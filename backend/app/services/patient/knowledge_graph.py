"""Build a small, auditable patient knowledge graph from saved clinical data."""
from __future__ import annotations

import re
from typing import Any


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def build_patient_graph(patient_id: str, state: dict[str, Any], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []

    def node(kind: str, label: str, **properties: Any) -> str:
        key = f"{kind}:{_key(label)}"
        nodes.setdefault(key, {"id": key, "type": kind, "label": label, **properties})
        return key

    patient = node("patient", patient_id)

    def link(kind: str, label: str, relation: str, **props: Any) -> str:
        target = node(kind, label, **props)
        edges.append({"source": patient, "target": target, "relation": relation, "evidence": "patient_record"})
        return target

    conditions = [str(x).strip() for x in state.get("conditions", []) if str(x).strip()]
    for item in conditions:
        link("condition", item, "has history")
    for item in state.get("medications", []):
        if str(item).strip():
            link("medication", str(item).strip(), "takes medication")
    for item in state.get("allergies", []):
        if str(item).strip():
            link("allergy", str(item).strip(), "has allergy")
    for item in state.get("symptoms", []):
        if str(item).strip():
            link("symptom", str(item).strip(), "reports symptom")
    vitals = state.get("vitals") or {}
    for name, value in vitals.items():
        if value not in (None, ""):
            link("observation", f"{name.replace('_', ' ')}: {value}", "has observation", value=value)
    for lab in state.get("labs", []) or []:
        if isinstance(lab, dict):
            label = f"{lab.get('name', 'Lab')}: {lab.get('value', '')} {lab.get('unit', '')}".strip()
            link("observation", label, "has observation", timestamp=lab.get("timestamp"))
    for event in state.get("timeline", []) or []:
        if isinstance(event, dict) and event.get("name") and event.get("value") is not None:
            label = f"{event['name']}: {event['value']} {event.get('unit') or ''}".strip()
            link("observation", label, "has observation", timestamp=event.get("timestamp"))
    for index, note in enumerate(state.get("notes", []) or []):
        excerpt = str(note).strip()
        if excerpt:
            label = "Uploaded report" if index == 0 else f"Clinical note {index}"
            target = node("document", label, excerpt=excerpt[:700])
            edges.append({"source": patient, "target": target, "relation": "has source document", "evidence": "patient_record"})

    # Evidence is connected only when its text explicitly mentions a recorded
    # condition or medication; this is a retrieval association, not a claim.
    terms = [(item, _key(item)) for item in [*conditions, *state.get("medications", [])] if len(_key(item)) > 2]
    for index, item in enumerate(evidence):
        text = str(item.get("text") or "")
        lowered = _key(text)
        matches = [(label, term) for label, term in terms if term in lowered]
        if not matches:
            continue
        title = str(item.get("title") or item.get("source") or "Clinical reference")
        ref = node("guideline", title, source=item.get("source"), excerpt=text[:700], page=item.get("page"))
        for label, _ in matches:
            subject = f"condition:{_key(label)}" if label in conditions else f"medication:{_key(label)}"
            edges.append({"source": subject, "target": ref, "relation": "mentioned in retrieved evidence", "evidence": "retrieval_match", "score": item.get("score")})

    return {"patient_id": patient_id, "nodes": list(nodes.values()), "edges": edges,
            "summary": {"nodes": len(nodes), "relationships": len(edges), "linked_references": sum(n["type"] == "guideline" for n in nodes.values())},
            "safety_note": "Evidence links indicate retrieved text mentions a recorded term; they do not establish causality or clinical applicability."}
