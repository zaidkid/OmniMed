"use client";

import { FormEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ZoomIn, ZoomOut, RotateCcw, Network, X, ExternalLink, UploadCloud, LoaderCircle, Maximize2 } from "lucide-react";
import { API } from "../Ui";

type Provenance = { source_id: string; source_title: string; source_url: string; page?: number | null; chunk_id: string; snippet: string; confidence: number };
type Node = { id: string; label: string; name: string; type: string; citation_ids: number[]; provenance: Provenance[] };
type Edge = { id: string; source: string; target: string; type: string; citation_ids: number[]; provenance: Provenance[] };
type Citation = { id: number; source_title: string; source_url: string; page?: number | null; snippet: string; confidence: number; chunk_id: string };
type Result = { answer: string; citations: Citation[]; graph: { nodes: Node[]; edges: Edge[] }; disclaimer: string; model?: string; generation_status?: "ollama" | "fallback" };
type Pos = { x: number; y: number };
type Props = { patientId?: string; patientState?: Record<string, unknown> | null; refreshKey?: string; compact?: boolean };

const COLORS: Record<string, string> = { Disease: "#F59E3F", Drug: "#B66FD0", Test_Items: "#EF4F4F", Symptom: "#2E8B63", Anatomy: "#7FCF84", Pathogenesis: "#D9C29B", Mechanism: "#3F7FD8" };
const LIGHT = new Set(["Pathogenesis", "Anatomy"]);
const BORDERS: Record<string, string> = { Disease: "#D17A1F", Drug: "#8E4FA8", Test_Items: "#C73A3A", Symptom: "#1F6A49", Anatomy: "#58A85E", Pathogenesis: "#B09C75", Mechanism: "#2C5EAE" };
const TYPES = Object.keys(COLORS);
const W = 1000, H = 640;
const EMPTY_NODES: Node[] = [];
const EMPTY_EDGES: Edge[] = [];
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const colorFor = (type: string, label = "") => label === "Type 2" ? "#35BEDC" : COLORS[type] ?? "#94A3B8";
const borderFor = (type: string, label = "") => label === "Type 2" ? "#2395B3" : BORDERS[type] ?? "#718096";
const radiusOf = (n: Node) => n.type === "Disease" ? 46 : 33;
const mix = (hex: string, to: number, amt: number) => {
  const n = parseInt(hex.slice(1), 16), c = (v: number) => Math.round(v + (to - v) * amt);
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
};
const tooltipPos = (x: number, y: number) => {
  const maxTop = Math.max(8, window.innerHeight - Math.min(280, window.innerHeight - 24) - 8);
  return { left: clamp(x + 16, 12, Math.max(12, window.innerWidth - 336)), top: clamp(y + 14, 8, maxTop) };
};

// Use only graph facts that have a matching source citation when the model
// returns its generic insufficient-evidence response.
function recoverCitedAnswer(result: Result): Result {
  if (!/^\s*insufficient evidence/i.test(result.answer)) return result;
  const citations = new Map(result.citations.map((citation) => [citation.id, citation]));
  const nodes = new Map(result.graph.nodes.map((node) => [node.id, node]));
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const edge of result.graph.edges) {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (!source || !target) continue;
    const citationId = edge.citation_ids.find((id) => citations.has(id));
    if (citationId === undefined) continue;
    const key = source.label + "|" + target.label + "|" + edge.type;
    if (seen.has(key)) continue;
    seen.add(key);
    const excerpt = citations.get(citationId)!.snippet?.trim();
    facts.push(source.label + " is linked to " + target.label + " (" + edge.type + ")" + (excerpt ? "; source excerpt: “" + excerpt.slice(0, 260) + "”" : "") + " [" + citationId + "]");
  }
  if (!facts.length) return result;
  return {
    ...result,
    answer: "Retrieved graph evidence:\n\n" + facts.slice(0, 8).map((fact) => "- " + fact).join("\n") + "\n\nThese are source-linked associations; review the cited material for clinical applicability.",
  };
}

function bindResultToPatientReport(result: Result, patientState: Record<string, unknown>): Result {
  const reportText = Array.isArray(patientState.notes)
    ? patientState.notes.filter((item): item is string => typeof item === "string").join("\n")
    : "";
  if (!reportText.trim()) {
    return {
      ...result,
      answer: "Insufficient evidence: no readable text or image observations are available for this upload.",
      citations: [],
      graph: { nodes: [], edges: [] },
      generation_status: "fallback",
    };
  }
  const sourceTitle = typeof patientState.source_title === "string" ? patientState.source_title : "Uploaded patient report";
  const fromVisionAssistedImage = sourceTitle.includes("AI image observations");
  const provenance: Provenance = { source_id: "patient-report", source_title: sourceTitle, source_url: "", page: null, chunk_id: "patient-report:1", snippet: reportText.slice(0, 300), confidence: fromVisionAssistedImage ? 0.8 : 1 };
  const citation: Citation = { id: 1, ...provenance };
  const nodes: Node[] = [], edges: Edge[] = [];
  const addNode = (name: string, type: string): string => {
    const id = type.toLowerCase() + ":" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!nodes.some((node) => node.id === id)) nodes.push({ id, label: name, name, type, citation_ids: [1], provenance: [provenance] });
    return id;
  };
  const diseases = Array.isArray(patientState.conditions)
    ? patientState.conditions.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  const diseaseTerms = ["Type 2 Diabetes", "Dengue Fever", "Hypertension", "Type 1 Diabetes", "Diabetes", "Asthma", "COPD", "Pneumonia", "Malaria"];
  const detectedDiseases = diseaseTerms.filter((term) => new RegExp("\\b" + term.replace(/\s+/g, "\\s+") + "\\b", "i").test(reportText));
  const diseaseNames = [...new Set([...diseases, ...detectedDiseases])];
  const addFact = (name: string, type: "Symptom" | "Test_Items", relation: string, diseaseName: string) => {
    const source = addNode(name, type), target = addNode(diseaseName, "Disease");
    const id = source + "|" + relation + "|" + target;
    if (!edges.some((edge) => edge.id === id)) edges.push({ id, source, target, type: relation, citation_ids: [1], provenance: [provenance] });
  };
  const symptomTerms = ["Fever", "Headache", "Muscle aches", "Nausea", "Vomiting", "Bleeding", "Abdominal pain"];
  const reportSymptoms = Array.isArray(patientState.symptoms)
    ? patientState.symptoms.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  const symptoms = [...new Set([...reportSymptoms, ...symptomTerms.filter((term) => new RegExp("\\b" + term.replace(" ", "\\s+") + "\\b", "i").test(reportText))])];
  const timeline = Array.isArray(patientState.timeline) ? patientState.timeline : [];
  const labNames = timeline.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string" ? [String((item as Record<string, unknown>).name)] : []);
  const testTerms = ["Dengue NS1 antigen", "Platelet count", "White blood cell count", "Complete blood count", "Hematocrit", "HbA1c", "Fasting blood glucose", "2-hour blood glucose"];
  const reportTests = testTerms.filter((term) => {
    if (term === "Platelet count") return /\bplatelet(?:s)?\b/i.test(reportText);
    if (term === "White blood cell count") return /\b(?:white[ -]cell|white blood cell|wbc)\b/i.test(reportText);
    if (term === "Dengue NS1 antigen") return /\bns1\b/i.test(reportText);
    return new RegExp("\\b" + term.replace(/\s+/g, "\\s+") + "\\b", "i").test(reportText);
  });
  const testNames = [...new Set([...labNames, ...reportTests])];
  diseaseNames.forEach((disease) => addNode(disease, "Disease"));
  for (const disease of diseaseNames) {
    for (const symptom of symptoms) addFact(symptom, "Symptom", "Symptom_Disease", disease);
    for (const test of testNames) addFact(test, "Test_Items", "Test_Items_Disease", disease);
  }
  if (!diseaseNames.length) return { ...result, citations: [citation], graph: { nodes: [], edges: [] } };
  return {
    ...result,
    citations: [citation],
    graph: { nodes, edges },
  };
}

