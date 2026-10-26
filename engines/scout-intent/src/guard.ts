// Guard stage: injection, policy gate, scope, PII and rate limit. Each layer
// returns pass, warn or block with a structured reason.
import { readFileSync } from "node:fs";
import { scanInjection, type InjectionResult, type PatternRule } from "./injection.ts";
import type { ParamError } from "./interpret.ts";
import type { Intent, RiskClass } from "./registry.ts";

export type Verdict = "pass" | "warn" | "block";
export type RiskLevel = "low" | "medium" | "high" | "block";
export type DataClass = "public" | "internal" | "confidential" | "restricted";
export type ApprovalKind = "user-confirm" | "operator-review";

export interface RiskFlag {
  layer: "injection" | "policy" | "scope" | "pii" | "rate-limit" | "interpret";
  kind: string;
  severity: "warn" | "block";
  evidence?: string[];
  detail?: string;
}

export interface Redaction {
  dataClass: string;
  kind: string;
  span: [number, number];
  replacement: string;
}

export interface LayerResult {
  layer: RiskFlag["layer"];
  verdict: Verdict;
  reason?: string;
  flags: RiskFlag[];
}

export interface Risk {
  level: RiskLevel;
  flags: RiskFlag[];
  redactions: Redaction[];
  reason?: string;
  approvalsRequired: ApprovalKind[];
  injection: { detected: boolean; kind?: string; score: number; evidence: string[] };
  dataClass: DataClass;
  layers: LayerResult[];
}

type Cond = Record<string, unknown>;

export interface IntentPolicy {
  intent: string;
  allow?: { roles?: string[]; surfaces?: string[]; params?: Record<string, { min?: number; max?: number; enum?: unknown[] }> };
  deny?: { paramCombinations?: Cond[] };
  requireApproval?: Cond[];
}

export interface RateLimit {
  perMinute: number;
}

export interface PolicyPack {
  name: string;
  version: number;
  injectionBlockAt?: number;
  injectionWarnAt?: number;
  extraRules?: PatternRule[];
  /** Data classes that block instead of being redacted. */
  piiBlock?: string[];
  /** Approvals required for high-risk intents. */
  highRiskApprovals?: ApprovalKind[];
  rateLimits?: Partial<Record<RiskClass, RateLimit>>;
  intents?: IntentPolicy[];
  /** Capabilities a role may never use. Intents needing them are down-ranked and blocked. */
  denyCapabilities?: Record<string, string[]>;
}

export const BUILTIN_PACKS: Record<string, PolicyPack> = {
  default: {
    name: "default", version: 1,
    injectionBlockAt: 0.7, injectionWarnAt: 0.35,
    highRiskApprovals: ["user-confirm"],
    rateLimits: { low: { perMinute: 120 }, medium: { perMinute: 60 }, high: { perMinute: 10 } },
  },
  enterprise: {
    name: "enterprise", version: 1,
    highRiskApprovals: ["user-confirm", "operator-review"],
  },
  regulated: {
    name: "regulated", version: 1,
    piiBlock: ["ssn", "credit-card", "health"],
  },
  "adversarial-tight": {
    name: "adversarial-tight", version: 1,
    injectionBlockAt: 0.6, injectionWarnAt: 0.25,
  },
};

export interface ComposedPolicy {
  version: string;
  injectionBlockAt: number;
  injectionWarnAt: number;
  extraRules: PatternRule[];
  piiBlock: Set<string>;
  highRiskApprovals: ApprovalKind[];
  rateLimits: Partial<Record<RiskClass, RateLimit>>;
  intents: Map<string, IntentPolicy[]>;
  denyCapabilities: Record<string, string[]>;
}

