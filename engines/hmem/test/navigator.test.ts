import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HMEM, NavigatorMemory } from "../src/index.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

function setup() {
  let now = T0;
  const clock = () => now;
  const nav = new NavigatorMemory({ clock });
  return { nav, advance: (ms: number) => (now += ms), clock };
}

test("remember tags records by patient, trial and criterion and writes a create entry", () => {
  const { nav } = setup();
  const r = nav.remember({
    patientId: "p-17",
    trialId: "nct05012345",
    criterionId: "NCT05012345:inc-2",
    kind: "decision",
    text: "Marked eligible for NCT05012345 after confirming HbA1c of 7.9.",
    actor: "rn:ortiz",
  });
  assert.ok(r.tags.includes("patient:p-17"));
  assert.ok(r.tags.includes("trial:NCT05012345"));
  assert.ok(r.tags.includes("criterion:NCT05012345:inc-2"));
  assert.equal(r.kind, "decision");
  assert.equal(r.actor, "rn:ortiz");
  const h = nav.history(r.id);
  assert.equal(h[0].action, "create");
  assert.equal(h[0].actor, "rn:ortiz");
  assert.throws(() => nav.remember({ kind: "fact", text: "", actor: "x" }));
  assert.throws(() => nav.remember({ kind: "fact", text: "no actor here", actor: "" }));
  assert.throws(() => nav.remember({ kind: "guess" as never, text: "bad kind", actor: "x" }));
});

test("correctionFor returns the latest correction and supersedes older ones", () => {
  const { nav, advance } = setup();
  const crit = "NCT04000001:exc-5";
  assert.equal(nav.correctionFor(crit), undefined);
  const first = nav.remember({ criterionId: crit, kind: "correction", text: "Exclusion 5 applies to any prior anti-PD-1 therapy.", actor: "md:lee" });
  advance(DAY);
  const second = nav.remember({ criterionId: crit, kind: "correction", text: "Exclusion 5 applies only to anti-PD-1 therapy within the last 6 months.", actor: "md:shah" });
  const current = nav.correctionFor(crit);
  assert.equal(current?.id, second.id);
  assert.equal(current?.supersedes, first.id);
  assert.equal(nav.get(first.id)?.supersededBy, second.id);
  const firstHistory = nav.history(first.id);
  assert.equal(firstHistory[0].action, "create");
  const sup = firstHistory.find((e) => e.next?.supersededBy === second.id);
  assert.ok(sup, "supersession must appear in the audit trail");
  assert.equal(sup.action, "update");
  assert.equal(sup.actor, "md:shah");
});

test("recall ranks relevant memories, explains scores and keeps patients apart", () => {
  const { nav } = setup();
  nav.remember({ patientId: "p1", kind: "preference", text: "Prefers trial sites within 30 miles of home, no overnight stays.", actor: "rn:kim" });
  nav.remember({ patientId: "p2", kind: "preference", text: "Prefers trial sites near home with weekday visits only.", actor: "rn:kim" });
  nav.remember({ criterionId: "NCT01234567:exc-3", trialId: "NCT01234567", kind: "correction", text: "Treated brain metastases stable for 4 weeks are allowed under exclusion 3.", actor: "md:lee" });

  const hits = nav.recall({ patientId: "p1", trialId: "NCT01234567", query: "brain metastases exclusion", threshold: 0 });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].kind, "correction");
  assert.ok(hits[0].score > 0);
  assert.equal(hits[0].why.layer, "long_term");
  assert.equal(hits[0].why.confidence, 0.95);
  assert.ok(hits[0].why.recency > 0.9);
  assert.ok(hits.every((h) => h.patientId !== "p2"), "another patient's memory leaked into recall");
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);

  const prefs = nav.recall({ patientId: "p1", query: "preferred trial site distance from home", threshold: 0 });
  assert.equal(prefs[0].patientId, "p1");
  assert.equal(prefs[0].kind, "preference");
});

