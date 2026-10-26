// Screener: evaluates every compiled criterion for every patient, one SQL pass per
// trial, inside the data layer. Verifier: re-reads the source rows behind each clean
// match and downgrades any match whose evidence does not hold up.
import type { DataLayer, Row } from "../datalayer.ts";
import type { Criterion, Leaf, Pred } from "../dsl.ts";
import type { Trace } from "../log.ts";
import type { Trial } from "../trials.ts";
import { combine, dataItemFor, evidenceSql, leafKey, leafSql, leaves, type DataItem, type Tri } from "./sqlgen.ts";

export type Verdict = "met" | "not_met" | "unknown";
export interface CriterionResult {
  criterionId: string;
  kind: Criterion["kind"];
  text: string;
  verdict: Verdict;
  method: Criterion["method"];
  caveat?: string;
  leaves: { leaf: Leaf; value: Tri; sql: string }[];
  items?: DataItem[];
}
export type MatchStatus = "eligible_no_blockers" | "possible_unknowns" | "not_eligible";
export interface Match {
  patientId: string;
  nctId: string;
  status: MatchStatus;
  met: number;
  unknown: number;
  screening: number;
  review: number;
  blocking: CriterionResult[];
  unknowns: CriterionResult[];
  results: CriterionResult[];
  nearestMiles: number;
  // how many met inclusion checks are specific to this patient's disease (biomarker,
  // prior therapy, PD-L1, histology, stage), and the share of the trial actually checked
  specificity: number;
  coverage: number;
  verified?: { ok: boolean; notes: string[] };
}

const SPECIFIC = new Set(["biomarker", "pdl1", "prior_therapy", "histology", "stage", "lines"]);
// The leaf that decided a verdict: for a failed inclusion the FALSE leaf, for a
// triggered exclusion the TRUE leaf.
export function decidingLeaf(r: CriterionResult) {
  const want = r.kind === "inclusion" ? (r.verdict === "not_met" ? "F" : "T") : r.verdict === "not_met" ? "T" : "F";
  return r.leaves.find((l) => l.value === want) ?? r.leaves[0];
}

export function verdictOf(kind: Criterion["kind"], v: Tri): Verdict {
  if (v === "U") return "unknown";
  if (kind === "inclusion") return v === "T" ? "met" : "not_met";
  return v === "T" ? "not_met" : "met";
}

