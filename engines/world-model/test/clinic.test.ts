import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClinicWorld, clinicIds, type TrialSnapshotItem } from "../src/clinic.ts";

const site = (id: string) => ({ id, name: `Site ${id}`, lat: 40.7, lon: -74 });
const trial = (nctId: string, criteriaHash = "h1", sites = [site("s1")]): TrialSnapshotItem => ({
  nctId,
  title: `Trial ${nctId}`,
  lastUpdate: "2026-10-01",
  criteriaHash,
  sites,
});

function fixedClock(start: string) {
  let t = new Date(start).getTime();
  return { clock: () => new Date(t), advance: (ms: number) => (t += ms) };
}

test("trial snapshot: opened, idempotent, amended, closed", () => {
  const w = new ClinicWorld();
  const first = w.ingestTrialSnapshot([trial("NCT00000001"), trial("NCT00000002")], "ctgov", "2026-10-26T02:00:00Z");
  assert.equal(first.opened, 2);
  assert.deepEqual(first.changes.map((c) => c.kind), ["trial_opened", "trial_opened"]);
  assert.equal(first.changes[0].provenance.source, "ctgov");
  assert.equal(first.changes[0].provenance.observedAt, "2026-10-26T02:00:00.000Z");

  const seq = w.world.lastSeq();
  const again = w.ingestTrialSnapshot([trial("NCT00000001"), trial("NCT00000002")], "ctgov", "2026-10-26T02:00:00Z");
  assert.equal(again.changes.length, 0);
  assert.equal(w.world.lastSeq(), seq, "re-ingesting the same snapshot appends nothing");

  const next = w.ingestTrialSnapshot([trial("NCT00000001", "h2", [site("s1"), site("s2")])], "ctgov", "2026-10-27T02:00:00Z");
  assert.deepEqual(next.changes.map((c) => c.kind), ["trial_amended", "trial_closed"]);
  assert.equal(next.changes[0].data.previousCriteriaHash, "h1");
  assert.equal(w.trial("NCT00000002")!.attrs.status, "closed");
  assert.equal(w.sitesFor("NCT00000001").length, 2);

  const reopened = w.ingestTrialSnapshot([trial("NCT00000001", "h2", [site("s1"), site("s2")]), trial("NCT00000002")], "ctgov", "2026-10-28T02:00:00Z");
  assert.deepEqual(reopened.changes.map((c) => c.kind), ["trial_opened"]);
  assert.equal(reopened.changes[0].data.reopened, true);
});

test("criteria link to trials and tests", () => {
  const w = new ClinicWorld();
  w.ingestTrialSnapshot([{ ...trial("NCT00000003"), criteria: [{ id: "inc1", text: "eGFR >= 45", tests: ["eGFR"] }, { id: "exc1", text: "No prior EGFR TKI" }] }], "ctgov", "2026-10-26T02:00:00Z");
  const crit = w.criteriaFor("NCT00000003");
  assert.equal(crit.length, 2);
  assert.equal(crit.find((c) => c.attrs.criterionId === "inc1")!.tests[0].id, clinicIds.test("egfr"));
  w.linkCriteria("NCT00000003", [{ id: "inc1", text: "eGFR >= 45", tests: ["eGFR"] }], "ctgov", "2026-10-27T02:00:00Z");
  assert.equal(w.criteriaFor("NCT00000003").length, 1);
});

test("patient facts: added, unchanged, changed, late older value", () => {
  const w = new ClinicWorld();
  const base = { patientId: "P1", kind: "lab" as const, key: "eGFR", source: "ehr" };
  const a = w.ingestPatientFacts([{ ...base, value: "60", observedAt: "2026-10-20T08:00:00Z" }]);
  assert.deepEqual(a.changes.map((c) => c.kind), ["fact_added"]);
  const b = w.ingestPatientFacts([{ ...base, value: "60", observedAt: "2026-10-20T08:00:00Z" }]);
  assert.equal(b.unchanged, 1);
  assert.equal(b.changes.length, 0);
  const c = w.ingestPatientFacts([{ ...base, value: "42", observedAt: "2026-10-26T08:00:00Z" }]);
  assert.deepEqual(c.changes.map((x) => x.kind), ["fact_changed"]);
  assert.equal(c.changes[0].data.previousValue, "60");
  const d = w.ingestPatientFacts([{ ...base, value: "55", observedAt: "2026-10-22T08:00:00Z" }]);
  assert.equal(d.historical, 1);
  assert.equal(w.patientFacts("P1")["lab:egfr"].value, "42");

  const prov = w.provenance(c.changes[0].factId!)!;
  assert.equal(prov.source, "ehr");
  assert.equal(prov.observedAt, "2026-10-26T08:00:00.000Z");
  assert.equal(prov.current, true);
  assert.equal(prov.history!.length, 3);
});

