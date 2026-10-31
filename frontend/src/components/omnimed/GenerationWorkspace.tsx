"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity, AlertCircle, AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, LoaderCircle, Sparkles, Square,
} from "lucide-react";

import "./generation.css";
import type { GenState, LogLine } from "./useBriefStream";

const STAGES: [string, string][] = [
  ["patient_context", "Patient context"],
  ["evidence_retrieval", "Evidence retrieval"],
  ["qwen_generation", "Qwen generation"],
  ["validation", "Validation & safety"],
  ["completed", "Brief preparation"],
];

const STATUS_TEXT: Record<string, string> = {
  pending: "Pending", active: "In progress", retrying: "Retrying", completed: "Completed", failed: "Failed",
};

const ms = (value?: number) =>
  value === undefined ? "" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
const seconds = (value: number) => (value < 10 ? value.toFixed(1) : String(Math.round(value)));
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

function useElapsed(gen: GenState) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!gen.running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [gen.running]);
  return gen.startedAt ? Math.max(0, ((gen.endedAt ?? now) - gen.startedAt) / 1000) : 0;
}

/** Scrolls to the bottom whenever `content` changes while `follow` is true. */
function Pane({ content, follow, className, children }: {
  content: unknown; follow: boolean; className: string; children: React.ReactNode;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [content, follow]);
  return <pre ref={ref} className={className} tabIndex={0}>{children}</pre>;
}

const TRIAGE_TEXT: Record<string, string> = {
  emergent: "High urgency", urgent: "Elevated urgency", routine: "No urgent signals",
};

function TriageLine({ triage }: { triage: Record<string, unknown> }) {
  const level = String(triage.level ?? "routine");
  const signals = Array.isArray(triage.signals) ? (triage.signals as { label?: string }[]) : [];
  return (
    <div className={`og-triage ${level}`} role={level === "emergent" ? "alert" : "status"}>
      <AlertTriangle size={15} />
      <strong>Urgency screening (automated): {TRIAGE_TEXT[level] ?? level}</strong>
      {signals.length > 0 && <span>{signals.slice(0, 3).map((s) => s.label).join(" · ")}{signals.length > 3 ? ` · +${signals.length - 3} more` : ""}</span>}
    </div>
  );
}

function StageIcon({ status, index }: { status: string; index: number }) {
  if (status === "completed") return <CheckCircle2 size={14} />;
  if (status === "failed") return <AlertCircle size={14} />;
  if (status === "active" || status === "retrying") return <LoaderCircle size={14} className="og-spin" />;
  return <span>{index + 1}</span>;
}

