// Patient page: identity, facts grouped by the system they came from, ranked matches,
// matches set aside by remembered decisions, and the coordinator memory with its audit trail.
import { useState, type ReactNode } from "react";
import { getMemory, getPatient, postMemory, STATIC } from "../api";
import { Disclosure, ErrorView, Loading, NewChip, SourceBadge, StaticNote, StatusChip } from "../components/ui";
import { cell, fmtDate, fmtDateTime, href, miles, phaseLabel, plural, sexShort, useLoad } from "../lib";
import type { MemoryInput, MemoryRecord, PatientDetail, ReviewQueueItem, Row } from "../types";

export function PatientPage({ pid }: { pid: string }) {
  const res = useLoad(() => getPatient(pid), [pid]);
  if (res.error) return <ErrorView error={res.error} retry={res.reload} />;
  if (!res.data) return <Loading label="Loading patient" />;
  return <PatientView d={res.data} />;
}

function PatientView({ d }: { d: PatientDetail }) {
  const p = d.patient;
  const w = d.worklist;
  const name = `${p.given_name ?? ""} ${p.family_name ?? ""}`.trim() || p.patient_id;
  const needsReview = w ? (w.counts.needsReview ?? w.matches.filter((m) => m.status === "needs_review").length) : 0;
  return (
    <div className="stack-lg">
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href={href.home()}>Worklist</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{name}</span>
      </nav>
      <section className="page-head" aria-labelledby="pt-title">
        <span className="eyebrow">Patient</span>
        <h1 id="pt-title">{name}</h1>
        <p className="small" style={{ color: "var(--ink-2)" }}>
          {p.patient_id} · MRN {p.mrn ?? "n/a"} · {p.age_years} {sexShort(p.sex)} · born {fmtDate(p.birth_date)} · ZIP {p.zip} ({miles(p.miles_to_clinic)} from clinic) · ECOG{" "}
          {p.ecog ?? "not recorded"}
          {p.ecog_date ? ` (${fmtDate(p.ecog_date)})` : ""}
        </p>
        {p.demo_story && <p className="lede">{p.demo_story}</p>}
        {w && (
          <p className="small muted">
            {plural(w.counts.eligible, "trial")} with no blocking criteria found
            {needsReview > 0 && <> · {needsReview} where a key criterion needs a human read</>} · {w.counts.possible} with open items · {w.counts.blocked} blocked
          </p>
        )}
      </section>

      <div className="grid-main-side">
        <div className="stack">
          <ReviewQueueCard d={d} />
          <MatchesCard d={d} />
          <SetAsideCard d={d} />
        </div>
        <div className="stack">
          <FactsCard d={d} />
          <MemoryPanel pid={p.patient_id} matches={w?.matches.map((m) => m.nctId) ?? []} />
        </div>
      </div>
    </div>
  );
}

