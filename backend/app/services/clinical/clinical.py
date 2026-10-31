import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any

from app.services.models.models import PatientState
from app.services.evidence.evidence import (
    search_evidence,
    evidence_context,
)
from app.services.ai.llm import THINK_ENABLED, ollama_generate, ollama_generate_stream, ollama_model_status
from app.core.config import OLLAMA_MODEL
from app.services.clinical.triage import URGENCY_LABELS, merge_urgency, screen_report
from app.services.clinical.clinical_verifier import (
    verify_clinical_brief,
)


URGENCY_LEVELS = ["routine", "urgent", "emergent"]
_LIST = {"type": "array", "items": {"type": "string"}}
_FIELDS = [
    "urgency", "urgency_rationale", "summary", "key_findings", "concerns",
    "clinical_possibilities", "recommended_review", "missing_information", "uncertainty",
]
_TEXT_FIELDS = {"urgency", "urgency_rationale", "summary"}

CLINICAL_BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "urgency": {"type": "string", "enum": URGENCY_LEVELS},
        "urgency_rationale": {"type": "string"},
        "summary": {"type": "string"},
        "key_findings": _LIST,
        "concerns": _LIST,
        "clinical_possibilities": _LIST,
        "recommended_review": _LIST,
        "missing_information": _LIST,
        "uncertainty": _LIST,
    },
    "required": _FIELDS,
    "additionalProperties": False,
}

# "detailed" = full professional brief; "brief" = shortest output (faster on slow hardware).
DETAIL = os.getenv("OMNIMED_DETAIL", "detailed").strip().lower()
LIMITS = (
    "summary at most 2 sentences; every list at most 4 items, each at most 25 words."
    if DETAIL != "brief" else
    "summary at most 20 words; every list at most 2 items, each at most 15 words."
)

RETRY_NOTE = (
    "\n\nRETRY: The previous output was invalid or incomplete. Return a shorter "
    "complete JSON object. Keep every array to at most 2 short strings. Ensure all "
    "strings, arrays, and the object are closed."
)


def extract_json(text: str) -> dict:
    """Parse one complete JSON object from an Ollama response."""
    if not text or not text.strip():
        raise ValueError("Qwen returned an empty response.")

    text = text.strip()
    text = re.sub(r"^\s*```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```\s*$", "", text).strip()

    try:
        result = json.loads(text)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    # Handle explanatory text surrounding an otherwise complete object.
    start = text.find("{")
    if start < 0:
        raise ValueError("Qwen response contains no JSON object.")

    depth = 0
    in_string = False
    escaped = False

    for index in range(start, len(text)):
        char = text[index]

        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1

            if depth == 0:
                candidate = text[start:index + 1]
                try:
                    result = json.loads(candidate)
                    if isinstance(result, dict):
                        return result
                except json.JSONDecodeError:
                    break

    raise ValueError("Qwen returned incomplete or invalid JSON.")


def normalize_string_list(value: Any, maximum: int = 3) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        return [value.strip()] if value.strip() else []

    if isinstance(value, list):
        return [
            str(item).strip()
            for item in value
            if item is not None and str(item).strip()
        ][:maximum]

    return [str(value).strip()]


def validate_clinical_brief(result: dict) -> bool:
    if not isinstance(result, dict) or not all(f in result for f in _FIELDS):
        return False
    if result["urgency"] not in URGENCY_LEVELS:
        return False
    for field in _FIELDS:
        value = result[field]
        if field in _TEXT_FIELDS:
            if not isinstance(value, str):
                return False
        elif not isinstance(value, list) or not all(isinstance(i, str) for i in value):
            return False
    return True


def get_vital(vitals: Any, field_name: str):
    if vitals is None:
        return None

    if hasattr(vitals, field_name):
        return getattr(vitals, field_name, None)

    if isinstance(vitals, dict):
        return vitals.get(field_name)

    return None


