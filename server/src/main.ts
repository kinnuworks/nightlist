// HTTP API for the morning worklist. Every screen in the UI is backed by one of these
// routes, so a judge can drive the whole product without the UI (see README).
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { NavigatorMemory } from "@nightlist/hmem";
import { config, LOGS, ROOT, RUNTIME } from "./config.ts";
import { openDataLayer, SAMPLE_SOURCES, type DataLayer } from "./datalayer.ts";
import { describe, type Criterion, type Leaf } from "./dsl.ts";
import { evidenceSql, leafSql } from "./evaluator/sqlgen.ts";
import { Nightshift } from "./nightshift.ts";
import { runNight } from "./night.ts";
import { activation, DQ_RULES, duckdb, USL_DDL, USL_TABLES } from "./usl/schema.ts";

const app = new Hono();
let layer: DataLayer;
let latest: { runId: string; dir: string };
let cache: { worklist: any; matches: any[]; criteria: Criterion[]; trials: any[]; summary: any } | null = null;
const memory = NavigatorMemory.open(join(RUNTIME, "hmem.json"));
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

async function load() {
  if (!existsSync(join(RUNTIME, "latest.json"))) {
    console.log("No run found; running the first overnight screen (sample mode)...");
    await runNight({ useModel: true, quiet: true });
  }
  latest = json(join(RUNTIME, "latest.json"));
  cache = {
    worklist: json(join(latest.dir, "worklist.json")),
    matches: json(join(latest.dir, "matches.json")),
    criteria: json(join(latest.dir, "criteria.json")),
    trials: json(join(latest.dir, "trials.json")),
    summary: json(join(latest.dir, "summary.json")),
  };
  if (layer) await layer.close();
  layer = await openDataLayer(cache.summary.asOf);
}

const t = (n: string) => layer.table(n as any);
const labCutoff = () => new Date(new Date(cache!.summary.asOf).getTime() - 30 * 86400000).toISOString().slice(0, 10);

app.get("/api/status", async (c) => {
  const ns = await new Nightshift().status();
  const conf = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8").trim().split("\n").filter((l) => /checks passed|passed|PASS|gates/i.test(l)).slice(-1)[0] ?? "" : "not run");
  return c.json({
    runId: latest.runId, sampleMode: config.sampleMode, dataLayer: layer.kind, nightshift: ns,
    engines: {
      worldModel: conf("engines/world-model/CONFORMANCE.txt"),
      hmem: conf("engines/hmem/CONFORMANCE.txt"),
      scoutIntent: conf("engines/scout-intent/EVAL.txt"),
    },
    clinic: config.clinic,
  });
});

app.get("/api/summary", (c) => c.json(cache!.summary));
app.get("/api/worklist", (c) => c.json(cache!.worklist));
app.get("/api/runs", (c) => c.json(readdirSync(join(RUNTIME, "runs")).sort().reverse()));
app.get("/api/trace", (c) => {
  const run = c.req.query("run") ?? latest.runId;
  const f = join(LOGS, `${run}.jsonl`);
  if (!existsSync(f)) return c.json([], 404);
  return c.json(readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
});

app.get("/api/patient/:id", async (c) => {
  const id = c.req.param("id").replace(/[^A-Za-z0-9]/g, "");
  const q = (table: string, extra = "") => layer.query(`SELECT * FROM ${t(table)} WHERE patient_id = '${id}' ${extra}`);
  const [patient] = await q("patient");
  if (!patient) return c.json({ error: "not found" }, 404);
  return c.json({
    patient,
    diagnosis: await q("diagnosis"),
    biomarkers: await q("biomarker", "ORDER BY gene"),
    labs: await q("lab", "ORDER BY collected_date DESC"),
    therapy: await q("therapy", "ORDER BY start_date"),
    conditions: await q("condition"),
    metastases: await q("metastasis"),
    worklist: cache!.worklist.patients.find((p: any) => p.patientId === id),
    memory: memory.list({ patientId: id }),
  });
});

app.get("/api/trial/:nct", (c) => {
  const nct = c.req.param("nct");
  const trial = cache!.trials.find((x) => x.nctId === nct);
  if (!trial) return c.json({ error: "not found" }, 404);
  const criteria = cache!.criteria.filter((x) => x.nctId === nct).map((x) => ({ ...x, readable: x.pred ? describe(x.pred) : undefined }));
  return c.json({ trial, criteria });
});

// One patient against one trial: every criterion with its verdict, the SQL that decided
// it and the source rows behind it.
app.get("/api/match/:pid/:nct", async (c) => {
  const pid = c.req.param("pid").replace(/[^A-Za-z0-9]/g, "");
  const nct = c.req.param("nct");
  const m = cache!.matches.find((x) => x.patientId === pid && x.nctId === nct);
  if (!m) return c.json({ error: "not found" }, 404);
  const criteria = cache!.criteria.filter((x) => x.nctId === nct);
  const byId = new Map(criteria.map((x) => [x.criterionId, x]));
  const results = await Promise.all((m.results ?? m.blocking).map(async (r: any) => {
    const crit = byId.get(r.criterionId)!;
    const leaves = await Promise.all(r.leaves.map(async (l: { leaf: Leaf; value: string }) => {
      const ev = evidenceSql(l.leaf, t, pid);
      return { ...l, readable: describe(l.leaf), sql: leafSql(l.leaf, t, labCutoff()), evidenceSql: ev, evidence: await layer.query(ev) };
    }));
    return { ...r, text: crit?.text, check: crit?.check, readable: crit?.pred ? describe(crit.pred) : undefined, leaves };
  }));
  const notChecked = criteria.filter((x) => x.category !== "check").map((x) => ({ criterionId: x.criterionId, kind: x.kind, category: x.category, text: x.text, caveat: x.caveat }));
  return c.json({ ...m, results, notChecked, trial: cache!.trials.find((x) => x.nctId === nct), memory: memory.recall({ patientId: pid, trialId: nct, query: "trial preferences decisions travel" }) });
});

app.get("/api/usl", async (c) => {
  const counts: Record<string, number> = {};
  for (const tb of USL_TABLES) counts[tb] = Number((await layer.query(`SELECT COUNT(*) AS n FROM ${t(tb)}`))[0].n);
  return c.json({ ddl: USL_DDL, activation: activation(SAMPLE_SOURCES, duckdb, cache!.summary.asOf, config.clinic), counts, dq: cache!.summary.dq, rules: DQ_RULES });
});

app.post("/api/memory", async (c) => {
  const body = await c.req.json();
  if (!body.text || !body.kind) return c.json({ error: "text and kind are required" }, 400);
  const rec = memory.remember({ patientId: body.patientId, trialId: body.trialId, criterionId: body.criterionId, kind: body.kind, text: String(body.text).slice(0, 500), actor: body.actor ?? "coordinator" });
  return c.json(rec);
});
app.get("/api/memory/:pid", (c) => {
  const pid = c.req.param("pid");
  return c.json(memory.list({ patientId: pid, includeSuperseded: true }).map((r) => ({ ...r, history: memory.history(r.id) })));
});

// Re-run the full overnight screen now (sample mode takes seconds).
app.post("/api/run", async (c) => {
  const res = await runNight({ useModel: true, quiet: true });
  await load();
  return c.json(res.summary);
});

const webDist = join(ROOT, "web", "dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: relative(process.cwd(), webDist) }));
  app.get("*", (c) => c.html(readFileSync(join(webDist, "index.html"), "utf8")));
}

await load();
serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`Nightlist on http://localhost:${i.port}  (data layer: ${layer.kind}, run ${latest.runId})`));