test("verdicts: new, changed, dropped versus the previous run; replay is a no-op", () => {
  const { clock, advance } = fixedClock("2026-10-26T03:00:00Z");
  const w = new ClinicWorld({ clock });
  w.ingestTrialSnapshot([trial("NCT00000001"), trial("NCT00000002")], "ctgov", "2026-10-26T02:00:00Z");

  const r1 = w.recordVerdicts("run-1", [
    { patientId: "P1", nctId: "NCT00000001", status: "possible_unknowns", unknownCount: 2 },
    { patientId: "P1", nctId: "NCT00000002", status: "eligible_no_blockers", unknownCount: 0 },
    { patientId: "P2", nctId: "NCT00000001", status: "not_eligible", unknownCount: 0, blockingCriterion: "exc1" },
  ]);
  assert.deepEqual(r1.counts, { new: 2, changed: 0, dropped: 0, evaluated: 3 });
  assert.deepEqual(w.candidateTrials("P1").map((t) => t.attrs.nctId), ["NCT00000001", "NCT00000002"]);

  const again = w.recordVerdicts("run-1", []);
  assert.equal(again.alreadyRecorded, true);
  assert.equal(again.changes.length, 2);

  advance(24 * 3600 * 1000);
  const r2 = w.recordVerdicts("run-2", [
    { patientId: "P1", nctId: "NCT00000001", status: "eligible_no_blockers", unknownCount: 0 },
    { patientId: "P1", nctId: "NCT00000002", status: "not_eligible", unknownCount: 0, blockingCriterion: "inc3" },
    { patientId: "P2", nctId: "NCT00000001", status: "possible_unknowns", unknownCount: 1 },
  ]);
  assert.deepEqual(r2.counts, { new: 1, changed: 1, dropped: 1, evaluated: 3 });
  const kinds = r2.changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["match_changed", "match_dropped", "match_new"]);
  assert.deepEqual(w.candidateTrials("P1").map((t) => t.attrs.nctId), ["NCT00000001"]);

  advance(24 * 3600 * 1000);
  const r3 = w.recordVerdicts("run-3", [{ patientId: "P1", nctId: "NCT00000001", status: "eligible_no_blockers", unknownCount: 0 }]);
  assert.deepEqual(r3.counts, { new: 0, changed: 0, dropped: 1, evaluated: 1 });
  assert.equal(r3.changes[0].data.reason, "not_in_run");

  const since = w.changesSince("run-1");
  assert.equal(since.sinceKind, "run");
  assert.deepEqual(since.groups.map((g) => g.kind), ["match_new", "match_changed", "match_dropped"]);
  assert.equal(since.total, 4);
  assert.equal(w.changesInRun("run-2").total, 3);
});

test("changesSince by time, timeline, and replay from the jsonl log", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clinic-")), "data", "runtime", "world.jsonl");
  const { clock, advance } = fixedClock("2026-10-26T20:00:00Z");
  const w = ClinicWorld.open(file, { clock });
  w.ingestTrialSnapshot([trial("NCT00000001")], "ctgov", "2026-10-26T19:00:00Z");
  advance(6 * 3600 * 1000);
  w.ingestTrialSnapshot([trial("NCT00000001", "h2")], "ctgov", "2026-10-27T01:00:00Z");
  w.ingestPatientFacts([{ patientId: "P1", kind: "biomarker", key: "EGFR", value: "L858R", observedAt: "2026-10-25T00:00:00Z", source: "lab-feed" }]);
  w.recordVerdicts("night-1", [{ patientId: "P1", nctId: "NCT00000001", status: "possible_unknowns", unknownCount: 1 }]);

  const overnight = w.changesSince("2026-10-27T00:00:00Z");
  assert.deepEqual(overnight.groups.map((g) => g.kind), ["trial_amended", "fact_added", "match_new"]);
  for (const g of overnight.groups) for (const i of g.items) assert.ok(i.provenance.source && i.provenance.observedAt);

  const tl = w.timeline("NCT00000001", { changesOnly: true });
  assert.deepEqual(tl.map((e) => e.kind), ["trial_opened", "trial_amended", "match_new"]);

  const reloaded = ClinicWorld.open(file, { clock });
  assert.equal(reloaded.world.stateShapeCanonical(), w.world.stateShapeCanonical());
  assert.deepEqual(reloaded.changesSince("2026-10-27T00:00:00Z"), overnight);
  assert.equal(reloaded.recordVerdicts("night-1", []).alreadyRecorded, true);
  assert.ok(reloaded.world.verify());
});