def build_fallback_brief(
    state: PatientState,
    evidence: list[dict[str, Any]],
) -> dict:
    """Build basic observations without pretending the LLM succeeded."""
    findings = []

    if state.age is not None:
        findings.append(f"Recorded age: {state.age} years.")

    if state.sex:
        findings.append(f"Recorded sex: {state.sex}.")

    if state.conditions:
        findings.append("Recorded conditions: " + ", ".join(state.conditions[:3]) + ".")

    if state.symptoms:
        findings.append("Reported symptoms: " + ", ".join(state.symptoms[:3]) + ".")

    bp = get_vital(state.vitals, "blood_pressure")
    if bp:
        findings.append(f"Recorded blood pressure: {bp}.")

    concerns = []
    if state.symptoms:
        concerns.append("Reported symptoms require clinician interpretation.")
    if state.conditions:
        concerns.append("Existing conditions should be considered during review.")
    if not evidence:
        concerns.append("No relevant knowledge-base evidence was retrieved.")

    missing = normalize_string_list(
        getattr(state, "missing_information", []),
        maximum=3,
    )

    summary = (
        "AI generation failed. This fallback lists basic recorded "
        "information only and is not a clinical interpretation."
    )

    return {
        "patient_id": state.patient_id,
        "summary": summary,
        "key_findings": findings[:3],
        "concerns": concerns[:3],
        "missing_information": missing,
        "clinical_possibilities": [],
        "evidence": evidence,
        "uncertainty": [
            "No valid AI-generated clinical interpretation was produced.",
            "Verify extracted values against the original report.",
            "Available information is insufficient to establish a diagnosis.",
        ],
        "safety_note": (
            "Fallback only. AI generation failed. This is not a diagnosis "
            "or treatment recommendation. Clinician review is required."
        ),
        "generation_status": "fallback",
        "generation_error": "The model response was incomplete, invalid, or unavailable.",
    }


def attach_verification(
    brief: dict,
    state: PatientState,
    evidence: list[dict[str, Any]],
) -> dict:
    """Attach heuristic safety checks; these are not clinical validation."""
    try:
        verification_result = verify_clinical_brief(
            brief=brief,
            patient_state=state,
            evidence=evidence,
        )

        brief["verification"] = {
            "status": verification_result.get("status", "needs_review"),
            "safe": verification_result.get("safe", False),
            "evidence_grounded": verification_result.get("evidence_grounded", False),
            "issues": verification_result.get("issues", []),
            "warnings": verification_result.get("warnings", []),
            "checks": verification_result.get("verification", {}),
        }
    except Exception as error:
        print(f"[OmniMed] Verification error: {error!r}")
        brief["verification"] = {
            "status": "needs_review",
            "safe": False,
            "evidence_grounded": False,
            "issues": ["Verification could not be completed."],
            "warnings": ["Manual clinician review is required."],
            "checks": {},
        }

    return brief


# --------------------------------------------------------------------------- #
# Shared helpers (used by both the standard and the streaming generator)
# --------------------------------------------------------------------------- #

MAX_QUERY_CONDITIONS = 3
MAX_QUERY_SYMPTOMS = 3
MAX_EVIDENCE_QUERIES = 6
FALLBACK_EVIDENCE_QUERY = "clinical report review missing information uncertainty"


def _clean_items(values: Any) -> list[str]:
    cleaned: list[str] = []
    for value in values or []:
        if value is None:
            continue
        text = re.sub(r"\s+", " ", str(value)).strip(" ,.;:")
        if text:
            cleaned.append(text)
    return cleaned


def build_evidence_queries(state: PatientState, clinical_question=None) -> list[str]:
    """One short, focused query per condition / symptom.

    A single query that joins every condition and symptom lands in a generic
    'medical' region of the embedding space and retrieves generic health-system
    pages. Short per-problem queries retrieve topic-specific references.
    """
    print("[DEBUG] Conditions:", state.conditions, flush=True)
    print("[DEBUG] Symptoms:", state.symptoms, flush=True)
    print("[DEBUG] Timeline:", state.timeline, flush=True)

    queries = (
        _clean_items(state.conditions)[:MAX_QUERY_CONDITIONS]
        + _clean_items(state.symptoms)[:MAX_QUERY_SYMPTOMS]
    )

    if clinical_question:
        question = re.sub(r"\s+", " ", str(clinical_question)).strip()
        if question:
            queries.append(question[:300])

    # Timeline events are only a last resort when there is little else to search.
    if len(queries) < 2:
        timeline_names = _clean_items(
            getattr(event, "name", None) for event in (state.timeline or [])
        )
        if timeline_names:
            queries.append(" ".join(timeline_names[:4]))

    seen: set[str] = set()
    unique: list[str] = []
    for query in queries:
        key = query.lower()
        if key not in seen:
            seen.add(key)
            unique.append(query)

    return unique[:MAX_EVIDENCE_QUERIES] or [FALLBACK_EVIDENCE_QUERY]


