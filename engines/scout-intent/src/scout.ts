// The Scout pipeline: Sense -> Interpret -> Guard -> Route -> Recommend -> contract.
import { performance } from "node:perf_hooks";
import {
  HmacSigner, Ulid, ephemeralSecret, signContract, verifyContract,
  type ApprovalRecord, type ExecutionContract, type IntentCandidate, type IntentRef, type Signer, type UserRef,
  type VerifyOptions, type VerifyResult,
} from "./contract.ts";
import { GuardStack, composePolicy, type ApprovalKind, type PolicyPack, type Risk, type RiskFlag, applyRedactions } from "./guard.ts";
import { bind, vagueReference, type EntityRef, type ParamError } from "./interpret.ts";
import { BUILTIN_GENERAL, GENERAL_ID, IntentRegistry, type Intent } from "./registry.ts";
import { CapabilityGraph, ModelRouter, type ModelProfile, type ModelProfileRef, type RouteFailure, type ToolRegistration, type ToolStep } from "./route.ts";
import {
  DEFAULT_BANDS, DEFAULT_WEIGHTS, LexicalScorer, bandOf, merge, round, selfTest, stage1,
  type Band, type Bands, type Stage2, type Weights,
} from "./score.ts";
import { stripControl } from "./text.ts";

export type Topology = "pipeline" | "fan_out" | "debate" | "loop" | "hierarchical" | "star" | "tree" | "mesh";

export interface ScoutOptions {
  intentRegistry: string | IntentRegistry | Intent[] | { intents: Intent[]; version?: number };
  policyPack?: string | PolicyPack | (string | PolicyPack)[];
  modelProfiles?: string | ModelProfile[];
  routing?: "local-first" | "cloud-first";
  /** Per-deployment HMAC secret. Without one, a random per-process secret is used. */
  signingSecret?: string | Buffer;
  signer?: Signer;
  /** Contract time to live in ms. Default 5 minutes. */
  ttlMs?: number;
  bands?: Partial<Bands>;
  surfaceBands?: Record<string, Partial<Bands>>;
  weights?: Partial<Weights>;
  /** Optional Stage-2 rescoring. Off unless provided. */
  stage2?: Stage2;
  /** Optional model-based injection score in [0, 1]. Off unless provided. */
  injectionModel?: (text: string) => number | Promise<number>;
  tools?: ToolRegistration[];
  /** Register the default local tools for the standard capability names. Default true. */
  defaultTools?: boolean;
  clock?: () => number;
  random?: () => number;
  telemetry?: (e: TelemetryEvent) => void;
  /** Run the 16 ms stage-1 latency self-test at startup. Default true. */
  selfTest?: boolean;
  topK?: number;
  highRiskProceed?: number;
  tieWindow?: number;
  secondaryFloor?: number;
  maxClarifyOptions?: number;
}

export interface DecideInput {
  prompt: string;
  user?: UserRef;
  surface: string;
  sessionId?: string;
  context?: {
    activeIntent?: string;
    recentTurns?: string[];
    memory?: string[];
    entities?: Record<string, string>;
    references?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    state?: unknown;
  };
  deadline?: string;
  budget?: { tokensMax?: number; costMaxUSD?: number };
}

export interface Candidate extends IntentCandidate {
  span: string;
  band: Band;
}

export interface Clarification {
  trigger: "low-band" | "tie" | "params" | "reference" | "high-risk";
  question: string;
  options: { label: string; intent: string }[];
}

export interface PlannedIntent {
  intent: string;
  score: number;
  span: string;
  parameters: Record<string, unknown>;
  references: Record<string, EntityRef>;
}

export interface Interpretation {
  primary: IntentRef;
  parameters: Record<string, unknown>;
  references: Record<string, EntityRef>;
  confidence: number;
  alternates: IntentCandidate[];
  needsClarification: boolean;
  paramErrors: ParamError[];
  missing: string[];
}

export interface Decision {
  traceId: string;
  candidates: Candidate[];
  band: Band;
  intent: Interpretation;
  intents: PlannedIntent[];
  multiIntent: boolean;
  clarification?: Clarification;
  risk: Risk;
  toolPlan: ToolStep[];
  modelProfile?: ModelProfileRef;
  executionContract?: ExecutionContract;
  unavailable?: RouteFailure[];
  sanitizedPrompt: string;
  scout_topology_pattern: Topology;
  stage2: "used" | "skipped";
  latencyMs: number;
  explanation?: string;
}

