// World model engine: an append-only event log of entities, contexts,
// relationships and facts. All state is a fold over the log, so every view
// can be thrown away and rebuilt. Record timestamps come from provenance
// (observation time), never from the wall clock, which keeps ingest
// idempotent. The wall clock is only stored as `recordedAt` on each event.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;

// ------------------------------------------------------------------ types

export type ISODate = string;

export interface Provenance {
  kind: string;
  at: ISODate | Date;
  by?: string;
  url?: string;
  checksum?: string;
  runId?: string;
}

export type StoredProvenance = Omit<Provenance, "at"> & { at: ISODate };

export type LifecycleState = "emerging" | "active" | "archived";

export interface Entity {
  id: string;
  type: string;
  name?: string;
  aliases: string[];
  attrs: Record<string, unknown>;
  state: LifecycleState;
  createdAt: ISODate;
  updatedAt: ISODate;
  source: StoredProvenance;
  mergedFrom: string[];
}

export interface Context {
  id: string;
  type: string;
  parent?: string;
  attrs: Record<string, unknown>;
  createdAt: ISODate;
  updatedAt: ISODate;
  source: StoredProvenance;
}

export type Cardinality = "one" | "many";

export interface Relationship {
  id: string;
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  cardinality: Cardinality;
  validFrom: ISODate;
  validTo?: ISODate;
  supersededBy?: string;
  createdAt: ISODate;
  source: StoredProvenance;
}

export interface Fact {
  id: string;
  about: string;
  predicate: string;
  value: unknown;
  confidence: number;
  context?: string;
  assertedAt: ISODate;
  seq: number;
  source: StoredProvenance;
  supersededBy?: string;
}

export interface Alias {
  aliasId: string;
  primaryId: string;
  mergedAt: ISODate;
  mergedBy: string;
  reason: string;
}

export interface MergeProposal {
  id: string;
  leftId: string;
  rightId: string;
  leftName: string;
  rightName: string;
  similarity: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  proposedAt: ISODate;
  resolvedAt?: ISODate;
  resolvedBy?: string;
}

export interface ObservationRecord {
  externalId: string;
  checksum: string;
  entityId: string;
  entityIds: string[];
  at: ISODate;
}

export interface ChangeNotice {
  kind: string;
  subject: string;
  related: string[];
  data: Record<string, unknown>;
}

export type EventKind =
  | "entity"
  | "context"
  | "relate"
  | "close"
  | "fact"
  | "alias"
  | "unalias"
  | "merge-proposed"
  | "merge-resolved"
  | "observation"
  | "tombstone"
  | "change";

export interface WorldEvent<P = any> {
  v: number;
  seq: number;
  id: string;
  kind: EventKind;
  /** observation time, from provenance */
  at: ISODate;
  /** wall-clock time the event was appended */
  recordedAt: ISODate;
  source: StoredProvenance;
  payload: P;
}

export interface AuditEntry {
  seq: number;
  at: ISODate;
  recordedAt: ISODate;
  kind: EventKind;
  actor: string;
  summary: string;
  eventId: string;
  runId?: string;
}

export type ConflictPolicy = "most-recent-wins" | "highest-confidence-wins" | "source-priority";

export interface WorldModelOptions {
  namespace?: string;
  /** "memory" keeps everything in process; "jsonl" appends every event to `path` and replays it on load */
  storage?: "memory" | "jsonl";
  path?: string;
  clock?: () => Date;
  resolver?: { autoMergeAt?: number; reviewAt?: number };
  conflictPolicy?: ConflictPolicy;
  /** source kinds, highest priority first (source-priority policy) */
  sourcePriority?: string[];
}

export interface ExternalKey {
  system: string;
  id: string;
}

export interface UpsertEntityInput {
  type: string;
  externalKey?: ExternalKey;
  name?: string;
  attrs?: Record<string, unknown>;
  state?: LifecycleState;
  source: Provenance | undefined;
}

export interface UpsertContextInput {
  type: string;
  externalKey?: ExternalKey;
  attrs?: Record<string, unknown>;
  parent?: string;
  source: Provenance | undefined;
}

export interface RelateInput {
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  validFrom?: ISODate;
  /** "one" (default): a new target closes the previous open edge of the same type. "many": edges coexist. */
  cardinality?: Cardinality;
  source: Provenance | undefined;
}

export interface AssertFactInput {
  about: string;
  predicate: string;
  value: unknown;
  confidence?: number;
  context?: string;
  source: Provenance | undefined;
}

export interface IngestObservation {
  externalId: string;
  type?: string;
  title: string;
  text?: string;
  at?: ISODate;
  source: Provenance;
  entities?: { type: string; name: string }[];
}

export interface IngestReport {
  runId: string;
  processed: number;
  skipped: number;
  eventsAppended: number;
  changed: boolean;
}

// ------------------------------------------------------------------ stable ids

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Deterministic JSON: sorted keys, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** lowercase, NFKD, strip combining marks and zero-width chars, collapse whitespace, trim */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[​-‍﻿]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function externalId(type: string, system: string, id: string): string {
  return `${type}:${system}:${id}`;
}

export function entityIdFromName(type: string, name: string): string {
  return `ent_${sha256Hex(`${type}:${normalizeName(name)}`).slice(0, 16)}`;
}

export function contextId(type: string, attrs: Record<string, unknown>, parent?: string): string {
  return `ctx_${sha256Hex(`${type}|${canonicalJson(attrs)}|${parent ?? ""}`).slice(0, 16)}`;
}

