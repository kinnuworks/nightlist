// Append-only trust ledger. Entries are never edited or pruned.

import type { LedgerAction, LedgerEntry, MemoryRecord } from "./types.ts";

export type LedgerInput = Omit<LedgerEntry, "id" | "timestamp"> & { timestamp?: number };

const SNAPSHOT_KEYS: (keyof MemoryRecord)[] = [
  "content", "type", "layer", "confidence", "accessCount", "tags", "domain", "namespace",
  "supersedes", "supersededBy", "derivedFrom", "relatedTo", "source",
];

// Small state snapshot for previousState/newState, without embeddings.
export function snapshot(m: MemoryRecord | undefined, keys: (keyof MemoryRecord)[] = SNAPSHOT_KEYS): Partial<MemoryRecord> | undefined {
  if (!m) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = m[k];
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out as Partial<MemoryRecord>;
}

export class TrustLedgerService {
  private entries: LedgerEntry[] = [];
  private seq = 0;

  constructor(private readonly clock: () => number) {}

  append(input: LedgerInput): LedgerEntry {
    this.seq += 1;
    const entry: LedgerEntry = {
      id: `led_${this.seq.toString(36).padStart(6, "0")}`,
      memoryId: input.memoryId,
      action: input.action,
      actor: input.actor,
      timestamp: input.timestamp ?? this.clock(),
      ...(input.previousState ? { previousState: input.previousState } : {}),
      ...(input.newState ? { newState: input.newState } : {}),
      ...(input.details ? { details: input.details } : {}),
    };
    this.entries.push(Object.freeze(entry));
    return entry;
  }

  history(memoryId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.memoryId === memoryId);
  }

  byAction(action: LedgerAction): LedgerEntry[] {
    return this.entries.filter((e) => e.action === action);
  }

  range(from: number, to: number): LedgerEntry[] {
    return this.entries.filter((e) => e.timestamp >= from && e.timestamp <= to);
  }

  stats(): { total: number; byAction: Record<string, number>; byActor: Record<string, number> } {
    const byAction: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    for (const e of this.entries) {
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
      byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;
    }
    return { total: this.entries.length, byAction, byActor };
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }

  export(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n");
  }

  toJSON(): { seq: number; entries: LedgerEntry[] } {
    return { seq: this.seq, entries: this.entries };
  }

  load(data: { seq: number; entries: LedgerEntry[] }): void {
    this.entries = (data?.entries ?? []).map((e) => Object.freeze({ ...e }));
    this.seq = Math.max(data?.seq ?? 0, this.entries.length);
  }
}
