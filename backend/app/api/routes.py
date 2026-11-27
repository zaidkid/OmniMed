from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import re
import time
import uuid

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from fastapi.concurrency import run_in_threadpool

from pydantic import BaseModel, Field

from app.core import db

from app.core.config import OLLAMA_MODEL, OLLAMA_VISION_MODEL, UPLOAD_DIR

from app.services.models.models import (
    PatientInput,
    PatientState,
    CarePlanInput,
    CarePlanGenerationRequest,
    ReassessmentRequest,
    ReassessmentDecisionRequest,
    ClinicalBriefRequest,
    EvidenceSearchRequest,
    EvidenceIndexRequest,
)

from app.services.patient.patient_state import (
    build_patient_state,
)
from app.services.patient.knowledge_graph import build_patient_graph
from app.services import graph_rag

from app.services.evidence.document_service import (
    extract_document_with_info,
    extract_pdf_pages,
    IMAGE_SUFFIXES,
    assess_ocr_quality,
)

from app.services.evidence.ocr_service import (
    ocr_image,
    ocr_pdf_pages,
)

from app.services.evidence.report_parser import (
    parse_medical_report,
    improve_medical_report_with_ai,
    ai_extraction_cache_key,
    build_failed_report,
)

from app.services.evidence.evidence import (
    evidence_status,
    index_text_evidence,
    search_evidence,
)

from app.services.clinical.clinical import (
    generate_clinical_brief,
    generate_clinical_brief_stream,
)

from app.services.clinical.care_plan import generate_care_plan

# Streaming care plan (model reasoning + tokens). Optional until the service
# function exists; the route falls back to stage/log events only.
try:
    from app.services.clinical.care_plan import generate_care_plan_stream
except ImportError:
    generate_care_plan_stream = None

from app.services.reassessment import reassess

from app.services.ai.llm import (
    check_ollama, ollama_model_status, ollama_warm_up, ollama_generate,
    ollama_generate_from_image, ollama_generate_stream,
)
from app.services.evidence.vector_store import index_chunks


log = logging.getLogger(__name__)

router = APIRouter()


# This cache is local to the running Python process.
# It clears when the server restarts.
_AI_EXTRACTION_CACHE: dict[str, dict] = {}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class ImproveExtractionRequest(BaseModel):

    extracted_text: str = Field(
        min_length=1,
        max_length=2_000_000,
    )

    structured_report: dict

    model: str | None = None


class DocumentSummaryRequest(BaseModel):
    extracted_text: str = Field(min_length=1, max_length=100_000)
    filename: str = Field(default="uploaded document", max_length=255)


class DocumentVisionRequest(BaseModel):
    document_id: str = Field(min_length=1, max_length=100)
    patient_id: str = Field(min_length=1, max_length=200)


class ReassessmentExtractRequest(BaseModel):
    filename: str = Field(default="report", max_length=255)
    extracted_text: str = Field(min_length=1, max_length=30000)


def _text_usable(text: str) -> bool:

    clean = " ".join(text.split())

    return (
        len(clean) >= 20
        and sum(c.isalnum() for c in clean)
        / max(len(clean), 1)
        >= 0.35
    )


class _ExtractionFailed(Exception):
    """Text extraction failed for a known, user-explainable reason."""


def _stage(
    stage_id: str,
    label: str,
    status: str,
    detail: str | None = None,
    duration_ms: int | None = None,
) -> dict[str, Any]:
    return {
        "id": stage_id,
        "label": label,
        "status": status,
        "detail": detail,
        "duration_ms": duration_ms,
    }


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _to_vision_png(path: Path) -> bytes:
    from PIL import Image

    with Image.open(path) as image:
        if image.width * image.height > 50_000_000:
            raise ValueError("Image dimensions exceed the analysis limit")
        image = image.convert("RGB")
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
        return output.getvalue()


def _extract_text_for_upload(
    destination: Path,
    suffix: str,
    content_type: str | None,
) -> dict[str, Any]:
    """Blocking text extraction (native text, OCR, CSV decoding).

    Runs in a worker thread so it never blocks the FastAPI event loop.
    Raises _ExtractionFailed for problems that should be shown to the user.
    """

    methods: dict[int, str] = {}
    ocr_quality: dict[int, dict] = {}
    warnings: list[str] = []
    pages: list[dict[str, Any]] = []
    doc_info: dict[str, Any] = {}
    ocr_attempted: set[int] = set()
    ocr_failed: dict[int, str] = {}

    if suffix == ".pdf":

        doc_info = {"type": "pdf"}

        try:
            page_items = extract_pdf_pages(destination)
        except Exception as exc:
            raise _ExtractionFailed(
                f"The PDF could not be read ({type(exc).__name__}: {exc})."
            ) from exc

        needs_ocr = {
            page["page"]
            for page in page_items
            if page["needs_ocr"]
        }

        ocr_results: dict[int, str] = {}

        if needs_ocr:

            ocr_attempted = set(needs_ocr)

            try:
                for result in ocr_pdf_pages(
                    destination,
                    needs_ocr,
                ):
                    if result.get("error"):
                        ocr_failed[result["page"]] = result["error"]
                    else:
                        ocr_results[result["page"]] = result["text"]
            except Exception as exc:
                # OCR as a whole is unavailable. Keep native text from every page.
                for number in needs_ocr:
                    ocr_failed[number] = f"{type(exc).__name__}: {exc}"

        chunks = []

        for page in page_items:

            number = page["page"]

            native = page["text"].strip()

            ocr_text = (
                ocr_results.get(number, "")
                .strip()
            )

            if ocr_text:
                ocr_quality[number] = (
                    assess_ocr_quality(ocr_text)
                )

            # Prefer OCR only if native text is unusable
            # and OCR returned more text.
            if (
                ocr_text
                and not _text_usable(native)
                and len(ocr_text) > len(native)
            ):

                text = ocr_text

                methods[number] = "tesseract_ocr"

            else:

                text = native

                methods[number] = "pymupdf_native"

            table_text = "\n".join(
                " | ".join(row)
                for table in page["tables"]
                for row in table["rows"]
            )

            if table_text:

                text = (
                    text
                    + "\n\nExtracted tables:\n"
                    + table_text
                ).strip()

            if text:
                chunks.append(
                    f"[Page {number}]\n{text}"
                )

            record = {
                "page": number,
                "method": methods[number],
                "characters": len(text),
                "ocr_attempted": number in ocr_attempted,
                "ocr_error": ocr_failed.get(number),
                "status": "ok" if text else "no_text",
            }

            if page.get("error"):
                record["status"] = "read_error"
                record["error"] = page["error"]
                warnings.append(
                    f"Page {number}: native text could not be read ({page['error']})."
                )

            pages.append(record)

            if number in ocr_failed:
                warnings.append(
                    f"Page {number}: OCR failed ({ocr_failed[number]})."
                    + (" Native text was used." if text else "")
                )
            elif not text:
                warnings.append(
                    f"Page {number}: no readable text was found."
                )

        extracted_text = "\n\n".join(
            chunks
        ).strip()

    elif suffix in IMAGE_SUFFIXES:

        doc_info = {"type": "image"}

        ocr_attempted = {1}

        try:
            extracted_text = ocr_image(
                destination
            )
        except Exception as exc:
            raise _ExtractionFailed(
                f"OCR failed for this image ({exc})."
            ) from exc

        methods[1] = "tesseract_ocr"

        ocr_quality[1] = assess_ocr_quality(
            extracted_text
        )

        pages.append(
            {
                "page": 1,
                "method": "tesseract_ocr",
                "characters": len(extracted_text),
                "ocr_attempted": True,
                "ocr_error": None,
                "status": "ok" if extracted_text.strip() else "no_text",
            }
        )

        if extracted_text:
            extracted_text = (
                f"[Page 1]\n{extracted_text}"
            )

    else:

        try:
            extracted_text, doc_info = extract_document_with_info(
                destination,
                content_type,
            )
        except Exception as exc:
            raise _ExtractionFailed(
                f"The file could not be read ({type(exc).__name__}: {exc})."
            ) from exc

        methods[1] = "native_text"

        warnings.extend(doc_info.get("warnings", []))

    return {
        "text": extracted_text,
        "methods": methods,
        "ocr_quality": ocr_quality,
        "warnings": warnings,
        "pages": pages,
        "doc_info": doc_info,
        "ocr_pages": sorted(ocr_attempted),
        "ocr_failed": ocr_failed,
    }


