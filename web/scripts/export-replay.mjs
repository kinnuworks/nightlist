#!/usr/bin/env node
// Exports a running Nightlist API to static JSON for the hosted replay build.
//
//   node web/scripts/export-replay.mjs [--api http://localhost:8790] [--per-patient 2]
//   npm run build:static -w web
//
// Writes web/replay-data/replay/... which `build:static` copies into dist-static/replay/.
// Every patient, trial and memory file is exported. Match pairs are a subset (they are
// about 25 KB each): the top N per patient, every pair for patients with a case summary,
// new matches, and the first trial for each "one data item away" entry.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const API = opt("api", "http://localhost:8790").replace(/\/$/, "");
const PER_PATIENT = Number(opt("per-patient", "2"));
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "replay-data", "replay");

async function get(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
async function put(rel, data) {
  const f = join(OUT, rel);
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(data));
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

await rm(OUT, { recursive: true, force: true });
const status = await get("/api/status");
const summary = await get("/api/summary");
const worklist = await get("/api/worklist");
await put("status.json", status);
await put("summary.json", summary);
await put("worklist.json", worklist);
await put("trace.json", await get(`/api/trace?run=${encodeURIComponent(summary.runId)}`));
await put("usl.json", await get("/api/usl"));
console.log(`run ${summary.runId}: ${worklist.patients.length} patients`);

await pool(worklist.patients, 8, async (p) => {
  await put(`patient/${p.patientId}.json`, await get(`/api/patient/${p.patientId}`));
  await put(`memory/${p.patientId}.json`, await get(`/api/memory/${p.patientId}`));
});

const trials = new Set();
const pairs = new Set();
for (const p of worklist.patients) {
  p.matches.forEach((m, i) => {
    trials.add(m.nctId);
    if (i < PER_PATIENT || p.story || m.isNew) pairs.add(`${p.patientId}|${m.nctId}`);
  });
  for (const s of p.setAside) trials.add(s.nctId);
}
for (const a of worklist.oneItemAway) pairs.add(`${a.patientId}|${a.trials[0]}`);
for (const g of worklist.overnight?.groups ?? [])
  for (const it of g.items) {
    if (it.nctId) trials.add(it.nctId);
    if (it.patientId && it.nctId && g.kind !== "match_dropped") pairs.add(`${it.patientId}|${it.nctId}`);
  }

await pool([...trials], 8, async (nct) => {
  try {
    await put(`trial/${nct}.json`, await get(`/api/trial/${nct}`));
  } catch (e) {
    console.warn(`skip trial ${nct}: ${e.message}`);
  }
});
let n = 0;
await pool([...pairs], 8, async (pair) => {
  const [pid, nct] = pair.split("|");
  try {
    await put(`match/${pid}__${nct}.json`, await get(`/api/match/${pid}/${nct}`));
    n++;
  } catch (e) {
    console.warn(`skip match ${pair}: ${e.message}`);
  }
});
console.log(`exported ${trials.size} trials and ${n} patient and trial pairs to ${OUT}`);
