// Dreaming: clusters memories and proposes insights, invariants and domain moves.
// Nothing is materialized until a proposal is approved.

import type { DreamProposal, DreamProposalType, MemoryRecord } from "./types.ts";
import { DEFAULTS } from "./types.ts";
import type { TrustLedgerService } from "./ledger.ts";
import type { MemoryStoreService } from "./store.ts";
import { cosine, jaccard, preview } from "./text.ts";

export class DreamingService {
  private proposals = new Map<string, DreamProposal>();
  private seq = 0;

  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly defaultActor = "system",
  ) {}

  relatedness(a: MemoryRecord, b: MemoryRecord): number {
    if (!scopeCompatible(a, b)) return 0;
    const sim = cosine(a.embedding, b.embedding);
    const tags = jaccard(a.tags, b.tags);
    const sameDomainOrType = (a.domain === b.domain && a.domain !== "general") || a.type === b.type ? 1 : 0;
    const ents = jaccard(a.entities.map((e) => e.name), b.entities.map((e) => e.name));
    const linked = a.relatedTo.includes(b.id) || b.relatedTo.includes(a.id) ? 1 : 0;
    return 0.45 * sim + 0.15 * tags + 0.15 * sameDomainOrType + 0.15 * ents + 0.1 * linked;
  }

  // Greedy average-link clustering: a memory joins the cluster whose members it is,
  // on average, most related to, if that average clears the relatedness threshold.
  cluster(memories: MemoryRecord[] = this.eligible()): MemoryRecord[][] {
    const ordered = [...memories].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
    const clusters: MemoryRecord[][] = [];
    for (const m of ordered) {
      let best: MemoryRecord[] | undefined;
      let bestScore: number = DEFAULTS.dreamRelatedness;
      for (const c of clusters) {
        const s = avg(c.map((o) => this.relatedness(m, o)));
        if (s >= bestScore) {
          best = c;
          bestScore = s;
        }
      }
      if (best) best.push(m);
      else clusters.push([m]);
    }
    return clusters.filter((g) => g.length >= DEFAULTS.dreamClusterMinSize);
  }

  dream(actor = this.defaultActor): DreamProposal[] {
    const memories = this.eligible();
    const clusters = this.cluster(memories);
    const created: DreamProposal[] = [];
    const counts: Record<DreamProposalType, number> = { insight: 0, domain: 0, invariant: 0 };
    const propose = (type: DreamProposalType, content: string, from: MemoryRecord[], confidence: number, suggestedDomain?: string) => {
      if (counts[type] >= DEFAULTS.maxDreamProposalsPerType) return;
      const derivedFrom = from.map((m) => m.id).sort();
      if (this.seen(type, derivedFrom, suggestedDomain)) return;
      this.seq += 1;
      const p: DreamProposal = {
        id: `dream_prop_${this.clock().toString(36)}_${this.seq.toString(36)}`,
        type,
        content,
        derivedFrom,
        confidence: Math.round(confidence * 100) / 100,
        ...(suggestedDomain ? { suggestedDomain } : {}),
        status: "pending_review",
        createdAt: this.clock(),
      };
      counts[type] += 1;
      this.proposals.set(p.id, p);
      created.push(p);
      for (const id of derivedFrom) {
        this.ledger.append({ memoryId: id, action: "dream_proposed", actor, details: { proposalId: p.id, type, content: p.content } });
      }
    };

    // Insights from clusters.
    for (const c of clusters) {
      const domain = majority(c.map((m) => m.domain));
      const lines = c.slice(0, 6).map((m) => preview(m.content, 90));
      propose("insight", `Across ${c.length} related ${domain} memories: ${lines.join("; ")}`, c, avg(c.map((m) => m.confidence)) * 0.9);
    }

    // Domain suggestions for general memories that cluster with categorized ones.
    for (const c of clusters) {
      const categorized = c.filter((m) => m.domain !== "general");
      const general = c.filter((m) => m.domain === "general");
      if (general.length === 0 || categorized.length === 0) continue;
      const domain = majority(categorized.map((m) => m.domain));
      propose("domain", `Move ${general.length} uncategorized memories to domain "${domain}"`, general, 0.6, domain);
    }

    // Invariants from preference, personal and correction signals, grouped by signal
    // kind and patient scope so one patient's pattern never mixes with another's.
    const signals = memories.filter((m) => m.type === "preference" || m.type === "personal" || m.tags.includes("correction"));
    const groups = new Map<string, MemoryRecord[]>();
    for (const m of signals) {
      const signal = m.tags.includes("correction") ? "correction" : m.type;
      const scope = m.tags.find((t) => t.startsWith("patient:")) ?? "global";
      const key = `${signal}|${scope}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    for (const [key, group] of groups) {
      if (group.length < DEFAULTS.dreamClusterMinSize) continue;
      const [signal, scope] = key.split("|");
      const label = signal === "correction" ? "Recurring corrections" : signal === "personal" ? "Stable personal context" : "Stable preferences";
      const where = scope === "global" ? "" : ` for ${scope}`;
      const lines = group.slice(0, 6).map((m) => preview(m.content, 90));
      propose("invariant", `${label}${where}: ${lines.join("; ")}`, group, avg(group.map((m) => m.confidence)));
    }

    return created;
  }

  approve(proposalId: string, actor = this.defaultActor): MemoryRecord | undefined {
    const p = this.mustGetPending(proposalId);
    p.status = "approved";
    p.decidedAt = this.clock();
    let created: MemoryRecord | undefined;
    if (p.type === "domain") {
      for (const id of p.derivedFrom) {
        if (!this.store.get(id) || !p.suggestedDomain) continue;
        this.store.update(id, { domain: p.suggestedDomain, namespace: `${p.suggestedDomain}/general` }, { actor, details: { proposalId: p.id } });
      }
    } else {
      created = this.store.add({
        content: p.content,
        source: "dreaming",
        type: p.type === "insight" ? "factual" : "preference",
        layer: "long_term",
        confidence: p.confidence,
        derivedFrom: p.derivedFrom,
        tags: ["dream:" + p.type],
        provenance: { origin: "inference", label: `approved dream ${p.type} ${p.id}` },
        actor,
        skipEnrichmentLinks: true,
      });
      p.materializedId = created.id;
    }
    this.ledger.append({
      memoryId: created?.id ?? p.derivedFrom[0] ?? p.id,
      action: "dream_approved",
      actor,
      details: { proposalId: p.id, type: p.type, derivedFrom: p.derivedFrom },
    });
    return created;
  }

  reject(proposalId: string, actor = this.defaultActor, reason?: string): DreamProposal {
    const p = this.mustGetPending(proposalId);
    p.status = "rejected";
    p.decidedAt = this.clock();
    for (const id of p.derivedFrom) {
      this.ledger.append({ memoryId: id, action: "dream_rejected", actor, details: { proposalId: p.id, type: p.type, ...(reason ? { reason } : {}) } });
    }
    return p;
  }

  pending(): DreamProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === "pending_review");
  }

  all(): DreamProposal[] {
    return [...this.proposals.values()];
  }

  get(id: string): DreamProposal | undefined {
    return this.proposals.get(id);
  }

  toJSON(): { seq: number; proposals: DreamProposal[] } {
    return { seq: this.seq, proposals: this.all() };
  }

  load(data: { seq: number; proposals: DreamProposal[] } | undefined): void {
    this.proposals = new Map((data?.proposals ?? []).map((p) => [p.id, { ...p }]));
    this.seq = data?.seq ?? this.proposals.size;
  }

  // Dreams work from current knowledge: superseded and review-flagged records are skipped,
  // and so are records that dreaming itself produced.
  private eligible(): MemoryRecord[] {
    return this.store.all().filter((m) => !m.supersededBy && !m.tags.includes("review") && m.source !== "dreaming");
  }

  private seen(type: DreamProposalType, derivedFrom: string[], domain?: string): boolean {
    const key = derivedFrom.join(",");
    for (const p of this.proposals.values()) {
      if (p.type === type && p.derivedFrom.join(",") === key && p.suggestedDomain === domain) return true;
    }
    return false;
  }

  private mustGetPending(id: string): DreamProposal {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`hmem: unknown proposal ${id}`);
    if (p.status !== "pending_review") throw new Error(`hmem: proposal ${id} already ${p.status}`);
    return p;
  }
}

// Records scoped to different patients, chats or runs are never clustered together.
function scopeCompatible(a: MemoryRecord, b: MemoryRecord): boolean {
  for (const prefix of ["patient:", "chat:", "project:"]) {
    const x = a.tags.find((t) => t.startsWith(prefix));
    const y = b.tags.find((t) => t.startsWith(prefix));
    if (x && y && x !== y) return false;
  }
  if (a.chatId && b.chatId && a.chatId !== b.chatId) return false;
  if (a.goalRunId && b.goalRunId && a.goalRunId !== b.goalRunId) return false;
  return true;
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function majority(xs: string[]): string {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "general";
}