// Force-directed hub-and-spoke layout. Diseases are hubs; existing positions stay fixed when new nodes are added.
function runLayout(nodes: Node[], edges: Edge[], old: Record<string, Pos>): Record<string, Pos> {
  const cx = W / 2, cy = H / 2;
  const pos: Record<string, Pos> = {}, fixed = new Set<string>();
  nodes.forEach((n) => { if (old[n.id]) { pos[n.id] = { ...old[n.id] }; fixed.add(n.id); } });
  const hubs = nodes.filter((n) => n.type === "Disease");
  hubs.forEach((n, i) => { if (!pos[n.id]) pos[n.id] = { x: cx + (i - (hubs.length - 1) / 2) * 330, y: cy }; });
  const near = (id: string) => {
    for (const e of edges) {
      if (e.source === id && pos[e.target]) return pos[e.target];
      if (e.target === id && pos[e.source]) return pos[e.source];
    }
    return null;
  };
  const fresh = nodes.filter((n) => !pos[n.id]).sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
  const byHub = new Map<string, Node[]>(), baseOf = new Map<string, Pos>();
  fresh.forEach((n) => {
    const b = near(n.id) ?? { x: cx, y: cy }, key = `${Math.round(b.x)}:${Math.round(b.y)}`;
    baseOf.set(key, b); byHub.set(key, [...(byHub.get(key) ?? []), n]);
  });
  byHub.forEach((list, key) => {
    const b = baseOf.get(key)!;
    list.forEach((n, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / list.length; pos[n.id] = { x: b.x + Math.cos(a) * 260, y: b.y + Math.sin(a) * 260 }; });
  });
  const ids = nodes.map((n) => n.id), isHub = new Set(hubs.map((n) => n.id));
  const links = edges.filter((e) => pos[e.source] && pos[e.target]);
  for (let it = 0; it < 320; it++) {
    const t = 1 - it / 320, f: Record<string, Pos> = {};
    ids.forEach((id) => { f[id] = { x: 0, y: 0 }; });
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = pos[ids[i]], b = pos[ids[j]];
      const dx = a.x - b.x || 0.1, dy = a.y - b.y || 0.1;
      const d2 = Math.max(dx * dx + dy * dy, 50), d = Math.sqrt(d2), s = 9000 / d2;
      f[ids[i]].x += (dx / d) * s; f[ids[i]].y += (dy / d) * s;
      f[ids[j]].x -= (dx / d) * s; f[ids[j]].y -= (dy / d) * s;
    }
    links.forEach((e) => {
      const a = pos[e.source], b = pos[e.target];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const rest = isHub.has(e.source) && isHub.has(e.target) ? 300 : 210, s = (d - rest) * 0.04;
      f[e.source].x += (dx / d) * s; f[e.source].y += (dy / d) * s;
      f[e.target].x -= (dx / d) * s; f[e.target].y -= (dy / d) * s;
    });
    ids.forEach((id) => {
      if (fixed.has(id)) return;
      const p = pos[id], fx = f[id].x + (cx - p.x) * 0.004, fy = f[id].y + (cy - p.y) * 0.004;
      const m = Math.hypot(fx, fy) || 1, step = Math.min(m * 2, 20 * t + 1.5);
      p.x += (fx / m) * step; p.y += (fy / m) * step;
    });
  }
  if (!fixed.size && ids.length) {
    const xs = ids.map((id) => pos[id].x), ys = ids.map((id) => pos[id].y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min((W - 140) / ((maxX - minX) || 1), (H - 140) / ((maxY - minY) || 1), 1.3);
    ids.forEach((id) => { pos[id] = { x: cx + (pos[id].x - (minX + maxX) / 2) * s, y: cy + (pos[id].y - (minY + maxY) / 2) * s }; });
  }
  return pos;
}

// Native wheel listener so the page does not scroll while zooming the graph.
const wheelRef = (el: SVGSVGElement | null, zoom: (dir: number) => void) => {
  el?.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
};