test("recall drops superseded corrections and records flagged wrong", () => {
  const { nav, advance } = setup();
  const crit = "NCT07000007:inc-1";
  const old = nav.remember({ criterionId: crit, kind: "correction", text: "Inclusion 1 requires ECOG 0 to 1.", actor: "md:lee" });
  advance(1000);
  const fresh = nav.remember({ criterionId: crit, kind: "correction", text: "Inclusion 1 requires ECOG 0 to 2.", actor: "md:lee" });
  const ids = nav.recall({ query: "ECOG inclusion requirement", threshold: 0 }).map((h) => h.id);
  assert.ok(ids.includes(fresh.id));
  assert.ok(!ids.includes(old.id));
  nav.feedback(fresh.id, "wrong", "md:lee");
  assert.equal(nav.get(fresh.id)?.confidence, 0.75);
  assert.ok(!nav.recall({ query: "ECOG inclusion requirement", threshold: 0 }).some((h) => h.id === fresh.id));
  assert.equal(nav.history(fresh.id).at(-1)?.action, "feedback");
});

test("nightly consolidates, archives stale notes, keeps preferences and only proposes dreams", () => {
  const { nav, advance } = setup();
  const pref = nav.remember({ patientId: "p9", kind: "preference", text: "Patient wants phone calls, not email, for trial updates.", actor: "rn:kim" });
  const pref2 = nav.remember({ patientId: "p9", kind: "preference", text: "Patient wants morning appointments for trial visits.", actor: "rn:kim" });
  const note = nav.remember({ kind: "fact", text: "Parking validation at the north clinic changed last spring.", actor: "rn:kim" });
  advance(40 * DAY);
  const before = nav.hmem.store.all().length;
  const report = nav.nightly();
  assert.ok(report.sleep.backupId);
  assert.ok(report.sleep.archived.some((a) => a.id === note.id), "stale unreferenced fact should archive");
  assert.ok(report.sleep.consolidated.some((c) => c.id === pref.id));
  assert.equal(nav.get(pref.id)?.layer, "long_term");
  assert.equal(nav.get(note.id)?.archived, true);
  assert.ok(report.dreaming.proposals.length > 0);
  assert.equal(nav.hmem.store.all().length, before - 1, "dreaming must not add records before approval");
  assert.ok(nav.history(note.id).some((e) => e.action === "sleep_archive"));
  assert.ok(nav.history(pref2.id).some((e) => e.action === "sleep_consolidate"));
  const proposal = report.dreaming.proposals[0];
  const created = nav.approveProposal(proposal.id, "md:lee");
  if (created) {
    assert.equal(created.layer, "long_term");
    assert.ok(created.derivedFrom.length > 0);
  }
  JSON.stringify(report);
});

test("state survives a save and reload through the JSON file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-test-"));
  const file = path.join(dir, "runtime", "hmem.json");
  try {
    let now = T0;
    const nav = NavigatorMemory.open(file, { clock: () => now });
    const crit = "NCT02222222:exc-1";
    const c = nav.remember({ criterionId: crit, kind: "correction", text: "Exclusion 1 does not apply to hepatitis B with undetectable viral load.", actor: "md:lee" });
    assert.ok(fs.existsSync(file));
    now += DAY;
    const reopened = NavigatorMemory.open(file, { clock: () => now });
    assert.equal(reopened.correctionFor(crit)?.id, c.id);
    assert.deepEqual(reopened.history(c.id).map((e) => e.action), ["create"]);
    const hits = reopened.recall({ query: "hepatitis B exclusion", threshold: 0 });
    assert.equal(hits[0].id, c.id);

    const h = HMEM.fromJSON(JSON.parse(fs.readFileSync(file, "utf-8")), { clock: () => now });
    assert.equal(h.store.all().length, 1);
    assert.equal(h.store.get(c.id)?.embedding.length, h.store.all()[0].embedding.length);
    assert.ok(h.ledger.size >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
