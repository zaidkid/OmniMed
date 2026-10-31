"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, BrainCircuit, Clock3, Database, Info,
  RefreshCw, Server, ShieldCheck, X, Zap,
} from "lucide-react";
import { API } from "../Ui";

type State = "checking" | "online" | "offline" | "unknown";
type Service = {
  title: string;
  subtitle: string;
  endpoint: string;
  state: State;
  detail: string;
  data?: unknown;
  checkedAt?: string;
};
type Props = { filename: string; patientId: string; characters: number };

const OK = /^(ok|healthy|online|ready|running|connected|available|success|green|up)$/i;
const BAD = /^(disconnected|down|error|failed|offline|unavailable|red)$/i;
const DB_KEYS = [
  "database", "postgres", "postgresql", "database_status", "db_status", "db", "postgres_status",
];
const STATE_KEYS = ["healthy", "connected", "ready", "available", "ok", "status", "state"];
const QDRANT_KEYS = ["collections", "points_count", "vectors_count", "qdrant", "vector_db"];
const POLL_MS = 15000;

const ICONS: Record<string, React.ReactNode> = {
  backend: <Server size={20} />,
  llm: <BrainCircuit size={20} />,
  database: <Database size={20} />,
  qdrant: <Zap size={20} />,
};

const svc = (title: string, subtitle: string, endpoint: string, state: State, detail: string): Service =>
  ({ title, subtitle, endpoint, state, detail });

const initial: Record<string, Service> = {
  backend: svc("FastAPI Backend", "REST API", "/health", "checking", "Checking API..."),
  llm: svc("LLM Service (Ollama)", "Model runtime", "/api/ai/status", "checking", "Checking model service..."),
  database: svc("PostgreSQL Database", "Application data", "/health", "unknown", "Database readiness not confirmed"),
  qdrant: svc("Qdrant Vector DB", "Evidence retrieval", "/api/knowledge/status", "checking", "Checking knowledge service..."),
};

const LABELS: Record<State, string> = {
  checking: "Checking",
  online: "Online",
  offline: "Offline",
  unknown: "Unconfirmed",
};

async function fetchJson(path: string) {
  const res = await fetch(`${API}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${raw.slice(0, 150)}`);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { message: raw };
  }
}

function getField(value: unknown, names: string[], depth = 0): unknown {
  if (depth > 5 || !value || typeof value !== "object") return undefined;
  const lower = names.map((n) => n.toLowerCase());
  const entries = Object.entries(value as Record<string, unknown>);
  const hit = entries.find(([k]) => lower.includes(k.toLowerCase()));
  if (hit) return hit[1];
  for (const [, item] of entries) {
    const r = getField(item, names, depth + 1);
    if (r !== undefined) return r;
  }
}

function healthy(v: unknown): boolean {
  const r = v && typeof v === "object" ? getField(v, STATE_KEYS) : v;
  return r === true || (typeof r === "string" && OK.test(r.trim()));
}

// Explicit failure signal in a response body (error field, status "error", healthy:false, etc.)
function failing(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  if (getField(v, ["error", "errors", "exception"]) != null) return true;
  const r = getField(v, STATE_KEYS);
  return r === false || (typeof r === "string" && BAD.test(r.trim()));
}

const isUp = (key: string, data: unknown) => {
  if (key === "backend") return true;
  if (healthy(data)) return true;
  // Qdrant: a successful 200 from the knowledge status endpoint with no
  // error/failure signal means the backend reached the vector store.
  if (key === "qdrant") {
    return getField(data, QDRANT_KEYS) !== undefined || !failing(data);
  }
  return false;
};

const ISO = /^\d{4}-\d{2}-\d{2}T/;
const fmt = (v: unknown) =>
  typeof v === "string" && ISO.test(v) && !isNaN(Date.parse(v))
    ? new Date(v).toLocaleString()
    : String(v);

function flatten(v: unknown, prefix = ""): [string, string][] {
  if (v === null || typeof v !== "object") return [[prefix.replace(/\.$/, "") || "value", fmt(v)]];
  return Object.entries(v).flatMap(([k, x]): [string, string][] =>
    Array.isArray(x) && x.every((i) => typeof i !== "object")
      ? [[prefix + k, x.join(", ")]]
      : flatten(x, `${prefix}${k}.`)
  );
}

function StatusCard({ service, icon, onDetails }: {
  service: Service;
  icon: React.ReactNode;
  onDetails: () => void;
}) {
  return (
    <div className="omni-service-card">
      <div className="omni-service-icon">{icon}</div>
      <div className="omni-service-content">
        <div className="omni-service-title-row">
          <h3>{service.title}</h3>
          <span className={`omni-status-pill ${service.state}`}>
            <span className="omni-status-dot" />
            {LABELS[service.state]}
          </span>
        </div>
        <p className="omni-service-subtitle">{service.subtitle}</p>
        <p className="omni-service-detail">{service.detail}</p>
        <button className="omni-text-button" onClick={onDetails} type="button">
          View technical details ↗
        </button>
      </div>
    </div>
  );
}

