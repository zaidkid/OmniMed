"use client";

import { useCallback, useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { API } from "../../components/Ui";
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Copy,
  Cpu,
  Database,
  HelpCircle,
  RefreshCw,
  Server,
  Zap,
} from "lucide-react";

type State = "checking" | "online" | "offline" | "unknown";

type Row = {
  key: string;
  label: string;
  path: string;
  state: State;
  summary: string;
  detail: unknown;
  ms?: number;
};

const TIMEOUT_MS = 6000;
const OK = /^(ok|healthy|online|ready|running|connected|available|success|up)$/i;
const BAD = /^(disconnected|down|error|failed|offline|unavailable)$/i;

const ICONS: Record<string, React.ReactNode> = {
  backend: <Server size={20} />,
  database: <Database size={20} />,
  llm: <Cpu size={20} />,
  evidence: <Zap size={20} />,
};

const DEFS = [
  { key: "backend", label: "Backend API", path: "/health" },
  { key: "database", label: "PostgreSQL database", path: "/health" },
  { key: "llm", label: "Local AI model (Ollama)", path: "/api/ai/status" },
  { key: "evidence", label: "Evidence index (Qdrant)", path: "/api/knowledge/status" },
];

const LABELS: Record<State, string> = {
  checking: "Checking",
  online: "Connected",
  offline: "Issue detected",
  unknown: "Unconfirmed",
};

const pending = (): Row[] =>
  DEFS.map((d) => ({
    ...d,
    state: "checking" as State,
    summary: "Checking connection...",
    detail: undefined,
  }));

async function probe(path: string): Promise<{ data: unknown; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`${res.status}: ${raw.slice(0, 150)}`);
  try {
    return { data: raw ? JSON.parse(raw) : {}, ms };
  } catch {
    return { data: { message: raw }, ms };
  }
}

const field = (data: unknown, key: string): unknown =>
  data && typeof data === "object"
    ? (data as Record<string, unknown>)[key]
    : undefined;

const errText = (e: unknown) => {
  if (e instanceof DOMException && e.name === "TimeoutError") return "Timed out";
  return e instanceof Error ? e.message.slice(0, 140) : "Service unreachable";
};

const pretty = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

const CSS = `
.st-wrap{max-width:1000px;margin:0 auto;padding:28px 24px 40px;display:flex;flex-direction:column;gap:22px;color:#0f172a}
.st-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px}
.st-eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;color:#2563eb}
.st-head h1{margin:4px 0 0;font-size:28px;font-weight:700;letter-spacing:-.02em}
.st-head p{margin:6px 0 0;font-size:14px;color:#64748b}
.st-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid #cbd5e1;background:#fff;color:#334155;font:inherit;font-size:13px;font-weight:600;padding:9px 16px;border-radius:10px;cursor:pointer;transition:background .15s ease}
.st-btn:hover:not(:disabled){background:#f1f5f9}
.st-btn:disabled{opacity:.6;cursor:not-allowed}
.st-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}
.st-stat{display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:16px 18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.st-stat-icon{flex:none;width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#eff6ff;color:#2563eb}
.st-stat-icon.good{background:#ecfdf5;color:#059669}
.st-stat-icon.warn{background:#fef2f2;color:#dc2626}
.st-stat-icon.mid{background:#fffbeb;color:#d97706}
.st-stat-label{font-size:10.5px;font-weight:700;letter-spacing:.07em;color:#64748b}
.st-stat-value{margin-top:2px;font-size:26px;font-weight:700;line-height:1}
.st-section-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.st-section-head h2{margin:2px 0 0;font-size:18px;font-weight:650}
.st-section-head p{margin:4px 0 0;font-size:13px;color:#64748b}
.st-overall{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;background:#f1f5f9;color:#475569}
.st-overall.online{background:#ecfdf5;color:#047857}
.st-overall.offline{background:#fef2f2;color:#b91c1c}
.st-overall.unknown{background:#fffbeb;color:#b45309}
.st-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.st-dot.pulse{animation:stpulse 1s ease-in-out infinite}
.st-list{display:flex;flex-direction:column;gap:12px}
.st-card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.st-row{display:flex;align-items:center;gap:14px;padding:16px 18px}
.st-icon{flex:none;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#eff6ff;color:#2563eb}
.st-meta{flex:1;min-width:0}
.st-meta h3{margin:0;font-size:15px;font-weight:650}
.st-path{margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#94a3b8}
.st-summary-text{margin-top:6px;font-size:13px;color:#475569;overflow-wrap:anywhere}
.st-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}
.st-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px;white-space:nowrap}
.st-badge.checking{background:#f1f5f9;color:#64748b}
.st-badge.online{background:#ecfdf5;color:#047857}
.st-badge.offline{background:#fef2f2;color:#b91c1c}
.st-badge.unknown{background:#fffbeb;color:#b45309}
.st-ms{font-size:11px;color:#94a3b8}
.st-toggle{display:flex;align-items:center;gap:6px;width:100%;border:0;border-top:1px solid #e2e8f0;background:#f8fafc;padding:10px 18px;font:inherit;font-size:12px;font-weight:700;letter-spacing:.04em;color:#64748b;cursor:pointer;text-align:left}
.st-toggle:hover{background:#f1f5f9}
.st-toggle svg{transition:transform .15s ease}
.st-toggle.open svg{transform:rotate(180deg)}
.st-details{border-top:1px solid #e2e8f0;background:#f8fafc;padding:0 18px 16px}
.st-details pre{margin:0;padding:12px 14px;border-radius:10px;background:#0f172a;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
.st-env{display:flex;gap:16px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.st-env h2{margin:2px 0 0;font-size:18px;font-weight:650}
.st-env p{margin:6px 0 0;font-size:13px;color:#64748b}
.st-url{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
.st-url code{padding:8px 12px;border-radius:10px;background:#f1f5f9;font-size:13px;color:#0f172a;overflow-wrap:anywhere}
.st-help code{padding:1px 6px;border-radius:6px;background:#f1f5f9;font-size:12px}
.st-last{margin-top:12px;font-size:12px;color:#94a3b8}
.st-foot{text-align:center;font-size:12px;color:#94a3b8}
.st-spin{animation:stspin 1s linear infinite}
@keyframes stspin{to{transform:rotate(360deg)}}
@keyframes stpulse{50%{opacity:.35}}
@media(max-width:640px){.st-row{flex-wrap:wrap}.st-right{flex-direction:row;align-items:center;width:100%;justify-content:space-between}}
`;

