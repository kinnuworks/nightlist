// Run page: what each agent did overnight, the data-quality rules, the semantic layer,
// engine conformance and data layer status, and a button to rerun the screen.
import { useEffect, useState } from "react";
import { getStatus, getSummary, getTrace, getUsl, postRun, STATIC, STATIC_NOTE } from "../api";
import { CodeBlock, Disclosure, ErrorView, EvidenceTable, Loading, SourceBadge, StackBar } from "../components/ui";
import { criteriaBreakdown, fmtDate, fmtTime, MODEL_IDLE_NOTE, modelPathIdle, plural, SOURCE_OF_TABLE, useLoad } from "../lib";
import type { Status, Summary, TraceEvent, Usl } from "../types";

const AGENTS: { name: string; role: string }[] = [
  { name: "Watcher", role: "Pulls the trial snapshot and records what opened, changed or closed" },
  { name: "Guard", role: "Screens untrusted trial text before any model reads it" },
  { name: "Compiler", role: "Compiles criteria into checks: rules first, then the model" },
  { name: "Checker", role: "Back-translates model checks and compares them with the source sentence" },
  { name: "Steward", role: "Opens the semantic layer and runs data-quality rules" },
  { name: "Screener", role: "Evaluates every check for every patient inside the data layer" },
  { name: "Verifier", role: "Re-reads the source rows behind each clean match" },
  { name: "Navigator", role: "Applies remembered decisions and writes the worklist" },
];

export function RunPage({ section }: { section?: string }) {
  const [gen, setGen] = useState(0);
  const status = useLoad(getStatus, [gen]);
  const summary = useLoad(getSummary, [gen]);
  const trace = useLoad(() => getTrace(), [gen]);
  const usl = useLoad(getUsl, [gen]);
  const ready = status.data && summary.data;

  useEffect(() => {
    if (!section || !ready) return;
    const el = document.getElementById(`run-${section}`);
    if (el) {
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    }
  }, [section, ready]);

  const err = status.error ?? summary.error;
  if (err) return <ErrorView error={err} retry={() => setGen(gen + 1)} />;
  if (!status.data || !summary.data) return <Loading label="Loading run" />;
  const s = status.data;
  const sm = summary.data;

  return (
    <div className="stack-lg">
      <section className="page-head" aria-labelledby="run-title">
        <span className="eyebrow">Overnight run</span>
        <h1 id="run-title">
          Run <span className="mono" style={{ fontSize: "0.85em" }}>{sm.runId}</span>
        </h1>
        <p className="lede">
          Screened as of {fmtDate(sm.asOf)}. {sm.trialsInSnapshot} recruiting lung cancer trials in the snapshot, {sm.trialsScreened} with a site within{" "}
          {s.clinic.maxMiles} miles of {s.clinic.name}. {sm.patients} patients, {sm.pairs.toLocaleString()} patient and trial pairs evaluated.
        </p>
      </section>

      <div className="grid-2">
        <RunNow onDone={() => setGen(gen + 1)} />
        <StatusCard s={s} sm={sm} />
      </div>

      <ResultsCard sm={sm} />

      <section className="card" id="run-trace" tabIndex={-1} aria-labelledby="trace-title">
        <div className="card-head">
          <div>
            <h2 id="trace-title">Agent trace</h2>
            <p>Every step the overnight agents logged, grouped by agent in pipeline order. The model used for a request is shown when one was used.</p>
          </div>
        </div>
        {trace.error ? (
          <p className="empty">Trace not available: {trace.error.message}</p>
        ) : !trace.data ? (
          <p className="loading">Loading trace</p>
        ) : (
          <TraceView events={trace.data} />
        )}
      </section>

      <section className="card" id="run-dq" tabIndex={-1} aria-labelledby="dq-title">
        <div className="card-head">
          <div>
            <h2 id="dq-title">Data-quality rules</h2>
            <p>Run by the Steward before screening. Rows that fail a rule are excluded so a bad value cannot produce a match.</p>
          </div>
        </div>
        <DqView sm={sm} usl={usl.data} />
      </section>

      <section className="card" id="run-usl" tabIndex={-1} aria-labelledby="usl-title">
        <div className="card-head">
          <div>
            <h2 id="usl-title">Semantic layer</h2>
            <p>The tables every check is written against. The model only sees these names and types, never the rows.</p>
          </div>
        </div>
        {usl.error ? <p className="empty">Not available: {usl.error.message}</p> : !usl.data ? <p className="loading">Loading</p> : <UslView usl={usl.data} />}
      </section>
    </div>
  );
}

