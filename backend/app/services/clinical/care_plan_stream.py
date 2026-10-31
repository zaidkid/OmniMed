"""Streaming care-plan endpoint (NDJSON).

Stages: read -> evidence -> reason -> draft -> structure.
Every event carries both `event` and `type` (same value) so the frontend can
read whichever key it expects. The final event is `result` (plan under both
`care_plan` and `result`). Only real model output is forwarded; nothing is faked.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.ai.llm import BRIEF_NUM_CTX, ollama_generate_stream
from app.services.clinical.care_plan import (
    CARE_PLAN_SCHEMA,
    MAX_ATTEMPTS,
    PLAN_ANSWER_NUM_PREDICT,
    PLAN_NUM_PREDICT,
    PLAN_THINK,
    PLAN_THINK_CHARS,
    PLAN_THINK_SECONDS,
    build_context,
    build_evidence_query,
    finalize_care_plan,
    retrieve_evidence,
    retry_note,
    review_attempt,
    validate_inputs,
)
from app.services.models.models import PatientState

logger = logging.getLogger(__name__)

router = APIRouter()


class CarePlanRequest(BaseModel):
    patient_state: PatientState
    clinical_brief: dict[str, Any]
    clinician_note: str | None = None


def ev(name: str, **data: Any) -> str:
    return json.dumps({"event": name, "type": name, **data}, ensure_ascii=False, default=str) + "\n"


async def _events(req: CarePlanRequest) -> AsyncIterator[str]:
    started = time.perf_counter()
    try:
        # 1. Read: patient state + clinical brief
        yield ev("stage", stage="read")
        validate_inputs(req.patient_state, req.clinical_brief)
        query = build_evidence_query(req.patient_state, req.clinical_brief)
        yield ev("log", level="info", message="Loaded clinical brief and patient state")

        # 2. Evidence: guidelines from the Qdrant store
        yield ev("stage", stage="evidence")
        evidence = await retrieve_evidence(query)
        yield ev(
            "log",
            level="ok" if evidence else "warn",
            message=(
                f"Retrieved {len(evidence)} evidence passages"
                if evidence
                else "No relevant evidence retrieved; the plan will not cite any"
            ),
        )
        ctx = build_context(req.patient_state, req.clinical_brief, req.clinician_note, evidence)

        # 3-4. Reason + draft (one retry if the answer is invalid or has empty core sections)
        best: dict[str, Any] | None = None
        meta: dict[str, Any] = {}
        note = ""
        attempts = 0

        for attempt in range(MAX_ATTEMPTS):
            attempts = attempt + 1
            if attempt == 0:
                yield ev("stage", stage="reason")
            text, drafting = "", False

            async for item in ollama_generate_stream(
                ctx.prompt + note,
                CARE_PLAN_SCHEMA,
                num_predict=PLAN_NUM_PREDICT,
                think=PLAN_THINK and attempt == 0,  # the retry skips thinking for speed
                num_ctx=BRIEF_NUM_CTX,  # same as warm-up: no model reload
                think_budget_seconds=PLAN_THINK_SECONDS,
                think_budget_chars=PLAN_THINK_CHARS,
                answer_num_predict=PLAN_ANSWER_NUM_PREDICT,
            ):
                kind = item["type"]
                if kind == "thinking":
                    yield ev("thinking", text=item["text"])
                elif kind == "thinking_end":
                    yield ev("thinking_end", seconds=item.get("seconds"), limited=bool(item.get("limited")))
                elif kind == "thinking_budget":
                    yield ev("log", level="info", message=f"Reasoning budget reached after {item['seconds']} s; drafting now")
                elif kind == "thinking_unsupported":
                    yield ev("log", level="warn", message="This model does not support thinking; continuing without it")
                elif kind == "response":
                    if not drafting:
                        drafting = True
                        yield ev("stage", stage="draft")
                    text += item["text"]
                    yield ev("token", text=item["text"])
                elif kind == "done":
                    text = item["text"]
                    meta = {
                        "model": item.get("model"),
                        "eval_count": item.get("eval_count"),
                        "thinking_seconds": item.get("thinking_seconds"),
                    }

            # 5. Structure: parse + validate
            yield ev("stage", stage="structure")
            plan, problem = review_attempt(text)
            best = plan or best
            if not problem:
                break
            yield ev("log", level="warn", message=f"Attempt {attempts} rejected: {problem}. Retrying once...")
            note = retry_note(problem)

        if best is None:
            raise ValueError("The model did not return a valid care plan. Please try again.")

        meta.update(attempts=attempts, elapsed_seconds=round(time.perf_counter() - started, 1))
        care_plan = finalize_care_plan(ctx, best, meta)
        yield ev("log", level="ok", message="Care plan structured and validated (status: draft)")
        yield ev("result", care_plan=care_plan, result=care_plan)

    except Exception as exc:  # CancelledError (client disconnect) is not caught here
        logger.exception("Care-plan stream failed")
        yield ev("error", detail=str(exc), message=str(exc))


@router.post("/api/care-plans/stream")
async def stream_care_plan(req: CarePlanRequest) -> StreamingResponse:
    return StreamingResponse(
        _events(req),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )