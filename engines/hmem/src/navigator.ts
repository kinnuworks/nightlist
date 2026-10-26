// Nightlist domain wrapper: remembers navigator decisions, criterion corrections and
// patient preferences across nightly runs, and recalls them for reinjection.

import type { DreamProposal, FeedbackKind, LedgerEntry, MemoryLayer, MemoryOrigin, MemoryRecord, MemoryType, ScoreSignals } from "./types.ts";
import { DAY_MS } from "./types.ts";
import { HMEM } from "./hmem.ts";
import { extractEntities } from "./text.ts";

export type NavigatorKind = "preference" | "correction" | "decision" | "fact";

export interface NavigatorDecision {
  patientId?: string;
  trialId?: string;
  criterionId?: string;
  kind: NavigatorKind;
  text: string;
  actor: string;
}

export interface NavigatorRecord {
  id: string;
  kind: NavigatorKind | "derived";
  text: string;
  actor?: string;
  patientId?: string;
  trialId?: string;
  criterionId?: string;
  layer: MemoryLayer;
  confidence: number;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  tags: string[];
  supersedes?: string;
  supersededBy?: string;
  derivedFrom: string[];
  archived: boolean;
}

export interface RecallContext {
  patientId?: string;
  trialId?: string;
  query: string;
  topN?: number;
  threshold?: number;
  actor?: string;
  includeSuperseded?: boolean;
}

export interface RecalledMemory extends NavigatorRecord {
  score: number;
  why: {
    layer: MemoryLayer;
    confidence: number;
    recency: number;
    daysSinceAccess: number;
    superseded: boolean;
    matchedPatient: boolean;
    matchedTrial: boolean;
    signals: ScoreSignals;
  };
}

export interface HistoryEntry {
  id: string;
  action: LedgerEntry["action"];
  actor: string;
  at: string;
  timestamp: number;
  previous?: LedgerEntry["previousState"];
  next?: LedgerEntry["newState"];
  details?: Record<string, unknown>;
}

export interface NightlyReport {
  ranAt: string;
  conflicts: {
    detected: number;
    autoResolved: number;
    queued: { id: string; memoryA: string; memoryB: string; reason: string; decisionConfidence?: number }[];
  };
  sleep: {
    backupId: string;
    preview: { toConsolidate: number; toArchive: number; toSynthesize: number; protected: number };
    consolidated: { id: string; text: string }[];
    archived: { id: string; text: string }[];
    synthesized: { id: string; text: string; derivedFrom: string[] }[];
    actionLog: string[];
  };
  dreaming: {
    proposals: { id: string; type: DreamProposal["type"]; content: string; derivedFrom: string[]; confidence: number }[];
    pendingTotal: number;
  };
  forgetting: { demoted: number };
  totals: { active: number; archived: number; ledgerEntries: number };
}

export interface NavigatorOptions {
  clock?: () => number;
  // When set, state is loaded from and saved to this JSON file.
  file?: string;
  // Save after every mutation when a file is set. Default true.
  autosave?: boolean;
  hmem?: HMEM;
}

const KINDS: Record<NavigatorKind, { type: MemoryType; layer: MemoryLayer; confidence: number; origin: MemoryOrigin }> = {
  // 0.9 keeps explicit preferences above the sleep archive guardrail.
  preference: { type: "preference", layer: "working", confidence: 0.9, origin: "user_explicit" },
  correction: { type: "factual", layer: "long_term", confidence: 0.95, origin: "user_explicit" },
  decision: { type: "factual", layer: "working", confidence: 0.8, origin: "decision" },
  fact: { type: "factual", layer: "working", confidence: 0.75, origin: "user_explicit" },
};

// Lower than the engine default of 0.35 because the offline hashed embedder gives
// smaller semantic scores than a learned embedding model would.
export const DEFAULT_RECALL_THRESHOLD = 0.2;

const tagValue = (tags: string[], prefix: string): string | undefined => {
  const t = tags.find((x) => x.startsWith(prefix + ":"));
  return t ? t.slice(prefix.length + 1) : undefined;
};

const normTrial = (id: string) => id.trim().toUpperCase();
const iso = (ms: number) => new Date(ms).toISOString();

export class NavigatorMemory {
  readonly hmem: HMEM;
  readonly file?: string;
  private readonly autosave: boolean;
  private readonly clock: () => number;

  constructor(opts: NavigatorOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.file = opts.file;
    this.autosave = opts.autosave ?? true;
    // Forgetting runs inside nightly() after sleep, not on every load.
    this.hmem = opts.hmem ?? (opts.file ? HMEM.loadFile(opts.file, { clock: this.clock, forgetting: false }) : new HMEM({ clock: this.clock }));
  }

  static open(file: string, opts: Omit<NavigatorOptions, "file" | "hmem"> = {}): NavigatorMemory {
    return new NavigatorMemory({ ...opts, file });
  }

