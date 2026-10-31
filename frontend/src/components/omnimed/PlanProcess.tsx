"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";

import "./care-plan.css";
import { PLAN_STAGES, type PlanTrace } from "./UseCarePlanStream";

export default function PlanProcess({ trace, running, onCancel }: {
  trace: PlanTrace; running: boolean; onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  const end = running ? now : trace.endedAt ?? now;
  const elapsed = trace.startedAt ? Math.max(0, (end - trace.startedAt) / 1000) : 0;
  const finished = !running && !trace.error && !trace.cancelled && trace.endedAt !== null;

  return (
    <section className="cp-proc og-noprint" aria-live="polite" aria-label="Care plan generation progress">
      <div className="cp-proc-head">
        <div>
          <p className="cp-k">{running ? "AI draft in progress" : finished ? "AI draft ready" : trace.cancelled ? "Cancelled" : "Stopped"}</p>
          <h4>Building the care plan</h4>
        </div>
        <div className="cp-proc-right">
          <span className="cp-time">{elapsed.toFixed(1)} s</span>
          {running && <button type="button" className="og-btn" onClick={onCancel}>Cancel</button>}
        </div>
      </div>

      <ol className="cp-steps">
        {PLAN_STAGES.map((s, i) => {
          const status = trace.stages[s.id];
          return (
            <li key={s.id} className={`cp-step ${status}`}>
              <span className="cp-dot">
                {status === "done" ? <Check size={12} /> : status === "active" ? <LoaderCircle size={12} className="og-spin" /> : i + 1}
              </span>
              <span>{s.label}</span>
            </li>
          );
        })}
      </ol>

      {trace.error && <p className="cp-err" role="alert">{trace.error}</p>}

      {trace.thinking && (
        <details className="cp-det">
          <summary>
            Model reasoning{trace.thinkingSeconds !== null ? ` · ${trace.thinkingSeconds} s` : ""}
          </summary>
          <pre>{trace.thinking}</pre>
        </details>
      )}
      {trace.output && (
        <details className="cp-det" open={running}>
          <summary>Live draft output</summary>
          <pre>{trace.output}</pre>
        </details>
      )}
      {trace.logs.length > 0 && (
        <details className="cp-det">
          <summary>Backend log ({trace.logs.length})</summary>
          <ul className="cp-log">
            {trace.logs.map((l, i) => (
              <li key={i} className={l.level}>
                <time>{new Date(l.ts).toLocaleTimeString()}</time> {l.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}