export default function KnowledgeGraphPanel({ patientId, patientState, refreshKey = "", compact = false }: Props) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState<Set<string>>(new Set(TYPES));
  const [search, setSearch] = useState("");
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const [scale, setScale] = useState(1);
  const [layoutReset, setLayoutReset] = useState(0);
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 });
  const [hovered, setHovered] = useState<{ kind: "node" | "edge"; id: string; x: number; y: number } | null>(null);
  const [hoverCitations, setHoverCitations] = useState<Set<number>>(new Set());
  const [chipFilter, setChipFilter] = useState<Set<number> | null>(null);
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ node: Node; chunks: Array<{ provenance: Provenance; text: string }> } | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestNotice, setIngestNotice] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [panDrag, setPanDrag] = useState<Pos | null>(null);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const openBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastAutoQuery = useRef("");
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragMoved = useRef(false);
  const posRef = useRef<Record<string, Pos>>({});
  const dragRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const hoverActive = useRef(false);

  const zoomBy = useCallback((factor: number) => setScale((v) => clamp(v * factor, 0.45, 3)), []);
  const svgRef = useCallback((el: SVGSVGElement | null) => wheelRef(el, zoomBy), [zoomBy]);

  const resetLayout = () => { setPositions({}); setLayoutReset((v) => v + 1); setScale(1); setPan({ x: 0, y: 0 }); };

  const submit = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setBusy(true); setError(""); setDrawer(null); setPinnedNodeId(null); setHovered(null); setHoverCitations(new Set()); setStreamText("");
    try {
      const reportText = patientState && Array.isArray(patientState.notes)
        ? patientState.notes.filter((item): item is string => typeof item === "string").join("\n").slice(0, 14000)
        : "";
      const patientContext = reportText ? {
        source_title: typeof patientState?.source_title === "string" ? patientState.source_title : "Uploaded patient report",
        patient_id: patientId || "",
        text: reportText,
      } : undefined;
      const response = await fetch(API + "/api/graph-rag/query/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, patient_context: patientContext }), cache: "no-store" });
      if (!response.ok) { const body = await response.json(); throw new Error(body.detail || "Graph search failed."); }
      if (!response.body) throw new Error("Streaming response was unavailable.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      const finalResult: { value: Result | null } = { value: null };
      const handleBlock = (block: string) => {
        const line = block.split("\n").find((item) => item.startsWith("data: "));
        if (!line) return;
        const event = JSON.parse(line.slice(6));
        if (event.type === "meta") {
          const initial = { ...event.result, answer: "" };
          setResult(patientState ? bindResultToPatientReport(initial, patientState) : initial);
        }
        if (event.type === "token") setStreamText("Generating a cited answer and checking its sources…");
        if (event.type === "result") {
          const recovered = patientState ? event.result as Result : recoverCitedAnswer(event.result as Result);
          const patientResult = patientState ? bindResultToPatientReport(recovered, patientState) : recovered;
          finalResult.value = patientResult; setResult(patientResult); setStreamText("");
        }
        if (event.type === "error") throw new Error(`Answer generation failed (${event.detail}).`);
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) { handleBlock(buffer.slice(0, split)); buffer = buffer.slice(split + 2); split = buffer.indexOf("\n\n"); }
        if (done) break;
      }
      if (buffer.trim()) handleBlock(buffer);
      if (!finalResult.value) throw new Error("The graph search ended before returning a final answer.");
      setPositions({}); setLayoutReset((v) => v + 1); setScale(1); setPan({ x: 0, y: 0 });
    } catch (err) { setError(err instanceof Error ? err.message : "Graph search failed."); }
    finally { setBusy(false); }
  }, [patientState]);

  useEffect(() => {
    if (!patientId || !patientState) return;
    const conditions = Array.isArray(patientState.conditions) ? patientState.conditions.filter((x): x is string => typeof x === "string") : [];
    const query = conditions.length ? `What retrieved evidence connects to ${conditions.join(", ")}?` : "What clinical evidence is available in this uploaded report?";
    if (lastAutoQuery.current === `${refreshKey}:${query}`) return;
    lastAutoQuery.current = `${refreshKey}:${query}`;
    setQuestion(query); void submit(query);
  }, [patientId, patientState, refreshKey, submit]);

  const graphNodes = result?.graph.nodes ?? EMPTY_NODES;
  const graphEdges = result?.graph.edges ?? EMPTY_EDGES;
  const visibleIds = useMemo(() => new Set(graphNodes.filter((n) => enabled.has(n.type) && (!search || n.label.toLowerCase().includes(search.toLowerCase()))).map((n) => n.id)), [graphNodes, enabled, search]);
  const nodeById = useMemo(() => new Map(graphNodes.map((n) => [n.id, n])), [graphNodes]);

  useEffect(() => {
    if (!graphNodes.length) { setPositions({}); return; }
    setPositions((old) => graphNodes.every((n) => old[n.id]) ? old : runLayout(graphNodes, graphEdges, old));
  }, [graphNodes, graphEdges, layoutReset]);

  useEffect(() => { posRef.current = positions; }, [positions]);
  hoverActive.current = hovered !== null;

  // Live physics: springs keep the structure, collisions keep nodes apart, a gentle drift keeps it floating.
  useEffect(() => {
    if (!graphNodes.length) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const vel: Record<string, Pos> = {};
    const hubIds = new Set(graphNodes.filter((n) => n.type === "Disease").map((n) => n.id));
    const rad = new Map(graphNodes.map((n) => [n.id, radiusOf(n)]));
    const deg = new Map<string, number>();
    graphEdges.forEach((e) => { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); });
    let raf = 0, last = 0, t = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 24 || document.hidden) return;
      last = now; t += 0.032;
      const pos = posRef.current;
      const ids = graphNodes.map((n) => n.id).filter((id) => pos[id]);
      if (!ids.length) return;
      const f: Record<string, Pos> = {};
      ids.forEach((id) => { f[id] = { x: 0, y: 0 }; if (!vel[id]) vel[id] = { x: 0, y: 0 }; });
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = pos[ids[i]], b = pos[ids[j]];
        const dx = a.x - b.x || 0.1, dy = a.y - b.y || 0.1;
        const d2 = Math.max(dx * dx + dy * dy, 50), d = Math.sqrt(d2), s2 = 14000 / d2;
        f[ids[i]].x += (dx / d) * s2; f[ids[i]].y += (dy / d) * s2;
        f[ids[j]].x -= (dx / d) * s2; f[ids[j]].y -= (dy / d) * s2;
        const min = rad.get(ids[i])! + rad.get(ids[j])! + 34;
        if (d < min) { const k = (min - d) * 0.6; f[ids[i]].x += (dx / d) * k; f[ids[i]].y += (dy / d) * k; f[ids[j]].x -= (dx / d) * k; f[ids[j]].y -= (dy / d) * k; }
      }
      graphEdges.forEach((e) => {
        const a = pos[e.source], b = pos[e.target]; if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const rest = hubIds.has(e.source) && hubIds.has(e.target) ? 300 : 210, k = (d - rest) * 0.04;
        f[e.source].x += (dx / d) * k; f[e.source].y += (dy / d) * k;
        f[e.target].x -= (dx / d) * k; f[e.target].y -= (dy / d) * k;
      });
      const drag = dragRef.current, amp = reduce ? 0 : hoverActive.current ? 0.1 : 0.5;
      const next: Record<string, Pos> = { ...pos };
      let moved = false;
      ids.forEach((id, i) => {
        if (drag && drag.id === id) { next[id] = { x: drag.x, y: drag.y }; vel[id] = { x: 0, y: 0 }; moved = true; return; }
        const mass = 1 + (deg.get(id) ?? 0) * 0.35, p = pos[id], v = vel[id];
        const fx = f[id].x + (W / 2 - p.x) * 0.003 + Math.sin(t * 0.7 + i * 1.9) * amp * mass;
        const fy = f[id].y + (H / 2 - p.y) * 0.003 + Math.cos(t * 0.6 + i * 2.3) * amp * mass;
        v.x = clamp((v.x + (fx / mass) * 0.9) * 0.8, -8, 8); v.y = clamp((v.y + (fy / mass) * 0.9) * 0.8, -8, 8);
        if (Math.abs(v.x) + Math.abs(v.y) > 0.01) { next[id] = { x: p.x + v.x, y: p.y + v.y }; moved = true; }
      });
      if (moved) { posRef.current = next; setPositions(next); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [graphNodes, graphEdges]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    const opener = openBtnRef.current;
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; opener?.focus(); };
  }, [open]);

  const citationItems = (ids: number[]) => ids.map((id) => result?.citations.find((c) => c.id === id)).filter((x): x is Citation => !!x);
  const answerCitationIds = useMemo(() => new Set((result?.answer.match(/\[(\d+)\]/g) ?? []).map((s) => Number(s.slice(1, -1)))), [result?.answer]);
  const usedInAnswer = (item: Node | Edge) => (item.citation_ids ?? []).some((id) => answerCitationIds.has(id));
  const setItemCitations = (item: Node | Edge) => {
    const ids = item.citation_ids ?? [];
    const cited = ids.filter((id) => answerCitationIds.has(id));
    setHoverCitations(new Set(cited.length ? cited : ids));
  };
  const clearHover = () => { setHovered(null); setHoverCitations(new Set()); };
  const showTooltip = (kind: "node" | "edge", id: string, event: { clientX: number; clientY: number }) => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered({ kind, id, x: event.clientX, y: event.clientY }); };
  const scheduleTooltipHide = () => { hoverTimer.current = setTimeout(clearHover, 130); };
  const keepTooltipOpen = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  const focusTooltip = (kind: "node" | "edge", id: string, target: { getBoundingClientRect: () => DOMRect }) => {
    const rect = target.getBoundingClientRect();
    setHovered({ kind, id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  const onSubmit = (event: FormEvent) => { event.preventDefault(); void submit(question); };
  const beginPan = (event: PointerEvent<SVGSVGElement>) => { if (event.target === event.currentTarget) { setPanDrag({ x: event.clientX - pan.x, y: event.clientY - pan.y }); event.currentTarget.setPointerCapture(event.pointerId); } };
  const movePan = (event: PointerEvent<SVGSVGElement>) => { if (panDrag) setPan({ x: event.clientX - panDrag.x, y: event.clientY - panDrag.y }); };

  const nodeDown = (id: string, event: PointerEvent<SVGGElement>) => {
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement, origin = positions[id];
    if (!svg || !origin) return;
    dragMoved.current = false;
    const toWorld = (cx: number, cy: number) => {
      const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
      const m = svg.getScreenCTM(); if (!m) return null;
      const q = pt.matrixTransform(m.inverse());
      return { x: (q.x - pan.x) / scale, y: (q.y - pan.y) / scale };
    };
    const start = toWorld(event.clientX, event.clientY); if (!start) return;
    const sx = event.clientX, sy = event.clientY;
    const move = (ev: globalThis.PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) { dragMoved.current = true; }
      const w = toWorld(ev.clientX, ev.clientY); if (!w) return;
      if (dragMoved.current) dragRef.current = { id, x: origin.x + (w.x - start.x), y: origin.y + (w.y - start.y) };
    };
    const up = () => { window.removeEventListener("pointermove", move); dragRef.current = null; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  };

  const openNode = async (node: Node) => {
    if (dragMoved.current) return;
    setPinnedNodeId(node.id);
    try {
      const response = await fetch(`${API}/api/graph-rag/node/${encodeURIComponent(node.id)}`, { cache: "no-store" });
      const data = await response.json();
      setDrawer({ node, chunks: data.chunks ?? node.provenance.map((p) => ({ provenance: p, text: p.snippet })) });
    } catch { setDrawer({ node, chunks: node.provenance.map((p) => ({ provenance: p, text: p.snippet })) }); }
  };

  const expandNode = async (node: Node) => {
    try {
      const response = await fetch(`${API}/api/graph-rag/node/${encodeURIComponent(node.id)}/neighbors`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      setResult((old) => {
        if (!old) return old;
        const citations = [...old.citations];
        const idsFor = (provenance: Provenance[] = []) => provenance.map((p) => {
          let item = citations.find((c) => c.source_title === p.source_title && c.chunk_id === p.chunk_id);
          if (!item) { item = { id: citations.length + 1, ...p }; citations.push(item); }
          return item.id;
        });
        const nodes = (data.nodes as Node[]).map((n) => ({ ...n, citation_ids: idsFor(n.provenance ?? []) }));
        const edges = (data.edges as Edge[]).map((e) => ({ ...e, citation_ids: idsFor(e.provenance ?? []) }));
        return { ...old, citations, graph: { nodes: [...new Map([...old.graph.nodes, ...nodes].map((n): [string, Node] => [n.id, n])).values()], edges: [...new Map([...old.graph.edges, ...edges].map((e): [string, Edge] => [e.id, e])).values()] } };
      });
    } catch { /* keep current subgraph */ }
  };

  const ingestFile = async (file?: File) => {
    if (!file) return;
    const data = new FormData(); data.append("file", file); data.append("source_title", file.name.replace(/\.[^.]+$/, "")); data.append("source_url", sourceUrl);
    setIngestBusy(true); setIngestNotice(""); setError("");
    try {
      const response = await fetch(`${API}/api/graph-rag/ingest`, { method: "POST", body: data });
      const body = await response.json(); if (!response.ok) throw new Error(body.detail || "Reference ingestion failed.");
      setIngestNotice(`Indexed ${body.chunks_indexed} chunks and extracted ${body.triples_added} supported relationships.`);
      if (question.trim()) void submit(question);
    } catch (err) { setError(err instanceof Error ? err.message : "Reference ingestion failed."); }
    finally { setIngestBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const answerParts = (result?.answer ?? "").split(/(\[\d+\])/g);
  const active = hovered ? (hovered.kind === "node" ? nodeById.get(hovered.id) : graphEdges.find((e) => e.id === hovered.id)) : null;
  const tooltipProvenance = active ? citationItems(active.citation_ids) : [];
  const citedActiveIds = active ? active.citation_ids.filter((id) => answerCitationIds.has(id)) : [];
  const focusId = hovered?.kind === "node" ? hovered.id : null;
  const focusEdge = hovered?.kind === "edge" ? graphEdges.find((e) => e.id === hovered.id) ?? null : null;
  const noAnswer = answerCitationIds.size === 0;
  const degree = new Map<string, number>();
  graphEdges.forEach((e) => degree.set(e.target, (degree.get(e.target) ?? 0) + 1));
  const hits = (item: Node | Edge, set: Set<number>) => (item.citation_ids ?? []).some((id) => set.has(id));
  const nodeRelevant = (n: Node) => chipFilter ? hits(n, chipFilter)
    : focusId ? n.id === focusId || graphEdges.some((e) => (e.source === focusId && e.target === n.id) || (e.target === focusId && e.source === n.id))
    : focusEdge ? n.id === focusEdge.source || n.id === focusEdge.target
    : noAnswer || usedInAnswer(n);
  const edgeRelevant = (e: Edge) => chipFilter ? hits(e, chipFilter)
    : focusId ? e.source === focusId || e.target === focusId
    : focusEdge ? e.id === focusEdge.id
    : noAnswer || usedInAnswer(e);
  const pickChip = (n: number) => { setHoverCitations(new Set([n])); setChipFilter(new Set([n])); };
  const dropChip = () => { setHoverCitations(new Set()); setChipFilter(null); };

  const answerEl = <div className="gg-answer-text">{answerParts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (!match) return <span key={i}>{part}</span>;
    const n = Number(match[1]);
    return <button key={i} type="button" className={`gg-citation-chip ${hoverCitations.has(n) ? "on" : ""}`} onMouseEnter={() => pickChip(n)} onMouseLeave={dropChip} onFocus={() => pickChip(n)} onBlur={dropChip}>[{n}]</button>;
  })}</div>;

  const graphSvg = (wide: boolean) => <svg ref={svgRef} className="gg-canvas" viewBox={wide ? `0 0 ${W} ${H}` : "190 20 620 600"} role="img" aria-label="Interactive retrieved knowledge graph" onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={() => setPanDrag(null)}>
    <defs>
      <marker id="gg-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#8fa3c4" /></marker>
      <linearGradient id="gg-shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".9" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      <radialGradient id="gg-rim"><stop offset=".7" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".28" /></radialGradient>
      {[...new Set(graphNodes.map((n) => colorFor(n.type, n.label)))].map((hex) => <radialGradient key={hex} id={`gg-g-${hex.slice(1)}`} cx="0.35" cy="0.3" r="0.85"><stop offset="0%" stopColor={mix(hex, 255, 0.6)} /><stop offset="45%" stopColor={hex} /><stop offset="100%" stopColor={mix(hex, 0, 0.3)} /></radialGradient>)}
    </defs>
    <g transform={`translate(${pan.x} ${pan.y}) scale(${scale})`}>
      {graphEdges.map((edge) => {
        const a = positions[edge.source], b = positions[edge.target], na = nodeById.get(edge.source), nb = nodeById.get(edge.target);
        if (!a || !b || !na || !nb) return null;
        const shown = visibleIds.has(edge.source) && visibleIds.has(edge.target);
        const relevant = edgeRelevant(edge);
        const hot = (focusId !== null || focusEdge !== null || chipFilter !== null) && relevant;
        const arrow = hot || (degree.get(edge.target) ?? 0) <= 8;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
        const x1 = a.x + ux * radiusOf(na), y1 = a.y + uy * radiusOf(na), x2 = b.x - ux * (radiusOf(nb) + 2), y2 = b.y - uy * (radiusOf(nb) + 2);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        let angle = Math.atan2(dy, dx) * 180 / Math.PI; if (angle > 90 || angle < -90) angle += 180;
        return <g key={edge.id} className={!shown || !relevant ? "dim" : ""} onMouseEnter={(e) => { showTooltip("edge", edge.id, e); setItemCitations(edge); }} onMouseMove={(e) => showTooltip("edge", edge.id, e)} onMouseLeave={scheduleTooltipHide} onFocus={(e) => { focusTooltip("edge", edge.id, e.currentTarget); setItemCitations(edge); }} onBlur={clearHover} tabIndex={0} role="button" aria-label={`${na.label} to ${nb.label}, ${edge.type}`}>
          <line className="gg-edge-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
          <line className={`gg-edge ${hot ? "hot" : ""} ${arrow ? "arrow" : ""}`} style={hot ? undefined : { stroke: colorFor(na.type, na.label), strokeOpacity: 0.5 }} x1={x1} y1={y1} x2={x2} y2={y2} />
          {shown && relevant && <line className="gg-flow" x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: borderFor(na.type, na.label) }} />}
          <text className="gg-edge-label" x={mx} y={my - 3} transform={`rotate(${angle} ${mx} ${my})`}>{edge.type}</text>
        </g>;
      })}
      {graphNodes.map((node, ni) => {
        const p = positions[node.id]; if (!p) return null;
        const shown = visibleIds.has(node.id);
        const relevant = nodeRelevant(node);
        const hot = node.id === focusId || (chipFilter !== null && relevant);
        const r = radiusOf(node), max = node.type === "Disease" ? 11 : 8;
        return <g key={node.id} className={`gg-node ${!relevant ? "dim" : ""} ${hot ? "hot" : ""} ${pinnedNodeId === node.id ? "pinned" : ""}`} transform={`translate(${p.x} ${p.y})`} onPointerDown={(e) => nodeDown(node.id, e)} onMouseEnter={(e) => { showTooltip("node", node.id, e); setItemCitations(node); }} onMouseMove={(e) => showTooltip("node", node.id, e)} onMouseLeave={scheduleTooltipHide} onFocus={(e) => { focusTooltip("node", node.id, e.currentTarget); setItemCitations(node); }} onBlur={clearHover} onClick={() => void openNode(node)} onDoubleClick={() => void expandNode(node)} tabIndex={0} role="button" aria-label={`${node.label}, ${node.type}. Double-click to expand neighbors.`} style={{ opacity: shown ? undefined : 0.12 }}>
          <g className="gg-inner">
            <circle className="gg-halo" r={r + (node.type === "Disease" ? 12 : 8)} fill={colorFor(node.type, node.label)} style={{ animationDelay: `${-(ni % 6) * 0.5}s` }} />
            <circle className="gg-body" r={r} fill={`url(#gg-g-${colorFor(node.type, node.label).slice(1)})`} stroke={borderFor(node.type, node.label)} />
            <circle r={r} fill="url(#gg-rim)" pointerEvents="none" />
            <ellipse cx={-r * 0.28} cy={-r * 0.5} rx={r * 0.5} ry={r * 0.26} fill="url(#gg-shine)" pointerEvents="none" />
            <text y={4} style={LIGHT.has(node.type) ? { fill: "#1c2733", stroke: "none" } : undefined}>{node.label.length > max ? `${node.label.slice(0, max - 1)}…` : node.label}</text>{hot && node.label.length > max && <text className="gg-full" y={r + 17}>{node.label}</text>}
          </g>
        </g>;
      })}
    </g>
  </svg>;

  const sidePanel = result && <aside className="gg-side">
    <h3>Evidence-grounded answer</h3>
    {result.model && <p className="gg-small" role="status">{result.generation_status === "ollama" ? "Generated by " : "Fallback answer; model generation did not complete. Configured model: "}{result.model}</p>}
    {streamText && <p role="status" className="gg-small">{streamText}</p>}
    {answerEl}
    <p className="gg-disclaimer">{result.disclaimer}</p>
    {drawer && <section className="gg-pinned">
      <div className="gg-drawer-head"><div><h3>{drawer.node.label}</h3><span className="gg-badge" style={{ background: colorFor(drawer.node.type, drawer.node.label) }}>{drawer.node.type.replace("_", " ")}</span></div><button className="gg-tool" type="button" aria-label="Close details" onClick={() => { setDrawer(null); setPinnedNodeId(null); }}><X size={14} /></button></div>
      {drawer.chunks.map((chunk, i) => <article className="gg-chunk" key={`${chunk.provenance.chunk_id}-${i}`}><strong>{chunk.provenance.source_title}</strong><div className="gg-small">{chunk.provenance.page ? `Page ${chunk.provenance.page} · ` : ""}confidence {Math.round(chunk.provenance.confidence * 100)}%</div><p>{chunk.text}</p>{chunk.provenance.source_url && <a className="gg-tip-link" href={chunk.provenance.source_url} target="_blank" rel="noreferrer">Open source</a>}</article>)}
    </section>}
    <h3 className="gg-sub">Retrieved citations ({result.citations.length})</h3>
    {result.citations.map((c) => <div key={c.id} className="gg-citation-row" onMouseEnter={() => pickChip(c.id)} onMouseLeave={dropChip}><strong>[{c.id}] {c.source_title || "Clinical source"}</strong>{c.page ? ` · page ${c.page}` : ""}{c.source_url && <><br /><a href={c.source_url} target="_blank" rel="noreferrer">Open source <ExternalLink size={9} style={{ verticalAlign: "middle" }} /></a></>}</div>)}
  </aside>;

  const workspace = (big: boolean) => result && <div className={`gg-work ${big ? "big" : ""}`}>
    <div className="gg-tools">
      <input className="gg-search" aria-label="Search graph nodes" placeholder="Find a node…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="gg-float-controls">
        <button className="gg-tool" type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}><ZoomOut size={14} /></button>
        <button className="gg-tool" type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)}><ZoomIn size={14} /></button>
        <button className="gg-tool" type="button" aria-label="Reset layout" onClick={resetLayout}><RotateCcw size={13} /></button>
      </div>
    </div>
    <div className="gg-legend">{TYPES.map((type) => <button type="button" key={type} className={!enabled.has(type) ? "off" : ""} onClick={() => setEnabled((old) => { const next = new Set(old); if (next.has(type)) next.delete(type); else next.add(type); return next; })}><span className="gg-dot" style={{ background: COLORS[type] }} />{type.replace("_", " ")}</button>)}</div>
    <div className="gg-main">{graphNodes.length ? graphSvg(true) : <div className="gg-empty gg-nograph">{busy ? "Building graph…" : "No graph to show: no linked condition, symptom or test was found in this report."}</div>}{sidePanel}</div>
    <p className="gg-footer">{graphNodes.length} nodes · {graphEdges.length} directed relationships · Hover or focus for source evidence; click a node for full chunks; double-click to expand; drag to rearrange.</p>
  </div>;

  const tooltipEl = hovered && active && <div className="gg-tooltip" style={tooltipPos(hovered.x, hovered.y)} onMouseEnter={keepTooltipOpen} onMouseLeave={clearHover}>
    <div className="gg-tip-head">{hovered.kind === "edge" ? `${nodeById.get((active as Edge).source)?.label} → ${nodeById.get((active as Edge).target)?.label}` : (active as Node).label}<span className="gg-badge" style={{ background: hovered.kind === "edge" ? "#64748B" : colorFor((active as Node).type, (active as Node).label) }}>{(hovered.kind === "edge" ? (active as Edge).type : (active as Node).type).replace("_", " ")}</span></div>
    {tooltipProvenance.map((p, i) => <div key={i}><div className="gg-tip-meta">{p.source_title}{p.page ? ` · page ${p.page}` : ""} · {citedActiveIds.length ? "Cited in answer as " : "Retrieved citation "}{(citedActiveIds.length ? citedActiveIds : active.citation_ids ?? []).map((id) => `[${id}]`).join(", ")}</div><div className="gg-tip-snippet">{p.snippet}</div><div className="gg-confidence"><span style={{ width: `${Math.round(p.confidence * 100)}%` }} /></div>{p.source_url && <a className="gg-tip-link" href={p.source_url} target="_blank" rel="noreferrer">Open source</a>}</div>)}
    <span className="gg-small">Click the node to pin its full citations</span>
  </div>;

  const styles = <style>{`
    .graphrag{--ink:#14284b;--muted:#6b7f9c;--brand:#4f7cff;--brand2:#7a5cff;--line:#e3ebfa;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:linear-gradient(180deg,#f9fbff,#eef3ff);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 12px 40px rgba(60,90,160,.09);min-width:0}
    .graphrag.compact{padding:14px;border-radius:16px}
    .gg-head{display:flex;align-items:flex-start;gap:13px}.gg-icon{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;display:grid;place-items:center;flex:0 0 auto;box-shadow:0 6px 16px rgba(79,124,255,.35)}.compact .gg-icon{width:34px;height:34px;border-radius:11px}
    .gg-head h2{font-size:20px;margin:0 0 5px;letter-spacing:-.03em;font-weight:800}.compact .gg-head h2{font-size:14px;margin:0}.gg-head p{font-size:12px;color:var(--muted);margin:0;line-height:1.5}
    .gg-query{display:flex;gap:8px;margin:18px 0 10px}.gg-query input,.gg-search{border:1px solid #d9e4f7;background:rgba(255,255,255,.9);border-radius:12px;padding:11px 13px;font:inherit;font-size:13px;min-width:0;outline:none;transition:border-color .15s,box-shadow .15s}.gg-query input{flex:1}.gg-query input:focus,.gg-search:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(79,124,255,.15)}
    .gg-button{border:0;border-radius:12px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;padding:0 17px;min-height:40px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:7px;box-shadow:0 6px 16px rgba(79,124,255,.3);transition:transform .15s,box-shadow .15s}.gg-button:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(79,124,255,.4)}.gg-button:disabled{opacity:.55;cursor:wait;transform:none}.gg-button.wide{width:100%;margin-top:12px}
    .gg-suggestions{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px}.gg-suggestion{border:1px solid #d9e4f7;border-radius:999px;padding:6px 11px;background:#fff;color:#4f6a90;font-size:11px;cursor:pointer;transition:all .15s}.gg-suggestion:hover{border-color:var(--brand);color:var(--brand);transform:translateY(-1px)}
    .gg-card-body{margin-top:12px;border:1px solid var(--line);background:#fff;border-radius:14px;padding:13px}.gg-answer-text{font-size:12.5px;line-height:1.75;white-space:pre-wrap}.gg-meta{font-size:10px;color:var(--muted);margin:10px 0 0}
    .gg-citation-chip{display:inline;border:0;background:#e8efff;color:#3a62d8;border-radius:6px;padding:1px 5px;font-size:10px;font-weight:800;cursor:pointer;transition:all .15s}.gg-citation-chip.on{background:#ffd976;color:#6b4300;box-shadow:0 0 0 3px rgba(255,201,77,.45)}
    .gg-citation-row{border-top:1px solid #edf1fa;padding:9px 0;font-size:10.5px;color:#5f7391;line-height:1.5}.gg-citation-row a{color:var(--brand)}.gg-disclaimer{margin:12px 0 0;border-left:3px solid var(--brand);background:linear-gradient(90deg,#eef3ff,#f7f9ff);padding:9px 11px;color:#5a6f8f;font-size:10.5px;line-height:1.55;border-radius:0 8px 8px 0}
    .gg-ingest-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:14px 0 4px}.gg-ingest-row .gg-search{flex:1;min-width:180px;padding:8px 10px;font-size:11px}.gg-ingest-row input[type=file]{display:none}
    .gg-work{margin-top:14px;display:flex;flex-direction:column;min-width:0}.gg-tools{display:flex;align-items:center;gap:6px;margin-bottom:9px}.gg-search{flex:1;min-width:120px;padding:8px 11px;font-size:11px}.gg-float-controls{display:flex;gap:5px}
    .gg-tool{border:1px solid #d9e4f7;background:#fff;color:#4f6a90;border-radius:10px;padding:7px 8px;display:inline-flex;align-items:center;justify-content:center;gap:5px;font:inherit;font-size:11px;cursor:pointer;transition:all .15s}.gg-tool:hover{border-color:var(--brand);color:var(--brand);box-shadow:0 3px 10px rgba(79,124,255,.15)}
    .gg-legend{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 11px}.gg-legend button{display:flex;gap:6px;align-items:center;border:1px solid #e1e9f7;border-radius:999px;background:#fff;padding:5px 11px;font-size:10.5px;font-weight:600;color:#5a6f8f;cursor:pointer;transition:all .15s}.gg-legend button:hover{transform:translateY(-1px);box-shadow:0 3px 10px rgba(60,90,160,.1)}.gg-legend button.off{opacity:.35}.gg-dot{width:9px;height:9px;border-radius:50%;box-shadow:inset -1px -1px 2px rgba(0,0,0,.2),0 0 0 2px rgba(255,255,255,.8)}
    .gg-main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;height:72vh;min-height:440px}.gg-work.big .gg-main{height:calc(100vh - 190px)}
    .gg-canvas{width:100%;height:100%;border-radius:18px;background:#fff;border:1px solid #e3e9f3;box-shadow:0 2px 14px rgba(40,70,120,.06);touch-action:none;min-height:0}
    .gg-side{overflow:auto;border:1px solid var(--line);background:rgba(255,255,255,.92);border-radius:18px;padding:15px;min-height:0}.gg-side h3{font-size:12px;margin:0 0 8px;font-weight:800}.gg-side .gg-sub{margin-top:16px}
    .gg-pinned{margin-top:14px;border:1px solid #cddcfb;background:#f6f9ff;border-radius:14px;padding:12px}.gg-drawer-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    .gg-chunk{border:1px solid #e1e9f7;background:#fff;border-radius:11px;padding:10px;margin-top:10px}.gg-chunk p{font-size:11px;line-height:1.65;white-space:pre-wrap;color:#43576d;margin:6px 0}
    .gg-edge{stroke:#a9b8d4;stroke-width:1.4;fill:none;stroke-linecap:round;transition:opacity .15s,stroke .15s;pointer-events:none}.gg-edge.arrow{marker-end:url(#gg-arrow)}.gg-edge.hot{stroke:#3b82f6;stroke-opacity:1;stroke-width:2.8;stroke-dasharray:7 5;animation:ggflow .9s linear infinite}@keyframes ggflow{to{stroke-dashoffset:-12}}@media(prefers-reduced-motion:reduce){.gg-edge.hot{animation:none}}.gg-edge-hit{stroke:transparent;stroke-width:12;cursor:pointer}
    .gg-edge-label{font-size:10px;font-weight:600;fill:#6b7f9c;paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round;text-anchor:middle;pointer-events:none}
    .gg-node .gg-body{stroke-width:1.5;filter:drop-shadow(0 4px 6px rgba(30,50,90,.28));cursor:grab}.gg-node:active .gg-body{cursor:grabbing}
    .gg-node text{fill:#fff;font-size:12px;font-weight:800;text-anchor:middle;pointer-events:none;paint-order:stroke;stroke:rgba(15,25,40,.4);stroke-width:2.2px;stroke-linejoin:round}.gg-node text.gg-full{fill:#17304d;stroke:#fff;stroke-width:4px}
    .gg-inner{transform-origin:0 0;transition:transform .3s cubic-bezier(.3,1.6,.5,1)}
    .gg-node:hover .gg-inner,.gg-node.hot .gg-inner{transform:scale(1.18)}
    .gg-halo{opacity:.16;transform-origin:0 0;animation:ggpulse 3s ease-in-out infinite;pointer-events:none}
    @keyframes ggpulse{50%{opacity:.34;transform:scale(1.15)}}
    @media(prefers-reduced-motion:reduce){.gg-halo{animation:none}}
    .gg-node.hot .gg-body,.gg-node.pinned .gg-body{stroke:#fff!important;stroke-width:3;filter:drop-shadow(0 0 10px rgba(79,124,255,.75))}
    .gg-node.dim,.gg-edge.dim,g.dim{opacity:.18}.gg-node:focus{outline:none}.gg-node:focus .gg-body{stroke:#1e3a8a!important;stroke-width:3.5}
    .gg-tooltip{position:fixed;z-index:1300;width:min(320px,calc(100vw - 24px));max-height:calc(100vh - 16px);overflow:auto;background:rgba(255,255,255,.96);backdrop-filter:blur(10px);border:1px solid #dbe6f8;border-radius:15px;box-shadow:0 16px 44px rgba(30,55,110,.22);padding:13px;opacity:0;transform:translateY(4px);animation:ggfade .12s ease forwards;color:var(--ink)}
    .gg-tip-head{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;font-weight:800}.gg-badge{padding:3px 8px;border-radius:999px;color:#fff;font-size:9px;font-weight:700;white-space:nowrap;display:inline-block}
    .gg-tip-meta{font-size:10px;color:#718096;margin:8px 0 4px}.gg-tip-snippet{font-size:10px;line-height:1.5;color:#40556b;background:#f2f6fd;padding:8px;border-radius:9px}
    .gg-confidence{height:5px;background:#e6edf8;border-radius:99px;margin:8px 0;overflow:hidden}.gg-confidence span{display:block;height:100%;background:linear-gradient(90deg,#27c99a,#4f8cff)}.gg-tip-link{font-size:10px;color:var(--brand)}
    .gg-empty{padding:22px 12px;text-align:center;color:#7b8da0;font-size:12px}.gg-error{color:#b42318;background:#fff2f0;padding:9px 11px;border-radius:10px;font-size:11px}.gg-notice{color:#166b4b;background:#edfaf3;padding:8px 10px;border-radius:9px;font-size:10px}
    .gg-small{font-size:10px;color:#718096}.gg-footer{font-size:10px;color:#8a9aab;margin:9px 0 0}
    .gg-overlay{position:fixed;inset:0;z-index:1100;background:rgba(15,30,60,.55);backdrop-filter:blur(4px);display:grid;place-items:center;padding:3vh 3vw}
    .gg-modal{width:100%;max-width:1500px;height:100%;max-height:94vh;overflow:hidden;display:flex;flex-direction:column;padding:16px 18px}.gg-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.gg-modal-head h2{font-size:16px;margin:0}
    .gg-flow{stroke-width:2.2;stroke-linecap:round;stroke-dasharray:1 16;animation:ggdash 1.4s linear infinite;pointer-events:none;opacity:.9}@keyframes ggdash{to{stroke-dashoffset:-34}}@media(prefers-reduced-motion:reduce){.gg-flow{animation:none}}
    .gg-compact-canvas{width:100%;aspect-ratio:620/600;max-height:68vh;margin-top:12px}.gg-compact-canvas .gg-canvas{height:100%;border-radius:16px}.compact .gg-head{align-items:center}.gg-expand{margin-left:auto}
    .gg-clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
    .gg-nograph{min-height:200px;display:grid;place-items:center;background:#fff;border:1px dashed #d9e4f7;border-radius:16px;margin-top:12px}
    @keyframes ggfade{to{opacity:1;transform:translateY(0)}}
    @media(max-width:900px){.gg-main{grid-template-columns:1fr;grid-template-rows:55vh auto;height:auto}.gg-work.big .gg-main{height:auto;overflow:auto}.gg-modal{overflow:auto}}
    @media(max-width:560px){.graphrag{padding:14px}.gg-query{flex-wrap:wrap}.gg-query input{flex-basis:100%}.gg-query .gg-button{padding:10px 14px}}
  `}</style>;

  const modal = open && typeof document !== "undefined" && createPortal(
    <div className="gg-overlay" onClick={() => setOpen(false)}>
      <div className="graphrag gg-modal" role="dialog" aria-modal="true" aria-label="Medical knowledge graph" onClick={(e) => e.stopPropagation()}>
        <div className="gg-modal-head"><h2>Medical knowledge graph</h2><button ref={closeBtnRef} className="gg-tool" type="button" aria-label="Close knowledge graph" onClick={() => setOpen(false)}><X size={16} /> Close</button></div>
        {workspace(true)}
      </div>
    </div>, document.body);

  if (compact) {
    return <section className="graphrag compact">
      {styles}
      <div className="gg-head"><div className="gg-icon"><Network size={18} /></div><div><h2>Evidence graph</h2></div>{result && graphNodes.length > 0 && <button ref={openBtnRef} type="button" className="gg-tool gg-expand" aria-label="Expand knowledge graph" onClick={() => setOpen(true)}><Maximize2 size={14} /></button>}</div>
      {error && <p className="gg-error" role="alert">{error}</p>}
      {result ? <>
        {graphNodes.length ? <div className="gg-compact-canvas">{graphSvg(false)}</div> : <div className="gg-empty gg-nograph">{busy ? "Building graph…" : "No graph to show: no linked condition, symptom or test was found in this report."}</div>}
        <div className="gg-card-body">
          {result.model && <p className="gg-small" role="status">{result.generation_status === "ollama" ? "Generated by " : "Fallback answer; model generation did not complete. Configured model: "}{result.model}</p>}
          {streamText && <p role="status" className="gg-small">{streamText}</p>}
          <div className="gg-clamp">{answerEl}</div>
          <p className="gg-disclaimer">{result.disclaimer}</p>
          <p className="gg-meta">{graphNodes.length} nodes · {graphEdges.length} relationships · {result.citations.length} citations · hover a node for its label and evidence</p>
        </div>
      </> : <div className="gg-empty">{busy ? "Preparing evidence graph…" : patientId ? `Preparing evidence graph for ${patientId}…` : "No graph yet."}</div>}
      {modal}{tooltipEl}
    </section>;
  }

  return <section className="graphrag">
    {styles}
    <div className="gg-head"><div className="gg-icon"><Network size={22} /></div><div><h2>Medical Knowledge Graph RAG</h2><p>Ask a question to retrieve connected clinical facts and their source passages.</p></div></div>
    <form className="gg-query" onSubmit={onSubmit}><input aria-label="Ask a medical evidence question" placeholder="e.g. Which drugs treat Type 2 Diabetes and how is it diagnosed?" value={question} onChange={(e) => setQuestion(e.target.value)} /><button className="gg-button" disabled={busy}>{busy ? "Retrieving…" : "Ask graph"}</button></form>
    {!result && <div className="gg-suggestions">{["Which drugs treat Type 2 Diabetes?", "How is diabetes diagnosed?", "What mechanisms are linked to Type 2 Diabetes?"].map((q) => <button type="button" className="gg-suggestion" key={q} onClick={() => { setQuestion(q); void submit(q); }}>{q}</button>)}</div>}
    {error && <p className="gg-error" role="alert">{error}</p>}{ingestNotice && <p className="gg-notice" role="status">{ingestNotice}</p>}
    <div className="gg-ingest-row">
      <input className="gg-search" aria-label="Reference source URL for next ingestion" placeholder="Optional source URL for the next reference" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
      <input ref={fileRef} type="file" accept=".pdf,.md,.markdown,.txt" onChange={(e) => void ingestFile(e.target.files?.[0])} />
      <button type="button" className="gg-tool" disabled={ingestBusy} onClick={() => fileRef.current?.click()} title="Ingest a guideline, drug monograph, or reference">{ingestBusy ? <LoaderCircle className="omni-spin" size={13} /> : <UploadCloud size={13} />} Ingest reference</button>
    </div>
    {workspace(false)}
    {!result && !busy && patientId && <div className="gg-empty">Preparing evidence graph for {patientId}…</div>}
    {tooltipEl}
  </section>;
}
