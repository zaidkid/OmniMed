"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { FileText, X, CheckCircle2 } from "lucide-react";

type Props = {
  filename: string;
  documentId?: string;
  patientId?: string;
  text: string;
  characters: number;
  onRemove: () => void;
  // Kept optional so existing callers passing this prop do not break.
  structuredReport?: unknown;
  fileUrl?: string;
  mimeType?: string;
};

/* ============================== Types ============================== */

type Flag = "High" | "Low" | "Abnormal" | "Critical" | "Normal" | "";
type Field = { label: string; value: string };
type LabRow = {
  name: string;
  time: string;
  value: string;
  unit: string;
  range: string;
  flag: Flag;
  line: number;
};
type GenericTable = { title: string; columns: string[]; rows: { cells: string[]; line: number }[] };
type TextSection = { title: string; paragraphs: { text: string; line: number }[] };
type Parsed = {
  title: string;
  banner: string;
  fields: Field[];
  labs: LabRow[];
  tables: GenericTable[];
  sections: TextSection[];
};
type Item = { text: string; line: number };

/* ============================== Parser ============================== */

const KNOWN_HEADINGS = new Set([
  "laboratory results", "lab results", "vital signs", "other findings",
  "presenting complaint", "extracted tables", "notes", "impression",
  "findings", "assessment", "plan", "comments", "recommendations",
  "summary", "diagnosis", "history", "investigations", "imaging", "results",
  "clinical notes", "clinical summary",
]);

// Split headings embedded after punctuation, including Presenting complaint.
const INLINE_HEAD =
  /([.!?])\s+(Presenting complaint|Laboratory results|Lab results|Vital signs|Other findings|Notes|Impression|Findings|Assessment|Plan|Comments|Recommendations|Summary|Diagnosis)(?=\s+[A-Z]|\s*$)/i;

const HDR_WORDS = "(?:Test|Time|Result|Results|Unit|Units|Reference|Range|Flag|Value|Parameter|Analyte)";
const LAB_HDR = new RegExp(`^${HDR_WORDS}(?:\\s+${HDR_WORDS})+$`, "i");
const TRAIL_HDR = new RegExp(`\\s+${HDR_WORDS}(?:\\s+${HDR_WORDS}){2,}$`, "i");

