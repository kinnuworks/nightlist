// One function per API route. With VITE_STATIC=1 the same functions read the JSON files
// exported by scripts/export-replay.mjs, so the app can be hosted without a backend.
import type {
  MatchDetail,
  MemoryInput,
  MemoryRecord,
  PatientDetail,
  Status,
  Summary,
  TraceEvent,
  TrialDetail,
  Usl,
  Worklist,
} from "./types";

export const STATIC = import.meta.env.VITE_STATIC === "1";
export const STATIC_NOTE = "Replay of a real overnight run. Run locally to record decisions.";

export class NotInReplay extends Error {
  constructor(what: string) {
    super(what);
    this.name = "NotInReplay";
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const enc = encodeURIComponent;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      // body was not JSON
    }
    throw new HttpError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

async function replay<T>(path: string, missing?: string): Promise<T> {
  const url = `${import.meta.env.BASE_URL}replay/${path}`;
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "";
  // Static hosts often answer a missing file with index.html and status 200.
  if (!res.ok || type.includes("text/html")) {
    if (missing) throw new NotInReplay(missing);
    throw new HttpError(res.status || 404, `Missing replay file ${path}`);
  }
  return res.json() as Promise<T>;
}

// The worklist is about 3 MB, so it and the other run-level payloads are cached until a
// rerun or a recorded decision invalidates them.
const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
export function clearCache(prefix?: string) {
  for (const k of [...cache.keys()]) if (!prefix || k.startsWith(prefix)) cache.delete(k);
}

export const getStatus = () =>
  cached("status", () => (STATIC ? replay<Status>("status.json") : getJson<Status>("/api/status")));

export const getSummary = () =>
  cached("summary", () => (STATIC ? replay<Summary>("summary.json") : getJson<Summary>("/api/summary")));

export const getWorklist = () =>
  cached("worklist", () => (STATIC ? replay<Worklist>("worklist.json") : getJson<Worklist>("/api/worklist")));

export const getPatient = (id: string) =>
  cached(`patient:${id}`, () =>
    STATIC
      ? replay<PatientDetail>(`patient/${enc(id)}.json`, "This patient is not in the replay export; run locally")
      : getJson<PatientDetail>(`/api/patient/${enc(id)}`),
  );

export const getMatch = (pid: string, nct: string) =>
  cached(`match:${pid}:${nct}`, () =>
    STATIC
      ? replay<MatchDetail>(`match/${enc(pid)}__${enc(nct)}.json`, "This pair is not in the replay export; run locally")
      : getJson<MatchDetail>(`/api/match/${enc(pid)}/${enc(nct)}`),
  );

export const getTrial = (nct: string) =>
  cached(`trial:${nct}`, () =>
    STATIC
      ? replay<TrialDetail>(`trial/${enc(nct)}.json`, "This trial is not in the replay export; run locally")
      : getJson<TrialDetail>(`/api/trial/${enc(nct)}`),
  );

export const getTrace = (run?: string) =>
  cached(`trace:${run ?? ""}`, () =>
    STATIC
      ? replay<TraceEvent[]>("trace.json")
      : getJson<TraceEvent[]>(`/api/trace${run ? `?run=${enc(run)}` : ""}`),
  );

export const getUsl = () => cached("usl", () => (STATIC ? replay<Usl>("usl.json") : getJson<Usl>("/api/usl")));

export async function getMemory(pid: string): Promise<MemoryRecord[]> {
  if (STATIC) {
    try {
      return await replay<MemoryRecord[]>(`memory/${enc(pid)}.json`);
    } catch {
      return [];
    }
  }
  return getJson<MemoryRecord[]>(`/api/memory/${enc(pid)}`);
}

export async function postMemory(input: MemoryInput): Promise<MemoryRecord> {
  if (STATIC) throw new Error(STATIC_NOTE);
  const res = await fetch("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new HttpError(res.status, (await res.json().catch(() => ({})))?.error ?? res.statusText);
  clearCache(`patient:${input.patientId}`);
  clearCache(`match:${input.patientId}:`);
  return res.json();
}

export async function postRun(): Promise<Summary> {
  if (STATIC) throw new Error(STATIC_NOTE);
  const res = await fetch("/api/run", { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, (await res.json().catch(() => ({})))?.error ?? res.statusText);
  clearCache();
  return res.json();
}
