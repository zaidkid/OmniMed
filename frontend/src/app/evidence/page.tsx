"use client";

import { useEffect, useRef, useState } from "react";
import {
  Search,
  Database,
  BookOpen,
  Plus,
  Trash2,
  Loader2,
  FileText,
  CheckCircle2,
  X,
  ChevronDown,
} from "lucide-react";

import Shell from "../../components/Shell";
import { api, useToast } from "../../components/Ui";

type Rec = Record<string, unknown>;

const EXCERPT_CHARS = 600;
const SUGGESTIONS = [
  "troponin and chest pain",
  "dengue warning signs",
  "platelet count thresholds",
];

const CSS = `
/* Evidence Library — page-scoped dashboard styling */
.omni-page{background:#f5f8fd!important;min-height:100%;padding:28px 26px 36px!important;color:#172554}
.omni-workspace{width:100%;max-width:1600px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.omni-page-heading{display:flex;align-items:center;gap:16px;margin:0 0 4px!important}
.omni-page-heading-icon{width:56px;height:56px;min-width:56px;border-radius:16px!important;background:#e7f0ff!important;color:#2376f5!important;display:grid;place-items:center}
.omni-eyebrow{font-size:10px!important;letter-spacing:.09em;font-weight:800!important;color:#5b7bb5!important;margin-bottom:5px}
.omni-page-heading h1{font-size:28px!important;line-height:1.2!important;letter-spacing:-.04em;color:#10264d!important;font-weight:800!important;margin:0!important}
.omni-page-description{font-size:13px!important;line-height:1.6!important;color:#6b7d98!important;margin:8px 0 0!important}
.omni-brief-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px!important;margin:0!important}
.omni-card{background:#fff!important;border:1px solid #e0e9f5!important;border-radius:15px!important;padding:20px!important;box-shadow:0 2px 8px rgba(20,55,100,.025)!important;min-width:0}
.omni-panel-heading{display:flex;align-items:center;gap:10px;margin-bottom:18px!important}
.omni-heading-icon{width:34px!important;height:34px!important;min-width:34px;border-radius:10px!important;display:grid;place-items:center}
.omni-heading-icon.blue{background:#e8f1ff!important;color:#2376f5!important}
.omni-heading-icon.green{background:#e2f8ef!important;color:#059669!important}
.omni-panel-heading-text h2{font-size:13px!important;font-weight:750!important;color:#172b4d!important;margin:0 0 4px!important}
.omni-panel-heading-text p,.omni-empty-note{font-size:11px!important;line-height:1.6!important;color:#7a8ba5!important;margin:0!important}
.omni-section-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px!important}
.omni-section-title-wrap{display:flex;align-items:flex-start;gap:11px;min-width:0}
.omni-step-number{display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;border-radius:50%;background:#2878f7!important;color:#fff!important;font-size:12px!important;font-weight:800!important}
.omni-step-number.green{background:#dcf8eb!important;color:#059669!important}
.omni-step-number.purple{background:#eee8ff!important;color:#7650ed!important}
.omni-section-title-wrap h2{font-size:14px!important;font-weight:800!important;letter-spacing:-.015em;color:#172b4d!important;margin:2px 0 5px!important}
.omni-section-title-wrap p{font-size:11px!important;line-height:1.6!important;color:#7a8ba5!important;margin:0!important}
.omni-question-row{display:flex!important;align-items:center!important;gap:8px!important;width:100%;min-width:0}
.omni-question-icon{display:flex;align-items:center;justify-content:center;flex:0 0 38px;height:38px;border:1px solid #dce6f3;border-radius:10px;color:#7890b3;background:#fff}
.omni-page .omni-input{display:block!important;box-sizing:border-box!important;width:100%!important;max-width:100%;min-width:0;padding:10px 12px!important;border:1px solid #d8e2f0!important;border-radius:9px!important;background:#fff!important;color:#1e3152!important;font-family:inherit!important;font-size:12px!important;line-height:1.5!important;outline:none!important;box-shadow:0 1px 2px rgba(15,35,70,.025)!important;transition:border-color .15s,box-shadow .15s!important}
.omni-page .omni-input::placeholder{color:#9aa9bd!important;opacity:1}
.omni-page .omni-input:focus{border-color:#6aa2ff!important;box-shadow:0 0 0 3px rgba(35,118,245,.12)!important}
.omni-page textarea.omni-input{min-height:150px;resize:vertical!important}
.omni-page label{display:block;min-width:0}
.omni-button{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:7px!important;min-height:38px!important;padding:9px 14px!important;border-radius:9px!important;font-family:inherit!important;font-size:12px!important;font-weight:700!important;white-space:nowrap;cursor:pointer;transition:all .15s ease!important}
.omni-button.primary{border:1px solid #2376f5!important;background:#2376f5!important;color:#fff!important;box-shadow:0 2px 5px rgba(35,118,245,.15)!important}
.omni-button.primary:hover:not(:disabled){background:#145fdb!important;transform:translateY(-1px)}
.omni-button.secondary{border:1px solid #dce5f1!important;background:#fff!important;color:#526581!important}
.omni-button.secondary:hover:not(:disabled){background:#f6f9fd!important;border-color:#c4d4e8!important}
.omni-button:disabled{opacity:.55;cursor:not-allowed}
.omni-message.error{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #fecaca;border-radius:9px;background:#fff1f2;color:#b91c1c;font-size:12px}
.omni-supported{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:1px solid #dce8f7;border-radius:999px;background:#f7faff;color:#5d7395;font-size:10px;font-weight:700;white-space:nowrap}
.omni-data-card{border:1px solid #e3ebf5!important;border-radius:12px!important;background:#fff!important;overflow:hidden}
.omni-data-card-heading{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:13px 15px;border-bottom:1px solid #edf2f8;background:#fbfdff}
.omni-data-card-heading>span{display:grid;place-items:center;width:29px;height:29px;border-radius:8px;background:#eaf2ff;color:#2878f7}
.omni-data-card-heading h3{flex:1;min-width:120px;margin:0;color:#203556;font-size:12px;font-weight:800}
.omni-data-card-content{padding:14px 15px}
.ev-chips{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.ev-chips-label{font-size:11px;font-weight:700;color:#71839e}
.ev-chip{border:1px solid #d5e1f0;background:#fff;color:#415574;font:inherit;font-size:11px;font-weight:600;padding:7px 12px;border-radius:999px;cursor:pointer;transition:all .15s ease}
.ev-chip:hover{border-color:#8bb7ff;color:#1764d8;background:#f0f6ff}
.ev-clear{display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#94a3b8;cursor:pointer}
.ev-clear:hover{background:#f1f5f9;color:#475569}
.ev-rel{display:flex;align-items:center;gap:8px;margin-left:auto}
.ev-rel-bar{width:64px;height:6px;border-radius:999px;background:#e2e8f0;overflow:hidden}
.ev-rel-fill{height:100%;border-radius:999px;background:#2878f7}
.ev-rel-text{font-size:10px;font-weight:700;color:#1e40af;white-space:nowrap}
.ev-more{display:inline-flex;align-items:center;gap:4px;margin-top:8px;border:0;background:none;padding:0;font:inherit;font-size:11px;font-weight:700;color:#2563eb;cursor:pointer}
.ev-more svg{transition:transform .15s ease}
.ev-more.open svg{transform:rotate(180deg)}
.ev-count{display:flex;justify-content:space-between;gap:10px;margin-top:6px;font-size:10px;color:#94a3b8}
.omni-safety-note{display:flex;align-items:flex-start;gap:11px;padding:14px 16px!important;border:1px solid #dce9fb!important;border-radius:12px!important;background:#f0f6ff!important;color:#2878f7!important}
.omni-safety-note h3{font-size:11px!important;font-weight:800!important;color:#244a7d!important;margin:0 0 4px!important}
.omni-safety-note p{font-size:11px!important;line-height:1.65!important;color:#617a9c!important;margin:0!important}
.omni-footer{padding:5px 0 0!important;text-align:center;color:#91a0b5!important;font-size:10px!important}
@media(max-width:900px){.omni-page{padding:22px 18px 30px!important}.omni-brief-grid{grid-template-columns:1fr!important}}
@media(max-width:560px){.omni-page{padding:16px 12px 24px!important}.omni-card{padding:15px!important}.omni-page-heading{align-items:flex-start}.omni-page-heading-icon{width:46px;height:46px;min-width:46px}.omni-page-heading h1{font-size:23px!important}.omni-question-row{flex-wrap:wrap!important}.omni-question-icon{display:none}.omni-question-row>.omni-input{flex:1 1 100%!important}.omni-question-row>.omni-button{flex:1}.omni-section-header{align-items:flex-start}.ev-rel{margin-left:0;width:100%}.omni-data-card-heading{align-items:flex-start}.ev-count{align-items:flex-start;flex-direction:column}}
`

