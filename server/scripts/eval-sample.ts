// Draws the evaluation sample: a stratified random set of real criteria from the
// screened trials, written without any compiler output so labelers stay blind.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, RUNTIME } from "../src/config.ts";
import type { Criterion } from "../src/dsl.ts";

const latest = JSON.parse(readFileSync(join(RUNTIME, "latest.json"), "utf8"));
const criteria: Criterion[] = JSON.parse(readFileSync(join(latest.dir, "criteria.json"), "utf8")).filter((c: Criterion) => c.method !== "structured");

const set = (process.argv.find((a) => a.startsWith("--set=")) ?? (process.argv.includes("--holdout") ? "--set=holdout" : "--set=dev")).split("=")[1];
const heldOut = set !== "dev";
let seed = set === "dev" ? 7 : set === "holdout" ? 20261027 : 777001;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffle = <T>(xs: T[]) => xs.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

// Half drawn from criteria the rules compiled, half from the rest, so the sample
// measures both precision of what is compiled and what is being missed.
const compiled = shuffle(criteria.filter((c) => c.method === "rule"));
const others = shuffle(criteria.filter((c) => c.method !== "rule"));
const used = new Set<string>();
if (heldOut) for (const f of ["sample.json", "holdout-sample.json"].filter((f) => f !== `${set}-sample.json`)) {
  try { for (const x of JSON.parse(readFileSync(join(DATA, "eval", f), "utf8"))) used.add(x.criterionId); } catch {}
}
const dev = used;
const notDev = (c: Criterion) => !dev.has(c.criterionId);
const sample = shuffle([...compiled.filter(notDev).slice(0, 80), ...others.filter(notDev).slice(0, 80)]).map((c, i) => ({ sampleId: `S${String(i + 1).padStart(3, "0")}`, criterionId: c.criterionId, nctId: c.nctId, kind: c.kind, text: c.text }));
mkdirSync(join(DATA, "eval"), { recursive: true });
const file = set === "dev" ? "sample.json" : `${set}-sample.json`;
writeFileSync(join(DATA, "eval", file), JSON.stringify(sample, null, 1));
console.log(`wrote ${sample.length} criteria to data/eval/${file}`);
