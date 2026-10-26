// Route stage (capability graph) and Recommend stage (model profiles).
import { readFileSync } from "node:fs";
import type { DataClass } from "./guard.ts";

export interface ToolRegistration {
  capability: string;
  toolId: string;
  availability?: () => boolean;
  requiredPermissions?: string[];
  cost?: { perCall: number };
  latency?: { p95Ms: number };
  local?: boolean;
  /** Surfaces this tool suits best. */
  surfaces?: string[];
  invoke?: (input: unknown) => unknown;
}

export interface ToolStep {
  capability: string;
  tool: string;
  input: Record<string, unknown>;
  fromIntent: string;
  local: boolean;
}

export interface RouteFailure {
  capability: string;
  reason: "unresolvable" | "permission" | "unavailable";
  fromIntent: string;
}

export interface RouteRequest {
  intent: string;
  capabilities: string[];
  input: Record<string, unknown>;
  surface: string;
  permissions?: string[];
  latencyBudgetMs?: number;
  /** Tools to treat as offline for this request (used by replan). */
  offline?: Set<string>;
}

// Default tools for the Meterless capability names. All local, no permissions.
const DEFAULT_TOOLS: ToolRegistration[] = [
  { capability: "world.query", toolId: "world-model.graph", local: true, latency: { p95Ms: 50 } },
  { capability: "world.assert", toolId: "world-model.assert", local: true, latency: { p95Ms: 50 } },
  { capability: "memory.recall", toolId: "hmem.retrieve", local: true, latency: { p95Ms: 30 } },
  { capability: "memory.commit", toolId: "hmem.commit", local: true, latency: { p95Ms: 30 } },
  { capability: "swarm.run", toolId: "swarm.execute", local: true, latency: { p95Ms: 20000 } },
  { capability: "markovian.chain", toolId: "markovian.chain", local: true, latency: { p95Ms: 15000 } },
  { capability: "email.draft", toolId: "email.compose", local: true, latency: { p95Ms: 2000 }, surfaces: ["inbox", "chat"] },
  { capability: "email.send", toolId: "smtp.send", local: true, latency: { p95Ms: 1500 }, surfaces: ["inbox", "chat"] },
  { capability: "calendar.create", toolId: "calendar.create", local: true, latency: { p95Ms: 300 } },
  { capability: "approval.require", toolId: "scout.approval", local: true, latency: { p95Ms: 10 } },
];

export class CapabilityGraph {
  private readonly tools = new Map<string, ToolRegistration[]>();
  private readonly deps = new Map<string, string[]>();

  constructor(withDefaults = true) {
    if (withDefaults) for (const t of DEFAULT_TOOLS) this.register(t);
  }

  register(t: ToolRegistration): void {
    const list = (this.tools.get(t.capability) ?? []).filter((x) => x.toolId !== t.toolId);
    list.push(t);
    this.tools.set(t.capability, list);
  }

  unregister(capability: string, toolId?: string): void {
    if (!toolId) this.tools.delete(capability);
    else this.tools.set(capability, (this.tools.get(capability) ?? []).filter((t) => t.toolId !== toolId));
  }

  /** Declare that a capability needs others (walked transitively). */
  depend(capability: string, needs: string[]): void {
    this.deps.set(capability, needs);
  }

  /** Every capability and tool id known to the graph. */
  known(): string[] {
    const out = new Set<string>();
    for (const [cap, list] of this.tools) {
      out.add(cap);
      for (const t of list) out.add(t.toolId);
    }
    return [...out];
  }

  expand(caps: string[]): string[] {
    const out: string[] = [];
    const visit = (c: string, stack: string[]) => {
      if (stack.includes(c)) return;
      for (const d of this.deps.get(c) ?? []) visit(d, [...stack, c]);
      if (!out.includes(c)) out.push(c);
    };
    for (const c of caps) visit(c, []);
    return out;
  }

  /** Pick one tool per capability by permissions, availability, surface, cost/latency, then local first. */
  resolve(capability: string, req: RouteRequest): ToolRegistration | RouteFailure["reason"] {
    const all = this.tools.get(capability) ?? [];
    if (!all.length) return "unresolvable";
    const perms = new Set(req.permissions ?? []);
    const permitted = all.filter((t) => (t.requiredPermissions ?? []).every((p) => perms.has(p)));
    if (!permitted.length) return "permission";
    const up = permitted.filter((t) => !req.offline?.has(t.toolId) && (t.availability ? safe(t.availability) : true));
    if (!up.length) return "unavailable";
    const budget = req.latencyBudgetMs ?? Infinity;
    const ranked = [...up].sort((a, b) => {
      const sa = a.surfaces?.includes(req.surface) ? 0 : 1;
      const sb = b.surfaces?.includes(req.surface) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const la = (a.latency?.p95Ms ?? 0) <= budget ? 0 : 1;
      const lb = (b.latency?.p95Ms ?? 0) <= budget ? 0 : 1;
      if (la !== lb) return la - lb;
      const ca = a.cost?.perCall ?? 0;
      const cb = b.cost?.perCall ?? 0;
      if (ca !== cb) return ca - cb;
      return (a.local === false ? 1 : 0) - (b.local === false ? 1 : 0);
    });
    return ranked[0];
  }