export function composePolicy(packs: (string | PolicyPack)[]): ComposedPolicy {
  const resolved = packs.map((p) => {
    if (typeof p !== "string") return p;
    if (BUILTIN_PACKS[p]) return BUILTIN_PACKS[p];
    if (p.endsWith(".json")) return JSON.parse(readFileSync(p, "utf8")) as PolicyPack;
    throw new Error(`unknown policy pack "${p}" (built in: ${Object.keys(BUILTIN_PACKS).join(", ")}; files must be .json)`);
  });
  if (!resolved.some((p) => p.name === "default")) resolved.unshift(BUILTIN_PACKS.default);
  const out: ComposedPolicy = {
    version: resolved.map((p) => `${p.name}@${p.version}`).join("+"),
    injectionBlockAt: 1,
    injectionWarnAt: 1,
    extraRules: [],
    piiBlock: new Set(),
    highRiskApprovals: [],
    rateLimits: {},
    intents: new Map(),
    denyCapabilities: {},
  };
  for (const p of resolved) {
    if (p.injectionBlockAt !== undefined) out.injectionBlockAt = Math.min(out.injectionBlockAt, p.injectionBlockAt);
    if (p.injectionWarnAt !== undefined) out.injectionWarnAt = Math.min(out.injectionWarnAt, p.injectionWarnAt);
    out.extraRules.push(...(p.extraRules ?? []));
    for (const c of p.piiBlock ?? []) out.piiBlock.add(c);
    for (const a of p.highRiskApprovals ?? []) if (!out.highRiskApprovals.includes(a)) out.highRiskApprovals.push(a);
    for (const [k, v] of Object.entries(p.rateLimits ?? {})) {
      const cur = out.rateLimits[k as RiskClass];
      out.rateLimits[k as RiskClass] = cur ? { perMinute: Math.min(cur.perMinute, v!.perMinute) } : v;
    }
    for (const ip of p.intents ?? []) out.intents.set(ip.intent, [...(out.intents.get(ip.intent) ?? []), ip]);
    for (const [role, caps] of Object.entries(p.denyCapabilities ?? {})) {
      out.denyCapabilities[role] = [...new Set([...(out.denyCapabilities[role] ?? []), ...caps])];
    }
  }
  return out;
}

// ---- conditions -----------------------------------------------------------

function matchValue(actual: unknown, rule: unknown): boolean {
  if (rule && typeof rule === "object" && !Array.isArray(rule)) {
    const r = rule as Record<string, unknown>;
    const n = typeof actual === "number" ? actual : NaN;
    if ("gt" in r && !(n > (r.gt as number))) return false;
    if ("gte" in r && !(n >= (r.gte as number))) return false;
    if ("lt" in r && !(n < (r.lt as number))) return false;
    if ("lte" in r && !(n <= (r.lte as number))) return false;
    if ("eq" in r && actual !== r.eq) return false;
    if ("in" in r && !(r.in as unknown[]).includes(actual)) return false;
    return true;
  }
  return actual === rule;
}

export function matchCond(params: Record<string, unknown>, cond: Cond): boolean {
  return Object.entries(cond).every(([k, v]) => k in params && matchValue(params[k], v));
}

// ---- PII ------------------------------------------------------------------

interface PiiRule {
  kind: string;
  dataClass: DataClass;
  re: RegExp;
  check?: (m: string) => boolean;
}

function luhn(s: string): boolean {
  const d = s.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = +d[d.length - 1 - i];
    if (i % 2) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return sum % 10 === 0;
}