export function relationshipId(from: string, type: string, to: string, context?: string, validFrom?: string): string {
  return `rel_${sha256Hex(`${from}|${type}|${to}|${context ?? ""}|${validFrom ?? ""}`).slice(0, 16)}`;
}

export function factId(about: string, predicate: string, value: unknown, assertedAt: string, sourceKind: string, sourceUrl?: string): string {
  return `fact_${sha256Hex(`${about}|${predicate}|${canonicalJson(value)}|${assertedAt}|${sourceKind}|${sourceUrl ?? ""}`).slice(0, 16)}`;
}

// ------------------------------------------------------------------ resolution

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 1 - levenshtein / maxLen over normalized names */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  const max = Math.max(x.length, y.length);
  return max === 0 ? 1 : 1 - levenshtein(x, y) / max;
}

export type MergeDecision = "auto-merge" | "review" | "new";

/** Bands: >= autoMergeAt merges, [reviewAt, autoMergeAt) queues, below is a new entity. */
export function decide(similarity: number, autoMergeAt = 0.85, reviewAt = 0.82): MergeDecision {
  if (similarity >= autoMergeAt) return "auto-merge";
  if (similarity >= reviewAt) return "review";
  return "new";
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ------------------------------------------------------------------ projection

export interface WorldState {
  entities: Map<string, Entity>;
  contexts: Map<string, Context>;
  relationships: Map<string, Relationship>;
  facts: Map<string, Fact>;
  factIndex: Map<string, string[]>;
  aliases: Map<string, Alias>;
  proposals: Map<string, MergeProposal>;
  observations: Map<string, ObservationRecord>;
}

function emptyState(): WorldState {
  return {
    entities: new Map(),
    contexts: new Map(),
    relationships: new Map(),
    facts: new Map(),
    factIndex: new Map(),
    aliases: new Map(),
    proposals: new Map(),
    observations: new Map(),
  };
}

const factKey = (about: string, predicate: string) => `${about}\u0000${predicate}`;
const clone = <T>(v: T): T => structuredClone(v);

class Projector {
  state = emptyState();

  constructor(private policy: ConflictPolicy, private priority: string[]) {}

  resolve(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    while (this.state.aliases.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.state.aliases.get(cur)!.primaryId;
    }
    return cur;
  }

  /** Fold a full log. An unalias cancels the most recent alias for that id. */
  foldAll(events: readonly WorldEvent[]): void {
    const lastAlias = new Map<string, number>();
    const cancelled = new Set<number>();
    for (const e of events) {
      if (e.kind === "alias") lastAlias.set(e.payload.aliasId, e.seq);
      if (e.kind === "unalias" && lastAlias.has(e.payload.aliasId)) {
        cancelled.add(lastAlias.get(e.payload.aliasId)!);
        lastAlias.delete(e.payload.aliasId);
      }
    }
    for (const e of events) if (!(e.kind === "alias" && cancelled.has(e.seq))) this.apply(e);
  }

  apply(e: WorldEvent): void {
    const s = this.state;
    switch (e.kind) {
      case "entity": {
        const p = e.payload as { id: string; type: string; name?: string; attrs: Record<string, unknown>; state?: LifecycleState };
        const id = this.resolve(p.id);
        const existing = s.entities.get(id);
        if (existing) {
          existing.attrs = { ...existing.attrs, ...clone(p.attrs) };
          if (p.name) {
            existing.name = p.name;
            if (!existing.aliases.includes(p.name)) existing.aliases.push(p.name);
          }
          if (p.state) existing.state = p.state;
          existing.updatedAt = e.at;
          existing.source = e.source;
        } else {
          s.entities.set(id, {
            id,
            type: p.type,
            name: p.name,
            aliases: p.name ? [p.name] : [],
            attrs: clone(p.attrs ?? {}),
            state: p.state ?? "active",
            createdAt: e.at,
            updatedAt: e.at,
            source: e.source,
            mergedFrom: [],
          });
        }
        break;
      }
      case "context": {
        const p = e.payload as { id: string; type: string; parent?: string; attrs: Record<string, unknown> };
        const existing = s.contexts.get(p.id);
        if (existing) {
          existing.attrs = { ...existing.attrs, ...clone(p.attrs) };
          existing.updatedAt = e.at;
          existing.source = e.source;
        } else {
          s.contexts.set(p.id, { id: p.id, type: p.type, parent: p.parent, attrs: clone(p.attrs ?? {}), createdAt: e.at, updatedAt: e.at, source: e.source });
        }
        break;
      }
      case "relate": {
        const r = clone(e.payload as Relationship);
        if (s.relationships.has(r.id)) break;
        r.from = this.resolve(r.from);
        r.to = this.resolve(r.to);
        if (r.cardinality === "one") {
          for (const other of s.relationships.values()) {
            if (other.validTo || other.from !== r.from || other.type !== r.type || (other.context ?? "") !== (r.context ?? "") || other.to === r.to) continue;
            if (r.validFrom >= other.validFrom) {
              other.validTo = r.validFrom;
              other.supersededBy = r.id;
            } else if (!r.validTo) {
              // a late-arriving older edge is historical: it ends where the newer one starts
              r.validTo = other.validFrom;
              r.supersededBy = other.id;
            }
          }
        }
        s.relationships.set(r.id, r);
        break;
      }
      case "close": {
        const rel = s.relationships.get(e.payload.relId);
        if (rel && !rel.validTo) rel.validTo = e.payload.validTo;
        break;
      }
      case "fact": {
        const f = clone(e.payload as Fact);
        if (s.facts.has(f.id)) break;
        f.about = this.resolve(f.about);
        f.seq = e.seq;
        s.facts.set(f.id, f);
        const key = factKey(f.about, f.predicate);
        s.factIndex.set(key, [...(s.factIndex.get(key) ?? []), f.id]);
        this.settle(f.about, f.predicate, e);
        break;
      }
      case "alias": {
        const a = e.payload as Alias;
        const primaryId = this.resolve(a.primaryId);
        if (primaryId === a.aliasId) break;
        s.aliases.set(a.aliasId, { ...a, primaryId });
        this.absorb(a.aliasId, primaryId, e);
        break;
      }
      case "merge-proposed": {
        const p = e.payload as MergeProposal;
        if (!s.proposals.has(p.id)) s.proposals.set(p.id, clone(p));
        break;
      }
      case "merge-resolved": {
        const p = s.proposals.get(e.payload.id);
        if (p) {
          p.status = e.payload.status;
          p.resolvedAt = e.at;
          p.resolvedBy = e.payload.by;
        }
        break;
      }
      case "observation": {
        const o = e.payload as ObservationRecord;
        s.observations.set(o.externalId, clone(o));
        break;
      }
      case "tombstone": {
        const ent = s.entities.get(this.resolve(e.payload.targetId));
        if (ent) {
          ent.state = "archived";
          ent.updatedAt = e.at;
        }
        break;
      }
      case "unalias":
      case "change":
        break;
    }
  }

  private absorb(aliasId: string, primaryId: string, e: WorldEvent): void {
    const s = this.state;
    const alias = s.entities.get(aliasId);
    if (alias) {
      const primary = s.entities.get(primaryId);
      if (primary) {
        for (const n of alias.aliases) if (!primary.aliases.includes(n)) primary.aliases.push(n);
        for (const [k, v] of Object.entries(alias.attrs)) if (!(k in primary.attrs)) primary.attrs[k] = v;
        if (alias.createdAt < primary.createdAt) primary.createdAt = alias.createdAt;
        primary.mergedFrom.push(aliasId, ...alias.mergedFrom);
      } else {
        s.entities.set(primaryId, { ...alias, id: primaryId, mergedFrom: [aliasId, ...alias.mergedFrom] });
      }
      s.entities.delete(aliasId);
    }
    for (const rel of s.relationships.values()) {
      if (rel.from === aliasId) rel.from = primaryId;
      if (rel.to === aliasId) rel.to = primaryId;
    }
    const touched = new Set<string>();
    for (const f of s.facts.values()) {
      if (f.about !== aliasId) continue;
      const oldKey = factKey(aliasId, f.predicate);
      s.factIndex.set(oldKey, (s.factIndex.get(oldKey) ?? []).filter((id) => id !== f.id));
      if (!s.factIndex.get(oldKey)!.length) s.factIndex.delete(oldKey);
      f.about = primaryId;
      const key = factKey(primaryId, f.predicate);
      s.factIndex.set(key, [...(s.factIndex.get(key) ?? []), f.id]);
      touched.add(f.predicate);
    }
    for (const p of touched) this.settle(primaryId, p, e);
  }

  /** Pick the winning fact for (about, predicate) and materialize it into entity attrs. */
  private settle(about: string, predicate: string, e: WorldEvent): void {
    const s = this.state;
    const facts = (s.factIndex.get(factKey(about, predicate)) ?? []).map((id) => s.facts.get(id)!);
    if (!facts.length) return;
    let winner = facts[0];
    for (const f of facts.slice(1)) if (this.beats(f, winner)) winner = f;
    for (const f of facts) f.supersededBy = f.id === winner.id ? undefined : winner.id;
    let ent = s.entities.get(about);
    if (!ent) {
      ent = {
        id: about,
        type: about.includes(":") ? about.split(":")[0] : "entity",
        aliases: [],
        attrs: {},
        state: "emerging",
        createdAt: e.at,
        updatedAt: e.at,
        source: e.source,
        mergedFrom: [],
      };
      s.entities.set(about, ent);
    }
    ent.attrs[predicate] = clone(winner.value);
    if (e.at > ent.updatedAt) ent.updatedAt = e.at;
  }

  private beats(a: Fact, b: Fact): boolean {
    if (this.policy === "highest-confidence-wins" && a.confidence !== b.confidence) return a.confidence > b.confidence;
    if (this.policy === "source-priority") {
      const rank = (k: string) => {
        const i = this.priority.indexOf(k);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      if (rank(a.source.kind) !== rank(b.source.kind)) return rank(a.source.kind) < rank(b.source.kind);
    }
    if (a.assertedAt !== b.assertedAt) return a.assertedAt > b.assertedAt;
    return a.seq > b.seq;
  }
}

// ------------------------------------------------------------------ helpers

function toIso(value: ISODate | Date | undefined, what: string): string {
  if (value === undefined || value === null || value === "") throw new Error(`world-model: ${what} is required`);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`world-model: ${what} is not a valid date: ${String(value)}`);
  return d.toISOString();
}

function normalizeProvenance(source: Provenance | undefined): StoredProvenance {
  if (!source || typeof source !== "object" || !source.kind) {
    throw new Error("world-model: every write needs provenance ({ kind, at }). No provenance, no write.");
  }
  const out: StoredProvenance = { kind: String(source.kind), at: toIso(source.at, "source.at") };
  if (source.by) out.by = source.by;
  if (source.url) out.url = source.url;
  if (source.checksum) out.checksum = source.checksum;
  if (source.runId) out.runId = source.runId;
  return out;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`world-model: ${what} is required`);
  return value;
}

