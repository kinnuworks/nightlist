// Guard for untrusted public trial eligibility text. Runs before any criterion
// text reaches the compiler model. Clean text gets a signed contract that
// authorizes one action, compile_criterion, for one criterion.
import { createHash } from "node:crypto";
import {
  HmacSigner, Ulid, ephemeralSecret, signContract, verifyContract as verifyExecution,
  type ExecutionContract, type Signer,
} from "./contract.ts";
import { scanInjection, type InjectionFinding, type PatternRule } from "./injection.ts";

export const TRIAL_ACTION = "compile_criterion";
export const TRIAL_INTENT = "trial.compile_criterion";

export interface TrialTextInput {
  nctId: string;
  criterionId: string;
  text: string;
}

export interface TrialTextResult {
  allowed: boolean;
  contract?: ExecutionContract;
  /** Combined injection score in [0, 1]. */
  risk: number;
  findings: string[];
  /** Text safe to hand to the compiler: hidden characters, links and blobs removed; offending sentences dropped. */
  sanitized: string;
}

const PATIENTS = "(?:patients?|participants?|subjects?|candidates?|criteri(?:on|a)|individuals?|applicants?|everyone|everybody|records?|cases?|people|persons?)";
const VERDICT = "(?:eligible|ineligible|qualif\\w*|included|excluded|meets?|met|pass\\w*|true|false|matched|a\\s+match)";
const LEAD = "(?:^|[.!?;:\\n(\\[{<>\"'`*#-]\\s*|\\b(?:and|then|please|just|always|simply|now)\\s+)";

