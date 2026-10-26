// Preview-first sleep cycle: consolidate, archive, synthesize, with backup and restore.
// Execution only acts on what the preview listed.

import type { MemoryRecord, SleepPreview, SleepPreviewItem, SleepReport } from "./types.ts";
import { DAY_MS, DEFAULTS } from "./types.ts";
import type { TrustLedgerService } from "./ledger.ts";
import type { MemoryStoreService } from "./store.ts";
import { cosine, preview as short } from "./text.ts";

type Snapshot = ReturnType<MemoryStoreService["snapshotAll"]>;

export interface Backup {
  id: string;
  createdAt: number;
  data: Snapshot;
}

const SCOPE_TAG = /^(patient|trial|criterion|project|chat):/;

function scopeKey(m: MemoryRecord): string {
  const scoped = m.tags.filter((t) => SCOPE_TAG.test(t)).sort();
  return [m.type, m.chatId ?? "", m.missionId ?? "", m.goalRunId ?? "", ...scoped].join("|");
}

export class SleepCycleService {
  private backups: Backup[] = [];
  private seq = 0;

  constructor(
    private readonly store: MemoryStoreService,
    private readonly ledger: TrustLedgerService,
    private readonly clock: () => number,
    private readonly hasOpenConflict: (id: string) => boolean,
    private readonly defaultActor = "system",
  ) {}

  // Pure: computes the plan without touching the store.
  preview(): SleepPreview {
    const now = this.clock();
    const all = this.store.all();
    const items: SleepPreviewItem[] = [];
    const protectedList: { id: string; reasons: string[] }[] = [];
    const toArchive: string[] = [];
    const ageDays = (m: MemoryRecord) => (now - m.timestamp) / DAY_MS;
    const idleDays = (m: MemoryRecord) => (now - m.lastAccessed) / DAY_MS;
    const item = (m: MemoryRecord, action: SleepPreviewItem["action"], reason: string): SleepPreviewItem => ({
      id: m.id,
      preview: short(m.content),
      action,
      reason,
      ageDays: Math.floor(ageDays(m)),
      accessCount: m.accessCount,
      confidence: m.confidence,
    });

    for (const m of all) {
      if (ageDays(m) < DEFAULTS.archiveMinDays || m.accessCount > DEFAULTS.archiveMaxAccess) continue;
      const reasons: string[] = [];
      const inbound = this.store.inboundReferences(m.id);
      if (inbound.length > 0) reasons.push(`referenced by ${inbound.length} record(s)`);
      if (m.supersedes) reasons.push("current record that supersedes another");
      if (m.derivedFrom.length > 0) reasons.push("derived or synthesized record");
      if (m.relatedTo.length >= 3) reasons.push("relationship hub");
      if (this.hasOpenConflict(m.id)) reasons.push("unresolved conflict");
      if (m.confidence >= DEFAULTS.archiveProtectConfidence) reasons.push("high confidence");
      if (reasons.length > 0) {
        protectedList.push({ id: m.id, reasons });
        continue;
      }
      toArchive.push(m.id);
      items.push(item(m, "archive", `${Math.floor(ageDays(m))} days old, accessCount ${m.accessCount}, unreferenced`));
    }
    const archiving = new Set(toArchive);

    const toSynthesize: string[][] = [];
    const grouped = new Set<string>();
    const eligible = all
      .filter((m) => !archiving.has(m.id) && !m.supersededBy && !m.supersedes && !this.hasOpenConflict(m.id) && !m.tags.includes("review"))
      .sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
    for (const m of eligible) {
      if (grouped.has(m.id)) continue;
      const key = scopeKey(m);
      const group = [m];
      for (const o of eligible) {
        if (o.id === m.id || grouped.has(o.id) || scopeKey(o) !== key) continue;
        if (cosine(m.embedding, o.embedding) >= DEFAULTS.synthesisCosine) group.push(o);
      }
      if (group.length >= 2) {
        for (const g of group) {
          grouped.add(g.id);
          items.push(item(g, "synthesize", `cosine >= ${DEFAULTS.synthesisCosine} with ${group.length - 1} other record(s)`));
        }
        toSynthesize.push(group.map((g) => g.id));
      }
    }

    const toConsolidate: string[] = [];
    for (const m of all) {
      if (m.layer === "long_term" || archiving.has(m.id) || grouped.has(m.id)) continue;
      if (m.supersededBy || m.tags.includes("review") || m.confidence < 0.5) continue;
      const idle = idleDays(m);
      if (idle >= DEFAULTS.consolidationDays) {
        toConsolidate.push(m.id);
        items.push(item(m, "consolidate", `${Math.floor(idle)} days without access`));
      } else if (m.accessCount >= 5) {
        toConsolidate.push(m.id);
        items.push(item(m, "consolidate", `repeated access (${m.accessCount})`));
      }
    }

    return { createdAt: now, toConsolidate, toArchive, toSynthesize, protected: protectedList, items };
  }

