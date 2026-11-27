"""Traceable JSON-backed clinical knowledge graph and hybrid GraphRAG helpers."""
from __future__ import annotations

import hashlib
import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from app.core.config import DATA_DIR

STORE = DATA_DIR / "knowledge_graph.json"
NODE_TYPES = {"Disease", "Drug", "Test_Items", "Symptom", "Anatomy", "Pathogenesis", "Mechanism"}
EDGE_TYPES = {"Drug_Disease", "Test_Items_Disease", "Symptom_Disease", "Anatomy_Disease", "Pathogenesis_Disease", "Subtype_Of"}
ALIASES = {"t2dm": "Type 2 Diabetes", "type ii diabetes": "Type 2 Diabetes", "type 2 diabetes mellitus": "Type 2 Diabetes", "hba1c": "HbA1c", "glyburide": "Glyburide", "glibenclamide": "Glyburide", "blood glucose": "Fasting Blood Glucose"}


def _key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def _stable(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


_ENTITY_EMBEDDINGS: dict[str, list[float]] = {}


def _similar_entity(name: str, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Use the app's sentence embedding model as a conservative dedupe fallback."""
    if not candidates:
        return None
    try:
        from app.services.evidence.vector_store import embed_texts
        labels = [name, *(n["label"] for n in candidates)]
        missing = [label for label in labels if label not in _ENTITY_EMBEDDINGS]
        if missing:
            vectors = embed_texts(missing)
            _ENTITY_EMBEDDINGS.update(zip(missing, vectors))
        query = _ENTITY_EMBEDDINGS[name]
        best, score = None, 0.0
        for candidate in candidates:
            vector = _ENTITY_EMBEDDINGS[candidate["label"]]
            similarity = sum(a * b for a, b in zip(query, vector))
            if similarity > score:
                best, score = candidate, similarity
        return best if score >= .93 else None
    except Exception:
        return None


def canonical_name(name: str) -> str:
    name = " ".join(name.strip().split())
    return ALIASES.get(_key(name), name)


def load_store() -> dict[str, Any]:
    if not STORE.exists():
        return {"nodes": {}, "edges": {}, "chunks": {}}
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
        return {key: data.get(key, {}) for key in ("nodes", "edges", "chunks")}
    except (OSError, json.JSONDecodeError):
        return {"nodes": {}, "edges": {}, "chunks": {}}


def save_store(store: dict[str, Any]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STORE.with_suffix(".tmp")
    temporary.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(STORE)


def _node(store: dict[str, Any], name: str, kind: str, provenance: dict[str, Any]) -> str:
    label = canonical_name(name)
    # Conservative lexical dedupe; synonym normalization is explicit above.
    candidates = [n for n in store["nodes"].values() if n["type"] == kind]
    match = next((n for n in candidates if _key(n["label"]) == _key(label)), None)
    if not match:
        match = next((n for n in candidates if SequenceMatcher(None, _key(n["label"]), _key(label)).ratio() >= .94), None)
    if not match:
        match = _similar_entity(label, candidates)
    node_id = match["id"] if match else f"{kind.lower()}:{_stable(kind, _key(label))}"
    current = store["nodes"].setdefault(node_id, {"id": node_id, "label": label, "name": label, "type": kind, "provenance": []})
    if provenance not in current["provenance"]:
        current["provenance"].append(provenance)
    return node_id


def add_fact(store: dict[str, Any], subject: str, subject_type: str, relation: str, object_: str, object_type: str, provenance: dict[str, Any]) -> tuple[str, str, str]:
    if subject_type not in NODE_TYPES or object_type not in NODE_TYPES or relation not in EDGE_TYPES:
        raise ValueError("Unsupported graph node or relationship type")
    if not subject.strip() or not object_.strip() or len(subject) > 160 or len(object_) > 160:
        raise ValueError("Graph entity names must be present and no longer than 160 characters")
    if len(str(provenance.get("snippet", ""))) > 300:
        provenance = {**provenance, "snippet": str(provenance["snippet"])[:300]}
    source = _node(store, subject, subject_type, provenance)
    target = _node(store, object_, object_type, provenance)
    edge_id = f"edge:{_stable(source, relation, target, str(provenance.get('chunk_id', '')))}"
    edge = store["edges"].setdefault(edge_id, {"id": edge_id, "source": source, "target": target, "type": relation, "provenance": []})
    if provenance not in edge["provenance"]:
        edge["provenance"].append(provenance)
    return source, target, edge_id


def provenance(source_id: str, title: str, url: str, page: int | None, chunk_id: str, snippet: str, confidence: float = 1.0) -> dict[str, Any]:
    return {"source_id": source_id, "source_title": title, "source_url": url, "page": page, "chunk_id": chunk_id, "snippet": snippet[:300], "confidence": max(0.0, min(1.0, float(confidence)))}


def query_graph(query: str, text_chunks: list[dict[str, Any]], store: dict[str, Any] | None = None, max_nodes: int = 40) -> dict[str, Any]:
    store = store or load_store()
    q = _key(query)
    seeds = [n for n in store["nodes"].values() if _key(n["label"]) in q or q in _key(n["label"])]
    if not seeds:
        terms = set(q.split())
        seeds = sorted((n for n in store["nodes"].values() if terms & set(_key(n["label"]).split())), key=lambda n: -len(terms & set(_key(n["label"]).split())))[:3]
    if not seeds and store["nodes"]:
        try:
            from app.services.evidence.vector_store import embed_texts
            entries = list(store["nodes"].values())
            vectors = embed_texts([query, *(n["label"] for n in entries)])
            qv = vectors[0]
            ranked = sorted(((sum(a*b for a, b in zip(qv, vec)), n) for n, vec in zip(entries, vectors[1:])), key=lambda item: item[0], reverse=True)
            if ranked and ranked[0][0] >= .64:
                seeds = [n for score, n in ranked[:3] if score >= max(.58, ranked[0][0] - .08)]
        except Exception:
            pass
    selected_nodes = {n["id"] for n in seeds}
    selected_edges: set[str] = set()
    frontier = set(selected_nodes)
    # One hop is preferred; a second hop is limited to direct query matches.
    for depth in range(2):
        next_frontier: set[str] = set()
        candidates = [e for e in store["edges"].values() if e["source"] in frontier or e["target"] in frontier]
        candidates.sort(key=lambda e: 0 if any(_key(store["nodes"].get(i, {}).get("label", "")) in q for i in (e["source"], e["target"])) else 1)
        for edge in candidates:
            if len(selected_nodes) >= max_nodes: break
            selected_edges.add(edge["id"])
            other = edge["target"] if edge["source"] in frontier else edge["source"]
            if other not in selected_nodes:
                selected_nodes.add(other); next_frontier.add(other)
        frontier = next_frontier
        if not frontier: break

    chunks = list(text_chunks[:6])
    citation_map: dict[str, int] = {}
    citations: list[dict[str, Any]] = []
    def citation_id(prov: dict[str, Any]) -> int:
        key = f"{prov.get('source_id')}|{prov.get('chunk_id')}|{prov.get('source_url')}"
        if key not in citation_map:
            idx = len(citations) + 1
            citation_map[key] = idx
            citations.append({"id": idx, **{k: prov.get(k) for k in ("source_id", "source_title", "source_url", "page", "chunk_id", "snippet", "confidence")}})
        return citation_map[key]

    graph_nodes = []
    for node_id in selected_nodes:
        node = store["nodes"][node_id]
        prov = node.get("provenance", [])
        graph_nodes.append({**node, "citation_ids": [citation_id(p) for p in prov]})
    graph_edges = []
    for edge_id in selected_edges:
        edge = store["edges"][edge_id]
        prov = edge.get("provenance", [])
        graph_edges.append({**edge, "citation_ids": [citation_id(p) for p in prov]})
    for chunk in chunks:
        meta = chunk.get("metadata") or {}
        p = provenance(str(chunk.get("document_id", "vector")), str(chunk.get("title", "Clinical reference")), str(chunk.get("url") or meta.get("url") or ""), chunk.get("page"), f"{chunk.get('document_id')}:{chunk.get('chunk_index')}", str(chunk.get("text", ""))[:300], float(chunk.get("score") or .5))
        citation_id(p)
        chunk["citation_id"] = citation_map[f"{p['source_id']}|{p['chunk_id']}|{p['source_url']}"]

    context = []
    for edge in graph_edges:
        for p in edge.get("provenance", []):
            cid = citation_id(p)
            s = store["nodes"].get(edge["source"], {}).get("label", "")
            t = store["nodes"].get(edge["target"], {}).get("label", "")
            context.append(f"[{cid}] {s} —{edge['type']}→ {t}. Source excerpt: {p.get('snippet', '')}")
    for chunk in chunks:
        context.append(f"[{chunk['citation_id']}] {chunk.get('text', '')}")
    return {"citations": citations, "graph": {"nodes": graph_nodes, "edges": graph_edges}, "context": "\n".join(dict.fromkeys(context)), "chunks": chunks}


def detail(node_id: str) -> dict[str, Any] | None:
    store = load_store()
    node = store["nodes"].get(node_id)
    if not node:
        return None
    chunks = [{"provenance": p, "text": store["chunks"].get(p.get("chunk_id"), {}).get("text", p.get("snippet", ""))}
              for p in node.get("provenance", [])]
    return {**node, "chunks": chunks}


def neighbors(node_id: str) -> dict[str, Any]:
    store = load_store()
    edges = [e for e in store["edges"].values() if e["source"] == node_id or e["target"] == node_id]
    ids = {node_id} | {e["source"] for e in edges} | {e["target"] for e in edges}
    return {"nodes": [{**store["nodes"][i], "citation_ids": []} for i in ids if i in store["nodes"]],
            "edges": [{**edge, "citation_ids": []} for edge in edges]}


def seed_demo() -> int:
    """Idempotently seed a compact, cited diabetes graph for the demo."""
    store = load_store()
    drug_url = "https://www.ncbi.nlm.nih.gov/books/NBK482386/"
    test_url = "https://www.niddk.nih.gov/health-information/professionals/clinical-tools-patient-management/diabetes/diabetes-prediabetes"
    mechanism_url = "https://www.niddk.nih.gov/health-information/diabetes/overview/what-is-diabetes/prediabetes-insulin-resistance"
    complications_url = "https://www.ncbi.nlm.nih.gov/books/NBK279509/"
    count = 0
    def fact(subj: str, st: str, rel: str, obj: str, ot: str, src: str, title: str, url: str, text: str, conf: float = .94) -> None:
        nonlocal count
        chunk_id = f"{src}:demo:{_stable(text)}"
        p = provenance(src, title, url, None, chunk_id, text, conf)
        add_fact(store, subj, st, rel, obj, ot, p)
        store["chunks"].setdefault(chunk_id, {"text": text, "provenance": p})
        count += 1

    disease = "Type 2 Diabetes"
    fact("Type 2", "Disease", "Subtype_Of", "Diabetes", "Disease", "ncbi-type2-drugs", "Oral Antidiabetic Medications", drug_url,
         "Oral antidiabetic medications are used in the management of type 2 diabetes.")
    drugs = [
        ("Metformin", "Biguanides: metformin."),
        ("Gliclazide", "Sulfonylureas: glipizide, glyburide, gliclazide, glimepiride."),
        ("Glimepiride", "Sulfonylureas: glipizide, glyburide, gliclazide, glimepiride."),
        ("Glipizide", "Sulfonylureas: glipizide, glyburide, gliclazide, glimepiride."),
        ("Glyburide", "Sulfonylureas: glipizide, glyburide, gliclazide, glimepiride."),
        ("Nateglinide", "Meglitinides (glinides): repaglinide, nateglinide."),
        ("Repaglinide", "Meglitinides (glinides): repaglinide, nateglinide."),
        ("Rosiglitazone", "Thiazolidinediones include pioglitazone and rosiglitazone."),
        ("Pioglitazone", "Thiazolidinediones include pioglitazone and rosiglitazone."),
        ("Tolbutamide", "First generation sulfonylureas include tolbutamide."),
        ("Chlorpropamide", "First generation sulfonylureas include chlorpropamide."),
        ("Tolazamide", "First generation sulfonylureas include tolazamide."),
        ("Acetohexamide", "First generation sulfonylureas include acetohexamide."),
        ("Acarbose", "Alpha-glucosidase inhibitors include acarbose, miglitol, and voglibose."),
        ("Miglitol", "Alpha-glucosidase inhibitors include acarbose, miglitol, and voglibose."),
        ("Voglibose", "Alpha-glucosidase inhibitors include acarbose, miglitol, and voglibose."),
        ("Sitagliptin", "DPP-4 inhibitors include sitagliptin, saxagliptin, linagliptin, and alogliptin."),
        ("Saxagliptin", "DPP-4 inhibitors include sitagliptin, saxagliptin, linagliptin, and alogliptin."),
        ("Linagliptin", "DPP-4 inhibitors include sitagliptin, saxagliptin, linagliptin, and alogliptin."),
        ("Alogliptin", "DPP-4 inhibitors include sitagliptin, saxagliptin, linagliptin, and alogliptin."),
        ("Empagliflozin", "SGLT2 inhibitors include empagliflozin, dapagliflozin, canagliflozin, and ertugliflozin."),
        ("Dapagliflozin", "SGLT2 inhibitors include empagliflozin, dapagliflozin, canagliflozin, and ertugliflozin."),
        ("Canagliflozin", "SGLT2 inhibitors include empagliflozin, dapagliflozin, canagliflozin, and ertugliflozin."),
        ("Ertugliflozin", "SGLT2 inhibitors include empagliflozin, dapagliflozin, canagliflozin, and ertugliflozin."),
    ]
    for name, snippet in drugs:
        fact(name, "Drug", "Drug_Disease", disease, "Disease", "ncbi-type2-drugs", "Oral Antidiabetic Medications", drug_url, snippet)
    tests = [
        ("HbA1c", "The A1C test is used to screen for and diagnose type 2 diabetes; 6.5% or higher should be repeated for confirmation."),
        ("Fasting Blood Glucose", "Fasting plasma glucose is used to screen for and diagnose diabetes; 126 mg/dL or higher should be repeated for confirmation."),
        ("2h Blood Glucose", "The oral glucose tolerance test is used to screen for and diagnose diabetes; 2-hour glucose of 200 mg/dL or higher should be repeated."),
        ("Random Blood Glucose", "Random plasma glucose is used for diagnosis with classic symptoms of hyperglycemia or hyperglycemic crisis; 200 mg/dL or higher."),
    ]
    for name, snippet in tests:
        fact(name, "Test_Items", "Test_Items_Disease", disease, "Disease", "niddk-diagnosis", "Diabetes & Prediabetes Tests", test_url, snippet, .98)
    fact("Insulin Resistance", "Mechanism", "Pathogenesis_Disease", disease, "Disease", "niddk-insulin-resistance", "Insulin Resistance & Prediabetes", mechanism_url,
         "Insulin resistance means that cells in your muscles, fat, and liver don’t respond well to insulin.", .93)
    fact("Decline in Insulin Secretion", "Pathogenesis", "Pathogenesis_Disease", disease, "Disease", "niddk-insulin-resistance", "Insulin Resistance & Prediabetes", mechanism_url,
         "Over time, the pancreas may not make enough insulin to help extra glucose enter cells.", .92)
    fact("Poorer Insulin Secretion", "Pathogenesis", "Pathogenesis_Disease", disease, "Disease", "niddk-insulin-resistance", "Insulin Resistance & Prediabetes", mechanism_url,
         "Over time, the pancreas may not make enough insulin to help extra glucose enter cells.", .90)
    fact("Blood Vessels", "Anatomy", "Anatomy_Disease", "Diabetes", "Disease", "ncbi-diabetes-overview", "Overview: Type 2 Diabetes", complications_url,
         "Diabetes may damage small blood vessels and can affect larger blood vessels.", .86)
    fact("Atrophy", "Symptom", "Symptom_Disease", "Diabetes", "Disease", "ncbi-diabetes-manifestations", "Diabetes Mellitus: Clinical Manifestations", "https://www.ncbi.nlm.nih.gov/books/NBK242/",
         "Muscle weakness and atrophy may be present with diabetic neuropathic amyotrophy.", .82)
    fact("Muscle Weakness", "Symptom", "Symptom_Disease", "Diabetes", "Disease", "ncbi-diabetes-manifestations", "Diabetes Mellitus: Clinical Manifestations", "https://www.ncbi.nlm.nih.gov/books/NBK242/",
         "Muscle weakness and atrophy may be present with diabetic neuropathic amyotrophy.", .82)
    save_store(store)
    return count


def ensure_seeded() -> None:
    if not load_store()["edges"]:
        seed_demo()