  remember(decision: NavigatorDecision): NavigatorRecord {
    const spec = KINDS[decision?.kind];
    if (!spec) throw new Error(`navigator: unknown kind ${decision?.kind}`);
    const text = decision.text?.trim();
    if (!text) throw new Error("navigator: text is required");
    const actor = decision.actor?.trim();
    if (!actor) throw new Error("navigator: actor is required");

    const tags = [`kind:${decision.kind}`];
    const entities = extractEntities(text);
    if (decision.patientId) {
      tags.push(`patient:${decision.patientId}`);
      entities.unshift({ name: `patient:${decision.patientId}`.toLowerCase(), type: "patient" });
    }
    if (decision.trialId) {
      const nct = normTrial(decision.trialId);
      tags.push(`trial:${nct}`);
      if (!entities.some((e) => e.name === nct.toLowerCase())) entities.unshift({ name: nct.toLowerCase(), type: "trial" });
    }
    if (decision.criterionId) {
      tags.push(`criterion:${decision.criterionId}`);
      entities.unshift({ name: `criterion:${decision.criterionId}`.toLowerCase(), type: "criterion" });
    }
    if (decision.kind === "correction") tags.push("correction");

    const prior = decision.kind === "correction" && decision.criterionId ? this.activeCorrections(decision.criterionId) : [];
    const m = this.hmem.add({
      content: text,
      source: `navigator:${actor}`,
      type: spec.type,
      layer: spec.layer,
      confidence: spec.confidence,
      tags,
      entities: entities.slice(0, 10),
      provenance: {
        origin: spec.origin,
        label: `${decision.kind} recorded by ${actor}${decision.trialId ? ` for ${normTrial(decision.trialId)}` : ""}`,
      },
      ...(prior[0] ? { supersedes: prior[0].id } : {}),
      actor,
    });
    // Older stray corrections for the same criterion are superseded too.
    for (const p of prior.slice(1)) this.hmem.store.markSuperseded(p.id, m.id, actor, "newer correction for the same criterion");
    this.persist();
    return this.view(m);
  }

  recall(context: RecallContext): RecalledMemory[] {
    if (!context?.query?.trim()) throw new Error("navigator: query is required");
    const patientTag = context.patientId ? `patient:${context.patientId}` : undefined;
    const trialTag = context.trialId ? `trial:${normTrial(context.trialId)}` : undefined;
    const now = this.clock();
    const result = this.hmem.query(context.query, {
      topN: context.topN ?? 5,
      threshold: context.threshold ?? DEFAULT_RECALL_THRESHOLD,
      tags: [patientTag, trialTag].filter((t): t is string => !!t),
      entities: [patientTag, context.trialId ? normTrial(context.trialId) : undefined].filter((t): t is string => !!t),
      actor: context.actor ?? "nightly",
      filter: (m) => {
        const p = tagValue(m.tags, "patient");
        // Another patient's memories never leak into this patient's recall.
        if (p !== undefined && p !== context.patientId) return false;
        if (!context.includeSuperseded && m.supersededBy) return false;
        if (m.tags.includes("review")) return false;
        return true;
      },
    });
    this.persist();
    return result.memories.map((r) => ({
      ...this.view(r.memory),
      score: r.relevance,
      why: {
        layer: r.memory.layer,
        confidence: r.memory.confidence,
        recency: Math.round(r.signals.recency * 1000) / 1000,
        daysSinceAccess: Math.round(((now - (r.memory.lastAccessed > now ? now : r.memory.lastAccessed)) / DAY_MS) * 10) / 10,
        superseded: !!r.memory.supersededBy,
        matchedPatient: !!patientTag && r.memory.tags.includes(patientTag),
        matchedTrial: !!trialTag && r.memory.tags.includes(trialTag),
        signals: roundSignals(r.signals),
      },
    }));
  }

  correctionFor(criterionId: string): NavigatorRecord | undefined {
    const active = this.activeCorrections(criterionId);
    return active[0] ? this.view(active[0]) : undefined;
  }

  nightly(opts: { actor?: string } = {}): NightlyReport {
    const actor = opts.actor ?? "nightly";
    const h = this.hmem;

    const pendingBefore = new Set(h.conflicts.pending().map((c) => c.id));
    const pending = h.conflicts.scan(actor);
    const detected = pending.filter((c) => !pendingBefore.has(c.id)).length;
    let autoResolved = 0;
    for (const c of pending) if (h.conflicts.autoResolve(c, actor) === "resolved") autoResolved++;
    const queued = h.conflicts.pending().map((c) => ({ id: c.id, memoryA: c.memoryA, memoryB: c.memoryB, reason: c.reason, decisionConfidence: c.decisionConfidence }));

    const preview = h.sleep.preview();
    const textOf = (id: string) => (h.store.get(id) ?? h.store.getArchived(id))?.content ?? "";
    const report = h.sleep.execute(preview, actor);

    const demoted = h.runForgetting();
    const proposals = h.dreaming.dream(actor);

    const out: NightlyReport = {
      ranAt: iso(this.clock()),
      conflicts: { detected, autoResolved, queued },
      sleep: {
        backupId: report.backupId,
        preview: {
          toConsolidate: preview.toConsolidate.length,
          toArchive: preview.toArchive.length,
          toSynthesize: preview.toSynthesize.length,
          protected: preview.protected.length,
        },
        consolidated: report.consolidated.map((id) => ({ id, text: textOf(id) })),
        archived: report.archived.map((id) => ({ id, text: textOf(id) })),
        synthesized: report.synthesized.map((s) => ({ id: s.id, text: textOf(s.id), derivedFrom: s.derivedFrom })),
        actionLog: report.actionLog,
      },
      dreaming: {
        proposals: proposals.map((p) => ({ id: p.id, type: p.type, content: p.content, derivedFrom: p.derivedFrom, confidence: p.confidence })),
        pendingTotal: h.dreaming.pending().length,
      },
      forgetting: { demoted },
      totals: { active: h.store.all().length, archived: h.store.allArchived().length, ledgerEntries: h.ledger.size },
    };
    this.persist();
    return out;
  }

