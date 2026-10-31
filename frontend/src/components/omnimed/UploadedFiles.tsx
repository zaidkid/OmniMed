
"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
} from "lucide-react";

export type UploadedFile = {
  documentId: string;
  filename: string;
  status: "extracting" | "structuring" | "ready" | "failed";
  characters?: number;
};

type Props = {
  files: UploadedFile[];
  selectedId?: string | null;
  onSelect: (documentId: string) => void;
};

const statusLabel: Record<UploadedFile["status"], string> = {
  extracting: "Extracting text...",
  structuring: "Structuring report...",
  ready: "Ready to review",
  failed: "Processing failed",
};

export default function UploadedFiles({
  files,
  selectedId,
  onSelect,
}: Props) {
  if (files.length === 0) return null;

  return (
    <section
      aria-label="Uploaded documents"
      style={{ display: "grid", gap: 10, marginTop: 12 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>
          Uploaded documents
        </h3>

        <span style={{ fontSize: 12, opacity: 0.65 }}>
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
      </div>

      {files.map((file) => {
        const active = file.documentId === selectedId;

        return (
          <button
            key={file.documentId}
            type="button"
            onClick={() => onSelect(file.documentId)}
            aria-pressed={active}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              width: "100%",
              minWidth: 0,
              padding: "12px 14px",
              borderRadius: 12,
              textAlign: "left",
              cursor: "pointer",
              color: "inherit",
              background: active
                ? "rgba(4, 120, 87, 0.08)"
                : "transparent",
              border: `1px solid ${
                active
                  ? "#047857"
                  : "rgba(148, 163, 184, 0.35)"
              }`,
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 42,
                height: 42,
                flexShrink: 0,
                borderRadius: 10,
                background: "rgba(16, 185, 129, 0.12)",
                color: "#047857",
              }}
            >
              <FileText size={20} />
            </span>

            <span style={{ flex: 1, minWidth: 0 }}>
              <strong
                style={{
                  display: "block",
                  fontSize: 14,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {file.filename}
              </strong>

              <span
                style={{
                  display: "block",
                  marginTop: 5,
                  fontSize: 12,
                  opacity: 0.7,
                }}
              >
                {file.characters != null
                  ? `${file.characters.toLocaleString()} characters · `
                  : ""}
                {statusLabel[file.status]}
              </span>
            </span>

            {file.status === "ready" ? (
              <CheckCircle2 size={17} color="#047857" />
            ) : file.status === "failed" ? (
              <AlertTriangle size={17} color="#b91c1c" />
            ) : (
              <Loader2
                size={17}
                className="animate-spin"
              />
            )}

            <ChevronRight
              size={17}
              style={{ opacity: active ? 1 : 0.45 }}
            />
          </button>
        );
      })}
    </section>
  );
}
