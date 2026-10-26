// Contradiction scan and resolution. Losers are marked supersededBy, never deleted
// automatically; only an explicit delete_both resolution removes records.

import type { ConflictRecord, MemoryRecord, ResolutionStrategy } from "./types.ts";
import { DEFAULTS, tidy } from "./types.ts";
import type { TrustLedgerService } from "./ledger.ts";
import { snapshot } from "./ledger.ts";
import type { MemoryStoreService } from "./store.ts";
import { NEGATIONS, cosine, jaccard, rawTokens, stem, STOPWORDS } from "./text.ts";

const OPPOSITES: [string, string][] = [
  ["always", "never"],
  ["enable", "disable"],
  ["enabled", "disabled"],
  ["include", "exclude"],
  ["included", "excluded"],
  ["inclusion", "exclusion"],
  ["eligible", "ineligible"],
  ["allow", "forbid"],
  ["allowed", "forbidden"],
  ["before", "after"],
  ["required", "optional"],
  ["accept", "reject"],
  ["accepted", "rejected"],
  ["true", "false"],
  ["positive", "negative"],
  ["above", "below"],
  ["increase", "decrease"],
  ["prefer", "avoid"],
];
const OPPOSITE_WORDS = new Set(OPPOSITES.flat());

function residual(text: string): Set<string> {
  return new Set(
    rawTokens(text)
      .filter((t) => !OPPOSITE_WORDS.has(t) && !NEGATIONS.has(t) && !STOPWORDS.has(t) && !/^\d+(\.\d+)?$/.test(t))
      .map(stem),
  );
}

function numbers(text: string): Set<string> {
  return new Set(text.match(/\d+(\.\d+)?/g) ?? []);
}

