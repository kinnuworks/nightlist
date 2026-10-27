import { useEffect, useRef } from "react";
import { getStatus, getSummary, getWorklist, STATIC, STATIC_NOTE } from "./api";
import { BrandMark } from "./components/ui";
import { criteriaBreakdown, href, modelPathIdle, useDataVersion, useLoad, useRoute } from "./lib";
import { MatchPage } from "./pages/Match";
import { PatientPage } from "./pages/Patient";
import { RunPage } from "./pages/Run";
import { TrialPage } from "./pages/Trial";
import { WorklistPage } from "./pages/Worklist";

export function App() {
  const route = useRoute();
  const version = useDataVersion();
  const status = useLoad(getStatus, [version]);
  // The worklist is cached and shared with the worklist page; the summary is the fallback
  // source for the model path when the worklist has no headline.
  const worklist = useLoad(getWorklist, [version]);
  const summary = useLoad(getSummary, [version]);
  const mainRef = useRef<HTMLElement>(null);
  const [section, a, b] = route.path;

  // Move focus to the page on navigation so keyboard and screen reader users land on the new content.
  const key = route.path.join("/");
  useEffect(() => {
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [key]);

  let page;
  let title = "Morning worklist";
  if (section === "patient" && a) {
    page = <PatientPage pid={a} />;
    title = `Patient ${a}`;
  } else if (section === "match" && a && b) {
    page = <MatchPage pid={a} nct={b} />;
    title = `${a} and ${b}`;
  } else if (section === "trial" && a) {
    page = <TrialPage nct={a} />;
    title = `Trial ${a}`;
  } else if (section === "run") {
    page = <RunPage section={route.query.get("section") ?? undefined} />;
    title = "Overnight run";
  } else {
    page = <WorklistPage query={route.query} />;
  }

  useEffect(() => {
    document.title = `${title} | Nightlist`;
  }, [title]);

  const s = status.data;
  const layerLabel = s ? (s.dataLayer === "zetaris" ? "Zetaris" : s.dataLayer === "duckdb" ? "DuckDB" : s.dataLayer) : "";
  const modelPath =
    worklist.data?.headline?.mode?.modelPath ??
    (summary.data ? (modelPathIdle(criteriaBreakdown(summary.data)) ? "rules only" : "rules and model") : undefined);
  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        Skip to content
      </a>
      {STATIC && (
        <div className="static-banner" role="note">
          {STATIC_NOTE}
        </div>
      )}
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={href.home()}>
            <BrandMark />
            Nightlist
            {s && <small className="hide-sm">{s.clinic.name}</small>}
          </a>
          <nav className="nav" aria-label="Main">
            <a href={href.home()} aria-current={!section || section === "patient" || section === "match" ? "page" : undefined}>
              Worklist
            </a>
            <a href={href.run()} aria-current={section === "run" ? "page" : undefined}>
              Overnight run
            </a>
          </nav>
          <a className="about-link" href="./home.html">
            About
          </a>
          {s && (
            <div className="topbar-status">
              <span className="mode-banner" title="How this run was produced: where the checks ran and which compile path was used">
                <span className={`dot ${s.dataLayer === "zetaris" ? "dot-ok" : "dot-warn"}`} aria-hidden="true" />
                <span>
                  <b>{s.sampleMode ? "Sample mode" : "Live"}</b> · data layer: {layerLabel}
                  {modelPath && <> · model path: {modelPath}</>}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <a href={href.run()} className="mono tiny">
                {s.runId}
              </a>
            </div>
          )}
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} style={{ outline: "none" }}>
        {page}
      </main>
      <footer className="footer">
        Synthetic patients at a fictional clinic. Nightlist produces a worklist for a research coordinator; it does not decide eligibility. The model reads only public trial text; checks run as SQL in the data layer.
      </footer>
    </>
  );
}
