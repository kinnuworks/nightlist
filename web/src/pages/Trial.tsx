// Trial page: every eligibility criterion as compiled overnight.
import { getTrial } from "../api";
import { CheckBadge, Disclosure, ErrorView, Loading, MethodBadge } from "../components/ui";
import { fmtDate, href, miles, phaseLabel, plural, useLoad } from "../lib";
import type { TrialCriterion, TrialDetail } from "../types";

const CATEGORY_LABEL = { check: "Checked from records", screening: "Screening visit", review: "Needs a human read" } as const;

export function TrialPage({ nct }: { nct: string }) {
  const res = useLoad(() => getTrial(nct), [nct]);
  if (res.error) return <ErrorView error={res.error} retry={res.reload} />;
  if (!res.data) return <Loading label="Loading trial" />;
  return <TrialView d={res.data} />;
}

function TrialView({ d }: { d: TrialDetail }) {
  const t = d.trial;
  const byCat = (c: string) => d.criteria.filter((x) => x.category === c).length;
  const sites = [...(t.sites ?? [])].sort((a, b) => a.miles - b.miles);
  return (
    <div className="stack-lg">
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href={href.home()}>Worklist</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{t.nctId}</span>
      </nav>
      <section className="page-head" aria-labelledby="tr-title">
        <span className="eyebrow">Trial</span>
        <h1 id="tr-title" className="wrap-anywhere">{t.title}</h1>
        <p className="small" style={{ color: "var(--ink-2)" }}>
          {t.nctId} · {phaseLabel(t.phase)} · {t.status ?? ""} · {t.sponsor ?? "sponsor not listed"}
          {t.lastUpdate ? ` · registry updated ${fmtDate(t.lastUpdate)}` : ""} ·{" "}
          <a href={`https://clinicaltrials.gov/study/${t.nctId}`} target="_blank" rel="noreferrer">
            ClinicalTrials.gov record<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
        <p className="small muted">
          {plural(d.criteria.length, "criterion", "criteria")}: {byCat("check")} checked from records, {byCat("screening")} for the screening visit, {byCat("review")} need a human read.
          {sites[0] && ` Nearest site ${miles(sites[0].miles)}: ${sites[0].facility}, ${sites[0].city}.`}
        </p>
      </section>

      <section className="card" aria-labelledby="tc-title">
        <div className="card-head">
          <div>
            <h2 id="tc-title">Compiled criteria</h2>
            <p>Each sentence from the public trial text and what it was compiled into. No patient data is used here.</p>
          </div>
        </div>
        {(["inclusion", "exclusion"] as const).map((k) => {
          const rows = d.criteria.filter((c) => c.kind === k);
          return (
            <div key={k}>
              <div className="section-label">
                <span>
                  {k === "inclusion" ? "Inclusion" : "Exclusion"} ({rows.length})
                </span>
              </div>
              <div role="list">
                {rows.map((c) => (
                  <CriterionLine key={c.criterionId} c={c} />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      {t.eligibility && (
        <section className="card card-pad" aria-labelledby="te-title">
          <h2 id="te-title" style={{ marginBottom: 8 }}>
            Source text
          </h2>
          <Disclosure id="elig-text" summary="Show the eligibility text as published">
            <pre className="small" style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font)", margin: 0 }}>
              {t.eligibility}
            </pre>
          </Disclosure>
        </section>
      )}
    </div>
  );
}

function CriterionLine({ c }: { c: TrialCriterion }) {
  const tone = c.category === "check" ? "badge-ok" : c.category === "screening" ? "" : "badge-warn";
  return (
    <div className="crit" role="listitem">
      <div className="crit-row label-wide">
        <div>
          <span className={`badge ${tone}`}>{CATEGORY_LABEL[c.category]}</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <p className="crit-text">{c.text}</p>
          {c.readable && (
            <p className="crit-rule">
              Compiled check: <code>{c.readable}</code>
            </p>
          )}
          <div className="crit-meta">
            {c.method !== "none" && <MethodBadge method={c.method} />}
            {c.category === "check" && <CheckBadge check={c.check} method={c.method} />}
            <span className="tiny muted mono">{c.criterionId}</span>
          </div>
          {c.check?.backTranslation && <p className="small muted" style={{ marginTop: 4 }}>Back-translation: "{c.check.backTranslation}"{c.check.model ? ` · model ${c.check.model}` : ""}</p>}
          {c.caveat && <p className="crit-caveat">Caveat: {c.caveat}</p>}
        </div>
      </div>
    </div>
  );
}
