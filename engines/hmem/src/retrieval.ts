// Hybrid retrieval ranking, reinjection formatting and feedback.

import type { FeedbackKind, MemoryRecord, QueryOptions, QueryResult, RetrievedMemory, ScoreSignals, Strategy } from "./types.ts";
import { DAY_MS, DEFAULTS, FEEDBACK_DELTAS, LAYER_WEIGHT, WEIGHTS, WEIGHT_PROFILE, clamp01, tidy } from "./types.ts";
import type { TrustLedgerService } from "./ledger.ts";
import type { MemoryStoreService } from "./store.ts";
import { classifyDomain, cosine, embed, extractEntities, tokenSet, topTokens, jaccard, rawTokens } from "./text.ts";

export class MemoryRetrievalService {
  private traceSeq = 0;

  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly defaultActor = "system",
  ) {}

  score(m: MemoryRecord, q: PreparedQuery, now = this.clock()): ScoreSignals {
    const semantic = cosine(q.embedding, m.embedding);
    const keyword = jaccard(new Set(q.keywords), tokenSet(m.content));
    const tag = tagScore(m.tags, q);
    const domain = q.domain !== "general" && m.domain === q.domain ? 1 : 0;
    const entity = entityScore(m, q.entities);
    const layer = LAYER_WEIGHT[m.layer] ?? 0.6;
    const ageDays = Math.max(0, now - m.lastAccessed) / DAY_MS;
    const recency = Math.exp(-ageDays / DEFAULTS.recencyDays);
    const superseded = m.supersededBy ? 1 : 0;
    const raw =
      WEIGHTS.semantic * semantic +
      WEIGHTS.keyword * keyword +
      WEIGHTS.tag * tag +
      WEIGHTS.domain * domain +
      WEIGHTS.entity * entity +
      WEIGHTS.layer * layer +
      WEIGHTS.recency * recency -
      WEIGHTS.superseded * superseded;
    return { semantic, keyword, tag, domain, entity, layer, recency, superseded, raw, confidence: m.confidence };
  }

  prepare(text: string, opts: QueryOptions = {}): PreparedQuery {
    const tags = opts.tags ?? [];
    return {
      text,
      embedding: embed(text),
      keywords: topTokens(text, 8),
      domain: classifyDomain(text, tags).domain,
      entities: [...new Set([...extractEntities(text).map((e) => e.name), ...(opts.entities ?? []).map((e) => e.toLowerCase())])],
      tags,
      rawTokens: new Set(rawTokens(text)),
    };
  }

  query(text: string, opts: QueryOptions = {}): QueryResult {
    const topN = opts.topN ?? DEFAULTS.topN;
    const threshold = opts.threshold ?? DEFAULTS.threshold;
    const strategy: Strategy = opts.strategy ?? "comprehensive";
    const includeUnscoped = opts.includeUnscoped ?? true;
    const now = this.clock();
    const q = this.prepare(text, opts);

    const candidates = this.store.all().filter((m) => {
      if (opts.chatId && !(m.chatId === opts.chatId || (includeUnscoped && !m.chatId))) return false;
      if (opts.missionId && !(m.missionId === opts.missionId || (includeUnscoped && !m.missionId))) return false;
      // Goal-run recall is isolated: another run's memories never leak in.
      if (opts.goalRunId ? m.goalRunId !== undefined && m.goalRunId !== opts.goalRunId : false) return false;
      if (opts.goalRunId && !m.goalRunId && !includeUnscoped) return false;
      if (opts.filter && !opts.filter(m)) return false;
      return true;
    });

    const scored: RetrievedMemory[] = candidates.map((m) => {
      const signals = this.score(m, q, now);
      const relevance = tidy(clamp01(signals.raw) * m.confidence);
      return { memory: m, relevance, signals };
    });
    scored.sort((a, b) => b.relevance - a.relevance || b.memory.timestamp - a.memory.timestamp || (a.memory.id < b.memory.id ? -1 : 1));

    const kept = scored.filter((r) => r.relevance >= threshold);
    const selected = kept.slice(0, topN);
    const suppressedSuperseded = scored.filter((r) => r.memory.supersededBy && !selected.includes(r)).length;

    this.traceSeq += 1;
    const traceId = `trace_${now.toString(36)}_${this.traceSeq.toString(36)}`;
    const scores: Record<string, number> = {};
    for (const r of selected) {
      r.memory.score = r.relevance;
      scores[r.memory.id] = r.relevance;
    }

    if (opts.touch !== false) {
      const actor = opts.actor ?? this.defaultActor;
      for (const r of selected) {
        this.store.touch(r.memory.id);
        this.ledger.append({ memoryId: r.memory.id, action: "read", actor, details: { traceId, relevance: r.relevance } });
      }
    }

    return {
      memories: selected,
      context: formatReinjection(selected, strategy),
      trace: {
        traceId,
        retrievalReason: `hybrid ranking of ${candidates.length} candidates for "${text.slice(0, 80)}" (threshold ${threshold}, topN ${topN})`,
        strategy,
        queryDomain: q.domain,
        queryEntities: q.entities,
        scores,
        weightProfile: WEIGHT_PROFILE,
        suppressedSuperseded,
      },
    };
  }

  feedback(memoryId: string, kind: FeedbackKind, actor = this.defaultActor, details?: Record<string, unknown>): MemoryRecord {
    const m = this.store.get(memoryId);
    if (!m) throw new Error(`hmem: unknown memory ${memoryId}`);
    if (!(kind in FEEDBACK_DELTAS)) throw new Error(`hmem: unknown feedback kind ${kind}`);
    const previousState = { confidence: m.confidence, accessCount: m.accessCount, tags: [...m.tags] };
    m.confidence = tidy(clamp01(m.confidence + FEEDBACK_DELTAS[kind]));
    if (kind === "helpful") m.accessCount += 1;
    if (kind === "wrong" && !m.tags.includes("review")) m.tags.push("review");
    this.ledger.append({
      memoryId,
      action: "feedback",
      actor,
      previousState,
      newState: { confidence: m.confidence, accessCount: m.accessCount, tags: [...m.tags] },
      details: { kind, delta: FEEDBACK_DELTAS[kind], ...(details ?? {}) },
    });
    return m;
  }
}