// "Title SYNTHETIC DATA ... NOT A REAL PATIENT."
const BANNER = /^(.+?)\s+([A-Z][A-Z0-9 ,.'\-]{18,})$/;

// Stand-alone disclaimer line that can appear anywhere in the document.
const DISCLAIMER_LINE = /synthetic data|not a real patient/i;

const LABELS = [
  "Patient ID", "Patient Name", "Age / Sex", "Age/Sex", "Gender", "Date of Birth", "DOB", "MRN",
  "Report date", "Reported", "Collected", "Collection date", "Specimen", "Location", "Facility",
  "Hospital", "Ordering physician", "Referring physician", "Physician", "Conditions", "Medications",
  "Allergies", "Presenting complaint", "Chief complaint", "Diagnosis", "Document ID", "Visit date",
  "Encounter",
].sort((a, b) => b.length - a.length);

const MULTI_WORD_COLUMNS = [
  "Blood pressure", "Heart rate", "Respiratory rate", "Resp rate", "Oxygen saturation",
  "Pulse rate", "Body temperature", "Temperature", "Blood glucose", "Pain score",
];

const RANGE_PARSE = /^([<>]=?)?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?$/;

const LAB_ROW =
  /^([A-Za-z][A-Za-z0-9 ,()/%.\-']*?)\s+(?:(\d{1,2}:\d{2})\s+)?([<>]?=?\s?\d+(?:\.\d+)?)(?:\s*([A-Za-zµ%][A-Za-z0-9µ%/^*.\-]*))?(?:\s+((?:[<>]=?\s*)?\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?))?(?:\s+(High|Low|Normal|Abnormal|Critical|HIGH|LOW|NORMAL|ABNORMAL|CRITICAL|H|L|N|\*))?$/;

const STOP_UNITS = new Set(["of", "to", "and", "at", "on", "in", "by", "or", "from", "for"]);
const UNIT_LIKE = /[/%^°]|^(?:mg|g|kg|ml|l|dl|mmol|mol|µ|u|iu|ng|pg|fl|pl|bpm|mmhg|cm|mm|cells|x10)/i;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function normalizeFlag(raw: string): Flag {
  const f = raw.trim().toLowerCase();
  if (f === "h" || f === "high") return "High";
  if (f === "l" || f === "low") return "Low";
  if (f === "abnormal" || f === "*") return "Abnormal";
  if (f === "critical") return "Critical";
  if (f === "normal" || f === "n") return "Normal";
  return "";
}

function computeFlag(value: string, range: string): Flag {
  const v = parseFloat(value.replace(/[^0-9.]/g, ""));
  const m = RANGE_PARSE.exec(range.trim());
  if (!m || Number.isNaN(v)) return "";
  const [, op, a, b] = m;
  const first = parseFloat(a);
  if (b !== undefined) {
    const second = parseFloat(b);
    if (v < first) return "Low";
    if (v > second) return "High";
    return "Normal";
  }
  if (op?.startsWith("<")) return v >= first ? "High" : "Normal";
  if (op?.startsWith(">")) return v <= first ? "Low" : "Normal";
  return "";
}

function isUpperHeading(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  return (
    letters.length >= 3 &&
    line.length <= 60 &&
    line === line.toUpperCase() &&
    !/\d{3,}/.test(line) &&
    !/[.!?,;]$/.test(line)
  );
}

function headingOf(line: string): string | null {
  const md = /^#{1,6}\s+(.+)$/.exec(line);
  if (md) return md[1].trim();
  const bare = line.replace(/:$/, "").trim();
  if (KNOWN_HEADINGS.has(bare.toLowerCase())) return bare;
  if (/^[A-Za-z][A-Za-z /&()'-]{2,40}:$/.test(line)) return bare;
  if (isUpperHeading(line)) return line;
  return null;
}

/** Handles "Patient ID X Age / Sex Y Report date Z" (no colons) and "Label: value". */
function extractFields(line: string): Field[] | null {
  const lower = line.toLowerCase();
  const first = LABELS.find(
    (l) => lower.startsWith(l.toLowerCase()) && (line.length === l.length || /[\s:：]/.test(line[l.length]))
  );

  if (first) {
    type Span = { start: number; end: number };
    const spans: Span[] = [{ start: 0, end: first.length }];
    const found: (Span & { len: number })[] = [];
    for (const l of LABELS) {
      const re = new RegExp(`\\s${escapeRe(l)}(?=\\s|[:：]|$)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        found.push({ start: m.index + 1, end: m.index + 1 + l.length, len: l.length });
      }
    }
    found.sort((a, b) => a.start - b.start || b.len - a.len);
    let last = first.length;
    for (const s of found) {
      if (s.start >= last) {
        spans.push({ start: s.start, end: s.end });
        last = s.end;
      }
    }
    const fields: Field[] = [];
    spans.forEach((s, i) => {
      const next = spans[i + 1];
      const label = line.slice(s.start, s.end).trim();
      const value = line.slice(s.end, next ? next.start : undefined).replace(/^[:：\s]+/, "").trim();
      if (label && value) fields.push({ label, value });
    });
    if (fields.length) return fields;
  }

  const kv = /^([A-Za-z][A-Za-z /()._'-]{1,40}?)\s*[:：]\s*(\S.*)$/.exec(line);
  if (kv && kv[1].trim().split(/\s+/).length <= 5) {
    return [{ label: kv[1].trim(), value: kv[2].trim() }];
  }
  return null;
}

function splitHeader(s: string): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const cols: string[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (const p of MULTI_WORD_COLUMNS) {
      const n = p.split(" ").length;
      if (words.slice(i, i + n).join(" ").toLowerCase() === p.toLowerCase()) {
        cols.push(words.slice(i, i + n).join(" "));
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) {
      cols.push(words[i]);
      i++;
    }
  }
  return cols;
}

/** "132/82 mmHg 78 bpm 98.6 F 98 %" -> ["132/82 mmHg","78 bpm","98.6 F","98 %"] */
function parseValues(rest: string): string[] {
  const re = /([<>]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s*([A-Za-z%°µ][A-Za-z%°µ/]*)?/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    out.push(`${m[1]}${m[2] ? " " + m[2] : ""}`);
  }
  return out;
}

function parseFlattenedLabRows(text: string): LabRow[] {
  const rows: LabRow[] = [];
  // Some PDF extractors flatten the entire table into one pipe-delimited line
  // and omit the pipe between a flag and the next test name.
  const rowPattern = /\b(hs[- ]?troponin|creatinine|hba1c|potassium)\s*\|\s*(\d{1,2}:\d{2})\s*\|\s*([<>]?\s*\d+(?:\.\d+)?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(High|Low|Normal|Abnormal|Critical)(?=\s*(?:\||$|(?:hs[- ]?troponin|creatinine|hba1c|potassium)\b))/gi;

  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(text)) !== null) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    const name = match[1].replace(/\s+/g, "-").replace(/^hs-/i, "hs-");
    rows.push({
      name,
      time: match[2],
      value: match[3].replace(/\s/g, ""),
      unit: match[4].trim(),
      range: match[5].trim(),
      flag: normalizeFlag(match[6]),
      line,
    });
  }

  return rows;
}

function parseLab(line: string, lineNo: number): LabRow | null {
  const m = LAB_ROW.exec(line);
  if (!m) return null;
  const name = m[1].trim();
  const time = m[2] || "";
  const value = m[3].replace(/\s/g, "");
  let unit = (m[4] || "").trim();
  const range = (m[5] || "").trim();
  let flagRaw = (m[6] || "").trim();

  if (unit && /^(h|l|high|low)$/i.test(unit) && !flagRaw && !range) {
    flagRaw = unit;
    unit = "";
  }
  if (STOP_UNITS.has(unit.toLowerCase())) return null;
  if (name.replace(/[^A-Za-z]/g, "").length < 2) return null;
  if (name.split(/\s+/).length > 6 || /[.:]$/.test(name) || /^page$/i.test(name)) return null;
  if (!range && !flagRaw && !(unit && UNIT_LIKE.test(unit))) return null;

  const flag = normalizeFlag(flagRaw) || computeFlag(value, range);
  return { name, time, value, unit, range, flag, line: lineNo };
}

function expand(item: Item): Item[] {
  const { text: t, line } = item;

  // Some PDF extractors put a section heading and its paragraph on one line,
  // e.g. "Presenting complaint Patient reports chest discomfort...".
  const leadingHeading = /^(Presenting complaint|Other findings|Notes|Laboratory results|Lab results|Vital signs|Clinical notes|Clinical summary|Impression|Assessment|Plan|Recommendations|Summary|Diagnosis|History|Investigations|Imaging)\s*:?\s+(.+)$/i.exec(t);
  if (leadingHeading && !KNOWN_HEADINGS.has(t.replace(/:$/, "").trim().toLowerCase())) {
    return [
      { text: leadingHeading[1], line },
      ...expand({ text: leadingHeading[2].trim(), line }),
    ];
  }

  const m = INLINE_HEAD.exec(t);
  if (m) {
    const before = t.slice(0, m.index + 1).trim();
    const after = t.slice(m.index + m[0].length).trim();
    return [
      ...(before ? expand({ text: before, line }) : []),
      { text: m[2], line },
      ...(after ? expand({ text: after, line }) : []),
    ];
  }

  const th = TRAIL_HDR.exec(t);
  if (th && th.index > 0) {
    return [...expand({ text: t.slice(0, th.index).trim(), line }), { text: th[0].trim(), line }];
  }

  if (/^Time\s/i.test(t) && /\s\d{1,2}:\d{2}\s/.test(t)) {
    return t
      .split(/\s(?=\d{1,2}:\d{2}\s)/)
      .map((x) => ({ text: x.trim(), line }))
      .filter((x) => x.text);
  }
  return [item];
}

function prepare(text: string): Item[] {
  const raw = text.replace(/\r/g, "").split("\n");
  const cleaned: Item[] = [];
  raw.forEach((r, i) => {
    const t = r.replace(/\[Page\s*\d+\]/gi, "").replace(/\s+/g, " ").trim();
    if (t) cleaned.push({ text: t, line: i + 1 });
  });

  // Repair times that extraction split across two lines: "07" + "00 18 ng/L" -> "07:00 18 ng/L"
  const merged: Item[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const cur = cleaned[i];
    const next = cleaned[i + 1];
    if (next) {
      const a = /^(.*[\s(])(\d{2})$/.exec(cur.text);
      const b = /^(\d{2})(?=[\s)])(.*)$/.exec(next.text);
      if (a && b && +a[2] <= 23 && +b[1] <= 59 && /^(\)|\s+[<>]?\d)/.test(b[2])) {
        merged.push({ text: `${a[1]}${a[2]}:${b[1]}${b[2]}`, line: cur.line });
        i++;
        continue;
      }
    }
    merged.push(cur);
  }

  return merged.flatMap(expand);
}

function splitDelimited(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === d && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function emptyParsed(): Parsed {
  return { title: "", banner: "", fields: [], labs: [], tables: [], sections: [] };
}

function parseDelimited(text: string): Parsed | null {
  const raw = text.replace(/\r/g, "").split("\n");
  const firstLine = raw.find((l) => l.trim()) ?? "";
  const d = firstLine.includes("\t")
    ? "\t"
    : !firstLine.includes(",") && firstLine.includes(";")
    ? ";"
    : !firstLine.includes(",") && firstLine.includes("|")
    ? "|"
    : ",";

  const out = emptyParsed();
  let table: GenericTable | null = null;
  raw.forEach((l, i) => {
    if (!l.trim()) return;
    const cells = splitDelimited(l, d);
    if (!table) {
      if (cells.length >= 3) table = { title: "Results", columns: cells, rows: [] };
      else if (cells.length === 2 && cells[0] && cells[1]) out.fields.push({ label: cells[0], value: cells[1] });
      return;
    }
    if (cells.every((c) => !c)) return;
    table.rows.push({ cells, line: i + 1 });
  });
  if (!table || !(table as GenericTable).rows.length) return null;
  out.tables.push(table);
  return out;
}

function parseDocument(text: string, filename: string): Parsed {
  if (/\.(csv|tsv)$/i.test(filename)) {
    const d = parseDelimited(text);
    if (d) return d;
  }

  const items = prepare(text);
  const out = emptyParsed();
  out.labs.push(...parseFlattenedLabRows(text));
  let ctx = "";
  let mode: "none" | "lab" | "table" = "none";
  let table: GenericTable | null = null;
  const labKeys = new Set<string>(
    out.labs.map((r) => `${r.name}|${r.time}|${r.value}`.toLowerCase())
  );

  const addParagraph = (title: string, t: string, line: number) => {
    const pipeCount = (t.match(/\|/g) || []).length;
    const containsFlattenedTable =
      pipeCount >= 5 &&
      /(test\s*\|\s*time\s*\|\s*result|blood pressure\s*\|\s*heart rate|hs[- ]?troponin|creatinine|hba1c|potassium)/i.test(t);

    // Do not render a duplicate flattened table as a prose paragraph.
    if (containsFlattenedTable) return;
    if (/^test$/i.test(t.trim()) && /laboratory results|lab results/i.test(title)) return;

    const name = !title || title === "Extracted tables" ? "Document text" : title;

    // "Document text" is only a catch-all bucket for lines that did not belong
    // to any recognised section. It is mostly leftovers (flattened tables,
    // disclaimers), so it is not rendered. A synthetic-data disclaimer is
    // promoted to the banner instead of being lost.
    if (name === "Document text") {
      if (!out.banner && DISCLAIMER_LINE.test(t)) out.banner = t.replace(/\.$/, "");
      return;
    }

    let sec = out.sections.find((s) => s.title === name);
    if (!sec) {
      sec = { title: name, paragraphs: [] };
      out.sections.push(sec);
    }
    const last = sec.paragraphs[sec.paragraphs.length - 1];
    if (last && !/[.!?:]$/.test(last.text)) last.text += " " + t;
    else sec.paragraphs.push({ text: t, line });
  };

  for (let idx = 0; idx < items.length; idx++) {
    const { text: t, line } = items[idx];

    // Document title / banner (first line only)
    if (idx === 0) {
      const bm = BANNER.exec(t);
      if (bm) {
        out.title = bm[1].trim();
        out.banner = bm[2].trim();
        continue;
      }
      if (
        /^[A-Za-z][A-Za-z &/,'-]{4,80}$/.test(t) &&
        t.split(" ").length >= 2 &&
        !headingOf(t) &&
        !extractFields(t)
      ) {
        out.title = t;
        continue;
      }
    }

    // Lab table header
    if (LAB_HDR.test(t)) {
      mode = "lab";
      table = null;
      continue;
    }

    // Headings
    const h = headingOf(t);
    if (h) {
      ctx = h;
      mode = "none";
      table = null;
      continue;
    }

    // Generic table header: "Time Blood pressure Heart rate ..."
    if (/^Time\s+[A-Za-z]/i.test(t) && !/\d{1,2}:\d{2}/.test(t)) {
      const cols = ["Time", ...splitHeader(t.replace(/^Time\s+/i, ""))];
      const key = cols.join("|").toLowerCase();
      table = out.tables.find((x) => x.columns.join("|").toLowerCase() === key) ?? null;
      if (!table) {
        table = {
          title: !ctx || ctx.toLowerCase() === "extracted tables" ? "Readings" : ctx,
          columns: cols,
          rows: [],
        };
        out.tables.push(table);
      }
      mode = "table";
      continue;
    }

    // Generic table row: "07:00 132/82 mmHg 78 bpm ..."
    if (mode === "table" && table) {
      const m = /^(\d{1,2}:\d{2})\s+(.+)$/.exec(t);
      if (m) {
        const cells = [m[1], ...parseValues(m[2])];
        const key = cells.join("|");
        if (!table.rows.some((r) => r.cells.join("|") === key)) table.rows.push({ cells, line });
        continue;
      }
    }

    // Header fields
    const fields = extractFields(t);
    if (fields) {
      for (const f of fields) {
        if (!out.fields.some((x) => x.label.toLowerCase() === f.label.toLowerCase())) out.fields.push(f);
      }
      continue;
    }

    // Lab result row
    const lab = parseLab(t, line);
    if (lab) {
      const key = `${lab.name}|${lab.time}|${lab.value}`.toLowerCase();
      if (!labKeys.has(key)) {
        labKeys.add(key);
        out.labs.push(lab);
      }
      continue;
    }

    // Suppress flattened table fragments even when extraction split the header
    // and data into separate source lines.
    const pipeCount = (t.match(/\|/g) || []).length;
    const flattenedTableFragment =
      pipeCount >= 5 &&
      /(test|time|result|reference|blood pressure|heart rate|hs[- ]?troponin|creatinine|hba1c|potassium)/i.test(t);
    if (flattenedTableFragment) continue;
    if (/^test$/i.test(t.trim()) && /laboratory results|lab results/i.test(ctx)) continue;

    addParagraph(ctx, t, line);
  }

  out.tables = out.tables.filter((x) => x.rows.length > 0);
  return out;
}

/* ============================== UI helpers ============================== */

const BORDER = "rgba(148, 163, 184, 0.35)";

const flagColors: Record<string, CSSProperties> = {
  High: { background: "#fee2e2", color: "#b91c1c" },
  Critical: { background: "#fee2e2", color: "#b91c1c" },
  Low: { background: "#fef3c7", color: "#b45309" },
  Abnormal: { background: "#ffedd5", color: "#c2410c" },
  Normal: { background: "#d1fae5", color: "#047857" },
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.8,
  whiteSpace: "nowrap",
  background: "rgba(148, 163, 184, 0.14)",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  fontSize: 13,
  borderBottom: `1px solid ${BORDER}`,
  verticalAlign: "middle",
};

function FlagPill({ flag }: { flag: string }) {
  const f = normalizeFlag(flag) || "";
  if (!f) return <>{flag || "—"}</>;
  return (
    <span
      style={{
        ...flagColors[f],
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {f}
    </span>
  );
}

function SourceChip({ line, onClick }: { line: number; onClick: (n: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onClick(line)}
      title="Show this line in the raw text"
      style={{
        border: `1px solid ${BORDER}`,
        background: "transparent",
        borderRadius: 8,
        padding: "4px 10px",
        fontSize: 12,
        cursor: "pointer",
        whiteSpace: "nowrap",
        color: "inherit",
      }}
    >
      Line {line}
    </button>
  );
}

const cardStyle: CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
  padding: 14,
};

/* ============================== Component ============================== */

export default function StructuredReport({
  filename,
  documentId,
  text,
  characters,
  onRemove,
  fileUrl,
  mimeType,
}: Props) {
  const [view, setView] = useState<"structured" | "raw" | "original">("structured");
  const [highlight, setHighlight] = useState<number | null>(null);

  const parsed = useMemo(() => parseDocument(text || "", filename || ""), [text, filename]);
  const rawLines = useMemo(() => (text || "").replace(/\r/g, "").split("\n"), [text]);

  const labRows = useMemo(() => {
    const groups = new Map<string, LabRow[]>();
    for (const r of parsed.labs) {
      const k = r.name.toLowerCase();
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    const flat: (LabRow & { first: boolean })[] = [];
    groups.forEach((rows) => {
      rows.sort((a, b) => a.time.localeCompare(b.time));
      rows.forEach((r, i) => flat.push({ ...r, first: i === 0 }));
    });
    return flat;
  }, [parsed.labs]);

  const hasTime = labRows.some((r) => r.time);
  const hasUnit = labRows.some((r) => r.unit);
  const hasRange = labRows.some((r) => r.range);
  const hasFlag = labRows.some((r) => r.flag);
  const outOfRange = labRows.filter((r) => ["High", "Low", "Abnormal", "Critical"].includes(r.flag)).length;

  const shortFields = parsed.fields.filter((f) => f.value.length <= 48);
  const longFields = parsed.fields.filter((f) => f.value.length > 48);

  const hasStructured =
    parsed.fields.length > 0 ||
    parsed.labs.length > 0 ||
    parsed.tables.length > 0 ||
    parsed.sections.length > 0 ||
    !!parsed.banner;

  const goToLine = (n: number) => {
    setHighlight(n);
    setView("raw");
  };

  useEffect(() => {
    if (view === "raw" && highlight) {
      document
        .getElementById(`omni-raw-line-${highlight}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [view, highlight]);

  const tabStyle = (active: boolean): CSSProperties => ({
    background: "transparent",
    border: "none",
    borderBottom: active ? "2px solid #047857" : "2px solid transparent",
    color: active ? "#047857" : "inherit",
    opacity: active ? 1 : 0.7,
    fontWeight: 600,
    fontSize: 14,
    padding: "10px 16px",
    cursor: "pointer",
  });

  return (
    <section className="omni-card" aria-labelledby="extracted-text-title">
      <div className="omni-section-header">
        <div className="omni-section-title-wrap">
          <span className="omni-step-number green">2</span>
          <div>
            <h2 id="extracted-text-title">Review extracted content</h2>
            <p>Check the extracted text before generating a brief.</p>
          </div>
        </div>

        <div className="omni-section-actions">
          <button type="button" className="omni-button danger small" onClick={onRemove}>
            <X size={14} />
            Remove report
          </button>
        </div>
      </div>

      <div className="omni-upload-success">
        <div className="omni-upload-success-icon">
          <FileText size={18} />
        </div>
        <div className="omni-upload-success-content">
          <strong>{filename}</strong>
          <p>
            {documentId ? <>Document ID: {documentId}<span> · </span></> : null}
            {characters.toLocaleString()} characters extracted
          </p>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            color: "#047857",
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          <CheckCircle2 size={14} /> Text extracted
        </span>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Document views"
        style={{ display: "flex", gap: 4, marginTop: 16, borderBottom: `1px solid ${BORDER}`, overflowX: "auto" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "structured"}
          style={tabStyle(view === "structured")}
          onClick={() => setView("structured")}
        >
          Structured
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "raw"}
          style={tabStyle(view === "raw")}
          onClick={() => setView("raw")}
        >
          Raw text
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "original"}
          style={tabStyle(view === "original")}
          onClick={() => setView("original")}
        >
          Original file
        </button>
      </div>

      {view === "raw" ? (
        <div className="omni-raw-panel" style={{ marginTop: 14 }}>
          <div className="omni-raw-heading">Raw extracted text</div>
          {text?.trim() ? (
            <div
              style={{
                margin: 0,
                maxHeight: 440,
                overflow: "auto",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 13,
                lineHeight: 1.65,
              }}
            >
              {rawLines.map((l, i) => {
                const n = i + 1;
                const active = n === highlight;
                return (
                  <div
                    key={n}
                    id={`omni-raw-line-${n}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "44px 1fr",
                      background: active ? "rgba(250, 204, 21, 0.28)" : "transparent",
                      borderRadius: 4,
                    }}
                  >
                    <span style={{ opacity: 0.45, userSelect: "none", textAlign: "right", paddingRight: 10 }}>
                      {n}
                    </span>
                    <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{l || "\u00A0"}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <pre style={{ margin: 0 }}>No text was returned by the extraction service.</pre>
          )}
        </div>
      ) : view === "original" ? (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          {!fileUrl ? (
            <div className="omni-empty-note">
              The original file is not available for this document. Pass the uploaded file URL
              or a valid backend file endpoint through the fileUrl prop.
            </div>
          ) : /\.pdf(?:$|[?#])/i.test(filename) || (mimeType || "").toLowerCase().includes("pdf") ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <a
                  className="omni-button secondary small"
                  href={fileUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in new tab
                </a>
                <a
                  className="omni-button secondary small"
                  href={fileUrl}
                  download={filename}
                >
                  Download original
                </a>
              </div>
              <iframe
                key={fileUrl}
                src={fileUrl}
                title={filename}
                style={{
                  width: "100%",
                  height: 620,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 12,
                  background: "#fff",
                }}
              />
            </>
          ) : (
            <div style={cardStyle}>
              <p style={{ marginTop: 0 }}>
                Preview is not available for this file type.
              </p>
              <a href={fileUrl} target="_blank" rel="noreferrer">
                Open {filename}
              </a>
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
          {!hasStructured ? (
            <div className="omni-empty-note">
              No structured content could be detected. Open the <strong>Raw text</strong> tab to inspect the
              extracted text.
            </div>
          ) : (
            <>
              {(parsed.title || parsed.banner) && (
                <div>
                  {parsed.title && <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{parsed.title}</h3>}
                  {parsed.banner && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: "8px 12px",
                        borderRadius: 8,
                        background: "#fef3c7",
                        color: "#92400e",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {parsed.banner}
                    </div>
                  )}
                </div>
              )}

              {/* Header fields */}
              {parsed.fields.length > 0 && (
                <div style={{ display: "grid", gap: 10 }}>
                  {shortFields.length > 0 && (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                        gap: 10,
                      }}
                    >
                      {shortFields.map((f, i) => (
                        <div key={`${f.label}-${i}`} style={{ ...cardStyle, padding: "12px 14px" }}>
                          <div style={{ fontSize: 12, opacity: 0.65 }}>{f.label}</div>
                          <div style={{ marginTop: 4, fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>
                            {f.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {longFields.map((f, i) => (
                    <div key={`${f.label}-long-${i}`} style={{ ...cardStyle, padding: "12px 14px" }}>
                      <div style={{ fontSize: 12, opacity: 0.65 }}>{f.label}</div>
                      <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.6 }}>{f.value}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Lab results */}
              {labRows.length > 0 && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Laboratory results</h3>
                    <span style={{ fontSize: 12, opacity: 0.65 }}>{labRows.length} results</span>
                    {outOfRange > 0 && (
                      <span style={{ ...flagColors.High, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
                        {outOfRange} out of range
                      </span>
                    )}
                  </div>
                  <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${BORDER}` }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={thStyle}>Test</th>
                          {hasTime && <th style={thStyle}>Time</th>}
                          <th style={thStyle}>Result</th>
                          {hasUnit && <th style={thStyle}>Unit</th>}
                          {hasRange && <th style={thStyle}>Reference</th>}
                          {hasFlag && <th style={thStyle}>Flag</th>}
                          <th style={thStyle}>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {labRows.map((r, i) => (
                          <tr key={`${r.name}-${r.time}-${i}`}>
                            <td style={{ ...tdStyle, fontWeight: r.first ? 600 : 400 }}>{r.first ? r.name : ""}</td>
                            {hasTime && <td style={tdStyle}>{r.time || "—"}</td>}
                            <td style={{ ...tdStyle, fontWeight: 700 }}>{r.value}</td>
                            {hasUnit && <td style={tdStyle}>{r.unit || "—"}</td>}
                            {hasRange && <td style={tdStyle}>{r.range || "—"}</td>}
                            {hasFlag && (
                              <td style={tdStyle}>{r.flag ? <FlagPill flag={r.flag} /> : "—"}</td>
                            )}
                            <td style={tdStyle}>
                              <SourceChip line={r.line} onClick={goToLine} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Other tables (vitals, CSV rows, ...) */}
              {parsed.tables.map((tbl, ti) => {
                const colCount = Math.max(tbl.columns.length, ...tbl.rows.map((r) => r.cells.length));
                const headers = Array.from({ length: colCount }, (_, i) => tbl.columns[i] ?? `Value ${i}`);
                return (
                  <div key={`${tbl.title}-${ti}`}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{tbl.title}</h3>
                      <span style={{ fontSize: 12, opacity: 0.65 }}>{tbl.rows.length} rows</span>
                    </div>
                    <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${BORDER}` }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            {headers.map((h, i) => (
                              <th key={`${h}-${i}`} style={thStyle}>{h}</th>
                            ))}
                            <th style={thStyle}>Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tbl.rows.map((r, ri) => (
                            <tr key={ri}>
                              {headers.map((h, ci) => {
                                const cell = r.cells[ci] ?? "";
                                const isFlagCol = /flag|status|interpretation/i.test(h);
                                return (
                                  <td key={ci} style={{ ...tdStyle, fontWeight: ci === 0 ? 600 : 400 }}>
                                    {!cell ? "—" : isFlagCol ? <FlagPill flag={cell} /> : cell}
                                  </td>
                                );
                              })}
                              <td style={tdStyle}>
                                <SourceChip line={r.line} onClick={goToLine} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {/* Findings / notes / any other recognised section */}
              {parsed.sections.map((s, si) => (
                <div key={`${s.title}-${si}`} style={cardStyle}>
                  <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700 }}>{s.title}</h3>
                  <div style={{ display: "grid", gap: 8 }}>
                    {s.paragraphs.map((p, pi) => (
                      <p key={pi} style={{ margin: 0, fontSize: 13, lineHeight: 1.65, overflowWrap: "anywhere" }}>
                        {p.text}{" "}
                        <button
                          type="button"
                          onClick={() => goToLine(p.line)}
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "#047857",
                            fontSize: 11,
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          (line {p.line})
                        </button>
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <p className="omni-report-disclaimer">
        Extracted text may contain parsing or OCR errors. The structured view is auto-generated from the raw
        text. Confirm important values against the original document before clinical use.
      </p>
    </section>
  );
}