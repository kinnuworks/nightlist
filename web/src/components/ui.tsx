// Shared presentational pieces: status and verdict chips, badges, SQL blocks,
// evidence tables, loading and error states.
import { useState, type ReactNode } from "react";
import { NotInReplay, STATIC, STATIC_NOTE } from "../api";
import { cell, METHOD_HELP, METHOD_LABEL, SOURCE_OF_TABLE, STATUS_LABEL, VERDICT_LABEL } from "../lib";
import type { CheckInfo, MatchStatus, Method, Row, Verdict } from "../types";

// ---------- icons (decorative; every use sits next to text) ----------

const svg = (path: ReactNode) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {path}
  </svg>
);
export const IconCheck = () => svg(<path d="M3.5 8.5l3 3 6-7" />);
export const IconX = () => svg(<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);
export const IconQ = () =>
  svg(
    <>
      <path d="M6 6.2a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.5" />
      <circle cx="8" cy="12.2" r=".5" fill="currentColor" />
    </>,
  );
export const IconMinus = () => svg(<path d="M4 8h8" />);
export const IconChevron = ({ open }: { open: boolean }) =>
  svg(<path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />);
export const IconCopy = () =>
  svg(
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>,
  );
export const IconTissue = () =>
  svg(
    <>
      <path d="M8 2.5c2.5 3 4 5 4 7a4 4 0 0 1-8 0c0-2 1.5-4 4-7z" />
    </>,
  );

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#1d3557" />
      <path d="M20.5 8a8.5 8.5 0 1 0 3.5 13.2A7 7 0 0 1 20.5 8z" fill="#f1f5f9" />
      <path d="M22 11h4M22 15h3" stroke="#8fb8de" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// ---------- chips ----------

export function StatusChip({ status }: { status: MatchStatus }) {
  if (status === "eligible_no_blockers")
    return (
      <span className="chip chip-ok" title="No blocking criteria found among the criteria checked from records">
        <IconCheck />
        {STATUS_LABEL[status]}
      </span>
    );
  if (status === "possible_unknowns")
    return (
      <span className="chip chip-warn" title="No criterion failed, but at least one could not be checked from records">
        <IconQ />
        {STATUS_LABEL[status]}
      </span>
    );
  return (
    <span className="chip chip-bad" title="At least one checked criterion is not met">
      <IconX />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  const cls = verdict === "met" ? "chip-ok" : verdict === "not_met" ? "chip-bad" : "chip-warn";
  const icon = verdict === "met" ? <IconCheck /> : verdict === "not_met" ? <IconX /> : <IconQ />;
  return (
    <span className={`chip ${cls}`}>
      {icon}
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function NewChip() {
  return <span className="chip chip-new">New since last run</span>;
}

export function MethodBadge({ method }: { method: Method }) {
  return (
    <span className={`badge ${method === "model" ? "badge-accent" : ""}`} title={METHOD_HELP[method]}>
      <span className="sr-only">Compiled by: </span>
      {METHOD_LABEL[method]}
    </span>
  );
}

export function CheckBadge({ check, method }: { check?: CheckInfo; method: Method }) {
  if (method === "structured" && !check) return <span className="badge badge-outline" title="Registry field, no back-translation needed">No check needed</span>;
  const s = check?.status ?? "unchecked";
  if (s === "agree")
    return (
      <span className="badge badge-ok" title={check?.backTranslation ? `Back-translation: ${check.backTranslation}` : undefined}>
        <IconCheck />
        Back-translation agrees
      </span>
    );
  if (s === "disagree")
    return (
      <span className="badge badge-bad" title={check?.reason}>
        <IconX />
        Back-translation disagrees
      </span>
    );
  return (
    <span className="badge badge-outline" title={check?.reason ?? "No back-translation check was run for this criterion"}>
      Unchecked
    </span>
  );
}

export function SourceBadge({ table, label }: { table?: string; label?: string }) {
  const src = table ? SOURCE_OF_TABLE[table] : undefined;
  const text = label ?? src?.label ?? table ?? "source";
  const tone = label?.startsWith("NCI") ? "ncit" : label?.startsWith("RxNav") ? "rx" : label?.startsWith("Lab") ? "lab" : label === "EHR" ? "ehr" : (src?.tone ?? "");
  return (
    <span className={`badge badge-${tone}`}>
      <span className="sr-only">Source: </span>
      {text}
    </span>
  );
}

// ---------- code ----------

const SQL_KW = /\b(SELECT|FROM|WHERE|AND|OR|NOT|CASE|WHEN|THEN|ELSE|END|IN|IS|NULL|EXISTS|COUNT|SUM|AS|ORDER BY|GROUP BY|LEFT JOIN|JOIN|ON|LIKE|CAST|MAX|MIN|DISTINCT|LIMIT)\b/g;

function highlight(sql: string): ReactNode[] {
  // Split into string literals and the rest; colour keywords and numbers outside strings.
  const parts = sql.split(/('(?:[^']|'')*')/g);
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      out.push(
        <span className="str" key={i}>
          {p}
        </span>,
      );
      return;
    }
    const sub = p.split(SQL_KW);
    sub.forEach((s, j) => {
      if (j % 2 === 1)
        out.push(
          <span className="kw" key={`${i}-${j}`}>
            {s}
          </span>,
        );
      else out.push(s);
    });
  });
  return out;
}

