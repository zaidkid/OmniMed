"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import { API } from "../Ui";

export type Obj = Record<string, unknown>;

export type Stage = {
  stage: string;
  status: string;
  label: string;
  detail?: string;
  duration_ms?: number;
  attempt?: number;
};

export type LogLine = {
  ts: string;
  level: "info" | "ok" | "warn" | "error";
  text: string;
};

export type GenState = {
  runId: number;
  started: boolean;
  running: boolean;
  startedAt: number | null;
  endedAt: number | null;
  stages: Record<string, Stage>;
  attempt: number;
  thinking: string;
  thinkStart: number | null;
  thinkingSeconds: number | null;
  thinkingLimited: boolean;
  triage: Obj | null;
  output: string;
  logs: LogLine[];
  cancelled: boolean;
  error: string;
};

type Action =
  | { type: "reset" }
  | { type: "start"; now: number }
  | { type: "event"; e: Obj; now: number }
  | { type: "log"; level: LogLine["level"]; text: string; now: number }
  | { type: "end"; now: number; cancelled?: boolean; error?: string };

const CAP = { thinking: 60_000, output: 16_000, logs: 300 };
const LEVELS = ["info", "ok", "warn", "error"];

const init: GenState = {
  runId: 0, started: false, running: false, startedAt: null, endedAt: null,
  stages: {}, attempt: 1, thinking: "", thinkStart: null, thinkingSeconds: null,
  thinkingLimited: false, triage: null, output: "", logs: [], cancelled: false, error: "",
};

const iso = (ms: number) => new Date(ms).toISOString();
const text = (e: Obj) => (typeof e.text === "string" ? e.text : "");
const pushLog = (s: GenState, line: LogLine): GenState => ({
  ...s, logs: [...s.logs, line].slice(-CAP.logs),
});

function applyEvent(s: GenState, e: Obj, now: number): GenState {
  switch (e.type) {
    case "progress": {
      const u = e as unknown as Stage;
      const stages = { ...s.stages, [u.stage]: u };
      // A new generation attempt invalidates later stages from the previous attempt.
      if (u.stage === "qwen_generation" && (u.status === "active" || u.status === "retrying")) {
        delete stages.validation;
        delete stages.completed;
      }
      return { ...s, stages };
    }
    case "attempt_start": {
      const attempt = Number(e.attempt) || 1;
      if (attempt === 1) return { ...s, attempt };
      return {
        ...s, attempt, output: "", thinkStart: null, thinkingSeconds: null,
        thinking: s.thinking ? `${s.thinking}\n\n— Attempt ${attempt} —\n\n` : "",
      };
    }
    case "triage":
      return e.triage && typeof e.triage === "object" ? { ...s, triage: e.triage as Obj } : s;
    case "thinking":
      return {
        ...s, thinking: (s.thinking + text(e)).slice(-CAP.thinking),
        thinkStart: s.thinkStart ?? now,
      };
    case "thinking_end":
      return {
        ...s, thinkingLimited: e.limited === true,
        thinkingSeconds: typeof e.seconds === "number" ? e.seconds
          : s.thinkStart ? (now - s.thinkStart) / 1000 : null,
      };
    case "live_output":
      return {
        ...s, output: (s.output + text(e)).slice(-CAP.output),
        thinkingSeconds: s.thinkingSeconds ?? (s.thinkStart ? (now - s.thinkStart) / 1000 : null),
      };
    case "backend_log":
      return pushLog(s, {
        ts: typeof e.ts === "string" ? e.ts : iso(now),
        level: LEVELS.includes(String(e.level)) ? (e.level as LogLine["level"]) : "info",
        text: text(e),
      });
    case "error": {
      const message = String(e.message || e.detail || "Clinical brief streaming failed.");
      const next = pushLog(s, { ts: iso(now), level: "error", text: `[OmniMed] Stream error: ${String(e.detail || message)}` });
      return { ...next, error: message };
    }
    default:
      return s;
  }
}

function reducer(s: GenState, a: Action): GenState {
  switch (a.type) {
    case "reset": return { ...init, runId: s.runId };
    case "start": return { ...init, runId: s.runId + 1, started: true, running: true, startedAt: a.now };
    case "event": return applyEvent(s, a.e, a.now);
    case "log": return pushLog(s, { ts: iso(a.now), level: a.level, text: a.text });
    case "end": return { ...s, running: false, endedAt: a.now, cancelled: !!a.cancelled, error: a.error ?? s.error };
  }
}

export async function readResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  let data: unknown = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (!response.ok) throw new Error(`${response.status}: ${raw.slice(0, 500)}`);
    throw new Error("The backend returned an invalid response.");
  }
  if (!response.ok) {
    const detail = (data as Obj).detail;
    throw new Error(
      typeof detail === "string" ? detail : `Request failed (${response.status}): ${JSON.stringify(data)}`
    );
  }
  return data;
}

export type BriefRun = { result: Obj; usedFallback: boolean };

/** Consumes the real NDJSON stream from /api/clinical-brief/stream. No simulated events. */
export function useBriefStream() {
  const [state, dispatch] = useReducer(reducer, init);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "reset" });
  }, []);

  const run = useCallback(async (request: unknown): Promise<BriefRun | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "start", now: Date.now() });

    const out: { result: Obj | null; streamError: string } = { result: null, streamError: "" };
    let usedFallback = false;
    const log = (level: LogLine["level"], message: string) =>
      dispatch({ type: "log", level, text: message, now: Date.now() });

    const handle = (line: string) => {
      const raw = line.trim();
      if (!raw) return;
      let event: Obj;
      try {
        event = JSON.parse(raw) as Obj;
      } catch {
        log("warn", "[client] Skipped a malformed stream line.");
        return;
      }
      if (event.type === "result" && event.result && typeof event.result === "object") {
        out.result = event.result as Obj;
      } else if (event.type === "error") {
        out.streamError = String(event.message || event.detail || "Clinical brief streaming failed.");
      }
      dispatch({ type: "event", e: event, now: Date.now() });
    };

    try {
      const response = await fetch(`${API}/api/clinical-brief/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) await readResponse(response); // throws with the backend's detail
      if (!response.body) throw new Error("The browser could not open the clinical progress stream.");

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

      if (!out.result) {
        // Safety net: the original, known-working endpoint.
        log("warn", `[client] ${out.streamError || "The stream ended without a result event."} Falling back to the standard endpoint...`);
        const fallback = await fetch(`${API}/api/clinical-brief`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        out.result = (await readResponse(fallback)) as Obj;
        usedFallback = true;
      }

      dispatch({ type: "end", now: Date.now() });
      return { result: out.result, usedFallback };
    } catch (err) {
      if (controller.signal.aborted) {
        dispatch({ type: "end", now: Date.now(), cancelled: true });
        return null;
      }
      const error = err instanceof Error ? err : new Error("Clinical brief generation failed.");
      dispatch({ type: "end", now: Date.now(), error: error.message });
      throw error;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  return { gen: state, run, cancel, reset };
}