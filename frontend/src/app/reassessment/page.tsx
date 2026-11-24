"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle2, LoaderCircle, UploadCloud } from "lucide-react";

import Shell from "../../components/Shell";
import { API, api } from "../../components/Ui";

type Obj = Record<string, unknown>;
type TimelineEvent = { timestamp: string; type: string; name: string; value?: unknown; unit?: string; source?: string };
type PatientState = {
  patient_id: string;
  age: number;
  sex: string;
  conditions: string[];
  medications: string[];
  allergies: string[];
  symptoms: string[];
  vitals: Obj;
  timeline: TimelineEvent[];
  missing_information: string[];
  notes: string[];
  updated_at?: string;
};
type ReassessmentResult = {
  patient_id: string;
  changed_items: Obj[];
  care_plan_impact: string;
  rationale: string[];
  reassessment_questions: string[];
  evidence: Obj[];
  safety_note: string;
};
type Decision = "accepted" | "edit" | "dismissed";
type UploadResult = { document_id: string; structured_report?: unknown; extracted_text?: string; text_preview?: string; filename?: string; vision_available?: boolean; vision_model?: string | null };
type VisionResult = { summary: string; observed_features: string[]; image_quality: string; possible_modality: string; uncertainties: string[]; clinician_review_questions: string[]; model: string };
type ExtractedFacts = { conditions: string[]; medications: string[]; allergies: string[]; symptoms: string[]; vitals: Record<string, string>; labs: { name: string; value: string; unit: string }[]; clinical_notes: string[] };
type ReviewForm = {
  conditions: string; medications: string; allergies: string; symptoms: string;
  blood_pressure: string; heart_rate: string; spo2: string; temperature: string;
  respiratory_rate: string; labs: string; clinical_note: string;
};