export interface PreparedQuery {
  text: string;
  embedding: number[];
  keywords: string[];
  domain: string;
  entities: string[];
  tags: string[];
  rawTokens: Set<string>;
}

// Explicit query tags compare directly; otherwise a tag counts when its value appears in the query.
function tagScore(memTags: string[], q: PreparedQuery): number {
  if (memTags.length === 0) return 0;
  if (q.tags.length > 0) {
    const mt = new Set(memTags);
    let hit = 0;
    for (const t of q.tags) if (mt.has(t)) hit++;
    return hit / q.tags.length;
  }
  let hit = 0;
  for (const t of memTags) {
    const value = t.includes(":") ? t.slice(t.indexOf(":") + 1) : t;
    const parts = rawTokens(value);
    if (parts.length > 0 && parts.every((p) => q.rawTokens.has(p))) hit++;
  }
  return Math.min(1, hit / Math.min(memTags.length, 3));
}

function entityScore(m: MemoryRecord, queryEntities: string[]): number {
  if (queryEntities.length === 0 || m.entities.length === 0) return 0;
  const names = new Set(m.entities.map((e) => e.name));
  let hit = 0;
  for (const e of queryEntities) if (names.has(e)) hit++;
  return hit / queryEntities.length;
}

// Domain-grouped context. Review-tagged memories are left out unless the strategy is audit.
export function formatReinjection(items: RetrievedMemory[], strategy: Strategy = "comprehensive"): string {
  const usable = items.filter((r) => strategy === "audit" || !r.memory.tags.includes("review"));
  if (usable.length === 0) return "";
  const groups = new Map<string, RetrievedMemory[]>();
  for (const r of usable) {
    const key = r.memory.namespace || r.memory.domain;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const lines: string[] = [];
  for (const [ns, rs] of groups) {
    for (const r of rs) {
      const ents = r.memory.entities.length ? ` {entities: ${r.memory.entities.map((e) => e.name).join(", ")}}` : "";
      const sup = r.memory.supersededBy ? " [superseded]" : "";
      lines.push(`[${ns}] (${r.memory.layer}) ${r.memory.content}${ents}${sup}`);
    }
  }
  return lines.join("\n");
}