function validAt(rel: Relationship, at: string): boolean {
  return rel.validFrom <= at && (!rel.validTo || at < rel.validTo);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Ids an event refers to, used for per-entity timelines. */
export function eventSubjects(e: WorldEvent): string[] {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "entity":
    case "context":
      return [p.id];
    case "relate":
    case "close":
      return [p.from, p.to];
    case "fact":
      return [p.about];
    case "alias":
    case "unalias":
      return [p.aliasId, p.primaryId];
    case "merge-proposed":
      return [p.leftId, p.rightId];
    case "observation":
      return [p.entityId, ...(p.entityIds ?? [])];
    case "tombstone":
      return [p.targetId];
    case "change":
      return [p.subject, ...(p.related ?? [])];
    default:
      return [];
  }
}

function summarize(e: WorldEvent): string {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "entity":
      return `${p.id} (${p.type})${p.name ? ` "${p.name}"` : ""}`;
    case "context":
      return `${p.id} (${p.type})`;
    case "relate":
      return `${p.from} -[${p.type}]-> ${p.to}`;
    case "close":
      return `closed ${p.from} -[${p.type}]-> ${p.to}`;
    case "fact":
      return `${p.about}.${p.predicate} = ${JSON.stringify(p.value)}`;
    case "alias":
      return `${p.aliasId} merged into ${p.primaryId}`;
    case "unalias":
      return `${p.aliasId} split from ${p.primaryId}`;
    case "merge-proposed":
      return `${p.leftName} ~ ${p.rightName} (${Number(p.similarity).toFixed(3)}) queued`;
    case "merge-resolved":
      return `${p.id} ${p.status}`;
    case "observation":
      return `observation ${p.externalId}`;
    case "tombstone":
      return `${p.targetId} archived`;
    case "change":
      return `${p.kind} ${p.subject}`;
    default:
      return e.kind;
  }
}

