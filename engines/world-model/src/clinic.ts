// Nightlist domain wrapper over the world model. Trials, sites, criteria,
// test types and patients are entities; patient facts and match verdicts are
// facts; domain changes (trial_opened, fact_changed, match_new, ...) are
// "change" events in the same log, so the overnight panel is just a read
// over the log.

import {
  WorldModel,
  normalizeName,
  type Entity,
  type Fact,
  type ISODate,
  type Provenance,
  type WorldEvent,
  type WorldModelOptions,
} from "./index.ts";

// ------------------------------------------------------------------ types

export interface TrialSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface CriterionInput {
  id: string;
  text: string;
  /** test type keys that can resolve this criterion, e.g. "egfr", "hba1c" */
  tests?: string[];
}

export interface TrialSnapshotItem {
  nctId: string;
  title: string;
  lastUpdate: string;
  criteriaHash: string;
  sites: TrialSite[];
  criteria?: CriterionInput[];
}

export type FactKind = "lab" | "biomarker" | "diagnosis" | "therapy";

export interface PatientFactInput {
  patientId: string;
  kind: FactKind;
  key: string;
  value: string;
  observedAt: string;
  source: string;
}

export type VerdictStatus = "eligible_no_blockers" | "possible_unknowns" | "needs_review" | "not_eligible";

export interface VerdictInput {
  patientId: string;
  nctId: string;
  status: VerdictStatus;
  unknownCount: number;
  blockingCriterion?: string;
}

export type ChangeKind =
  | "trial_opened"
  | "trial_amended"
  | "trial_closed"
  | "fact_added"
  | "fact_changed"
  | "match_new"
  | "match_changed"
  | "match_dropped";

export interface ChangeProvenance {
  source: string;
  observedAt: ISODate;
  recordedAt: ISODate;
  runId?: string;
  eventId: string;
}

export interface ChangeItem {
  eventId: string;
  seq: number;
  kind: ChangeKind;
  subject: string;
  related: string[];
  nctId?: string;
  patientId?: string;
  factId?: string;
  summary: string;
  data: Record<string, unknown>;
  provenance: ChangeProvenance;
}

export interface ChangeGroup {
  kind: ChangeKind;
  label: string;
  count: number;
  items: ChangeItem[];
}

export interface ChangesReport {
  since: string;
  sinceKind: "run" | "time";
  throughSeq: number;
  total: number;
  groups: ChangeGroup[];
}

export interface TrialSnapshotResult {
  changes: ChangeItem[];
  opened: number;
  amended: number;
  closed: number;
  unchanged: number;
}

export interface PatientFactsResult {
  changes: ChangeItem[];
  added: number;
  changed: number;
  unchanged: number;
  /** recorded with provenance but older than the current value, so not current */
  historical: number;
}

export interface VerdictRunResult {
  runId: string;
  alreadyRecorded: boolean;
  changes: ChangeItem[];
  counts: { new: number; changed: number; dropped: number; evaluated: number };
}

export interface TimelineEntry {
  seq: number;
  eventId: string;
  kind: string;
  observedAt: ISODate;
  recordedAt: ISODate;
  summary: string;
  provenance: { source: string; observedAt: ISODate; runId?: string; by?: string; url?: string };
  data: unknown;
}

export interface ProvenanceRecord {
  id: string;
  type: "fact" | "event";
  eventId?: string;
  seq?: number;
  kind: string;
  about?: string;
  predicate?: string;
  value?: unknown;
  current?: boolean;
  supersededBy?: string;
  source: string;
  observedAt: ISODate;
  recordedAt?: ISODate;
  runId?: string;
  by?: string;
  url?: string;
  /** other recorded values for the same fact key, oldest first */
  history?: { factId: string; value: unknown; source: string; observedAt: ISODate; current: boolean }[];
}

export interface ClinicWorldOptions {
  /** JSONL event log path, e.g. data/runtime/world.jsonl. Omit for an in-memory world. */
  logPath?: string;
  clock?: () => Date;
}

interface VerdictValue {
  status: VerdictStatus | "not_evaluated";
  unknownCount: number;
  blockingCriterion: string | null;
  /** keeps verdict fact ids unique per run */
  runId?: string;
}

const sameVerdict = (a: VerdictValue, b: VerdictValue) =>
  a.status === b.status && a.unknownCount === b.unknownCount && (a.blockingCriterion ?? null) === (b.blockingCriterion ?? null);
