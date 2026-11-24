"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, FileSpreadsheet, FileText, Loader2,
  RefreshCw, Search, UploadCloud,
} from "lucide-react";
import Shell from "../../components/Shell";
import { API, api, useToast } from "../../components/Ui";

type Doc = {
  document_id: string;
  filename: string;
  mime_type?: string | null;
  extracted_text?: string | null;
  created_at?: string;
};
type Uploaded = {
  document_id: string;
  filename: string;
  characters_extracted: number;
  text_preview: string;
  extracted_text?: string;
  vision_available?: boolean;
  vision_model?: string | null;
};

type DocumentSummary = { summary: string; key_findings: string[]; uncertainties: string[]; review_note: string; image_interpreted: boolean };
type VisionSummary = { summary: string; observed_features: string[]; image_quality: string; possible_modality: string; uncertainties: string[]; clinician_review_questions: string[]; model: string; diagnostic: false; clinician_review_required: true };

const ALLOWED = [".pdf", ".txt", ".md", ".csv", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"];
const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]);
const PREVIEW_CHARS = 1500;

const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
};

const fmtDate = (v?: string) => {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
};

const CSS = `
.dp-wrap{max-width:960px;margin:0 auto;padding:28px 24px 40px;display:flex;flex-direction:column;gap:22px;color:#0f172a}
.dp-head h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-.02em}
.dp-head p{margin:6px 0 0;font-size:14px;color:#64748b}
.dp-card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.dp-drop{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:36px 16px;border:2px dashed #cbd5e1;border-radius:14px;background:#f8fafc;transition:all .15s ease;color:#64748b;font-size:14px}
.dp-drop.drag{border-color:#2563eb;background:#eff6ff}
.dp-drop-icon{width:52px;height:52px;border-radius:14px;background:#e0ecff;color:#2563eb;display:flex;align-items:center;justify-content:center}
.dp-drop strong{color:#0f172a;font-size:15px;font-weight:600}
.dp-drop small{font-size:12px;color:#94a3b8}
.dp-input{display:none}
.dp-btn{display:inline-flex;align-items:center;gap:6px;border:0;cursor:pointer;font:inherit;font-size:13px;font-weight:600;padding:9px 16px;border-radius:10px;background:#2563eb;color:#fff;transition:background .15s ease}
.dp-btn:hover:not(:disabled){background:#1d4ed8}
.dp-btn:disabled{opacity:.55;cursor:not-allowed}
.dp-btn.ghost{background:#fff;color:#334155;border:1px solid #cbd5e1;padding:7px 12px;font-weight:500}
.dp-btn.ghost:hover:not(:disabled){background:#f1f5f9}
.dp-btn.done{background:#ecfdf5;color:#047857;border:1px solid #a7f3d0}
.dp-error{margin-top:14px;padding:10px 14px;border-radius:10px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13px}
.dp-last{margin-top:16px;padding:14px 16px;border-radius:12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px}
.dp-last-title{font-weight:600;color:#14532d}
.dp-last-title span{font-weight:400;color:#4b7a5c}
.dp-last p{margin:8px 0 0;white-space:pre-wrap;color:#475569;line-height:1.5}
.dp-list-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.dp-list-title{display:flex;align-items:center;gap:10px}
.dp-list-title h2{margin:0;font-size:18px;font-weight:650}
.dp-count{font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;background:#e2e8f0;color:#475569}
.dp-tools{display:flex;align-items:center;gap:8px}
.dp-search{display:flex;align-items:center;gap:8px;padding:0 12px;height:36px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#94a3b8}
.dp-search input{border:0;outline:0;font:inherit;font-size:13px;color:#0f172a;width:200px;background:transparent}
.dp-items{display:flex;flex-direction:column;gap:10px}
.dp-item{background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;transition:box-shadow .15s ease,border-color .15s ease}
.dp-item:hover{border-color:#bfdbfe;box-shadow:0 2px 8px rgba(37,99,235,.07)}
.dp-row{display:flex;align-items:center;gap:12px;padding:12px 14px}
.dp-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:12px;background:none;border:0;padding:0;cursor:pointer;font:inherit;text-align:left;color:inherit}
.dp-ficon{flex:none;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:#eff6ff;color:#2563eb}
.dp-ficon.csv{background:#ecfdf5;color:#059669}
.dp-ficon.txt,.dp-ficon.md{background:#f1f5f9;color:#475569}
.dp-meta{min-width:0}
.dp-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dp-sub{margin-top:2px;font-size:12px;color:#94a3b8;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dp-tag{font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:2px 7px;border-radius:6px;background:#e2e8f0;color:#475569}
.dp-chars{font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:#f1f5f9;color:#475569;white-space:nowrap}
.dp-chev{flex:none;color:#94a3b8;transition:transform .15s ease}
.dp-chev.open{transform:rotate(180deg)}
.dp-preview{border-top:1px solid #e2e8f0;background:#f8fafc;padding:14px 16px}
.dp-preview pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13px;line-height:1.6;color:#475569;max-height:320px;overflow:auto}
.dp-preview small{display:block;margin-top:8px;font-size:12px;color:#94a3b8}
.dp-empty{text-align:center;padding:36px 16px;color:#64748b;font-size:14px}
.dp-skel{height:66px;border-radius:14px;background:linear-gradient(90deg,#f1f5f9,#e2e8f0,#f1f5f9);background-size:200% 100%;animation:dpsk 1.2s infinite}
.dp-spin{animation:dpspin 1s linear infinite}
.dp-foot{text-align:center;font-size:12px;color:#94a3b8}
@keyframes dpsk{0%{background-position:200% 0}100%{background-position:-200% 0}}
@keyframes dpspin{to{transform:rotate(360deg)}}
@media(max-width:640px){.dp-search input{width:120px}.dp-chars{display:none}}
`;