export default function GenerationWorkspace({ gen, onCancel }: { gen: GenState; onCancel: () => void }) {
  // Parent passes key={gen.runId}, so this state resets for every new generation.
  const [manual, setManual] = useState<boolean | null>(null);
  const elapsed = useElapsed(gen);

  const hasThinking = gen.thinking.length > 0;
  const thinkingDone = gen.thinkingSeconds !== null || (!gen.running && hasThinking);
  const open = manual ?? !thinkingDone; // auto-open while thinking, auto-collapse when done
  const finished = !gen.running && gen.started;
  const lastLog = gen.logs[gen.logs.length - 1];
  const validation = gen.stages.validation?.status;

  const status = gen.running ? { cls: "run", text: `Running · ${elapsed.toFixed(1)} s` }
    : gen.cancelled ? { cls: "warn", text: "Cancelled" }
    : gen.error ? { cls: "err", text: "Failed" }
    : { cls: "ok", text: `Finished in ${elapsed.toFixed(1)} s` };

  let thinkLabel = "";
  if (hasThinking) thinkLabel = thinkingDone
    ? gen.thinkingSeconds !== null
      ? `Thought for ${seconds(gen.thinkingSeconds)} s${gen.thinkingLimited ? " (limited to keep generation fast)" : ""}`
      : "Thought process"
    : "Thinking…";

  return (
    <section className="og-card" aria-live="polite" aria-busy={gen.running}>
      <div className="og-head">
        <span className="og-ico"><Sparkles size={20} /></span>
        <div className="og-grow">
          <h2>{gen.running ? "Generating clinical brief" : "Clinical brief generation"}</h2>
          <p>Live events from the backend. Conclusions are shown only after validation.</p>
        </div>
        <span className={`og-pill ${status.cls}`}>{status.text}</span>
        {gen.attempt > 1 && <span className="og-pill warn">Attempt {gen.attempt}</span>}
        {gen.running && (
          <button type="button" className="og-btn" onClick={onCancel}><Square size={12} /> Stop</button>
        )}
      </div>

      <div className="og-stages">
        {STAGES.map(([id, fallback], index) => {
          const stage = gen.stages[id];
          const state = stage?.status ?? "pending";
          return (
            <div key={id} className={`og-stage ${state}`}>
              <span className="og-stage-icon"><StageIcon status={state} index={index} /></span>
              <div className="og-grow">
                <strong>{fallback}</strong>
                <small>
                  {STATUS_TEXT[state] ?? state}
                  {state === "completed" && stage?.duration_ms !== undefined ? ` · ${ms(stage.duration_ms)}` : ""}
                </small>
                {stage?.detail && (state === "failed" || state === "active" || state === "retrying" || id === "evidence_retrieval") &&
                  <em>{stage.detail}</em>}
              </div>
            </div>
          );
        })}
      </div>

      {gen.triage && <TriageLine triage={gen.triage} />}

      <div className="og-live" aria-live="off">{lastLog ? lastLog.text : "Connecting to the backend…"}</div>

      {hasThinking ? (
        <div className="og-think">
          <button type="button" className="og-think-btn" aria-expanded={open} aria-controls="og-think-body"
            onClick={() => setManual(!open)}>
            <span className={!thinkingDone ? "og-pulse" : ""}><BrainCircuit size={16} /></span>
            <span className={!thinkingDone ? "og-shimmer" : ""}>{thinkLabel}</span>
            <ChevronDown size={16} className="og-chev" />
          </button>
          <div id="og-think-body" className={`og-collapse ${open ? "open" : ""}`} aria-hidden={!open}>
            <div>
              <p className="og-note">Reasoning exactly as emitted by Ollama&apos;s thinking field. It may be incomplete and is not a clinical fact.</p>
              <Pane content={gen.thinking} follow={gen.running && !thinkingDone} className="og-think-text">{gen.thinking}</Pane>
            </div>
          </div>
        </div>
      ) : gen.output.length > 0 || finished ? (
        <p className="og-think-none"><BrainCircuit size={14} /> No separate reasoning was shown for this run.</p>
      ) : (
        <p className="og-think-none og-shimmer"><BrainCircuit size={14} /> Waiting for model output…</p>
      )}

      {gen.error && <div className="og-error" role="alert"><AlertCircle size={15} /> {gen.error}</div>}

      <details className="og-exec">
        <summary>Execution details <span>{gen.logs.length} events · {gen.output.length.toLocaleString()} characters drafted</span></summary>
        <div className="og-panes">
          <div className="og-pane">
            <header>
              <Sparkles size={14} /> Draft output
              <span>{validation === "completed" ? "validation finished" : "intermediate, not validated"}</span>
            </header>
            <Pane content={gen.output} follow={gen.running} className="og-term">
              {gen.output || "Waiting for response tokens…"}
            </Pane>
          </div>
          <div className="og-pane">
            <header><Activity size={14} /> Backend log <span>FastAPI events</span></header>
            <Pane content={gen.logs.length} follow={gen.running} className="og-term">
              {gen.logs.length
                ? gen.logs.map((line: LogLine, i) => (
                    <span key={i} className={`og-log ${line.level}`}>
                      <time>{clock(line.ts)}</time> {line.text}{"\n"}
                    </span>
                  ))
                : "Waiting for backend events…"}
            </Pane>
          </div>
        </div>
      </details>
    </section>
  );
}