// ------------------------------------------------------------------ world model

interface CustomView<S> {
  events: EventKind[] | string[];
  initialState: S;
  reducer: (state: S, event: WorldEvent) => S;
}

export class WorldModel {
  readonly namespace: string;
  private readonly opts: WorldModelOptions;
  private readonly clock: () => Date;
  private readonly file?: string;
  private log: WorldEvent[] = [];
  private projector: Projector;
  private subscribers = new Set<(e: WorldEvent) => void>();
  private customViews = new Map<string, CustomView<unknown>>();
  /** non-fatal issues found while loading the log (for example a torn last line) */
  readonly loadWarnings: string[] = [];

  constructor(opts: WorldModelOptions = {}) {
    this.opts = opts;
    this.namespace = opts.namespace ?? "default";
    this.clock = opts.clock ?? (() => new Date());
    this.projector = this.newProjector();
    if ((opts.storage ?? (opts.path ? "jsonl" : "memory")) === "jsonl") {
      if (!opts.path) throw new Error("world-model: storage \"jsonl\" needs a path");
      this.file = path.resolve(opts.path);
      this.load();
    }
  }

  private newProjector(): Projector {
    return new Projector(this.opts.conflictPolicy ?? "most-recent-wins", this.opts.sourcePriority ?? []);
  }

  private get state(): WorldState {
    return this.projector.state;
  }

  // ---------------------------------------------------------- persistence