export default function Documents() {
  const [patientId, setPatientId] = useState("");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [last, setLast] = useState<Uploaded | null>(null);
  const [summary, setSummary] = useState<DocumentSummary | null>(null);
  const [visionSummary, setVisionSummary] = useState<VisionSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [analyzingImage, setAnalyzingImage] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, say] = useToast();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("patient_id");
    if (fromUrl) setPatientId(fromUrl);
  }, []);

  const refresh = useCallback(async () => {
    if (!patientId.trim()) {
      setDocs([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      setDocs(await api<Doc[]>(`/api/documents?patient_id=${encodeURIComponent(patientId.trim())}`));
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reach backend");
    }
    setLoading(false);
    setRefreshing(false);
  }, [patientId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const upload = async (file: File) => {
    if (!patientId.trim()) {
      setErr("Enter a patient ID before uploading a document.");
      return;
    }
    if (!ALLOWED.includes(ext(file.name))) {
      setErr(`Unsupported file type. Allowed: ${ALLOWED.join(", ")}`);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("patient_id", patientId.trim());
      const r = await fetch(`${API}/api/documents/upload`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      setLast((await r.json()) as Uploaded);
      setSummary(null);
      setVisionSummary(null);
      say(`Uploaded ${file.name}`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    }
    setBusy(false);
  };

  const summarizeLast = async () => {
    if (!last?.extracted_text?.trim()) return;
    setSummarizing(true);
    setErr("");
    try {
      setSummary(await api<DocumentSummary>("/api/documents/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: last.filename, extracted_text: last.extracted_text }),
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not summarize extracted text");
    } finally { setSummarizing(false); }
  };

  const analyzeImage = async () => {
    if (!last?.document_id || !patientId.trim()) return;
    setAnalyzingImage(true);
    setErr("");
    try {
      setVisionSummary(await api<VisionSummary>("/api/documents/vision-summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: last.document_id, patient_id: patientId.trim() }),
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not analyze image");
    } finally { setAnalyzingImage(false); }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? docs.filter((d) => d.filename.toLowerCase().includes(q)) : docs;
  }, [docs, query]);

  return (
    <Shell>
      <style>{CSS}</style>
      <div className="dp-wrap">
        <div className="dp-head">
          <h1>Documents</h1>
          <p>Extracted text stays in this patient&apos;s record; shared references belong in Evidence Library.</p>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13 }}>
            Patient ID
            <input value={patientId} onChange={(event) => setPatientId(event.target.value)} placeholder="Enter patient ID" aria-label="Patient ID" style={{ maxWidth: 280, padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 9 }} />
            <button type="button" className="dp-btn ghost" disabled={!patientId.trim() || refreshing} onClick={() => void refresh()}><RefreshCw size={14} />Load</button>
          </label>
        </div>

        <div className="dp-card">
          <div
            className={`dp-drop ${drag ? "drag" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files[0];
              if (f) upload(f);
            }}
          >
            <div className="dp-drop-icon">
              {busy ? <Loader2 size={24} className="dp-spin" /> : <UploadCloud size={24} />}
            </div>
            <strong>{busy ? "Uploading and extracting text..." : "Drag and drop a file here"}</strong>
            <small>PDF, TXT, MD, CSV, PNG, JPG, TIFF, BMP or WEBP · up to 25 MB</small>
            <button
              type="button"
              className="dp-btn"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              Choose file
            </button>
            <input
              ref={input}
              type="file"
              accept={ALLOWED.join(",")}
              className="dp-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = "";
              }}
            />
          </div>

          {err && <div className="dp-error">{err}</div>}

          {last && (
            <div className="dp-last">
              <div className="dp-last-title">
                {last.filename} <span>· {last.characters_extracted.toLocaleString()} characters extracted</span>
              </div>
              <p>{last.text_preview.slice(0, 600)}</p>
              {last.extracted_text?.trim() ? (
                <button type="button" className="dp-btn ghost" disabled={summarizing} onClick={() => void summarizeLast()}>
                  {summarizing ? "Summarizing extracted text…" : "Summarize extracted text"}
                </button>
              ) : <p>This file produced no readable text. Use the configured vision model below to analyze image content.</p>}
              {summary && <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #bbf7d0" }}>
                <strong>Summary of extracted text</strong><p>{summary.summary}</p>
                {!!summary.key_findings?.length && <><strong>Key findings</strong><ul>{summary.key_findings.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                {!!summary.uncertainties?.length && <><strong>Uncertainties</strong><ul>{summary.uncertainties.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                <small>{summary.review_note} This summarizes OCR/text only; it does not interpret the medical image.</small>
              </div>}
              {IMAGE_TYPES.has(ext(last.filename)) && <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #dbeafe" }}>
                {last.vision_available ? <button type="button" className="dp-btn" disabled={analyzingImage} onClick={() => void analyzeImage()}>
                  {analyzingImage ? "Analyzing image…" : `Analyze image with ${last.vision_model || "vision model"}`}
                </button> : <p>Image analysis is not configured. Set <code>OLLAMA_VISION_MODEL</code> to an installed Ollama vision model, then restart the backend.</p>}
                {visionSummary && <div style={{ marginTop: 12, padding: 14, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10 }}>
                  <strong>AI image observations · not a diagnosis</strong>
                  <p>{visionSummary.summary}</p>
                  <p><strong>Possible modality:</strong> {visionSummary.possible_modality}</p>
                  <p><strong>Image quality:</strong> {visionSummary.image_quality}</p>
                  {!!visionSummary.observed_features?.length && <><strong>Observed features</strong><ul>{visionSummary.observed_features.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                  {!!visionSummary.uncertainties?.length && <><strong>Uncertainties</strong><ul>{visionSummary.uncertainties.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                  {!!visionSummary.clinician_review_questions?.length && <><strong>Clinician review</strong><ul>{visionSummary.clinician_review_questions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
                  <small>Model: {visionSummary.model}. AI output can be wrong; a qualified clinician or radiologist must review the original image.</small>
                </div>}
              </div>}
            </div>
          )}
        </div>

        <section>
          <div className="dp-list-head">
            <div className="dp-list-title">
              <h2>Uploaded documents</h2>
              {!loading && <span className="dp-count">{docs.length}</span>}
            </div>
            <div className="dp-tools">
              <label className="dp-search">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by filename..."
                />
              </label>
              <button type="button" className="dp-btn ghost" onClick={refresh} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? "dp-spin" : ""} />
                Refresh
              </button>
            </div>
          </div>

          {loading && (
            <div className="dp-items">
              <div className="dp-skel" />
              <div className="dp-skel" />
              <div className="dp-skel" />
            </div>
          )}

          {!loading && docs.length === 0 && !err && (
            <div className="dp-card dp-empty">
              {patientId.trim() ? "No documents yet. Upload one above to get started." : "Enter a patient ID to load that patient’s documents."}
            </div>
          )}

          {!loading && docs.length > 0 && visible.length === 0 && (
            <div className="dp-card dp-empty">No documents match “{query}”.</div>
          )}

          <div className="dp-items">
            {visible.map((d) => {
              const isOpen = open === d.document_id;
              const kind = ext(d.filename).replace(".", "");
              const text = d.extracted_text ?? "";
              return (
                <div className="dp-item" key={d.document_id}>
                  <div className="dp-row">
                    <button
                      type="button"
                      className="dp-toggle"
                      onClick={() => setOpen(isOpen ? null : d.document_id)}
                    >
                      <span className={`dp-ficon ${kind}`}>
                        {kind === "csv" ? <FileSpreadsheet size={20} /> : <FileText size={20} />}
                      </span>
                      <span className="dp-meta">
                        <div className="dp-name">{d.filename}</div>
                        <div className="dp-sub">
                          {kind && <span className="dp-tag">{kind.toUpperCase()}</span>}
                          {fmtDate(d.created_at)}
                        </div>
                      </span>
                    </button>
                    <span className="dp-chars">{text.length.toLocaleString()} chars</span>
                    <ChevronDown size={16} className={`dp-chev ${isOpen ? "open" : ""}`} />
                  </div>
                  {isOpen && (
                    <div className="dp-preview">
                      <pre>{text ? text.slice(0, PREVIEW_CHARS) : "No text extracted."}</pre>
                      {text.length > PREVIEW_CHARS && (
                        <small>
                          Showing first {PREVIEW_CHARS.toLocaleString()} of {text.length.toLocaleString()} characters
                        </small>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <p className="dp-foot">Decision support only. OmniMed does not replace clinician judgment.</p>
      </div>
      {toast}
    </Shell>
  );
}