  history(id: string, opts: { includeReads?: boolean } = {}): HistoryEntry[] {
    return this.hmem.ledger
      .history(id)
      .filter((e) => opts.includeReads || e.action !== "read")
      .map((e) => ({
        id: e.id,
        action: e.action,
        actor: e.actor,
        at: iso(e.timestamp),
        timestamp: e.timestamp,
        ...(e.previousState ? { previous: e.previousState } : {}),
        ...(e.newState ? { next: e.newState } : {}),
        ...(e.details ? { details: e.details } : {}),
      }));
  }

  feedback(id: string, kind: FeedbackKind, actor: string): NavigatorRecord {
    const m = this.hmem.feedback(id, kind, actor);
    this.persist();
    return this.view(m);
  }

  get(id: string): NavigatorRecord | undefined {
    const m = this.hmem.store.get(id) ?? this.hmem.store.getArchived(id);
    return m ? this.view(m) : undefined;
  }

  list(filter: { patientId?: string; trialId?: string; criterionId?: string; kind?: NavigatorKind; includeSuperseded?: boolean } = {}): NavigatorRecord[] {
    return this.hmem.store
      .all()
      .filter((m) => {
        if (filter.patientId && !m.tags.includes(`patient:${filter.patientId}`)) return false;
        if (filter.trialId && !m.tags.includes(`trial:${normTrial(filter.trialId)}`)) return false;
        if (filter.criterionId && !m.tags.includes(`criterion:${filter.criterionId}`)) return false;
        if (filter.kind && !m.tags.includes(`kind:${filter.kind}`)) return false;
        if (!filter.includeSuperseded && m.supersededBy) return false;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((m) => this.view(m));
  }

  proposals(): DreamProposal[] {
    return this.hmem.dreaming.pending();
  }

  approveProposal(id: string, actor: string): NavigatorRecord | undefined {
    const m = this.hmem.dreaming.approve(id, actor);
    this.persist();
    return m ? this.view(m) : undefined;
  }

  rejectProposal(id: string, actor: string, reason?: string): DreamProposal {
    const p = this.hmem.dreaming.reject(id, actor, reason);
    this.persist();
    return p;
  }

  save(file = this.file): void {
    if (!file) throw new Error("navigator: no file configured");
    this.hmem.saveFile(file);
  }

  toJSON() {
    return this.hmem.toJSON();
  }

  private persist(): void {
    if (this.file && this.autosave) this.hmem.saveFile(this.file);
  }

  // Newest first: active (not superseded) corrections for a criterion.
  private activeCorrections(criterionId: string): MemoryRecord[] {
    const tag = `criterion:${criterionId}`;
    return this.hmem.store
      .all()
      .filter((m) => m.tags.includes(tag) && m.tags.includes("kind:correction") && !m.supersededBy)
      .sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1));
  }

  private view(m: MemoryRecord): NavigatorRecord {
    const kind = tagValue(m.tags, "kind") as NavigatorKind | undefined;
    const archived = !this.hmem.store.has(m.id);
    return {
      id: m.id,
      kind: kind ?? "derived",
      text: m.content,
      ...(m.source.startsWith("navigator:") ? { actor: m.source.slice("navigator:".length) } : {}),
      ...(tagValue(m.tags, "patient") ? { patientId: tagValue(m.tags, "patient") } : {}),
      ...(tagValue(m.tags, "trial") ? { trialId: tagValue(m.tags, "trial") } : {}),
      ...(tagValue(m.tags, "criterion") ? { criterionId: tagValue(m.tags, "criterion") } : {}),
      layer: m.layer,
      confidence: m.confidence,
      createdAt: iso(m.timestamp),
      lastAccessedAt: iso(m.lastAccessed),
      accessCount: m.accessCount,
      tags: [...m.tags],
      ...(m.supersedes ? { supersedes: m.supersedes } : {}),
      ...(m.supersededBy ? { supersededBy: m.supersededBy } : {}),
      derivedFrom: [...m.derivedFrom],
      archived,
    };
  }
}

function roundSignals(s: ScoreSignals): ScoreSignals {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    semantic: r(s.semantic), keyword: r(s.keyword), tag: r(s.tag), domain: r(s.domain), entity: r(s.entity),
    layer: r(s.layer), recency: r(s.recency), superseded: s.superseded, raw: r(s.raw), confidence: r(s.confidence),
  };
}