def _needs_review(structured: dict[str, Any]) -> bool:

    if structured.get("extraction_warnings"):
        return True

    def flagged(field: Any) -> bool:
        return isinstance(field, dict) and bool(field.get("needs_review"))

    for key, value in structured.items():
        if key in {"extraction_warnings", "extraction_trace"}:
            continue
        if isinstance(value, dict):
            if flagged(value) or any(flagged(v) for v in value.values()):
                return True
        elif isinstance(value, list):
            for item in value:
                if flagged(item):
                    return True
                if isinstance(item, dict) and any(flagged(v) for v in item.values()):
                    return True
    return False


async def _care_plan_events_fallback(request: CarePlanGenerationRequest):
    """Used until generate_care_plan_stream exists: real stages and logs,
    but no model reasoning (generate_care_plan is not streaming)."""

    def ev(**fields: Any) -> dict[str, Any]:
        return {"ts": now_iso(), **fields}

    yield ev(type="stage", stage="read")
    yield ev(type="log", message="Care plan request received")
    yield ev(type="stage", stage="reason")

    task = asyncio.create_task(
        generate_care_plan(
            patient_state=request.patient_state,
            clinical_brief=request.clinical_brief,
            clinician_note=request.clinician_note,
        )
    )

    try:
        while not task.done():
            await asyncio.wait({task}, timeout=3)
            if not task.done():
                yield ev(type="log", message="Model is still generating the care plan...")
        result = task.result()  # re-raises generation errors
    finally:
        if not task.done():
            task.cancel()

    yield ev(type="stage", stage="structure")
    yield ev(
        type="result",
        result=result.model_dump() if hasattr(result, "model_dump") else result,
    )


@router.post("/patients/state")
def create_patient_state(
    patient: PatientInput,
):

    state = build_patient_state(patient)

    db.upsert_patient(
        patient.patient_id,
        state.model_dump(),
    )

    db.save_audit(
        "patient_state_created",
        patient.patient_id,
        state.model_dump(),
    )

    return state


@router.get("/patients/{patient_id}")
def get_patient(
    patient_id: str,
):

    state = db.get_patient(patient_id)

    if not state:
        raise HTTPException(
            status_code=404,
            detail="Patient not found",
        )

    return state


@router.get("/patients/{patient_id}/knowledge-graph")
def patient_knowledge_graph(patient_id: str):
    """Return patient relationships with guideline passages retrieved from RAG."""
    saved = db.get_patient(patient_id)
    if not saved:
        raise HTTPException(status_code=404, detail="Patient not found. Save a patient state first.")
    state = saved.get("state_json") or {}
    terms = [str(value).strip() for value in [*(state.get("conditions") or []), *(state.get("medications") or [])] if str(value).strip()]
    evidence = []
    if terms:
        try:
            evidence = search_evidence(" ".join(terms), top_k=8)
        except Exception:
            log.exception("Knowledge graph evidence retrieval failed for patient %s", patient_id)
    return build_patient_graph(patient_id, state, evidence)


@router.post("/patients/knowledge-graph")
def preview_patient_knowledge_graph(request: dict[str, Any]):
    """Build a graph from the current upload/review state without persisting it."""
    patient_id = str(request.get("patient_id") or "").strip()
    if not patient_id:
        raise HTTPException(status_code=422, detail="patient_id is required")
    terms = [str(value).strip() for value in [*(request.get("conditions") or []), *(request.get("medications") or [])] if str(value).strip()]
    evidence = []
    if terms:
        try:
            evidence = search_evidence(" ".join(terms), top_k=8)
        except Exception:
            log.exception("Knowledge graph evidence retrieval failed for uploaded patient %s", patient_id)
    return build_patient_graph(patient_id, request, evidence)


@router.post("/graph-rag/query")
async def graph_rag_query(request: dict[str, Any]):
    query = str(request.get("query") or "").strip()
    if not query or len(query) > 2000:
        raise HTTPException(status_code=422, detail="Enter a question (up to 2,000 characters).")
    try:
        chunks = search_evidence(query, top_k=6)
    except Exception:
        log.exception("GraphRAG text retrieval failed")
        chunks = []
    graph_rag.ensure_seeded()
    retrieved = graph_rag.query_graph(query, chunks)
    if not retrieved["context"].strip():
        return {"answer": "Insufficient evidence was found in the indexed text and knowledge graph to answer this question.", "citations": [], "graph": retrieved["graph"], "disclaimer": "Educational information only; not a diagnosis or treatment recommendation."}
    prompt = _graph_answer_prompt(query, retrieved["context"])
    try:
        raw = await ollama_generate(prompt, GRAPH_ANSWER_SCHEMA, num_predict=420, temperature=0.0)
        answer = _ground_graph_answer(str(json.loads(raw).get("answer", "")), retrieved["citations"])
        if not answer or answer.lower().startswith("insufficient evidence"):
            answer = _fallback_graph_answer(query, retrieved)
    except Exception:
        log.exception("GraphRAG answer generation failed")
        answer = _fallback_graph_answer(query, retrieved)
    return {"answer": answer, "citations": retrieved["citations"], "graph": retrieved["graph"], "disclaimer": "Educational information only; not a diagnosis or treatment recommendation. Verify evidence and applicability with a qualified clinician."}


def _graph_answer_prompt(query: str, context: str) -> str:
    return (
        "Answer the medical question using ONLY the retrieved facts below. Every factual claim must have inline numbered citations in the exact format [1]. "
        "Never invent a citation, dosage, diagnosis, or treatment recommendation. If context does not support an answer, say 'Insufficient evidence.' "
        "Keep the answer concise and mention uncertainty. This is educational decision support, not personalized care.\n\n"
        f"Question: {query}\n\nRetrieved context (citation numbers are authoritative):\n{context}\n\nAnswer with numbered citations:"
    )


GRAPH_ANSWER_SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}


def _ground_graph_answer(raw: str, citations: list[dict[str, Any]]) -> str:
    allowed = {str(c["id"]) for c in citations}
    text_value = re.sub(r"\[(\d+)\]", lambda m: m.group(0) if m.group(1) in allowed else "", raw.strip())
    cited = [sentence.strip() for sentence in re.split(r"(?<=[.!?])\s+|\n+", text_value)
             if sentence.strip() and re.search(r"\[\d+\]", sentence)]
    return " ".join(cited) if cited else ""


