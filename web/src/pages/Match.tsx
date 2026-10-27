// Match page (one patient against one trial). Every criterion with its verdict, the
// compiled check in plain words, how it was compiled and checked, and on expand the SQL
// and the source rows that decided it.
import { useMemo, useState } from "react";
import { getMatch, getPatient, getStatus } from "../api";
import {
  CheckBadge,
  CodeBlock,
  CopyButton,
  ErrorView,
  EvidenceTable,
  IconChevron,
  IconRead,
  IconTissue,
  Loading,
  MethodBadge,
  SourceBadge,
  StackBar,
  StatusChip,
  VerdictChip,
} from "../components/ui";
import { cell, fmtDate, href, miles, phaseLabel, plural, sexShort, tableOfSql, useLoad } from "../lib";
import type { CriterionResult, KeyReview, MatchDetail, NotChecked, PatientDetail, Status } from "../types";
import { MemoryPanel } from "./Patient";

export function MatchPage({ pid, nct }: { pid: string; nct: string }) {
  const m = useLoad(() => getMatch(pid, nct), [pid, nct]);
  const p = useLoad(() => getPatient(pid), [pid]);
  const s = useLoad(getStatus, []);
  if (m.error) return <ErrorView error={m.error} retry={m.reload} />;
  if (!m.data) return <Loading label="Loading match" />;
  return <MatchView m={m.data} patient={p.data} status={s.data} />;
}

// Key criteria come on the match itself or on the patient's worklist entry for this trial.
function keyReviewOf(m: MatchDetail, patient?: PatientDetail): KeyReview[] {
  if (m.keyReview?.length) return m.keyReview;
  return patient?.worklist?.matches.find((x) => x.nctId === m.nctId)?.keyReview ?? [];
}

function summarySentence(m: MatchDetail) {
  const checked = m.results.length;
  const notMet = m.results.filter((r) => r.verdict === "not_met").length;
  const unknown = m.results.filter((r) => r.verdict === "unknown").length;
  if (m.status === "eligible_no_blockers") return `No blocking criteria found in ${plural(checked, "checked criterion", "checked criteria")}.`;
  if (m.status === "needs_review")
    return `No blocking criteria found in ${plural(checked, "checked criterion", "checked criteria")}, but a disease-defining criterion could not be checked from records and needs a human read.`;
  if (m.status === "possible_unknowns")
    return `No blocking criteria found in ${checked} checked criteria, but ${plural(unknown, "criterion", "criteria")} could not be answered from records.`;
  return `${plural(notMet, "criterion", "criteria")} not met among ${checked} checked from records.`;
}