  private load(): void {
    const file = this.file!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineStart = offset;
      offset += Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) continue;
      let event: WorldEvent;
      try {
        event = JSON.parse(line);
      } catch {
        const isLast = lines.slice(i + 1).every((l) => !l.trim());
        if (!isLast) throw new Error(`world-model: corrupt event log ${file} at line ${i + 1}`);
        // torn final write: drop it so the next append starts on a clean line
        fs.truncateSync(file, lineStart);
        this.loadWarnings.push(`dropped torn last line ${i + 1}`);
        break;
      }
      const prev = this.log[this.log.length - 1];
      if (prev && event.seq <= prev.seq) throw new Error(`world-model: non-increasing seq ${event.seq} in ${file} at line ${i + 1}`);
      this.log.push(event);
    }
    this.projector.foldAll(this.log);
    const text = fs.readFileSync(file, "utf8");
    if (text.length && !text.endsWith("\n")) fs.appendFileSync(file, "\n");
  }

  private append<P>(kind: EventKind, source: StoredProvenance, payload: P): WorldEvent<P> {
    const seq = (this.log[this.log.length - 1]?.seq ?? 0) + 1;
    const event: WorldEvent<P> = {
      v: SCHEMA_VERSION,
      seq,
      id: `evt_${seq}`,
      kind,
      at: source.at,
      recordedAt: this.clock().toISOString(),
      source,
      payload: clone(payload),
    };
    if (this.file) {
      const line = JSON.stringify(event) + "\n";
      if (this.pending) this.pending.push(line);
      else fs.appendFileSync(this.file, line);
    }
    this.log.push(event);
    if (kind === "unalias") this.rebuild();
    else this.projector.apply(event);
    for (const fn of this.subscribers) fn(event);
    return event;
  }

  // ---------------------------------------------------------- writes

  private pending: string[] | null = null;

  /** Runs fn with log appends buffered, then writes them in one append. Events are
   * still applied in order as they happen; only the file write is deferred. */
  batch<T>(fn: () => T): T {
    if (this.pending) return fn();
    this.pending = [];
    try {
      return fn();
    } finally {
      const lines = this.pending;
      this.pending = null;
      if (this.file && lines.length) fs.appendFileSync(this.file, lines.join(""));
    }
  }

  resolveId(id: string): string {
    return this.projector.resolve(id);
  }

  upsertEntity(input: UpsertEntityInput): Entity {
    const source = normalizeProvenance(input?.source);
    requireText(input.type, "entity type");
    const name = input.name ?? (typeof input.attrs?.name === "string" ? (input.attrs.name as string) : undefined);
    const requested = input.externalKey
      ? externalId(input.type, requireText(input.externalKey.system, "externalKey.system"), requireText(input.externalKey.id, "externalKey.id"))
      : entityIdFromName(input.type, requireText(name, "entity name (or externalKey)"));
    let id = this.resolveId(requested);

    if (!input.externalKey && !this.state.entities.has(id) && id === requested) {
      id = this.resolveNewName(id, input.type, name!, source);
    }

    const existing = this.state.entities.get(id);
    if (existing && this.isNoop(existing, input, name)) return existing;
    this.append("entity", source, { id, type: existing?.type ?? input.type, name, attrs: input.attrs ?? {}, state: input.state });
    return this.state.entities.get(id)!;
  }

  private isNoop(existing: Entity, input: UpsertEntityInput, name?: string): boolean {
    if (name && (existing.name !== name || !existing.aliases.includes(name))) return false;
    if (input.state && input.state !== existing.state) return false;
    for (const [k, v] of Object.entries(input.attrs ?? {})) {
      if (canonicalJson(existing.attrs[k]) !== canonicalJson(v)) return false;
    }
    return true;
  }

  /** Probabilistic resolution for a brand-new name-keyed id. Returns the id to write to. */
  private resolveNewName(id: string, type: string, name: string, source: StoredProvenance): string {
    const autoAt = this.opts.resolver?.autoMergeAt ?? 0.85;
    const reviewAt = this.opts.resolver?.reviewAt ?? 0.82;
    let best: { entity: Entity; similarity: number } | undefined;
    const candidates = [...this.state.entities.values()].filter((e) => e.type === type && e.name && e.id !== id).sort(byId);
    for (const other of candidates) {
      const similarity = nameSimilarity(name, other.name!);
      if (!best || similarity > best.similarity) best = { entity: other, similarity };
    }
    if (!best) return id;
    const decision = decide(best.similarity, autoAt, reviewAt);
    if (decision === "auto-merge") {
      this.append("alias", source, {
        aliasId: id,
        primaryId: best.entity.id,
        mergedAt: source.at,
        mergedBy: "resolver",
        reason: `name similarity ${best.similarity.toFixed(3)}`,
      } satisfies Alias);
      return best.entity.id;
    }
    if (decision === "review") {
      const proposalId = `merge_${sha256Hex([id, best.entity.id].sort().join("|")).slice(0, 12)}`;
      if (!this.state.proposals.has(proposalId)) {
        this.append("merge-proposed", source, {
          id: proposalId,
          leftId: id,
          rightId: best.entity.id,
          leftName: name,
          rightName: best.entity.name!,
          similarity: best.similarity,
          reason: `name similarity in review band [${reviewAt}, ${autoAt})`,
          status: "pending",
          proposedAt: source.at,
        } satisfies MergeProposal);
      }
    }
    return id;
  }

  upsertContext(input: UpsertContextInput): Context {
    const source = normalizeProvenance(input?.source);
    requireText(input.type, "context type");
    const id = input.externalKey
      ? externalId(input.type, input.externalKey.system, input.externalKey.id)
      : contextId(input.type, input.attrs ?? {}, input.parent);
    const existing = this.state.contexts.get(id);
    if (existing && Object.entries(input.attrs ?? {}).every(([k, v]) => canonicalJson(existing.attrs[k]) === canonicalJson(v))) return existing;
    this.append("context", source, { id, type: input.type, parent: input.parent, attrs: input.attrs ?? {} });
    return this.state.contexts.get(id)!;
  }

  relate(input: RelateInput): Relationship {
    const source = normalizeProvenance(input?.source);
    requireText(input.type, "relationship type");
    const from = this.resolveId(requireText(input.from, "relationship from"));
    const to = this.resolveId(requireText(input.to, "relationship to"));
    const validFrom = input.validFrom ? toIso(input.validFrom, "validFrom") : source.at;
    const id = relationshipId(from, input.type, to, input.context, validFrom);
    const same = this.state.relationships.get(id);
    if (same) return same;
    const open = this.openEdge(from, input.type, to, input.context);
    if (open && open.validFrom <= validFrom) return open;
    const rel: Relationship = {
      id,
      from,
      type: input.type,
      to,
      context: input.context,
      attrs: input.attrs,
      cardinality: input.cardinality ?? "one",
      validFrom,
      createdAt: source.at,
      source,
    };
    this.append("relate", source, rel);
    return this.state.relationships.get(id)!;
  }

  /** Close the open edge from -[type]-> to. Returns the closed edge, or undefined if none was open. */
  unrelate(input: { from: string; type: string; to: string; context?: string; validTo?: ISODate; source: Provenance | undefined }): Relationship | undefined {
    const source = normalizeProvenance(input?.source);
    const from = this.resolveId(input.from);
    const to = this.resolveId(input.to);
    const open = this.openEdge(from, input.type, to, input.context);
    if (!open) return undefined;
    const validTo = input.validTo ? toIso(input.validTo, "validTo") : source.at;
    this.append("close", source, { relId: open.id, from, type: input.type, to, validTo });
    return this.state.relationships.get(open.id);
  }

  private openEdge(from: string, type: string, to: string, context?: string): Relationship | undefined {
    for (const r of this.state.relationships.values()) {
      if (!r.validTo && r.from === from && r.to === to && r.type === type && (r.context ?? "") === (context ?? "")) return r;
    }
    return undefined;
  }

  assertFact(input: AssertFactInput): Fact {
    const source = normalizeProvenance(input?.source);
    requireText(input.predicate, "fact predicate");
    const about = this.resolveId(requireText(input.about, "fact subject"));
    const id = factId(about, input.predicate, input.value, source.at, source.kind, source.url);
    const existing = this.state.facts.get(id);
    if (existing) return existing;
    const fact: Fact = {
      id,
      about,
      predicate: input.predicate,
      value: input.value,
      confidence: input.confidence ?? 0.5,
      context: input.context,
      assertedAt: source.at,
      seq: 0,
      source,
    };
    this.append("fact", source, fact);
    return this.state.facts.get(id)!;
  }

  tombstone(targetId: string, opts: { reason?: string; source: Provenance | undefined }): void {
    const source = normalizeProvenance(opts?.source);
    this.append("tombstone", source, { targetId: this.resolveId(targetId), reason: opts.reason });
  }

  /** Domain-level change notice. Stored in the log like any other event. */
  recordChange(input: ChangeNotice & { source: Provenance | undefined }): WorldEvent<ChangeNotice> {
    const source = normalizeProvenance(input?.source);
    requireText(input.kind, "change kind");
    return this.append("change", source, { kind: input.kind, subject: input.subject, related: input.related ?? [], data: input.data ?? {} });
  }

  // ---------------------------------------------------------- merges

  merge(aliasId: string, primaryId: string, opts: { by: string; reason?: string; at?: ISODate }): void {
    const alias = this.resolveId(aliasId);
    const primary = this.resolveId(primaryId);
    if (alias === primary) throw new Error(`world-model: ${aliasId} and ${primaryId} are already the same entity`);
    const at = opts.at ? toIso(opts.at, "at") : this.clock().toISOString();
    this.append("alias", { kind: "manual", by: opts.by, at }, {
      aliasId: alias,
      primaryId: primary,
      mergedAt: at,
      mergedBy: opts.by,
      reason: opts.reason ?? "operator merge",
    } satisfies Alias);
  }

  /** One-step rollback of a merge. Writes made to the primary after the merge stay on the primary. */
  unmerge(aliasId: string, opts: { by: string; at?: ISODate }): void {
    const a = this.state.aliases.get(aliasId);
    if (!a) throw new Error(`world-model: ${aliasId} is not merged into anything`);
    const at = opts.at ? toIso(opts.at, "at") : this.clock().toISOString();
    this.append("unalias", { kind: "manual", by: opts.by, at }, { aliasId, primaryId: a.primaryId });
  }

  mergeQueue(): MergeProposal[] {
    return [...this.state.proposals.values()].filter((p) => p.status === "pending").map(clone);
  }

  approveMerge(proposalId: string, by: string): void {
    const p = this.state.proposals.get(proposalId);
    if (!p || p.status !== "pending") throw new Error(`world-model: no pending merge proposal ${proposalId}`);
    const at = this.clock().toISOString();
    this.append("merge-resolved", { kind: "manual", by, at }, { id: proposalId, status: "approved", by });
    this.merge(p.leftId, p.rightId, { by, reason: p.reason, at });
  }

  rejectMerge(proposalId: string, by: string): void {
    const p = this.state.proposals.get(proposalId);
    if (!p || p.status !== "pending") throw new Error(`world-model: no pending merge proposal ${proposalId}`);
    this.append("merge-resolved", { kind: "manual", by, at: this.clock().toISOString() }, { id: proposalId, status: "rejected", by });
  }

  // ---------------------------------------------------------- ingest

  /** Idempotent batch ingest. Unchanged observations (same checksum) are skipped and append nothing. */
  ingest(observations: IngestObservation[], opts: { runId?: string } = {}): IngestReport {
    const prepared = observations.map((obs) => {
      requireText(obs?.externalId, "observation externalId");
      const source = normalizeProvenance({ ...obs.source, at: obs.at ?? obs.source?.at });
      const checksum = sha256Hex(
        canonicalJson({ externalId: obs.externalId, type: obs.type ?? "item", title: obs.title, text: obs.text, at: source.at, entities: obs.entities ?? [], source: { kind: source.kind, url: source.url } }),
      );
      return { obs, source, checksum };
    });
    const runId = opts.runId ?? `ing_${sha256Hex(canonicalJson(prepared.map((p) => p.checksum))).slice(0, 12)}`;
    const before = this.stateShapeCanonical();
    const seqBefore = this.lastSeq();
    let processed = 0;
    let skipped = 0;

    for (const { obs, source: base, checksum } of prepared) {
      if (this.state.observations.get(obs.externalId)?.checksum === checksum) {
        skipped++;
        continue;
      }
      const source = { ...base, runId: base.runId ?? runId };
      const type = obs.type ?? "item";
      const item = this.upsertEntity({
        type,
        externalKey: { system: "ingest", id: obs.externalId },
        name: obs.title,
        attrs: { title: obs.title, ...(obs.text !== undefined ? { text: obs.text } : {}) },
        source,
      });
      const mentioned: string[] = [];
      for (const m of obs.entities ?? []) {
        const ent = this.upsertEntity({ type: m.type, name: m.name, source });
        mentioned.push(ent.id);
        this.relate({ from: item.id, type: "mentions", to: ent.id, cardinality: "many", source });
      }
      this.append("observation", source, { externalId: obs.externalId, checksum, entityId: item.id, entityIds: [...new Set(mentioned)].sort(), at: source.at } satisfies ObservationRecord);
      processed++;
    }

    return { runId, processed, skipped, eventsAppended: this.lastSeq() - seqBefore, changed: this.stateShapeCanonical() !== before };
  }

  // ---------------------------------------------------------- reads

  entity(id: string): Entity | undefined {
    const e = this.state.entities.get(this.resolveId(id));
    return e ? clone(e) : undefined;
  }

  context(id: string): Context | undefined {
    const c = this.state.contexts.get(id);
    return c ? clone(c) : undefined;
  }

  fact(id: string): Fact | undefined {
    const f = this.state.facts.get(id);
    return f ? clone(f) : undefined;
  }

  relationship(id: string): Relationship | undefined {
    const r = this.state.relationships.get(id);
    return r ? clone(r) : undefined;
  }

  events(opts: { afterSeq?: number; kinds?: EventKind[] } = {}): WorldEvent[] {
    return this.log.filter((e) => (opts.afterSeq === undefined || e.seq > opts.afterSeq) && (!opts.kinds || opts.kinds.includes(e.kind)));
  }

  event(id: string): WorldEvent | undefined {
    const seq = Number(id.replace(/^evt_/, ""));
    const e = this.log[seq - 1];
    return e && e.id === id ? e : this.log.find((x) => x.id === id);
  }

  lastSeq(): number {
    return this.log[this.log.length - 1]?.seq ?? 0;
  }

  /** Every event touching an entity (alias ids included), in log order. */
  history(entityId: string): WorldEvent[] {
    const target = this.resolveId(entityId);
    const ids = new Set<string>([entityId, target]);
    for (const [aliasId, a] of this.state.aliases) if (this.resolveId(a.primaryId) === target) ids.add(aliasId);
    return this.log.filter((e) => eventSubjects(e).some((s) => ids.has(s)));
  }

  /** One audit entry per event, in append order. */
  audit(): AuditEntry[] {
    return this.log.map((e) => ({
      seq: e.seq,
      at: e.at,
      recordedAt: e.recordedAt,
      kind: e.kind,
      actor: e.source.by ?? e.source.kind,
      summary: summarize(e),
      eventId: e.id,
      runId: e.source.runId,
    }));
  }

  view(name: "graph"): GraphView;
  view(name: "facts"): FactsView;
  view(name: "timeline"): TimelineView;
  view(name: "snapshot"): SnapshotView;
  view(name: string): { get(): unknown };
  view(name: string): unknown {
    if (name === "graph") return new GraphView(this.state, (id) => this.resolveId(id));
    if (name === "facts") return new FactsView(this.state, (id) => this.resolveId(id));
    if (name === "timeline") return new TimelineView(this);
    if (name === "snapshot") return new SnapshotView(this.log, () => this.newProjector());
    const custom = this.customViews.get(name);
    if (!custom) throw new Error(`world-model: unknown view "${name}"`);
    return {
      get: () => {
        let state = clone(custom.initialState);
        for (const e of this.log) if ((custom.events as string[]).includes(e.kind)) state = custom.reducer(state, e);
        return state;
      },
    };
  }

  registerView<S>(name: string, spec: CustomView<S>): void {
    this.customViews.set(name, spec as CustomView<unknown>);
  }

  subscribe(fn: (e: WorldEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Throw away all derived state and refold it from the log. */
  rebuild(): { events: number; ms: number } {
    const t0 = performance.now();
    const projector = this.newProjector();
    projector.foldAll(this.log);
    this.projector = projector;
    return { events: this.log.length, ms: performance.now() - t0 };
  }

  /** True when a fresh fold of the log matches the live state. */
  verify(): boolean {
    const projector = this.newProjector();
    projector.foldAll(this.log);
    return canonicalJson(shapeOf(projector.state)) === this.stateShapeCanonical();
  }

  stateShape(): unknown {
    return shapeOf(this.state);
  }

  stateShapeCanonical(): string {
    return canonicalJson(shapeOf(this.state));
  }

  stats(): Record<string, number> {
    const s = this.state;
    return {
      events: this.log.length,
      entities: s.entities.size,
      contexts: s.contexts.size,
      relationships: s.relationships.size,
      facts: s.facts.size,
      aliases: s.aliases.size,
      pendingMerges: this.mergeQueue().length,
    };
  }
}

function shapeOf(s: WorldState): unknown {
  return {
    schemaVersion: SCHEMA_VERSION,
    entities: [...s.entities.values()].sort(byId),
    contexts: [...s.contexts.values()].sort(byId),
    relationships: [...s.relationships.values()].sort(byId),
    facts: [...s.facts.values()].map(({ seq: _seq, ...f }) => f).sort(byId),
    aliases: [...s.aliases.values()].map((a) => ({ aliasId: a.aliasId, primaryId: a.primaryId })).sort((a, b) => (a.aliasId < b.aliasId ? -1 : 1)),
    observations: [...s.observations.values()].sort((a, b) => (a.externalId < b.externalId ? -1 : 1)),
  };
}

// ------------------------------------------------------------------ views

export class GraphView {
  constructor(private s: WorldState, private resolve: (id: string) => string) {}

  entity(id: string): Entity | undefined {
    return this.s.entities.get(this.resolve(id));
  }

  /** Edges touching an entity. Without `at`, only open edges; with `at`, edges valid at that time. */
  edges(id: string, opts: { via?: string; inContext?: string; at?: string; direction?: "out" | "in" | "both"; includeClosed?: boolean } = {}): Relationship[] {
    const rid = this.resolve(id);
    const dir = opts.direction ?? "both";
    const at = opts.at ? toIso(opts.at, "at") : undefined;
    const out: Relationship[] = [];
    for (const rel of this.s.relationships.values()) {
      if (opts.via && rel.type !== opts.via) continue;
      if (opts.inContext && rel.context !== opts.inContext) continue;
      if (at ? !validAt(rel, at) : rel.validTo && !opts.includeClosed) continue;
      const isOut = rel.from === rid && dir !== "in";
      const isIn = rel.to === rid && dir !== "out";
      if (isOut || isIn) out.push(rel);
    }
    return out.sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : byId(a, b)));
  }

  neighborsOf(id: string, opts: { via?: string; inContext?: string; at?: string; direction?: "out" | "in" | "both" } = {}): Entity[] {
    const rid = this.resolve(id);
    const seen = new Map<string, Entity>();
    for (const rel of this.edges(id, opts)) {
      const other = rel.from === rid ? rel.to : rel.from;
      const ent = this.s.entities.get(this.resolve(other));
      if (ent) seen.set(ent.id, ent);
    }
    return [...seen.values()].sort(byId);
  }

  traverse(startId: string, opts: { via: string; direction: "ancestors" | "descendants"; maxDepth?: number }): Entity[] {
    const out: Entity[] = [];
    const visited = new Set<string>([this.resolve(startId)]);
    let frontier = [...visited];
    for (let depth = 0; depth < (opts.maxDepth ?? 5) && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const rel of this.edges(id, { via: opts.via, direction: opts.direction === "ancestors" ? "out" : "in" })) {
          const target = opts.direction === "ancestors" ? rel.to : rel.from;
          if (visited.has(target)) continue;
          visited.add(target);
          const ent = this.s.entities.get(target);
          if (ent) out.push(ent);
          next.push(target);
        }
      }
      frontier = next;
    }
    return out;
  }

  query(opts: { type?: string; where?: (e: Entity) => boolean } = {}): Entity[] {
    return [...this.s.entities.values()].filter((e) => (!opts.type || e.type === opts.type) && (!opts.where || opts.where(e))).sort(byId);
  }

  entitiesInContext(contextId: string, opts: { type?: string } = {}): Entity[] {
    const seen = new Map<string, Entity>();
    for (const rel of this.s.relationships.values()) {
      if (rel.context !== contextId) continue;
      for (const id of [rel.from, rel.to]) {
        const ent = this.s.entities.get(id);
        if (ent && (!opts.type || ent.type === opts.type)) seen.set(ent.id, ent);
      }
    }
    return [...seen.values()].sort(byId);
  }
}

