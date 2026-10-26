// Tiered memory store with enrichment. Every mutation writes a ledger entry.

import type { AddInput, LedgerAction, MemoryRecord, MemoryOrigin } from "./types.ts";
import { DEFAULTS, DAY_MS, clamp01, tidy } from "./types.ts";
import { TrustLedgerService, snapshot } from "./ledger.ts";
import { classifyDomain, cosine, embed, extractEntities, hasCorrectionLanguage } from "./text.ts";

const VALID_TYPES = new Set(["personal", "factual", "preference", "general"]);
const VALID_LAYERS = new Set(["short_term", "working", "long_term"]);

export interface UpdateOptions {
  actor?: string;
  action?: LedgerAction;
  details?: Record<string, unknown>;
}

export class MemoryStoreService {
  private records = new Map<string, MemoryRecord>();
  // Archived records are removed from the active set but kept for audit and restore.
  private archived = new Map<string, MemoryRecord & { archivedAt: number }>();
  private seq = 0;

  constructor(
    private readonly clock: () => number,
    private readonly ledger: TrustLedgerService,
    private readonly defaultActor = "system",
  ) {}

  nextId(prefix = "mem"): string {
    this.seq += 1;
    return `${prefix}_${this.clock().toString(36)}_${this.seq.toString(36)}`;
  }