def build_evidence_query(state: PatientState, clinical_question=None) -> str:
    """Single-string form, kept for any caller that still expects one query."""
    return " | ".join(build_evidence_queries(state, clinical_question))


def safe_evidence_text(evidence: list[dict[str, Any]]) -> str:
    try:
        return evidence_context(evidence)
    except Exception as error:
        print(f"[OmniMed] Evidence context error: {error!r}")
        return "No relevant evidence was found in the indexed knowledge base."


MAX_NOTE_CHARS = 6000
MAX_EVIDENCE_CHARS = 2000


def compact_patient(state: PatientState) -> str:
    """Patient facts as compact JSON: empty fields dropped, long report text capped.

    Smaller prompts mean faster prompt processing and shorter model reasoning.
    """
    data = {k: v for k, v in state.model_dump().items() if v not in (None, "", [], {})}
    notes = data.get("notes")
    if isinstance(notes, list):
        data["notes"] = [
            n if len(str(n)) <= MAX_NOTE_CHARS else str(n)[:MAX_NOTE_CHARS] + " [report truncated for length]"
            for n in notes
        ]
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str)


def build_prompt(
    state: PatientState,
    evidence_text: str,
    clinical_question=None,
    retry: bool = False,
) -> str:
    question = clinical_question or "Provide a structured, evidence-grounded clinical brief."
    prompt = f"""
You are OmniMed, a clinical decision-support tool. A clinician reviews your output.
Reply with ONE JSON object matching the schema. No text outside the JSON.

Rules:
- Use only facts in PATIENT. Never invent values, history or measurements. Quote numbers exactly as written in PATIENT, with units. Do not calculate new numbers (differences, percentages); describe trends in words.
- No diagnoses, prescriptions, doses or orders. Write neutral observations or questions, not instructions.
- Phrase clinical_possibilities as uncertain (for example "could be consistent with").
- recommended_review lists what the clinician may wish to review or clarify, as neutral noun phrases.
- EVIDENCE is background reference, not patient data.
- urgency: "emergent" if the findings could indicate an immediately life-threatening condition, "urgent" if prompt review is warranted, otherwise "routine". When unsure, choose the higher level.
- urgency_rationale: one sentence naming the specific findings behind the urgency.
- Limits: {LIMITS}
- Think briefly (a few short lines), then answer.

PATIENT:
{compact_patient(state)}

EVIDENCE:
{evidence_text[:MAX_EVIDENCE_CHARS]}

QUESTION:
{question}
""".strip()
    return prompt + RETRY_NOTE if retry else prompt


def report_text(state: PatientState) -> str:
    parts = [str(n) for n in (getattr(state, "notes", None) or [])]
    for field in ("conditions", "symptoms"):
        parts.extend(str(x) for x in (getattr(state, field, None) or []))
    return "\n".join(parts)


def attach_urgency(brief: dict, triage: dict | None, model_level: str | None = None,
                   rationale: str = "") -> dict:
    """Show the higher of the rule-based and model urgency; never lower a rule-based flag."""
    rule_level = triage["level"] if triage else "routine"
    level = merge_urgency(rule_level, model_level)
    brief["urgency"] = {
        "level": level,
        "label": URGENCY_LABELS[level],
        "rationale": (rationale or "").strip(),
        "rule_based_level": rule_level,
        "model_level": model_level,
        "signals": triage["signals"] if triage else [],
        "note": triage["note"] if triage else "",
    }
    return brief