export default function SettingsPage() {
  const [rows, setRows] = useState<Row[]>(pending);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useCallback(async () => {
    setChecking(true);
    setRows(pending());

    const [backend, llm, evidence] = await Promise.allSettled([
      probe("/health"),
      probe("/api/ai/status"),
      probe("/api/knowledge/status"),
    ]);

    const next: Row[] = [];
    const base = (key: string) => DEFS.find((d) => d.key === key)!;

    // Backend API
    if (backend.status === "fulfilled") {
      const { data, ms } = backend.value;
      next.push({
        ...base("backend"),
        state: "online",
        summary: "Health endpoint responding",
        detail: data,
        ms,
      });

      // PostgreSQL, read from the backend's /health response
      const db = field(data, "database");
      if (db === undefined) {
        next.push({
          ...base("database"),
          state: "unknown",
          summary: "Not reported by /health. Update and restart the backend.",
          detail: data,
        });
      } else {
        const text = String(db);
        const state: State = OK.test(text) ? "online" : BAD.test(text) ? "offline" : "unknown";
        next.push({
          ...base("database"),
          state,
          summary:
            state === "online"
              ? "Query round-trip succeeded"
              : state === "offline"
                ? "Backend could not reach PostgreSQL"
                : `Database reported: ${text}`,
          detail: { database: db },
        });
      }
    } else {
      const msg = errText(backend.reason);
      next.push({ ...base("backend"), state: "offline", summary: msg, detail: { error: msg } });
      next.push({
        ...base("database"),
        state: "offline",
        summary: "Backend unreachable",
        detail: { error: "Backend unreachable" },
      });
    }

    // Local AI model
    if (llm.status === "fulfilled") {
      const { data, ms } = llm.value;
      const status = field(data, "status");
      const model = field(data, "model");
      const text = typeof status === "string" ? status : "";
      const state: State = OK.test(text) ? "online" : BAD.test(text) ? "offline" : "unknown";
      next.push({
        ...base("llm"),
        state,
        summary:
          state === "online"
            ? `${model ? String(model) : "Model"} is loaded and responding`
            : state === "offline"
              ? "Model service is disconnected"
              : "Reachable, but readiness not confirmed",
        detail: data,
        ms,
      });
    } else {
      const msg = errText(llm.reason);
      next.push({ ...base("llm"), state: "offline", summary: msg, detail: { error: msg } });
    }

    // Evidence index
    if (evidence.status === "fulfilled") {
      const { data, ms } = evidence.value;
      const items = field(data, "indexed_evidence_items");
      next.push({
        ...base("evidence"),
        state: "online",
        summary:
          typeof items === "number"
            ? `${items.toLocaleString()} evidence items indexed`
            : "Knowledge service reachable",
        detail: data,
        ms,
      });
    } else {
      const msg = errText(evidence.reason);
      next.push({ ...base("evidence"), state: "offline", summary: msg, detail: { error: msg } });
    }

    setRows(next);
    setLastChecked(new Date().toLocaleTimeString());
    setChecking(false);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const online = rows.filter((r) => r.state === "online").length;
  const issues = rows.filter((r) => r.state === "offline").length;
  const unconfirmed = rows.filter((r) => r.state === "unknown").length;

  const overall: State = checking
    ? "checking"
    : issues > 0
      ? "offline"
      : unconfirmed > 0
        ? "unknown"
        : "online";
  const overallText = checking
    ? "Checking"
    : issues > 0
      ? "Attention required"
      : unconfirmed > 0
        ? "Some checks unconfirmed"
        : "All checks passed";

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(API);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Shell>
      <style>{CSS}</style>
      <div className="st-wrap">
        <div className="st-head">
          <div>
            <div className="st-eyebrow">SYSTEM CONFIGURATION</div>
            <h1>Settings</h1>
            <p>Monitor connections and the status of OmniMed services.</p>
          </div>
          <button type="button" className="st-btn" onClick={() => void run()} disabled={checking}>
            <RefreshCw size={15} className={checking ? "st-spin" : ""} />
            {checking ? "Checking..." : "Re-check"}
          </button>
        </div>

        <section className="st-summary">
          <div className="st-stat">
            <div className="st-stat-icon">
              <Activity size={20} />
            </div>
            <div>
              <div className="st-stat-label">SERVICES CHECKED</div>
              <div className="st-stat-value">{rows.length}</div>
            </div>
          </div>
          <div className="st-stat">
            <div className="st-stat-icon good">
              <CheckCircle2 size={20} />
            </div>
            <div>
              <div className="st-stat-label">OPERATIONAL</div>
              <div className="st-stat-value">{online}</div>
            </div>
          </div>
          <div className="st-stat">
            <div className="st-stat-icon mid">
              <HelpCircle size={20} />
            </div>
            <div>
              <div className="st-stat-label">UNCONFIRMED</div>
              <div className="st-stat-value">{unconfirmed}</div>
            </div>
          </div>
          <div className="st-stat">
            <div className="st-stat-icon warn">
              <CircleAlert size={20} />
            </div>
            <div>
              <div className="st-stat-label">ISSUES</div>
              <div className="st-stat-value">{issues}</div>
            </div>
          </div>
        </section>

        <section>
          <div className="st-section-head">
            <div>
              <div className="st-eyebrow">CONNECTIVITY</div>
              <h2>Service status</h2>
              <p>Live responses from the configured backend endpoints.</p>
            </div>
            <span className={`st-overall ${overall}`}>
              <span className={`st-dot ${checking ? "pulse" : ""}`} />
              {overallText}
            </span>
          </div>

          <div className="st-list">
            {rows.map((row) => {
              const isOpen = open === row.key;
              const canExpand = row.detail !== undefined;
              return (
                <article className="st-card" key={row.key}>
                  <div className="st-row">
                    <div className="st-icon">{ICONS[row.key]}</div>
                    <div className="st-meta">
                      <h3>{row.label}</h3>
                      <div className="st-path">{row.path}</div>
                      <div className="st-summary-text">{row.summary}</div>
                    </div>
                    <div className="st-right">
                      <span className={`st-badge ${row.state}`}>
                        <span className={`st-dot ${row.state === "checking" ? "pulse" : ""}`} />
                        {LABELS[row.state]}
                      </span>
                      {row.ms !== undefined && <span className="st-ms">{row.ms} ms</span>}
                    </div>
                  </div>

                  {canExpand && (
                    <>
                      <button
                        type="button"
                        className={`st-toggle ${isOpen ? "open" : ""}`}
                        onClick={() => setOpen(isOpen ? null : row.key)}
                      >
                        <ChevronDown size={14} />
                        RESPONSE DETAILS
                      </button>
                      {isOpen && (
                        <div className="st-details">
                          <pre>{pretty(row.detail)}</pre>
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>

          {lastChecked && !checking && <p className="st-last">Last checked at {lastChecked}</p>}
        </section>

        <section className="st-env">
          <div className="st-icon">
            <Server size={20} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="st-eyebrow">ENVIRONMENT</div>
            <h2>Backend configuration</h2>
            <p>OmniMed uses this base URL for API requests.</p>
            <div className="st-url">
              <code>{API}</code>
              <button type="button" className="st-btn" onClick={() => void copyUrl()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="st-help">
              To change the backend address, update <code>NEXT_PUBLIC_API_URL</code> in your
              frontend <code>.env.local</code> file, then restart the development server.
            </p>
          </div>
        </section>

        <p className="st-foot">Decision support only. OmniMed does not replace clinician judgment.</p>
      </div>
    </Shell>
  );
}