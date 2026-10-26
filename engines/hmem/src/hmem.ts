// H-MEM engine facade. In-memory, deterministic, offline, with JSON persistence.

import fs from "node:fs";
import path from "node:path";
import type { AddInput, FeedbackKind, MemoryRecord, QueryOptions, QueryResult } from "./types.ts";
import { TrustLedgerService } from "./ledger.ts";
import { MemoryStoreService } from "./store.ts";
import { MemoryRetrievalService } from "./retrieval.ts";
import { ConflictDetectionService } from "./conflicts.ts";
import { SleepCycleService } from "./sleep.ts";
import { DreamingService } from "./dreaming.ts";

export interface HMEMOptions {
  clock?: () => number;
  actor?: string;
}

export interface HMEMSnapshot {
  format: "nightlist-hmem";
  version: 1;
  savedAt: number;
  forgettingAt: number;
  storeSeq: number;
  records: MemoryRecord[];
  archived: (MemoryRecord & { archivedAt: number })[];
  ledger: ReturnType<TrustLedgerService["toJSON"]>;
  conflicts: ReturnType<ConflictDetectionService["toJSON"]>;
  dreaming: ReturnType<DreamingService["toJSON"]>;
  sleep: ReturnType<SleepCycleService["toJSON"]>;
}

export class HMEM {
  readonly clock: () => number;
  readonly ledger: TrustLedgerService;
  readonly store: MemoryStoreService;
  readonly retrieval: MemoryRetrievalService;
  readonly conflicts: ConflictDetectionService;
  readonly sleep: SleepCycleService;
  readonly dreaming: DreamingService;
  // Last time the forgetting curve ran; persisted so restarts do not reset it.
  forgettingAt: number;

  constructor(opts: HMEMOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    const actor = opts.actor ?? "system";
    this.ledger = new TrustLedgerService(this.clock);
    this.store = new MemoryStoreService(this.clock, this.ledger, actor);
    this.retrieval = new MemoryRetrievalService(this.store, this.ledger, this.clock, actor);
    this.conflicts = new ConflictDetectionService(this.store, this.ledger, this.clock, actor);
    this.sleep = new SleepCycleService(this.store, this.ledger, this.clock, (id) => this.conflicts.hasOpenConflict(id), actor);
    this.dreaming = new DreamingService(this.store, this.ledger, this.clock, actor);
    this.forgettingAt = this.clock();
  }

  add(input: AddInput): MemoryRecord {
    return this.store.add(input);
  }

  query(text: string, opts?: QueryOptions): QueryResult {
    return this.retrieval.query(text, opts);
  }

  feedback(memoryId: string, kind: FeedbackKind, actor?: string): MemoryRecord {
    return this.retrieval.feedback(memoryId, kind, actor);
  }

  // Embeddings are dropped and rebuilt on load to keep the file small.
  toJSON(): HMEMSnapshot {
    const snap = this.store.snapshotAll();
    return {
      format: "nightlist-hmem",
      version: 1,
      savedAt: this.clock(),
      forgettingAt: this.forgettingAt,
      storeSeq: this.store.sequence,
      records: snap.records,
      archived: snap.archived,
      ledger: this.ledger.toJSON(),
      conflicts: this.conflicts.toJSON(),
      dreaming: this.dreaming.toJSON(),
      sleep: this.sleep.toJSON(),
    };
  }

  static fromJSON(data: HMEMSnapshot | string, opts: HMEMOptions & { forgetting?: boolean } = {}): HMEM {
    const snap: HMEMSnapshot = typeof data === "string" ? JSON.parse(data) : data;
    if (snap?.format !== "nightlist-hmem") throw new Error("hmem: not an H-MEM snapshot");
    const h = new HMEM(opts);
    h.ledger.load(snap.ledger);
    h.store.replaceAll({ records: snap.records ?? [], archived: snap.archived ?? [] });
    h.store.sequence = snap.storeSeq ?? 0;
    h.conflicts.load(snap.conflicts);
    h.dreaming.load(snap.dreaming);
    h.sleep.load(snap.sleep);
    h.forgettingAt = snap.forgettingAt ?? snap.savedAt ?? h.clock();
    if (opts.forgetting !== false) h.runForgetting();
    return h;
  }

  // Applies decay to idle non-long-term records once at least a day has passed.
  runForgetting(): number {
    const changed = this.store.applyForgetting(this.forgettingAt);
    if (this.clock() - this.forgettingAt >= 24 * 60 * 60 * 1000) this.forgettingAt = this.clock();
    return changed;
  }

  // Atomic write: temp file then rename.
  saveFile(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.toJSON()));
    fs.renameSync(tmp, file);
  }

  static loadFile(file: string, opts: HMEMOptions & { forgetting?: boolean } = {}): HMEM {
    if (!fs.existsSync(file)) return new HMEM(opts);
    return HMEM.fromJSON(fs.readFileSync(file, "utf-8"), opts);
  }
}