def assemble_brief(state: PatientState, result: dict, evidence: list[dict[str, Any]],
                   triage: dict | None = None) -> dict:
    items = lambda key: normalize_string_list(result[key], maximum=5)  # noqa: E731
    brief = {
        "patient_id": state.patient_id,
        "summary": result["summary"].strip()
        or "The available information requires clinician review.",
        "key_findings": items("key_findings"),
        "concerns": items("concerns"),
        "clinical_possibilities": items("clinical_possibilities"),
        "recommended_review": items("recommended_review"),
        "missing_information": items("missing_information")
        or normalize_string_list(getattr(state, "missing_information", []), maximum=5),
        "evidence": evidence,
        "uncertainty": items("uncertainty")
        or ["Available information is insufficient to establish a diagnosis."],
        "safety_note": (
            "Decision support only. Clinician review is required; "
            "this output is not a diagnosis or treatment order."
        ),
        "generation_status": "success",
    }
    return attach_urgency(brief, triage, result["urgency"], result["urgency_rationale"])


async def generate_clinical_brief(
    state: PatientState,
    clinical_question=None,
) -> dict:
    total_start = time.perf_counter()
    print("\n[OmniMed] Starting evidence-grounded clinical brief...")

    evidence_queries = build_evidence_queries(state, clinical_question)
    print(f"[OmniMed] Evidence queries: {evidence_queries}")
    triage = screen_report(report_text(state))

    evidence: list[dict[str, Any]] = []

    try:
        evidence_start = time.perf_counter()
        evidence = search_evidence(evidence_queries, top_k=3) or []
        print(f"[OmniMed] Evidence retrieval: {time.perf_counter() - evidence_start:.2f}s")
        print(f"[OmniMed] Retrieved {len(evidence)} evidence chunks.")
    except Exception as error:
        print(f"[OmniMed] Evidence retrieval error: {error!r}")

    evidence_text = safe_evidence_text(evidence)
    last_error = None

    for attempt in range(2):
        try:
            llm_start = time.perf_counter()
            print(f"[OmniMed] Sending request to Qwen (attempt {attempt + 1}/2)...")

            raw_response = await ollama_generate(
                build_prompt(state, evidence_text, clinical_question, retry=attempt == 1),
                output_schema=CLINICAL_BRIEF_SCHEMA,
            )

            print(f"[OmniMed] Qwen generation: {time.perf_counter() - llm_start:.2f}s")
            print(f"[OmniMed] Qwen response length: {len(raw_response)} characters")

            result = extract_json(raw_response)

            if not validate_clinical_brief(result):
                raise ValueError("Qwen response does not match the required schema.")

            brief = attach_verification(
                assemble_brief(state, result, evidence, triage), state, evidence
            )

            print(f"[OmniMed] Total time: {time.perf_counter() - total_start:.2f}s")
            return brief

        except Exception as error:
            last_error = error
            print(f"[OmniMed] Generation attempt {attempt + 1} failed: {error!r}")

    fallback = attach_urgency(build_fallback_brief(state, evidence), triage)
    fallback["generation_error"] = str(last_error or "Unknown generation error")
    fallback = attach_verification(fallback, state, evidence)

    print(
        f"[OmniMed] Returning fallback after generation failure. "
        f"Total time: {time.perf_counter() - total_start:.2f}s"
    )
    return fallback


# --------------------------------------------------------------------------- #
# Streaming generator
# --------------------------------------------------------------------------- #

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


