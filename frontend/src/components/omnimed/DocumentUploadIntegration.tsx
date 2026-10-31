"use client";

import { useState } from "react";
import StructuredReport from "./StructuredReport";

type UploadResponse = {
  document_id: string;
  patient_id?: string | null;
  filename: string;
  characters_extracted: number;
  extracted_text: string;
  structured_report: Record<string, unknown>;
};

type Props = { apiBaseUrl?: string; patientId?: string };

/** Reference integration: use this wiring pattern in the existing upload parent. */
export default function DocumentUploadIntegration({
  apiBaseUrl = "http://localhost:8000/api",
  patientId = "",
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [response, setResponse] = useState<UploadResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload() {
    if (!file) { setError("Choose a document first."); return; }
    setBusy(true); setError(""); setResponse(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (patientId.trim()) form.append("patient_id", patientId.trim());
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/documents/upload`, {
        method: "POST", body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `Upload failed (${response.status})`);
      if (!payload.structured_report || typeof payload.structured_report !== "object") {
        throw new Error("The backend did not return structured_report. Check the upload API response.");
      }
      setResponse(payload as UploadResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown upload error");
    } finally { setBusy(false); }
  }

  return <div className="omni-document-upload-integration">
    <div>
      <input type="file" accept=".pdf,.csv,.txt,.md,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button type="button" disabled={!file || busy} onClick={upload}>
        {busy ? "Extracting…" : "Upload and extract"}
      </button>
    </div>
    {busy && <p role="status">Extracting document text and mapping fields with Ollama…</p>}
    {error && <p role="alert">{error}</p>}
    {response && <StructuredReport
      filename={response.filename}
      documentId={response.document_id}
      patientId={response.patient_id || patientId}
      text={response.extracted_text || ""}
      characters={response.characters_extracted || 0}
      structuredReport={response.structured_report as never}
      onRemove={() => setResponse(null)}
    />}
  </div>;
}