function RunNow({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section className="card card-pad stack" aria-labelledby="rn-title" style={{ gap: 10 }}>
      <h2 id="rn-title">Run the overnight screen now</h2>
      <p className="small" style={{ color: "var(--ink-2)" }}>
        Pulls the trial snapshot, compiles new or changed criteria, runs data-quality rules, screens every patient and rewrites the worklist. In sample mode this
        takes a few seconds.
      </p>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={STATIC || busy}
          aria-describedby={STATIC ? "rn-static" : undefined}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const res = await postRun();
              setMsg({ ok: true, text: `Finished run ${res.runId}: ${res.pairs.toLocaleString()} pairs screened, ${res.newMatches} new matches.` });
              onDone();
            } catch (e) {
              setMsg({ ok: false, text: `Run failed: ${(e as Error).message}` });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Running overnight screen" : "Run overnight screen now"}
        </button>
        {busy && <span className="small muted" role="status">Working. This page updates when the run finishes.</span>}
      </div>
      {STATIC && (
        <p id="rn-static" className="note note-warn small">
          {STATIC_NOTE}
        </p>
      )}
      {msg && (
        <p className={`note small ${msg.ok ? "note-ok" : "note-bad"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </section>
  );
}

// Engine status strings can arrive as markdown ("## Verdict: PASS" with an emoji).
// Strip that down to plain text for a badge.
function cleanEngine(v?: string): string {
  return (v ?? "")
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ScoutBadge({ v }: { v?: string }) {
  const text = cleanEngine(v);
  if (!text) return <span className="badge">not run</span>;
  if (/\bPASS(ED)?\b/i.test(text) && !/\bFAIL/i.test(text))
    return (
      <span className="badge badge-ok" title={text}>
        Eval gates passed
      </span>
    );
  return <span className="badge badge-warn">{text}</span>;
}

function modelNote(sm: Summary): string {
  const b = criteriaBreakdown(sm);
  if (modelPathIdle(b)) return MODEL_IDLE_NOTE;
  return `${plural(b.checkByModel, "model-compiled check")} in use; back-translation: ${b.backTranslationAgree} agree, ${b.backTranslationDisagree} disagree.`;
}

function StatusCard({ s, sm }: { s: Status; sm: Summary }) {
  const models = (s.nightshift.models ?? []).map((m) => (typeof m === "string" ? m : (m.id ?? m.name ?? JSON.stringify(m))));
  const eng = (v: string) => cleanEngine(v) || "not run";
  const engTone = (v: string) => (/not run/.test(v) || !v.trim() ? "" : /(\d+)\/\1/.test(v) ? "badge-ok" : "badge-warn");
  return (
    <section className="card card-pad stack" aria-labelledby="st-title" style={{ gap: 10 }}>
      <h2 id="st-title">Systems</h2>
      <dl className="kv">
        <dt>Data layer</dt>
        <dd>
          {s.dataLayer === "zetaris" ? (
            <span className="badge badge-ok">Zetaris (federated)</span>
          ) : (
            <span className="badge badge-warn">DuckDB sample</span>
          )}{" "}
          <span className="small muted">{s.sampleMode ? "sample mode: checks run on a local copy" : "checks run where the data lives"}</span>
        </dd>
        <dt>Nightshift</dt>
        <dd>
          <span className={`badge ${s.nightshift.state === "online" || s.nightshift.state === "ready" ? "badge-ok" : ""}`}>{s.nightshift.state}</span>{" "}
          <span className="small muted">{models.length ? `Models: ${models.join(", ")}. ${modelNote(sm)}` : `No model endpoint. ${modelNote(sm)}`}</span>
        </dd>
        <dt>World Model</dt>
        <dd>
          <span className={`badge ${engTone(eng(s.engines.worldModel))}`}>{eng(s.engines.worldModel)}</span> <span className="small muted">conformance</span>
        </dd>
        <dt>H-MEM</dt>
        <dd>
          <span className={`badge ${engTone(eng(s.engines.hmem))}`}>{eng(s.engines.hmem)}</span> <span className="small muted">conformance</span>
        </dd>
        <dt>Scout Intent</dt>
        <dd>
          <ScoutBadge v={s.engines.scoutIntent} /> <span className="small muted">trial text guard eval</span>
        </dd>
      </dl>
    </section>
  );
}

function ResultsCard({ sm }: { sm: Summary }) {
  const sc = sm.statusCounts;
  const b = criteriaBreakdown(sm);
  const idle = modelPathIdle(b);
  const critRows: [string, number][] = [
    ["Total criteria in screened trials", b.total],
    ["Checked from records by a pattern rule", b.checkByRule],
    ["Checked from records by a model-compiled check", b.checkByModel],
    ["Taken from structured registry fields (age, sex)", b.structured],
    ["Confirmed at the screening visit", b.screening],
    ["Need a human read", b.review],
    ["Model checks where back-translation agrees", b.backTranslationAgree],
    ["Model checks where back-translation disagrees", b.backTranslationDisagree],
  ];
  return (
    <section className="card" aria-labelledby="res-title">
      <div className="card-head">
        <h2 id="res-title">Results</h2>
      </div>
      <div className="card-body grid-2">
        <div className="stack" style={{ gap: 8 }}>
          <h3>Patient and trial pairs ({sm.pairs.toLocaleString()})</h3>
          <StackBar
            label="Pairs by status"
            parts={[
              { value: sc.eligible_no_blockers ?? 0, cls: "b-ok", label: "no blockers found" },
              { value: sc.needs_review ?? 0, cls: "b-review", label: "key criterion needs a human read" },
              { value: sc.possible_unknowns ?? 0, cls: "b-warn", label: "open items" },
              { value: sc.not_eligible ?? 0, cls: "b-bad", label: "blocked" },
            ]}
          />
          <dl className="kv small">
            <dt>No blocking criteria found</dt>
            <dd>{(sc.eligible_no_blockers ?? 0).toLocaleString()}</dd>
            {sc.needs_review !== undefined && (
              <>
                <dt>Key criterion needs a human read</dt>
                <dd>{sc.needs_review.toLocaleString()}</dd>
              </>
            )}
            <dt>Open items (unknowns)</dt>
            <dd>{(sc.possible_unknowns ?? 0).toLocaleString()}</dd>
            <dt>Blocked</dt>
            <dd>{(sc.not_eligible ?? 0).toLocaleString()}</dd>
            <dt>New since last run</dt>
            <dd>{sm.newMatches}</dd>
          </dl>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <h3>How criteria were handled</h3>
          <div className="table-wrap">
            <table className="t compact">
              <caption className="sr-only">Criteria by how they were handled</caption>
              <tbody>
                {critRows.map(([label, v]) => (
                  <tr key={label}>
                    <th scope="row" style={{ textTransform: "none", letterSpacing: 0, background: "transparent", fontSize: 13, color: "var(--ink-2)" }}>
                      {label}
                    </th>
                    <td className="num">{v.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {idle && <p className="note small">{MODEL_IDLE_NOTE}</p>}
        </div>
      </div>
    </section>
  );
}

function TraceView({ events }: { events: TraceEvent[] }) {
  const known = new Set(AGENTS.map((a) => a.name));
  const extra = [...new Set(events.map((e) => e.agent).filter((a) => !known.has(a)))].map((name) => ({ name, role: "" }));
  const first = events[0]?.ts;
  const last = events[events.length - 1]?.ts;
  const total = first && last ? (new Date(last).getTime() - new Date(first).getTime()) / 1000 : 0;
  return (
    <div>
      <p className="small muted" style={{ padding: "10px 16px 0" }}>
        {plural(events.length, "event")} from {fmtTime(first)} to {fmtTime(last)} ({total.toFixed(1)} s).
      </p>
      <div style={{ marginTop: 10 }}>
        {[...AGENTS, ...extra].map((a) => (
          <AgentGroup key={a.name} name={a.name} role={a.role} events={events.filter((e) => e.agent === a.name)} />
        ))}
      </div>
    </div>
  );
}

function AgentGroup({ name, role, events }: { name: string; role: string; events: TraceEvent[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 6);
  const blocked = events.filter((e) => e.status === "blocked" || e.status === "error").length;
  const ms = events.reduce((a, e) => a + (e.durationMs ?? 0), 0);
  const models = [...new Set(events.map((e) => e.model).filter(Boolean))];
  return (
    <div>
      <div className="agent-head">
        <h3>{name}</h3>
        <span className="small muted" style={{ flex: 1 }}>{role}</span>
        <span className="small muted nowrap">
          {plural(events.length, "event")}
          {ms > 0 && ` · ${(ms / 1000).toFixed(1)} s`}
          {blocked > 0 && ` · ${blocked} flagged`}
        </span>
      </div>
      {models.length > 0 && (
        <p className="tiny muted" style={{ padding: "6px 16px 0" }}>
          Models: {models.join(", ")}
        </p>
      )}
      {events.length === 0 ? (
        <p className="small muted" style={{ padding: "8px 16px" }}>
          No events this run.
        </p>
      ) : (
        <ul className="tl">
          {shown.map((e) => (
            <li key={e.seq}>
              <span className="ts">{fmtTime(e.ts)}</span>
              <span title={e.status} style={{ paddingTop: 6 }}>
                <span className={`dot ${e.status === "ok" ? "dot-ok" : e.status === "blocked" ? "dot-warn" : e.status === "error" ? "dot-bad" : ""}`} aria-hidden="true" />
                <span className="sr-only">{e.status}</span>
              </span>
              <div style={{ minWidth: 0 }}>
                <span className="mono tiny" style={{ color: "var(--ink-2)" }}>
                  {e.action}
                </span>
                {e.target && <span className="tiny muted"> to {e.target}</span>}
                {e.model && <span className="badge badge-accent" style={{ marginLeft: 6 }}>model {e.model}</span>}
                {e.durationMs !== undefined && <span className="tiny muted"> · {e.durationMs} ms</span>}
                <div className="wrap-anywhere">{e.summary}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {events.length > 6 && (
        <div style={{ padding: "4px 16px 12px" }}>
          <button type="button" className="btn btn-sm" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${events.length} ${name} events`}
          </button>
        </div>
      )}
    </div>
  );
}

