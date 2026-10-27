// Compile stage of the nightly run. Agents: Watcher (trial snapshot), Guard (Scout
// Intent check on untrusted trial text), Compiler (rules first, then model), Checker
// (back-translation). Every decision is written to the run trace.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED, config, RUNTIME } from "../config.ts";
import { describe, predSchema, type Criterion } from "../dsl.ts";
import type { Trace } from "../log.ts";
import { Nightshift } from "../nightshift.ts";
import { splitCriteria, type Trial } from "../trials.ts";
import { backTranslate, compileByModel } from "./model.ts";
import { compileByRules, isScreeningItem } from "./rules.ts";

type Cached = Pick<Criterion, "category" | "method" | "pred" | "caveat" | "check"> & { model?: string; compiledAt: string };
const CACHE_FILE = join(COMPILED, "criteria-cache.json");

const keyOf = (c: Pick<Criterion, "kind" | "text">) => createHash("sha256").update(`${c.kind}\n${c.text}`).digest("hex").slice(0, 20);

function loadCache(): Record<string, Cached> {
  return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
}

export interface GuardResult { allowed: boolean; risk: number; findings: string[]; sanitized: string; contract?: unknown }
export type Guard = (input: { nctId: string; criterionId: string; text: string }) => GuardResult;

export interface GuardApi { guard: Guard; verify: (contract: unknown, expect: { criterionId?: string; nctId?: string; text?: string }) => boolean }
export async function loadGuard(): Promise<GuardApi | null> {
  try {
    const mod: any = await import("@nightlist/scout-intent/trialtext");
    return { guard: mod.guardTrialText as Guard, verify: mod.verifyContract };
  } catch {
    return null;
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export interface CompileOptions { useModel: boolean; recheck?: boolean; concurrency?: number }

export async function compileTrials(trials: Trial[], trace: Trace, opts: CompileOptions) {
  const cache = loadCache();
  const ns = new Nightshift();
  const status = opts.useModel ? await ns.status() : { state: "offline" as const, models: [] };
  const modelOn = opts.useModel && status.state === "online";
  trace.emit({ agent: "Compiler", action: "nightshift_status", status: modelOn ? "ok" : "info", summary: modelOn ? `Nightshift online, routes: ${status.models.join(", ")}` : `Nightshift ${status.state}; using rules and cached model compilations` });
  const guard = await loadGuard();
  trace.emit({ agent: "Guard", action: "load_scout_intent", status: guard ? "ok" : "info", summary: guard ? "Scout Intent guard active on trial text" : "Scout Intent engine not installed; guard skipped" });

  const all: Criterion[] = [];
  for (const t of trials) {
    const cs = splitCriteria(t);
    if (t.minAge !== undefined || t.maxAge !== undefined) {
      cs.unshift({ criterionId: `${t.nctId}-S01`, nctId: t.nctId, kind: "inclusion", ordinal: 0, text: `Age ${t.minAge ?? 0}${t.maxAge ? `-${t.maxAge}` : "+"} years (structured field)`, category: "check", method: "structured", pred: { k: "age", min: t.minAge, max: t.maxAge } });
    }
    if (t.sex === "female" || t.sex === "male") {
      cs.unshift({ criterionId: `${t.nctId}-S02`, nctId: t.nctId, kind: "inclusion", ordinal: 0, text: `Sex: ${t.sex} (structured field)`, category: "check", method: "structured", pred: { k: "sex", is: t.sex } });
    }
    all.push(...cs);
  }

  const counts = { rule: 0, model: 0, cached: 0, screening: 0, review: 0, structured: 0, blocked: 0, agree: 0, disagree: 0, retries: 0 };
  const work: Criterion[] = [];
  for (const c of all) {
    if (c.method === "structured") { counts.structured++; continue; }
    if (guard) {
      const g = guard.guard({ nctId: c.nctId, criterionId: c.criterionId, text: c.text });
      // The compiler only proceeds on a valid signed contract for this exact criterion,
      // and it compiles the sanitized text (links and markup removed).
      const contractOk = g.allowed && guard.verify(g.contract, { criterionId: c.criterionId, nctId: c.nctId, text: g.sanitized });
      if (g.allowed && !contractOk) g.findings.push("execution contract did not verify");
      if (g.allowed && contractOk && g.sanitized && g.sanitized !== c.text) c.text = g.sanitized;
      if (!g.allowed || !contractOk) {
        c.category = "review";
        c.caveat = `blocked by Scout Intent guard: ${g.findings.join("; ")}`;
        counts.blocked++;
        trace.emit({ agent: "Guard", action: "block_trial_text", status: "blocked", target: "Compiler", summary: `${c.criterionId}: ${g.findings.join("; ")}` });
        continue;
      }
    }
    // Rules are deterministic and cheap, so they always run fresh; only model
    // compilations and back-translation checks are reused from the cache.
    const hit = cache[keyOf(c)];
    const r = compileByRules(c);
    if (r) {
      Object.assign(c, { category: "check", method: "rule", pred: r.pred, caveat: r.caveats.join("; ") || undefined });
      if (hit?.method === "rule" && JSON.stringify(hit.pred) === JSON.stringify(r.pred) && hit.check && hit.check.status !== "unchecked") {
        c.check = hit.check;
        if (hit.check.status === "disagree") c.category = "review";
        counts.cached++;
        continue;
      }
      counts.rule++;
    } else if (isScreeningItem(c.text)) {
      c.category = "screening";
      counts.screening++;
      continue;
    } else if (hit && hit.method === "model" && !(modelOn && hit.check?.status === "unchecked")) {
      Object.assign(c, { category: hit.category, method: hit.method, pred: hit.pred, caveat: hit.caveat, check: hit.check });
      counts.cached++;
      continue;
    } else if (hit && hit.method === "none" && hit.category === "review" && hit.model && !modelOn) {
      Object.assign(c, { category: "review", method: "none", caveat: hit.caveat });
      counts.cached++;
      continue;
    }
    work.push(c);
  }

  await pool(work, opts.concurrency ?? 4, async (c) => {
    if (c.category === "screening") return;
    if (!c.pred && modelOn) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const m = await compileByModel(ns, c);
          Object.assign(c, { category: m.category, method: m.pred ? "model" : "none", pred: m.pred, caveat: m.caveats.join("; ") || undefined, modelReviewed: m.model });
          trace.emit({ agent: "Compiler", action: "compile_criterion", status: "ok", model: m.model, durationMs: m.ms, target: m.pred ? "Checker" : undefined, summary: `${c.criterionId}: ${m.pred ? describe(m.pred) : m.category}` });
          if (m.pred) counts.model++;
          break;
        } catch (err) {
          counts.retries++;
          trace.emit({ agent: "Compiler", action: "compile_criterion", status: attempt === 1 ? "retry" : "failed", summary: `${c.criterionId}: ${(err as Error).message}` });
        }
      }
    }
    if (!c.pred) {
      if (c.category !== "screening") { c.category = "review"; counts.review++; }
      return;
    }
    if (modelOn) {
      try {
        const chk = await backTranslate(ns, c, c.pred);
        c.check = { status: chk.status, backTranslation: chk.backTranslation, model: chk.model, reason: chk.reason };
        if (chk.status === "disagree") {
          counts.disagree++;
          trace.emit({ agent: "Checker", action: "back_translate", status: "blocked", model: chk.model, target: "Compiler", summary: `${c.criterionId}: rule "${describe(c.pred)}" does not match the sentence (${chk.reason}); sent to human review` });
          c.category = "review";
        } else {
          counts.agree++;
          trace.emit({ agent: "Checker", action: "back_translate", status: "ok", model: chk.model, summary: `${c.criterionId}: agrees` });
        }
      } catch (err) {
        c.check = { status: "unchecked", reason: (err as Error).message };
      }
    } else {
      c.check = { status: "unchecked" };
    }
  });

  for (const c of all) {
    if (c.method === "structured") continue;
    if (!c.pred && c.category === "check") c.category = "review";
    if (c.pred && !predSchema.safeParse(c.pred).success) { c.category = "review"; c.pred = undefined; }
    if (!(c.caveat ?? "").startsWith("blocked by Scout") && (c.method === "model" || c.check?.model || (c as any).modelReviewed)) {
      cache[keyOf(c)] = { category: c.category, method: c.method, pred: c.pred, caveat: c.caveat, check: c.check, model: c.check?.model ?? (c as any).modelReviewed, compiledAt: new Date().toISOString() };
    }
  }
  mkdirSync(COMPILED, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  trace.emit({ agent: "Compiler", action: "compile_summary", status: "ok", summary: `${all.length} criteria: ${JSON.stringify(counts)}`, data: counts });
  return { criteria: all, counts };
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(path: string, rows: Record<string, unknown>[]) {
  const cols = Object.keys(rows[0]);
  writeFileSync(path, [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
}

// The compiled tables the semantic layer reads (a Zetaris file-store source in live mode).
export function writeCompiledTables(trials: Trial[], criteria: Criterion[], dir = join(RUNTIME, "compiled")) {
  mkdirSync(dir, { recursive: true });
  writeCsv(join(dir, "trials.csv"), trials.map((t) => ({
    nct_id: t.nctId, title: t.title, phase: t.phase, overall_status: t.status, sponsor: t.sponsor, last_update: t.lastUpdate,
    min_age: t.minAge ?? "", max_age: t.maxAge ?? "", sex: t.sex, criteria_hash: t.criteriaHash, nearest_site_miles: t.nearestMiles.toFixed(1),
  })));
  writeCsv(join(dir, "sites.csv"), trials.flatMap((t) => t.sites.map((s) => ({
    site_id: s.siteId, nct_id: t.nctId, facility: s.facility, city: s.city, state: s.state, zip: s.zip, lat: s.lat, lon: s.lon,
  }))));
  writeCsv(join(dir, "criteria.csv"), criteria.map((c) => ({
    criterion_id: c.criterionId, nct_id: c.nctId, kind: c.kind, ordinal: c.ordinal, text: c.text, category: c.category, method: c.method,
    check_status: c.check?.status ?? (c.method === "structured" ? "structured" : ""), compiled_json: c.pred ? JSON.stringify({ pred: c.pred, caveat: c.caveat ?? null }) : "",
  })));
  writeFileSync(join(dir, "criteria.json"), JSON.stringify(criteria));
  return dir;
}

export function nearbyRecruiting(trials: Trial[]) {
  return trials.filter((t) => t.status === "RECRUITING" && t.nearestMiles <= config.clinic.maxMiles);
}
