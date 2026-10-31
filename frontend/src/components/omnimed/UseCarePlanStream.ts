"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import { API } from "../Ui";
import { readResponse, type Obj } from "./useBriefStream";

export const PLAN_STAGES = [
  { id: "read", label: "Read patient state and brief" },
  { id: "evidence", label: "Search guideline evidence" },
  { id: "reason", label: "Reason over findings" },
  { id: "draft", label: "Draft care plan" },
  { id: "structure", label: "Structure and validate" },
] as const;

export type PlanStageId = (typeof PLAN_STAGES)[number]["id"];
export type StageStatus = "pending" | "active" | "done";
export type PlanLog = { ts: string; level: "info" | "ok" | "warn" | "error"; text: string };

export type PlanTrace = {
  runId: number;
  started: boolean;
  startedAt: number | null;
  endedAt: number | null;
  stages: Record<PlanStageId, StageStatus>;
  thinking: string;
  thinkingSeconds: number | null;
  output: string;
  logs: PlanLog[];
  cancelled: boolean;
  error: string;
};

// Used only if the stream ends without a result. Adjust if your route differs.
const FALLBACK_PATH = "/api/care-plans/generate";
const CAP = { thinking: 20_000, output: 12_000, logs: 200 };
const LEVELS = ["info", "ok", "warn", "error"];
const IDS = PLAN_STAGES.map((s) => s.id) as PlanStageId[];

const blankStages = (): Record<PlanStageId, StageStatus> =>
  ({ read: "pending", evidence: "pending", reason: "pending", draft: "pending", structure: "pending" });

const init: PlanTrace = {
  runId: 0, started: false, startedAt: null, endedAt: null, stages: blankStages(),
  thinking: "", thinkingSeconds: null, output: "", logs: [], cancelled: false, error: "",
};

type Action =
  | { type: "start"; now: number }
  | { type: "event"; e: Obj; now: number }
  | { type: "log"; level: PlanLog["level"]; text: string; now: number }
  | { type: "end"; now: number; cancelled?: boolean; error?: string; ok?: boolean };

const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown) => (typeof v === "string" ? v : "");
const pushLog = (s: PlanTrace, line: PlanLog): PlanTrace => ({ ...s, logs: [...s.logs, line].slice(-CAP.logs) });

function setStage(s: PlanTrace, id: string): PlanTrace {
  const at = IDS.indexOf(id as PlanStageId);
  if (at < 0) return s;
  const current = IDS.findIndex((k) => s.stages[k] === "active");
  const stages = blankStages();
  IDS.forEach((k, i) => { stages[k] = i < at ? "done" : i === at ? "active" : "pending"; });
  // Going backwards means the model is retrying: drop the rejected draft.
  return { ...s, stages, output: current > at ? "" : s.output };
}

function applyEvent(s: PlanTrace, e: Obj, now: number): PlanTrace {
  switch (e.type ?? e.event) {
    case "stage": return setStage(s, str(e.stage));
    case "thinking": return { ...s, thinking: (s.thinking + str(e.text)).slice(-CAP.thinking) };
    case "thinking_end":
      return { ...s, thinkingSeconds: typeof e.seconds === "number" ? e.seconds : s.thinkingSeconds };
    case "token": return { ...s, output: (s.output + str(e.text)).slice(-CAP.output) };
    case "log":
      return pushLog(s, {
        ts: iso(now),
        level: LEVELS.includes(String(e.level)) ? (e.level as PlanLog["level"]) : "info",
        text: str(e.message) || str(e.text),
      });
    case "error": {
      const message = str(e.message) || str(e.detail) || "Care plan streaming failed.";
      return { ...pushLog(s, { ts: iso(now), level: "error", text: message }), error: message };
    }
    default: return s;
  }
}

function reducer(s: PlanTrace, a: Action): PlanTrace {
  switch (a.type) {
    case "start": return { ...init, runId: s.runId + 1, started: true, startedAt: a.now };
    case "event": return applyEvent(s, a.e, a.now);
    case "log": return pushLog(s, { ts: iso(a.now), level: a.level, text: a.text });
    case "end": {
      const stages = a.ok ? Object.fromEntries(IDS.map((k) => [k, "done"])) as Record<PlanStageId, StageStatus> : s.stages;
      return { ...s, stages, endedAt: a.now, cancelled: !!a.cancelled, error: a.error ?? s.error };
    }
  }
}

/** Consumes the real NDJSON stream from /api/care-plans/stream. No simulated events. */
export function useCarePlanStream() {
  const [trace, dispatch] = useReducer(reducer, init);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const [, force] = useReducer((n: number) => n + 1, 0);

  useEffect(() => () => abortRef.current?.abort(), []);
  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const start = useCallback(async (body: unknown): Promise<Obj> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    force();
    dispatch({ type: "start", now: Date.now() });

    const out: { plan: Obj | null; streamError: string } = { plan: null, streamError: "" };
    const log = (level: PlanLog["level"], text: string) => dispatch({ type: "log", level, text, now: Date.now() });

    const handle = (line: string) => {
      const raw = line.trim();
      if (!raw) return;
      let event: Obj;
      try { event = JSON.parse(raw) as Obj; } catch { log("warn", "[client] Skipped a malformed stream line."); return; }
      const kind = event.type ?? event.event;
      const plan = event.care_plan ?? event.result;
      if (kind === "result" && plan && typeof plan === "object") out.plan = plan as Obj;
      else if (kind === "error") out.streamError = str(event.message) || str(event.detail) || "Care plan streaming failed.";
      dispatch({ type: "event", e: event, now: Date.now() });
    };

    try {
      const response = await fetch(`${API}/api/care-plans/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) await readResponse(response); // throws with the backend's detail
      if (!response.body) throw new Error("The browser could not open the care plan progress stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          lines.forEach(handle);
          if (done) break;
        }
        if (buffer.trim()) handle(buffer);
      } finally {
        reader.cancel().catch(() => undefined);
      }

      if (out.streamError) throw new Error(out.streamError);

      if (!out.plan) {
        log("warn", "[client] The stream ended without a result. Trying the standard endpoint...");
        const fallback = await fetch(`${API}${FALLBACK_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        out.plan = (await readResponse(fallback)) as Obj;
      }

      dispatch({ type: "end", now: Date.now(), ok: true });
      return out.plan;
    } catch (err) {
      if (controller.signal.aborted) {
        dispatch({ type: "end", now: Date.now(), cancelled: true });
        throw new DOMException("Cancelled", "AbortError");
      }
      const error = err instanceof Error ? err : new Error("Care plan generation failed.");
      dispatch({ type: "end", now: Date.now(), error: error.message });
      throw error;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      runningRef.current = false;
      force();
    }
  }, []);

  return { trace, running: runningRef.current, start, cancel };
}