const CSS = `
.rr{max-width:1120px;margin:0 auto;padding:28px 24px 48px;color:#172554}
.rr *{box-sizing:border-box}.rr-head{display:flex;justify-content:space-between;gap:20px;margin:0 0 22px;align-items:flex-start}
.rr-back{display:inline-flex;align-items:center;gap:7px;color:#64748b;text-decoration:none;font-size:12px;font-weight:650;margin-bottom:16px}
.rr-eyebrow{font-size:10px;letter-spacing:.09em;font-weight:800;color:#6480aa;margin:0 0 7px}.rr h1{font-size:clamp(25px,3vw,34px);margin:0;font-weight:800;letter-spacing:-.04em}.rr h2{font-size:16px;margin:0;font-weight:750}.rr p{line-height:1.65}
.rr-muted{color:#718096;font-size:12px}.rr-card{background:#fff;border:1px solid #e1e9f3;border-radius:15px;padding:21px;margin:0 0 15px;box-shadow:0 2px 8px #18376308}
.rr-row{display:flex;align-items:center;justify-content:space-between;gap:14px}.rr-form{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:10px;margin-top:16px}
.rr input,.rr textarea{width:100%;border:1px solid #d7e1ee;border-radius:9px;padding:10px 12px;color:#1e293b;font:inherit;font-size:13px}.rr textarea{min-height:78px;resize:vertical;margin-top:12px}
.rr button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:9px 14px;border:1px solid #d6e0ee;border-radius:9px;background:#fff;color:#334155;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.rr button.primary{border-color:#2376f5;background:#2376f5;color:#fff}.rr button:disabled{opacity:.55;cursor:not-allowed}
.rr-upload{min-height:130px;width:100%;margin-top:15px;display:flex;flex-direction:column;gap:8px;border:1.5px dashed #b9cdec!important;background:#f8fbff!important;color:#2376f5!important}.rr-upload span{font-weight:500;color:#718096}
.rr-error{padding:10px 12px;background:#fff1f2;color:#b91c1c;border:1px solid #fecaca;border-radius:9px;font-size:12px}.rr-progress{margin-top:14px;color:#2563eb;font-size:12px;display:flex;align-items:center;gap:8px}
.rr-compare{display:grid;grid-template-columns:minmax(0,1fr) 32px minmax(0,1fr);align-items:center;gap:12px;margin-top:16px}.rr-state{padding:15px;border:1px solid #e1e9f3;border-radius:11px;background:#fbfdff}.rr-arrow{display:grid;place-items:center;color:#2376f5}.rr-change{display:grid;grid-template-columns:minmax(120px,.6fr) 1fr 1fr;gap:10px;padding:12px 0;border-bottom:1px solid #edf1f7;font-size:12px}.rr-change:last-child{border-bottom:0}.rr-change strong{overflow-wrap:anywhere}.rr-warning{color:#b45309}.rr-evidence{padding:13px;border:1px solid #e1e9f3;border-radius:10px;margin-top:10px;background:#fbfdff}.rr-evidence a{color:#2563eb}.rr-evidence p{font-size:12px;color:#64748b;margin:6px 0 0}.rr-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}.rr-decision{margin-top:12px;color:#166534;font-size:12px;font-weight:700}.rr-empty{padding:26px 15px;text-align:center;background:#f8fbff;border-radius:11px;color:#718096;font-size:13px}
.rr-modal-bg{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:18px;background:#0f172a70}.rr-modal{width:min(100%,440px);padding:20px;border-radius:14px;background:#fff;box-shadow:0 24px 80px #0f172a30}.rr-modal h2{margin-bottom:8px}.rr-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.rr-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.rr-field{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:700;color:#475569}.rr-field textarea{min-height:86px}.rr-vitals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px}.rr-report-text{white-space:pre-wrap;max-height:260px;overflow:auto;padding:12px;border-radius:9px;background:#f8fafc;color:#475569;font:12px/1.6 ui-monospace,monospace}.rr-review-warning{margin-top:12px;padding:11px 13px;background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:9px;font-size:12px;line-height:1.6}
@media(max-width:650px){.rr{padding:18px 12px 30px}.rr-head{display:block}.rr-form{grid-template-columns:1fr}.rr-compare{grid-template-columns:1fr}.rr-arrow{transform:rotate(90deg)}.rr-change{grid-template-columns:1fr 1fr}.rr-change span:first-child{grid-column:1/-1}.rr-grid{grid-template-columns:1fr}.rr-vitals{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const lines = (value: string): string[] => [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
const toNumber = (value: string): number | undefined => {
  if (!value.trim()) return undefined;
  const result = Number(value.trim());
  return Number.isFinite(result) ? result : undefined;
};
const formString = (value: unknown): string => value === null || value === undefined ? "" : String(value);

function reviewFormFor(state: PatientState): ReviewForm {
  return {
    conditions: state.conditions.join("\n"), medications: state.medications.join("\n"),
    allergies: state.allergies.join("\n"), symptoms: state.symptoms.join("\n"),
    blood_pressure: formString(state.vitals?.blood_pressure),
    heart_rate: formString(state.vitals?.heart_rate), spo2: formString(state.vitals?.spo2),
    temperature: formString(state.vitals?.temperature), respiratory_rate: formString(state.vitals?.respiratory_rate),
    labs: "", clinical_note: "",
  };
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "No recorded value";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export default function Reassessment() {
  const [patientId, setPatientId] = useState("");
  const [previous, setPrevious] = useState<PatientState | null>(null);
  const [carePlan, setCarePlan] = useState<Obj | null>(null);
  const [current, setCurrent] = useState<PatientState | null>(null);
  const [report, setReport] = useState<UploadResult | null>(null);
  const [imageReview, setImageReview] = useState<VisionResult | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [extractionMessage, setExtractionMessage] = useState("");
  const [result, setResult] = useState<ReassessmentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [decision, setDecision] = useState("");
  const [confirmDecision, setConfirmDecision] = useState<Decision | null>(null);
  const [clinicianNote, setClinicianNote] = useState("");

  useEffect(() => {
    const queryId = new URLSearchParams(window.location.search).get("patient_id");
    if (queryId) setPatientId(queryId);
  }, []);

  async function loadPatient() {
    const id = patientId.trim();
    if (!id) { setError("Enter a patient ID."); return; }
    setLoading(true); setError(""); setResult(null); setCurrent(null); setDecision(""); setReport(null); setImageReview(null); setReviewConfirmed(false); setExtractionMessage("");
    try {
      const [patientRecord, plan] = await Promise.all([
        api<Obj>(`/api/patients/${encodeURIComponent(id)}`),
        api<Obj>(`/api/patients/${encodeURIComponent(id)}/approved-care-plan`),
      ]);
      const state = (patientRecord.state_json && typeof patientRecord.state_json === "object"
        ? patientRecord.state_json
        : patientRecord) as PatientState;
      if (String(plan.status) !== "approved") {
        throw new Error("This patient has no approved care plan yet. Approve a plan before reassessing it.");
      }
      setPrevious(state);
      setCarePlan(plan);
      setReviewForm(reviewFormFor(state));
    } catch (e) {
      setPrevious(null); setCarePlan(null); setCurrent(null); setResult(null); setReport(null); setImageReview(null); setReviewForm(null); setReviewConfirmed(false);
      setError(e instanceof Error ? e.message : "Could not load the patient and approved plan.");
    } finally { setLoading(false); }
  }

  async function upload(file: File) {
    if (!previous || !carePlan) return;
    setLoading(true); setError(""); setResult(null); setCurrent(null); setDecision(""); setReport(null); setImageReview(null); setReviewConfirmed(false); setExtractionMessage("");
    try {
      setProgress("Uploading report and extracting text");
      const form = new FormData();
      form.append("file", file);
      form.append("patient_id", previous.patient_id);
      const response = await fetch(`${API}/api/documents/upload`, { method: "POST", body: form });
      if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 220)}`);
      const uploaded = await response.json() as UploadResult;
      setReport(uploaded);
      const baseForm = reviewForm ?? reviewFormFor(previous);
      setReviewForm(baseForm);
      if (uploaded.extracted_text?.trim()) {
        setProgress("Extracting proposed facts for clinician review");
        const facts = await api<ExtractedFacts>("/api/reassessment/extract", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: uploaded.filename, extracted_text: uploaded.extracted_text.slice(0, 30000) }),
        });
        const proposalCount = (facts.conditions?.length ?? 0) + (facts.medications?.length ?? 0) + (facts.allergies?.length ?? 0) + (facts.symptoms?.length ?? 0) + (facts.labs?.length ?? 0) + Object.keys(facts.vitals ?? {}).length;
        setExtractionMessage(proposalCount ? `Drafted ${proposalCount} proposed fact(s). Check them against the report before comparing.` : "No structured facts were extracted. Enter the relevant changes manually; an empty extraction does not mean there were no changes.");
        const mergeLines = (oldValue: string, proposed: string[]) => [...new Set([...lines(oldValue), ...proposed.map((x) => x.trim()).filter(Boolean)])].join("\n");
        const vitalValue = (names: string[]) => {
          const key = Object.keys(facts.vitals ?? {}).find((item) => names.includes(item.toLowerCase().replace(/[^a-z0-9]/g, "")));
          return key ? facts.vitals[key] : undefined;
        };
        setReviewForm((formValue) => {
          const form = formValue ?? reviewFormFor(previous);
          const proposedLabs = (facts.labs ?? []).filter((item) => item.name && item.value).map((item) => `${item.name} | ${item.value} | ${item.unit || ""}`);
          const proposedNotes = (facts.clinical_notes ?? []).filter(Boolean).join("\n");
          return {
            ...form,
            conditions: mergeLines(form.conditions, facts.conditions ?? []),
            medications: mergeLines(form.medications, facts.medications ?? []),
            allergies: mergeLines(form.allergies, facts.allergies ?? []),
            symptoms: mergeLines(form.symptoms, facts.symptoms ?? []),
            blood_pressure: vitalValue(["bloodpressure", "bp"]) ?? form.blood_pressure,
            heart_rate: vitalValue(["heartrate", "pulse"]) ?? form.heart_rate,
            spo2: vitalValue(["spo2", "oxygensaturation"]) ?? form.spo2,
            temperature: vitalValue(["temperature"]) ?? form.temperature,
            respiratory_rate: vitalValue(["respiratoryrate", "resprate"]) ?? form.respiratory_rate,
            labs: [...form.labs.split(/\r?\n/).filter(Boolean), ...proposedLabs].join("\n"),
            clinical_note: mergeLines(form.clinical_note, proposedNotes ? [proposedNotes] : []),
          };
        });
      }
      setProgress("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report upload failed.");
      setProgress("");
    } finally { setLoading(false); }
  }

  async function analyzeUploadedImage() {
    if (!report || !previous) return;
    setLoading(true); setError("");
    try {
      setProgress("Analyzing image with the configured vision model");
      const observations = await api<VisionResult>("/api/documents/vision-summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: report.document_id, patient_id: previous.patient_id }),
      });
      setImageReview(observations);
      setProgress("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Image analysis failed.");
      setProgress("");
    } finally { setLoading(false); }
  }

  function buildCurrentState(): PatientState {
    if (!previous || !reviewForm) throw new Error("Load the patient record before reviewing changes.");
    const labs: TimelineEvent[] = reviewForm.labs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const [name, rawValue, ...unitParts] = line.split("|").map((part) => part.trim());
      if (!name || !rawValue) throw new Error(`Lab row ${index + 1} needs a test name and result: Test | Result | Unit`);
      const numeric = Number(rawValue);
      return {
        timestamp: new Date().toISOString(), type: "lab", name,
        value: Number.isFinite(numeric) ? numeric : rawValue,
        unit: unitParts.join(" | ") || undefined,
        source: report?.filename || "Clinician-entered reassessment",
      };
    });
    const note = reviewForm.clinical_note.trim();
    const conditions = lines(reviewForm.conditions);
    const medications = lines(reviewForm.medications);
    const allergies = lines(reviewForm.allergies);
    const symptoms = lines(reviewForm.symptoms);
    const timeline = [...previous.timeline, ...labs];
    const notes = note && !previous.notes.includes(note) ? [...previous.notes, note] : previous.notes;
    const missing = new Set(previous.missing_information);
    const syncMissing = (label: string, hasValue: boolean) => {
      if (hasValue) missing.delete(label);
      else missing.add(label);
    };
    syncMissing("Current medications", medications.length > 0);
    syncMissing("Allergy information", allergies.length > 0);
    syncMissing("Current symptoms", symptoms.length > 0);
    syncMissing("Recent laboratory results", timeline.some((item) => item.type.toLowerCase() === "lab"));
    syncMissing("Clinical notes", notes.length > 0);
    return {
      ...previous,
      conditions, medications, allergies, symptoms,
      vitals: {
        blood_pressure: reviewForm.blood_pressure.trim() || undefined,
        heart_rate: toNumber(reviewForm.heart_rate), spo2: toNumber(reviewForm.spo2),
        temperature: toNumber(reviewForm.temperature), respiratory_rate: toNumber(reviewForm.respiratory_rate),
      },
      timeline, notes, missing_information: [...missing],
    };
  }

  async function compareUpdatedState() {
    if (!previous || !carePlan || !report) return;
    setLoading(true); setError(""); setResult(null); setCurrent(null); setDecision("");
    try {
      setProgress("Comparing clinician-reviewed changes with the saved state and plan");
      const nextState = buildCurrentState();
      const reassessment = await api<ReassessmentResult>("/api/reassessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previous_state: previous, current_state: nextState, care_plan: carePlan }),
      });
      setCurrent(nextState);
      setResult(reassessment);
      setProgress("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reassessment failed.");
      setProgress("");
    } finally { setLoading(false); }
  }

  async function recordDecision(choice: Decision) {
    if (!current || !previous || !carePlan || !result) return;
    setLoading(true); setError("");
    try {
      await api("/api/reassessment/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: current.patient_id,
          decision: choice,
          previous_state: previous,
          current_state: current,
          care_plan: carePlan,
          clinician_note: clinicianNote.trim() || null,
        }),
      });
      setDecision(choice);
      if (choice === "accepted") setPrevious(current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the clinician decision.");
    } finally { setLoading(false); }
  }

  const changes = result?.changed_items ?? [];

  return (
    <Shell>
      <style>{CSS}</style>
      <main className="rr">
        <header className="rr-head">
          <div>
            <Link href="/" className="rr-back"><ArrowLeft size={15} />Clinical workspace</Link>
            <p className="rr-eyebrow">PATIENT MONITORING</p>
            <h1>Reassessment</h1>
            <p className="rr-muted">Compare new information with a saved patient state and approved care plan.</p>
          </div>
          <span className="rr-muted">Clinician review required</span>
        </header>

        <section className="rr-card">
          <p className="rr-eyebrow">STEP 1 · SELECT PATIENT</p>
          <h2>Load the patient record</h2>
          <div className="rr-form">
            <input value={patientId} onChange={(event) => setPatientId(event.target.value)} placeholder="Patient ID" aria-label="Patient ID" />
            <button type="button" className="primary" onClick={() => void loadPatient()} disabled={loading}>Load patient and plan</button>
          </div>
          {previous && carePlan && <p className="rr-muted">Loaded patient {previous.patient_id} · approved plan from {display(carePlan.approved_at)}</p>}
        </section>

        {previous && carePlan && (
          <section className="rr-card">
            <p className="rr-eyebrow">STEP 2 · ADD UPDATED INFORMATION</p>
            <h2>Upload a new report</h2>
            <p className="rr-muted">The upload is compared with the saved patient state. The existing care plan is not changed automatically.</p>
            <label className="rr-upload">
              <UploadCloud size={24} />
              <strong>{loading ? "Processing reassessment" : "Choose an updated report"}</strong>
              <span>PDF, TXT, MD, CSV, or supported image file</span>
              <input type="file" accept=".pdf,.txt,.md,.csv,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp" hidden disabled={loading} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.currentTarget.value = "";
              }} />
            </label>
            {progress && <p className="rr-progress"><LoaderCircle className="og-spin" size={16} />{progress}</p>}
            {report && reviewForm && <div style={{ marginTop: 18 }}>
              <div className="rr-state">
                <strong>Report uploaded: {report.filename || "document"}</strong>
                <p className="rr-muted" style={{ marginBottom: 0 }}>{report.extracted_text?.length?.toLocaleString() ?? 0} characters extracted. Extracted text is not automatically treated as verified patient facts.</p>
              </div>
              <p className="rr-review-warning">The model proposes facts from extracted report text. Review them against the source and correct the fields below before comparing. For an image with no readable text, use its image observations as a reference and enter only clinician-confirmed facts.</p>
              {extractionMessage && <p className="rr-muted" role="status">{extractionMessage}</p>}
              {report.vision_available && <div style={{ marginTop: 12 }}>
                <button type="button" disabled={loading} onClick={() => void analyzeUploadedImage()}>{loading ? "Analyzing image…" : `Analyze image with ${report.vision_model || "vision model"}`}</button>
              </div>}
              {imageReview && <div className="rr-state" style={{ marginTop: 12, borderColor: "#bfdbfe", background: "#eff6ff" }}>
                <strong>AI image observations · not a diagnosis</strong><p>{imageReview.summary}</p>
                <p><strong>Possible modality:</strong> {imageReview.possible_modality} · <strong>Image quality:</strong> {imageReview.image_quality}</p>
                {!!imageReview.observed_features.length && <><strong>Observed features</strong><ul>{imageReview.observed_features.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                {!!imageReview.uncertainties.length && <><strong>Uncertainties</strong><ul>{imageReview.uncertainties.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                {!!imageReview.clinician_review_questions.length && <><strong>Clinician review questions</strong><ul>{imageReview.clinician_review_questions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                <small>Model: {imageReview.model}. Verify the original image with a qualified clinician/radiologist before recording changes.</small>
              </div>}
              {report.extracted_text?.trim() ? <details style={{ marginTop: 12 }}><summary style={{ cursor: "pointer", color: "#2563eb", fontSize: 12, fontWeight: 700 }}>Review extracted report text</summary><pre className="rr-report-text">{report.extracted_text.slice(0, 30000)}{report.extracted_text.length > 30000 ? "\n… Text preview truncated." : ""}</pre></details> : <p className="rr-muted">No readable text was extracted. Complete the patient-fact review manually from the source report or image.</p>}
              <h3 style={{ marginTop: 18 }}>Confirm current patient facts</h3>
              <p className="rr-muted">Lists replace the saved lists. Put one item per line. Leave a list unchanged if the report provides no update.</p>
              <div className="rr-grid">
                {(["conditions", "medications", "allergies", "symptoms"] as const).map((field) => <label className="rr-field" key={field}>{field[0].toUpperCase() + field.slice(1)} · one per line
                  <textarea value={reviewForm[field]} onChange={(event) => setReviewForm({ ...reviewForm, [field]: event.target.value })} />
                </label>)}
              </div>
              <h3 style={{ marginTop: 18 }}>Current vitals</h3>
              <div className="rr-vitals">
                {([["blood_pressure", "Blood pressure (e.g. 120/80)"], ["heart_rate", "Heart rate"], ["spo2", "SpO₂ (%)"], ["temperature", "Temperature"], ["respiratory_rate", "Respiratory rate"]] as const).map(([field, label]) => <label className="rr-field" key={field}>{label}
                  <input inputMode={field === "blood_pressure" ? "text" : "decimal"} value={reviewForm[field]} onChange={(event) => setReviewForm({ ...reviewForm, [field]: event.target.value })} />
                </label>)}
              </div>
              <label className="rr-field" style={{ marginTop: 16 }}>New lab results · one per line as <code>Test | Result | Unit</code>
                <textarea value={reviewForm.labs} onChange={(event) => setReviewForm({ ...reviewForm, labs: event.target.value })} placeholder={"Hemoglobin | 11.2 | g/dL\nGlucose | 105 | mg/dL"} />
              </label>
              <label className="rr-field" style={{ marginTop: 16 }}>Additional clinician-confirmed note
                <textarea value={reviewForm.clinical_note} onChange={(event) => setReviewForm({ ...reviewForm, clinical_note: event.target.value })} placeholder="Optional new note to add to the patient record if the update is accepted" />
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 16, fontSize: 12, color: "#475569" }}><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} />I reviewed the report and confirmed the patient facts above. These are proposals, not verified facts until I confirm them.</label>
              <div className="rr-actions"><button type="button" className="primary" disabled={loading || !reviewConfirmed} onClick={() => void compareUpdatedState()}>{loading ? "Comparing…" : "Compare reviewed updates"}</button></div>
            </div>}
          </section>
        )}

        {error && <p className="rr-error" role="alert">{error}</p>}

        {result && current && (
          <>
            <section className="rr-card">
              <p className="rr-eyebrow">STEP 3 · COMPARE STATE</p>
              <div className="rr-row"><h2>Detected patient-state changes</h2><span className={changes.length ? "rr-warning" : "rr-muted"}>{changes.length} change{changes.length === 1 ? "" : "s"}</span></div>
              <div className="rr-compare">
                <div className="rr-state"><strong>Previously saved</strong><p className="rr-muted">{previous?.updated_at ? `Updated ${display(previous.updated_at)}` : "Current patient record"}</p></div>
                <div className="rr-arrow"><ArrowRight size={19} /></div>
                <div className="rr-state"><strong>Updated report</strong><p className="rr-muted">Compared with the approved care plan</p></div>
              </div>
              {changes.length ? changes.map((item, index) => (
                <div className="rr-change" key={`${String(item.name)}-${index}`}>
                  <span>{display(item.name)}</span>
                  <strong>{display(item.old)}</strong>
                  <strong className="rr-warning">{display(item.new)} {display(item.unit) !== "No recorded value" ? display(item.unit) : ""}</strong>
                </div>
              )) : <p className="rr-muted">No changes were found in the clinician-confirmed patient fields.</p>}
            </section>

            <section className="rr-card">
              <p className="rr-eyebrow">STEP 4 · REVIEW IMPACT</p>
              <div className="rr-row"><h2>Care-plan review</h2><strong className={result.care_plan_impact === "review_required" ? "rr-warning" : ""}>{result.care_plan_impact.replaceAll("_", " ")}</strong></div>
              <ul>{result.rationale.map((line, i) => <li key={i}>{line}</li>)}</ul>
              {result.reassessment_questions.length > 0 && <><h3>Questions for clinician review</h3><ul>{result.reassessment_questions.map((line, i) => <li key={i}>{line}</li>)}</ul></>}
              <h3>Retrieved evidence</h3>
              {result.evidence.length ? result.evidence.map((item, index) => (
                <article className="rr-evidence" key={`${String(item.title)}-${index}`}>
                  <strong>{display(item.title)}</strong> · {display(item.source)}
                  {typeof item.url === "string" && <p><a href={item.url} target="_blank" rel="noreferrer">Open source</a></p>}
                  <p>{display(item.excerpt ?? item.text)}</p>
                </article>
              )) : <p className="rr-muted">No supporting evidence was retrieved for this reassessment.</p>}
              <p className="rr-muted">{result.safety_note}</p>
            </section>

            <section className="rr-card">
              <p className="rr-eyebrow">FINAL STEP · CLINICIAN DECISION</p>
              <h2>Record review decision</h2>
              <p className="rr-muted">Accepting updates the patient state. It does not modify the approved care plan.</p>
              <textarea value={clinicianNote} onChange={(event) => setClinicianNote(event.target.value)} placeholder="Optional clinician note" aria-label="Clinician note" />
              {decision ? <p className="rr-decision"><CheckCircle2 size={16} /> Decision recorded: {decision}. {decision === "accepted" ? "Patient state updated; care plan remains unchanged." : "Patient state was not changed."}</p> : (
                <div className="rr-actions">
                  <button type="button" className="primary" disabled={loading} onClick={() => setConfirmDecision("accepted")}>Accept updated state</button>
                  <button type="button" disabled={loading} onClick={() => setConfirmDecision("edit")}>Needs edits</button>
                  <button type="button" disabled={loading} onClick={() => setConfirmDecision("dismissed")}>Dismiss</button>
                </div>
              )}
            </section>
          </>
        )}
      </main>
      {confirmDecision && (
        <div className="rr-modal-bg" onClick={() => setConfirmDecision(null)}>
          <section className="rr-modal" role="dialog" aria-modal="true" aria-labelledby="rr-confirm-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="rr-confirm-title">Confirm clinician decision</h2>
            <p className="rr-muted">
              {confirmDecision === "accepted"
                ? "This updates the saved patient state. The approved care plan stays unchanged."
                : confirmDecision === "edit"
                  ? "This records that the reassessment needs edits. The patient state stays unchanged."
                  : "This dismisses the reassessment and leaves the patient state unchanged."}
            </p>
            <div className="rr-modal-actions">
              <button type="button" disabled={loading} onClick={() => setConfirmDecision(null)}>Cancel</button>
              <button type="button" className="primary" disabled={loading} onClick={() => { if (confirmDecision) void recordDecision(confirmDecision); setConfirmDecision(null); }}>Confirm</button>
            </div>
          </section>
        </div>
      )}
    </Shell>
  );
}
