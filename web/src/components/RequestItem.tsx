// "Request (coordinator sign-off)": records the request as a coordinator decision in
// H-MEM via POST /api/memory. Nothing is ordered; the decision is an audit entry.
import { useState } from "react";
import { postMemory, STATIC, STATIC_NOTE } from "../api";
import { fmtTime } from "../lib";
import type { OneItemAway } from "../types";

export function requestText(e: OneItemAway) {
  const list = e.trials.slice(0, 5).join(", ") + (e.trials.length > 5 ? ` and ${e.trials.length - 5} more` : "");
  return `Request: ${e.label}. One data item away from ${e.trials.length} trials (${list}).${e.needsTissue ? " Needs tissue." : ""}`;
}

export function RequestItem({ entry, patientName }: { entry: OneItemAway; patientName: string }) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "saving" | "done" | "error">("idle");
  const [actor, setActor] = useState("coordinator");
  const [err, setErr] = useState("");
  const [at, setAt] = useState("");
  const text = requestText(entry);
  const id = `req-${entry.patientId}-${entry.item}`;

  if (STATIC)
    return (
      <div className="stack" style={{ gap: 4 }}>
        <button type="button" className="btn btn-sm" disabled aria-describedby={`${id}-note`}>
          Request (coordinator sign-off)
        </button>
        <span id={`${id}-note`} className="tiny muted">
          {STATIC_NOTE}
        </span>
      </div>
    );

  if (phase === "done")
    return (
      <p className="note note-ok small" role="status">
        Recorded as a decision for {patientName} at {fmtTime(at)} by {actor}. It is in the patient's audit history.
      </p>
    );

  if (phase === "idle" || phase === "error")
    return (
      <div className="stack" style={{ gap: 6 }}>
        <div>
          <button type="button" className="btn btn-sm" aria-controls={id} onClick={() => setPhase("confirm")}>
            Request (coordinator sign-off)
          </button>
        </div>
        {phase === "error" && (
          <p className="note note-bad small" role="alert">
            Not recorded: {err}
          </p>
        )}
      </div>
    );

  return (
    <div id={id} className="note stack" style={{ gap: 8 }} role="group" aria-label={`Confirm request for ${patientName}`}>
      <div className="small">
        This records a coordinator decision for {patientName}. It does not place an order.
      </div>
      <div className="small" style={{ color: "var(--ink)" }}>
        "{text}"
      </div>
      <div className="row">
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Signed off by
          <input className="input" style={{ width: 150 }} value={actor} onChange={(e) => setActor(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={phase === "saving" || !actor.trim()}
          onClick={async () => {
            setPhase("saving");
            try {
              const rec = await postMemory({ patientId: entry.patientId, kind: "decision", text, actor: actor.trim() });
              setAt(rec.createdAt ?? new Date().toISOString());
              setPhase("done");
            } catch (e) {
              setErr((e as Error).message);
              setPhase("error");
            }
          }}
        >
          {phase === "saving" ? "Recording" : "Sign off and record"}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setPhase("idle")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