// The sentences a person has to read to settle the top trials, grouped by trial in rank order.
function ReviewQueueCard({ d }: { d: PatientDetail }) {
  const w = d.worklist;
  const queue = w?.reviewQueue;
  const ruledOut = w?.ruledOut;
  if (!w || (queue === undefined && ruledOut === undefined)) return null;
  const titles = new Map(w.matches.map((m) => [m.nctId, m.title ?? m.nctId]));
  const groups: { nctId: string; items: ReviewQueueItem[] }[] = [];
  for (const it of queue ?? []) {
    let g = groups.find((x) => x.nctId === it.nctId);
    if (!g) {
      g = { nctId: it.nctId, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  const n = queue?.length ?? 0;
  const topN = groups.length;
  return (
    <section className="card" aria-labelledby="rq-title">
      <div className="card-head">
        <div>
          <h2 id="rq-title">
            {n === 0
              ? "Nothing left to read for the top trials"
              : `To settle this patient's top ${topN === 1 ? "trial" : `${topN} trials`}, read ${n === 1 ? "this sentence" : `these ${n} sentences`}`}
          </h2>
          <p>These criteria could not be checked from records, so a person has to read them. Each title opens the full match with its evidence.</p>
        </div>
      </div>
      {groups.map((g) => (
        <div key={g.nctId} className="rq-trial">
          <a className="strong wrap-anywhere" href={href.match(w.patientId, g.nctId)} style={{ color: "var(--ink)" }}>
            {titles.get(g.nctId) ?? g.nctId}
          </a>
          <div className="tiny muted">
            <a href={href.trial(g.nctId)}>{g.nctId}</a> · {plural(g.items.length, "sentence")}
          </div>
          <ol>
            {g.items.map((it) => (
              <li key={it.criterionId}>
                {it.text} <span className="mono tiny muted nowrap">{it.criterionId}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
      {ruledOut !== undefined && (
        <div className="card-foot small stack" style={{ gap: 6 }}>
          <span>
            <span className="strong">{plural(ruledOut, "trial")} ruled out with evidence</span>
            <span className="muted"> · each has a criterion not met, backed by a source row</span>
          </span>
          {w.topBlockers.length > 0 && (
            <Disclosure id="rq-ruled-out" summary="Show the most common reasons">
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {w.topBlockers.map((b) => (
                  <li key={b.reason}>
                    {b.reason} ({plural(b.trials, "trial")})
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </section>
  );
}

const MATCH_LIMIT = 10;

function MatchesCard({ d }: { d: PatientDetail }) {
  const w = d.worklist;
  const ms = w?.matches ?? [];
  const [all, setAll] = useState(false);
  const shown = all ? ms : ms.slice(0, MATCH_LIMIT);
  return (
    <section className="card" aria-labelledby="pm-title">
      <div className="card-head">
        <div>
          <h2 id="pm-title">Ranked matches</h2>
          <p>Ranked by how many disease-specific criteria were met, then status, coverage and distance.</p>
        </div>
      </div>
      {ms.length === 0 ? (
        <p className="empty">No trials to review. Every nearby trial has at least one criterion not met.</p>
      ) : (
        <ol className="list">
          {shown.map((m, i) => (
            <li key={m.nctId}>
              <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap", gap: 12 }}>
                <span className="mono tiny muted" style={{ paddingTop: 3, minWidth: 18 }} aria-hidden="true">
                  {i + 1}
                </span>
                <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                  <div className="row">
                    <StatusChip status={m.status} />
                    {m.isNew && <NewChip />}
                    <span className="small muted">
                      <a href={href.trial(m.nctId)}>{m.nctId}</a> · {phaseLabel(m.phase)} · nearest site {miles(m.nearestMiles)}
                    </span>
                  </div>
                  <a href={href.match(w!.patientId, m.nctId)} className="strong wrap-anywhere" style={{ color: "var(--ink)" }}>
                    {m.title ?? m.nctId}
                  </a>
                  <div className="small muted">
                    {m.status === "eligible_no_blockers"
                      ? `No blocking criteria found in ${m.met} checked criteria`
                      : m.status === "needs_review"
                        ? `No blocking criteria found in ${m.met} checked criteria, but ${plural(m.keyReview?.length || 1, "key criterion", "key criteria")} must be read by a person`
                        : `${m.met} met, ${m.unknown} unknown`}
                    {" · "}
                    {m.screening} for the screening visit · {m.review} need a human read · {Math.round(m.coverage * 100)}% of criteria checked from records
                  </div>
                  {m.unknowns.length > 0 && (
                    <div className="small">
                      To obtain:{" "}
                      {[...new Map(m.unknowns.flatMap((u) => u.items ?? []).map((it) => [it.id, it])).values()].map((it, j) => (
                        <span key={it.id}>
                          {j > 0 && "; "}
                          {it.label}
                          {it.needsTissue && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Needs tissue</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.verified && !m.verified.ok && <p className="note note-warn small">Verifier: {m.verified.notes.join("; ")}</p>}
                  {m.notes?.map((n) => (
                    <p key={n} className="note small">
                      {n}
                    </p>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {ms.length > MATCH_LIMIT && (
        <div className="card-foot">
          <button type="button" className="btn btn-sm" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? `Show top ${MATCH_LIMIT}` : `Show all ${ms.length}`}
          </button>
        </div>
      )}
      {w && w.topBlockers.length > 0 && (
        <div className="card-foot small">
          <span className="muted">Most common reasons other trials are blocked: </span>
          {w.topBlockers.map((b, i) => (
            <span key={b.reason}>
              {i > 0 && "; "}
              {b.reason} ({plural(b.trials, "trial")})
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function SetAsideCard({ d }: { d: PatientDetail }) {
  const sa = d.worklist?.setAside ?? [];
  return (
    <section className="card" aria-labelledby="sa-title">
      <div className="card-head">
        <div>
          <h2 id="sa-title">Set aside by remembered decisions</h2>
          <p>Matches hidden from the list because of a preference or decision stored in H-MEM memory.</p>
        </div>
      </div>
      {sa.length === 0 ? (
        <p className="empty">Nothing set aside. Add a preference below (for example a travel limit) and it applies at the next overnight run.</p>
      ) : (
        <ul className="list">
          {sa.map((s) => (
            <li key={s.nctId}>
              <a href={href.match(d.patient.patient_id, s.nctId)}>{s.nctId}</a>
              <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {s.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FactGroup({ title, badge, children }: { title: string; badge: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="section-label" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--ink-2)" }}>
        <span>{title}</span>
        {badge}
      </div>
      <div style={{ padding: "10px 16px" }}>{children}</div>
    </div>
  );
}

function latestByAnalyte(labs: Row[]) {
  const seen = new Set<string>();
  return labs.filter((l) => {
    const k = String(l.analyte);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function FactsCard({ d }: { d: PatientDetail }) {
  const labs = latestByAnalyte(d.labs);
  return (
    <section className="card" aria-labelledby="facts-title">
      <div className="card-head">
        <div>
          <h2 id="facts-title">Facts on file</h2>
          <p>Grouped by the system each fact came from.</p>
        </div>
      </div>
      <FactGroup title="Diagnosis and disease" badge={<SourceBadge label="EHR" />}>
        <div className="stack" style={{ gap: 8 }}>
          {d.diagnosis.map((x) => (
            <div key={String(x.dx_id)} className="small">
              <div className="strong">{cell(x.diagnosis_text)}</div>
              <div className="row" style={{ marginTop: 2 }}>
                <span>
                  ICD-10 {cell(x.icd10)} · stage {cell(x.stage)} · measurable disease {x.measurable_disease === "Y" ? "yes" : cell(x.measurable_disease)} · diagnosed {fmtDate(x.diagnosis_date as string)}
                </span>
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <span>Histology: {cell(x.histology)}</span>
                {x.histology_ncit ? <SourceBadge label={`NCI Thesaurus ${x.histology_ncit}`} /> : null}
              </div>
            </div>
          ))}
          {d.metastases.length > 0 && (
            <div className="small">
              Metastases: {d.metastases.map((m) => `${m.site} (${m.status}, ${fmtDate(m.noted_date as string)})`).join("; ")}
            </div>
          )}
          <div className="small">
            Problem list: {d.conditions.length ? d.conditions.map((c) => `${c.description} (${c.icd10})`).join("; ") : "none recorded"}
          </div>
        </div>
      </FactGroup>
      <FactGroup title="Molecular results" badge={<SourceBadge label="Lab system" />}>
        {d.biomarkers.length === 0 ? (
          <p className="small note note-warn">No molecular testing on file.</p>
        ) : (
          <div className="table-wrap">
            <table className="t compact">
              <caption className="sr-only">Molecular results</caption>
              <thead>
                <tr>
                  <th scope="col">Gene</th>
                  <th scope="col">Result</th>
                  <th scope="col">Reported</th>
                </tr>
              </thead>
              <tbody>
                {d.biomarkers.map((b) => (
                  <tr key={String(b.result_key)}>
                    <td className="strong">{cell(b.gene)}</td>
                    <td>
                      {b.gene === "PDL1" ? `TPS ${cell(b.tps)}%` : b.status === "detected" ? <b>detected{b.alteration ? ` ${b.alteration}` : ""}</b> : String(b.status).replace("_", " ")}
                    </td>
                    <td className="nowrap">{fmtDate(b.reported_date as string)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.biomarkers[0] && <p className="tiny muted" style={{ marginTop: 6 }}>Assay: {[...new Set(d.biomarkers.map((b) => b.assay))].join("; ")}</p>}
      </FactGroup>
      <FactGroup title="Recent labs (latest per test)" badge={<SourceBadge label="Lab system" />}>
        {labs.length === 0 ? (
          <p className="small muted">No labs on file.</p>
        ) : (
          <div className="table-wrap">
            <table className="t compact">
              <caption className="sr-only">Recent labs</caption>
              <thead>
                <tr>
                  <th scope="col">Test</th>
                  <th scope="col" className="num">Value</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Collected</th>
                </tr>
              </thead>
              <tbody>
                {labs.map((l) => (
                  <tr key={String(l.accession)}>
                    <td>{cell(l.analyte)}</td>
                    <td className="num">{cell(l.value)}</td>
                    <td className={l.unit ? "" : "null"}>{l.unit ? String(l.unit) : <span className="badge badge-warn">no unit</span>}</td>
                    <td className="nowrap">{fmtDate(l.collected_date as string)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FactGroup>
      <FactGroup title="Systemic therapy" badge={<SourceBadge label="RxNav-resolved medication" />}>
        {d.therapy.length === 0 ? (
          <p className="small muted">No systemic therapy on file.</p>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {d.therapy.map((t) => (
              <div key={String(t.med_order_id)} className="small">
                <div>
                  <span className="strong">{cell(t.ingredient)}</span> <span className="muted">from order "{cell(t.order_text)}"</span>
                </div>
                <div className="muted">
                  RxCUI {cell(t.rxcui)} · ATC {cell(t.atc_code)} · class {cell(t.therapy_class)} · line {cell(t.line_of_therapy)} ({cell(t.setting)}) · {fmtDate(t.start_date as string)} to{" "}
                  {t.end_date ? fmtDate(t.end_date as string) : "ongoing"}
                </div>
              </div>
            ))}
          </div>
        )}
      </FactGroup>
    </section>
  );
}

const KINDS: MemoryInput["kind"][] = ["preference", "decision", "correction", "fact"];

export function MemoryPanel({ pid, matches, trialId }: { pid: string; matches: string[]; trialId?: string }) {
  const mem = useLoad(() => getMemory(pid), [pid]);
  const [kind, setKind] = useState<MemoryInput["kind"]>("preference");
  const [text, setText] = useState("");
  const [trial, setTrial] = useState(trialId ?? "");
  const [actor, setActor] = useState("coordinator");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const list = mem.data ?? [];

  return (
    <section className="card" aria-labelledby="mem-title">
      <div className="card-head">
        <div>
          <h2 id="mem-title">Coordinator memory</h2>
          <p>Preferences and decisions stored in H-MEM. They apply at the next overnight run.</p>
        </div>
      </div>
      <form
        className="card-body stack"
        style={{ gap: 10 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          setMsg(null);
          try {
            await postMemory({ patientId: pid, trialId: trial || undefined, kind, text: text.trim(), actor: actor.trim() || "coordinator" });
            setText("");
            setMsg({ ok: true, text: "Recorded. It appears in the audit history below and applies at the next overnight run." });
            mem.reload();
          } catch (err) {
            setMsg({ ok: false, text: `Not recorded: ${(err as Error).message}` });
          } finally {
            setBusy(false);
          }
        }}
      >
        <StaticNote />
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            Kind
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryInput["kind"])} disabled={STATIC}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: "1 1 160px" }}>
            Trial (optional)
            <select className="select" value={trial} onChange={(e) => setTrial(e.target.value)} disabled={STATIC}>
              <option value="">All trials</option>
              {[...new Set([...(trialId ? [trialId] : []), ...matches])].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Note
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind === "preference" ? "Will not travel more than 100 miles" : kind === "decision" ? "Not interested in this trial; prefers oral therapy" : "Write the note"}
            maxLength={500}
            disabled={STATIC}
          />
        </label>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            Recorded by
            <input className="input" value={actor} onChange={(e) => setActor(e.target.value)} disabled={STATIC} style={{ width: 160 }} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={STATIC || busy || !text.trim()}>
            {busy ? "Recording" : "Record"}
          </button>
        </div>
        {msg && (
          <p className={`note small ${msg.ok ? "note-ok" : "note-bad"}`} role={msg.ok ? "status" : "alert"}>
            {msg.text}{" "}
            {msg.ok && <a href={href.run()}>Run the overnight screen now</a>}
          </p>
        )}
      </form>
      <div className="section-label">
        <span>Audit history</span>
        <span>{list.length}</span>
      </div>
      {mem.error ? (
        <p className="empty">Could not load memory: {mem.error.message}</p>
      ) : list.length === 0 ? (
        <p className="empty">{mem.loading ? "Loading" : "No memory recorded for this patient."}</p>
      ) : (
        <ul className="list">
          {[...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => (
            <MemoryItem key={r.id} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryItem({ r }: { r: MemoryRecord }) {
  const inactive = !!r.supersededBy || r.archived;
  return (
    <li>
      <div className="row">
        <span className="badge">{r.kind}</span>
        {r.trialId && <a className="small" href={href.trial(r.trialId)}>{r.trialId}</a>}
        {inactive && <span className="badge badge-outline">{r.archived ? "archived" : "superseded"}</span>}
      </div>
      <p className="small" style={{ marginTop: 4, textDecoration: inactive ? "line-through" : undefined }}>
        {r.text}
      </p>
      <p className="tiny muted">
        {r.actor ?? "unknown"} · {fmtDateTime(r.createdAt)} · <span className="mono">{r.id}</span>
      </p>
      {r.history && r.history.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <Disclosure id={`hist-${r.id}`} summary={`Audit trail (${r.history.length})`}>
            <ul className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
              {r.history.map((h) => (
                <li key={h.id}>
                  {h.action} by {h.actor} · {fmtDateTime(h.at)}
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </li>
  );
}