export interface TelemetryEvent {
  type: string;
  traceId: string;
  at: string;
  [k: string]: unknown;
}

interface Stored {
  input: DecideInput;
  contract: ExecutionContract;
}

export class Scout {
  readonly registry: IntentRegistry;
  readonly capabilities: CapabilityGraph;
  readonly models: ModelRouter;
  readonly policyVersion: string;
  private readonly guardStack: GuardStack;
  private readonly scorer: LexicalScorer;
  private readonly general: Intent;
  private readonly signer: Signer;
  private readonly ulid: Ulid;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly bands: Bands;
  private readonly weights: Weights;
  private readonly store = new Map<string, Stored>();
  private readonly events: TelemetryEvent[] = [];
  private readonly sessions = new Map<string, string[]>();
  private readonly highRisk = new Map<string, number[]>();
  readonly selfTestMs?: number;

  constructor(private readonly opts: ScoutOptions) {
    this.registry = IntentRegistry.load(opts.intentRegistry);
    const packs = opts.policyPack === undefined ? ["default"] : Array.isArray(opts.policyPack) ? opts.policyPack : [opts.policyPack];
    const policy = composePolicy(packs);
    this.policyVersion = policy.version;
    this.guardStack = new GuardStack(policy);
    this.capabilities = new CapabilityGraph(opts.defaultTools !== false);
    for (const t of opts.tools ?? []) this.capabilities.register(t);
    this.models = new ModelRouter(opts.modelProfiles, opts.routing);
    this.scorer = new LexicalScorer(this.registry.intents);
    this.general = this.registry.get(GENERAL_ID) ?? BUILTIN_GENERAL;
    const secret = opts.signingSecret ?? process.env.SCOUT_SECRET;
    this.signer = opts.signer ?? new HmacSigner(secret ?? ephemeralSecret());
    this.clock = opts.clock ?? Date.now;
    this.ulid = new Ulid(opts.random);
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.bands = { ...DEFAULT_BANDS, ...opts.bands };
    this.weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
    if (opts.selfTest !== false) this.selfTestMs = selfTest(this.scorer);
  }

  // ---- public API ------------------------------------------------------------

  async classify(input: { prompt: string; surface: string; user?: UserRef }): Promise<{ candidates: Candidate[] }> {
    const s = await this.sense({ ...input });
    return { candidates: s.candidates };
  }

  async classifyMulti(input: { prompt: string; surface: string; user?: UserRef }) {
    const d = await this.decide({ ...input }, { dryRun: true, ignoreGuard: true });
    return {
      intents: d.intents.map((i) => ({ intent: i.intent, score: i.score, span: i.span, parameters: i.parameters })),
      toolPlan: d.toolPlan,
    };
  }

  /** Guard stack only. Does not count against rate limits or issue a contract. */
  async guard(input: DecideInput): Promise<Risk> {
    return (await this.decide(input, { dryRun: true })).risk;
  }

