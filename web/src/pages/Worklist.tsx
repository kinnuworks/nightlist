// Morning worklist: what the overnight screen found, what changed, which patients are one
// data item away from more trials, and the full patient list.
import { useMemo, useRef, useState } from "react";
import { getSummary, getWorklist } from "../api";
import { RequestItem } from "../components/RequestItem";
import { Disclosure, ErrorView, IconTissue, Loading, NewChip, StatusChip } from "../components/ui";
import { fmtDate, href, miles, navigate, plural, sexShort, useLoad } from "../lib";
import type { OneItemAway, Overnight, Summary, Worklist, WorklistPatient } from "../types";

type StatusFilter = "any" | "clean" | "open" | "none";
type Sort = "priority" | "name" | "distance";

export function WorklistPage({ query }: { query: URLSearchParams }) {
  const wl = useLoad(getWorklist, []);
  const sm = useLoad(getSummary, []);
  if (wl.error) return <ErrorView error={wl.error} retry={wl.reload} />;
  if (sm.error) return <ErrorView error={sm.error} retry={sm.reload} />;
  if (!wl.data || !sm.data) return <Loading label="Loading the morning worklist" />;
  return <WorklistView worklist={wl.data} summary={sm.data} query={query} />;
}

function WorklistView({ worklist, summary, query }: { worklist: Worklist; summary: Summary; query: URLSearchParams }) {
  const listRef = useRef<HTMLElement>(null);
  const awayRef = useRef<HTMLElement>(null);
  const [q, setQ] = useState(query.get("q") ?? "");
  const [onlyNew, setOnlyNew] = useState(query.get("filter") === "new");
  const [onlyAway, setOnlyAway] = useState(query.get("filter") === "away");
  const [status, setStatus] = useState<StatusFilter>((query.get("status") as StatusFilter) ?? "any");
  const [sort, setSort] = useState<Sort>("priority");
  const [shown, setShown] = useState(20);

  const awayByPatient = useMemo(() => {
    const m = new Map<string, OneItemAway[]>();
    for (const a of worklist.oneItemAway) m.set(a.patientId, [...(m.get(a.patientId) ?? []), a]);
    return m;
  }, [worklist]);
  const byId = useMemo(() => new Map(worklist.patients.map((p) => [p.patientId, p])), [worklist]);

  const withTrials = worklist.patients.filter((p) => p.matches.length > 0);
  const newPairs = worklist.patients.reduce((a, p) => a + p.matches.filter((m) => m.isNew).length, 0);
  const newCount = Math.max(summary.newMatches ?? 0, newPairs);
  const dqRows = summary.dq.reduce((a, d) => a + d.invalid, 0);
  const dqRules = summary.dq.filter((d) => d.invalid > 0).length;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let ps = worklist.patients.filter((p) => {
      if (onlyNew && !p.matches.some((m) => m.isNew)) return false;
      if (onlyAway && !awayByPatient.has(p.patientId)) return false;
      const best = p.matches[0]?.status;
      if (status === "clean" && best !== "eligible_no_blockers") return false;
      if (status === "open" && best !== "possible_unknowns") return false;
      if (status === "none" && p.matches.length > 0) return false;
      if (needle) {
        const hay = [p.name, p.patientId, p.story ?? "", p.zip, ...p.matches.map((m) => `${m.nctId} ${m.title ?? ""}`)].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    ps = [...ps].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "distance") return a.milesToClinic - b.milesToClinic;
      return priority(b) - priority(a) || a.patientId.localeCompare(b.patientId);
    });
    return ps;
  }, [worklist, q, onlyNew, onlyAway, status, sort, awayByPatient]);

  const scrollTo = (el: HTMLElement | null) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };

  return (
    <div className="stack-lg">
      <section className="page-head" aria-labelledby="wl-title">
        <span className="eyebrow">Morning worklist</span>
        <h1 id="wl-title">
          Overnight screen · {fmtDate(summary.asOf)} · {plural(summary.trialsScreened, "trial")} · {plural(summary.patients, "patient")}
        </h1>
        <p className="lede">
          Last night every recruiting lung cancer trial within reach of the clinic was compared with every patient on file.
          This list is for a coordinator to review. It does not decide eligibility; each match shows what was checked, what
          could not be checked, and the record behind every answer.
        </p>
      </section>

      <ol className="flow" aria-label="How the overnight screen works">
        <li className="flow-step">
          <b><span className="num">1</span>Read public trial text</b>
          {summary.trialsInSnapshot} recruiting trials from ClinicalTrials.gov; {summary.trialsScreened} have a site nearby.
        </li>
        <li className="flow-step">
          <b><span className="num">2</span>Compile each criterion</b>
          into a typed check. The model sees trial text only, never patient data.
        </li>
        <li className="flow-step">
          <b><span className="num">3</span>Run checks as SQL</b>
          inside the data layer over clinic records: met, not met, or unknown.
        </li>
        <li className="flow-step">
          <b><span className="num">4</span>Coordinator review</b>
          Unknown answers name the data item to obtain.
        </li>
      </ol>

      <div className="stats" role="group" aria-label="Overnight results">
        <button type="button" className="stat" onClick={() => { setStatus("any"); setOnlyNew(false); setOnlyAway(false); setQ(""); scrollTo(listRef.current); }}>
          <span className="stat-num">{withTrials.length}</span>
          <span className="stat-label">Patients with trials to review</span>
          <span className="stat-hint">of {summary.patients} screened · open the list</span>
        </button>
        <button type="button" className="stat" aria-pressed={onlyNew} onClick={() => { setOnlyNew(!onlyNew); setOnlyAway(false); scrollTo(listRef.current); }}>
          <span className="stat-num">{newCount}</span>
          <span className="stat-label">New matches since last night</span>
          <span className="stat-hint">{onlyNew ? "Filter on · click to clear" : "Filter the list to new matches"}</span>
        </button>
        <button type="button" className="stat" onClick={() => scrollTo(awayRef.current)}>
          <span className="stat-num">{awayByPatient.size}</span>
          <span className="stat-label">Patients one data item away</span>
          <span className="stat-hint">one missing item would open 2 or more trials</span>
        </button>
        <button type="button" className="stat" onClick={() => navigate(href.run("dq"))}>
          <span className="stat-num">{dqRows}</span>
          <span className="stat-label">Data-quality issues found</span>
          <span className="stat-hint">rows set aside by {plural(dqRules, "rule")} · see rules and rows</span>
        </button>
      </div>

      <div className="grid-2">
        <OvernightPanel overnight={worklist.overnight} byId={byId} />
        <section ref={awayRef} tabIndex={-1} className="card" aria-labelledby="away-title" id="one-item-away">
          <OneItemAwayPanel entries={worklist.oneItemAway} byId={byId} />
        </section>
      </div>

      <section ref={listRef} tabIndex={-1} className="card" aria-labelledby="pl-title" id="patients">
        <div className="card-head">
          <div>
            <h2 id="pl-title">Patients</h2>
            <p>Best match first. Each row also says why the other trials were blocked.</p>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 10, borderBottom: "1px solid var(--border)" }}>
          <div className="toolbar">
            <label className="sr-only" htmlFor="pl-search">Search patients</label>
            <input
              id="pl-search"
              className="input"
              type="search"
              placeholder="Search name, patient ID, NCT number, trial title"
              value={q}
              onChange={(e) => { setQ(e.target.value); setShown(20); }}
            />
            <label className="sr-only" htmlFor="pl-status">Best status</label>
            <select id="pl-status" className="select" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setShown(20); }}>
              <option value="any">Any best status</option>
              <option value="clean">Best: no blockers found</option>
              <option value="open">Best: open items</option>
              <option value="none">No trials to review</option>
            </select>
            <label className="sr-only" htmlFor="pl-sort">Sort</label>
            <select id="pl-sort" className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="priority">Sort: priority</option>
              <option value="name">Sort: name</option>
              <option value="distance">Sort: distance to clinic</option>
            </select>
          </div>
          <div className="toolbar">
            <button type="button" className="toggle" aria-pressed={onlyNew} onClick={() => { setOnlyNew(!onlyNew); setShown(20); }}>
              Has new match <span className="count">{worklist.patients.filter((p) => p.matches.some((m) => m.isNew)).length}</span>
            </button>
            <button type="button" className="toggle" aria-pressed={onlyAway} onClick={() => { setOnlyAway(!onlyAway); setShown(20); }}>
              One data item away <span className="count">{awayByPatient.size}</span>
            </button>
            <span className="small muted" aria-live="polite" style={{ marginLeft: "auto" }}>
              Showing {Math.min(shown, filtered.length)} of {plural(filtered.length, "patient")}
            </span>
          </div>
        </div>
        {filtered.length === 0 ? (
          <p className="empty">No patients match these filters.</p>
        ) : (
          <ul className="list">
            {filtered.slice(0, shown).map((p) => (
              <PatientRow key={p.patientId} p={p} away={awayByPatient.get(p.patientId)} />
            ))}
          </ul>
        )}
        {filtered.length > shown && (
          <div className="card-foot">
            <button type="button" className="btn" onClick={() => setShown(shown + 20)}>
              Show {Math.min(20, filtered.length - shown)} more
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// "Comprehensive NGS panel (EGFR, ALK, ...); plasma ctDNA ..." -> "Comprehensive NGS panel"
export function shortItem(label: string) {
  return label.split(/\s*[;(]|\s+on\s+/)[0].trim();
}

function priority(p: WorklistPatient) {
  const best = p.matches[0];
  if (!best) return -1;
  return (p.matches.some((m) => m.isNew) ? 1000 : 0) + best.specificity * 50 + (best.status === "eligible_no_blockers" ? 20 : 0) + Math.min(p.counts.eligible, 19);
}

function PatientRow({ p, away }: { p: WorklistPatient; away?: OneItemAway[] }) {
  const best = p.matches[0];
  const newCount = p.matches.filter((m) => m.isNew).length;
  return (
    <li>
      <div className="prow">
        <div>
          <a className="prow-name" href={href.patient(p.patientId)}>
            {p.name}
          </a>
          <div className="prow-meta">
            {p.patientId} · {p.age} {sexShort(p.sex)} · ECOG {p.ecog ?? "not recorded"} · {miles(p.milesToClinic)} from clinic
          </div>
          {p.story && <div className="prow-story">{p.story}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            {newCount > 0 && <NewChip />}
            {away?.map((a) => (
              <span key={a.item} className="badge badge-warn badge-wrap" title={`${a.label}; would open ${a.trials.length} trials`}>
                One data item away: {shortItem(a.label)}
              </span>
            ))}
          </div>
        </div>
        <div className="prow-best">
          {best ? (
            <>
              <div className="row">
                <StatusChip status={best.status} />
                {best.isNew && <NewChip />}
                <span className="small muted">
                  <a href={href.trial(best.nctId)}>{best.nctId}</a> · nearest site {miles(best.nearestMiles)}
                </span>
              </div>
              <a className="title" href={href.match(p.patientId, best.nctId)} title="Open the criteria, SQL and source rows for this match">
                {best.title ?? best.nctId}
              </a>
              <div className="small muted">
                {best.met} met
                {best.unknown > 0 && <> · {best.unknown} unknown (to obtain: {best.unknowns.flatMap((u) => u.items ?? []).map((i) => shortItem(i.label)).filter((v, i, a) => a.indexOf(v) === i).join("; ") || "data item missing"})</>}
                {" · "}
                {best.screening + best.review} not checked from records
              </div>
            </>
          ) : (
            <span className="small muted">No trials to review. Every nearby trial has at least one criterion not met.</span>
          )}
        </div>
        <div>
          <div className="counts" aria-label="Trials by status">
            <a href={href.patient(p.patientId)} title="No blocking criteria found">
              <b>{p.counts.eligible}</b> no blockers
            </a>
            <a href={href.patient(p.patientId)} title="Open items: at least one criterion unknown">
              <b>{p.counts.possible}</b> open items
            </a>
            <span title="At least one criterion not met">
              <b>{p.counts.blocked}</b> blocked
            </span>
          </div>
          {p.topBlockers.length > 0 && (
            <div className="blockers">
              Others blocked by:
              <ul>
                {p.topBlockers.map((b) => (
                  <li key={b.reason}>
                    {b.reason} <span className="nowrap">({plural(b.trials, "trial")})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function OvernightPanel({ overnight, byId }: { overnight: Overnight; byId: Map<string, WorklistPatient> }) {
  const groups = overnight.groups ?? [];
  return (
    <section className="card" aria-labelledby="on-title">
      <div className="card-head">
        <div>
          <h2 id="on-title">What changed overnight</h2>
          <p>Events recorded by the World Model, each with where it came from.</p>
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="card-body stack" style={{ gap: 8 }}>
          <p className="small">No trial, patient fact or match changes were recorded since the previous run.</p>
          <p className="small muted">
            Compared against {overnight.since ? <span className="mono tiny">{overnight.since}</span> : "the previous run"}. Trial openings, amendments,
            closures, new lab and biomarker results, and new or dropped matches appear here.
          </p>
          <p className="small">
            <a href={href.run("trace")}>See the Watcher and Navigator steps in the run trace</a>
          </p>
        </div>
      ) : (
        <div>
          {groups.map((g, gi) => (
            <div key={g.kind}>
              <div className="section-label">
                <span>{g.label}</span>
                <span>{g.count}</span>
              </div>
              <ul className="list">
                {g.items.slice(0, 4).map((it, i) => (
                  <ChangeRow key={it.eventId ?? i} it={it} byId={byId} />
                ))}
              </ul>
              {g.items.length > 4 && (
                <div style={{ padding: "0 16px 12px" }}>
                  <Disclosure id={`on-more-${gi}`} summary={`Show ${g.items.length - 4} more`}>
                    <ul className="list">
                      {g.items.slice(4).map((it, i) => (
                        <ChangeRow key={it.eventId ?? i} it={it} byId={byId} />
                      ))}
                    </ul>
                  </Disclosure>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ChangeRow({ it, byId }: { it: Overnight["groups"][number]["items"][number]; byId: Map<string, WorklistPatient> }) {
  const p = it.patientId ? byId.get(it.patientId) : undefined;
  const link = it.patientId && it.nctId ? href.match(it.patientId, it.nctId) : it.patientId ? href.patient(it.patientId) : it.nctId ? href.trial(it.nctId) : undefined;
  const pv = it.provenance;
  return (
    <li>
      <div className="small">{link ? <a href={link}>{it.summary}</a> : it.summary}</div>
      <div className="tiny muted">
        {p && <>{p.name} · </>}
        Source: {pv?.source ?? "unknown"}
        {pv?.observedAt && <> · observed {fmtDate(pv.observedAt)}</>}
        {pv?.by && <> · by {pv.by}</>}
        {pv?.url && (
          <>
            {" · "}
            <a href={pv.url} target="_blank" rel="noreferrer">
              record
            </a>
          </>
        )}
      </div>
    </li>
  );
}

function OneItemAwayPanel({ entries, byId }: { entries: OneItemAway[]; byId: Map<string, WorklistPatient> }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, 6);
  return (
    <>
      <div className="card-head">
        <div>
          <h2 id="away-title">One data item away</h2>
          <p>One missing item is the only open question for 2 or more trials.</p>
        </div>
        <span className="small muted">
          {plural(entries.length, "item")} for {plural(new Set(entries.map((e) => e.patientId)).size, "patient")}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="empty">No patient is one data item away from multiple trials.</p>
      ) : (
        <ul className="list">
          {shown.map((e) => {
            const p = byId.get(e.patientId);
            return (
              <li key={`${e.patientId}-${e.item}`}>
                <div className="spread">
                  <a className="strong" href={href.patient(e.patientId)}>
                    {p?.name ?? e.patientId}
                  </a>
                  <span className="small muted">{e.patientId}</span>
                </div>
                <div className="small" style={{ marginTop: 2 }}>
                  {e.label}
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="badge badge-accent">Would open {plural(e.trials.length, "trial")}</span>
                  {e.needsTissue ? (
                    <span className="badge badge-warn">
                      <IconTissue />
                      Needs tissue
                    </span>
                  ) : (
                    <span className="badge">No tissue needed</span>
                  )}
                </div>
                <div style={{ marginTop: 6 }}>
                  <Disclosure id={`away-${e.patientId}-${e.item}`} summary={`Which ${e.trials.length} trials`}>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {e.trials.map((n) => (
                        <li key={n}>
                          <a href={href.match(e.patientId, n)}>{n}</a>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                </div>
                <div style={{ marginTop: 8 }}>
                  <RequestItem entry={e} patientName={p?.name ?? e.patientId} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {entries.length > 6 && (
        <div className="card-foot">
          <button type="button" className="btn btn-sm" onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? "Show fewer" : `Show all ${entries.length}`}
          </button>
        </div>
      )}
    </>
  );
}
