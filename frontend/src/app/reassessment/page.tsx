"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Shell from "../../components/Shell";
import { API } from "../../components/Ui";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";

const steps = [
  "Extracting information",
  "Updating Patient State",
  "Checking Care Plan Impact",
  "Retrieving Evidence",
  "Generating Reassessment",
];

const before = [
  ["hs-Troponin", "18 ng/L"],
  ["Creatinine", "1.0 mg/dL"],
  ["Blood pressure", "132/82 mmHg"],
  ["ECG", "No abnormality recorded"],
];

const after = [
  ["hs-Troponin", "86 ng/L"],
  ["Creatinine", "1.4 mg/dL"],
  ["Blood pressure", "168/96 mmHg"],
  ["ECG", "Abnormal (new finding)"],
];

const reasoning = [
  "The hs-Troponin rise of 68 ng/L over 3 hours is a significant biomarker change.",
  "Creatinine has risen 0.4 mg/dL from baseline, which may affect medication review.",
  "The current plan was approved before these values were available.",
];

const evidence = [
  [
    "Guideline for evaluation of chest pain",
    "Serial hs-troponin testing supports assessment of myocardial injury.",
  ],
  [
    "Guideline for diabetes care in CKD",
    "Renal function should inform review of glucose-lowering therapy.",
  ],
];

type Decision = "accepted" | "dismissed" | "edit" | null;