  async decide(input: DecideInput, internal: { dryRun?: boolean; ignoreGuard?: boolean; parent?: ExecutionContract; offline?: Set<string> } = {}): Promise<Decision> {
    const t0 = performance.now();
    const now = this.clock();
    const traceId = internal.parent?.traceId ?? this.ulid.next(now);
    const user: UserRef = input.user ?? { id: "anonymous", role: "anonymous" };
    const bands = { ...this.bands, ...this.opts.surfaceBands?.[input.surface] };

    // Sense.
    const sense = await this.sense(input);
    const { candidates } = sense;
    const top = candidates[0];
    const band = bandOf(top?.score ?? 0, bands);

    // Plan: one intent, or several on disjoint spans.
    const floor = this.opts.secondaryFloor ?? bands.medium;
    const winners = new Map<string, { score: number; start: number; spans: string[] }>();
    for (const { seg, top: t } of sense.segments) {
      if (t.intent === GENERAL_ID || !this.registry.has(t.intent)) continue;
      if (t.score < floor) continue;
      const w = winners.get(t.intent) ?? { score: 0, start: seg.start, spans: [] };
      w.score = Math.max(w.score, t.score);
      w.spans.push(seg.text);
      winners.set(t.intent, w);
    }
    const maxClause = Math.max(0, ...[...winners.values()].map((w) => w.score));
    const multi = winners.size >= 2 && maxClause >= bands.high && sense.wholeTop < maxClause;

    let plan: { intent: Intent; score: number; span: string }[];
    let explanation: string | undefined;
    if (multi) {
      plan = [...winners.entries()].sort((a, b) => a[1].start - b[1].start)
        .map(([id, w]) => ({ intent: this.registry.get(id)!, score: round(w.score), span: w.spans.join("; ") }));
    } else if (!top || band === "reject" || !this.registry.has(top.intent)) {
      plan = [{ intent: this.general, score: sense.final.get(GENERAL_ID) ?? 0, span: input.prompt.trim() }];
      if (band === "reject") {
        const best = candidates.find((c) => c.intent !== GENERAL_ID);
        explanation = `No registered intent cleared the reject band (best ${best?.intent ?? "none"} at ${(best?.score ?? 0).toFixed(2)}); answering as ${GENERAL_ID} without tools.`;
      }
    } else {
      plan = [{ intent: this.registry.get(top.intent)!, score: top.score, span: input.prompt.trim() }];
    }

    // Interpret.
    const bound = plan.map((p) => ({ ...p, b: bind(p.intent, p.span, { entities: input.context?.entities, parameters: input.context?.parameters }) }));
    const primary = bound[0];
    const alternates = candidates.filter((c) => c.intent !== primary.intent.id).slice(0, 4).map(({ intent, score, span }) => ({ intent, score, span }));
    const asked = this.clarify({ band, candidates, plan: bound, multi, prompt: input.prompt, context: input.context });

    // Guard.
    let modelScore: number | undefined;
    if (this.opts.injectionModel) {
      try {
        modelScore = Math.max(0, Math.min(1, await this.opts.injectionModel(input.prompt)));
      } catch {
        modelScore = undefined;
      }
    }
    const recent = (this.highRisk.get(user.id) ?? []).filter((t) => now - t < 10 * 60 * 1000);
    const session = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
    const risk = this.guardStack.run({
      prompt: input.prompt,
      role: user.role,
      userId: user.id,
      surface: input.surface,
      intents: bound.map((p) => ({ intent: p.intent, parameters: p.b.parameters, errors: p.b.errors })),
      knownTools: [...this.capabilities.known(), ...this.registry.intents.flatMap((i) => i.capabilities)],
      recentHighRisk: recent.length,
      sessionCategories: session?.map((id) => this.registry.get(id)?.category ?? "").filter(Boolean),
      now,
      skipRateLimit: internal.dryRun,
      modelInjectionScore: modelScore,
    });
    // A blocked request gets a refusal, not a question.
    const clarification = risk.level === "block" ? undefined : asked;
    const sanitizedPrompt = stripControl(applyRedactions(input.prompt, risk.redactions));

    const interpretation: Interpretation = {
      primary: ref(primary.intent),
      parameters: primary.b.parameters,
      references: Object.assign({}, ...bound.map((p) => p.b.references)),
      confidence: primary.score,
      alternates,
      needsClarification: Boolean(clarification),
      paramErrors: bound.flatMap((p) => p.b.errors),
      missing: bound.flatMap((p) => p.b.missing),
    };
    const intents: PlannedIntent[] = bound.map((p) => ({ intent: p.intent.id, score: p.score, span: p.span, parameters: p.b.parameters, references: p.b.references }));

    const base: Decision = {
      traceId,
      candidates,
      band,
      intent: interpretation,
      intents,
      multiIntent: multi,
      clarification,
      risk,
      toolPlan: [],
      sanitizedPrompt,
      scout_topology_pattern: "pipeline",
      stage2: sense.stage2,
      latencyMs: 0,
      explanation,
    };

    if (risk.level === "block" && !internal.ignoreGuard) {
      base.latencyMs = round(performance.now() - t0, 2);
      if (!internal.dryRun) {
        this.emit({ type: "scout.blocked", traceId, intent: primary.intent.id, reason: risk.reason, layers: risk.layers.filter((l) => l.verdict === "block").map((l) => l.layer), injection: risk.injection.evidence });
        this.emit({ type: "scout.decision", traceId, intent: primary.intent.id, band, latencyMs: base.latencyMs, stage2: sense.stage2, risk: "block" });
      }
      return base;
    }

    // Route.
    const steps: ToolStep[] = [];
    const failures: RouteFailure[] = [];
    for (const p of bound) {
      const r = this.capabilities.plan({
        intent: p.intent.id,
        capabilities: p.intent.capabilities,
        input: { intent: p.intent.id, parameters: p.b.parameters, references: p.b.references, span: p.span },
        surface: input.surface,
        permissions: user.permissions,
        offline: internal.offline,
      });
      steps.push(...r.steps);
      failures.push(...r.failures);
    }
    base.toolPlan = steps;
    base.scout_topology_pattern = topology(steps, multi);

    // Recommend.
    const riskClass = bound.some((p) => p.intent.riskClass === "high") ? "high" : bound.some((p) => p.intent.riskClass === "medium") ? "medium" : "low";
    const profile = this.models.pick({
      needs: steps.length ? ["json-mode"] : ["text"],
      dataClass: risk.dataClass,
      promptTokens: Math.ceil(input.prompt.length / 4),
      riskClass,
      costMaxUSD: input.budget?.costMaxUSD,
    });
    if (!profile) failures.push({ capability: "model", reason: "unresolvable", fromIntent: primary.intent.id });
    base.modelProfile = profile;

    if (failures.length) {
      base.unavailable = failures;
      base.latencyMs = round(performance.now() - t0, 2);
      if (!internal.dryRun) this.emit({ type: "scout.unavailable", traceId, intent: primary.intent.id, missing: failures.map((f) => `${f.capability}:${f.reason}`) });
      return base;
    }

    if (internal.dryRun) {
      base.latencyMs = round(performance.now() - t0, 2);
      return base;
    }

    const flags: RiskFlag[] = [...risk.flags];
    const approvalsRequired = new Set<ApprovalKind>(risk.approvalsRequired);
    if (clarification) {
      flags.push({ layer: "interpret", kind: "clarification-pending", severity: "warn", detail: clarification.trigger });
      approvalsRequired.add("user-confirm");
    }
    const contract = signContract({
      contractId: this.ulid.next(now),
      parentId: internal.parent?.contractId,
      traceId,
      intent: {
        primary: interpretation.primary,
        parameters: interpretation.parameters,
        references: interpretation.references,
        confidence: interpretation.confidence,
        alternates,
        plan: multi ? intents.slice(1).map((i) => ({ id: i.intent, version: this.registry.get(i.intent)!.version, span: i.span, confidence: i.score, parameters: i.parameters })) : undefined,
      },
      risk: { level: risk.level as "low" | "medium" | "high", flags, redactions: risk.redactions, approvals: [], approvalsRequired: [...approvalsRequired] },
      toolPlan: steps,
      modelProfile: profile!,
      scope: {
        user: { id: user.id, role: user.role },
        surface: input.surface,
        capabilities: [...new Set(steps.map((s) => s.capability))],
        deadline: input.deadline,
        budget: input.budget,
      },
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      registryVersion: this.registry.registryVersion,
      policyPackVersion: this.policyVersion,
    }, this.signer);
    base.executionContract = contract;

    // Bookkeeping for replan, recency and scope checks.
    this.remember(contract, input);
    if (input.sessionId) {
      const s = this.sessions.get(input.sessionId) ?? [];
      s.unshift(...plan.map((p) => p.intent.id).reverse());
      this.sessions.set(input.sessionId, s.slice(0, 10));
    }
    if (riskClass === "high") this.highRisk.set(user.id, [...recent, now]);

    base.latencyMs = round(performance.now() - t0, 2);
    this.emit({ type: "scout.decision", traceId, intent: primary.intent.id, band, latencyMs: base.latencyMs, stage2: sense.stage2 });
    this.emit({ type: "contract.issued", traceId, contractId: contract.contractId, parentId: contract.parentId, intent: primary.intent.id, risk: contract.risk.level, profile: profile!.id });
    if (clarification) this.emit({ type: "scout.clarification", traceId, trigger: clarification.trigger });
    return base;
  }

