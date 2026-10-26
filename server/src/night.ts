// One overnight run. Agents and their order:
//   Watcher   pulls the trial snapshot and records what opened, changed or closed
//   Steward   opens the semantic layer and runs its data-quality rules
//   Guard / Compiler / Checker   compile eligibility text into checks (compiler/pipeline.ts)
//   Screener  evaluates every check for every patient inside the data layer
//   Verifier  re-reads the source rows behind every clean match
//   Navigator applies remembered coordinator decisions (H-MEM) and writes the worklist
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NavigatorMemory } from "@nightlist/hmem";
import { ClinicWorld } from "@nightlist/world-model/clinic";
import { compileTrials, nearbyRecruiting, writeCompiledTables } from "./compiler/pipeline.ts";
import { config, RUNTIME } from "./config.ts";
import { openDataLayer, type DataLayer, type Row } from "./datalayer.ts";
import { describe, type Criterion } from "./dsl.ts";
import { decidingLeaf, screen, verify, type Match } from "./evaluator/screen.ts";
import { Trace } from "./log.ts";
import { DQ_RULES } from "./usl/schema.ts";
import { loadSnapshot, type Trial } from "./trials.ts";

export interface NightOptions { asOf?: string; useModel?: boolean; snapshotFile?: string; quiet?: boolean; trialLimit?: number }

export function runId(d = new Date()) {
  return `night-${d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}`;
}