export class FactsView {
  constructor(private s: WorldState, private resolve: (id: string) => string) {}

  about(id: string, opts: { predicate?: string; includeSuperseded?: boolean } = {}): Fact[] {
    const rid = this.resolve(id);
    return [...this.s.facts.values()]
      .filter((f) => f.about === rid && (!opts.predicate || f.predicate === opts.predicate) && (opts.includeSuperseded !== false || !f.supersededBy))
      .sort((a, b) => (a.assertedAt < b.assertedAt ? -1 : a.assertedAt > b.assertedAt ? 1 : a.seq - b.seq));
  }

  /** Winning fact per predicate. */
  current(id: string): Record<string, Fact> {
    const out: Record<string, Fact> = {};
    for (const f of this.about(id, { includeSuperseded: false })) out[f.predicate] = f;
    return out;
  }

  get(factId: string): Fact | undefined {
    return this.s.facts.get(factId);
  }
}

export class TimelineView {
  constructor(private world: WorldModel) {}

  entitiesOfType(type: string, opts: { from?: string; to?: string } = {}): Entity[] {
    const from = opts.from ? toIso(opts.from, "from") : undefined;
    const to = opts.to ? toIso(opts.to.length === 10 ? `${opts.to}T23:59:59.999Z` : opts.to, "to") : undefined;
    return this.world
      .view("graph")
      .query({ type })
      .filter((e) => (!from || e.createdAt >= from) && (!to || e.createdAt <= to))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : byId(a, b)));
  }

  events(opts: { from?: string; to?: string; kinds?: EventKind[] } = {}): WorldEvent[] {
    return this.world.events({ kinds: opts.kinds }).filter((e) => (!opts.from || e.at >= opts.from) && (!opts.to || e.at <= opts.to));
  }

  forEntity(id: string): WorldEvent[] {
    return this.world.history(id);
  }

  subscribe(fn: (e: WorldEvent) => void): () => void {
    return this.world.subscribe(fn);
  }
}

export class SnapshotView {
  constructor(private log: readonly WorldEvent[], private make: () => Projector) {}

  /** World state folded from events observed at or before `at`. */
  stateAt(at: string): WorldState {
    const iso = toIso(at.length === 10 ? `${at}T23:59:59.999Z` : at, "at");
    const p = this.make();
    p.foldAll(this.log.filter((e) => e.at <= iso));
    return p.state;
  }

  entityAt(id: string, at: string): Entity | undefined {
    const iso = at.length === 10 ? `${at}T23:59:59.999Z` : at;
    const p = this.make();
    p.foldAll(this.log.filter((e) => e.at <= toIso(iso, "at")));
    return p.state.entities.get(p.resolve(id));
  }
}

export { ClinicWorld, clinicIds } from "./clinic.ts";
export type * from "./clinic.ts";