  /** Re-plan from a parent contract. The new contract keeps the trace id and records the parent. */
  async replan(input: { parent: string; reason: string; state?: unknown }): Promise<Decision> {
    const stored = this.store.get(input.parent);
    if (!stored) throw new Error(`replan: unknown parent contract ${input.parent}`);
    const offline = new Set<string>();
    for (const m of input.reason.matchAll(/\btool\.([\w.-]+)\s+(?:unavailable|offline|down)\b/g)) offline.add(m[1]);
    const st = input.state as { offline?: string[] } | undefined;
    for (const t of st?.offline ?? []) offline.add(t);
    this.emit({ type: "scout.replan", traceId: stored.contract.traceId, parent: input.parent, reason: input.reason });
    return this.decide({ ...stored.input, context: { ...stored.input.context, state: input.state } }, { parent: stored.contract, offline });
  }

  /** Attach an approval by re-issuing the contract. Expiry does not move. */
  approve(contract: ExecutionContract, approval: Omit<ApprovalRecord, "at"> & { at?: string }): ExecutionContract {
    const check = this.verify(contract, { requireApprovals: false });
    if (!check.ok) throw new Error(`approve: contract not valid (${check.reason})`);
    const now = this.clock();
    const { signature: _sig, signedBy: _by, ...body } = contract;
    const next = signContract({
      ...body,
      contractId: this.ulid.next(now),
      parentId: contract.contractId,
      risk: { ...body.risk, approvals: [...body.risk.approvals, { ...approval, at: approval.at ?? new Date(now).toISOString() }] },
      issuedAt: new Date(now).toISOString(),
    }, this.signer);
    const stored = this.store.get(contract.contractId);
    if (stored) this.remember(next, stored.input);
    this.emit({ type: "contract.approved", traceId: next.traceId, contractId: next.contractId, parentId: contract.contractId, kind: approval.kind });
    return next;
  }