def _fallback_graph_answer(query: str, retrieved: dict[str, Any]) -> str:
    """Turn retrieved graph facts into cited statements when the model omits citations."""
    graph = retrieved.get("graph") or {}
    nodes = {node.get("id"): node for node in graph.get("nodes", [])}
    citations = {str(item.get("id")): item for item in retrieved.get("citations", [])}
    q = query.casefold()
    wants_drugs = any(term in q for term in ("drug", "medication", "medicine", "treat", "therapy"))
    wants_tests = any(term in q for term in ("diagnos", "test", "hba1c", "glucose", "screen"))
    edges = graph.get("edges", [])
    drug_edges = [e for e in edges if e.get("type") == "Drug_Disease"]
    test_edges = [e for e in edges if e.get("type") == "Test_Items_Disease"]
    chosen = []
    if wants_drugs:
        chosen.extend(drug_edges)
    if wants_tests:
        chosen.extend(test_edges)
    if not chosen:
        chosen = edges[:8]

    lines: list[str] = []
    if drug_edges and (wants_drugs or not wants_tests):
        facts = []
        for edge in drug_edges[:12]:
            ids = [str(value) for value in edge.get("citation_ids", []) if str(value) in citations]
            if ids:
                facts.append(f"{nodes.get(edge.get('source'), {}).get('label', 'Drug')} [{ids[0]}]")
        if facts:
            lines.append("The retrieved graph links these listed medicines with the disease; this is a source association, not a patient-specific treatment recommendation: " + ", ".join(facts) + ".")

    if test_edges and (wants_tests or not wants_drugs):
        for edge in test_edges[:5]:
            source = nodes.get(edge.get("source"), {}).get("label", "A glucose test")
            ids = [str(value) for value in edge.get("citation_ids", []) if str(value) in citations]
            if not ids:
                continue
            citation = citations[ids[0]]
            snippet = str(citation.get("snippet") or "").strip()
            target = nodes.get(edge.get("target"), {}).get("label", "diabetes")
            lines.append(f"The graph links {source} to {target}; retrieved source text: {snippet} [{ids[0]}]")

    if not lines:
        for edge in chosen[:5]:
            ids = [str(value) for value in edge.get("citation_ids", []) if str(value) in citations]
            if not ids:
                continue
            source = nodes.get(edge.get("source"), {}).get("label", "Retrieved entity")
            target = nodes.get(edge.get("target"), {}).get("label", "related entity")
            lines.append(f"Retrieved graph relationship: {source} —{edge.get('type')}→ {target} [{ids[0]}].")

    if not lines:
        for chunk in (retrieved.get("chunks") or [])[:3]:
            cid = str(chunk.get("citation_id", ""))
            text_value = str(chunk.get("text", "")).strip()
            if cid in citations and text_value:
                excerpt = text_value[:260].rsplit(" ", 1)[0]
                lines.append(f"Retrieved source excerpt: {excerpt} [{cid}]")
    return " ".join(lines) if lines else "Insufficient evidence to answer this question from retrieved sources."


@router.post("/graph-rag/query/stream")
async def graph_rag_query_stream(request: dict[str, Any]):
    query = str(request.get("query") or "").strip()
    if not query or len(query) > 2000:
        raise HTTPException(status_code=422, detail="Enter a question (up to 2,000 characters).")

    patient_context = request.get("patient_context")
    patient_text = str(patient_context.get("text") or "").strip()[:14000] if isinstance(patient_context, dict) else ""

    async def events():
        try:
            if patient_text:
                patient_id = str(patient_context.get("patient_id") or "unknown")
                source_title = str(patient_context.get("source_title") or "Uploaded patient report")[:255]
                patient_citation = {
                    "id": 1,
                    "source_id": "patient-report:" + patient_id,
                    "source_title": source_title,
                    "source_url": "",
                    "page": None,
                    "chunk_id": "patient-report:" + patient_id + ":upload",
                    "snippet": patient_text[:300],
                    "confidence": 1.0,
                }
                retrieved = {
                    "citations": [patient_citation],
                    "graph": {"nodes": [], "edges": []},
                    "context": "[1] Uploaded patient report text: " + patient_text,
                }
            else:
                try:
                    chunks = search_evidence(query, top_k=6)
                except Exception:
                    log.exception("GraphRAG streamed text retrieval failed")
                    chunks = []
                graph_rag.ensure_seeded()
                retrieved = graph_rag.query_graph(query, chunks)
            base = {"citations": retrieved["citations"], "graph": retrieved["graph"], "disclaimer": "Educational information only; not a diagnosis or treatment recommendation. Verify evidence and applicability with a qualified clinician.", "model": OLLAMA_MODEL, "generation_status": "ollama"}
            if not retrieved["context"].strip():
                base["answer"] = "Insufficient evidence was found in the indexed text and knowledge graph to answer this question."
                base["generation_status"] = "fallback"
                yield f"data: {json.dumps({'type': 'result', 'result': base})}\n\n"
                return
            yield f"data: {json.dumps({'type': 'meta', 'result': base})}\n\n"
            prompt = _graph_answer_prompt(query, retrieved["context"])
            parts = []
            async for item in ollama_generate_stream(prompt, GRAPH_ANSWER_SCHEMA, num_predict=420, answer_num_predict=420, temperature=0.0, think=False):
                if item.get("type") == "response":
                    parts.append(str(item.get("text") or ""))
                    yield f"data: {json.dumps({'type': 'token', 'text': item.get('text', '')})}\n\n"
            try:
                raw = json.loads("".join(parts)).get("answer", "")
            except (json.JSONDecodeError, AttributeError):
                raw = ""
            base["answer"] = _ground_graph_answer(str(raw), retrieved["citations"])
            if not base["answer"] or base["answer"].lower().startswith("insufficient evidence"):
                if patient_text:
                    base["answer"] = "The uploaded report states: " + patient_text[:260].rsplit(" ", 1)[0] + " [1]"
                else:
                    base["answer"] = _fallback_graph_answer(query, retrieved)
                base["generation_status"] = "fallback"
            yield f"data: {json.dumps({'type': 'result', 'result': base})}\n\n"
        except Exception as exc:
            log.exception("GraphRAG streamed answer failed")
            if "retrieved" in locals() and retrieved.get("context"):
                if patient_text:
                    base["answer"] = "The uploaded report states: " + patient_text[:260].rsplit(" ", 1)[0] + " [1]"
                else:
                    base["answer"] = _fallback_graph_answer(query, retrieved)
                base["generation_status"] = "fallback"
                yield f"data: {json.dumps({'type': 'result', 'result': base})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'error', 'detail': type(exc).__name__})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/graph-rag/node/{node_id}")
