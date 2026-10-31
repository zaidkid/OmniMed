from __future__ import annotations

import asyncio
import hashlib
import json
import logging
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

from app.core.config import OLLAMA_MODEL, UPLOAD_DIR

from app.services.models.models import (
    PatientInput,
    CarePlanInput,
    CarePlanGenerationRequest,
    ReassessmentRequest,
    ClinicalBriefRequest,
    EvidenceSearchRequest,
    EvidenceIndexRequest,
)

from app.services.patient.patient_state import (
    build_patient_state,
)

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
    index_evidence,
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

from app.services.ai.llm import check_ollama, ollama_warm_up


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

    # Load the model while the document is being extracted, so generation has no cold start.
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

    # No text is a real failure (and is not an HTTPException caught by a broad
    # except, which previously rewrote this message and deleted the file).
    if not extracted_text or not extracted_text.strip():
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


@router.get("/documents")
def get_documents(
    patient_id: Optional[str] = None,
):

    return db.list_documents(patient_id)


@router.post("/evidence/index")
def add_evidence(
    request: EvidenceIndexRequest,
):

    return index_evidence(
        request.title,
        request.source,
        request.text,
        request.metadata,
    )


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

    return {
        "indexed_evidence_items": len(
            db.list_evidence()
        )
    }


@router.get("/ai/status")
async def ai_status():

    try:

        return {
            "status": "connected",
            "provider": "Ollama",
            "model": OLLAMA_MODEL,
            "ollama": await check_ollama(),
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

    care_plan_id = str(uuid.uuid4())

    now = now_iso()

    plan = {
        "care_plan_id": care_plan_id,
        **request.model_dump(),
        "created_at": now,
        "updated_at": now,
    }

    db.save_care_plan(
        care_plan_id,
        request.patient_id,
        plan,
    )

    db.save_audit(
        "care_plan_saved",
        request.patient_id,
        plan,
    )

    return plan


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

    return plan


@router.post("/reassessment")
def reassessment(
    request: ReassessmentRequest,
):

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

    db.save_audit(
        "reassessment_generated",
        request.current_state.patient_id,
        data,
    )

    return data