function Panel({ icon, color, title, subtitle, action, children }: {
  icon: React.ReactNode;
  color: string;
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="omni-panel">
      <div className="omni-panel-heading">
        <div className={`omni-heading-icon ${color}`}>{icon}</div>
        <div className="omni-panel-heading-text">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const Row = ({ label, children, brk }: { label: string; children: React.ReactNode; brk?: boolean }) => (
  <div className="omni-info-row">
    <span>{label}</span>
    <strong className={brk ? "omni-break" : undefined}>{children}</strong>
  </div>
);

export default function StatusSidebar({ filename, patientId, characters }: Props) {
  const [services, setServices] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);

    const defs = [
      { key: "backend", path: "/health" },
      { key: "llm", path: "/api/ai/status" },
      { key: "qdrant", path: "/api/knowledge/status" },
    ];
    const checkedAt = new Date().toLocaleTimeString();
    const next: Record<string, Service> = { ...initial };

    const results = await Promise.allSettled(
      defs.map(async (d) => ({ ...d, data: await fetchJson(d.path) }))
    );

    results.forEach((r, i) => {
      const { key } = defs[i];
      if (r.status === "rejected") {
        next[key] = {
          ...initial[key],
          state: "offline",
          detail: r.reason instanceof Error ? r.reason.message.slice(0, 100) : "Endpoint unavailable",
          checkedAt,
        };
        return;
      }
      const up = isUp(key, r.value.data);
      next[key] = {
        ...initial[key],
        state: up ? "online" : "unknown",
        detail: up
          ? key === "backend"
            ? "Health endpoint responding"
            : key === "qdrant"
              ? "Knowledge service reachable"
              : "Service reports healthy"
          : "Endpoint reachable; readiness not confirmed",
        data: r.value.data,
        checkedAt,
      };
    });

    const db = getField(next.backend.data, DB_KEYS);
    next.database =
      db !== undefined
        ? {
            ...initial.database,
            state: healthy(db) ? "online" : BAD.test(String(db)) || failing(db) ? "offline" : "unknown",
            detail:
              healthy(db) ? "Database reports healthy"
              : typeof db === "string" ? db
              : "Database status returned; readiness unconfirmed",
            data: db,
            checkedAt,
          }
        : next.backend.state === "offline"
          ? { ...initial.database, state: "offline", detail: "Backend unreachable", checkedAt }
          : { ...initial.database, detail: "Database status is not exposed by /health" };

    setServices(next);
    setRefreshing(false);
    busy.current = false;
  }, []);

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && void refresh();
    tick();
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const allOnline = Object.values(services).every((s) => s.state === "online");
  const llm = services.llm;
  const open = details ? services[details] : null;

  const llmRows: [string, unknown][] = [
    ["Provider", getField(llm.data, ["provider"])],
    ["Model", getField(llm.data, ["model", "model_name"])],
    ["Context length", getField(llm.data, ["context_length", "num_ctx"])],
    ["Temperature", getField(llm.data, ["temperature"])],
  ];

  return (
    <aside className="omni-right-sidebar">
      <Panel
        icon={<Activity size={18} />}
        color="green"
        title="System Status"
        subtitle="Real-time status of OmniMed services"
        action={
          <button
            className="omni-icon-button"
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Refresh status"
          >
            <RefreshCw size={15} className={refreshing ? "omni-spin" : ""} />
          </button>
        }
      >
        <div className={`omni-system-summary ${allOnline ? "healthy" : ""}`}>
          <span className="omni-status-dot" />
          {allOnline ? "All services report healthy" : "Service readiness"}
        </div>

        <div className="omni-service-list">
          {Object.entries(services).map(([key, service]) => (
            <StatusCard
              key={key}
              service={service}
              icon={ICONS[key]}
              onDetails={() => setDetails((c) => (c === key ? null : key))}
            />
          ))}
        </div>

        {open && (
          <div className="omni-detail-box">
            <div className="omni-detail-heading">
              <div>
                <h3>{open.title}</h3>
                <p>{open.endpoint}</p>
              </div>
              <button
                className="omni-icon-button"
                type="button"
                onClick={() => setDetails(null)}
                aria-label="Close details"
              >
                <X size={15} />
              </button>
            </div>
            <dl className="omni-detail-list">
              {flatten(open.data ?? { state: open.state, detail: open.detail }).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <p className="omni-last-checked">
          <Clock3 size={12} />
          Last checked: {services.backend.checkedAt || "Not checked"}
        </p>
      </Panel>

      <Panel icon={<BrainCircuit size={18} />} color="purple" title="About LLM" subtitle="Model configuration">
        {llmRows.map(([label, value]) => (
          <Row key={label} label={label}>
            {value == null ? "Not exposed" : String(value)}
          </Row>
        ))}
        <Row label="Status">
          <span className="omni-status-inline">
            <span className={`omni-status-dot ${llm.state}`} />
            {LABELS[llm.state]}
          </span>
        </Row>
      </Panel>

      <Panel icon={<Info size={18} />} color="blue" title="Workspace Info" subtitle="Current session">
        <Row label="Environment">Development</Row>
        <Row label="API Base URL" brk>{API}</Row>
        <Row label="Document" brk>{filename || "None uploaded"}</Row>
        <Row label="Patient ID">{patientId || "Not selected"}</Row>
        <Row label="Characters">{characters.toLocaleString()}</Row>
      </Panel>

      <section className="omni-safety-note">
        <ShieldCheck size={17} />
        <div>
          <h3>Clinical safety</h3>
          <p>
            Verify extracted values against the original report. AI-generated
            content is decision support and requires clinician review.
          </p>
        </div>
      </section>
    </aside>
  );
}