const pick = (r: Rec, ...keys: string[]): string => {
  const nested = [
    r,
    r.payload as Rec | undefined,
    r.metadata as Rec | undefined,
  ];

  for (const obj of nested) {
    for (const key of keys) {
      const value = obj?.[key];

      if (typeof value === "string" && value) {
        return value;
      }
    }
  }

  return "";
};

const toScore = (raw: unknown): number | null =>
  typeof raw === "number"
    ? Math.max(0, Math.min(100, Math.round(raw <= 1 ? raw * 100 : raw)))
    : null;

const labelStyle = {
  display: "block",
  marginBottom: 5,
  color: "#34445f",
  fontSize: 10,
  fontWeight: 700,
} as const;

export default function Evidence() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Rec[] | null>(null);
  const [searchedFor, setSearchedFor] = useState("");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const requestId = useRef(0);

  const [form, setForm] = useState({
    title: "",
    source: "",
    text: "",
  });

  const [toast, say] = useToast();

  const status = async () => {
    try {
      const response = await api<{
        indexed_evidence_items: number;
      }>("/api/knowledge/status");

      setCount(response.indexed_evidence_items);
    } catch {
      setCount(null);
    }
  };

  const search = async (query: string) => {
    const trimmed = query.trim();

    if (!trimmed) {
      setErr("Enter a search query first.");
      return;
    }

    // Ignore responses from older searches if a newer one was started.
    const id = ++requestId.current;

    setBusy(true);
    setErr("");
    setResults(null);
    setExpanded({});

    try {
      const response = await api<{ results: Rec[] }>(
        "/api/evidence/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: trimmed,
            top_k: 5,
          }),
        }
      );

      if (id !== requestId.current) return;

      setResults(response.results ?? []);
      setSearchedFor(trimmed);

      // Keep the query in the URL so the page can be refreshed or shared.
      const url = new URL(window.location.href);
      url.searchParams.set("q", trimmed);
      window.history.replaceState(null, "", url);
    } catch (e) {
      if (id !== requestId.current) return;
      setErr(
        e instanceof Error ? e.message : "Evidence search failed."
      );
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };

  const clearSearch = () => {
    requestId.current++;
    setQ("");
    setResults(null);
    setSearchedFor("");
    setErr("");
    setBusy(false);

    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  };

  useEffect(() => {
    void status();

    const initial = new URLSearchParams(
      window.location.search
    ).get("q");

    if (initial) {
      setQ(initial);
      void search(initial);
    }
    // Read the initial URL query only when the page mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async () => {
    if (!form.title.trim() || !form.text.trim()) {
      say("Title and evidence text are required.");
      return;
    }

    setAdding(true);

    try {
      await api("/api/evidence/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          title: form.title.trim(),
          source: form.source.trim() || "Manual entry",
          text: form.text.trim(),
          metadata: {},
        }),
      });

      say("Evidence indexed successfully.");

      setForm({
        title: "",
        source: "",
        text: "",
      });

      await status();
    } catch (e) {
      say(
        e instanceof Error
          ? `Indexing failed: ${e.message}`
          : "Could not index evidence."
      );
    } finally {
      setAdding(false);
    }
  };

  const clearForm = () => {
    setForm({ title: "", source: "", text: "" });
  };

  const formReady = form.title.trim() !== "" && form.text.trim() !== "";
  const formDirty =
    form.title !== "" || form.source !== "" || form.text !== "";

  return (
    <Shell>
      <style>{CSS}</style>
      <div className="omni-page">
        <div className="omni-workspace">
          {/* Page heading */}
          <div className="omni-page-heading">
            <div className="omni-page-heading-icon">
              <BookOpen size={25} />
            </div>

            <div>
              <div className="omni-eyebrow">
                CLINICAL KNOWLEDGE MANAGEMENT
              </div>

              <h1>Evidence Library</h1>

              <p className="omni-page-description">
                Search indexed evidence and add clinical documents
                to support your clinical workflows.
              </p>
            </div>
          </div>

          {/* Evidence summary */}
          <div className="omni-brief-grid">
            <div className="omni-card">
              <div className="omni-panel-heading">
                <div className="omni-heading-icon blue">
                  <Database size={17} />
                </div>

                <div className="omni-panel-heading-text">
                  <h2>Indexed evidence</h2>
                  <p>Items in the knowledge library</p>
                </div>
              </div>

              <div
                style={{
                  color: "#172554",
                  fontSize: 26,
                  fontWeight: 800,
                }}
              >
                {count === null ? "—" : count.toLocaleString()}
              </div>

              {count === null && (
                <p className="omni-empty-note">
                  Evidence status is currently unavailable.
                </p>
              )}
            </div>

            <div className="omni-card">
              <div className="omni-panel-heading">
                <div className="omni-heading-icon green">
                  <CheckCircle2 size={17} />
                </div>

                <div className="omni-panel-heading-text">
                  <h2>Knowledge search</h2>
                  <p>Retrieve relevant indexed content</p>
                </div>
              </div>

              <p className="omni-empty-note">
                Search returns up to five matching evidence items.
              </p>
            </div>
          </div>

          {/* Search */}
          <section className="omni-card">
            <div className="omni-section-header">
              <div className="omni-section-title-wrap">
                <span className="omni-step-number">1</span>

                <div>
                  <h2>Search evidence</h2>
                  <p>
                    Enter a clinical topic, symptom, or research question.
                  </p>
                </div>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search(q);
              }}
            >
              <div className="omni-question-row">
                <div className="omni-question-icon">
                  <Search size={16} />
                </div>

                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="e.g. troponin and chest pain"
                  aria-label="Search evidence query"
                  className="omni-input"
                  style={{ minWidth: 0, flex: 1 }}
                />

                {q && (
                  <button
                    type="button"
                    className="ev-clear"
                    aria-label="Clear search"
                    title="Clear search"
                    onClick={clearSearch}
                  >
                    <X size={15} />
                  </button>
                )}

                <button
                  type="submit"
                  className="omni-button primary"
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 size={14} className="omni-spin" />
                  ) : (
                    <Search size={14} />
                  )}

                  {busy ? "Searching..." : "Search"}
                </button>
              </div>
            </form>

            {results === null && !busy && (
              <div className="ev-chips">
                <span className="ev-chips-label">Try:</span>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="ev-chip"
                    onClick={() => {
                      setQ(s);
                      void search(s);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {err && (
              <div
                className="omni-message error"
                style={{ marginTop: 12, marginBottom: 0 }}
              >
                <span>{err}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  onClick={() => setErr("")}
                >
                  ×
                </button>
              </div>
            )}
          </section>

          {/* Search results */}
          {results !== null && (
            <section className="omni-card">
              <div className="omni-section-header">
                <div className="omni-section-title-wrap">
                  <span className="omni-step-number green">
                    <FileText size={12} />
                  </span>

                  <div>
                    <h2>Search results</h2>
                    <p>
                      {results.length} matching{" "}
                      {results.length === 1 ? "item" : "items"} for “
                      {searchedFor}”
                    </p>
                  </div>
                </div>

                <span className="omni-supported">
                  <Database size={13} />
                  Top 5 results
                </span>
              </div>

              {results.length === 0 ? (
                <div
                  className="omni-dropzone"
                  style={{ minHeight: 110 }}
                >
                  <Search size={25} />
                  <strong>No matching evidence found</strong>
                  <span>
                    Try different keywords or add evidence below.
                  </span>
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  {results.map((result, index) => {
                    const score = toScore(result.score);
                    const fullText =
                      pick(result, "text", "excerpt", "content") ||
                      "No excerpt available.";
                    const long = fullText.length > EXCERPT_CHARS;
                    const isOpen = !!expanded[index];

                    return (
                      <article
                        key={
                          typeof result.id === "string"
                            ? result.id
                            : index
                        }
                        className="omni-data-card"
                      >
                        <div className="omni-data-card-heading">
                          <span>
                            <FileText size={15} />
                          </span>

                          <h3>
                            {pick(result, "title") ||
                              `Evidence item ${index + 1}`}
                          </h3>

                          {score !== null && score > 0 && (
                            <div className="ev-rel">
                              <div className="ev-rel-bar">
                                <div
                                  className="ev-rel-fill"
                                  style={{ width: `${score}%` }}
                                />
                              </div>
                              <span className="ev-rel-text">
                                {score}% relevant
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="omni-data-card-content">
                          <p
                            className="omni-empty-note"
                            style={{ marginBottom: 8 }}
                          >
                            {pick(result, "source") ||
                              "Source not specified"}
                          </p>

                          <p
                            style={{
                              color: "#52617b",
                              fontSize: 11,
                              lineHeight: 1.8,
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {isOpen
                              ? fullText
                              : fullText.slice(0, EXCERPT_CHARS) +
                                (long ? "…" : "")}
                          </p>

                          {long && (
                            <button
                              type="button"
                              className={`ev-more ${isOpen ? "open" : ""}`}
                              onClick={() =>
                                setExpanded((s) => ({
                                  ...s,
                                  [index]: !s[index],
                                }))
                              }
                            >
                              {isOpen ? "Show less" : "Show full text"}
                              <ChevronDown size={13} />
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Add evidence */}
          <section className="omni-card">
            <div className="omni-section-header">
              <div className="omni-section-title-wrap">
                <span className="omni-step-number purple">
                  <Plus size={14} />
                </span>

                <div>
                  <h2>Add evidence</h2>
                  <p>
                    Index a guideline, reference, or manually entered text.
                  </p>
                </div>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <label>
                <span style={labelStyle}>Title *</span>

                <input
                  value={form.title}
                  onChange={(e) =>
                    setForm({ ...form, title: e.target.value })
                  }
                  placeholder="Evidence title"
                  className="omni-input"
                />
              </label>

              <label>
                <span style={labelStyle}>Source</span>

                <input
                  value={form.source}
                  onChange={(e) =>
                    setForm({ ...form, source: e.target.value })
                  }
                  placeholder="Guideline, journal, URL, or manual entry"
                  className="omni-input"
                />
              </label>

              <label>
                <span style={labelStyle}>Evidence text *</span>

                <textarea
                  value={form.text}
                  onChange={(e) =>
                    setForm({ ...form, text: e.target.value })
                  }
                  rows={6}
                  placeholder="Enter the evidence content to index..."
                  className="omni-input"
                  style={{ resize: "vertical", lineHeight: 1.7 }}
                />
                <div className="ev-count">
                  <span>
                    {formReady || !formDirty
                      ? ""
                      : "Title and evidence text are required"}
                  </span>
                  <span>{form.text.length.toLocaleString()} characters</span>
                </div>
              </label>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  className="omni-button primary"
                  onClick={() => void add()}
                  disabled={adding || !formReady}
                >
                  {adding ? (
                    <Loader2 size={14} className="omni-spin" />
                  ) : (
                    <Database size={14} />
                  )}

                  {adding ? "Indexing..." : "Index evidence"}
                </button>

                <button
                  type="button"
                  className="omni-button secondary"
                  onClick={clearForm}
                  disabled={adding || !formDirty}
                >
                  <Trash2 size={14} />
                  Clear form
                </button>
              </div>
            </div>
          </section>

          <div className="omni-safety-note">
            <CheckCircle2 size={17} />

            <div>
              <h3>Clinical information notice</h3>
              <p>
                Verify evidence sources and clinical claims before using
                them in care decisions. OmniMed supports clinical workflows
                and does not replace professional medical judgment.
              </p>
            </div>
          </div>

          <footer className="omni-footer">
            OmniMed Clinical AI Copilot · Evidence Library
          </footer>
        </div>
      </div>

      {toast}
    </Shell>
  );
}