// Scores the compiler against the blind gold labels by behaviour, not by string
// match: both predicates are evaluated for every patient in the clinic, and a compiled
// criterion is correct only if it gives the same met / not met / unknown answer as the
// gold label for every patient. Writes data/eval/report.json and docs/EVALUATION-RESULTS.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT, RUNTIME } from "../src/config.ts";
import { DuckLayer } from "../src/datalayer.ts";
import { describe, predSchema, type Criterion, type Pred } from "../src/dsl.ts";
import { verdictOf } from "../src/evaluator/screen.ts";
import { combine, leafKey, leafSql, leaves, type Tri } from "../src/evaluator/sqlgen.ts";

type Gold = { category: Criterion["category"]; pred: Pred | null; omitted?: string[]; confidence?: string };
const SET = (process.argv.find((a) => a.startsWith("--set=")) ?? (process.argv.includes("--holdout") ? "--set=holdout" : "--set=dev")).split("=")[1];
const HOLD = SET !== "dev";
const sample: { sampleId: string; criterionId: string; kind: Criterion["kind"]; text: string }[] = JSON.parse(readFileSync(join(DATA, "eval", HOLD ? `${SET}-sample.json` : "sample.json"), "utf8"));
const gold: Record<string, Gold> = JSON.parse(readFileSync(join(DATA, "eval", HOLD ? `${SET}-gold.json` : "gold.json"), "utf8"));
const latest = JSON.parse(readFileSync(join(RUNTIME, "latest.json"), "utf8"));
const compiled = new Map<string, Criterion>(JSON.parse(readFileSync(join(latest.dir, "criteria.json"), "utf8")).map((c: Criterion) => [c.criterionId, c]));
const layer = await DuckLayer.open("2026-10-26");
const t = (n: string) => layer.table(n as any);

async function vector(p: Pred, kind: Criterion["kind"]): Promise<Map<string, string>> {
  const ls = leaves(p);
  const keys = [...new Set(ls.map(leafKey))];
  const byKey = new Map(ls.map((l) => [leafKey(l), l]));
  const rows = await layer.query(`SELECT p.patient_id, ${keys.map((k, i) => `${leafSql(byKey.get(k)!, t, "2026-09-26")} AS l${i}`).join(", ")} FROM ${t("patient")} p`);
  return new Map(rows.map((r) => [String(r.patient_id), verdictOf(kind, combine(p, (l) => (r[`l${keys.indexOf(leafKey(l))}`] as Tri) ?? "U"))]));
}

const rows: any[] = [];
for (const s of sample) {
  const g = gold[s.sampleId];
  const c = compiled.get(s.criterionId);
  if (!g || !c) continue;
  const ours = c.category;
  const row: any = { sampleId: s.sampleId, kind: s.kind, text: s.text, goldCategory: g.category, ourCategory: ours, method: c.method, gold: g.pred ? describe(g.pred) : null, ours: c.pred ? describe(c.pred) : null };
  if (ours === "check" && c.pred && g.category === "check" && g.pred && predSchema.safeParse(g.pred).success) {
    const [a, b] = await Promise.all([vector(c.pred, s.kind), vector(g.pred, s.kind)]);
    let same = 0, flips = 0, unknownOnly = 0;
    for (const [pid, va] of a) {
      const vb = b.get(pid);
      if (va === vb) same++;
      else if (va === "unknown" || vb === "unknown") unknownOnly++;
      else flips++;
    }
    row.patients = a.size;
    row.flips = flips;
    row.unknownDiffs = unknownOnly;
    row.result = flips ? "wrong" : unknownOnly ? "partial" : "exact";
  } else if (ours === "check" && g.category !== "check") {
    row.result = "overreach"; // we compiled something the gold says needs review or screening
  } else if (ours !== "check" && g.category === "check") {
    row.result = "missed";
  } else {
    row.result = ours === g.category ? "agree_not_compiled" : "category_mismatch";
  }
  rows.push(row);
}

const by = (r: string) => rows.filter((x) => x.result === r).length;
const compiledN = rows.filter((x) => x.ourCategory === "check").length;
const goldCheck = rows.filter((x) => x.goldCategory === "check").length;
const flipsTotal = rows.reduce((s, x) => s + (x.flips ?? 0), 0);
const metrics = {
  sample: rows.length,
  compiled: compiledN,
  exact: by("exact"),
  partial: by("partial"),
  wrong: by("wrong"),
  overreach: by("overreach"),
  missed: by("missed"),
  precisionExact: +(by("exact") / Math.max(1, compiledN)).toFixed(3),
  precisionNoFlip: +((by("exact") + by("partial")) / Math.max(1, compiledN)).toFixed(3),
  coverage: +((by("exact") + by("partial") + by("wrong")) / Math.max(1, goldCheck)).toFixed(3),
  verdictFlips: flipsTotal,
  patientCriterionPairs: rows.reduce((s, x) => s + (x.patients ?? 0), 0),
};
writeFileSync(join(DATA, "eval", HOLD ? `${SET}-report.json` : "report.json"), JSON.stringify({ metrics, rows }, null, 1));
const md = `# Compiler evaluation

Sample: ${metrics.sample} real eligibility criteria drawn at random from the screened trials (half from criteria the rules compiled, half from the rest). Gold labels were written blind, without seeing compiler output.

A compiled criterion counts as **exact** when it gives the same verdict as the gold label for all ${rows[0]?.patients ?? 240} patients, **partial** when the only differences are unknown vs known, and **wrong** when at least one patient's met / not met verdict flips.

| Metric | Value |
|---|---|
| Compiled to a check | ${metrics.compiled} |
| Exact | ${metrics.exact} |
| Partial (unknown differences only) | ${metrics.partial} |
| Wrong (a verdict flips) | ${metrics.wrong} |
| Compiled but gold says review or screening | ${metrics.overreach} |
| Gold says checkable but left for review | ${metrics.missed} |
| Precision, exact | ${metrics.precisionExact} |
| Precision, no verdict flip | ${metrics.precisionNoFlip} |
| Coverage of checkable criteria | ${metrics.coverage} |
| Patient-level verdict flips | ${metrics.verdictFlips} of ${metrics.patientCriterionPairs} |

## Every wrong or overreaching criterion

${rows.filter((r) => r.result === "wrong" || r.result === "overreach").map((r) => `- ${r.sampleId} (${r.kind}, ${r.method}): "${r.text.slice(0, 160)}"\n  - ours: ${r.ours}\n  - gold: ${r.gold ?? r.goldCategory}${r.flips ? `\n  - flips ${r.flips} patients` : ""}`).join("\n")}
`;
writeFileSync(join(ROOT, "docs", HOLD ? `EVALUATION-${SET.toUpperCase()}.md` : "EVALUATION-DEV.md"), md);
console.log(JSON.stringify(metrics, null, 1));
await layer.close();
