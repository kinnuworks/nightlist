import assert from "node:assert/strict";
import { test } from "node:test";
import { compileByRules, isScreeningItem } from "../src/compiler/rules.ts";
import { describe as readable, predSchema, type Pred } from "../src/dsl.ts";
import { verdictOf } from "../src/evaluator/screen.ts";
import { combine, dataItemFor, type Tri } from "../src/evaluator/sqlgen.ts";
import { splitCriteria } from "../src/trials.ts";
import { normalizeBaseUrl, extractJson } from "../src/nightshift.ts";

const rule = (text: string, kind: "inclusion" | "exclusion" = "inclusion") => compileByRules({ text, kind })?.pred;

test("splits inclusion and exclusion lists and folds sub-bullets into their parent", () => {
  const cs = splitCriteria({
    nctId: "NCT00000001",
    eligibility: "Inclusion Criteria:\n\n* Age 18 or older\n* Adequate organ function:\n  * ANC ≥ 1.5 × 10^9/L\n  * Platelets ≥ 100 × 10^9/L\n\nExclusion Criteria:\n\n* Active brain metastases",
  });
  assert.equal(cs.length, 3);
  assert.deepEqual(cs.map((c) => c.kind), ["inclusion", "inclusion", "exclusion"]);
  assert.match(cs[1].text, /ANC .*; Platelets/);
  assert.equal(cs[2].criterionId, "NCT00000001-E01");
});

test("compiles common criteria into the expected checks", () => {
  assert.deepEqual(rule("ECOG performance status of 0 or 1"), { k: "ecog", max: 1 });
  assert.deepEqual(rule("Eastern Cooperative Oncology Group (ECOG) performance status ≤ 2"), { k: "ecog", max: 2 });
  assert.deepEqual(rule("Age ≥ 18 years at the time of signing consent"), { k: "age", min: 18 });
  assert.deepEqual(rule("Histologically or cytologically documented non-squamous NSCLC"), { k: "histology", anyOf: ["adenocarcinoma", "large_cell", "nos"] });
  assert.deepEqual(rule("Documented EGFR mutation (exon 19 deletion or L858R)"), { k: "biomarker", gene: "EGFR", alterations: ["exon19del", "L858R"], status: "detected" });
  assert.deepEqual(rule("Tumor PD-L1 expression TPS ≥ 50%"), { k: "pdl1", minTps: 50 });
  assert.deepEqual(rule("Absolute neutrophil count ≥ 1,500/µL"), { k: "lab", analyte: "ANC", op: ">=", value: 1.5 });
  assert.deepEqual(rule("Untreated or symptomatic CNS metastases", "exclusion"), { k: "brain_mets", activeOnly: true });
  assert.deepEqual(rule("Received at least 1 and no more than 2 prior systemic lines of therapy for advanced NSCLC"), { k: "lines", min: 1, max: 2 });
});

test("does not guess when the sentence names something it cannot represent", () => {
  assert.equal(rule("Documented EGFR T790M mutation"), undefined);
  assert.equal(rule("Resolution of toxicities to Grade 1, except anemia Grade 2 or hemoglobin ≥ 8"), undefined);
  assert.equal(rule("Cohort B: histologically confirmed colorectal adenocarcinoma"), undefined);
});

test("KRAS G12D and G12C are kept distinct", () => {
  assert.deepEqual(rule("Local testing confirmed KRAS G12D mutation"), { k: "biomarker", gene: "KRAS", alterations: ["G12D"], status: "detected" });
  assert.deepEqual(rule("KRAS G12C mutation documented by an FDA-approved test")?.k, "biomarker");
});

test("screening-visit items are recognised", () => {
  assert.ok(isScreeningItem("Willing and able to provide written informed consent"));
  assert.ok(isScreeningItem("Women of childbearing potential must have a negative pregnancy test"));
  assert.ok(!isScreeningItem("ECOG 0-1"));
});

test("three-valued logic follows Kleene rules and exclusions invert", () => {
  const p: Pred = { k: "and", all: [{ k: "ecog", max: 1 }, { k: "or", any: [{ k: "condition", category: "hiv" }, { k: "condition", category: "hbv" }] }] };
  const vals: Record<string, Tri> = { ecog: "T", hiv: "F", hbv: "U" };
  const value = (l: any): Tri => vals[l.k === "condition" ? l.category : l.k];
  assert.equal(combine(p, value), "U");
  vals.hbv = "T";
  assert.equal(combine(p, value), "T");
  assert.equal(verdictOf("exclusion", "T"), "not_met");
  assert.equal(verdictOf("inclusion", "U"), "unknown");
});

test("every rule output validates against the predicate schema and reads back in English", () => {
  for (const text of ["ECOG 0-1", "Platelets ≥ 100,000/mm3", "No prior anti-PD-1 or anti-PD-L1 therapy for metastatic disease", "Known HIV or active hepatitis B or C infection"]) {
    const r = compileByRules({ text, kind: text.startsWith("Known") ? "exclusion" : "inclusion" });
    if (!r) continue;
    assert.ok(predSchema.safeParse(r.pred).success, text);
    assert.ok(readable(r.pred).length > 3);
  }
});

test("unknown biomarker results point to a standard-of-care NGS panel, PD-L1 needs tissue", () => {
  assert.equal(dataItemFor({ k: "biomarker", gene: "EGFR", status: "detected" }).id, "ngs_panel");
  assert.equal(dataItemFor({ k: "pdl1", minTps: 50 }).needsTissue, true);
});

test("Nightshift base URL and model JSON parsing are forgiving", () => {
  assert.equal(normalizeBaseUrl("192.168.1.20:8088/v1/chat/completions"), "http://192.168.1.20:8088/v1");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8088/"), "http://127.0.0.1:8088/v1");
  assert.deepEqual(extractJson('Here you go:\n```json\n{"pred": null, "category": "review"}\n```'), { pred: null, category: "review" });
});