const verdictFields = (v: VerdictValue) => ({ status: v.status, unknownCount: v.unknownCount, blockingCriterion: v.blockingCriterion });

// ------------------------------------------------------------------ ids

const slug = (s: string) => normalizeName(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const clinicIds = {
  trial: (nctId: string) => `trial:ctgov:${nctId.trim().toUpperCase()}`,
  site: (siteId: string) => `site:ctgov:${siteId}`,
  patient: (patientId: string) => `patient:nightlist:${patientId}`,
  criterion: (nctId: string, criterionId: string) => `criterion:${nctId.trim().toUpperCase()}:${criterionId}`,
  test: (key: string) => `test:nightlist:${slug(key)}`,
};

const GROUPS: { kind: ChangeKind; label: string }[] = [
  { kind: "trial_opened", label: "Trials opened" },
  { kind: "trial_amended", label: "Trials amended" },
  { kind: "trial_closed", label: "Trials closed" },
  { kind: "fact_added", label: "Patient facts added" },
  { kind: "fact_changed", label: "Patient facts changed" },
  { kind: "match_new", label: "New matches" },
  { kind: "match_changed", label: "Changed matches" },
  { kind: "match_dropped", label: "Dropped matches" },
];

const RUN_MARKER = "run_recorded";
const STATUSES: VerdictStatus[] = ["eligible_no_blockers", "possible_unknowns", "needs_review", "not_eligible"];
const FACT_KINDS: FactKind[] = ["lab", "biomarker", "diagnosis", "therapy"];
const isMatch = (status: string | undefined) => status === "eligible_no_blockers" || status === "possible_unknowns" || status === "needs_review";
const statusLabel = (v: VerdictValue) =>
  v.status === "eligible_no_blockers"
    ? "no blockers found"
    : v.status === "possible_unknowns"
      ? `possible, ${v.unknownCount} unknown${v.unknownCount === 1 ? "" : "s"}`
      : v.status === "needs_review"
        ? "key criterion needs a human read"
      : v.status === "not_eligible"
        ? `not eligible${v.blockingCriterion ? ` (${v.blockingCriterion})` : ""}`
        : "not evaluated";

// ------------------------------------------------------------------ ClinicWorld

export class ClinicWorld {
  readonly world: WorldModel;
  private readonly clock: () => Date;

  constructor(opts: ClinicWorldOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
    const wopts: WorldModelOptions = { namespace: "nightlist", clock: this.clock };
    if (opts.logPath) Object.assign(wopts, { storage: "jsonl", path: opts.logPath });
    this.world = new WorldModel(wopts);
  }

  static open(logPath: string, opts: Omit<ClinicWorldOptions, "logPath"> = {}): ClinicWorld {
    return new ClinicWorld({ ...opts, logPath });
  }

  // ---------------------------------------------------------- trials

  ingestTrialSnapshot(trials: TrialSnapshotItem[], source: string, observedAt: string, opts: { complete?: boolean } = {}): TrialSnapshotResult {
    const prov: Provenance = { kind: requireSource(source), at: observedAt };
    const result: TrialSnapshotResult = { changes: [], opened: 0, amended: 0, closed: 0, unchanged: 0 };
    const seen = new Set<string>();

    for (const t of trials) {
      if (!t?.nctId) throw new Error("ingestTrialSnapshot: every trial needs an nctId");
      const id = clinicIds.trial(t.nctId);
      if (seen.has(id)) continue;
      seen.add(id);
      const before = this.world.entity(id);
      const wasOpen = before?.attrs.status === "open";
      const attrs = { nctId: t.nctId.trim().toUpperCase(), title: t.title, lastUpdate: t.lastUpdate, criteriaHash: t.criteriaHash, status: "open" };
      this.world.upsertEntity({ type: "trial", externalKey: { system: "ctgov", id: attrs.nctId }, name: t.title, attrs, source: prov });

      if (!wasOpen) {
        result.opened++;
        result.changes.push(
          this.change("trial_opened", id, [], { nctId: attrs.nctId, title: t.title, lastUpdate: t.lastUpdate, criteriaHash: t.criteriaHash, reopened: before?.attrs.status === "closed" }, prov),
        );
      } else if (before!.attrs.criteriaHash !== t.criteriaHash) {
        result.amended++;
        result.changes.push(
          this.change("trial_amended", id, [], { nctId: attrs.nctId, title: t.title, lastUpdate: t.lastUpdate, previousCriteriaHash: before!.attrs.criteriaHash, criteriaHash: t.criteriaHash }, prov),
        );
      } else {
        result.unchanged++;
      }

      this.syncSites(id, t.sites ?? [], prov);
      if (t.criteria) this.syncCriteria(attrs.nctId, t.criteria, prov);
    }

    if (opts.complete !== false) {
      for (const trial of this.world.view("graph").query({ type: "trial", where: (e) => e.attrs.status === "open" })) {
        if (seen.has(trial.id)) continue;
        this.world.upsertEntity({ type: "trial", externalKey: { system: "ctgov", id: String(trial.attrs.nctId) }, attrs: { status: "closed" }, source: prov });
        result.closed++;
        result.changes.push(this.change("trial_closed", trial.id, [], { nctId: trial.attrs.nctId, title: trial.attrs.title, reason: "missing from snapshot" }, prov));
      }
    }
    return result;
  }

  /** Attach criteria (and the test types that resolve them) to a trial. Criteria not listed are detached. */
  linkCriteria(nctId: string, criteria: CriterionInput[], source: string, observedAt: string): void {
    this.syncCriteria(nctId.trim().toUpperCase(), criteria, { kind: requireSource(source), at: observedAt });
  }

  private syncSites(trialId: string, sites: TrialSite[], prov: Provenance): void {
    const keep = new Set<string>();
    for (const s of sites) {
      const site = this.world.upsertEntity({ type: "site", externalKey: { system: "ctgov", id: String(s.id) }, name: s.name, attrs: { siteId: String(s.id), name: s.name, lat: s.lat, lon: s.lon }, source: prov });
      keep.add(site.id);
      this.world.relate({ from: trialId, type: "recruits_at", to: site.id, cardinality: "many", source: prov });
    }
    for (const rel of this.world.view("graph").edges(trialId, { via: "recruits_at", direction: "out" })) {
      if (!keep.has(rel.to)) this.world.unrelate({ from: trialId, type: "recruits_at", to: rel.to, source: prov });
    }
  }

  private syncCriteria(nctId: string, criteria: CriterionInput[], prov: Provenance): void {
    const trialId = clinicIds.trial(nctId);
    const keep = new Set<string>();
    for (const c of criteria) {
      const crit = this.world.upsertEntity({ type: "criterion", externalKey: { system: nctId, id: String(c.id) }, attrs: { nctId, criterionId: String(c.id), text: c.text }, source: prov });
      keep.add(crit.id);
      this.world.relate({ from: trialId, type: "has_criterion", to: crit.id, cardinality: "many", source: prov });
      const tests = new Set<string>();
      for (const key of c.tests ?? []) {
        const test = this.world.upsertEntity({ type: "test", externalKey: { system: "nightlist", id: slug(key) }, name: key, attrs: { key: slug(key) }, source: prov });
        tests.add(test.id);
        this.world.relate({ from: crit.id, type: "resolved_by_test", to: test.id, cardinality: "many", source: prov });
      }
      for (const rel of this.world.view("graph").edges(crit.id, { via: "resolved_by_test", direction: "out" })) {
        if (!tests.has(rel.to)) this.world.unrelate({ from: crit.id, type: "resolved_by_test", to: rel.to, source: prov });
      }
    }
    for (const rel of this.world.view("graph").edges(trialId, { via: "has_criterion", direction: "out" })) {
      if (!keep.has(rel.to)) this.world.unrelate({ from: trialId, type: "has_criterion", to: rel.to, source: prov });
    }
  }

  // ---------------------------------------------------------- patient facts

  ingestPatientFacts(facts: PatientFactInput[]): PatientFactsResult {
    const result: PatientFactsResult = { changes: [], added: 0, changed: 0, unchanged: 0, historical: 0 };
    for (const f of facts) {
      if (!f?.patientId || !f.key) throw new Error("ingestPatientFacts: patientId and key are required");
      if (!FACT_KINDS.includes(f.kind)) throw new Error(`ingestPatientFacts: unknown kind "${f.kind}"`);
      const prov: Provenance = { kind: requireSource(f.source), at: f.observedAt };
      const patientId = clinicIds.patient(f.patientId);
      this.world.upsertEntity({ type: "patient", externalKey: { system: "nightlist", id: f.patientId }, attrs: { patientId: f.patientId }, source: prov });
      const related: string[] = [];
      if (f.kind === "lab" || f.kind === "biomarker") {
        const test = this.world.upsertEntity({ type: "test", externalKey: { system: "nightlist", id: slug(f.key) }, name: f.key, attrs: { key: slug(f.key) }, source: prov });
        related.push(test.id);
      }

      const predicate = `${f.kind}:${slug(f.key)}`;
      const previous = this.world.view("facts").current(patientId)[predicate];
      const value = String(f.value);
      if (previous && previous.value === value) {
        result.unchanged++;
        continue;
      }
      const fact = this.world.assertFact({ about: patientId, predicate, value, confidence: 1, source: prov });
      const now = this.world.view("facts").current(patientId)[predicate];
      if (now?.id !== fact.id) {
        result.historical++;
        continue;
      }
      const data = { patientId: f.patientId, kind: f.kind, key: f.key, predicate, value, factId: fact.id };
      if (!previous) {
        result.added++;
        result.changes.push(this.change("fact_added", patientId, related, data, prov));
      } else {
        result.changed++;
        result.changes.push(this.change("fact_changed", patientId, related, { ...data, previousValue: previous.value, previousFactId: previous.id }, prov));
      }
    }
    return result;
  }

  /** Current value per fact key for a patient. */
  patientFacts(patientId: string): Record<string, { value: unknown; factId: string; source: string; observedAt: string }> {
    const out: Record<string, { value: unknown; factId: string; source: string; observedAt: string }> = {};
    for (const [predicate, f] of Object.entries(this.world.view("facts").current(clinicIds.patient(patientId)))) {
      if (predicate.startsWith("verdict:")) continue;
      out[predicate] = { value: f.value, factId: f.id, source: f.source.kind, observedAt: f.assertedAt };
    }
    return out;
  }

  // ---------------------------------------------------------- verdicts

  recordVerdicts(runId: string, verdicts: VerdictInput[], opts: { at?: string; source?: string; partial?: boolean } = {}): VerdictRunResult {
    if (!runId) throw new Error("recordVerdicts: runId is required");
    const marker = this.runMarker(runId);
    if (marker) {
      const changes = this.runEvents(runId).map((e) => this.toItem(e)).filter((c): c is ChangeItem => !!c);
      return { runId, alreadyRecorded: true, changes, counts: marker.payload.data.counts as VerdictRunResult["counts"] };
    }

    const prov: Provenance = { kind: opts.source ?? "matcher", at: opts.at ?? this.clock().toISOString(), runId };
    const previous = this.latestVerdicts();
    const seen = new Set<string>();
    const changes: ChangeItem[] = [];
    const counts = { new: 0, changed: 0, dropped: 0, evaluated: 0 };

    for (const v of verdicts) {
      if (!v?.patientId || !v.nctId) throw new Error("recordVerdicts: patientId and nctId are required");
      if (!STATUSES.includes(v.status)) throw new Error(`recordVerdicts: unknown status "${v.status}"`);
      const nctId = v.nctId.trim().toUpperCase();
      const key = `${v.patientId}|${nctId}`;
      seen.add(key);
      counts.evaluated++;
      const patientId = clinicIds.patient(v.patientId);
      const trialId = clinicIds.trial(nctId);
      this.world.upsertEntity({ type: "patient", externalKey: { system: "nightlist", id: v.patientId }, attrs: { patientId: v.patientId }, source: prov });
      if (!this.world.entity(trialId)) this.world.upsertEntity({ type: "trial", externalKey: { system: "ctgov", id: nctId }, attrs: { nctId }, source: prov });

      const value: VerdictValue = { status: v.status, unknownCount: Number(v.unknownCount) || 0, blockingCriterion: v.blockingCriterion ?? null, runId };
      const prev = previous.get(key);
      const same = !!prev && sameVerdict(prev.value, value);
      let fact = prev?.fact;
      if (!same) fact = this.world.assertFact({ about: patientId, predicate: `verdict:${nctId}`, value, confidence: 1, source: prov });
      previous.set(key, { value, fact: fact! });

      const base = { patientId: v.patientId, nctId, factId: fact!.id };
      const wasMatch = isMatch(prev?.value.status);
      const nowMatch = isMatch(value.status);
      if (!wasMatch && nowMatch) {
        counts.new++;
        this.world.relate({ from: patientId, type: "candidate_for", to: trialId, cardinality: "many", source: prov });
        changes.push(this.change("match_new", patientId, [trialId], { ...base, ...verdictFields(value) }, prov));
      } else if (wasMatch && nowMatch && !same) {
        counts.changed++;
        changes.push(this.change("match_changed", patientId, [trialId], { ...base, from: verdictFields(prev!.value), to: verdictFields(value) }, prov));
      } else if (wasMatch && !nowMatch) {
        counts.dropped++;
        this.world.unrelate({ from: patientId, type: "candidate_for", to: trialId, source: prov });
        changes.push(this.change("match_dropped", patientId, [trialId], { ...base, from: verdictFields(prev!.value), reason: "not_eligible", blockingCriterion: value.blockingCriterion }, prov));
      }
    }

    if (!opts.partial) {
      for (const [key, prev] of previous) {
        if (seen.has(key) || !isMatch(prev.value.status)) continue;
        const [pid, nctId] = key.split("|");
        const patientId = clinicIds.patient(pid);
        const trialId = clinicIds.trial(nctId);
        const value: VerdictValue = { status: "not_evaluated", unknownCount: 0, blockingCriterion: null, runId };
        const fact = this.world.assertFact({ about: patientId, predicate: `verdict:${nctId}`, value, confidence: 1, source: prov });
        this.world.unrelate({ from: patientId, type: "candidate_for", to: trialId, source: prov });
        counts.dropped++;
        changes.push(this.change("match_dropped", patientId, [trialId], { patientId: pid, nctId, factId: fact.id, from: verdictFields(prev.value), reason: "not_in_run", blockingCriterion: null }, prov));
      }
    }

    this.world.recordChange({ kind: RUN_MARKER, subject: `run:${runId}`, related: [], data: { runId, counts }, source: prov });
    return { runId, alreadyRecorded: false, changes, counts };
  }

  /** Latest verdict per patient/trial pair (by log order). */
  currentVerdicts(): (VerdictInput & { factId: string; observedAt: string; runId?: string; isMatch: boolean })[] {
    return [...this.latestVerdicts().entries()]
      .filter(([, v]) => v.value.status !== "not_evaluated")
      .map(([key, v]) => {
        const [patientId, nctId] = key.split("|");
        return {
          patientId,
          nctId,
          status: v.value.status as VerdictStatus,
          unknownCount: v.value.unknownCount,
          ...(v.value.blockingCriterion ? { blockingCriterion: v.value.blockingCriterion } : {}),
          factId: v.fact.id,
          observedAt: v.fact.assertedAt,
          runId: v.fact.source.runId,
          isMatch: isMatch(v.value.status),
        };
      })
      .sort((a, b) => (a.patientId + a.nctId < b.patientId + b.nctId ? -1 : 1));
  }

  private latestVerdicts(): Map<string, { value: VerdictValue; fact: Fact }> {
    const latest = new Map<string, { value: VerdictValue; fact: Fact }>();
    for (const e of this.world.events({ kinds: ["fact"] })) {
      const f = e.payload as Fact;
      if (!f.predicate.startsWith("verdict:")) continue;
      const fact = this.world.fact(f.id);
      if (!fact) continue;
      const patient = this.world.entity(fact.about);
      const pid = String(patient?.attrs.patientId ?? fact.about.replace(/^patient:nightlist:/, ""));
      latest.set(`${pid}|${f.predicate.slice("verdict:".length)}`, { value: fact.value as VerdictValue, fact });
    }
    return latest;
  }

  runs(): { runId: string; seq: number; observedAt: string; recordedAt: string; counts: unknown }[] {
    return this.world
      .events({ kinds: ["change"] })
      .filter((e) => e.payload.kind === RUN_MARKER)
      .map((e) => ({ runId: e.payload.data.runId, seq: e.seq, observedAt: e.at, recordedAt: e.recordedAt, counts: e.payload.data.counts }));
  }

  private runMarker(runId: string): WorldEvent | undefined {
    return this.world.events({ kinds: ["change"] }).find((e) => e.payload.kind === RUN_MARKER && e.payload.data.runId === runId);
  }

  private runEvents(runId: string): WorldEvent[] {
    return this.world.events({ kinds: ["change"] }).filter((e) => e.source.runId === runId && e.payload.kind !== RUN_MARKER);
  }

  // ---------------------------------------------------------- reads

  /**
   * Changes for the "what changed overnight" panel. Pass a run id to get
   * everything recorded after that run, or an ISO time to get everything
   * recorded at or after that time.
   */
  changesSince(since: string): ChangesReport {
    const marker = this.runMarker(since);
    let events: WorldEvent[];
    if (marker) {
      events = this.world.events({ afterSeq: marker.seq, kinds: ["change"] });
    } else {
      const t = new Date(since);
      if (Number.isNaN(t.getTime())) throw new Error(`changesSince: "${since}" is neither a recorded run id nor an ISO time`);
      const iso = t.toISOString();
      events = this.world.events({ kinds: ["change"] }).filter((e) => e.recordedAt >= iso);
    }
    return this.group(since, marker ? "run" : "time", events);
  }

  /** Changes produced by one verdict run. */
  changesInRun(runId: string): ChangesReport {
    return this.group(runId, "run", this.runEvents(runId));
  }

  private group(since: string, sinceKind: "run" | "time", events: WorldEvent[]): ChangesReport {
    const items = events.map((e) => this.toItem(e)).filter((c): c is ChangeItem => !!c);
    const groups = GROUPS.map((g) => {
      const list = items.filter((i) => i.kind === g.kind);
      return { kind: g.kind, label: g.label, count: list.length, items: list };
    }).filter((g) => g.count > 0);
    return { since, sinceKind, throughSeq: this.world.lastSeq(), total: items.length, groups };
  }

  timeline(entityId: string, opts: { changesOnly?: boolean } = {}): TimelineEntry[] {
    const id = this.resolveEntityId(entityId);
    return this.world
      .history(id)
      .filter((e) => !opts.changesOnly || (e.kind === "change" && e.payload.kind !== RUN_MARKER))
      .map((e) => {
        const item = e.kind === "change" ? this.toItem(e) : undefined;
        return {
          seq: e.seq,
          eventId: e.id,
          kind: e.kind === "change" ? String(e.payload.kind) : e.kind,
          observedAt: e.at,
          recordedAt: e.recordedAt,
          summary: item?.summary ?? describe(e),
          provenance: { source: e.source.kind, observedAt: e.source.at, runId: e.source.runId, by: e.source.by, url: e.source.url },
          data: e.kind === "change" ? e.payload.data : e.payload,
        };
      });
  }

  /** Where a fact (fact_...) or event (evt_...) came from. */
  provenance(id: string): ProvenanceRecord | undefined {
    const fact = this.world.fact(id);
    if (fact) {
      const event = this.world.events({ kinds: ["fact"] }).find((e) => e.payload.id === id);
      const history = this.world
        .view("facts")
        .about(fact.about, { predicate: fact.predicate })
        .map((f) => ({ factId: f.id, value: f.value, source: f.source.kind, observedAt: f.assertedAt, current: !f.supersededBy }));
      return {
        id,
        type: "fact",
        eventId: event?.id,
        seq: event?.seq,
        kind: fact.predicate.split(":")[0],
        about: fact.about,
        predicate: fact.predicate,
        value: fact.value,
        current: !fact.supersededBy,
        supersededBy: fact.supersededBy,
        source: fact.source.kind,
        observedAt: fact.assertedAt,
        recordedAt: event?.recordedAt,
        runId: fact.source.runId,
        by: fact.source.by,
        url: fact.source.url,
        history,
      };
    }
    const event = this.world.event(id);
    if (!event) return undefined;
    return {
      id,
      type: "event",
      eventId: event.id,
      seq: event.seq,
      kind: event.kind === "change" ? String(event.payload.kind) : event.kind,
      source: event.source.kind,
      observedAt: event.at,
      recordedAt: event.recordedAt,
      runId: event.source.runId,
      by: event.source.by,
      url: event.source.url,
    };
  }

  trial(nctId: string): Entity | undefined {
    return this.world.entity(clinicIds.trial(nctId));
  }

  openTrials(): Entity[] {
    return this.world.view("graph").query({ type: "trial", where: (e) => e.attrs.status === "open" });
  }

  sitesFor(nctId: string): Entity[] {
    return this.world.view("graph").neighborsOf(clinicIds.trial(nctId), { via: "recruits_at", direction: "out" });
  }

  criteriaFor(nctId: string): (Entity & { tests: Entity[] })[] {
    return this.world
      .view("graph")
      .neighborsOf(clinicIds.trial(nctId), { via: "has_criterion", direction: "out" })
      .map((c) => ({ ...c, tests: this.world.view("graph").neighborsOf(c.id, { via: "resolved_by_test", direction: "out" }) }));
  }

  candidateTrials(patientId: string): Entity[] {
    return this.world.view("graph").neighborsOf(clinicIds.patient(patientId), { via: "candidate_for", direction: "out" });
  }

  stats(): Record<string, number> {
    const g = this.world.view("graph");
    return {
      ...this.world.stats(),
      trials: g.query({ type: "trial" }).length,
      openTrials: this.openTrials().length,
      patients: g.query({ type: "patient" }).length,
      sites: g.query({ type: "site" }).length,
      runs: this.runs().length,
    };
  }

  // ---------------------------------------------------------- internals

  private resolveEntityId(id: string): string {
    if (this.world.entity(id)) return id;
    if (/^NCT\d+$/i.test(id.trim())) return clinicIds.trial(id);
    if (this.world.entity(clinicIds.patient(id))) return clinicIds.patient(id);
    return id;
  }

  private change(kind: ChangeKind, subject: string, related: string[], data: Record<string, unknown>, prov: Provenance): ChangeItem {
    const e = this.world.recordChange({ kind, subject, related, data, source: prov });
    return this.toItem(e)!;
  }

  private toItem(e: WorldEvent): ChangeItem | undefined {
    if (e.kind !== "change" || e.payload.kind === RUN_MARKER) return undefined;
    const kind = e.payload.kind as ChangeKind;
    const d = e.payload.data as Record<string, any>;
    return {
      eventId: e.id,
      seq: e.seq,
      kind,
      subject: e.payload.subject,
      related: e.payload.related ?? [],
      nctId: d.nctId,
      patientId: d.patientId,
      factId: d.factId,
      summary: summaryFor(kind, d),
      data: d,
      provenance: { source: e.source.kind, observedAt: e.at, recordedAt: e.recordedAt, runId: e.source.runId, eventId: e.id },
    };
  }
}

function summaryFor(kind: ChangeKind, d: Record<string, any>): string {
  switch (kind) {
    case "trial_opened":
      return `${d.nctId} ${d.reopened ? "reopened" : "opened"}: ${d.title ?? ""}`.trim();
    case "trial_amended":
      return `${d.nctId} eligibility criteria amended`;
    case "trial_closed":
      return `${d.nctId} no longer in the registry snapshot`;
    case "fact_added":
      return `${d.patientId}: ${d.kind} ${d.key} = ${d.value}`;
    case "fact_changed":
      return `${d.patientId}: ${d.kind} ${d.key} changed ${d.previousValue} -> ${d.value}`;
    case "match_new":
      return `${d.patientId} now matches ${d.nctId} (${statusLabel(d as VerdictValue)})`;
    case "match_changed":
      return `${d.patientId} / ${d.nctId}: ${statusLabel(d.from)} -> ${statusLabel(d.to)}`;
    case "match_dropped":
      return d.reason === "not_in_run"
        ? `${d.patientId} / ${d.nctId} was not evaluated in this run`
        : `${d.patientId} no longer matches ${d.nctId}${d.blockingCriterion ? ` (blocked by ${d.blockingCriterion})` : ""}`;
  }
}

function describe(e: WorldEvent): string {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "entity":
      return `${p.type} ${p.id} recorded`;
    case "relate":
      return `${p.from} ${p.type} ${p.to}`;
    case "close":
      return `${p.from} ${p.type} ${p.to} ended`;
    case "fact":
      return `${p.predicate} = ${typeof p.value === "string" ? p.value : JSON.stringify(p.value)}`;
    case "alias":
      return `${p.aliasId} merged into ${p.primaryId}`;
    case "unalias":
      return `${p.aliasId} split from ${p.primaryId}`;
    default:
      return e.kind;
  }
}

function requireSource(source: string): string {
  if (!source || typeof source !== "string") throw new Error("a source is required for provenance");
  return source;
}