def graph_rag_node(node_id: str):
    node = graph_rag.detail(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Graph node not found")
    return node


@router.get("/graph-rag/node/{node_id}/neighbors")
def graph_rag_neighbors(node_id: str):
    if not graph_rag.detail(node_id):
        raise HTTPException(status_code=404, detail="Graph node not found")
    return graph_rag.neighbors(node_id)


@router.post("/graph-rag/ingest")
async def graph_rag_ingest(
    file: UploadFile = File(...),
    source_title: str = Form(""),
    source_url: str = Form(""),
):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".pdf", ".md", ".markdown", ".txt"}:
        raise HTTPException(status_code=415, detail="Upload a PDF, Markdown, or TXT reference.")
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Reference exceeds the 20 MB limit.")
    title = source_title.strip() or Path(file.filename or "Reference").stem
    source_id = hashlib.sha256(f"{title}|{source_url}|".encode() + raw).hexdigest()[:24]
    if suffix == ".pdf":
        import fitz
        with fitz.open(stream=raw, filetype="pdf") as pdf:
            pages = [(i + 1, p.get_text("text").strip()) for i, p in enumerate(pdf) if p.get_text("text").strip()]
    else:
        pages = [(None, raw.decode("utf-8", errors="replace"))]
    pieces: list[tuple[int | None, str, int]] = []
    for page, text_value in pages:
        words = text_value.split()
        start = 0
        while start < len(words):
            end = min(start + 575, len(words))
            pieces.append((page, " ".join(words[start:end]), len(pieces)))
            if end == len(words): break
            start = end - 90
    if not pieces:
        raise HTTPException(status_code=422, detail="No readable text was found in the reference.")
    store = graph_rag.load_store()
    vector_chunks = []
    extracted = 0
    for page, chunk_text, index in pieces:
        chunk_id = f"{source_id}:{index}"
        prov = graph_rag.provenance(source_id, title, source_url, page, chunk_id, chunk_text[:300], .95)
        store["chunks"][chunk_id] = {"text": chunk_text, "provenance": prov}
        vector_chunks.append({"id": int(hashlib.sha256(chunk_id.encode()).hexdigest()[:15], 16), "document_id": source_id,
                              "chunk_index": index, "text": chunk_text, "title": title, "source": file.filename or title,
                              "metadata": {"document_type": "clinical_reference", "url": source_url, "source_id": source_id, "page": page, "chunk_id": chunk_id},
                              "document_type": "clinical_reference", "clinical_topics": [], "page": page, "url": source_url})
        schema = {"type": "object", "properties": {"triples": {"type": "array", "items": {"type": "object", "properties": {
            "subject": {"type": "string"}, "subject_type": {"type": "string", "enum": sorted(graph_rag.NODE_TYPES)},
            "relationship": {"type": "string", "enum": sorted(graph_rag.EDGE_TYPES)}, "object": {"type": "string"},
            "object_type": {"type": "string", "enum": sorted(graph_rag.NODE_TYPES)}, "snippet": {"type": "string"}, "confidence": {"type": "number"}},
            "required": ["subject", "subject_type", "relationship", "object", "object_type", "snippet", "confidence"]}}}, "required": ["triples"]}
        prompt = ("Extract only explicit clinical facts that match the allowed entity and relationship schema. Do not infer.")
        try:
            output = await ollama_generate(f"{prompt}\nJSON schema: {json.dumps(schema)}\nPassage:\n{chunk_text}", schema, num_predict=700, temperature=0.0)
            triples = json.loads(output).get("triples", [])
        except Exception:
            log.exception("Graph triple extraction failed for chunk %s", chunk_id)
            continue
        for triple in triples:
            snippet = str(triple.get("snippet", "")).strip()
            if not snippet or _normalize_graph_text(snippet) not in _normalize_graph_text(chunk_text):
                continue
            try:
                graph_rag.add_fact(store, str(triple["subject"]), triple["subject_type"], triple["relationship"], str(triple["object"]), triple["object_type"], graph_rag.provenance(source_id, title, source_url, page, chunk_id, snippet, triple.get("confidence", .5)))
                extracted += 1
            except (KeyError, ValueError):
                continue
    index_chunks(vector_chunks)
    graph_rag.save_store(store)
    return {"source_id": source_id, "source_title": title, "chunks_indexed": len(pieces), "triples_added": extracted, "idempotent": True}


def _normalize_graph_text(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.casefold()).split())


@router.post("/documents/upload")
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    patient_id: Optional[str] = Form(None),
):

    started = time.perf_counter()

    original = file.filename or "uploaded_document"

    suffix = Path(original).suffix.lower()

    allowed = {
        ".pdf",
        ".txt",
        ".md",
        ".csv",
        *IMAGE_SUFFIXES,
    }

    if suffix not in allowed:
        raise HTTPException(
            status_code=400,
            detail=(
                "Supported: PDF, TXT, MD, CSV, "
                "PNG, JPG, JPEG, TIF, TIFF, BMP, WEBP"
            ),
        )

    content = await file.read()

    if not content:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is empty.",
        )

    if len(content) > 25 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail="Maximum upload size is 25 MB.",
        )

    # Avoid loading the text-only model for image uploads; image analysis uses
    # its own configured vision model and loading both wastes local memory.
    if suffix not in IMAGE_SUFFIXES:
        background_tasks.add_task(ollama_warm_up)

    document_id = str(uuid.uuid4())

    destination = (
        UPLOAD_DIR
        / f"{document_id}{suffix}"
    )

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    destination.write_bytes(content)

    stages: list[dict[str, Any]] = [
        _stage(
            "file_received",
            "File received",
            "completed",
            f"{original} ({len(content):,} bytes)",
        ),
    ]

    # ---- Stage: text extraction (native text, CSV decoding, OCR) -------------
    extraction_started = time.perf_counter()

    try:
        extracted = await run_in_threadpool(
            _extract_text_for_upload,
            destination,
            suffix,
            file.content_type,
        )
    except _ExtractionFailed as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(
            status_code=422,
            detail=f"Document extraction failed: {exc}",
        ) from exc
    except Exception as exc:
        log.exception("Unexpected error while extracting %s", original)
        destination.unlink(missing_ok=True)
        raise HTTPException(
            status_code=422,
            detail=(
                "Document extraction failed: "
                f"{type(exc).__name__}: {exc}"
            ),
        ) from exc

    extracted_text: str = extracted["text"]
    methods: dict[int, str] = extracted["methods"]
    ocr_quality: dict[int, dict] = extracted["ocr_quality"]
    extraction_warnings: list[str] = extracted["warnings"]
    page_records: list[dict[str, Any]] = extracted["pages"]
    doc_info: dict[str, Any] = extracted["doc_info"]
    ocr_pages: list[int] = extracted["ocr_pages"]
    ocr_failed: dict[int, str] = extracted["ocr_failed"]

    # Keep images even when OCR has nothing to extract; vision analysis can
    # still inspect their pixels. Empty non-image documents remain invalid.
    if not extracted_text or not extracted_text.strip():
        if suffix in IMAGE_SUFFIXES:
            extraction_warnings.append(
                "No text was detected by OCR. The image was retained for optional vision-model analysis."
            )
        else:
            destination.unlink(missing_ok=True)
            reasons = " ".join(extraction_warnings[:3])
            raise HTTPException(
                status_code=422,
                detail=(
                    "No readable text was extracted from this document."
                    + (f" {reasons}" if reasons else "")
                ),
            )

    stages.append(
        _stage(
            "document_type",
            "Document type identified",
            "completed",
            doc_info.get("type", suffix.lstrip(".")),
        )
    )

    pages_processed = len(page_records) or 1

    stages.append(
        _stage(
            "text_extraction",
            "Text extraction",
            "completed",
            f"{len(extracted_text):,} characters"
            + (
                f" from {len(page_records)} page(s)"
                if page_records
                else ""
            )
            + (
                f"; {doc_info['data_rows']:,} CSV data rows"
                if doc_info.get("type") == "csv"
                else ""
            ),
            _ms(extraction_started),
        )
    )

    if ocr_pages:
        ocr_ok = len(ocr_pages) - len(ocr_failed)
        stages.append(
            _stage(
                "ocr",
                "OCR",
                "failed" if ocr_failed and not ocr_ok else "completed",
                f"{ocr_ok} of {len(ocr_pages)} page(s) OCR'd"
                + (f"; {len(ocr_failed)} failed" if ocr_failed else ""),
            )
        )
    else:
        stages.append(
            _stage(
                "ocr",
                "OCR",
                "skipped",
                "Not needed: native text was usable.",
            )
        )

    stages.append(
        _stage(
            "text_prepared",
            "Extracted text prepared",
            "completed",
            f"{len(extracted_text):,} characters available as raw text",
        )
    )

    # Persist the document NOW, before the LLM runs. A slow, failed or
    # cancelled structuring step must never lose the upload or its text.
    db.save_document(
        document_id,
        patient_id,
        original,
        file.content_type,
        str(destination),
        extracted_text,
    )

    # ---- Raw-text mode: no LLM mapping during document extraction ------------
    # Preserve the complete extracted text and return an explicit skipped trace.
    # Downstream clinical reasoning can consume the raw text separately.
    structured = build_failed_report(
        "Raw-text mode is enabled. The document was extracted successfully; LLM field mapping is disabled.",
        stage="raw_text_mode",
        code="llm_mapping_disabled",
        input_characters=len(extracted_text),
        status="skipped",
    )

    trace = structured.setdefault("extraction_trace", {})

    structuring_status = trace.get("status", "failed")

    trace["stages"] = stages + list(trace.get("stages", []))

    trace["document"] = {
        "filename": original,
        "document_id": document_id,
        "document_type": doc_info.get("type"),
        "characters_extracted": len(extracted_text),
        "pages_processed": pages_processed if page_records else None,
        "ocr_pages_processed": len(ocr_pages) - len(ocr_failed),
        "ocr_pages_failed": len(ocr_failed),
        "csv": (
            {
                key: doc_info.get(key)
                for key in (
                    "records",
                    "data_rows",
                    "max_columns",
                    "delimiter",
                    "encoding",
                    "header_detected",
                    "ragged_rows",
                    "blank_rows",
                    "unparsed_rows",
                )
            }
            if doc_info.get("type") == "csv"
            else None
        ),
    }

    trace["processing_duration_ms"] = _ms(started)

    if extraction_warnings:
        structured["extraction_warnings"] = [
            *extraction_warnings,
            *structured.get("extraction_warnings", []),
        ]

    errors = list(trace.get("errors", []))

    if doc_info.get("type") == "csv":
        for issue in doc_info.get("issues", []):
            errors.append(
                {
                    "stage": "text_extraction",
                    "code": "csv_row_issue",
                    "message": f"CSV row {issue['row']}: {issue['problem']}",
                }
            )

    llm_error = errors[0]["message"] if structuring_status in {"failed", "partial"} and errors else None

    legacy_status = {
        "completed": "completed",
        "partial": "partial",
        "skipped": "raw_text_only",
    }.get(structuring_status, "raw_text_only")

    return {
        "document_id": document_id,
        "patient_id": patient_id,
        "filename": original,
        "vision_available": bool(OLLAMA_VISION_MODEL) and suffix in IMAGE_SUFFIXES,
        "vision_model": OLLAMA_VISION_MODEL if suffix in IMAGE_SUFFIXES else None,
        "characters_extracted": len(
            extracted_text
        ),
        "text_preview": extracted_text[:4000],
        "extracted_text": extracted_text,
        "structured_report": structured,
        "extraction_methods": methods,
        "ocr_quality": ocr_quality,
        "content_hash": hashlib.sha256(
            content
        ).hexdigest(),
        "ai_improvement_available": False,
        "extraction_status": "completed",
        "structuring_status": structuring_status,
        "errors": errors,
        "warnings": structured.get("extraction_warnings", []),
        "pages": page_records,
        "document_info": trace["document"],
        "processing": {
            "status": legacy_status,
            "extraction_status": "completed",
            "structuring_status": structuring_status,
            "text_extraction_status": "completed",
            "complete": structuring_status == "completed",
            "llm_used": False,
            "llm_provider": None,
            "llm_model": None,
            "structured_extraction_method": "disabled_raw_text_only",
            "llm_error": llm_error,
            "duration_ms": trace["processing_duration_ms"],
        },
        "review_required": _needs_review(structured),
    }