export async function runNight(opts: NightOptions = {}) {
  const id = runId();
  const trace = new Trace(id, { quiet: opts.quiet });
  const asOf = opts.asOf ?? "2026-10-26";
  const outDir = join(RUNTIME, "runs", id);
  mkdirSync(outDir, { recursive: true });
  trace.emit({ agent: "Watcher", action: "start_run", status: "info", summary: `as of ${asOf}; data layer: ${config.sampleMode ? "sample (DuckDB)" : "Zetaris"}` });

  // Watcher
  const snap = loadSnapshot(opts.snapshotFile);
  let trials: Trial[] = nearbyRecruiting(snap.trials);
  if (opts.trialLimit) trials = trials.slice(0, opts.trialLimit);
  const world = ClinicWorld.open(join(RUNTIME, "world.jsonl"));
  const tChanges = world.ingestTrialSnapshot(
    trials.map((t) => ({ nctId: t.nctId, title: t.title, lastUpdate: t.lastUpdate, criteriaHash: t.criteriaHash, sites: t.sites.map((s) => ({ id: s.siteId, name: s.facility, lat: s.lat, lon: s.lon })) })),
    "clinicaltrials.gov/api/v2",
    snap.fetchedAt,
  );
  trace.emit({ agent: "Watcher", action: "diff_trials", status: "ok", target: "Compiler", summary: `${snap.trials.length} recruiting NSCLC trials in snapshot, ${trials.length} within ${config.clinic.maxMiles} miles; opened ${tChanges.opened}, amended ${tChanges.amended}, closed ${tChanges.closed}` });

  // Guard / Compiler / Checker
  const { criteria, counts } = await compileTrials(trials, trace, { useModel: opts.useModel ?? true });
  writeCompiledTables(trials, criteria);

  // Steward
  const layer = await openDataLayer(asOf);
  const dq = await steward(layer, trace);

  // Screener and Verifier
  const matches = await screen(layer, trials, criteria, asOf, trace);
  await verify(layer, matches, trace);

  // Navigator memory
  const memory = NavigatorMemory.open(join(RUNTIME, "hmem.json"));
  const patients = await layer.query(`SELECT patient_id, given_name, family_name, sex, age_years, zip, miles_to_clinic, ecog, demo_story FROM ${layer.table("patient")}`);
  const applied = applyMemory(memory, matches, trials, trace);
  const memoryReport = memory.nightly({ actor: "nightlist" });
  trace.emit({ agent: "Navigator", action: "memory_sleep_cycle", status: "ok", summary: `H-MEM nightly: ${memoryReport.totals.active} active memories, ${memoryReport.dreaming.proposals.length} consolidation proposals pending`, data: { totals: memoryReport.totals } });

  // World model: patient facts and verdicts, then what changed overnight
  const facts = await patientFacts(layer);
  world.ingestPatientFacts(facts);
  const vRes = world.recordVerdicts(id, matches.map((m) => ({ patientId: m.patientId, nctId: m.nctId, status: m.status, unknownCount: m.unknown, blockingCriterion: m.blocking[0]?.criterionId })));
  // Everything recorded since the previous run: trials that opened or changed, new lab
  // results, and match changes.
  const prev = world.runs().map((r: any) => (typeof r === "string" ? r : r.runId)).filter((r: string) => r !== id).slice(-1)[0];
  const overnight = prev ? world.changesSince(prev) : world.changesInRun(id);
  trace.emit({ agent: "Navigator", action: "record_verdicts", status: "ok", summary: `World Model: ${vRes.counts.new} new matches, ${vRes.counts.changed} changed, ${vRes.counts.dropped} dropped since the last run` });

  const worklist = buildWorklist(id, asOf, patients, matches, trials, criteria, overnight, applied);
  const summary = {
    runId: id, asOf, dataLayer: layer.kind, trialsInSnapshot: snap.trials.length, trialsScreened: trials.length, patients: patients.length,
    criteria: counts,
    criteriaBreakdown: {
      total: criteria.length,
      checkByRule: criteria.filter((c) => c.category === "check" && c.method === "rule").length,
      checkByModel: criteria.filter((c) => c.category === "check" && c.method === "model").length,
      structured: criteria.filter((c) => c.method === "structured").length,
      screening: criteria.filter((c) => c.category === "screening").length,
      review: criteria.filter((c) => c.category === "review").length,
      backTranslationAgree: criteria.filter((c) => c.check?.status === "agree").length,
      backTranslationDisagree: criteria.filter((c) => c.check?.status === "disagree").length,
    },
    dq, pairs: matches.length,
    statusCounts: countBy(matches, (m) => m.status),
    newMatches: vRes.counts.new, traceFile: trace.file,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  writeFileSync(join(outDir, "worklist.json"), JSON.stringify(worklist));
  writeFileSync(join(outDir, "matches.json"), JSON.stringify(slimMatches(matches)));
  writeFileSync(join(outDir, "criteria.json"), JSON.stringify(criteria));
  writeFileSync(join(outDir, "trials.json"), JSON.stringify(trials.map(({ eligibility, ...t }) => ({ ...t, eligibility }))));
  writeFileSync(join(RUNTIME, "latest.json"), JSON.stringify({ runId: id, dir: outDir }));
  trace.emit({ agent: "Navigator", action: "write_worklist", status: "ok", summary: `${worklist.patients.filter((p) => p.matches.length).length} patients with at least one trial to review; ${worklist.oneItemAway.length} patients one data item away` });
  await layer.close();
  return { id, outDir, summary };
}

async function steward(layer: DataLayer, trace: Trace) {
  const out: { rule: string; table: string; invalid: number; why: string; sample: Row[] }[] = [];
  for (const rule of DQ_RULES) {
    const rows = await layer.dqInvalid(rule);
    out.push({ rule: rule.name, table: rule.table, invalid: rows.length, why: rule.why, sample: rows.slice(0, 5) });
    trace.emit({ agent: "Steward", action: "run_dq_rule", status: rows.length ? "blocked" : "ok", target: layer.kind === "zetaris" ? "Zetaris" : "DuckDB (sample)", summary: `${rule.name} on ${rule.table}: ${rows.length} invalid rows${rows.length ? " (excluded from screening)" : ""}` });
  }
  return out;
}

async function patientFacts(layer: DataLayer) {
  const rows = await layer.query(`SELECT patient_id, gene, status, alteration, tps, reported_date FROM ${layer.table("biomarker")} WHERE patient_id IS NOT NULL`);
  const labs = await layer.query(`SELECT patient_id, analyte, value, unit, collected_date FROM ${layer.table("lab")} WHERE patient_id IS NOT NULL AND unit IS NOT NULL`);
  return [
    ...rows.map((r) => ({ patientId: String(r.patient_id), kind: "biomarker" as const, key: String(r.gene), value: r.gene === "PDL1" ? `TPS ${r.tps}%` : `${r.status}${r.alteration ? ` ${r.alteration}` : ""}`, observedAt: String(r.reported_date), source: "lab-system/molecular" })),
    ...labs.map((r) => ({ patientId: String(r.patient_id), kind: "lab" as const, key: String(r.analyte), value: `${r.value} ${r.unit}`, observedAt: String(r.collected_date), source: "lab-system/results" })),
  ];
}

// Coordinator decisions remembered in H-MEM change tonight's worklist: travel limits set
// matches aside, and "not interested" decisions on a trial suppress it.
function applyMemory(memory: NavigatorMemory, matches: Match[], trials: Trial[], trace: Trace) {
  const notes: Record<string, string[]> = {};
  const byPatient = new Map<string, Match[]>();
  for (const m of matches) byPatient.set(m.patientId, [...(byPatient.get(m.patientId) ?? []), m]);
  for (const [pid, ms] of byPatient) {
    const prefs = memory.list({ patientId: pid }).filter((r) => !r.supersededBy && !r.archived);
    if (!prefs.length) continue;
    for (const p of prefs) {
      const travel = p.text.match(/(?:within|under|no more than|not (?:travel |go )?(?:more|further|farther) than|max(?:imum)?(?: of)?|up to|over)\s*(\d+)\s*(?:miles|mi\b)/i);
      for (const m of ms) {
        if (travel && m.nearestMiles > Number(travel[1]) && m.status !== "not_eligible") {
          (notes[`${pid}|${m.nctId}`] ??= []).push(`Set aside: nearest site ${m.nearestMiles.toFixed(0)} mi exceeds the ${travel[1]}-mile limit recorded by ${p.actor} (${p.createdAt.slice(0, 10)})`);
        }
        if (p.trialId === m.nctId && p.kind === "decision") (notes[`${pid}|${m.nctId}`] ??= []).push(`Coordinator decision: ${p.text}`);
      }
    }
    trace.emit({ agent: "Navigator", action: "recall_memory", status: "ok", summary: `${pid}: ${prefs.length} remembered decisions applied` });
  }
  return notes;
}

function countBy<T>(xs: T[], f: (x: T) => string) {
  const out: Record<string, number> = {};
  for (const x of xs) out[f(x)] = (out[f(x)] ?? 0) + 1;
  return out;
}

// Leaf SQL is deterministic and regenerated on demand, so it is not stored per pair.
function slimMatches(ms: Match[]) {
  const slimResult = (r: Match["results"][number]) => ({ ...r, text: undefined, leaves: r.leaves.map((l) => ({ leaf: l.leaf, value: l.value })) });
  return ms.map((m) => m.status === "not_eligible"
    ? { patientId: m.patientId, nctId: m.nctId, status: m.status, met: m.met, unknown: m.unknown, specificity: m.specificity, coverage: m.coverage, blocking: m.blocking.map(slimResult) }
    : { ...m, results: m.results.map(slimResult), blocking: [], unknowns: m.unknowns.map(slimResult) });
}

function buildWorklist(runId: string, asOf: string, patients: Row[], matches: Match[], trials: Trial[], criteria: Criterion[], overnight: any, notes: Record<string, string[]>) {
  const trialById = new Map(trials.map((t) => [t.nctId, t]));
  const newPairs = new Set<string>();
  for (const g of overnight.groups ?? []) if (g.kind === "match_new") for (const it of g.items) newPairs.add(`${it.patientId}|${it.nctId}`);

  const oneItemAway: { patientId: string; item: string; label: string; needsTissue: boolean; trials: string[] }[] = [];
  const patientsOut = patients.map((p) => {
    const pid = String(p.patient_id);
    const mine = matches.filter((m) => m.patientId === pid);
    const live = mine
      .filter((m) => m.status !== "not_eligible" && !(notes[`${pid}|${m.nctId}`] ?? []).some((n) => n.startsWith("Set aside")))
      .sort((a, b) => b.specificity - a.specificity || (a.status === b.status ? 0 : a.status === "eligible_no_blockers" ? -1 : 1) || b.coverage - a.coverage || a.unknown - b.unknown || a.nearestMiles - b.nearestMiles);
    const byItem = new Map<string, { label: string; needsTissue: boolean; trials: string[] }>();
    for (const m of mine.filter((x) => x.status === "possible_unknowns")) {
      const items = new Map(m.unknowns.flatMap((u) => u.items ?? []).map((i) => [i.id, i]));
      if (items.size === 1) {
        const [it] = items.values();
        const e = byItem.get(it.id) ?? { label: it.label, needsTissue: it.needsTissue, trials: [] };
        e.trials.push(m.nctId);
        byItem.set(it.id, e);
      }
    }
    for (const [item, e] of byItem) if (e.trials.length >= 2) oneItemAway.push({ patientId: pid, item, ...e });
    const topBlockers = countTop(mine.filter((m) => m.status === "not_eligible").flatMap((m) => m.blocking.map((b) => `${b.kind === "exclusion" ? "excluded: " : "fails: "}${describe(decidingLeaf(b).leaf)}`)));
    return {
      patientId: pid,
      name: `${p.given_name} ${p.family_name}`,
      sex: p.sex, age: p.age_years, zip: p.zip, milesToClinic: p.miles_to_clinic, ecog: p.ecog, story: p.demo_story || undefined,
      counts: { eligible: mine.filter((m) => m.status === "eligible_no_blockers").length, possible: mine.filter((m) => m.status === "possible_unknowns").length, blocked: mine.filter((m) => m.status === "not_eligible").length },
      matches: live.slice(0, 25).map((m) => ({
        nctId: m.nctId, title: trialById.get(m.nctId)?.title, phase: trialById.get(m.nctId)?.phase, status: m.status, met: m.met, unknown: m.unknown,
        screening: m.screening, review: m.review, specificity: m.specificity, coverage: Math.round(m.coverage * 100) / 100, nearestMiles: Math.round(m.nearestMiles), isNew: newPairs.has(`${pid}|${m.nctId}`),
        unknowns: m.unknowns.map((u) => ({ criterionId: u.criterionId, text: u.text, items: u.items })), verified: m.verified, notes: notes[`${pid}|${m.nctId}`],
      })),
      setAside: Object.entries(notes).filter(([k]) => k.startsWith(`${pid}|`)).map(([k, v]) => ({ nctId: k.split("|")[1], notes: v })),
      topBlockers,
    };
  });
  oneItemAway.sort((a, b) => b.trials.length - a.trials.length);
  return { runId, asOf, generatedAt: new Date().toISOString(), patients: patientsOut, oneItemAway, overnight };
}

function countTop(xs: string[], n = 3) {
  const c: Record<string, number> = {};
  for (const x of xs) c[x] = (c[x] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([reason, trials]) => ({ reason, trials }));
}