export async function screen(layer: DataLayer, trials: Trial[], criteria: Criterion[], asOf: string, trace: Trace): Promise<Match[]> {
  const labCutoff = new Date(new Date(asOf).getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const t = (n: string) => layer.table(n as any);
  const byTrial = new Map<string, Criterion[]>();
  for (const c of criteria) byTrial.set(c.nctId, [...(byTrial.get(c.nctId) ?? []), c]);
  const matches: Match[] = [];
  let queries = 0;

  for (const trial of trials) {
    const cs = byTrial.get(trial.nctId) ?? [];
    const checks = cs.filter((c) => c.category === "check" && c.pred);
    const uniq = new Map<string, Leaf>();
    for (const c of checks) for (const l of leaves(c.pred as Pred)) uniq.set(leafKey(l), l);
    const keys = [...uniq.keys()];
    const sqlFor = new Map(keys.map((k) => [k, leafSql(uniq.get(k)!, t, labCutoff)]));
    const select = keys.length
      ? `SELECT p.patient_id, ${keys.map((k, i) => `${sqlFor.get(k)} AS l${i}`).join(",\n  ")}\nFROM ${t("patient")} p`
      : `SELECT p.patient_id FROM ${t("patient")} p`;
    const rows: Row[] = await trace.time(
      { agent: "Screener", action: "evaluate_trial", target: layer.kind === "zetaris" ? "Zetaris" : "DuckDB (sample)", summary: `${trial.nctId}: ${checks.length} compiled criteria, ${keys.length} distinct checks`, data: { nctId: trial.nctId, leaves: keys.length } },
      () => layer.query(select),
    );
    queries++;

    for (const row of rows) {
      const pid = String(row.patient_id);
      const value = (l: Leaf): Tri => (row[`l${keys.indexOf(leafKey(l))}`] as Tri) ?? "U";
      const results: CriterionResult[] = checks.map((c) => {
        const v = combine(c.pred as Pred, value);
        const ls = leaves(c.pred as Pred).map((l) => ({ leaf: l, value: value(l), sql: sqlFor.get(leafKey(l))! }));
        const verdict = verdictOf(c.kind, v);
        const items = verdict === "unknown" ? dedupeItems(ls.filter((x) => x.value === "U").map((x) => dataItemFor(x.leaf))) : undefined;
        return { criterionId: c.criterionId, kind: c.kind, text: c.text, verdict, method: c.method, caveat: c.caveat, leaves: ls, items };
      });
      const blocking = results.filter((r) => r.verdict === "not_met");
      const unknowns = results.filter((r) => r.verdict === "unknown");
      matches.push({
        patientId: pid,
        nctId: trial.nctId,
        status: blocking.length ? "not_eligible" : unknowns.length ? "possible_unknowns" : "eligible_no_blockers",
        met: results.filter((r) => r.verdict === "met").length,
        unknown: unknowns.length,
        screening: cs.filter((c) => c.category === "screening").length,
        review: cs.filter((c) => c.category === "review").length,
        blocking,
        unknowns,
        results,
        nearestMiles: trial.nearestMiles,
        specificity: results.filter((r) => r.kind === "inclusion" && r.verdict === "met" && r.leaves.some((l) => l.value === "T" && SPECIFIC.has(l.leaf.k) && !(l.leaf.k === "histology" && l.leaf.anyOf.length === 4))).length,
        coverage: checks.length / Math.max(1, checks.length + cs.filter((c) => c.category === "review").length),
      });
    }
  }
  trace.emit({ agent: "Screener", action: "screen_summary", status: "ok", summary: `${queries} trial queries, ${matches.length} patient-trial pairs evaluated` });
  return matches;
}

function dedupeItems(items: DataItem[]): DataItem[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.id) && seen.add(i.id));
}

// For each clean match, re-read the evidence rows for every met criterion that depends
// on patient data and confirm the rows exist and agree. A missing or contradictory row
// downgrades the match and is logged as a critique.
export async function verify(layer: DataLayer, matches: Match[], trace: Trace, limit = layer.kind === "duckdb" ? Infinity : 400) {
  const t = (n: string) => layer.table(n as any);
  const clean = matches.filter((m) => m.status === "eligible_no_blockers").slice(0, limit);
  let downgraded = 0;
  const cache = new Map<string, Row[]>();
  for (const m of clean) {
    const notes: string[] = [];
    for (const r of m.results) {
      for (const x of r.leaves) {
        if (x.value !== "T" || !["biomarker", "pdl1", "lab"].includes(x.leaf.k)) continue;
        const sql = evidenceSql(x.leaf, t, m.patientId);
        if (!cache.has(sql)) cache.set(sql, await layer.query(sql));
        const rows = cache.get(sql)!;
        if (!rows.length) notes.push(`${r.criterionId}: no source row behind a TRUE ${x.leaf.k} check`);
        if (x.leaf.k === "biomarker" && x.leaf.status === "detected" && !rows.some((row) => row.status === "detected")) notes.push(`${r.criterionId}: report does not show a detected ${x.leaf.gene} result`);
      }
    }
    m.verified = { ok: notes.length === 0, notes };
    if (notes.length) {
      downgraded++;
      m.status = "possible_unknowns";
      trace.emit({ agent: "Verifier", action: "challenge_match", status: "revise", target: "Screener", summary: `${m.patientId} x ${m.nctId}: ${notes.join("; ")}` });
    }
  }
  trace.emit({ agent: "Verifier", action: "verify_summary", status: "ok", summary: `${clean.length} clean matches re-read against source rows, ${downgraded} downgraded`, data: { checked: clean.length, downgraded } });
}