@router.post("/documents/improve-with-ai")
async def improve_document_extraction(
    request: ImproveExtractionRequest,
):

    cache_key = ai_extraction_cache_key(
        request.extracted_text
    )

    if cache_key in _AI_EXTRACTION_CACHE:

        return {
            "structured_report": (
                _AI_EXTRACTION_CACHE[cache_key]
            ),
            "cached": True,
        }

    try:

        improved = (
            await improve_medical_report_with_ai(
                request.extracted_text,
                request.structured_report,
                model=request.model,
            )
        )

    except ValueError as exc:

        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    except Exception as exc:

        raise HTTPException(
            status_code=502,
            detail=(
                "Raw-text-only mode: "
                f"{type(exc).__name__}: {exc}"
            ),
        ) from exc

    status = improved.get("extraction_trace", {}).get("status")

    if status == "failed":

        errors = improved.get("extraction_trace", {}).get("errors", [])

        raise HTTPException(
            status_code=502,
            detail=(
                "Raw-text-only mode: "
                + (errors[0]["message"] if errors else "no structured response was produced.")
            ),
        )

    # Only a complete result is cached; partial results should be retried.
    if status == "completed":
        _AI_EXTRACTION_CACHE[cache_key] = improved

    return {
        "structured_report": improved,
        "cached": False,
    }


@router.post("/documents/summarize")
async def summarize_document(request: DocumentSummaryRequest):
    """Summarize extracted text; this endpoint does not interpret image pixels."""
    schema = {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "key_findings": {"type": "array", "items": {"type": "string"}},
            "uncertainties": {"type": "array", "items": {"type": "string"}},
            "review_note": {"type": "string"},
        },
        "required": ["summary", "key_findings", "uncertainties", "review_note"],
    }
    prompt = (
        "Summarize only clinical facts explicitly present in the extracted text. Do not infer a diagnosis, "
        "treatment, or missing value. Preserve units and dates. Keep it brief. If the source is an image, "
        "state this is an OCR-text summary and does not interpret the image itself. Return the requested JSON.\n\n"
        f"Document: {request.filename}\nExtracted text:\n{request.extracted_text[:24000]}"
    )
    try:
        raw = await ollama_generate(prompt, schema, num_predict=240, temperature=0.1)
        result = json.loads(raw)
    except Exception as exc:
        log.exception("Document text summarization failed")
        raise HTTPException(status_code=502, detail=f"Could not summarize extracted text: {type(exc).__name__}") from exc
    return {**result, "source": "extracted_text", "image_interpreted": False}


@router.post("/reassessment/extract")
async def extract_reassessment_facts(request: ReassessmentExtractRequest):
    """Extract report facts as unverified proposals for clinician confirmation."""
    schema = {
        "type": "object",
        "properties": {
            "conditions": {"type": "array", "items": {"type": "string"}},
            "medications": {"type": "array", "items": {"type": "string"}},
            "allergies": {"type": "array", "items": {"type": "string"}},
            "symptoms": {"type": "array", "items": {"type": "string"}},
            "vitals": {"type": "object", "additionalProperties": {"type": "string"}},
            "labs": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "value": {"type": "string"}, "unit": {"type": "string"}
            }, "required": ["name", "value", "unit"]}},
            "clinical_notes": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["conditions", "medications", "allergies", "symptoms", "vitals", "labs", "clinical_notes"],
    }
    prompt = (
        "Extract EVERY patient-specific fact explicitly reported below, even when the report does not call it new "
        "or changed. The comparison step will determine what changed. Include all measured lab results and vitals, "
        "with exact values and units. Exclude reference ranges, examples, and general education text. Do not infer, "
        "diagnose, or convert values. Preserve medication doses. Leave absent categories empty. These are proposals "
        "that a clinician must verify. Return JSON only.\n\n"
        f"Report: {request.filename}\n{request.extracted_text[:24000]}"
    )
    fallback = _extract_labeled_reassessment_facts(request.extracted_text)
    try:
        raw = await ollama_generate(prompt, schema, num_predict=500, temperature=0.0)
        facts = json.loads(raw)
    except Exception as exc:
        log.exception("Reassessment report extraction failed")
        fallback = _sanitize_reassessment_facts(fallback, request.extracted_text)
        return {**fallback, "review_required": True, "extraction_source": "labeled_text_fallback",
                "extraction_warning": f"Model extraction unavailable ({type(exc).__name__}); only explicitly labeled values were proposed."}
    facts = _sanitize_reassessment_facts(facts, request.extracted_text)
    return {
        **facts,
        "review_required": True,
        "extraction_source": "source_checked_model_proposals",
        "extraction_warning": "Only source-supported proposals were kept. Ambiguous multi-value lab rows may be omitted; verify them against the report and enter the current result manually.",
    }