async def generate_clinical_brief_stream(state: PatientState, clinical_question=None):
    """Yield NDJSON-ready events for one generation attempt (no retry loop).

    Event types: backend_log {text, level, ts}, progress {stage, status, label, detail,
    duration_ms?, ts}, thinking, thinking_end {seconds, limited?}, live_output, result.
    Every value comes from the real pipeline or from Ollama.
    """
    total_start = time.perf_counter()

    def log_event(message: str, level: str = "info") -> dict[str, Any]:
        print(f"[OmniMed] {message}", flush=True)
        return {"type": "backend_log", "text": f"[OmniMed] {message}", "level": level, "ts": _now()}

    def stage(stage_id: str, status: str, label: str, detail: str = "",
              started: float | None = None, **extra: Any) -> dict[str, Any]:
        event: dict[str, Any] = {
            "type": "progress", "stage": stage_id, "status": status,
            "label": label, "detail": detail, "ts": _now(), **extra,
        }
        if started is not None:
            event["duration_ms"] = int((time.perf_counter() - started) * 1000)
        return event

    state_info: dict[str, Any] = {"thinking_available": False, "thinking_seconds": None, "evidence_ms": 0}

    def meta() -> dict[str, Any]:
        return {
            "model": OLLAMA_MODEL, "attempts": 1,
            "thinking_available": state_info["thinking_available"],
            "thinking_seconds": state_info["thinking_seconds"],
            "evidence_ms": state_info["evidence_ms"],
            "elapsed_seconds": round(time.perf_counter() - total_start, 2),
            "generated_at": _now(),
        }

    # 1. Patient context -------------------------------------------------------
    yield log_event("Starting evidence-grounded clinical brief...")
    context_start = time.perf_counter()
    yield stage("patient_context", "active", "Preparing patient context",
                "Preparing available patient information.")
    evidence_queries = build_evidence_queries(state, clinical_question)
    yield log_event(f"Evidence queries ({len(evidence_queries)}): {json.dumps(evidence_queries)[:300]}")
    yield stage("patient_context", "completed", "Patient context prepared",
                "Patient context is ready for analysis.", context_start)

    # Instant rule-based urgency screening: shown while the model is still working.
    triage = screen_report(report_text(state))
    yield log_event(
        f"Urgency screening (rule-based): {triage['level'].upper()}, "
        f"{len(triage['signals'])} signal(s)",
        "info" if triage["level"] == "routine" else "warn")
    yield {"type": "triage", "triage": triage, "ts": _now()}

    # 2. Evidence retrieval (blocking client -> worker thread keeps the stream live)
    yield stage("evidence_retrieval", "active", "Retrieving evidence",
                "Searching the indexed medical knowledge base.")
    evidence: list[dict[str, Any]] = []
    evidence_failed = False
    evidence_start = time.perf_counter()
    try:
        evidence = await asyncio.to_thread(search_evidence, evidence_queries, top_k=3) or []
        yield log_event(
            f"Evidence retrieval: {time.perf_counter() - evidence_start:.2f}s, "
            f"{len(evidence)} chunk(s) retrieved", "ok")
    except Exception as error:
        evidence_failed = True
        yield log_event(f"Evidence retrieval error: {error!r}", "warn")
    state_info["evidence_ms"] = int((time.perf_counter() - evidence_start) * 1000)
    evidence_text = safe_evidence_text(evidence)
    yield stage(
        "evidence_retrieval", "failed" if evidence_failed else "completed",
        "Evidence retrieval failed" if evidence_failed else "Evidence retrieval finished",
        "Continuing without reference evidence." if evidence_failed
        else f"Retrieved {len(evidence)} reference passage(s).",
        evidence_start, evidence_count=len(evidence),
    )

    # 3-4. Generation (reasoning is time-budgeted) and validation ---------------
    prompt = build_prompt(state, evidence_text, clinical_question)
    yield log_event(f"Prompt size: {len(prompt):,} characters")
    status = await ollama_model_status()
    if status["loaded"] is False:
        yield log_event("Model is not loaded in Ollama. This request must load it first, which can "
                        "take 30+ s. It then stays loaded for 30 minutes.", "warn")
    elif status["loaded"]:
        gpu = status["gpu_percent"]
        slow = gpu is not None and gpu < 95
        yield log_event(
            f"Model loaded in Ollama, {gpu if gpu is not None else '?'}% in GPU memory"
            + (" (the rest runs on CPU, which makes prompt processing and generation much slower)" if slow else ""),
            "warn" if slow else "info")
    if not THINK_ENABLED:
        yield log_event("Reasoning is turned off (OMNIMED_THINK=off) for speed.")
    yield log_event("Sending request to Qwen...")
    yield stage("qwen_generation", "active", "Qwen is generating the clinical brief",
                "Receiving streamed output from Ollama.")

    parts: list[str] = []
    phase = "qwen_generation"
    llm_start = time.perf_counter()
    last_error: Exception | None = None
    try:
        async for item in ollama_generate_stream(
            prompt, output_schema=CLINICAL_BRIEF_SCHEMA, think=THINK_ENABLED,
        ):
            kind = item.get("type")
            if kind == "first_token":
                yield log_event(
                    f"First model output after {item['seconds']:.1f}s "
                    "(model load + prompt processing)",
                    "warn" if item["seconds"] > 10 else "info")
            elif kind == "thinking" and item.get("text"):
                state_info["thinking_available"] = True
                yield {"type": "thinking", "text": item["text"]}
            elif kind == "thinking_end":
                state_info["thinking_seconds"] = item.get("seconds")
                yield {"type": "thinking_end", "seconds": item.get("seconds"),
                       "limited": bool(item.get("limited"))}
            elif kind == "thinking_budget":
                yield log_event(
                    f"Reasoning limited to {item['seconds']}s / {item['characters']:,} characters "
                    "to keep generation fast; requesting the answer now.", "warn")
            elif kind == "thinking_unsupported":
                yield log_event(
                    f"Model {item.get('model')} does not support separate thinking; "
                    "continuing without it.", "warn")
            elif kind == "response" and item.get("text"):
                parts.append(item["text"])
                yield {"type": "live_output", "text": item["text"]}
            elif kind == "done":
                eval_ns, eval_count = item.get("eval_duration"), item.get("eval_count")
                if eval_ns and eval_count:
                    yield log_event(
                        f"Generation speed: {eval_count / (eval_ns / 1e9):.1f} tokens/s "
                        f"({eval_count} tokens; model load {(item.get('load_duration') or 0) / 1e9:.1f}s, "
                        f"prompt {(item.get('prompt_eval_duration') or 0) / 1e9:.1f}s)")

        raw_response = "".join(parts).strip()
        yield log_event(f"Qwen generation: {time.perf_counter() - llm_start:.2f}s", "ok")
        yield log_event(f"Qwen response length: {len(raw_response)} characters")
        yield stage("qwen_generation", "completed", "Qwen generation finished",
                    f"{len(raw_response):,} characters generated.", llm_start)

        phase = "validation"
        validation_start = time.perf_counter()
        yield stage("validation", "active", "Validating the clinical brief",
                    "Checking the required response fields and structure.")

        result = extract_json(raw_response)
        if not validate_clinical_brief(result):
            raise ValueError("Qwen response does not match the required schema.")
        yield log_event("Qwen response parsed successfully.", "ok")

        brief = attach_verification(assemble_brief(state, result, evidence, triage), state, evidence)
        brief["generation_meta"] = meta()

        verification = brief.get("verification", {})
        yield log_event(f"Verification status: {verification.get('status', 'unknown')}",
                        "ok" if verification.get("safe") else "warn")
        yield log_event(f"Total time: {time.perf_counter() - total_start:.2f}s", "ok")
        yield stage("validation", "completed", "Validation finished",
                    "Output structure checked; review verification status before relying on the brief.",
                    validation_start)
        yield stage("completed", "completed", "Clinical brief ready",
                    "The brief is ready for clinician review.")
        yield {"type": "result", "result": brief, "ts": _now()}
        return

    except Exception as error:
        last_error = error
        yield log_event(f"Generation failed during {phase}: {error!r}", "error")
        yield stage(phase, "failed",
                    "Generation failed" if phase == "qwen_generation" else "Validation failed",
                    str(error)[:240])

    # 5. Fallback (immediate, no second model call) -----------------------------
    fallback = attach_urgency(build_fallback_brief(state, evidence), triage)
    fallback["generation_error"] = str(last_error or "Unknown generation error")
    fallback = attach_verification(fallback, state, evidence)
    fallback["generation_meta"] = meta()
    yield log_event("AI generation did not produce a valid brief; returning fallback "
                    "based on recorded information.", "error")
    yield log_event(f"Total time: {time.perf_counter() - total_start:.2f}s")
    yield stage("completed", "completed", "Fallback brief ready",
                "AI generation did not produce a valid brief; showing recorded facts only.")
    yield {"type": "result", "result": fallback, "ts": _now()}