  /** Verify at an executor boundary. Emits contract.verified, contract.expired or contract.refused. */
  verify(contract: ExecutionContract, opts: Omit<VerifyOptions, "secret" | "signer"> & { engine?: string } = {}): VerifyResult {
    const r = verifyContract(contract, { now: this.clock(), ...opts, signer: this.signer });
    const traceId = contract?.traceId ?? "unknown";
    if (r.ok) this.emit({ type: "contract.verified", traceId, contractId: contract.contractId, engine: opts.engine });
    else if (r.reason === "expired") this.emit({ type: "contract.expired", traceId, contractId: contract?.contractId, engine: opts.engine });
    else this.emit({ type: "contract.refused", traceId, contractId: contract?.contractId, engine: opts.engine, reason: r.reason });
    return r;
  }

  /** A user corrected the routing ("No, I meant ..."). */
  recordOverride(e: { traceId: string; from: string; to: string }): void {
    this.emit({ type: "scout.override", traceId: e.traceId, from: e.from, to: e.to });
  }

  /** Telemetry for one trace, or the most recent events. */
  telemetry(traceId?: string): TelemetryEvent[] {
    return traceId ? this.events.filter((e) => e.traceId === traceId) : [...this.events];
  }

  // ---- stages ---------------------------------------------------------------

  private async sense(input: { prompt: string; surface: string; user?: UserRef; sessionId?: string; context?: DecideInput["context"] }) {
    const clean = stripControl(input.prompt);
    const s1 = stage1(this.scorer, clean);
    const lexical = new Map<string, number>();
    for (const [id, s] of s1.best) lexical.set(id, s.score);

    let semantic: Record<string, number> | undefined;
    let stage2: "used" | "skipped" = "skipped";
    if (this.opts.stage2?.semantic) {
      try {
        semantic = await this.opts.stage2.semantic(clean, this.registry.intents);
        stage2 = "used";
      } catch {
        semantic = undefined;
      }
    }

    let contextual: Record<string, number> | undefined;
    const ctx = input.context;
    if (ctx && (ctx.activeIntent || ctx.recentTurns?.length || ctx.memory?.length)) {
      contextual = {};
      const text = [...(ctx.recentTurns ?? []), ...(ctx.memory ?? [])].join(". ");
      const fromText = text ? stage1(this.scorer, text).whole : new Map<string, number>();
      const activeCat = ctx.activeIntent ? this.registry.get(ctx.activeIntent)?.category : undefined;
      for (const i of this.registry.intents) {
        const a = ctx.activeIntent === i.id ? 1 : activeCat && activeCat === i.category ? 0.5 : 0;
        contextual[i.id] = Math.max(a, fromText.get(i.id) ?? 0);
      }
    }

    let recency: Record<string, number> | undefined;
    const hist = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
    if (hist?.length) {
      recency = {};
      hist.forEach((id, k) => (recency![id] = Math.max(recency![id] ?? 0, 0.5 ** k)));
    }

    let riskPenalty: Record<string, number> | undefined;
    const denied = input.user ? this.guardStack.policy.denyCapabilities[input.user.role] : undefined;
    if (denied?.length) {
      riskPenalty = {};
      for (const i of this.registry.intents) if (i.capabilities.some((c) => denied.includes(c))) riskPenalty[i.id] = 0.25;
    }

    const final = merge({ lexical, semantic, contextual, recency, riskPenalty, weights: this.weights });
    const order = new Map(this.registry.intents.map((i, k) => [i.id, k]));
    const bands = { ...this.bands, ...this.opts.surfaceBands?.[input.surface] };
    const candidates: Candidate[] = [...final.entries()]
      .sort((a, b) => b[1] - a[1] || (s1.whole.get(b[0]) ?? 0) - (s1.whole.get(a[0]) ?? 0) || order.get(a[0])! - order.get(b[0])!)
      .slice(0, this.opts.topK ?? 5)
      .map(([intent, score]) => ({ intent, score, span: s1.best.get(intent)!.span, band: bandOf(score, bands) }));
    const wholeTop = Math.max(0, ...s1.whole.values());
    return { candidates, final, segments: s1.segments, wholeTop, stage2 };
  }