export function CopyButton({ text, label = "Copy", className = "btn btn-sm" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      }}
    >
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </button>
  );
}

export function CodeBlock({ code, label, sql = true }: { code: string; label: string; sql?: boolean }) {
  return (
    <div className="code-wrap">
      <pre className="code" aria-label={label} tabIndex={0}>
        <code>{sql ? highlight(code) : code}</code>
      </pre>
      <CopyButton text={code} className="copy" label="Copy" />
    </div>
  );
}

// ---------- evidence ----------

export function EvidenceTable({ rows, caption }: { rows: Row[]; caption: string }) {
  if (!rows.length) return <p className="note small">No source rows returned. The data item is not on file, which is why a check can come back unknown.</p>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="table-wrap">
      <table className="t compact evidence">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={r[c] === null || r[c] === undefined ? "null" : ""}>
                  {cell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- states ----------

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="stack" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="skeleton" style={{ height: 22, width: "40%" }} />
      <div className="skeleton" style={{ height: 90 }} />
      <div className="skeleton" style={{ height: 240 }} />
    </div>
  );
}

export function ErrorView({ error, retry }: { error: Error; retry?: () => void }) {
  if (error instanceof NotInReplay)
    return (
      <div className="card card-pad stack" role="alert">
        <h2>Not in this replay</h2>
        <p className="lede">{error.message}.</p>
        <p className="small muted">The hosted replay includes a subset of patient and trial pairs. A local run serves every pair.</p>
      </div>
    );
  return (
    <div className="card card-pad stack" role="alert">
      <h2>Could not load this page</h2>
      <p className="lede">{error.message}</p>
      <p className="small muted">{STATIC ? "This replay file is missing." : "Check that the Nightlist API is running (npm run dev from the project root)."}</p>
      {retry && (
        <div>
          <button className="btn" type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function StaticNote() {
  if (!STATIC) return null;
  return <p className="note note-warn small">{STATIC_NOTE}</p>;
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  id,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  id: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" className="linkish row small" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span style={{ width: 14, height: 14, display: "inline-flex" }}>
          <IconChevron open={open} />
        </span>
        {summary}
      </button>
      {open && (
        <div id={id} style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function StackBar({ parts, label }: { parts: { value: number; cls: string; label: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.value} ${p.label}`).join(", ")}`}>
      {parts.map((p) => (
        <span key={p.label} className={p.cls} style={{ width: `${(p.value / total) * 100}%` }} />
      ))}
    </div>
  );
}