  add(input: AddInput): MemoryRecord {
    if (!input || typeof input.content !== "string" || input.content.trim().length === 0) {
      throw new Error("hmem: memory content is required");
    }
    if (typeof input.source !== "string" || input.source.trim().length === 0) {
      throw new Error("hmem: memory source is required");
    }
    if (input.type && !VALID_TYPES.has(input.type)) throw new Error(`hmem: invalid type ${input.type}`);
    if (input.layer && !VALID_LAYERS.has(input.layer)) throw new Error(`hmem: invalid layer ${input.layer}`);

    const now = this.clock();
    const content = input.content.trim();
    const tags = uniq(input.tags ?? []);
    const cls = classifyDomain(content, tags);
    const entities = input.entities ?? extractEntities(content);
    const m: MemoryRecord = {
      id: this.nextId(),
      content,
      type: input.type ?? "general",
      layer: input.layer ?? "working",
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      tags,
      domain: input.domain ?? cls.domain,
      namespace: input.namespace ?? cls.namespace,
      embedding: embed(content),
      confidence: tidy(clamp01(input.confidence ?? DEFAULTS.defaultConfidence)),
      source: input.source.trim(),
      provenance: {
        origin: (input.provenance?.origin ?? inferOrigin(input.source)) as MemoryOrigin,
        learnedAt: input.provenance?.learnedAt ?? now,
        label: input.provenance?.label ?? `added from ${input.source.trim()}`,
        ...(input.provenance?.refs ? { refs: input.provenance.refs } : {}),
      },
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.goalRunId ? { goalRunId: input.goalRunId } : {}),
      entities: entities.slice(0, DEFAULTS.entityCap),
      relatedTo: uniq(input.relatedTo ?? []).slice(0, DEFAULTS.relatedCap),
      derivedFrom: uniq(input.derivedFrom ?? []),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    const actor = input.actor ?? this.defaultActor;
    const plan = input.skipEnrichmentLinks ? { related: [], supersede: undefined } : this.planLinks(m);
    for (const r of plan.related) if (m.relatedTo.length < DEFAULTS.relatedCap && !m.relatedTo.includes(r)) m.relatedTo.push(r);
    this.records.set(m.id, m);
    this.ledger.append({ memoryId: m.id, action: "create", actor, newState: snapshot(m), details: { source: m.source } });

    if (m.supersedes) {
      this.markSuperseded(m.supersedes, m.id, actor, "explicit supersedes on create");
    } else if (plan.supersede) {
      this.markSuperseded(plan.supersede, m.id, actor, "correction language with high similarity");
    }
    for (const r of plan.related) {
      const other = this.records.get(r);
      if (other && other.relatedTo.length < DEFAULTS.relatedCap && !other.relatedTo.includes(m.id)) {
        this.update(other.id, { relatedTo: [...other.relatedTo, m.id] }, { actor, details: { reason: "shared entity link", with: m.id } });
      }
    }
    return m;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  getArchived(id: string): MemoryRecord | undefined {
    return this.archived.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  allArchived(): MemoryRecord[] {
    return [...this.archived.values()];
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  update(id: string, patch: Partial<MemoryRecord>, opts: UpdateOptions = {}): MemoryRecord {
    const m = this.records.get(id);
    if (!m) throw new Error(`hmem: unknown memory ${id}`);
    const keys = Object.keys(patch) as (keyof MemoryRecord)[];
    const before = snapshot(m, keys);
    Object.assign(m, patch);
    if (patch.content !== undefined) {
      m.embedding = embed(m.content);
      if (!patch.entities) m.entities = extractEntities(m.content);
    }
    if (patch.confidence !== undefined) m.confidence = tidy(clamp01(m.confidence));
    if (patch.tags) m.tags = uniq(m.tags);
    this.ledger.append({
      memoryId: id,
      action: opts.action ?? "update",
      actor: opts.actor ?? this.defaultActor,
      previousState: before,
      newState: snapshot(m, keys),
      ...(opts.details ? { details: opts.details } : {}),
    });
    return m;
  }

  // Hard removal from the active set. The ledger entry is written first.
  delete(id: string, opts: UpdateOptions = {}): boolean {
    const m = this.records.get(id);
    if (!m) return false;
    this.ledger.append({
      memoryId: id,
      action: opts.action ?? "delete",
      actor: opts.actor ?? this.defaultActor,
      previousState: snapshot(m),
      ...(opts.details ? { details: opts.details } : {}),
    });
    this.records.delete(id);
    this.unlink(id);
    return true;
  }

  // Move to the archive. Used by sleep; the record stays restorable.
  archive(id: string, opts: UpdateOptions = {}): boolean {
    const m = this.records.get(id);
    if (!m) return false;
    this.ledger.append({
      memoryId: id,
      action: opts.action ?? "sleep_archive",
      actor: opts.actor ?? this.defaultActor,
      previousState: snapshot(m),
      ...(opts.details ? { details: opts.details } : {}),
    });
    this.records.delete(id);
    this.archived.set(id, { ...m, archivedAt: this.clock() });
    this.unlink(id);
    return true;
  }

  // Record an access without a ledger entry; callers log "read" in batches.
  touch(id: string): void {
    const m = this.records.get(id);
    if (!m) return;
    m.lastAccessed = this.clock();
    m.accessCount += 1;
  }

  markSuperseded(oldId: string, newId: string, actor: string, reason: string): void {
    const old = this.records.get(oldId);
    const fresh = this.records.get(newId);
    if (!old || !fresh || oldId === newId) return;
    if (old.supersededBy !== newId) {
      this.update(oldId, { supersededBy: newId }, { actor, details: { reason, supersededBy: newId } });
    }
    if (fresh.supersedes !== oldId) {
      this.update(newId, { supersedes: oldId }, { actor, details: { reason, supersedes: oldId } });
    }
  }

  // Ids referenced by other records through relatedTo, supersedes or derivedFrom.
  inboundReferences(id: string): string[] {
    const refs: string[] = [];
    for (const m of this.records.values()) {
      if (m.id === id) continue;
      if (m.relatedTo.includes(id) || m.supersedes === id || m.derivedFrom.includes(id)) refs.push(m.id);
    }
    return refs;
  }

  snapshotAll(): { records: MemoryRecord[]; archived: (MemoryRecord & { archivedAt: number })[] } {
    const strip = <T extends MemoryRecord>(m: T) => ({ ...m, embedding: [], tags: [...m.tags], relatedTo: [...m.relatedTo], derivedFrom: [...m.derivedFrom], entities: m.entities.map((e) => ({ ...e })) });
    return {
      records: [...this.records.values()].map(strip),
      archived: [...this.archived.values()].map(strip),
    };
  }

  replaceAll(data: { records: MemoryRecord[]; archived?: (MemoryRecord & { archivedAt: number })[] }): void {
    this.records = new Map();
    this.archived = new Map();
    for (const raw of data.records ?? []) this.records.set(raw.id, hydrateRecord(raw));
    for (const raw of data.archived ?? []) this.archived.set(raw.id, { ...hydrateRecord(raw), archivedAt: raw.archivedAt });
  }

  get sequence(): number {
    return this.seq;
  }

  set sequence(n: number) {
    this.seq = Math.max(this.seq, n);
  }

  // Forgetting curve for non-long-term records idle for over a week.
  applyForgetting(sinceMs: number, actor = "system:forgetting"): number {
    const now = this.clock();
    const elapsedDays = (now - sinceMs) / DAY_MS;
    if (elapsedDays < 1) return 0;
    let changed = 0;
    for (const m of this.records.values()) {
      if (m.layer === "long_term") continue;
      if ((now - m.lastAccessed) / DAY_MS < DEFAULTS.consolidationDays) continue;
      const next = tidy(Math.max(0.05, m.confidence * Math.pow(0.5, elapsedDays / 180)));
      if (m.confidence - next >= 0.005) {
        this.update(m.id, { confidence: next }, { actor, action: "demote", details: { reason: "forgetting curve", elapsedDays: Math.round(elapsedDays) } });
        changed++;
      }
    }
    return changed;
  }

  // Relationship discovery: shared entities plus similarity or domain affinity,
  // and supersession from high similarity plus correction language.
  private planLinks(m: MemoryRecord): { related: string[]; supersede?: string } {
    const names = new Set(m.entities.map((e) => e.name));
    const related: { id: string; sim: number }[] = [];
    let supersede: { id: string; sim: number } | undefined;
    const correcting = hasCorrectionLanguage(m.content);
    for (const other of this.records.values()) {
      const sim = cosine(m.embedding, other.embedding);
      if (correcting && !other.supersededBy && other.type === m.type && sim >= 0.75 && sameScope(m, other)) {
        if (!supersede || sim > supersede.sim) supersede = { id: other.id, sim };
        continue;
      }
      const shared = other.entities.some((e) => names.has(e.name));
      if (!shared) continue;
      if (sim < 0.3 && other.domain !== m.domain) continue;
      related.push({ id: other.id, sim });
    }
    related.sort((a, b) => b.sim - a.sim);
    return { related: related.slice(0, DEFAULTS.relatedCap).map((r) => r.id), supersede: supersede?.id };
  }

  private unlink(id: string): void {
    for (const m of this.records.values()) {
      if (m.relatedTo.includes(id)) m.relatedTo = m.relatedTo.filter((r) => r !== id);
    }
  }
}

const SCOPE_TAG = /^(patient|trial|criterion|project|chat):/;

// Records scoped to different patients, trials or criteria never supersede each other automatically.
function sameScope(a: MemoryRecord, b: MemoryRecord): boolean {
  const key = (m: MemoryRecord) => m.tags.filter((t) => SCOPE_TAG.test(t)).sort().join("|");
  return key(a) === key(b) && a.chatId === b.chatId && a.goalRunId === b.goalRunId;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function inferOrigin(source: string): MemoryOrigin {
  const s = source.toLowerCase();
  if (s.startsWith("doc") || s.includes("import")) return "import";
  if (s.includes("dream") || s.includes("sleep")) return "inference";
  if (s.includes("chat") || s.startsWith("session")) return "chat";
  if (s.includes("decision") || s.includes("navigator")) return "decision";
  if (s.includes("tool")) return "tool";
  return "user_explicit";
}

// Fill defaults for records loaded from disk, including legacy rows.
export function hydrateRecord(raw: MemoryRecord): MemoryRecord {
  const tags = raw.tags ?? [];
  const cls = classifyDomain(raw.content, tags);
  return {
    ...raw,
    type: raw.type ?? "general",
    layer: raw.layer ?? "working",
    lastAccessed: raw.lastAccessed ?? raw.timestamp,
    accessCount: raw.accessCount ?? 0,
    tags: [...tags],
    domain: raw.domain ?? cls.domain,
    namespace: raw.namespace ?? cls.namespace,
    embedding: raw.embedding?.length ? raw.embedding : embed(raw.content),
    confidence: raw.confidence ?? DEFAULTS.defaultConfidence,
    provenance: raw.provenance ?? { origin: inferOrigin(raw.source), learnedAt: raw.timestamp, label: `legacy row from ${raw.source}` },
    entities: raw.entities ?? extractEntities(raw.content),
    relatedTo: [...(raw.relatedTo ?? [])],
    derivedFrom: [...(raw.derivedFrom ?? [])],
  };
}