  plan(req: RouteRequest): { steps: ToolStep[]; failures: RouteFailure[] } {
    const steps: ToolStep[] = [];
    const failures: RouteFailure[] = [];
    for (const capability of this.expand(req.capabilities)) {
      const r = this.resolve(capability, req);
      if (typeof r === "string") failures.push({ capability, reason: r, fromIntent: req.intent });
      else steps.push({ capability, tool: r.toolId, input: req.input, fromIntent: req.intent, local: r.local !== false });
    }
    return { steps, failures };
  }
}

function safe(f: () => boolean): boolean {
  try {
    return Boolean(f());
  } catch {
    return false;
  }
}

// ---- model profiles ----------------------------------------------------------

export interface ModelProfile {
  id: string;
  provider: string;
  model: string;
  context: number;
  cost: { in: number; out: number };
  latency: { p95Ms: number };
  capabilities: string[];
  dataClasses: DataClass[];
  quality?: number;
  local?: boolean;
  fallbacks?: string[];
}

export interface ModelProfileRef {
  id: string;
  provider: string;
  model: string;
  local: boolean;
}

export const DEFAULT_PROFILES: ModelProfile[] = [
  { id: "local-fast", provider: "local", model: "small-instruct", context: 8000, cost: { in: 0, out: 0 }, latency: { p95Ms: 1500 },
    capabilities: ["text", "json-mode"], dataClasses: ["public", "internal", "confidential", "restricted"], quality: 1, local: true },
  { id: "local-capable", provider: "local", model: "medium-instruct", context: 32000, cost: { in: 0, out: 0 }, latency: { p95Ms: 4000 },
    capabilities: ["text", "json-mode", "function-calling"], dataClasses: ["public", "internal", "confidential", "restricted"], quality: 2, local: true },
  { id: "remote-fast", provider: "byok", model: "remote-small", context: 128000, cost: { in: 0.0001, out: 0.0004 }, latency: { p95Ms: 800 },
    capabilities: ["text", "json-mode", "function-calling"], dataClasses: ["public", "internal"], quality: 2, local: false },
  { id: "remote-capable", provider: "byok", model: "remote-large", context: 200000, cost: { in: 0.003, out: 0.015 }, latency: { p95Ms: 6000 },
    capabilities: ["text", "json-mode", "function-calling", "vision"], dataClasses: ["public", "internal"], quality: 3, local: false },
];

export interface ModelTask {
  needs: string[];
  dataClass: DataClass;
  promptTokens: number;
  riskClass: "low" | "medium" | "high";
  costMaxUSD?: number;
  latencyMs?: number;
}

export class ModelRouter {
  readonly profiles: ModelProfile[];

  constructor(profiles: string | ModelProfile[] = DEFAULT_PROFILES, readonly routing: "local-first" | "cloud-first" = "local-first") {
    const list = typeof profiles === "string" ? JSON.parse(readFileSync(profiles, "utf8")) : profiles;
    this.profiles = (Array.isArray(list) ? list : list.profiles).map((p: ModelProfile) => ({
      ...p,
      local: p.local ?? (p.provider === "local" || p.provider === "webllm" || p.provider === "onnx" || p.provider === "ollama"),
    }));
  }

  pick(task: ModelTask): ModelProfileRef | undefined {
    const fits = this.profiles.filter((p) =>
      task.needs.every((n) => p.capabilities.includes(n))
      && p.dataClasses.includes(task.dataClass)
      && p.context >= task.promptTokens + 2000);
    if (!fits.length) return undefined;
    const est = (p: ModelProfile) => (task.promptTokens / 1000) * p.cost.in + 1 * p.cost.out;
    const within = fits.filter((p) => (task.costMaxUSD === undefined || est(p) <= task.costMaxUSD) && (task.latencyMs === undefined || p.latency.p95Ms <= task.latencyMs));
    const pool = within.length ? within : fits;
    const sensitive = task.dataClass === "confidential" || task.dataClass === "restricted";
    const preferLocal = this.routing === "local-first" || sensitive;
    const sorted = [...pool].sort((a, b) => {
      if (task.riskClass === "high" && (b.quality ?? 1) !== (a.quality ?? 1)) return (b.quality ?? 1) - (a.quality ?? 1);
      if (a.local !== b.local) return preferLocal ? (a.local ? -1 : 1) : (a.local ? 1 : -1);
      if (est(a) !== est(b)) return est(a) - est(b);
      return a.latency.p95Ms - b.latency.p95Ms;
    });
    const p = sorted[0];
    return { id: p.id, provider: p.provider, model: p.model, local: Boolean(p.local) };
  }
}