const REASSESSMENT_CSS = `
.omni-reassess{max-width:1440px;margin:0 auto;padding:28px 30px 36px;color:#172554}
.omni-reassess *{box-sizing:border-box}
.omni-reassess .omni-page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}
.omni-reassess .omni-back-link{display:inline-flex;align-items:center;gap:7px;margin-bottom:18px;color:#64748b;text-decoration:none;font-size:12px;font-weight:650}
.omni-reassess .omni-back-link:hover{color:#2376f5}
.omni-reassess .omni-eyebrow{font-size:10px;letter-spacing:.09em;font-weight:800;color:#6480aa;margin-bottom:7px}
.omni-reassess .omni-page-title,.omni-reassess h1{margin:0;color:#172554;font-size:clamp(25px,2.4vw,32px);line-height:1.15;font-weight:800;letter-spacing:-.04em}
.omni-reassess h2{margin:0;color:#172554;font-size:16px;font-weight:750;letter-spacing:-.02em}
.omni-reassess h3{margin:0;color:#1e3154;font-size:13px;font-weight:750}
.omni-reassess p{margin-top:7px}
.omni-reassess .omni-muted{color:#718096;font-size:12px;line-height:1.7}
.omni-reassess .omni-status-pill,.omni-reassess .omni-warning-pill{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;border-radius:999px;padding:8px 12px;font-size:11px;font-weight:750}
.omni-reassess .omni-status-pill{color:#2563eb;background:#eff6ff;border:1px solid #dbeafe}
.omni-reassess .omni-warning-pill{color:#a16207;background:#fffbeb;border:1px solid #fde68a}
.omni-reassess .omni-card,.omni-reassess .omni-section{min-width:0;background:#fff;border:1px solid #e1e9f3;border-radius:15px;padding:22px;box-shadow:0 2px 8px rgba(24,55,99,.025)}
.omni-reassess .omni-section{margin-bottom:16px}
.omni-reassess .omni-section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}
.omni-reassess .omni-section-heading>svg{color:#2376f5;flex-shrink:0}
.omni-reassess .omni-chip-row{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 17px}
.omni-reassess .omni-chip{padding:6px 10px;border:1px solid #dce7f5;background:#f8fbff;color:#536987;border-radius:999px;font-size:10px;font-weight:650}
.omni-reassess .omni-upload-zone{width:100%;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:22px;border:1.5px dashed #b9cdec;border-radius:12px;background:#f8fbff;color:#2376f5;cursor:pointer;transition:background .18s,border-color .18s}
.omni-reassess .omni-upload-zone:hover:not(:disabled){background:#eff6ff;border-color:#60a5fa}
.omni-reassess .omni-upload-zone:disabled{opacity:.75;cursor:wait}
.omni-reassess .omni-upload-zone strong{font-size:13px;color:#1e3154}
.omni-reassess .omni-upload-zone span{font-size:11px;color:#718096;text-align:center;line-height:1.6}
.omni-reassess .omni-error-message{padding:10px 12px;border:1px solid #fecaca;border-radius:9px;background:#fff1f2;color:#b91c1c;font-size:12px}
.omni-reassess .omni-processing{margin-top:20px;padding:17px;border:1px solid #dbeafe;border-radius:12px;background:#fbfdff}
.omni-reassess .omni-processing-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.omni-reassess .omni-progress-track{height:6px;background:#e7eef8;border-radius:99px;overflow:hidden;margin-bottom:13px}
.omni-reassess .omni-progress-value{height:100%;border-radius:99px;background:linear-gradient(90deg,#2376f5,#60a5fa);transition:width .3s}
.omni-reassess .omni-process-step{display:flex;align-items:center;gap:10px;min-height:34px;color:#52617b;font-size:12px}
.omni-reassess .omni-step-dot{width:16px;height:16px;border:2px solid #d6e0ee;border-radius:50%;flex-shrink:0}
.omni-reassess .omni-success-icon{color:#059669;flex-shrink:0}
.omni-reassess .omni-accent-icon{color:#2376f5;flex-shrink:0}
.omni-reassess .omni-step-complete{margin-left:auto;color:#059669;font-size:10px;font-weight:700}
.omni-reassess .omni-empty-state{display:flex;flex-direction:column;align-items:center;text-align:center;padding:30px 20px;margin:16px 0;border:1px solid #e1e9f3;border-radius:15px;background:linear-gradient(180deg,#fff,#f9fbff)}
.omni-reassess .omni-empty-icon{width:44px;height:44px;display:grid;place-items:center;margin-bottom:12px;border-radius:13px;background:#eaf2ff;color:#2376f5}
.omni-reassess .omni-empty-state h3{font-size:14px}
.omni-reassess .omni-empty-state p{max-width:440px;margin-bottom:0;color:#718096;font-size:12px;line-height:1.7}
.omni-reassess .omni-comparison-grid{display:grid;grid-template-columns:minmax(0,1fr) 36px minmax(0,1fr);align-items:center;gap:12px}
.omni-reassess .omni-comparison-card{padding:17px;border-radius:12px;box-shadow:none}
.omni-reassess .omni-card-warning{border-color:#fed7aa;background:#fffdfa}
.omni-reassess .omni-data-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid #edf1f7;font-size:12px}
.omni-reassess .omni-data-row:last-child{border-bottom:0;padding-bottom:0}
.omni-reassess .omni-data-row>span{color:#718096}
.omni-reassess .omni-data-row strong{color:#253858;text-align:right;font-weight:700}
.omni-reassess .omni-card-warning .omni-data-row strong{color:#b45309}
.omni-reassess .omni-comparison-arrow{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#eff6ff;color:#2376f5}
.omni-reassess .omni-impact-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(220px,.8fr);gap:16px;margin:16px 0}
.omni-reassess .omni-reasoning-list{display:grid;gap:12px;margin:18px 0;padding:0;list-style:none}
.omni-reassess .omni-reasoning-list li{position:relative;padding-left:20px;color:#52617b;font-size:12px;line-height:1.75}
.omni-reassess .omni-reasoning-list li:before{content:"";position:absolute;left:1px;top:7px;width:7px;height:7px;border-radius:50%;background:#60a5fa;box-shadow:0 0 0 3px #eff6ff}
.omni-reassess .omni-caution-note{padding:11px 12px;border:1px solid #fde68a;border-radius:9px;background:#fffbeb;color:#92400e;font-size:11px;line-height:1.7}
.omni-reassess .omni-impact-card{display:flex;flex-direction:column;justify-content:center;background:linear-gradient(160deg,#fff,#fffaf3)}
.omni-reassess .omni-impact-value{margin:13px 0 10px;color:#c2410c;font-size:30px;font-weight:850;letter-spacing:-.04em}
.omni-reassess .omni-impact-meter{display:flex;gap:5px;margin-bottom:12px}
.omni-reassess .omni-impact-meter span{height:7px;flex:1;border-radius:99px;background:#e5eaf1}
.omni-reassess .omni-impact-meter span.is-high{background:#f97316}
.omni-reassess .omni-evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}
.omni-reassess .omni-evidence-item{padding:15px;border:1px solid #e1e9f3;border-radius:11px;background:#fbfdff}
.omni-reassess .omni-evidence-item h3{font-size:12px}
.omni-reassess .omni-evidence-item p{margin-bottom:0;color:#718096;font-size:11px;line-height:1.7}
.omni-reassess .omni-action-row{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}
.omni-reassess .omni-button,.omni-reassess .omni-button-secondary{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:9px 14px;border:1px solid transparent;border-radius:9px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.omni-reassess .omni-button{background:#2376f5;color:white;box-shadow:0 2px 5px #2376f526}
.omni-reassess .omni-button:hover{background:#1459ce}
.omni-reassess .omni-button-secondary{border-color:#dce5f0;background:#fff;color:#475569}
.omni-reassess .omni-button-secondary:hover{border-color:#93b7f7;background:#f8fbff;color:#1d4ed8}
.omni-reassess .omni-decision-recorded{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:16px;padding:13px;border:1px solid #bbf7d0;border-radius:10px;background:#f0fdf4;color:#166534;font-size:12px;font-weight:650}
.omni-reassess .omni-disclaimer{margin:18px 0 0;padding:12px 14px;border:1px solid #e1e9f3;border-radius:10px;background:#f8fafc;color:#718096;font-size:11px;line-height:1.7}
.omni-reassess .omni-modal-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(15,23,42,.45);backdrop-filter:blur(3px)}
.omni-reassess .omni-modal{width:min(100%,440px);padding:22px;border:1px solid #e1e9f3;border-radius:16px;background:#fff;box-shadow:0 24px 80px #0f172a30}
.omni-reassess .omni-modal-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.omni-reassess .omni-modal-heading h2{font-size:17px}
.omni-reassess .omni-icon-button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:#f1f5f9;color:#64748b;cursor:pointer}
.omni-reassess .omni-modal>p{color:#64748b;font-size:12px;line-height:1.8;margin:16px 0 20px}
.omni-reassess .omni-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.omni-reassess .omni-toast{position:fixed;right:24px;bottom:24px;z-index:1100;max-width:min(420px,calc(100vw - 32px));padding:13px 16px;border:1px solid #bfdbfe;border-radius:11px;background:#fff;color:#1e3a8a;box-shadow:0 12px 35px #0f172a1a;font-size:12px;font-weight:650}
.omni-reassess .omni-spin{animation:omni-reassess-spin 1s linear infinite}
@keyframes omni-reassess-spin{to{transform:rotate(360deg)}}
@media(max-width:900px){.omni-reassess{padding:22px 20px}.omni-reassess .omni-impact-grid{grid-template-columns:1fr}.omni-reassess .omni-impact-card{min-height:180px}}
@media(max-width:620px){.omni-reassess{padding:18px 12px 26px}.omni-reassess .omni-page-heading{flex-direction:column;gap:10px}.omni-reassess .omni-card,.omni-reassess .omni-section{padding:16px}.omni-reassess .omni-comparison-grid{grid-template-columns:1fr}.omni-reassess .omni-comparison-arrow{transform:rotate(90deg);margin:auto}.omni-reassess .omni-evidence-grid{grid-template-columns:1fr}.omni-reassess .omni-section-heading{gap:10px}.omni-reassess .omni-action-row>*{flex:1 1 100%}.omni-reassess .omni-status-pill{white-space:normal}}
`;

