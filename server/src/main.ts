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

const AGENTS = [
  { name: "Watcher", role: "Reads the ClinicalTrials.gov snapshot and records what opened, closed or changed since the last night" },
  { name: "Guard", role: "Screens trial text for instruction-like content and signs a contract that allows only compiling that criterion (Scout Intent)" },
  { name: "Compiler", role: "Turns each eligibility sentence into a typed check, by rule first and by model through Nightshift when rules cannot" },
  { name: "Checker", role: "Restates each compiled check in plain words and sends disagreements to human review" },
  { name: "Steward", role: "Runs the data-quality rules and keeps orphan or unit-less lab rows out of screening" },
  { name: "Screener", role: "Runs every compiled check as SQL against the semantic layer: met, not met or unknown" },
  { name: "Verifier", role: "Re-reads the source rows behind each surviving match and challenges conflicts across reports" },
  { name: "Navigator", role: "Applies coordinator decisions from memory (H-MEM) and writes the morning worklist" },
];

// One call for judges and scripts: re-runs the night (or reads the latest run), and returns
// the headline plus, when a patient is named, that patient's worklist entry.
app.post("/run", async (c) => {
  const t0 = Date.now();
  let body: any = {};
  try {
    const raw = await c.req.text();
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return c.json({ status: "error", error: { type: "BadRequest", message: "Body must be JSON", recoverable: true } }, 400);
  }
  const runIdIn = body.run_id ?? `run-${Date.now()}`;
  try {
    if (body.options?.sample_mode === false && config.sampleMode)
      return c.json({ run_id: runIdIn, status: "error", error: { type: "ConfigError", message: "Live mode needs SAMPLE_MODE=false and Zetaris settings in .env; this server is in sample mode", recoverable: true } }, 400);
    if (body.options?.rerun !== false) {
      await runNight({ useModel: true, quiet: true });
      await load();
    }
    const w = cache!.worklist;
    const output: any = {
      as_of: w.asOf,
      data_layer: layer.kind,
      headline: w.headline,
      overnight: w.overnight.groups.map((g: any) => ({ kind: g.kind, label: g.label, count: g.count })),
      worklist_top: w.patients.filter((p: any) => p.matches.length).slice(0, 5).map((p: any) => ({ patient_id: p.patientId, name: p.name, story: p.story, counts: p.counts, top_trial: p.matches[0]?.nctId, top_status: p.matches[0]?.status })),
    };
    const pid = body.input?.patient_id ? String(body.input.patient_id).replace(/[^A-Za-z0-9]/g, "") : "";
    if (pid) {
      const p = w.patients.find((x: any) => x.patientId === pid);
      if (!p) return c.json({ run_id: runIdIn, status: "error", error: { type: "NotFound", message: `No patient ${pid} in this run`, recoverable: true } }, 404);
      output.patient = {
        patient_id: p.patientId, name: p.name, story: p.story, miles_to_clinic: Math.round(p.milesToClinic), counts: p.counts,
        top_matches: p.matches.slice(0, 5).map((m: any) => ({ nct_id: m.nctId, title: m.title, status: m.status, nearest_site_miles: m.nearestMiles, new_tonight: m.isNew, open_items: m.unknowns, key_review: m.keyReview.map((k: any) => k.text), verified: m.verified })),
        review_queue: p.reviewQueue.length,
        top_blockers: p.topBlockers,
        set_aside: { count: p.setAside.length, example: p.setAside[0]?.notes?.[0] },
        one_item_away: w.oneItemAway.filter((x: any) => x.patientId === pid),
        overnight: w.overnight.groups.flatMap((g: any) => g.items.filter((i: any) => JSON.stringify(i).includes(pid)).map((i: any) => i.summary)),
        memory: memory.list({ patientId: pid }).map((r: any) => ({ kind: r.kind, text: r.text, actor: r.actor })),
      };
    }
    return c.json({
      run_id: runIdIn, status: "success", output, agents: AGENTS,
      trace_id: latest.runId, log_file: `logs/${latest.runId}.jsonl`,
      execution_time_seconds: Math.round((Date.now() - t0) / 100) / 10,
    });
  } catch (err) {
    return c.json({ run_id: runIdIn, status: "error", error: { type: (err as Error).name || "Error", message: String((err as Error).message ?? err).slice(0, 300), recoverable: true } }, 500);
  }
});

const webDist = join(ROOT, "web", "dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: relative(process.cwd(), webDist) }));
  app.get("*", (c) => c.html(readFileSync(join(webDist, "index.html"), "utf8")));
}

await load();
serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (i) => console.log(`Nightlist on http://localhost:${i.port}  (data layer: ${layer.kind}, run ${latest.runId})`));
