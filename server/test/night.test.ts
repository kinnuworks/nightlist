// End-to-end: a full overnight run in sample mode, checked against what the clinic's
// records say about the demo patients.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.SAMPLE_MODE = "true";
process.env.NIGHTLIST_RUNTIME = mkdtempSync(join(tmpdir(), "nightlist-test-"));
process.env.NIGHTLIST_LOGS = join(process.env.NIGHTLIST_RUNTIME, "logs");
process.env.NIGHTLIST_COMPILED = join(process.env.NIGHTLIST_RUNTIME, "compiled");
process.env.NIGHTSHIFT_URL = process.env.METERLESS_BASE_URL = "http://127.0.0.1:1";
const { runNight } = await import("../src/night.ts");

test("overnight run screens every patient and the evidence holds up", { timeout: 300000 }, async () => {
  const res = await runNight({ quiet: true, useModel: false });
  const s = res.summary;
  assert.equal(s.patients, 240);
  assert.ok(s.trialsScreened > 50);
  assert.equal(s.pairs, s.patients * s.trialsScreened);

  const dq = Object.fromEntries(s.dq.map((d: any) => [d.rule, d.invalid]));
  assert.equal(dq.lab_row_resolves_to_patient, 6, "six lab rows filed under a mistyped MRN");
  assert.ok(dq.lab_has_unit_and_value >= 8, "lab rows exported without a unit");

  const w = JSON.parse(readFileSync(join(res.outDir, "worklist.json"), "utf8"));
  const p = (id: string) => w.patients.find((x: any) => x.patientId === id);
  const matches = JSON.parse(readFileSync(join(res.outDir, "matches.json"), "utf8"));
  // Is at least one trial blocked for this patient by a check of this kind that came out
  // the way the patient's records say it should?
  const blockedBy = (id: string, test: (leaf: any, value: string) => boolean) =>
    matches.some((m: any) => m.patientId === id && m.status === "not_eligible" && m.blocking.some((b: any) => b.leaves.some((l: any) => test(l.leaf, l.value))));

  assert.ok(blockedBy("P10001", (l, v) => l.k === "biomarker" && l.gene === "EGFR" && l.status === "detected" && v === "T"), "EGFR-positive patient is excluded by trials that exclude EGFR mutations");
  assert.ok(blockedBy("P10005", (l, v) => l.k === "brain_mets" && v === "T"), "active brain metastases block trials");
  assert.ok(blockedBy("P10006", (l, v) => l.k === "lab" && l.analyte === "ANC" && v === "F"), "low neutrophil count blocks trials");
  assert.ok(blockedBy("P10007", (l, v) => l.k === "condition" && l.category === "hbv" && v === "T"), "hepatitis B blocks trials");

  const kras = p("P10002").matches[0];
  assert.doesNotMatch(kras.title, /G12D/, "a KRAS G12C patient is not offered a G12D trial first");

  const away = w.oneItemAway.find((o: any) => o.patientId === "P10003");
  assert.ok(away && away.item === "ngs_panel" && away.trials.length >= 10, "untested patient is one NGS panel away from many trials");

  const trace = readFileSync(s.traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const agents = new Set(trace.map((e: any) => e.agent));
  for (const a of ["Watcher", "Compiler", "Steward", "Screener", "Verifier", "Navigator"]) assert.ok(agents.has(a), `trace includes ${a}`);
});