export default function Reassessment() {
  const [step, setStep] = useState(-1);
  const [confirm, setConfirm] = useState<Decision>(null);
  const [decision, setDecision] = useState<Decision>(null);
  const [toast, setToast] = useState("");
  const [uploadErr, setUploadErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setUploadErr("");

    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("patient_id", "OMNI-DEMO-001");

      const response = await fetch(`${API}/api/documents/upload`, {
        method: "POST",
        body: fd,
      });

      if (!response.ok) {
        throw new Error(
          `${response.status}: ${(await response.text()).slice(0, 200)}`
        );
      }

      setDecision(null);
      setStep(0);
    } catch (error) {
      setUploadErr(
        error instanceof Error ? error.message : "Upload failed"
      );
    }
  };

  useEffect(() => {
    if (step < 0 || step >= steps.length) return;

    const timer = setTimeout(() => {
      setStep((current) => current + 1);
    }, 900);

    return () => clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    if (!toast) return;

    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const done = step >= steps.length;

  const commit = () => {
    setDecision(confirm);

    setToast(
      confirm === "accepted"
        ? "Reassessment accepted. Review each option before changing the care plan."
        : confirm === "edit"
          ? "Reassessment marked for editing."
          : "Reassessment dismissed."
    );

    setConfirm(null);
  };

  return (
    <Shell>
      <style>{REASSESSMENT_CSS}</style>
      <div className="omni-page omni-reassess">
        <div className="omni-page-heading">
          <div>
            <Link href="/" className="omni-back-link">
              <ArrowLeft size={15} />
              Back to Clinical Brief
            </Link>

            <div className="omni-eyebrow">PATIENT MONITORING</div>
            <h1 className="omni-page-title">Reassessment</h1>
            <p className="omni-muted">
              OMNI-DEMO-001 · Synthetic Patient
            </p>
          </div>

          <span className="omni-status-pill">
            <Sparkles size={14} />
            AI-assisted review
          </span>
        </div>

        <section className="omni-card">
          <div className="omni-section-heading">
            <div>
              <div className="omni-eyebrow">STEP 01</div>
              <h2>Add new patient information</h2>
              <p className="omni-muted">
                Upload updated clinical information to begin reassessment.
              </p>
            </div>
            <UploadCloud size={22} />
          </div>

          <div className="omni-chip-row">
            {[
              "Lab Report",
              "ECG",
              "Medical Document",
              "Vital Signs",
              "Clinical Note",
              "Imaging",
            ].map((item) => (
              <span className="omni-chip" key={item}>
                {item}
              </span>
            ))}
          </div>

          <button
            type="button"
            className="omni-upload-zone"
            disabled={step >= 0 && !done}
            onClick={() => fileRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file && (step < 0 || done)) upload(file);
            }}
          >
            <UploadCloud size={28} />
            <strong>
              {step >= 0 && !done
                ? "Processing uploaded information"
                : "Upload patient information"}
            </strong>
            <span>
              Drag and drop a PDF, TXT, MD or CSV file, or click to browse.
            </span>
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,.csv"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload(file);
              event.target.value = "";
            }}
          />

          {uploadErr && (
            <p className="omni-error-message">{uploadErr}</p>
          )}

          {step >= 0 && (
            <div className="omni-processing">
              <div className="omni-processing-heading">
                <span className="omni-eyebrow">PROCESSING WORKFLOW</span>
                <span className="omni-muted">
                  {done ? "Complete" : `${Math.min(step + 1, steps.length)} of ${steps.length}`}
                </span>
              </div>

              <div className="omni-progress-track">
                <div
                  className="omni-progress-value"
                  style={{
                    width: `${(Math.min(step + 1, steps.length) / steps.length) * 100}%`,
                  }}
                />
              </div>

              {steps.map((item, index) => (
                <div className="omni-process-step" key={item}>
                  {index < step ? (
                    <CheckCircle2 className="omni-success-icon" size={17} />
                  ) : index === step && !done ? (
                    <Loader2 className="omni-accent-icon omni-spin" size={17} />
                  ) : index === step && done ? (
                    <CheckCircle2 className="omni-success-icon" size={17} />
                  ) : (
                    <span className="omni-step-dot" />
                  )}
                  <span>{item}</span>
                  {index < step && (
                    <span className="omni-step-complete">Complete</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {!done && step < 0 && (
          <div className="omni-empty-state">
            <div className="omni-empty-icon">
              <Sparkles size={21} />
            </div>
            <h3>Ready for reassessment</h3>
            <p>
              Upload new information to compare patient state and review
              potential care-plan implications.
            </p>
          </div>
        )}

        {done && (
          <>
            <section className="omni-section">
              <div className="omni-section-heading">
                <div>
                  <div className="omni-eyebrow">STEP 02</div>
                  <h2>Patient state changed</h2>
                  <p className="omni-muted">
                    Review the changes identified in this demonstration.
                  </p>
                </div>
                <span className="omni-warning-pill">
                  <Sparkles size={13} />
                  AI detected
                </span>
              </div>

              <div className="omni-comparison-grid">
                <div className="omni-card omni-comparison-card">
                  <div className="omni-eyebrow">BEFORE · 3 HOURS AGO</div>
                  {before.map(([label, value]) => (
                    <div className="omni-data-row" key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>

                <div className="omni-comparison-arrow">
                  <ArrowRight size={21} />
                </div>

                <div className="omni-card omni-comparison-card omni-card-warning">
                  <div className="omni-eyebrow">AFTER · NOW</div>
                  {after.map(([label, value]) => (
                    <div className="omni-data-row" key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="omni-impact-grid">
              <div className="omni-card">
                <div className="omni-eyebrow">CLINICAL REASONING</div>
                <h2>Does this affect the current care plan?</h2>
                <p className="omni-muted">
                  AI reasoning · Inferred, not confirmed
                </p>

                <ul className="omni-reasoning-list">
                  {reasoning.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>

                <div className="omni-caution-note">
                  Uncertain: exact symptom onset, ECG interpretation, and
                  complete medication history.
                </div>
              </div>

              <div className="omni-card omni-impact-card">
                <div className="omni-eyebrow">POTENTIAL IMPACT</div>
                <div className="omni-impact-value">High</div>

                <div className="omni-impact-meter">
                  <span className="is-high" />
                  <span />
                  <span />
                </div>

                <p className="omni-muted">
                  Suggests clinician review. This is not a diagnosis.
                </p>
              </div>
            </section>

            <section className="omni-card">
              <div className="omni-eyebrow">STEP 03</div>
              <h2>Supporting evidence</h2>

              <div className="omni-evidence-grid">
                {evidence.map(([title, description]) => (
                  <article className="omni-evidence-item" key={title}>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="omni-card">
              <div className="omni-eyebrow">FINAL STEP</div>
              <h2>Clinician decision</h2>
              <p className="omni-muted">
                Review the suggestions before deciding how to proceed.
                No care-plan changes are made automatically.
              </p>

              {decision ? (
                <div className="omni-decision-recorded">
                  <CheckCircle2 size={18} />
                  Decision recorded: {decision}
                  {decision === "edit" && (
                    <button
                      className="omni-button-secondary"
                      onClick={() => setToast("Editing workflow is not connected yet.")}
                    >
                      Continue editing
                    </button>
                  )}
                </div>
              ) : (
                <div className="omni-action-row">
                  <button
                    className="omni-button"
                    onClick={() => setConfirm("accepted")}
                  >
                    Accept reassessment
                  </button>
                  <button
                    className="omni-button-secondary"
                    onClick={() => setConfirm("edit")}
                  >
                    Edit
                  </button>
                  <button
                    className="omni-button-secondary"
                    onClick={() => setConfirm("dismissed")}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </section>
          </>
        )}

        <p className="omni-disclaimer">
          Decision support only. OmniMed does not replace clinician judgment.
        </p>
      </div>

      {confirm && (
        <div className="omni-modal-backdrop" onClick={() => setConfirm(null)}>
          <section
            className="omni-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="decision-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="omni-modal-heading">
              <h2 id="decision-title">Confirm decision</h2>
              <button
                className="omni-icon-button"
                aria-label="Close dialog"
                onClick={() => setConfirm(null)}
              >
                <X size={17} />
              </button>
            </div>

            <p>
              You are about to mark this reassessment as{" "}
              <strong>{confirm}</strong>. The care plan will not change
              automatically.
            </p>

            <div className="omni-modal-actions">
              <button
                className="omni-button-secondary"
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button className="omni-button" onClick={commit}>
                Confirm
              </button>
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className="omni-toast" role="status">
          {toast}
        </div>
      )}
    </Shell>
  );
}