  private clarify(a: {
    band: Band;
    candidates: Candidate[];
    plan: { intent: Intent; score: number; span: string; b: { missing: string[] } }[];
    multi: boolean;
    prompt: string;
    context?: DecideInput["context"];
  }): Clarification | undefined {
    const max = this.opts.maxClarifyOptions ?? 4;
    const options = (ids: string[]) => ids.filter((id) => id !== GENERAL_ID && this.registry.has(id)).slice(0, max)
      .map((id) => ({ label: label(this.registry.get(id)!), intent: id }));
    const top3 = options(a.candidates.slice(0, 3).map((c) => c.intent));
    const [c1, c2] = a.candidates;

    const vague = vagueReference(a.prompt, a.context);
    if (vague) {
      return { trigger: "reference", question: `What does "${vague}" refer to? Pick what you want to do, or add the details.`, options: options(a.candidates.map((c) => c.intent)) };
    }
    if (!a.multi && a.band === "low") {
      return { trigger: "low-band", question: "I am not sure what you want to do. Which of these is closest?", options: top3 };
    }
    if (!a.multi && a.band === "medium" && c2 && c2.intent !== GENERAL_ID && c1.score - c2.score <= (this.opts.tieWindow ?? 0.05)) {
      return { trigger: "tie", question: `Did you mean ${label(this.registry.get(c1.intent)!)} or ${label(this.registry.get(c2.intent)!)}?`, options: options([c1.intent, c2.intent]) };
    }
    const missing = a.plan.flatMap((p) => p.b.missing.map((m) => `${p.intent.id}.${m}`));
    if (missing.length) {
      return { trigger: "params", question: `Please add: ${missing.join(", ")}.`, options: options(a.plan.map((p) => p.intent.id)) };
    }
    const risky = a.plan.find((p) => p.intent.riskClass === "high" && p.score < (this.opts.highRiskProceed ?? 0.95));
    if (risky) {
      return { trigger: "high-risk", question: `This would ${label(risky.intent)}. Is that what you want?`, options: options([risky.intent.id, ...a.candidates.map((c) => c.intent)]) };
    }
    return undefined;
  }

  private remember(contract: ExecutionContract, input: DecideInput): void {
    this.store.set(contract.contractId, { contract, input });
    if (this.store.size > 1000) this.store.delete(this.store.keys().next().value!);
  }

  private emit(e: Omit<TelemetryEvent, "at">): void {
    const ev = { at: new Date(this.clock()).toISOString(), ...e } as TelemetryEvent;
    this.events.push(ev);
    if (this.events.length > 2000) this.events.shift();
    try {
      this.opts.telemetry?.(ev);
    } catch {
      // telemetry must never break a decision
    }
  }
}

function ref(i: Intent): IntentRef {
  return { id: i.id, version: i.version, category: i.category, riskClass: i.riskClass };
}

function label(i: Intent): string {
  const first = i.description.split(/[.;:,(\u2014\u2013-]\s/)[0].trim();
  const words = first.split(/\s+/).slice(0, 8).join(" ");
  return words ? words.charAt(0).toLowerCase() + words.slice(1) : i.id;
}

function topology(steps: ToolStep[], multi: boolean): Topology {
  const caps = new Set(steps.map((s) => s.capability));
  if (caps.has("approval.require")) return "hierarchical";
  if (caps.has("swarm.run")) return "fan_out";
  if (caps.has("markovian.chain") && !multi) return "loop";
  return "pipeline";
}