export class ConflictDetectionService {
  private conflicts = new Map<string, ConflictRecord>();
  private seq = 0;

  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly defaultActor = "system",
  ) {}

  // Detects new conflicts and returns every conflict still awaiting a decision.
  scan(actor = this.defaultActor): ConflictRecord[] {
    const active = this.store.all().filter((m) => !m.supersededBy);
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        if (a.supersedes === b.id || b.supersedes === a.id) continue;
        if (this.pairKnown(a.id, b.id)) continue;
        const found = this.detect(a, b);
        if (!found) continue;
        this.seq += 1;
        const c: ConflictRecord = {
          id: `conflict_${this.clock().toString(36)}_${this.seq.toString(36)}`,
          memoryA: a.id,
          memoryB: b.id,
          kind: found.kind,
          reason: found.reason,
          confidence: found.confidence,
          status: "open",
          detectedAt: this.clock(),
        };
        this.conflicts.set(c.id, c);
        for (const id of [a.id, b.id]) {
          this.ledger.append({ memoryId: id, action: "conflict_detected", actor, details: { conflictId: c.id, kind: c.kind, reason: c.reason, confidence: c.confidence } });
        }
      }
    }
    return this.pending();
  }

  detect(a: MemoryRecord, b: MemoryRecord): { kind: ConflictRecord["kind"]; reason: string; confidence: number } | undefined {
    const ta = new Set(rawTokens(a.content));
    const tb = new Set(rawTokens(b.content));
    const overlap = jaccard(residual(a.content), residual(b.content));
    const sim = cosine(a.embedding, b.embedding);
    let kind: ConflictRecord["kind"] | undefined;
    let reason = "";
    let base = 0;

    for (const [x, y] of OPPOSITES) {
      const aX = ta.has(x), aY = ta.has(y), bX = tb.has(x), bY = tb.has(y);
      if (((aX && !aY && bY && !bX) || (aY && !aX && bX && !bY)) && overlap >= 0.5) {
        kind = "opposing_phrase";
        reason = `opposing phrases "${x}" / "${y}" on similar content`;
        base = 0.6;
        break;
      }
    }
    if (!kind) {
      const na = numbers(a.content), nb = numbers(b.content);
      if (na.size > 0 && nb.size > 0 && overlap >= 0.6 && sim >= 0.6 && jaccard(na, nb) < 1) {
        kind = "numeric_divergence";
        reason = `similar claims with divergent values (${[...na].join(",")} vs ${[...nb].join(",")})`;
        base = 0.55;
      }
    }
    if (!kind) {
      const negA = [...ta].some((t) => NEGATIONS.has(t));
      const negB = [...tb].some((t) => NEGATIONS.has(t));
      if (negA !== negB && overlap >= 0.7) {
        kind = "negation";
        reason = "one claim negates the other";
        base = 0.5;
      }
    }
    if (!kind) return undefined;

    let confidence = base + 0.2 * overlap;
    const namesA = new Set(a.entities.map((e) => e.name));
    if (b.entities.some((e) => namesA.has(e.name))) confidence += 0.1;
    if (a.domain === b.domain) confidence += 0.1;
    if (a.relatedTo.includes(b.id) || b.relatedTo.includes(a.id)) confidence -= 0.1;
    return { kind, reason, confidence: tidy(Math.min(1, Math.max(0, confidence))) };
  }

  // Weighted auto-decision. Resolves only at decision confidence >= 0.70.
  decide(c: ConflictRecord): { winner: string; loser: string; decisionConfidence: number } | undefined {
    const a = this.store.get(c.memoryA);
    const b = this.store.get(c.memoryB);
    if (!a || !b) return undefined;
    const pair = (x: number, y: number) => (x + y === 0 ? 0.5 : x / (x + y));
    const recA = a.timestamp === b.timestamp ? 0.5 : a.timestamp > b.timestamp ? 1 : 0;
    const accA = pair(a.accessCount, b.accessCount);
    const richA = pair(a.content.length, b.content.length);
    const relA = pair(sourceReliability(a), sourceReliability(b));
    const sA = 0.25 * recA + 0.15 * accA + 0.35 * a.confidence + 0.1 * richA + 0.15 * relA;
    const sB = 0.25 * (1 - recA) + 0.15 * (1 - accA) + 0.35 * b.confidence + 0.1 * (1 - richA) + 0.15 * (1 - relA);
    const margin = Math.abs(sA - sB);
    const decisionConfidence = tidy(Math.min(1, (0.5 + 1.5 * margin) * (0.7 + 0.3 * c.confidence)));
    return sA >= sB
      ? { winner: a.id, loser: b.id, decisionConfidence }
      : { winner: b.id, loser: a.id, decisionConfidence };
  }

  autoResolve(c: ConflictRecord | string, actor = this.defaultActor): "resolved" | "queued" {
    const conflict = typeof c === "string" ? this.conflicts.get(c) : this.conflicts.get(c.id) ?? c;
    if (!conflict) throw new Error("hmem: unknown conflict");
    if (conflict.status === "resolved") return "resolved";
    const d = this.decide(conflict);
    if (!d || d.decisionConfidence < DEFAULTS.conflictAutoResolveGate) {
      conflict.status = "queued";
      if (d) conflict.decisionConfidence = d.decisionConfidence;
      this.conflicts.set(conflict.id, conflict);
      return "queued";
    }
    const strategy: ResolutionStrategy = d.winner === conflict.memoryA ? "keep_a" : "keep_b";
    this.resolve(conflict.id, strategy, actor, { auto: true, decisionConfidence: d.decisionConfidence });
    return "resolved";
  }

  resolve(conflictId: string, strategy: ResolutionStrategy, actor = this.defaultActor, extra: Record<string, unknown> = {}): ConflictRecord {
    const c = this.conflicts.get(conflictId);
    if (!c) throw new Error(`hmem: unknown conflict ${conflictId}`);
    const a = this.store.get(c.memoryA);
    const b = this.store.get(c.memoryB);
    const before = { a: snapshot(a), b: snapshot(b) };
    const details = { conflictId, strategy, reason: c.reason, ...extra };

    if ((strategy === "keep_a" || strategy === "keep_b") && a && b) {
      const [win, lose] = strategy === "keep_a" ? [a, b] : [b, a];
      this.store.markSuperseded(lose.id, win.id, actor, `conflict ${conflictId} resolved ${strategy}`);
    } else if (strategy === "merge" && a && b) {
      const merged = this.store.add({
        content: `${a.content} / ${b.content}`,
        source: "conflict_merge",
        type: a.type,
        layer: "long_term",
        confidence: Math.max(a.confidence, b.confidence),
        tags: [...new Set([...a.tags, ...b.tags])],
        derivedFrom: [a.id, b.id],
        actor,
        skipEnrichmentLinks: true,
      });
      this.store.markSuperseded(a.id, merged.id, actor, `conflict ${conflictId} merged`);
      this.store.update(b.id, { supersededBy: merged.id }, { actor, details: { reason: `conflict ${conflictId} merged` } });
    } else if (strategy === "delete_both") {
      if (a) this.store.delete(a.id, { actor, details });
      if (b) this.store.delete(b.id, { actor, details });
    }

    c.status = "resolved";
    c.resolution = strategy;
    c.resolvedAt = this.clock();
    if (typeof extra.decisionConfidence === "number") c.decisionConfidence = extra.decisionConfidence;
    for (const [key, id] of [["a", c.memoryA], ["b", c.memoryB]] as const) {
      const now = this.store.get(id);
      this.ledger.append({
        memoryId: id,
        action: "conflict_resolved",
        actor,
        previousState: before[key],
        newState: now ? snapshot(now) : undefined,
        details,
      });
    }
    return c;
  }

  get(id: string): ConflictRecord | undefined {
    return this.conflicts.get(id);
  }

  pending(): ConflictRecord[] {
    return [...this.conflicts.values()].filter((c) => c.status !== "resolved");
  }

  all(): ConflictRecord[] {
    return [...this.conflicts.values()];
  }

  hasOpenConflict(memoryId: string): boolean {
    return this.pending().some((c) => c.memoryA === memoryId || c.memoryB === memoryId);
  }

  toJSON(): { seq: number; conflicts: ConflictRecord[] } {
    return { seq: this.seq, conflicts: this.all() };
  }

  load(data: { seq: number; conflicts: ConflictRecord[] } | undefined): void {
    this.conflicts = new Map((data?.conflicts ?? []).map((c) => [c.id, { ...c }]));
    this.seq = data?.seq ?? this.conflicts.size;
  }

  private pairKnown(x: string, y: string): boolean {
    for (const c of this.conflicts.values()) {
      if ((c.memoryA === x && c.memoryB === y) || (c.memoryA === y && c.memoryB === x)) return true;
    }
    return false;
  }
}

function sourceReliability(m: MemoryRecord): number {
  const s = m.source.toLowerCase();
  if (s.includes("user_correction") || m.tags.includes("correction")) return 1;
  if (m.provenance?.origin === "user_explicit" || s.startsWith("user") || s.startsWith("navigator")) return 0.8;
  if (s.includes("dream") || s.includes("sleep") || s.includes("inference")) return 0.6;
  return 0.5;
}
