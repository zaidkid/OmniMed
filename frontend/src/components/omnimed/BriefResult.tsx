"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, AlertTriangle, Check, CheckCircle2, ClipboardList, Copy, Database,
  LoaderCircle, Pencil, Printer, ShieldCheck, ChevronDown, ChevronUp, X,
} from "lucide-react";

import "./generation.css";
import "./brief-result.css";
import "./care-plan.css";
import type { Obj } from "./useBriefStream";
import { api } from "../Ui";
import PlanProcess from "./PlanProcess";
import { useCarePlanStream } from "./UseCarePlanStream";

type Signal = { label: string; severity?: string; snippet?: string };
type CarePlan = { care_plan_id?: string; patient_id?: string; pathway?: string; status?: string;
  clinician_note?: string | null; evidence_grounded?: boolean; safety_note?: string;
  source_brief_generated_at?: string; [key: string]: unknown };
type Review = "approved" | "rejected";
type SaveStatus = "draft" | "approved";

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

function referenceList(value: unknown): Obj[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? { title: item } : item)
    .filter((item): item is Obj => Boolean(item && typeof item === "object"));
}

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

function EvidenceReferences({ items, title = "Evidence references" }: { items: Obj[]; title?: string }) {
  return (
    <div className="br-block">
      <h4>{title}</h4>
      {items.length ? items.map((item, index) => {
        const url = typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : "";
        const excerpt = String(item.excerpt ?? item.text ?? "");
        return (
          <div className="br-ev" key={`${String(item.title ?? item.source ?? index)}-${index}`}>
            <b>{String(item.title ?? "Medical reference")}</b>
            {typeof item.source === "string" && <p className="br-m">{item.source}</p>}
            {excerpt && <p>{excerpt.length > 520 ? `${excerpt.slice(0, 520)}…` : excerpt}</p>}
            {url && <a href={url} target="_blank" rel="noreferrer">Open source</a>}
          </div>
        );
      }) : <p className="br-empty">No relevant evidence was retrieved.</p>}
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
          Indexed references in Qdrant · supports the brief and care plan
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

  // Review decisions remain local until the clinician saves a draft or approves it.
  const [review, setReview] = useState<Record<string, Review>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  const [clinicianNote, setClinicianNote] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [savedPlanId, setSavedPlanId] = useState("");
  const [planDirty, setPlanDirty] = useState(false);
  const savedLoadKey = useRef("");
  const ignoreSavedPlan = useRef(false);

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

  useEffect(() => {
    const patientId = String(brief.patient_id ?? "");
    const briefGeneratedAt = typeof meta.generated_at === "string" ? meta.generated_at : "";
    if (!patientId || !briefGeneratedAt) return;
    const loadKey = `${patientId}:${briefGeneratedAt}`;
    if (savedLoadKey.current !== loadKey) {
      savedLoadKey.current = loadKey;
      ignoreSavedPlan.current = false;
      setCarePlan(null);
      setReview({});
      setEdits({});
      setApprovedAt(null);
      setSavedPlanId("");
      setPlanDirty(false);
      setSaveMessage("");
    }
    if (ignoreSavedPlan.current) return;
    let active = true;
    api<Obj>(`/api/patients/${encodeURIComponent(patientId)}/care-plan`)
      .then((saved) => {
        const candidate = saved.plan_json && typeof saved.plan_json === "object"
          ? saved.plan_json as Obj
          : saved;
        if (!active || ignoreSavedPlan.current || candidate.patient_id !== patientId || candidate.source_brief_generated_at !== briefGeneratedAt) return;
        const restored = candidate as CarePlan;
        const isApproved = String(restored.status) === "approved";
        setCarePlan(restored);
        setSavedPlanId(String(restored.care_plan_id ?? ""));
        setApprovedAt(isApproved && typeof restored.approved_at === "string" ? restored.approved_at : null);
        setPlanDirty(false);
        setClinicianNote(typeof restored.clinician_note === "string" ? restored.clinician_note : "");
        if (isApproved) {
          const objectives = planList(restored.clinical_objectives ?? restored.objectives);
          const followUp = planList(restored.follow_up);
          setReview({
            ...Object.fromEntries(objectives.map((_, i) => [`now-${i}`, "approved"])),
            ...Object.fromEntries(followUp.map((_, i) => [`next-${i}`, "approved"])),
          } as Record<string, Review>);
          setEdits({});
        } else {
          setReview((restored.review_decisions ?? {}) as Record<string, Review>);
          setEdits((restored.review_edits ?? {}) as Record<string, string>);
        }
        setSaveMessage("Loaded the saved care plan for this clinical brief.");
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [brief.patient_id, meta.generated_at]);

  const refs = carePlan ? referenceList(carePlan.evidence_references) : [];
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
  const canApprove = total > 0 && reviewed === total && approvedCount > 0 && !approvedAt && !editing;
  const approvedTime = approvedAt ? new Date(approvedAt).toLocaleString() : "";

  async function copy() {
    try { await navigator.clipboard.writeText(asText(brief)); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable */ }
  }

  async function generateCarePlan() {
    ignoreSavedPlan.current = true;
    setPlanError(""); setCarePlan(null);
    setReview({}); setEdits({}); setEditing(null); setApprovedAt(null);
    try {
      if (!request || typeof request !== "object")
        throw new Error("The original patient request is unavailable. Generate the clinical brief again.");
      const req = request as Obj;
      const patientState = req.patient_state ?? req.patientState;
      if (!patientState || typeof patientState !== "object" || Array.isArray(patientState))
        throw new Error("Patient state is missing from the original request. The parent component must pass patient_state to BriefResult.");

      const plan = await start({ patient_state: patientState, clinical_brief: brief, clinician_note: clinicianNote.trim() || null });

      if (typeof plan.patient_id === "string" && typeof brief.patient_id === "string" && plan.patient_id !== brief.patient_id)
        throw new Error("The returned care plan belongs to a different patient.");
      const st = String(plan.status ?? "draft").toLowerCase();
      if (!["draft", "pending_review", "awaiting_clinician_review"].includes(st))
        throw new Error(`Unexpected care plan status: ${st}. Check the backend approval workflow.`);

      setCarePlan({ ...plan, status: "draft" });
      setSavedPlanId("");
      setSaveMessage("");
      setPlanDirty(true);
      setShowPlan(true);
    } catch (e) {
      setPlanError(e instanceof DOMException && e.name === "AbortError" ? "Generation cancelled." : e instanceof Error ? e.message : "Unable to generate the care plan.");
    }
  }

  // Any change after approval reopens the review.
  const setDecision = (id: string, value: Review) => {
    setApprovedAt(null);
    setSaveMessage("");
    setPlanDirty(true);
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
      setSaveMessage("");
      setPlanDirty(true);
      setReview((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setEdits((e) => {
        const next = { ...e };
        if (text === original) delete next[id]; else next[id] = text;
        return next;
      });
    }
    setEditing(null);
  };

  async function persistCarePlan(status: SaveStatus) {
    if (!carePlan || savingPlan) return;
    setPlanError("");
    setSaveMessage("");
    setSavingPlan(true);
    const originalObjectives = planList(carePlan.clinical_objectives ?? carePlan.objectives);
    const originalFollowUp = planList(carePlan.follow_up);
    const objectives = originalObjectives.map((item, i) => edits[`now-${i}`] ?? item);
    const followUp = originalFollowUp.map((item, i) => edits[`next-${i}`] ?? item);
    const approvedTime = status === "approved" ? new Date().toISOString() : null;
    const reviewedPlan = {
      care_plan_id: savedPlanId || carePlan.care_plan_id,
      patient_id: String(carePlan.patient_id ?? brief.patient_id ?? ""),
      pathway: String(carePlan.pathway ?? ""),
      clinical_objectives: objectives,
      monitoring: planList(carePlan.monitoring),
      pending_information: planList(carePlan.pending_information),
      follow_up: followUp,
      safety_warnings: planList(carePlan.safety_warnings),
      uncertainty: planList(carePlan.uncertainty),
      evidence_references: refs,
      source_documents: planList(carePlan.source_documents),
      evidence_grounded: grounded,
      evidence_count: evidenceCount,
      missing_sections: planList(carePlan.missing_sections),
      generation_meta: (carePlan.generation_meta ?? {}) as Record<string, unknown>,
      source_brief_generated_at: carePlan.source_brief_generated_at ?? (typeof meta.generated_at === "string" ? meta.generated_at : null),
      clinician_note: clinicianNote.trim() || carePlan.clinician_note || null,
      review_decisions: review,
      review_edits: edits,
      review_state: status === "approved" ? "approved" : reviewed === total && total > 0 ? "reviewed" : "awaiting_clinician_review",
      approved_at: approvedTime,
      created_at: carePlan.created_at,
      status,
    };

    try {
      const saved = await api<CarePlan>("/api/care-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reviewedPlan),
      });
      const id = String(saved.care_plan_id ?? "");
      setSavedPlanId(id);
      setApprovedAt(approvedTime);
      setPlanDirty(false);
      setCarePlan({
        ...carePlan,
        care_plan_id: id || carePlan.care_plan_id,
        status,
        review_state: reviewedPlan.review_state,
        approved_at: approvedTime,
        clinician_note: reviewedPlan.clinician_note,
        created_at: saved.created_at ?? carePlan.created_at,
        updated_at: saved.updated_at,
      });
      setSaveMessage(status === "approved" ? "Approved plan saved to the patient record." : "Draft saved to the patient record.");
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Unable to save the care plan.");
    } finally {
      setSavingPlan(false);
    }
  }

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
        const url = typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : "";
        return (
              <div className="br-ev" key={i}>
                <b>[{i + 1}] {String(item.title ?? item.source ?? item.document ?? `Reference ${i + 1}`)}</b>
                {typeof item.source === "string" && <p className="br-m">{item.source}</p>}
                {body && <p>{body.length > 420 ? `${body.slice(0, 420)}…` : body}</p>}
                {url && <a href={url} target="_blank" rel="noreferrer">Open source</a>}
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
        <div className="br-plan-generate">
          <label htmlFor="care-plan-note">Clinician context (optional)</label>
          <textarea id="care-plan-note" value={clinicianNote} onChange={(event) => { setClinicianNote(event.target.value); setApprovedAt(null); setSaveMessage(""); setPlanDirty(true); }} disabled={generatingPlan} placeholder="Add context for this draft, if needed" />
          <button type="button" className="br-btn" onClick={() => void generateCarePlan()} disabled={fallback || generatingPlan}>
            {generatingPlan ? <LoaderCircle size={16} className="og-spin" /> : <ClipboardList size={16} />}
            {generatingPlan ? "Generating care plan..." : carePlan ? "Regenerate care plan" : "Generate care plan"}
          </button>
        </div>
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
              <span className={reviewed === total && total > 0 ? "ok" : "now"}>{reviewed === total && total > 0 ? "✓ " : ""}Clinician review</span><hr />
              <span className={approvedAt ? "ok" : "off"}>{approvedAt ? "✓ " : ""}Approved</span>
            </div>
            <button type="button" className="og-btn og-noprint" onClick={() => setShowPlan((v) => !v)} aria-expanded={showPlan}>
              {showPlan ? "Collapse" : "View plan"}{showPlan ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {approvedAt && (
              <Link className="og-btn og-noprint" href={`/reassessment?patient_id=${encodeURIComponent(String(carePlan.patient_id ?? brief.patient_id ?? ""))}`}>
                Start reassessment
              </Link>
            )}
          </div>

          <PlanFlow evidenceCount={evidenceCount} grounded={grounded} />

          <div className={`cp-draft ${approvedAt ? "approved" : ""}`}>
            <strong>{approvedAt ? "Approved plan" : savedPlanId ? planDirty ? "Unsaved changes" : "Saved draft" : "Draft"}</strong>
            {approvedAt
              ? ` · ${approvedTime}. Saved to the patient record.`
              : savedPlanId ? planDirty ? " · Changes not saved" : " · Saved; awaiting clinician approval" : " · Awaiting clinician review; not yet saved"}
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
                  <EvidenceReferences items={refs} />
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
                    ? "Approved snapshot saved. Editing an item clears approval; save again to record the revision."
                    : `Approve or reject every action (${reviewed} of ${total} done). Rejected actions are excluded from the approved plan.`}
                </p>
                <div className="cp-review-actions">
                  <button type="button" className="og-btn" disabled={savingPlan || Boolean(editing)} onClick={() => void persistCarePlan("draft")}>
                    {savingPlan ? <LoaderCircle size={14} className="og-spin" /> : <CheckCircle2 size={14} />}
                    {savedPlanId ? "Save draft changes" : "Save draft"}
                  </button>
                  <button type="button" className="cp-approve" disabled={!canApprove || savingPlan} onClick={() => void persistCarePlan("approved")}>
                    {approvedAt ? "Approved and saved" : savingPlan ? "Saving..." : "Approve and save plan"}
                  </button>
                </div>
              </div>
              {saveMessage && <p className="cp-save-message" role="status">{saveMessage}</p>}

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