def _sanitize_reassessment_facts(facts: dict[str, Any], source: str) -> dict[str, Any]:
    """Reject model proposals that are not directly supported by the uploaded text."""
    def normalized(value: Any) -> str:
        return " ".join(re.sub(r"[^a-z0-9]+", " ", str(value).casefold()).split())

    source_normalized = normalized(source)
    metadata = re.compile(r"(?i)\b(patient\s*id|related report|follow[ -]?up date|age\s*/\s*sex|known conditions|recorded medication|reference range|information still missing)\b")

    def supported(value: Any, limit: int = 180) -> bool:
        candidate = str(value or "").strip()
        key = normalized(candidate)
        return bool(key and len(candidate) <= limit and key in source_normalized and not metadata.search(candidate))

    clean: dict[str, Any] = {"conditions": [], "medications": [], "allergies": [], "symptoms": [],
                              "vitals": {}, "labs": [], "clinical_notes": []}
    for key in ("conditions", "medications", "allergies", "symptoms", "clinical_notes"):
        values = facts.get(key, [])
        if not isinstance(values, list):
            continue
        for value in values:
            if supported(value, 240 if key == "clinical_notes" else 120):
                candidate = str(value).strip()
                if candidate not in clean[key]:
                    clean[key].append(candidate)

    raw_vitals = facts.get("vitals", {})
    if isinstance(raw_vitals, dict):
        for key, value in raw_vitals.items():
            candidate = str(value or "").strip()
            # Vitals must be a single measured value; reject prose or merged cells.
            if key == "blood_pressure":
                valid = bool(re.fullmatch(r"\d{2,3}\s*/\s*\d{2,3}(?:\s*mm\s*Hg)?", candidate, re.I))
            else:
                valid = bool(re.fullmatch(r"[<>]?\s*\d+(?:\.\d+)?\s*(?:%|bpm|mm\s*Hg|°?[CF]|mmol/L|breaths/min)?", candidate, re.I))
            if valid and supported(candidate, 40):
                clean["vitals"][str(key)] = candidate

    raw_labs = facts.get("labs", [])
    if isinstance(raw_labs, list):
        for item in raw_labs:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            value = str(item.get("value", "")).strip()
            unit = str(item.get("unit", "")).strip()
            # A result must be one scalar. This drops merged cells such as "86 72"
            # or "7.4 Not repeated", which cannot safely represent a result.
            if (not supported(name, 80) or metadata.search(name)
                    or not re.fullmatch(r"[<>]?\s*\d+(?:\.\d+)?", value)
                    or len(unit) > 24 or re.search(r"[<>|\n]", unit)):
                continue
            # Require an unambiguous source row: a lab name and exactly one
            # numeric result on the same extracted line. Multi-column rows
            # (for example prior/current values) must be entered manually.
            matching_rows = [line for line in source.splitlines()
                             if normalized(name) in normalized(line)
                             and re.search(rf"(?<!\d){re.escape(value)}(?!\d)", line)]
            if not any(len(re.findall(r"(?<![A-Za-z])\d+(?:\.\d+)?", line)) == 1 for line in matching_rows):
                continue
            clean["labs"].append({"name": name, "value": value.replace(" ", ""), "unit": unit})

    return clean


def _extract_labeled_reassessment_facts(text: str) -> dict[str, Any]:
    """Conservative fallback for explicit labels and tabular lab rows."""
    facts: dict[str, Any] = {"conditions": [], "medications": [], "allergies": [], "symptoms": [],
                             "vitals": {}, "labs": [], "clinical_notes": []}
    list_labels = {
        "condition": "conditions", "conditions": "conditions", "diagnosis": "conditions", "diagnoses": "conditions",
        "medication": "medications", "medications": "medications", "current medications": "medications",
        "allergy": "allergies", "allergies": "allergies", "symptom": "symptoms", "symptoms": "symptoms",
    }
    vital_labels = {
        "bp": "blood_pressure", "blood pressure": "blood_pressure", "heart rate": "heart_rate", "pulse": "heart_rate",
        "spo2": "spo2", "oxygen saturation": "spo2", "temperature": "temperature",
        "respiratory rate": "respiratory_rate", "resp rate": "respiratory_rate",
    }
    number = r"([<>]?\s*\d+(?:\.\d+)?)"
    for raw in text.splitlines():
        line = re.sub(r"^\s*\[Page\s+\d+\]\s*", "", raw).strip()
        line = re.sub(r"^\s*Row\s+\d+\s*:\s*", "", line, flags=re.I)
        if not line or re.search(r"(?i)reference\s*range|normal\s*range|desirable\s*level|example", line):
            continue
        labeled = re.match(r"(?i)^\s*([a-z ]{2,32})\s*:\s*(.+)$", line)
        if labeled:
            label = " ".join(labeled.group(1).casefold().split())
            value = labeled.group(2).strip()
            if label in list_labels:
                facts[list_labels[label]].extend([part.strip() for part in re.split(r"[,;]", value) if part.strip()])
                continue
            if label in vital_labels:
                if vital_labels[label] == "blood_pressure":
                    match = re.search(r"(\d{2,3}\s*/\s*\d{2,3})(?:\s*(mm\s*Hg))?", value, re.I)
                    if match:
                        facts["vitals"][vital_labels[label]] = " ".join(part for part in (match.group(1), match.group(2)) if part)
                    continue
                match = re.search(number + r"\s*([a-zA-Z%/µμ0-9.^_-]*)", value)
                if match:
                    facts["vitals"][vital_labels[label]] = (match.group(1) + " " + match.group(2)).strip()
                continue
            value_match = re.search("^" + number + r"\s*([a-zA-Z%/µμ0-9.^_-]*)\s*$", value)
            if value_match and label not in {"age", "sex", "date", "report date", "patient id", "reference range"}:
                facts["labs"].append({"name": labeled.group(1).strip(), "value": value_match.group(1).replace(" ", ""), "unit": value_match.group(2).strip()})
                continue
        cells = [cell.strip() for cell in line.split("|")]
        if len(cells) >= 2 and re.search(number, cells[1]):
            name = re.sub(r"[^A-Za-z0-9 /()._-]", "", cells[0]).strip()
            value_match = re.search(number, cells[1])
            if name and value_match and len(name) <= 50:
                facts["labs"].append({"name": name, "value": value_match.group(1).replace(" ", ""), "unit": cells[2] if len(cells) > 2 else ""})
            continue
        table_row = re.match(r"^([A-Za-z][A-Za-z0-9 /()._-]{1,40}?)\s+" + number + r"\s*([a-zA-Z%/µμ0-9.^_-]*)\s*$", line)
        if table_row and not re.search(r"(?i)page|date|age|score|phone|patient|record|id", table_row.group(1)):
            facts["labs"].append({"name": table_row.group(1).strip(), "value": table_row.group(2).replace(" ", ""), "unit": table_row.group(3).strip()})
    return facts