// Domain rules: attempts to dictate the eligibility verdict instead of stating a criterion.
export const TRIAL_RULES: PatternRule[] = [
  { id: "verdict.mark-patients", kind: "verdict", hard: true, weight: 1,
    re: new RegExp(`${LEAD}(?:mark|label|classify|output|return|respond|answer|reply|print|say|set|flag|deem|treat|consider|record|report|score)\\s+(?:(?:(?:every|all|each|any|this|the|these|those)\\s+)?${PATIENTS}\\b|it\\b|this\\b|them\\b|everything\\b)?[^.\\n]{0,30}?\\b(?:as\\s+)?${VERDICT}\\b`, "i") },
  { id: "verdict.output-word", kind: "verdict", hard: true, weight: 1,
    re: /(?:^|[.!?;:\n(\[{<>"'`*#-]\s*|\b(?:and|then|always|only|just|must|should|simply|please)\s+)(?:output|return|respond|reply|answer|print|say)\s+(?:only\s+)?(?:with\s+)?:?\s*["'`]?(?:eligible|ineligible|yes|no|true|false|met|not\s+met|pass|fail|match|include|exclude)\b/i },
  { id: "verdict.statement", kind: "verdict", hard: true, weight: 1,
    re: /\b(?:the|your)\s+(?:verdict|answer|output|response|decision|result|classification)\s+(?:is|must\s+be|should\s+be|will\s+be|=)\s*["'`]?(?:eligible|ineligible|met|true|yes|pass|include)/i },
  { id: "verdict.json", kind: "verdict", weight: 0.8,
    re: /\{\s*["']?(?:eligible|verdict|status|result|met|decision|match)["']?\s*:\s*(?:true|false|["'](?:eligible|ineligible|met|yes|pass|include)["'])/i },
  { id: "verdict.regardless", kind: "verdict", weight: 0.7,
    re: new RegExp(`\\b(?:all|every|any)\\s+${PATIENTS}\\s+(?:are|is|should\\s+be|must\\s+be|will\\s+be)\\s+(?:considered\\s+|deemed\\s+|marked\\s+)?(?:eligible|qualified|included)\\s+regardless\\s+of\\s+(?:the\\s+|any\\s+|all\\s+)?(?:criteria|rules|above|other|everything|instructions)`, "i") },
  { id: "verdict.skip-criteria", kind: "pattern", weight: 0.7,
    re: /(?:^|[.!?;:\n]\s*)(?:skip|bypass|ignore)\s+(?:this|the|all|any|these|remaining|other)\s+(?:[a-z-]+\s+){0,2}(?:criteri(?:on|a)|checks?|screening|exclusions?|requirements?)\b/i },
  { id: "verdict.always-met", kind: "verdict", weight: 0.7,
    re: /\b(?:this|the|each|every)\s+(?:criterion|criteria|patient|subject|participant|requirement)\s+(?:is|are)\s+(?:always|automatically|already|considered)\s+(?:met|satisfied|eligible|true|fulfilled)\b/i },
  { id: "model.address", kind: "role-drift", weight: 0.7,
    re: /\b(?:note\s+to|dear|attention|hey|hi|hello)\s+(?:the\s+)?(?:ai|assistant|model|llm|chatbot|gpt|bot|agent|compiler|classifier)\b/i },
  { id: "model.speaker", kind: "role-marker", weight: 0.7,
    re: /(?:^|[\s.!?;])(?:assistant|human|user|chatbot)\s*:\s/i },
  { id: "format.hijack", kind: "pattern", weight: 0.5,
    re: /\b(?:respond|reply|answer|output)\s+(?:only\s+)?(?:in|with|using)\s+(?:json|yaml|xml|markdown|the\s+following)\b/i },
];

const LABELS: Record<string, string> = {
  pattern: "instruction-like text",
  "role-drift": "role-play or model-directed text",
  "role-marker": "system or chat role marker",
  "tool-ref": "tool or URL call",
  exfiltration: "request for secrets",
  privilege: "privilege or destructive request",
  "embedded-control": "hidden control characters",
  encoded: "encoded payload",
  verdict: "attempt to set the eligibility verdict",
  model: "model check",
};

const BLOCK_AT = 0.6;

const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
const URL = /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*/gi;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function scan(text: string) {
  return scanInjection(text, { knownTools: [TRIAL_ACTION], extraRules: TRIAL_RULES, blockAt: BLOCK_AT });
}

function describe(f: InjectionFinding): string {
  return `${LABELS[f.kind] ?? f.kind} (${f.id}): "${f.evidence}"`;
}

function serious(f: InjectionFinding): boolean {
  return f.hard || f.weight >= BLOCK_AT;
}

/** Light clean-up for text that passed: no hidden characters, links or opaque blobs. Clinical symbols are kept as is. */
function tidy(text: string, findings: InjectionFinding[]): string {
  let out = text.replace(HIDDEN, "");
  if (findings.some((f) => f.id === "tool.url")) out = out.replace(URL, "[link removed]");
  for (const f of findings) {
    if (f.kind === "encoded") out = out.replace(/[A-Za-z0-9+/_-]{24,}={0,2}|\b(?:[0-9a-f]{2}[\s:]?){12,}\b/gi, (m) => (/^[ACGTUN]+$/i.test(m) ? m : "[encoded text removed]"));
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** Drop sentences that carry instructions; keep the clinical rest for human review. */
function dropOffending(text: string): string {
  const parts = text.replace(HIDDEN, "").split(/(?<=[.!?;\n])\s+|\n+/);
  const keep = parts.filter((p) => p.trim() && !scan(p).findings.some(serious));
  return tidy(keep.join(" "), []);
}

export interface TrialTextGuardOptions {
  secret?: string | Buffer;
  signer?: Signer;
  ttlMs?: number;
  clock?: () => number;
}

export class TrialTextGuard {
  private readonly signer: Signer;
  private readonly ulid = new Ulid();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: TrialTextGuardOptions = {}) {
    const secret = opts.secret ?? process.env.SCOUT_TRIALTEXT_SECRET ?? process.env.SCOUT_SECRET;
    this.signer = opts.signer ?? new HmacSigner(secret ?? ephemeralSecret());
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.clock = opts.clock ?? Date.now;
  }

  guard(input: TrialTextInput): TrialTextResult {
    const text = typeof input?.text === "string" ? input.text : "";
    if (typeof input?.text !== "string" || typeof input.criterionId !== "string" || !input.criterionId || typeof input.nctId !== "string" || !input.nctId) {
      return { allowed: false, risk: 1, findings: ["invalid input: nctId, criterionId and text are required strings"], sanitized: "" };
    }
    const r = scan(text);
    const blocked = r.detected || r.findings.some(serious);
    const findings = r.findings.map(describe);
    if (blocked) {
      return { allowed: false, risk: r.score, findings, sanitized: dropOffending(text) };
    }
    const sanitized = tidy(text, r.findings);
    return { allowed: true, risk: r.score, findings, sanitized, contract: this.issue(input, sanitized, r.findings) };
  }

  verify(contract: unknown, expect: { criterionId?: string; nctId?: string; text?: string; now?: number } = {}): boolean {
    let check;
    try {
      check = verifyExecution(contract, { signer: this.signer, capability: TRIAL_ACTION, now: expect.now ?? this.clock() });
    } catch {
      return false;
    }
    if (!check.ok) return false;
    const c = contract as ExecutionContract;
    if (c.intent.primary.id !== TRIAL_INTENT) return false;
    if (c.scope.capabilities.length !== 1 || c.scope.capabilities[0] !== TRIAL_ACTION) return false;
    if (!c.toolPlan.length || c.toolPlan.some((s) => s.capability !== TRIAL_ACTION)) return false;
    const p = c.intent.parameters as { nctId?: string; criterionId?: string; textSha256?: string };
    if (expect.criterionId !== undefined && p.criterionId !== expect.criterionId) return false;
    if (expect.nctId !== undefined && p.nctId !== expect.nctId) return false;
    if (expect.text !== undefined && p.textSha256 !== sha256(expect.text)) return false;
    return true;
  }

  private issue(input: TrialTextInput, sanitized: string, soft: InjectionFinding[]): ExecutionContract {
    const now = this.clock();
    const params = { nctId: input.nctId, criterionId: input.criterionId, textSha256: sha256(sanitized) };
    const traceId = this.ulid.next(now);
    return signContract({
      contractId: this.ulid.next(now),
      traceId,
      intent: {
        primary: { id: TRIAL_INTENT, version: 1, category: "trial", riskClass: "low" },
        parameters: params,
        references: {
          trial: { kind: "trial", id: input.nctId, label: input.nctId, resolved: true },
          criterion: { kind: "criterion", id: input.criterionId, label: input.criterionId, resolved: true },
        },
        confidence: 1,
        alternates: [],
      },
      risk: {
        level: soft.length ? "medium" : "low",
        flags: soft.map((f) => ({ layer: "injection" as const, kind: f.kind, severity: "warn" as const, detail: f.id })),
        redactions: [],
        approvals: [],
        approvalsRequired: [],
      },
      toolPlan: [{ capability: TRIAL_ACTION, tool: "criterion-compiler", input: params, fromIntent: TRIAL_INTENT, local: true }],
      modelProfile: { id: "criterion-compiler", provider: "nightlist", model: "configured-by-server", local: false },
      scope: {
        user: { id: "nightlist-compiler", role: "compiler" },
        surface: "trial-text",
        capabilities: [TRIAL_ACTION],
      },
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      registryVersion: 1,
      policyPackVersion: "trialtext@1",
    }, this.signer);
  }
}

let shared = new TrialTextGuard();

/** Replace the shared guard, for example to set a deployment secret. */
export function configureTrialTextGuard(opts: TrialTextGuardOptions): void {
  shared = new TrialTextGuard(opts);
}

export function guardTrialText(input: TrialTextInput): TrialTextResult {
  return shared.guard(input);
}

/** True when the contract was signed by this guard, is fresh, and authorizes only compile_criterion. */
export function verifyContract(contract: unknown, expect?: { criterionId?: string; nctId?: string; text?: string; now?: number }): boolean {
  return shared.verify(contract, expect);
}