export const PII_RULES: PiiRule[] = [
  { kind: "credential", dataClass: "restricted", re: /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  { kind: "password", dataClass: "restricted", re: /\b(?:password|passwd|pwd|passcode)\s*[:=]\s*\S+/gi },
  { kind: "ssn", dataClass: "restricted", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: "credit-card", dataClass: "restricted", re: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
  { kind: "email", dataClass: "confidential", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "phone", dataClass: "confidential", re: /(?<![\w$])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },
  { kind: "health", dataClass: "restricted", re: /\b(?:diagnos(?:is|ed)\s+with|MRN[:#]?\s*\d+|ICD-?10[:\s]+[A-Z]\d{2}(?:\.\d+)?)\b/gi },
];

const CLASS_RANK: DataClass[] = ["public", "internal", "confidential", "restricted"];

export function maxClass(a: DataClass, b: DataClass): DataClass {
  return CLASS_RANK.indexOf(a) >= CLASS_RANK.indexOf(b) ? a : b;
}

export function findPii(text: string): Redaction[] {
  const out: Redaction[] = [];
  for (const r of PII_RULES) {
    for (const m of text.matchAll(r.re)) {
      if (r.check && !r.check(m[0])) continue;
      const span: [number, number] = [m.index!, m.index! + m[0].length];
      if (out.some((o) => span[0] < o.span[1] && o.span[0] < span[1])) continue;
      out.push({ dataClass: r.dataClass, kind: r.kind, span, replacement: `[REDACTED:${r.kind}]` });
    }
  }
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

export function applyRedactions(text: string, reds: Redaction[]): string {
  let out = "";
  let at = 0;
  for (const r of reds) {
    out += text.slice(at, r.span[0]) + r.replacement;
    at = r.span[1];
  }
  return out + text.slice(at);
}

// ---- rate limit -------------------------------------------------------------

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  take(key: string, perMinute: number, now: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10000) this.buckets.delete(this.buckets.keys().next().value!);
    return true;
  }
}

// ---- the stack ------------------------------------------------------------

export interface GuardInput {
  prompt: string;
  role: string;
  userId: string;
  surface: string;
  intents: { intent: Intent; parameters: Record<string, unknown>; errors: ParamError[] }[];
  knownTools: Iterable<string>;
  recentHighRisk?: number;
  sessionCategories?: string[];
  now: number;
  skipRateLimit?: boolean;
  /** Optional score from an injectable model check, in [0, 1]. */
  modelInjectionScore?: number;
}

const RANK: RiskLevel[] = ["low", "medium", "high"];

function allowed(list: string[], v: string): boolean {
  return list.includes("*") || list.includes(v);
}

export class GuardStack {
  readonly rate = new RateLimiter();

  constructor(readonly policy: ComposedPolicy) {}

  injection(prompt: string, knownTools?: Iterable<string>): InjectionResult {
    return scanInjection(prompt, { knownTools, extraRules: this.policy.extraRules, blockAt: this.policy.injectionBlockAt });
  }

  run(g: GuardInput): Risk {
    const layers: LayerResult[] = [];

    // 1. Injection.
    const inj = this.injection(g.prompt, g.knownTools);
    let injScore = inj.score;
    const injFlags: RiskFlag[] = inj.findings.map((f) => ({
      layer: "injection", kind: f.kind, severity: inj.detected ? "block" : "warn", evidence: [f.evidence], detail: f.id,
    }));
    if (g.modelInjectionScore !== undefined) {
      injScore = Math.max(injScore, g.modelInjectionScore);
      if (g.modelInjectionScore >= this.policy.injectionWarnAt) {
        injFlags.push({ layer: "injection", kind: "model", severity: g.modelInjectionScore >= this.policy.injectionBlockAt ? "block" : "warn", detail: `model score ${g.modelInjectionScore}` });
      }
    }
    const injBlock = inj.detected || injScore >= this.policy.injectionBlockAt;
    layers.push({
      layer: "injection",
      verdict: injBlock ? "block" : injScore >= this.policy.injectionWarnAt ? "warn" : "pass",
      reason: injBlock ? `prompt injection (${inj.kind ?? "model"})` : undefined,
      flags: injBlock || injScore >= this.policy.injectionWarnAt ? injFlags : [],
    });

    // 2. Policy gate.
    const pol: LayerResult = { layer: "policy", verdict: "pass", flags: [] };
    const approvals = new Set<ApprovalKind>();
    const block = (l: LayerResult, kind: string, detail: string) => {
      l.verdict = "block";
      l.reason ??= detail;
      l.flags.push({ layer: l.layer, kind, severity: "block", detail });
    };
    const warn = (l: LayerResult, kind: string, detail: string) => {
      if (l.verdict === "pass") l.verdict = "warn";
      l.flags.push({ layer: l.layer, kind, severity: "warn", detail });
    };
    for (const { intent, parameters, errors } of g.intents) {
      if (!allowed(intent.roles, g.role)) block(pol, "role-not-allowed", `role "${g.role}" may not invoke ${intent.id}`);
      const denied = (this.policy.denyCapabilities[g.role] ?? []).filter((c) => intent.capabilities.includes(c));
      if (denied.length) block(pol, "capability-denied", `role "${g.role}" may not use ${denied.join(", ")}`);
      for (const e of errors) block(pol, "param-invalid", `${intent.id}.${e.param}=${JSON.stringify(e.value)} fails ${e.rule}`);
      for (const ip of this.policy.intents.get(intent.id) ?? []) {
        if (ip.allow?.roles && !allowed(ip.allow.roles, g.role)) block(pol, "role-not-allowed", `policy: role "${g.role}" may not invoke ${intent.id}`);
        if (ip.allow?.surfaces && !allowed(ip.allow.surfaces, g.surface)) block(pol, "surface-not-allowed", `policy: ${intent.id} not allowed on ${g.surface}`);
        for (const [k, b] of Object.entries(ip.allow?.params ?? {})) {
          const v = parameters[k];
          if (v === undefined) continue;
          if ((b.max !== undefined && typeof v === "number" && v > b.max) || (b.min !== undefined && typeof v === "number" && v < b.min) || (b.enum && !b.enum.includes(v))) {
            block(pol, "param-out-of-bounds", `policy: ${intent.id}.${k}=${JSON.stringify(v)} out of bounds`);
          }
        }
        for (const c of ip.deny?.paramCombinations ?? []) {
          if (matchCond(parameters, c)) block(pol, "param-combination-denied", `policy: ${intent.id} denies ${JSON.stringify(c)}`);
        }
        for (const c of ip.requireApproval ?? []) {
          if (matchCond(parameters, c)) {
            approvals.add("operator-review");
            warn(pol, "require-approval", `policy: ${intent.id} requires approval for ${JSON.stringify(c)}`);
          }
        }
      }
    }
    layers.push(pol);

    // 3. Scope.
    const scope: LayerResult = { layer: "scope", verdict: "pass", flags: [] };
    for (const { intent } of g.intents) {
      if (!allowed(intent.surfaces, g.surface)) block(scope, "surface-not-allowed", `${intent.id} is not available on surface "${g.surface}"`);
      if (intent.riskClass === "high" && (g.recentHighRisk ?? 0) >= 3) warn(scope, "high-risk-burst", `${g.recentHighRisk} high-risk requests in the last 10 minutes`);
      if (intent.riskClass === "high" && g.sessionCategories?.length && !g.sessionCategories.includes(intent.category)) {
        warn(scope, "session-drift", `${intent.id} does not match the session so far (${g.sessionCategories.join(", ")})`);
      }
    }
    layers.push(scope);

    // 4. PII and sensitive data.
    const pii: LayerResult = { layer: "pii", verdict: "pass", flags: [] };
    const redactions = findPii(g.prompt);
    let dataClass: DataClass = "internal";
    for (const r of redactions) {
      dataClass = maxClass(dataClass, r.dataClass as DataClass);
      if (this.policy.piiBlock.has(r.kind) || this.policy.piiBlock.has(r.dataClass)) block(pii, `pii-${r.kind}`, `${r.kind} is not allowed by policy`);
      else if (r.dataClass === "restricted") warn(pii, `pii-${r.kind}`, `${r.kind} redacted`);
      else pii.flags.push({ layer: "pii", kind: `pii-${r.kind}`, severity: "warn", detail: `${r.kind} redacted` });
    }
    layers.push(pii);

    // 5. Rate limit.
    const rl: LayerResult = { layer: "rate-limit", verdict: "pass", flags: [] };
    for (const { intent } of g.intents) {
      const lim = this.policy.rateLimits[intent.riskClass];
      if (lim && !g.skipRateLimit && !this.rate.take(`${g.userId}|${intent.id}|${g.surface}`, lim.perMinute, g.now)) {
        block(rl, "rate-limited", `rate limit for ${intent.id} (${lim.perMinute}/min) reached`);
      }
    }
    layers.push(rl);

    // Reduce.
    const blocked = layers.find((l) => l.verdict === "block");
    const flags = layers.flatMap((l) => l.flags);
    const base = g.intents.reduce((acc, i) => Math.max(acc, RANK.indexOf(i.intent.riskClass)), 0);
    const lifted = layers.some((l) => l.verdict === "warn") ? Math.min(2, base + 1) : base;
    const level: RiskLevel = blocked ? "block" : RANK[lifted];
    const highRisk = g.intents.some((i) => i.intent.riskClass === "high");
    if (!blocked && highRisk && (level === "medium" || level === "high")) for (const a of this.policy.highRiskApprovals) approvals.add(a);
    return {
      level,
      flags,
      redactions,
      reason: blocked?.reason,
      approvalsRequired: blocked ? [] : [...approvals],
      injection: { detected: injBlock, kind: inj.kind, score: injScore, evidence: inj.findings.map((f) => f.id) },
      dataClass,
      layers,
    };
  }
}