@router.post("/documents/vision-summarize")
async def summarize_medical_image(request: DocumentVisionRequest):
    """Generate cautious image observations from a configured Ollama vision model."""
    if not OLLAMA_VISION_MODEL:
        raise HTTPException(
            status_code=503,
            detail="Image analysis is not configured. Set OLLAMA_VISION_MODEL to an installed Ollama vision model and restart the backend.",
        )
    document = db.get_patient_document(request.document_id, request.patient_id.strip())
    if not document:
        raise HTTPException(status_code=404, detail="Image not found for this patient.")
    path = Path(document["path"])
    if path.suffix.lower() not in IMAGE_SUFFIXES or not path.is_file():
        raise HTTPException(status_code=422, detail="The selected document is not an available image.")
    if path.stat().st_size > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 25 MB analysis limit.")

    # Normalize supported raster formats for Ollama's image input. Keep original
    # dimensions; do not resize away potentially relevant details.
    try:
        image_bytes = await run_in_threadpool(_to_vision_png, path)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not prepare image for analysis ({type(exc).__name__}).") from exc

    schema = {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "observed_features": {"type": "array", "items": {"type": "string"}},
            "image_quality": {"type": "string"},
            "possible_modality": {"type": "string"},
            "uncertainties": {"type": "array", "items": {"type": "string"}},
            "clinician_review_questions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["summary", "observed_features", "image_quality", "possible_modality", "uncertainties", "clinician_review_questions"],
    }
    prompt = (
        "Describe visible image features cautiously and only as observations. Do not diagnose, rule out disease, "
        "recommend treatment, or claim certainty. If the image is a radiograph, note that this is an AI-generated "
        "preliminary observation and not a radiologist report. State limitations, image quality concerns, and what "
        "a qualified clinician/radiologist should verify. If modality or anatomy is unclear, say so. Return only the requested JSON."
    )
    try:
        generated = await ollama_generate_from_image(prompt, image_bytes, schema)
        result = json.loads(generated["text"])
    except Exception as exc:
        log.exception("Vision analysis failed for uploaded image")
        raise HTTPException(status_code=502, detail=f"Vision model could not analyze this image ({type(exc).__name__}).") from exc
    return {
        **result,
        "document_id": request.document_id,
        "filename": document["filename"],
        "model": generated["model"],
        "image_interpreted": True,
        "diagnostic": False,
        "clinician_review_required": True,
    }


@router.get("/documents")
def get_documents(
    patient_id: Optional[str] = None,
):

    return db.list_documents(patient_id)


