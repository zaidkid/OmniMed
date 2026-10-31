
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  UserRound,
  Settings,
  LogOut,
  FileText,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";

import { API } from "../components/Ui";
import Sidebar from "../components/omnimed/Sidebar";
import StatusSidebar from "../components/omnimed/StatusSidebar";
import StructuredReport from "../components/omnimed/StructuredReport";
import GenerationWorkspace from "../components/omnimed/GenerationWorkspace";
import BriefResult from "../components/omnimed/BriefResult";
import {
  readResponse,
  useBriefStream,
  type Obj,
} from "../components/omnimed/useBriefStream";

type UploadedDoc = {
  localId: string;
  document_id?: string;
  patient_id?: string;
  filename: string;
  characters_extracted?: number;
  text_preview?: string;
  extracted_text?: string;
  structured_report?: unknown;
  structuredReport?: unknown;
  status: "extracting" | "structuring" | "ready" | "failed";
  error?: string;
  fileUrl?: string;
  mimeType?: string;
};

type BackendHealth = "checking" | "online" | "offline";

// Fixed question: the workspace offers a single "Generate brief" action.
const BRIEF_QUESTION =
  "Summarize the important findings, identify uncertainties, and list what a clinician should review.";

function extractId(text: string): string {
  const patterns = [
    /(?:^|\n)\s*Patient\s*(?:ID|Identifier)\s*:?\s*([A-Za-z0-9_-]+)/i,
    /(?:^|\n)\s*MRN\s*:?\s*([A-Za-z0-9_-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function extractDemographics(text: string) {
  // Accept both "Age / Gender: 62 / Male" and "Age / Gender: 28 years / Male".
  // Extracted text may contain multiple spaces or tabs from PDF layout.
  const ageSex = text.match(
    /Age\s*\/\s*Sex\s*:?\s*(\d{1,3})(?:\s*(?:years?|yrs?))?\s*\/\s*(Male|Female|Other|Unknown)\b/i
  );

  // Also accept standalone age fields such as "Age: 28 years".
  const ageMatch = text.match(
    /(?:Patient\s+)?Age\s*:?\s*(\d{1,3})(?:\s*(?:years?|yrs?))?\b/i
  );

  const sexMatch = text.match(
    /(?:Patient\s+)?(?:Sex|Gender)\s*:?\s*(Male|Female|Other|Unknown)\b/i
  );

  return {
    age: ageSex?.[1] ?? ageMatch?.[1] ?? "",
    sex: ageSex?.[2] ?? sexMatch?.[1] ?? "",
  };
}

// Header pill styles for non-online states.
const HEALTH_PILL: Record<
  Exclude<BackendHealth, "online">,
  {
    label: string;
    color: string;
    background: string;
    border: string;
    dot: string;
  }
> = {
  checking: {
    label: "Checking...",
    color: "#92400e",
    background: "#fffbeb",
    border: "#fde68a",
    dot: "#d97706",
  },
  offline: {
    label: "Backend offline",
    color: "#b91c1c",
    background: "#fef2f2",
    border: "#fecaca",
    dot: "#dc2626",
  },
};

export default function HomePage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  const { gen, run, cancel, reset } = useBriefStream();

  const [profileOpen, setProfileOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [patientId, setPatientId] = useState("");
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [brief, setBrief] = useState<Obj | null>(null);
  const [requestJson, setRequestJson] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [health, setHealth] = useState<BackendHealth>("checking");

  const uploaded =
    uploadedDocs.find((doc) => doc.localId === selectedId) ?? null;

  const generating = gen.running;
  const text = uploaded?.extracted_text || uploaded?.text_preview || "";
  const characters = uploaded?.characters_extracted ?? text.length;
  const demographics = extractDemographics(text);
  const extractedPatientId =
    extractId(text) || uploaded?.patient_id || patientId;

  // Close the profile dropdown when clicking outside or pressing Escape.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        profileRef.current &&
        !profileRef.current.contains(event.target as Node)
      ) {
        setProfileOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setProfileOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  // Check backend health using the actual /health endpoint.
  useEffect(() => {
    let cancelled = false;

    async function check() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);

      try {
        const response = await fetch(`${API}/health`, {
          cache: "no-store",
          signal: controller.signal,
        });

        if (!cancelled) {
          setHealth(response.ok ? "online" : "offline");
        }
      } catch {
        if (!cancelled) {
          setHealth("offline");
        }
      } finally {
        clearTimeout(timer);
      }
    }

    void check();

    const interval = setInterval(() => void check(), 15000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  function openFilePicker() {
    if (uploading || generating) return;
    fileRef.current?.click();
  }

  async function uploadReport() {
    if (!file) {
      setError("Please choose a medical report first.");
      fileRef.current?.click();
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError("The file exceeds the 10 MB upload limit.");
      return;
    }

    setUploading(true);
    setError("");
    setNotice("");
    setBrief(null);
    setRequestJson(null);
    reset();

    try {
      const form = new FormData();

      form.append("file", file);
      form.append("patient_id", patientId.trim() || "OMNI-DEMO-001");

      const response = await fetch(`${API}/api/documents/upload`, {
        method: "POST",
        body: form,
      });

      const data = (await readResponse(response)) as UploadedDoc;
      const extractedText = data.extracted_text || data.text_preview || "";
      const id = extractId(extractedText) || data.patient_id || "";

      const responseData = data as UploadedDoc & {
        structured?: unknown;
        file_url?: string;
        original_file_url?: string;
        mime_type?: string;
      };

      const structured =
        responseData.structured_report ??
        responseData.structuredReport ??
        responseData.structured ??
        null;

      const localId = data.document_id || crypto.randomUUID();

      const newDoc: UploadedDoc = {
        ...data,
        localId,
        document_id: data.document_id || localId,
        filename: data.filename || file.name,
        text_preview: data.text_preview || extractedText,
        extracted_text: data.extracted_text || extractedText,
        structured_report: structured,
        status: structured ? "ready" : "failed",
        error: structured
          ? undefined
          : "The upload endpoint did not return structured report data. The raw text remains available.",
        fileUrl: URL.createObjectURL(file),
        mimeType: responseData.mime_type || file.type || undefined,
      };

      setUploadedDocs((previous) => [...previous, newDoc]);
      setSelectedId(newDoc.localId);

      if (id) {
        setPatientId(id);
        setNotice(`Report uploaded. Patient ID extracted: ${id}`);
      } else {
        setNotice(
          "Report uploaded. Patient ID was not detected; verify the report before generating a brief."
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Report upload failed.";

      setError(
        /failed to fetch|networkerror|load failed/i.test(message)
          ? "Cannot reach the backend. Start the FastAPI server, then try again."
          : message
      );
    } finally {
      setUploading(false);
    }
  }

  async function generateBrief() {
    if (!uploaded) {
      setError("Upload a report before generating a clinical brief.");
      return;
    }

    const id = extractId(text) || uploaded.patient_id || patientId.trim();

    if (!id) {
      setError(
        "Patient ID could not be extracted from the report. Verify the report before continuing."
      );
      return;
    }

    const age = Number(demographics.age);
    const sex = demographics.sex.trim();

    if (
      !demographics.age ||
      !Number.isInteger(age) ||
      age < 0 ||
      age > 130 ||
      !sex
    ) {
      setError(
        "Age or gender could not be extracted reliably. Check the report and confirm the patient details before generating the brief."
      );
      return;
    }

    const request = {
      patient_state: {
        patient_id: id,
        age,
        sex,
        conditions: [],
        medications: [],
        allergies: [],
        symptoms: [],
        vitals: {},
        notes: [`Uploaded report: ${uploaded.filename}`, text],
        missing_information: [
          "Verify extracted measurements against the original report.",
          "Confirm relevant symptoms and clinical history.",
          "Confirm the formal interpretation of any pending investigations.",
        ],
        timeline: [],
      },
      clinical_question: BRIEF_QUESTION,
    };

    setError("");
    setNotice("");
    setBrief(null);
    setRequestJson(request);

    try {
      const output = await run(request);

      if (!output) {
        setNotice("Generation stopped. No clinical brief was produced.");
        return;
      }

      const { result, usedFallback } = output;
      setBrief(result);

      const prefix = usedFallback
        ? "The live stream did not return a final event, so the standard endpoint was used. "
        : "";

      if (result.generation_status === "fallback") {
        setNotice(
          prefix +
            "AI generation failed. The returned content is a fallback based on recorded information, not an AI-generated clinical interpretation."
        );
      } else if (result.generation_status === "success") {
        setNotice(
          prefix +
            "Clinical brief generated. Verify the findings against the original report and supporting evidence."
        );
      } else {
        setNotice(
          prefix +
            "Response received. Review its status and content carefully before use."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Clinical brief generation failed."
      );
    }
  }

  function removeReport() {
    if (!uploaded) return;

    const removedId = uploaded.localId;
    const remaining = uploadedDocs.filter(
      (doc) => doc.localId !== removedId
    );

    setUploadedDocs(remaining);
    setSelectedId((current) =>
      current === removedId ? remaining[0]?.localId ?? null : current
    );

    setBrief(null);
    setRequestJson(null);
    setError("");
    setNotice("");
    reset();
  }

  return (
    <div className="omni-app">
      <Sidebar />

      <div className="omni-app-main">
        <header className="omni-topbar">
          <div className="omni-top-search">
            <Search size={15} />

            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search evidence and reports..."
              aria-label="Search workspace"
            />

            <span className="omni-shortcut">Ctrl K</span>
          </div>

          <div className="omni-top-right">
            <span className="omni-top-patient">
              <Activity size={15} />
              {patientId || "No patient selected"}
            </span>

            {health === "online" ? (
              <span className="omni-top-online" role="status">
                <span className="omni-status-dot" />
                Online
              </span>
            ) : (
              <span
                className="omni-top-online"
                role="status"
                style={{
                  color: HEALTH_PILL[health].color,
                  background: HEALTH_PILL[health].background,
                  borderColor: HEALTH_PILL[health].border,
                }}
              >
                <span
                  className="omni-status-dot"
                  style={{ background: HEALTH_PILL[health].dot }}
                />
                {HEALTH_PILL[health].label}
              </span>
            )}

            {/* Profile dropdown */}
            <div className="omni-profile-wrapper" ref={profileRef}>
              <button
                type="button"
                className={`omni-profile-trigger ${
                  profileOpen ? "is-open" : ""
                }`}
                onClick={() => setProfileOpen((open) => !open)}
                aria-label="Open user profile menu"
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                title="User profile"
              >
                <span className="omni-profile-icon">
                  <UserRound size={20} />
                </span>

                <span className="omni-profile-name">ZK</span>

                <ChevronDown
                  size={15}
                  className={`omni-profile-chevron ${
                    profileOpen ? "rotated" : ""
                  }`}
                />
              </button>

              {profileOpen && (
                <div className="omni-profile-menu" role="menu">
                  <div className="omni-profile-menu-header">
                    <div className="omni-profile-large-icon">
                      <UserRound size={24} />
                    </div>

                    <div className="omni-profile-details">
                      <strong>Zaid Kidwai</strong>
                      <span>Clinical Administrator</span>
                    </div>
                  </div>

                  <div className="omni-profile-divider" />

                  <Link
                    href="/settings?section=profile"
                    className="omni-profile-menu-item"
                    role="menuitem"
                    onClick={() => setProfileOpen(false)}
                  >
                    <UserRound size={17} />
                    <span>My Profile</span>
                  </Link>

                  <Link
                    href="/settings"
                    className="omni-profile-menu-item"
                    role="menuitem"
                    onClick={() => setProfileOpen(false)}
                  >
                    <Settings size={17} />
                    <span>Account Settings</span>
                  </Link>

                  <Link
                    href="/settings?section=security"
                    className="omni-profile-menu-item"
                    role="menuitem"
                    onClick={() => setProfileOpen(false)}
                  >
                    <ShieldCheck size={17} />
                    <span>Security</span>
                  </Link>

                  <div className="omni-profile-divider" />

                  <button
                    type="button"
                    className="omni-profile-menu-item sign-out"
                    role="menuitem"
                    onClick={() => {
                      setProfileOpen(false);
                      setNotice(
                        "Sign out is not connected to authentication yet."
                      );
                    }}
                  >
                    <LogOut size={17} />
                    <span>Sign out</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="omni-page">
          {(error || notice) && (
            <div
              className={`omni-message ${error ? "error" : "success"}`}
              role={error ? "alert" : "status"}
            >
              {error ? (
                <AlertCircle size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}

              <span>{error || notice}</span>

              <button
                type="button"
                onClick={() => {
                  setError("");
                  setNotice("");
                }}
                aria-label="Dismiss message"
              >
                <X size={15} />
              </button>
            </div>
          )}

          <div className="omni-workspace-grid">
            <main className="omni-workspace">
              <div className="omni-page-heading">
                <div className="omni-page-heading-icon">
                  <Activity size={29} />
                </div>

                <div>
                  <p className="omni-eyebrow">CLINICAL AI WORKSPACE</p>
                  <h1>Clinical Report Workspace</h1>

                  <p className="omni-page-description">
                    Upload medical reports, review extracted information, and
                    generate an evidence-aware clinical brief.
                  </p>
                </div>
              </div>

              <div className="omni-workflow">
                <div className="omni-workflow-step">
                  <span
                    className={`omni-workflow-number ${uploaded ? "done" : ""}`}
                  >
                    1
                  </span>

                  <div>
                    <strong>Upload Report</strong>
                    <span>PDF, CSV, TXT, Markdown</span>
                  </div>
                </div>

                <div className="omni-workflow-step">
                  <span
                    className={`omni-workflow-number ${uploaded ? "done" : ""}`}
                  >
                    2
                  </span>

                  <div>
                    <strong>Review Extracted Content</strong>
                    <span>Structured, readable format</span>
                  </div>
                </div>

                <div className="omni-workflow-step">
                  <span
                    className={`omni-workflow-number ${
                      brief?.generation_status === "success" ? "done" : ""
                    }`}
                  >
                    3
                  </span>

                  <div>
                    <strong>Generate Clinical Brief</strong>
                    <span>Evidence-aware insights</span>
                  </div>
                </div>
              </div>

              <section className="omni-card">
                <div className="omni-section-header">
                  <div className="omni-section-title-wrap">
                    <span className="omni-step-number">1</span>

                    <div>
                      <h2>Upload medical report</h2>
                      <p>
                        Upload a clinical document. Patient information will be
                        extracted from the report text.
                      </p>
                    </div>
                  </div>

                  <span className="omni-supported">
                    <FileText size={12} />
                    Supported formats
                  </span>
                </div>

                <div className="omni-upload-grid">
                  <div
                    className="omni-dropzone"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      cursor:
                        uploading || generating ? "not-allowed" : "pointer",
                    }}
                    onClick={openFilePicker}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();

                      const dropped = event.dataTransfer.files?.[0];

                      if (dropped) {
                        setFile(dropped);
                        setError("");
                        setNotice("");
                      }
                    }}
                  >
                    <UploadCloud size={32} />

                    <strong>
                      Drag and drop a file here, or click to browse
                    </strong>

                    <span>PDF, CSV, TXT, or Markdown (max 10 MB)</span>

                    <button
                      type="button"
                      className="omni-button primary"
                      style={{ marginTop: 8 }}
                      disabled={uploading || generating}
                      onClick={(event) => {
                        event.stopPropagation();
                        openFilePicker();
                      }}
                    >
                      <FileText size={13} />
                      Choose File
                    </button>

                    <input
                      ref={fileRef}
                      type="file"
                      accept=".pdf,.csv,.txt,.md,.markdown"
                      hidden
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        setFile(event.target.files?.[0] ?? null);
                        setError("");
                        setNotice("");
                      }}
                    />
                  </div>

                  <div className="omni-file-selection">
                    {file ? (
                      <div className="omni-selected-file">
                        <span className="omni-file-icon">
                          <FileText size={19} />
                        </span>

                        <div className="omni-selected-file-text">
                          <strong>{file.name}</strong>
                          <span>
                            Ready to upload · {(file.size / 1024).toFixed(1)} KB
                          </span>
                        </div>

                        <button
                          type="button"
                          className="omni-icon-button"
                          disabled={uploading || generating}
                          onClick={() => {
                            setFile(null);

                            if (fileRef.current) {
                              fileRef.current.value = "";
                            }
                          }}
                          aria-label="Remove selected file"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="omni-no-file">
                        <span className="omni-file-icon">
                          <FileText size={19} />
                        </span>

                        <div>
                          <strong>No file selected</strong>
                          <span>Choose a report to get started</span>
                        </div>
                      </div>
                    )}

                    <button
                      type="button"
                      className="omni-button primary omni-upload-button"
                      disabled={!file || uploading || generating}
                      onClick={() => void uploadReport()}
                    >
                      {uploading ? (
                        <LoaderCircle size={15} className="omni-spin" />
                      ) : (
                        <UploadCloud size={15} />
                      )}

                      {uploading
                        ? "Uploading and extracting..."
                        : "Upload and extract"}
                    </button>
                  </div>
                </div>
              </section>

              {uploadedDocs.length > 0 && (
                <section className="omni-card" style={{ marginTop: 16 }}>
                  <div className="omni-section-header">
                    <div className="omni-section-title-wrap">
                      <div>
                        <h2>Uploaded documents</h2>
                        <p>Select a file to review its contents.</p>
                      </div>
                    </div>

                    <span>{uploadedDocs.length} files</span>
                  </div>

                  <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
                    {uploadedDocs.map((doc) => {
                      const active = doc.localId === selectedId;
                      const docText =
                        doc.extracted_text || doc.text_preview || "";

                      return (
                        <button
                          key={doc.localId}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSelectedId(doc.localId)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            width: "100%",
                            padding: 12,
                            textAlign: "left",
                            color: "inherit",
                            cursor: "pointer",
                            borderRadius: 12,
                            border: `1px solid ${
                              active ? "#047857" : "rgba(148,163,184,.35)"
                            }`,
                            background: active
                              ? "rgba(4,120,87,.08)"
                              : "transparent",
                          }}
                        >
                          <FileText size={20} color="#047857" />

                          <span style={{ flex: 1, minWidth: 0 }}>
                            <strong
                              style={{
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {doc.filename}
                            </strong>

                            <span style={{ fontSize: 12, opacity: 0.7 }}>
                              {(
                                doc.characters_extracted ?? docText.length
                              ).toLocaleString()}{" "}
                              characters ·{" "}
                              {doc.status === "ready"
                                ? "Ready"
                                : doc.status === "failed"
                                  ? "Raw text available"
                                  : "Processing"}
                            </span>
                          </span>

                          <ChevronRight size={18} />
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {!uploaded && (
                <section
                  className="omni-card"
                  aria-disabled="true"
                  style={{ opacity: 0.6, marginTop: 16 }}
                >
                  <div className="omni-section-header">
                    <div className="omni-section-title-wrap">
                      <span
                        className="omni-step-number"
                        style={{ background: "#94a3b8" }}
                      >
                        2
                      </span>

                      <div>
                        <h2>Review extracted content</h2>
                        <p>
                          Extracted text and structured fields appear here
                          after you upload a report.
                        </p>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {uploaded && (
                <StructuredReport
                  key={uploaded.localId}
                  filename={uploaded.filename}
                  documentId={uploaded.document_id}
                  patientId={uploaded.patient_id || extractedPatientId}
                  text={uploaded.extracted_text || uploaded.text_preview || ""}
                  characters={
                    uploaded.characters_extracted ??
                    (uploaded.extracted_text || uploaded.text_preview || "")
                      .length
                  }
                  structuredReport={
                    uploaded.structured_report ?? uploaded.structuredReport
                  }
                  status={uploaded.status}
                  error={uploaded.error}
                  fileUrl={uploaded.fileUrl}
                  mimeType={uploaded.mimeType}
                  onRemove={removeReport}
                />
              )}

              <section className="omni-card" style={{ marginTop: 16 }}>
                <div className="omni-section-header">
                  <div className="omni-section-title-wrap">
                    <span className="omni-step-number purple">3</span>

                    <div>
                      <h2>Generate a clinical brief</h2>
                      <p>
                        Generate an evidence-aware summary based on the
                        uploaded report.
                      </p>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="omni-button purple omni-upload-button"
                  disabled={!uploaded || uploading || generating}
                  onClick={() => void generateBrief()}
                >
                  {generating ? (
                    <LoaderCircle size={15} className="omni-spin" />
                  ) : (
                    <Sparkles size={15} />
                  )}

                  {generating ? "Generating..." : "Generate brief"}
                </button>

                {!uploaded && (
                  <p
                    style={{
                      fontSize: 13,
                      margin: "10px 0 0",
                      opacity: 0.8,
                    }}
                  >
                    Upload and extract a report first to enable this step.
                  </p>
                )}

                <div className="omni-safety-inline">
                  <ShieldCheck size={13} />
                  Decision support only. Clinical review required.
                </div>
              </section>

              {gen.started && (
                <GenerationWorkspace
                  key={gen.runId}
                  gen={gen}
                  onCancel={cancel}
                />
              )}

              {brief && <BriefResult brief={brief} request={requestJson} />}

              <footer className="omni-footer">
                OmniMed Clinical AI Copilot · Development workspace · Clinician
                review required
              </footer>
            </main>

            <StatusSidebar
              filename={uploaded?.filename || ""}
              patientId={patientId}
              characters={characters}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