  execute(preview: SleepPreview, actor = this.defaultActor): SleepReport {
    const backup = this.backup();
    const actionLog: string[] = [];
    const ledgerIds: string[] = [];
    const lastLedgerId = () => this.ledger.all().at(-1)?.id;
    const consolidated: string[] = [];
    const archived: string[] = [];
    const synthesized: { id: string; derivedFrom: string[] }[] = [];

    for (const id of preview.toConsolidate) {
      const m = this.store.get(id);
      if (!m || m.layer === "long_term") continue;
      this.store.update(id, { layer: "long_term" }, { actor, action: "sleep_consolidate", details: { backupId: backup.id } });
      consolidated.push(id);
      actionLog.push(`promoted ${id}`);
      ledgerIds.push(lastLedgerId()!);
    }

    for (const id of preview.toArchive) {
      if (!this.store.archive(id, { actor, action: "sleep_archive", details: { backupId: backup.id } })) continue;
      archived.push(id);
      actionLog.push(`archived ${id}`);
      ledgerIds.push(lastLedgerId()!);
    }

    for (const group of preview.toSynthesize) {
      const members = group.map((id) => this.store.get(id)).filter((m): m is MemoryRecord => !!m);
      if (members.length < 2) continue;
      const rep = [...members].sort((a, b) => b.confidence - a.confidence || b.timestamp - a.timestamp)[0];
      const ids = new Set(members.map((m) => m.id));
      const relatedTo = [...new Set(members.flatMap((m) => m.relatedTo))].filter((r) => !ids.has(r)).slice(0, DEFAULTS.relatedCap);
      const entities = new Map<string, { name: string; type: string }>();
      for (const m of members) for (const e of m.entities) if (!entities.has(e.name)) entities.set(e.name, e);
      const created = this.store.add({
        content: rep.content,
        source: "sleep_synthesis",
        type: rep.type,
        layer: "long_term",
        confidence: Math.max(...members.map((m) => m.confidence)),
        tags: [...new Set(members.flatMap((m) => m.tags))],
        entities: [...entities.values()].slice(0, DEFAULTS.entityCap),
        relatedTo,
        derivedFrom: members.map((m) => m.id),
        chatId: rep.chatId,
        missionId: rep.missionId,
        goalRunId: rep.goalRunId,
        provenance: { origin: "inference", label: `synthesized by sleep from ${members.length} similar records` },
        actor,
        skipEnrichmentLinks: true,
      });
      created.accessCount = members.reduce((s, m) => s + m.accessCount, 0);
      created.lastAccessed = Math.max(...members.map((m) => m.lastAccessed));
      this.ledger.append({ memoryId: created.id, action: "sleep_synthesize", actor, details: { backupId: backup.id, derivedFrom: [...ids] } });
      ledgerIds.push(lastLedgerId()!);
      for (const other of this.store.all()) {
        if (other.id === created.id) continue;
        if (other.relatedTo.some((r) => ids.has(r))) {
          const next = [...new Set(other.relatedTo.map((r) => (ids.has(r) ? created.id : r)))];
          this.store.update(other.id, { relatedTo: next }, { actor, details: { reason: "relink to synthesized record", to: created.id } });
        }
      }
      for (const m of members) {
        this.store.archive(m.id, { actor, action: "sleep_synthesize", details: { backupId: backup.id, mergedInto: created.id } });
        ledgerIds.push(lastLedgerId()!);
      }
      synthesized.push({ id: created.id, derivedFrom: [...ids] });
      actionLog.push(`synthesized ${[...ids].join("+")} -> ${created.id}`);
    }

    return {
      backupId: backup.id,
      ranAt: this.clock(),
      consolidatedCount: consolidated.length,
      archivedCount: archived.length,
      synthesizedCount: synthesized.length,
      consolidated,
      archived,
      synthesized,
      actionLog,
      ledgerIds,
    };
  }

  backup(): Backup {
    this.seq += 1;
    const b: Backup = { id: `backup_${this.clock().toString(36)}_${this.seq.toString(36)}`, createdAt: this.clock(), data: this.store.snapshotAll() };
    this.backups.push(b);
    while (this.backups.length > DEFAULTS.backupsKept) this.backups.shift();
    return b;
  }

  restore(backupId: string, actor = this.defaultActor): void {
    const b = this.backups.find((x) => x.id === backupId);
    if (!b) throw new Error(`hmem: unknown backup ${backupId}`);
    const before = this.store.all().length;
    this.store.replaceAll(b.data);
    this.ledger.append({ memoryId: `backup:${backupId}`, action: "restore", actor, details: { backupId, recordsBefore: before, recordsAfter: this.store.all().length } });
  }

  listBackups(): { id: string; createdAt: number; records: number }[] {
    return this.backups.map((b) => ({ id: b.id, createdAt: b.createdAt, records: b.data.records.length }));
  }

  toJSON(): { seq: number; backups: Backup[] } {
    return { seq: this.seq, backups: this.backups };
  }

  load(data: { seq: number; backups: Backup[] } | undefined): void {
    this.backups = data?.backups ?? [];
    this.seq = data?.seq ?? this.backups.length;
  }
}
