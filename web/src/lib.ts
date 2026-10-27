// Hash routing, a small data-loading hook and formatting helpers.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { dataVersion, onDataChange } from "./api";
import type { CriteriaBreakdown, HeadlineMode, MatchStatus, Method, Summary, Verdict } from "./types";

// ---------- routing ----------

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [p, q = ""] = raw.split("?");
  return { path: p.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseHash(), [hash]);
}

export const href = {
  home: (q?: Record<string, string>) => `#/${q && Object.keys(q).length ? `?${new URLSearchParams(q)}` : ""}`,
  patient: (pid: string) => `#/patient/${encodeURIComponent(pid)}`,
  match: (pid: string, nct: string) => `#/match/${encodeURIComponent(pid)}/${encodeURIComponent(nct)}`,
  trial: (nct: string) => `#/trial/${encodeURIComponent(nct)}`,
  run: (section?: string) => `#/run${section ? `?section=${section}` : ""}`,
};

export function navigate(to: string) {
  window.location.hash = to.replace(/^#/, "");
}

// ---------- data loading ----------

export interface Loaded<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// Bumps after a rerun replaces the cached run data, so long-lived views (the header) reload.
export function useDataVersion(): number {
  return useSyncExternalStore(onDataChange, dataVersion);
}

// ---------- formatting ----------

export function fmtDate(d?: string | null, withYear = true): string {
  if (!d) return "not recorded";
  const date = new Date(d.length === 10 ? `${d}T12:00:00` : d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}

export function fmtTime(d?: string): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtDateTime(d?: string): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

export const miles = (m?: number | null) => (m === undefined || m === null || Number.isNaN(m) ? "n/a" : `${Math.round(m).toLocaleString()} mi`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const pct = (x?: number) => (x === undefined ? "n/a" : `${Math.round(x * 100)}%`);

export const STATUS_LABEL: Record<MatchStatus, string> = {
  eligible_no_blockers: "No blockers found",
  needs_review: "Key criterion needs a human read",
  possible_unknowns: "Open items",
  not_eligible: "Blocked",
};

// Display order for statuses, best first.
export const STATUS_RANK: Record<MatchStatus, number> = {
  eligible_no_blockers: 0,
  needs_review: 1,
  possible_unknowns: 2,
  not_eligible: 3,
};

export const statusRank = (s: string) => STATUS_RANK[s as MatchStatus] ?? 2;

// Criteria counts for the run. Older summaries only carry the flat criteria record.
export function criteriaBreakdown(sm: Summary): CriteriaBreakdown {
  if (sm.criteriaBreakdown) return sm.criteriaBreakdown;
  const c = sm.criteria ?? {};
  const n = (k: string) => (typeof c[k] === "number" ? c[k] : 0);
  const b = {
    checkByRule: n("rule"),
    checkByModel: n("model") + n("cached"),
    structured: n("structured"),
    screening: n("screening"),
    review: n("review"),
    backTranslationAgree: n("agree"),
    backTranslationDisagree: n("disagree"),
  };
  return { total: b.checkByRule + b.checkByModel + b.structured + b.screening + b.review, ...b };
}

// True when no criterion was compiled or checked by the model in this build.
export function modelPathIdle(b: CriteriaBreakdown) {
  return b.checkByModel === 0 && b.backTranslationAgree + b.backTranslationDisagree === 0;
}

// Funnel counts in the worklist headline shape, from the summary breakdown when the
// worklist has no headline (older runs) or is not loaded.
export function modeFromBreakdown(b: CriteriaBreakdown): Required<HeadlineMode> {
  return {
    modelPath: modelPathIdle(b) ? "rules only" : "rules and model",
    checkedByRule: b.checkByRule,
    checkedByModel: b.checkByModel,
    structured: b.structured,
    screening: b.screening,
    humanRead: b.review,
    total: b.total,
  };
}

export const MODEL_IDLE_NOTE = "Model path not run in this build: rules and structured fields only. Connect Nightshift to compile the rest.";

export const VERDICT_LABEL: Record<Verdict, string> = {
  met: "Met",
  not_met: "Not met",
  unknown: "Unknown",
};

export const METHOD_LABEL: Record<Method, string> = {
  rule: "Rule",
  model: "Model",
  structured: "Structured field",
  none: "Not compiled",
};

export const METHOD_HELP: Record<Method, string> = {
  rule: "Compiled by a deterministic pattern rule from the trial text",
  model: "Compiled by the model from the public trial text, then checked by back-translation",
  structured: "Taken from a structured registry field (age or sex)",
  none: "Not compiled into a check",
};

// Which source system a semantic-layer table comes from, for source badges.
export const SOURCE_OF_TABLE: Record<string, { label: string; tone: string }> = {
  patient: { label: "EHR", tone: "ehr" },
  diagnosis: { label: "EHR", tone: "ehr" },
  metastasis: { label: "EHR", tone: "ehr" },
  condition: { label: "EHR problem list", tone: "ehr" },
  biomarker: { label: "Lab system (molecular)", tone: "lab" },
  lab: { label: "Lab system", tone: "lab" },
  therapy: { label: "RxNav-resolved medication", tone: "rx" },
};

export function tableOfSql(sql: string): string | undefined {
  const m = sql.match(/FROM\s+(?:[\w"]+\.)*"?(\w+)"?/i);
  return m?.[1];
}

export function phaseLabel(p?: string) {
  if (!p) return "";
  return p.replace(/PHASE/g, "Phase ").replace(/\//g, "/").replace(/EARLY_Phase /, "Early phase ").trim();
}

export function sexShort(s?: string) {
  if (!s) return "";
  return s.startsWith("f") ? "F" : s.startsWith("m") ? "M" : s;
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