function DqView({ sm, usl }: { sm: Summary; usl?: Usl }) {
  const exprOf = new Map((usl?.rules ?? []).map((r) => [r.name, r.expr]));
  return (
    <ul className="list">
      {sm.dq.map((d) => (
        <li key={d.rule}>
          <div className="spread">
            <div className="row">
              <span className="mono small strong">{d.rule}</span>
              <span className="tiny muted">on usl.{d.table}</span>
              <SourceBadge table={d.table} />
            </div>
            {d.invalid > 0 ? (
              <span className="badge badge-warn">{plural(d.invalid, "invalid row")}</span>
            ) : (
              <span className="badge badge-ok">0 invalid rows</span>
            )}
          </div>
          <p className="small" style={{ marginTop: 4 }}>
            {d.why}
          </p>
          {exprOf.get(d.rule) && (
            <p className="small muted" style={{ marginTop: 4 }}>
              Rows must satisfy: <code>{exprOf.get(d.rule)}</code>
            </p>
          )}
          {d.sample.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <Disclosure id={`dq-${d.rule}`} summary={`Show ${d.sample.length} sample rows`}>
                <EvidenceTable rows={d.sample} caption={`Rows failing ${d.rule}`} />
              </Disclosure>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function UslView({ usl }: { usl: Usl }) {
  return (
    <ul className="list">
      {Object.entries(usl.ddl).map(([table, ddl]) => (
        <li key={table}>
          <div className="spread">
            <div className="row">
              <span className="mono small strong">usl.{table}</span>
              {SOURCE_OF_TABLE[table] ? <SourceBadge table={table} /> : <span className="badge">Trial registry</span>}
            </div>
            <span className="small muted">{plural(usl.counts[table] ?? 0, "row")}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <Disclosure id={`ddl-${table}`} summary="Show DDL">
              <CodeBlock code={ddl} label={`DDL for ${table}`} />
            </Disclosure>
          </div>
        </li>
      ))}
    </ul>
  );
}
