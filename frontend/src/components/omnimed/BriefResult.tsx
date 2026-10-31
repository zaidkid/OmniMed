"use client";

import { useState } from "react";
import {
  AlertCircle, AlertTriangle, Check, CheckCircle2, ClipboardList, Copy, Database,
  LoaderCircle, Pencil, Printer, ShieldCheck, ChevronDown, ChevronUp, X,
} from "lucide-react";

import "./generation.css";
import "./brief-result.css";
import "./care-plan.css";
import type { Obj } from "./useBriefStream";
import PlanProcess from "./PlanProcess";
import { useCarePlanStream } from "./UseCarePlanStream";

type Signal = { label: string; severity?: string; snippet?: string };
type CarePlan = { care_plan_id?: string; patient_id?: string; pathway?: string; status?: string;
  clinician_note?: string | null; evidence_grounded?: boolean; safety_note?: string; [key: string]: unknown };
type Review = "approved" | "rejected";

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((i) => (typeof i === "string" ? i : JSON.stringify(i))) : [];

// Tolerate a JSON-array string or plain string so raw JSON is never printed.
const planList = (v: unknown): string[] => {
  if (typeof v !== "string") return list(v);
  const t = v.trim();
  if (t.startsWith("[")) {
    try { const p: unknown = JSON.parse(t); if (Array.isArray(p)) return list(p); } catch { /* plain text */ }
  }
  return t ? [t] : [];
};

const SECTIONS: [string, string, string?][] = [
  ["key_findings", "Key findings"],
  ["concerns", "Concerns and risks"],
  ["clinical_possibilities", "Clinical possibilities", "Uncertain; for clinician interpretation"],
  ["recommended_review", "Items for clinician review"],
  ["missing_information", "Missing information"],
  ["uncertainty", "Uncertainty and limitations"],
];

const SOURCE_TEXT = (rule: string, model: string | null) =>
  !model || rule === model ? "Automated screening and model assessment agree"
  : rule === "routine" || (rule === "urgent" && model === "emergent")
    ? "Level set by the model assessment" : "Level set by automated screening";

function asText(b: Obj): string {
  const u = (b.urgency ?? {}) as Obj;
  const lines = [
    `CLINICAL BRIEF · patient ${String(b.patient_id ?? "unknown")}`,
    `URGENCY: ${String(u.label ?? "Not assessed")}`,
    ...(u.rationale ? [String(u.rationale)] : []),
    ...(Array.isArray(u.signals) ? (u.signals as Signal[]).map((s) => `- ${s.label}${s.snippet ? ` ("${s.snippet}")` : ""}`) : []),
    "", "SUMMARY", String(b.summary ?? ""),
  ];
  for (const [key, title] of SECTIONS) {
    const items = list(b[key]);
    if (items.length) lines.push("", title.toUpperCase(), ...items.map((i) => `- ${i}`));
  }
  return [...lines, "", String(b.safety_note ?? "Decision support only. Clinician review required.")].join("\n");
}

// One list block for both brief sections and care-plan panels.
function Block({ n, title, note, items, empty = "None returned.", hideEmpty, className = "", as: H = "h3" }: {
  n?: number; title: string; note?: string; items: string[]; empty?: string;
  hideEmpty?: boolean; className?: string; as?: "h3" | "h4";
}) {
  if (!items.length && hideEmpty) return null;
  return (
    <div className={`br-block ${className}`}>
      <H>{n && <span className="br-num">{n}</span>}{title}</H>
      {note && <p className="br-m">{note}</p>}
      {items.length ? <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="br-empty">{empty}</p>}
    </div>
  );
}

// Mirrors the care-plan design: purple = AI-generated draft, always reviewed by a clinician.
function PlanFlow({ evidenceCount, grounded }: { evidenceCount: number; grounded: boolean }) {
  return (
    <>
      <div className="cp-flow" aria-label="Care plan flow">
        <div className="cp-node"><b>Patient state</b><small>Reports, labs, notes</small></div>
        <span className="cp-arrow" aria-hidden>→</span>
        <div className="cp-node ai"><b>Clinical brief</b><small>Findings, risks</small></div>
        <span className="cp-arrow" aria-hidden>→</span>
        <div className="cp-node ai"><b>Care plan</b><small>Draft actions</small></div>
        <span className="cp-arrow" aria-hidden>→</span>
        <div className="cp-node"><b>Clinician</b><small>Review, approve</small></div>
        <div className="cp-evid">
          <Database size={13} />
          Evidence store · Guidelines in Qdrant · feeds the brief and the care plan
          {grounded ? ` · ${evidenceCount} passage${evidenceCount === 1 ? "" : "s"} used` : " · none used for this plan"}
        </div>
      </div>
      <p className="cp-legend"><i />Purple = AI-generated draft, always reviewed by a clinician</p>
    </>
  );
}