function MatchView({ m, patient, status }: { m: MatchDetail; patient?: PatientDetail; status?: Status }) {
  const [openAll, setOpenAll] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const t = m.trial;
  const name = patient ? `${patient.patient.given_name ?? ""} ${patient.patient.family_name ?? ""}`.trim() : m.patientId;
  const incl = m.results.filter((r) => r.kind === "inclusion");
  const excl = m.results.filter((r) => r.kind === "exclusion");
  const keyReview = keyReviewOf(m, patient);
  const keyIds = new Set(keyReview.map((k) => k.criterionId));
  const screening = m.notChecked.filter((x) => x.category === "screening" && !keyIds.has(x.criterionId));
  const review = m.notChecked.filter((x) => x.category === "review" && !keyIds.has(x.criterionId));
  const counts = {
    met: m.results.filter((r) => r.verdict === "met").length,
    notMet: m.results.filter((r) => r.verdict === "not_met").length,
    unknown: m.results.filter((r) => r.verdict === "unknown").length,
  };
  const items = useMemo(() => {
    const map = new Map<string, { label: string; needsTissue: boolean; standardOfCare?: boolean; criteria: string[] }>();
    for (const r of m.results.filter((x) => x.verdict === "unknown"))
      for (const it of r.items ?? []) {
        const e = map.get(it.id) ?? { label: it.label, needsTissue: it.needsTissue, standardOfCare: it.standardOfCare, criteria: [] };
        e.criteria.push(r.criterionId);
        map.set(it.id, e);
      }
    return [...map.values()];
  }, [m]);
  const nearest = [...(t.sites ?? [])].sort((a, b) => a.miles - b.miles)[0];

  return (
    <div className="stack-lg">
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href={href.home()}>Worklist</a>
        <span aria-hidden="true">/</span>
        <a href={href.patient(m.patientId)}>{name}</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{m.nctId}</span>
      </nav>

      <section className="page-head" aria-labelledby="mt-title">
        <span className="eyebrow">Patient and trial</span>
        <h1 id="mt-title" className="wrap-anywhere">{t.title}</h1>
        <p className="small" style={{ color: "var(--ink-2)" }}>
          <a href={href.trial(m.nctId)}>{m.nctId}</a> · {phaseLabel(t.phase)} · {t.sponsor ?? "sponsor not listed"} ·{" "}
          <a href={`https://clinicaltrials.gov/study/${m.nctId}`} target="_blank" rel="noreferrer">
            ClinicalTrials.gov record<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
        <p className="small" style={{ color: "var(--ink-2)" }}>
          For <a href={href.patient(m.patientId)}>{name}</a> ({m.patientId}
          {patient ? `, ${patient.patient.age_years} ${sexShort(patient.patient.sex)}` : ""})
          {patient?.patient.demo_story ? ` · ${patient.patient.demo_story}` : ""}
        </p>
      </section>

      <section className="card card-pad stack" aria-labelledby="ms-title" style={{ gap: 12 }}>
        <h2 id="ms-title" className="sr-only">Result</h2>
        <div className="row" style={{ gap: 12 }}>
          <StatusChip status={m.status} />
          <span className="strong">{summarySentence(m)}</span>
        </div>
        <p className="small" style={{ color: "var(--ink-2)" }}>
          This is a worklist result, not an eligibility decision. {plural(screening.length, "item")} {screening.length === 1 ? "is" : "are"} confirmed at the screening visit and{" "}
          {plural(review.length + keyReview.length, "criterion", "criteria")} {review.length + keyReview.length === 1 ? "needs" : "need"} a human read; both are listed below.
        </p>
        <div className="stack" style={{ gap: 6 }}>
          <StackBar
            label="All criteria for this trial"
            parts={[
              { value: counts.met, cls: "b-ok", label: "met" },
              { value: counts.unknown, cls: "b-warn", label: "unknown" },
              { value: counts.notMet, cls: "b-bad", label: "not met" },
              { value: m.notChecked.length, cls: "b-muted", label: "not checked from records" },
            ]}
          />
          <div className="row small muted" style={{ gap: 14 }}>
            <span><span className="dot dot-ok" aria-hidden="true" /> {counts.met} met</span>
            <span><span className="dot dot-warn" aria-hidden="true" /> {counts.unknown} unknown</span>
            <span><span className="dot dot-bad" aria-hidden="true" /> {counts.notMet} not met</span>
            <span><span className="dot" aria-hidden="true" style={{ background: "#9aa6b4" }} /> {m.notChecked.length} not checked from records</span>
            {nearest && <span>Nearest site {miles(nearest.miles)}: {nearest.facility}, {nearest.city}</span>}
          </div>
        </div>
        {items.length > 0 && (
          <div className="note note-warn stack" style={{ gap: 4 }}>
            <span className="strong">To answer the unknown criteria, obtain:</span>
            {items.map((it) => (
              <span key={it.label} className="row">
                {it.label}
                {it.needsTissue && (
                  <span className="badge badge-warn">
                    <IconTissue />
                    Needs tissue
                  </span>
                )}
                {it.standardOfCare && <span className="badge">Standard of care</span>}
                <span className="tiny">({it.criteria.join(", ")})</span>
              </span>
            ))}
          </div>
        )}
        {m.verified && (
          <p className={`note small ${m.verified.ok ? "note-ok" : "note-warn"}`}>
            Verifier {m.verified.ok ? "re-read the source rows and they hold up" : "flagged"}{m.verified.notes.length ? `: ${m.verified.notes.join("; ")}` : "."}
          </p>
        )}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setNote(referralNote(m, keyReview, patient, status))} aria-controls="referral">
            Draft referral note
          </button>
          <button type="button" className="btn" onClick={() => setOpenAll(openAll ? false : true)}>
            {openAll ? "Collapse all criteria" : "Expand all: SQL and source rows"}
          </button>
        </div>
        {note && (
          <div id="referral" className="stack" style={{ gap: 6 }}>
            <div className="spread">
              <label htmlFor="referral-text" className="strong small">
                Draft referral note (plain text, review before sending)
              </label>
              <div className="row">
                <CopyButton text={note} label="Copy note" />
                <button type="button" className="btn btn-sm" onClick={() => setNote(null)}>
                  Close
                </button>
              </div>
            </div>
            <textarea id="referral-text" className="textarea mono" readOnly value={note} rows={18} style={{ fontSize: 12.5 }} />
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="crit-title">
        <div className="card-head">
          <div>
            <h2 id="crit-title">Criteria checked from records</h2>
            <p>Original trial sentence, the compiled check in plain words, and how it was compiled. Expand a row for the SQL and source rows.</p>
          </div>
        </div>
        <CriteriaGroup title="Inclusion" rows={incl} openAll={openAll} kind="inclusion" />
        <CriteriaGroup title="Exclusion" rows={excl} openAll={openAll} kind="exclusion" />
      </section>

      <NotCheckedCard screening={screening} review={review} keyReview={keyReview} />

      <div className="grid-main-side">
        <SitesCard m={m} maxMiles={status?.clinic.maxMiles ?? 250} />
        <div className="stack">
          {m.memory.length > 0 && (
            <section className="card" aria-labelledby="mm-title">
              <div className="card-head">
                <h2 id="mm-title">Recalled for this pair</h2>
              </div>
              <ul className="list">
                {m.memory.map((r) => (
                  <li key={r.id} className="small">
                    <span className="badge">{r.kind}</span> {r.text}
                    <div className="tiny muted">
                      {r.actor} · {fmtDate(r.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <MemoryPanel pid={m.patientId} matches={[m.nctId]} trialId={m.nctId} />
        </div>
      </div>
    </div>
  );
}

function CriteriaGroup({ title, rows, openAll, kind }: { title: string; rows: CriterionResult[]; openAll: boolean | null; kind: string }) {
  return (
    <div>
      <div className="section-label">
        <span>
          {title} ({rows.length})
        </span>
        <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>
          {kind === "exclusion" ? "Met means the excluding condition was not found" : "Met means the requirement was found in records"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="empty">No {title.toLowerCase()} criteria were compiled into checks.</p>
      ) : (
        <div role="list">
          {rows.map((r, i) => (
            <CriterionRow key={r.criterionId} r={r} openAll={openAll} sameAs={sameAsEarlier(rows, i)} />
          ))}
        </div>
      )}
    </div>
  );
}

// The first earlier row with the same sentence and verdict, so repeated criteria read as one.
function sameAsEarlier(rows: CriterionResult[], i: number): string | undefined {
  const key = (r: CriterionResult) => `${(r.text ?? "").trim().toLowerCase()}|${r.verdict}`;
  const k = key(rows[i]);
  if (!rows[i].text) return undefined;
  return rows.slice(0, i).find((r) => key(r) === k)?.criterionId;
}

const TRI_LABEL = { T: "true", F: "false", U: "unknown" } as const;

function CriterionRow({ r, openAll, sameAs }: { r: CriterionResult; openAll: boolean | null; sameAs?: string }) {
  const [open, setOpen] = useState(false);
  const [lastAll, setLastAll] = useState(openAll);
  if (openAll !== lastAll) {
    setLastAll(openAll);
    if (openAll !== null) setOpen(openAll);
  }
  const id = `crit-${r.criterionId}`;
  return (
    <div className="crit" role="listitem">
      <div className="crit-row">
        <div>
          <VerdictChip verdict={r.verdict} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p className={`crit-text${open ? "" : " clamp"}`}>{r.text ?? r.criterionId}</p>
          {r.readable && (
            <p className="crit-rule">
              Compiled check: <code>{r.readable}</code>
            </p>
          )}
          <div className="crit-meta">
            <MethodBadge method={r.method} />
            <CheckBadge check={r.check} method={r.method} />
            <span className="tiny muted mono">{r.criterionId}</span>
            {sameAs && <span className="tiny muted">Same sentence and result as {sameAs}</span>}
          </div>
          {r.caveat && <p className="crit-caveat">Caveat: {r.caveat}</p>}
          {r.verdict === "unknown" && r.items && r.items.length > 0 && (
            <p className="crit-need">
              Obtain: {r.items.map((i) => `${i.label}${i.needsTissue ? " (needs tissue)" : ""}`).join("; ")}
            </p>
          )}
        </div>
        <div>
          <button type="button" className="btn btn-sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
            <IconChevron open={open} />
            {open ? "Hide" : "SQL and rows"}
          </button>
        </div>
      </div>
      {open && (
        <div className="crit-detail" id={id}>
          {r.check?.backTranslation && (
            <>
              <h4>Back-translation</h4>
              <p className="small">
                "{r.check.backTranslation}"{r.check.model && <span className="muted"> · model {r.check.model}</span>}
              </p>
            </>
          )}
          {r.check?.reason && r.check.status !== "agree" && <p className="small muted" style={{ marginTop: 10 }}>Check note: {r.check.reason}</p>}
          {r.leaves.map((l, i) => {
            const table = tableOfSql(l.evidenceSql);
            return (
              <div className="leaf" key={i}>
                <div className="leaf-head">
                  <span className={`tri tri-${l.value}`}>{TRI_LABEL[l.value]}</span>
                  <code>{l.readable}</code>
                  {table && <SourceBadge table={table} />}
                  {table && <span className="tiny muted mono">usl.{table}</span>}
                </div>
                <h4>Check expression (evaluated per patient p inside the data layer)</h4>
                <CodeBlock code={l.sql} label={`Check SQL for ${l.readable}`} />
                <h4>Evidence query</h4>
                <CodeBlock code={l.evidenceSql} label={`Evidence SQL for ${l.readable}`} />
                <h4>Source rows ({l.evidence.length})</h4>
                <EvidenceTable rows={l.evidence} caption={`Source rows for ${l.readable}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NotCheckedCard({ screening, review, keyReview }: { screening: NotChecked[]; review: NotChecked[]; keyReview: KeyReview[] }) {
  const total = screening.length + review.length + keyReview.length;
  return (
    <section className="card" aria-labelledby="nc-title">
      <div className="card-head">
        <div>
          <h2 id="nc-title">Not checked from records</h2>
          <p>{plural(total, "criterion", "criteria")} could not be checked from records. They are listed so nothing is silently skipped.</p>
        </div>
      </div>
      {keyReview.length > 0 && (
        <div className="card-body" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="note note-warn stack" style={{ gap: 6 }}>
            <h3 id="nc-key" className="row" style={{ gap: 6 }}>
              <span style={{ width: 16, height: 16, display: "inline-flex" }}>
                <IconRead />
              </span>
              Key criteria a person must read ({keyReview.length})
            </h3>
            <p className="small">These define the disease the trial is for. Records could not settle them, so a person has to read the chart.</p>
            <ul className="list" aria-labelledby="nc-key">
              {keyReview.map((k) => (
                <li key={k.criterionId} className="small" style={{ padding: "6px 0" }}>
                  {k.text} <span className="tiny muted mono">{k.criterionId}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="card-body grid-2">
        <NotCheckedColumn title="Screening visit" help="Confirmed in person: consent, contraception, pregnancy test, ability to swallow and similar." xs={screening} id="nc-screening" />
        <NotCheckedColumn title="Needs a human read" help="Requires clinical judgement or detail the records do not hold in structured form." xs={review} id="nc-review" />
      </div>
    </section>
  );
}

function NotCheckedColumn({ title, help, xs, id }: { title: string; help: string; xs: NotChecked[]; id: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? xs : xs.slice(0, 5);
  return (
    <div className="card" style={{ boxShadow: "none" }}>
      <div className="card-head">
        <div>
          <h3 id={id}>
            {title} ({xs.length})
          </h3>
          <p>{help}</p>
        </div>
      </div>
      {xs.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <ul className="list" aria-labelledby={id}>
          {shown.map((x) => (
            <li key={x.criterionId} className="small">
              <span className="badge badge-outline" style={{ marginRight: 6 }}>
                {x.kind}
              </span>
              {x.text}
              {x.caveat && <div className="crit-caveat">{x.caveat}</div>}
            </li>
          ))}
        </ul>
      )}
      {xs.length > 5 && (
        <div className="card-foot">
          <button type="button" className="btn btn-sm" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${xs.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

function SitesCard({ m, maxMiles }: { m: MatchDetail; maxMiles: number }) {
  const [all, setAll] = useState(false);
  const sites = [...(m.trial.sites ?? [])].sort((a, b) => a.miles - b.miles);
  const near = sites.filter((s) => s.miles <= maxMiles);
  const shown = all ? sites : near.length ? near.slice(0, 10) : sites.slice(0, 5);
  return (
    <section className="card" aria-labelledby="sites-title">
      <div className="card-head">
        <div>
          <h2 id="sites-title">Trial sites</h2>
          <p>
            {plural(near.length, "site")} within {maxMiles} miles of the clinic, of {sites.length} listed. Distance from the clinic.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <caption className="sr-only">Trial sites by distance</caption>
          <thead>
            <tr>
              <th scope="col">Facility</th>
              <th scope="col">City</th>
              <th scope="col" className="num">Distance</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s, i) => (
              <tr key={s.siteId ?? i}>
                <td>{s.facility}</td>
                <td className="nowrap">
                  {s.city}, {s.state}
                </td>
                <td className="num nowrap">{miles(s.miles)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sites.length > shown.length || all ? (
        <div className="card-foot">
          <button type="button" className="btn btn-sm" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show nearby sites only" : `Show all ${sites.length} sites`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ---------- referral note ----------

function evidenceLine(r: CriterionResult) {
  const parts: string[] = [];
  for (const l of r.leaves) {
    const row = l.evidence[0];
    if (!row) {
      parts.push(`${l.readable}: no source row`);
      continue;
    }
    const fields = Object.entries(row)
      .filter(([k, v]) => !["patient_id", "lab_mrn", "mrn", "given_name", "family_name"].includes(k) && v !== null && v !== undefined)
      .slice(0, 5)
      .map(([k, v]) => `${k}=${cell(v)}`)
      .join(", ");
    const table = tableOfSql(l.evidenceSql);
    parts.push(`${l.readable} [${table ? `usl.${table}` : "source"}: ${fields}${l.evidence.length > 1 ? `; +${l.evidence.length - 1} more rows` : ""}]`);
  }
  return parts.join(" | ");
}

function referralNote(m: MatchDetail, keyReview: KeyReview[], patient?: PatientDetail, status?: Status) {
  const t = m.trial;
  const p = patient?.patient;
  const dx = patient?.diagnosis[0];
  const nearest = [...(t.sites ?? [])].sort((a, b) => a.miles - b.miles)[0];
  const lines: string[] = [];
  const met = m.results.filter((r) => r.verdict === "met");
  const unknown = m.results.filter((r) => r.verdict === "unknown");
  const notMet = m.results.filter((r) => r.verdict === "not_met");
  lines.push("DRAFT: trial referral for coordinator review");
  lines.push(`Prepared ${new Date().toISOString().slice(0, 10)} from overnight screen ${status?.runId ?? ""}`.trim());
  lines.push("");
  lines.push(`Patient: ${p ? `${p.given_name} ${p.family_name}` : m.patientId} (${m.patientId}${p?.mrn ? `, MRN ${p.mrn}` : ""})`);
  if (p) lines.push(`Age/sex: ${p.age_years} ${p.sex}; ECOG ${p.ecog ?? "not recorded"}${p.ecog_date ? ` (${p.ecog_date})` : ""}; ZIP ${p.zip}`);
  if (dx) lines.push(`Diagnosis: ${dx.diagnosis_text}; stage ${dx.stage}; histology ${dx.histology}${dx.histology_ncit ? ` (NCIt ${dx.histology_ncit})` : ""}`);
  lines.push("");
  lines.push(`Trial: ${t.nctId} ${t.title}`);
  lines.push(`Phase: ${phaseLabel(t.phase)}; sponsor: ${t.sponsor ?? "not listed"}`);
  if (nearest) lines.push(`Nearest site: ${nearest.facility}, ${nearest.city}, ${nearest.state} (${Math.round(nearest.miles)} miles from clinic)`);
  lines.push("");
  lines.push(`Screen result: ${summarySentence(m)}`);
  lines.push("This is not an eligibility determination. Final eligibility is decided by the trial site.");
  lines.push("");
  lines.push(`Criteria met from records (${met.length}):`);
  for (const r of met) lines.push(`- [${r.kind}] ${r.text}\n    Evidence: ${evidenceLine(r)}`);
  if (notMet.length) {
    lines.push("");
    lines.push(`Criteria not met (${notMet.length}):`);
    for (const r of notMet) lines.push(`- [${r.kind}] ${r.text}\n    Evidence: ${evidenceLine(r)}`);
  }
  lines.push("");
  lines.push("Open items:");
  if (!unknown.length && !m.notChecked.length && !keyReview.length) lines.push("- None");
  const keyIds = new Set(keyReview.map((k) => k.criterionId));
  for (const k of keyReview) lines.push(`- Key criterion, needs human read: ${k.text}`);
  for (const r of unknown)
    lines.push(`- Unknown [${r.kind}] ${r.text}${r.items?.length ? `\n    Obtain: ${r.items.map((i) => `${i.label}${i.needsTissue ? " (needs tissue)" : ""}`).join("; ")}` : ""}`);
  for (const x of m.notChecked.filter((x) => x.category === "screening" && !keyIds.has(x.criterionId))) lines.push(`- Screening visit [${x.kind}] ${x.text}`);
  for (const x of m.notChecked.filter((x) => x.category === "review" && !keyIds.has(x.criterionId))) lines.push(`- Needs human read [${x.kind}] ${x.text}`);
  lines.push("");
  lines.push(`Checks and source rows: ${window.location.origin}${window.location.pathname}#/match/${m.patientId}/${m.nctId}`);
  return lines.join("\n");
}