@router.post("/evidence/index")
def add_evidence(
    request: EvidenceIndexRequest,
):
    try:
        return index_text_evidence(
            request.title,
            request.source,
            request.text,
            request.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/evidence/search")
def evidence_search(
    request: EvidenceSearchRequest,
):

    return {
        "query": request.query,
        "results": search_evidence(
            request.query,
            request.top_k,
        ),
    }


@router.get("/knowledge/status")
def knowledge_status():
    status = evidence_status()
    return {
        **status,
        # Backward-compatible field used by the evidence and settings pages.
        "indexed_evidence_items": status.get("vectors_count", 0),
    }


@router.get("/ai/status")
async def ai_status():
    try:
        tags = await check_ollama()
        available_models = {
            str(item.get("name") or item.get("model") or "")
            for item in tags.get("models", [])
            if isinstance(item, dict)
        }
        model_available = OLLAMA_MODEL in available_models or f"{OLLAMA_MODEL}:latest" in available_models
        runtime = await ollama_model_status()
        return {
            "status": "connected" if model_available else "unavailable",
            "provider": "Ollama",
            "model": OLLAMA_MODEL,
            "model_available": model_available,
            "runtime": runtime,
        }
    except Exception as exc:
        return {
            "status": "disconnected",
            "provider": "Ollama",
            "model": OLLAMA_MODEL,
            "error": str(exc),
        }


@router.post("/clinical-brief/stream")
async def clinical_brief_stream(
    http_request: Request,
    request: ClinicalBriefRequest,
):
    """Stream NDJSON progress, model fragments, backend logs, and the validated result."""
    db.upsert_patient(
        request.patient_state.patient_id,
        request.patient_state.model_dump(),
    )

    async def event_stream():
        try:
            async for event in generate_clinical_brief_stream(
                request.patient_state,
                request.clinical_question,
            ):
                # Stop work (and the Ollama request) if the browser went away.
                if await http_request.is_disconnected():
                    log.info("Client disconnected; stopping clinical brief stream.")
                    return

                if event.get("type") == "result":
                    result = event.get("result", {})
                    # Audit persistence must never suppress the clinical result event.
                    try:
                        db.save_audit(
                            "clinical_brief_generated",
                            request.patient_state.patient_id,
                            result,
                        )
                    except Exception:
                        log.exception("Could not save clinical brief audit event")
                yield json.dumps(event, ensure_ascii=False, default=str) + "\n"
        except Exception as exc:
            log.exception("Streaming clinical brief generation failed")
            yield json.dumps({
                "type": "error",
                "message": "Clinical brief generation failed.",
                "detail": str(exc),
                "ts": now_iso(),
            }, ensure_ascii=False) + "\n"

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/clinical-brief")
async def clinical_brief(
    request: ClinicalBriefRequest,
):

    db.upsert_patient(
        request.patient_state.patient_id,
        request.patient_state.model_dump(),
    )

    result = await generate_clinical_brief(
        request.patient_state,
        request.clinical_question,
    )

    db.save_audit(
        "clinical_brief_generated",
        request.patient_state.patient_id,
        result,
    )

    return result


@router.post("/care-plans/generate")
async def generate_care_plan_endpoint(
    request: CarePlanGenerationRequest,
):
    """Generate a care-plan draft for clinician review; do not save or approve it."""
    try:
        db.upsert_patient(
            request.patient_state.patient_id,
            request.patient_state.model_dump(),
        )
        result = await generate_care_plan(
            patient_state=request.patient_state,
            clinical_brief=request.clinical_brief,
            clinician_note=request.clinician_note,
        )

        # Audit failure should not prevent returning a generated draft.
        try:
            db.save_audit(
                "care_plan_draft_generated",
                request.patient_state.patient_id,
                result,
            )
        except Exception:
            log.exception("Could not save care-plan generation audit event")

        return result

    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        log.exception("Care-plan generation failed")
        raise HTTPException(
            status_code=500,
            detail="Care-plan generation failed. Check backend logs.",
        ) from exc


@router.post("/care-plans/stream")
async def care_plan_stream(
    http_request: Request,
    request: CarePlanGenerationRequest,
):
    """Stream NDJSON progress, model reasoning, logs, and the draft care plan.

    The draft is never saved or approved here; clinician review is required.
    """

    events = (
        generate_care_plan_stream(
            patient_state=request.patient_state,
            clinical_brief=request.clinical_brief,
            clinician_note=request.clinician_note,
        )
        if generate_care_plan_stream
        else _care_plan_events_fallback(request)
    )

    async def event_stream():
        log.info("Care plan stream opened (service stream: %s)", bool(generate_care_plan_stream))
        # Sent immediately so the browser (and any proxy) sees the stream is alive.
        yield json.dumps({"type": "log", "message": "Connected to care plan stream", "ts": now_iso()}) + "\n"
        try:
            async for event in events:
                log.info("Care plan stream event: %s", event.get("type"))
                # Stop work (and the Ollama request) if the browser went away.
                if await http_request.is_disconnected():
                    log.info("Client disconnected; stopping care plan stream.")
                    return

                if event.get("type") == "result":
                    # Audit failure must never suppress the generated draft.
                    try:
                        db.save_audit(
                            "care_plan_draft_generated",
                            request.patient_state.patient_id,
                            event.get("result", {}),
                        )
                    except Exception:
                        log.exception("Could not save care-plan generation audit event")

                yield json.dumps(event, ensure_ascii=False, default=str) + "\n"
        except ValueError as exc:
            yield json.dumps({
                "type": "error",
                "message": "Invalid care plan request.",
                "detail": str(exc),
                "ts": now_iso(),
            }, ensure_ascii=False) + "\n"
        except Exception as exc:
            log.exception("Streaming care-plan generation failed")
            yield json.dumps({
                "type": "error",
                "message": "Care plan generation failed.",
                "detail": str(exc),
                "ts": now_iso(),
            }, ensure_ascii=False) + "\n"
        finally:
            log.info("Care plan stream closed")
            aclose = getattr(events, "aclose", None)
            if aclose:
                await aclose()

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/care-plans")
def create_care_plan(
    request: CarePlanInput,
):

    care_plan_id = request.care_plan_id or str(uuid.uuid4())

    now = now_iso()

    plan_data = request.model_dump()
    if request.status == "approved":
        # Exclude rejected actions from the approved snapshot while retaining
        # the full review record in review_decisions/review_edits.
        plan_data["clinical_objectives"] = [
            item for i, item in enumerate(request.clinical_objectives)
            if request.review_decisions.get(f"now-{i}") == "approved"
        ]
        plan_data["follow_up"] = [
            item for i, item in enumerate(request.follow_up)
            if request.review_decisions.get(f"next-{i}") == "approved"
        ]
        plan_data["review_state"] = "approved"
        event_type = "care_plan_approved"
    else:
        event_type = "care_plan_saved"

    plan = {
        "care_plan_id": care_plan_id,
        **plan_data,
        "created_at": request.created_at or now,
        "updated_at": now,
    }

    db.save_care_plan(
        care_plan_id,
        request.patient_id,
        plan,
    )

    db.save_audit(
        event_type,
        request.patient_id,
        plan,
    )

    return plan


@router.get("/care-plans")
def get_care_plans(patient_id: str, limit: int = 50):
    if not patient_id.strip():
        raise HTTPException(status_code=422, detail="patient_id is required")
    if limit < 1 or limit > 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    rows = db.list_care_plans(patient_id.strip(), limit)
    results = []
    for row in rows:
        plan_data = row.get("plan_json") if isinstance(row, dict) else None
        if isinstance(plan_data, dict):
            results.append({**plan_data, "care_plan_id": row.get("care_plan_id"),
                            "patient_id": row.get("patient_id"), "updated_at": row.get("updated_at")})
        else:
            results.append(row)
    return results


@router.get("/patients/{patient_id}/care-plan")
def get_care_plan(
    patient_id: str,
):

    plan = db.get_latest_care_plan(
        patient_id
    )

    if not plan:
        raise HTTPException(
            status_code=404,
            detail="Care plan not found",
        )

    plan_data = plan.get("plan_json") if isinstance(plan, dict) else None
    if isinstance(plan_data, dict):
        return {**plan_data, "updated_at": plan.get("updated_at", plan_data.get("updated_at"))}
    return plan


@router.get("/patients/{patient_id}/approved-care-plan")
def get_latest_approved_care_plan(patient_id: str):
    plan = db.get_latest_approved_care_plan(patient_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Approved care plan not found")
    plan_data = plan.get("plan_json") if isinstance(plan, dict) else None
    if isinstance(plan_data, dict):
        return {**plan_data, "updated_at": plan.get("updated_at", plan_data.get("updated_at"))}
    return plan


def _validate_reassessment_snapshot(patient_id: str, previous_state: PatientState, care_plan) -> None:
    """Reject a reassessment based on a patient or plan snapshot that is stale."""
    saved_patient = db.get_patient(patient_id)
    if not saved_patient:
        raise HTTPException(status_code=404, detail="Patient not found. Load a saved patient state first.")
    saved_state_data = saved_patient.get("state_json") if isinstance(saved_patient, dict) else None
    try:
        saved_state = PatientState.model_validate(saved_state_data)
    except Exception as exc:
        raise HTTPException(status_code=409, detail="The saved patient state is invalid. Refresh the patient record.") from exc
    if saved_state.model_dump() != previous_state.model_dump():
        raise HTTPException(status_code=409, detail="The patient state changed after this reassessment was opened. Reload the patient and try again.")

    saved_plan = db.get_latest_approved_care_plan(patient_id)
    saved_plan_data = saved_plan.get("plan_json") if isinstance(saved_plan, dict) else None
    saved_plan_id = (saved_plan_data or {}).get("care_plan_id") if isinstance(saved_plan_data, dict) else None
    if not saved_plan_id or saved_plan_id != care_plan.care_plan_id:
        raise HTTPException(status_code=409, detail="The approved care plan changed. Reload the patient and reassess against the current plan.")


@router.post("/reassessment")
def reassessment(
    request: ReassessmentRequest,
):

    if request.previous_state.patient_id != request.current_state.patient_id:
        raise HTTPException(status_code=422, detail="Patient IDs must match for reassessment.")
    if request.care_plan.patient_id != request.current_state.patient_id:
        raise HTTPException(status_code=422, detail="Care plan belongs to a different patient.")
    if request.care_plan.status != "approved":
        raise HTTPException(status_code=422, detail="Reassessment requires an approved care plan.")

    _validate_reassessment_snapshot(
        request.current_state.patient_id,
        request.previous_state,
        request.care_plan,
    )

    result = reassess(
        request.previous_state,
        request.current_state,
        request.care_plan,
    )

    data = (
        result.model_dump()
        if hasattr(result, "model_dump")
        else result
    )

    try:
        db.save_audit(
            "reassessment_generated",
            request.current_state.patient_id,
            data,
        )
    except Exception:
        log.exception("Could not save reassessment generation audit event")

    return data


@router.post("/reassessment/decision")
def record_reassessment_decision(request: ReassessmentDecisionRequest):
    if request.current_state.patient_id != request.patient_id:
        raise HTTPException(status_code=422, detail="Patient ID does not match the reassessment state.")
    if request.previous_state.patient_id != request.patient_id or request.care_plan.patient_id != request.patient_id:
        raise HTTPException(status_code=422, detail="Patient IDs must match for reassessment review.")
    if request.care_plan.status != "approved":
        raise HTTPException(status_code=422, detail="Reassessment requires an approved care plan.")

    _validate_reassessment_snapshot(
        request.patient_id,
        request.previous_state,
        request.care_plan,
    )

    reviewed = reassess(request.previous_state, request.current_state, request.care_plan)
    assessment_data = reviewed.model_dump() if hasattr(reviewed, "model_dump") else reviewed

    if request.decision == "accepted":
        db.upsert_patient(request.patient_id, request.current_state.model_dump())

    record = {
        "decision": request.decision,
        "clinician_note": request.clinician_note,
        "reassessment": assessment_data,
        "patient_state_updated": request.decision == "accepted",
        "recorded_at": now_iso(),
    }
    try:
        db.save_audit("reassessment_decision_recorded", request.patient_id, record)
    except Exception:
        # The accepted state update is already committed; audit failure should
        # be logged without telling the client the clinical update failed.
        log.exception("Could not save reassessment decision audit event")
    return record