export default function BriefResult({ brief, request }: { brief: Obj; request: unknown }) {
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);
  const { trace, running: generatingPlan, start, cancel } = useCarePlanStream();
  const [planError, setPlanError] = useState("");
  const [carePlan, setCarePlan] = useState<CarePlan | null>(null);
  const [showPlan, setShowPlan] = useState(true);

  // Clinician review of the draft. Held in this session only; nothing is saved to the record yet.
  const [review, setReview] = useState<Record<string, Review>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [approvedAt, setApprovedAt] = useState<string | null>(null);

  const fallback = brief.generation_status === "fallback";
  const urgency = (brief.urgency ?? {}) as Obj;
  const level = ["emergent", "urgent", "routine"].includes(String(urgency.level)) ? String(urgency.level) : "routine";
  const signals = Array.isArray(urgency.signals) ? (urgency.signals as Signal[]) : [];
  const verification = (brief.verification ?? {}) as Obj;
  const issues = list(verification.issues);
  const warnings = list(verification.warnings);
  const meta = (brief.generation_meta ?? {}) as Obj;
  const evidence = (Array.isArray(brief.evidence) ? brief.evidence : []).map((e) =>
    typeof e === "object" && e !== null ? (e as Obj) : { text: String(e) });
  const status = String(verification.status ?? "needs_review").replace(/_/g, " ");
  const verified = Boolean(verification.safe) && !issues.length;
  const generated = typeof meta.generated_at === "string" ? new Date(meta.generated_at).toLocaleString() : "";

  const refs = carePlan ? planList(carePlan.evidence_references) : [];
  const grounded = carePlan ? (typeof carePlan.evidence_grounded === "boolean" ? carePlan.evidence_grounded : refs.length > 0) : false;
  const evidenceCount = carePlan && typeof carePlan.evidence_count === "number" ? carePlan.evidence_count : refs.length;
  const limits = carePlan ? planList(carePlan.uncertainty) : [];
  const groups: [string, string, string[]][] = carePlan ? [
    ["now", "Objectives", planList(carePlan.clinical_objectives ?? carePlan.objectives)],
    ["next", "Follow-up", planList(carePlan.follow_up)],
  ] : [];
  const total = groups.reduce((s, g) => s + g[2].length, 0);
  const ids = groups.flatMap(([tone, , items]) => items.map((_, i) => `${tone}-${i}`));
  const reviewed = ids.filter((id) => review[id]).length;
  const approvedCount = ids.filter((id) => review[id] === "approved").length;
  const canApprove = total > 0 && reviewed === total && approvedCount > 0 && !approvedAt;
  const approvedTime = approvedAt ? new Date(approvedAt).toLocaleString() : "";

  async function copy() {
    try { await navigator.clipboard.writeText(asText(brief)); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable */ }
  }

  async function generateCarePlan() {
    setPlanError(""); setCarePlan(null);
    setReview({}); setEdits({}); setEditing(null); setApprovedAt(null);
    try {
      if (!request || typeof request !== "object")
        throw new Error("The original patient request is unavailable. Generate the clinical brief again.");
      const req = request as Obj;
      const patientState = req.patient_state ?? req.patientState;
      if (!patientState || typeof patientState !== "object" || Array.isArray(patientState))
        throw new Error("Patient state is missing from the original request. The parent component must pass patient_state to BriefResult.");

      const plan = await start({ patient_state: patientState, clinical_brief: brief, clinician_note: null });

      if (typeof plan.patient_id === "string" && typeof brief.patient_id === "string" && plan.patient_id !== brief.patient_id)
        throw new Error("The returned care plan belongs to a different patient.");
      const st = String(plan.status ?? "draft").toLowerCase();
      if (!["draft", "pending_review", "awaiting_clinician_review"].includes(st))
        throw new Error(`Unexpected care plan status: ${st}. Check the backend approval workflow.`);

      setCarePlan({ ...plan, status: "draft" });
      setShowPlan(true);
    } catch (e) {
      setPlanError(e instanceof DOMException && e.name === "AbortError" ? "Generation cancelled." : e instanceof Error ? e.message : "Unable to generate the care plan.");
    }
  }

  // Any change after approval reopens the review.
  const setDecision = (id: string, value: Review) => {
    setApprovedAt(null);
    setReview((r) => {
      const next = { ...r };
      if (next[id] === value) delete next[id]; else next[id] = value;
      return next;
    });
  };
  const beginEdit = (id: string, current: string) => { setEditing(id); setEditText(current); };
  const saveEdit = (id: string, original: string) => {
    const text = editText.trim();
    if (text) {
      setApprovedAt(null);
      setEdits((e) => {
        const next = { ...e };
        if (text === original) delete next[id]; else next[id] = text;
        return next;
      });
    }
    setEditing(null);
  };

  return (
    <section className="og-card og-print br">
      <div className="br-head">
        <div>
          <p className="br-k">Clinical brief</p>
          <h2>Patient {String(brief.patient_id ?? "")}</h2>
          <p className="br-m">
            {[generated, typeof meta.model === "string" && `Model ${meta.model}`].filter(Boolean).join(" · ")}
            {generated || meta.model ? " · " : ""}Review against the original report and supporting evidence.
          </p>
        </div>
        <div className="br-actions og-noprint">
          {fallback
            ? <span className="og-pill err"><AlertCircle size={13} />Fallback, not AI interpretation</span>
            : <span className="og-pill run">AI-generated draft</span>}
          <button type="button" className="og-btn" onClick={() => void copy()}><Copy size={13} />{copied ? "Copied" : "Copy"}</button>
          <button type="button" className="og-btn" onClick={() => window.print()}><Printer size={13} />Print</button>
          <button type="button" className="og-btn" onClick={() => setShowJson((v) => !v)}>{showJson ? "Hide JSON" : "Inspect JSON"}</button>
        </div>
      </div>

      <div className={`br-urg ${level}`} role={level === "emergent" ? "alert" : "region"} aria-label="Urgency assessment">
        <div className="br-urg-title">
          <AlertTriangle size={26} />
          <div>
            <strong>{String(urgency.label ?? "Urgency not assessed")}</strong>
            <small>{SOURCE_TEXT(String(urgency.rule_based_level ?? "routine"), typeof urgency.model_level === "string" ? urgency.model_level : null)}</small>
          </div>
        </div>
        <div>
          {typeof urgency.rationale === "string" && urgency.rationale && <p>{urgency.rationale}</p>}
          {signals.length > 0 && (
            <div className="br-chips">
              {signals.map((s, i) => <span className="br-chip" key={i} title={s.snippet}>{s.label}</span>)}
            </div>
          )}
          {typeof urgency.note === "string" && urgency.note && <p><small>{urgency.note}</small></p>}
        </div>
      </div>

      {fallback && (
        <div className="og-error" role="alert">
          <AlertCircle size={15} />
          <span><strong>AI generation unsuccessful.</strong> {String(brief.generation_error ?? "")} The sections below come from recorded information only; the urgency screening above still applies.</span>
        </div>
      )}

      <div className="br-summary">
        <p className="br-k">Clinical summary</p>
        <p>{String(brief.summary ?? "Not provided")}</p>
      </div>

      <div className="br-grid">
        {SECTIONS.map(([key, title, note], i) => (
          <Block key={key} n={i + 1} title={title} note={note} items={list(brief[key])} className={key === "uncertainty" ? "warn" : ""} />
        ))}

        <div className="br-block">
          <h3><span className="br-num">{SECTIONS.length + 1}</span>Evidence references</h3>
          <p className="br-m">Reference material, not patient data</p>
          {evidence.length ? evidence.map((item, i) => {
            const score = typeof item.score === "number" ? item.score : null;
            const body = String(item.text ?? item.content ?? item.chunk ?? item.passage ?? "");
            return (
              <div className="br-ev" key={i}>
                <b>[{i + 1}] {String(item.title ?? item.source ?? item.document ?? `Reference ${i + 1}`)}</b>
                {body && <p>{body.length > 420 ? `${body.slice(0, 420)}…` : body}</p>}
                {score !== null && (
                  <div className="br-score">
                    {score >= 0 && score <= 1 && <div><i style={{ width: `${score * 100}%` }} /></div>}
                    <small>Retrieval score {score.toFixed(2)}</small>
                  </div>
                )}
              </div>
            );
          }) : <p className="br-empty">No relevant evidence was retrieved.</p>}
        </div>

        <div className={`br-block ${verified ? "" : "warn"}`}>
          <h3><span className="br-num">{SECTIONS.length + 2}</span>Verification</h3>
          <p className="br-m">
            {verified ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />} Status: {status} · Evidence grounded: {verification.evidence_grounded ? "yes" : "no"}. Heuristic checks, not clinical validation.
          </p>
          {[...issues, ...warnings].length > 0 && <ul>{[...issues, ...warnings].map((t, i) => <li key={i}>{t}</li>)}</ul>}
        </div>
      </div>

      <p className="br-m">
        {typeof meta.elapsed_seconds === "number" && `Generated in ${meta.elapsed_seconds} s · `}
        reasoning {meta.thinking_available ? "exposed by the model" : "not exposed by the model"}
      </p>
      <div className="br-safe" style={{ borderRadius: 12, marginTop: 10 }}>
        <ShieldCheck size={15} />{String(brief.safety_note ?? "Decision support only. Clinician review required.")}
      </div>

      <div className="br-launch og-noprint">
        <div>
          <h3>Care plan</h3>
          <p className="br-m">Generate a separate draft based on this clinical brief. It will remain pending clinician review.</p>
        </div>
        <button type="button" className="br-btn" onClick={() => void generateCarePlan()} disabled={fallback || generatingPlan}>
          {generatingPlan ? <LoaderCircle size={16} className="og-spin" /> : <ClipboardList size={16} />}
          {generatingPlan ? "Generating care plan..." : carePlan ? "Regenerate care plan" : "Generate care plan"}
        </button>
      </div>

      {planError && <div className="og-error og-noprint" role="alert"><AlertCircle size={15} /><span>{planError}</span></div>}
      {(generatingPlan || trace.started) && <PlanProcess trace={trace} running={generatingPlan} onCancel={cancel} />}

      {carePlan && (
        <section className="br-plan" aria-labelledby="br-plan-title">
          <div className="br-plan-top">
            <div>
              <p className="br-k" style={{ color: "var(--cp-purple)" }}>Care planning</p>
              <h3 id="br-plan-title">Generated care plan</h3>
              <p className="br-m">Patient {String(carePlan.patient_id ?? brief.patient_id ?? "")} · AI-generated draft</p>
            </div>
            <div className="br-track">
              <span className="ok">✓ Generated</span><hr />
              <span className={approvedAt ? "ok" : "now"}>{approvedAt ? "✓ " : ""}Clinician review</span><hr />
              <span className={approvedAt ? "ok" : "off"}>{approvedAt ? "✓ " : ""}Approved</span>
            </div>
            <button type="button" className="og-btn og-noprint" onClick={() => setShowPlan((v) => !v)} aria-expanded={showPlan}>
              {showPlan ? "Collapse" : "View plan"}{showPlan ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>

          <PlanFlow evidenceCount={evidenceCount} grounded={grounded} />

          <div className={`cp-draft ${approvedAt ? "approved" : ""}`}>
            <strong>{approvedAt ? "Approved by clinician" : "Draft"}</strong>
            {approvedAt
              ? ` · ${approvedTime}. Held in this session only; it has not been saved to the patient record.`
              : " · Awaiting clinician review"}
            {!grounded && <span className="og-pill err" style={{ marginLeft: 8 }}><AlertCircle size={13} />Not evidence-grounded</span>}
            {typeof carePlan.care_plan_id === "string" && <span className="br-id" style={{ marginLeft: 8 }} title={carePlan.care_plan_id}>Plan {carePlan.care_plan_id.slice(0, 8)}</span>}
          </div>

          {showPlan && (
            <>
              {typeof carePlan.pathway === "string" && carePlan.pathway.trim() && (
                <div className="br-path"><p className="br-k" style={{ color: "var(--cp-purple)" }}>Proposed pathway</p><p>{carePlan.pathway}</p></div>
              )}

              <div className="br-cols">
                <div>
                  <div className="br-plan-top" style={{ padding: "16px 22px 10px" }}>
                    <h4 style={{ fontSize: 15, fontWeight: 700 }}>Action plan</h4>
                    <span className="br-m">{reviewed} of {total} reviewed</span>
                  </div>
                  {groups.map(([tone, label, items]) => items.length > 0 && (
                    <div key={tone}>
                      <div className="br-grp"><span className={`br-tag ${tone}`}>{tone === "now" ? "Now" : "Next"}</span>{label}</div>
                      {items.map((original, i) => {
                        const id = `${tone}-${i}`;
                        const text = edits[id] ?? original;
                        const decision = review[id];
                        return (
                          <div key={id} className={`cp-row ${decision ?? ""}`}>
                            <span className="br-num">{i + 1}</span>
                            <span className="cp-text">
                              {text}{edits[id] && <span className="cp-edited">edited</span>}
                            </span>
                            <span className="cp-btns og-noprint">
                              <button type="button" className={`cp-icon ${decision === "approved" ? "on-ok" : ""}`} onClick={() => setDecision(id, "approved")} aria-pressed={decision === "approved"} aria-label={`Approve: ${text}`} title="Approve"><Check size={14} /></button>
                              <button type="button" className="cp-icon" onClick={() => beginEdit(id, text)} aria-label={`Edit: ${text}`} title="Edit"><Pencil size={13} /></button>
                              <button type="button" className={`cp-icon ${decision === "rejected" ? "on-bad" : ""}`} onClick={() => setDecision(id, "rejected")} aria-pressed={decision === "rejected"} aria-label={`Reject: ${text}`} title="Reject"><X size={14} /></button>
                            </span>
                            {editing === id && (
                              <div className="cp-edit og-noprint">
                                <textarea value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Edit action text" />
                                <div className="cp-edit-actions">
                                  <button type="button" className="og-btn" onClick={() => saveEdit(id, original)}>Save</button>
                                  <button type="button" className="og-btn" onClick={() => setEditing(null)}>Cancel</button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {!total && <p className="br-empty" style={{ padding: "0 22px 18px" }}>Not generated. Review the clinical brief directly.</p>}
                </div>

                <div className="br-side">
                  <Block as="h4" title="Monitoring considerations" items={planList(carePlan.monitoring)} empty="Not generated. Review the clinical brief directly." />
                  <Block as="h4" title="Pending information" items={planList(carePlan.pending_information)} hideEmpty />
                  <Block as="h4" title="Source report" items={planList(carePlan.source_documents)} hideEmpty />
                  <Block as="h4" title="Evidence references" items={refs} empty="No external evidence retrieved." />
                  <Block as="h4" title="Safety warnings" items={planList(carePlan.safety_warnings)} hideEmpty />
                </div>
              </div>

              {limits.length > 0 && <div className="br-limits"><Block as="h4" title="Uncertainty and limitations" items={limits} /></div>}
              {typeof carePlan.clinician_note === "string" && carePlan.clinician_note && (
                <div className="br-limits" style={{ background: "#fff", color: "inherit" }}><Block as="h4" title="Clinician note" items={[carePlan.clinician_note]} /></div>
              )}

              <div className="cp-review og-noprint">
                <p>
                  {approvedAt
                    ? "Review complete. Changing any action reopens the review."
                    : `Approve or reject every action (${reviewed} of ${total} done). Rejected actions are excluded from the approved plan.`}
                </p>
                <button type="button" className="cp-approve" disabled={!canApprove} onClick={() => setApprovedAt(new Date().toISOString())}>
                  {approvedAt ? "Approved" : "Approve reviewed plan"}
                </button>
              </div>

              <div className="br-safe">
                <ShieldCheck size={17} />
                <span>{String(carePlan.safety_note ?? "Decision support only. This AI-generated draft is not a diagnosis, prescription, or treatment order. Clinician review is required.")}</span>
              </div>
            </>
          )}
        </section>
      )}

      {showJson && (
        <pre className="og-json og-noprint">
          {JSON.stringify({
            request, response: brief, generated_care_plan: carePlan,
            clinician_review: { decisions: review, edits, approved_at: approvedAt },
          }, null, 2)}
        </pre>
      )}
    </section>
  );
}