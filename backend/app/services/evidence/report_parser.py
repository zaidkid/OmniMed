from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Annotated, Any, NamedTuple, Optional

import httpx
from pydantic import BaseModel, BeforeValidator, Field, ValidationError

from app.core.config import OLLAMA_BASE_URL, OLLAMA_MODEL
from app.services.ai.llm import (
    OllamaEmptyResponseError,
    OllamaOutputLimitError,
    ollama_generate_with_meta,
)

log = logging.getLogger(__name__)

# ------------------------------------------------------------------ settings
# Sized for qwen3:4b: ~6000 chars of dense lab text is ~2-3k tokens, so
# prompt (+instructions) + up to 4096 output tokens fits in an 8192 context.
CHUNK_CHAR_LIMIT = int(os.getenv("OMNIMED_EXTRACT_CHUNK_CHARS", "6000"))
LLM_NUM_CTX = int(os.getenv("OMNIMED_EXTRACT_NUM_CTX", "8192"))
LLM_CONCURRENCY = max(1, int(os.getenv("OMNIMED_EXTRACT_CONCURRENCY", "1")))
LLM_MAX_ATTEMPTS = 2  # one retry for malformed / empty / invalid output
MAX_SPLIT_DEPTH = 3

CSV_MARKER = "CSV REPORT"
PAGE_RE = re.compile(r"(?m)^\[Page\s+(\d+)\]\s*$")
ROW_RE = re.compile(r"^Row\s+(\d+):")


# ------------------------------------------------------------ response schema
class ExtractedField(BaseModel):
    value: str | None = None
    source_text: str | None = None
    page: int | None = None
    row: int | None = None
    method: str = "ollama_text"
    # Only filled when the model or a documented scoring method provides one.
    # Verification below sets `verified`, never a made-up confidence number.
    confidence: float | None = Field(default=None, ge=0, le=1)
    verified: bool = False
    needs_review: bool = False
    review_reason: str | None = None


class ExtractedLabResult(BaseModel):
    test: ExtractedField = Field(default_factory=ExtractedField)
    result: ExtractedField = Field(default_factory=ExtractedField)
    unit: ExtractedField = Field(default_factory=ExtractedField)
    reference_range: ExtractedField = Field(default_factory=ExtractedField)
    flag: ExtractedField = Field(default_factory=ExtractedField)
    timestamp: ExtractedField = Field(default_factory=ExtractedField)


class StructuredMedicalReport(BaseModel):
    patient_id: ExtractedField = Field(default_factory=ExtractedField)
    patient_name: ExtractedField = Field(default_factory=ExtractedField)
    age: ExtractedField = Field(default_factory=ExtractedField)
    sex: ExtractedField = Field(default_factory=ExtractedField)
    report_date: ExtractedField = Field(default_factory=ExtractedField)
    facility: ExtractedField = Field(default_factory=ExtractedField)
    conditions: list[ExtractedField] = Field(default_factory=list)
    medications: list[ExtractedField] = Field(default_factory=list)
    allergies: list[ExtractedField] = Field(default_factory=list)
    vitals: dict[str, ExtractedField] = Field(default_factory=dict)
    labs: list[ExtractedLabResult] = Field(default_factory=list)
    notes: list[ExtractedField] = Field(default_factory=list)
    extraction_warnings: list[str] = Field(default_factory=list)
    extraction_trace: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------- what the model must return (JSON schema)
LLM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "patient_id": {"type": ["string", "null"]},
        "patient_name": {"type": ["string", "null"]},
        "age": {"type": ["string", "null"]},
        "sex": {"type": ["string", "null"]},
        "report_date": {"type": ["string", "null"]},
        "facility": {"type": ["string", "null"]},
        "conditions": {"type": "array", "items": {"type": "string"}},
        "medications": {"type": "array", "items": {"type": "string"}},
        "allergies": {"type": "array", "items": {"type": "string"}},
        "vitals": {"type": "object", "additionalProperties": {"type": "string"}},
        "labs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "test": {"type": "string"},
                    "timestamp": {"type": "string"},
                    "result": {"type": "string"},
                    "unit": {"type": "string"},
                    "reference_range": {"type": "string"},
                    "flag": {"type": "string"},
                    "source_text": {"type": "string"},
                },
                "required": ["test", "timestamp", "result", "unit", "reference_range", "flag", "source_text"],
            },
        },
        "notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "patient_id", "patient_name", "age", "sex", "report_date", "facility",
        "conditions", "medications", "allergies", "vitals", "labs", "notes",
    ],
}

SCALAR_FIELDS = ("patient_id", "patient_name", "age", "sex", "report_date", "facility")
LIST_FIELDS = ("conditions", "medications", "allergies", "notes")


# ---- Pydantic models that VALIDATE the model's raw JSON (tolerant of numbers/nulls)
def _coerce_scalar(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        raise ValueError("expected a text value, got a nested structure")
    text = str(value).strip()
    return text or None


def _coerce_list(value: Any) -> Any:
    if value is None:
        return []
    if isinstance(value, (str, int, float)):
        return [value]
    return value


def _coerce_dict(value: Any) -> Any:
    return {} if value is None else value


Scalar = Annotated[Optional[str], BeforeValidator(_coerce_scalar)]


class LLMLab(BaseModel):
    test: Scalar = None
    timestamp: Scalar = None
    result: Scalar = None
    unit: Scalar = None
    reference_range: Scalar = None
    flag: Scalar = None
    source_text: Scalar = None


class LLMChunk(BaseModel):
    patient_id: Scalar = None
    patient_name: Scalar = None
    age: Scalar = None
    sex: Scalar = None
    report_date: Scalar = None
    facility: Scalar = None
    conditions: Annotated[list[Scalar], BeforeValidator(_coerce_list)] = Field(default_factory=list)
    medications: Annotated[list[Scalar], BeforeValidator(_coerce_list)] = Field(default_factory=list)
    allergies: Annotated[list[Scalar], BeforeValidator(_coerce_list)] = Field(default_factory=list)
    notes: Annotated[list[Scalar], BeforeValidator(_coerce_list)] = Field(default_factory=list)
    vitals: Annotated[dict[str, Scalar], BeforeValidator(_coerce_dict)] = Field(default_factory=dict)
    labs: list[LLMLab] = Field(default_factory=list)


# ------------------------------------------------------------------ helpers
def ai_extraction_cache_key(text: str) -> str:
    return hashlib.sha256(" ".join((text or "").split()).encode("utf-8")).hexdigest()


def _norm(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


def _collapse(value: str) -> str:
    return " ".join((value or "").split())


# ------------------------------------------------------ chunking (deterministic)
def _hard_split(text: str, limit: int) -> list[str]:
    """Split on line boundaries; split a single over-long line only as a last resort."""
    limit = max(100, limit)
    pieces: list[str] = []
    current: list[str] = []
    size = 0
    for line in text.split("\n"):
        while len(line) > limit:
            if current:
                pieces.append("\n".join(current))
                current, size = [], 0
            pieces.append(line[:limit])
            line = line[limit:]
        add = len(line) + 1
        if current and size + add > limit:
            pieces.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += add
    if current:
        pieces.append("\n".join(current))
    return [p for p in pieces if p.strip()]


def _pack(units: list[str], limit: int, sep: str = "\n\n") -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for unit in units:
        add = len(unit) + len(sep)
        if current and size + add > limit:
            chunks.append(sep.join(current))
            current, size = [], 0
        current.append(unit)
        size += add
    if current:
        chunks.append(sep.join(current))
    return chunks


def _split_row_line(line: str, budget: int) -> list[str]:
    """Split one very wide CSV row at cell boundaries, keeping its row number."""
    match = ROW_RE.match(line)
    if not match:
        return _hard_split(line, budget)
    head = match.group(0)
    cells = line[len(head):].strip().split(" | ")
    pieces: list[str] = []
    current: list[str] = []
    size = 0
    for cell in cells:
        while len(cell) > budget - 40:
            if current:
                pieces.append(current)
                current, size = [], 0
            pieces.append([cell[: budget - 40]])
            cell = cell[budget - 40:]
        if current and size + len(cell) + 3 > budget - 40:
            pieces.append(current)
            current, size = [], 0
        current.append(cell)
        size += len(cell) + 3
    if current:
        pieces.append(current)
    return [
        (f"{head} " if i == 0 else f"{head} (continued) ") + " | ".join(p) for i, p in enumerate(pieces)
    ]


def _split_csv(text: str, limit: int) -> list[str]:
    lines = text.split("\n")
    first = next((i for i, line in enumerate(lines) if ROW_RE.match(line)), None)
    if first is None:
        return _pack(_hard_split(text, limit), limit)
    prefix = "\n".join(lines[:first]).strip()
    budget = max(200, limit - len(prefix) - 2)
    units: list[str] = []
    for line in lines[first:]:
        if not line.strip():
            continue
        units.extend([line] if len(line) <= budget else _split_row_line(line, budget))
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for unit in units:
        if current and size + len(unit) + 1 > budget:
            chunks.append(prefix + "\n" + "\n".join(current))
            current, size = [], 0
        current.append(unit)
        size += len(unit) + 1
    if current:
        chunks.append(prefix + "\n" + "\n".join(current))
    return chunks


def _split_chunks(text: str, limit: int = CHUNK_CHAR_LIMIT) -> list[str]:
    """Partition text into chunks that together contain every character of content.

    CSV: whole rows are batched; the preamble is repeated in every chunk and each
    row line carries its own column labels and original row number.
    PDF/OCR: whole pages are packed; a page larger than the limit is split on
    line boundaries and its [Page N] marker is repeated.
    """
    text = text or ""
    if not text.strip():
        return []
    limit = max(300, limit)
    if text.startswith(CSV_MARKER):
        return [c for c in _split_csv(text, limit) if c.strip()]
    pages = list(PAGE_RE.finditer(text))
    if not pages:
        return _pack(_hard_split(text, limit), limit)
    units: list[str] = []
    lead = text[: pages[0].start()].strip()
    if lead:
        units.extend(_hard_split(lead, limit))
    for i, match in enumerate(pages):
        end = pages[i + 1].start() if i + 1 < len(pages) else len(text)
        body = text[match.end():end].strip()
        if not body:
            continue
        header = f"[Page {match.group(1)}]"
        whole = f"{header}\n{body}"
        if len(whole) <= limit:
            units.append(whole)
        else:
            units.extend(f"{header}\n{piece}" for piece in _hard_split(body, limit - len(header) - 1))
    return _pack(units, limit)


# --------------------------------------------- source verification (deterministic)
class Seg(NamedTuple):
    page: Optional[int]
    row: Optional[int]
    text: str  # whitespace-collapsed, original case
    lower: str


class Hit(NamedTuple):
    excerpt: str
    page: Optional[int]
    row: Optional[int]


def _segments(chunk: str) -> list[Seg]:
    segs: list[Seg] = []

    def add(page: Optional[int], row: Optional[int], raw: str) -> None:
        collapsed = _collapse(raw)
        if collapsed:
            segs.append(Seg(page, row, collapsed, collapsed.lower()))

    pages = list(PAGE_RE.finditer(chunk))
    if pages:
        add(None, None, chunk[: pages[0].start()])
        for i, match in enumerate(pages):
            end = pages[i + 1].start() if i + 1 < len(pages) else len(chunk)
            add(int(match.group(1)), None, chunk[match.end():end])
        return segs
    if chunk.startswith(CSV_MARKER):
        for line in chunk.split("\n"):
            m = ROW_RE.match(line)
            if m:
                add(None, int(m.group(1)), line)
        return segs
    add(1, None, chunk)
    return segs


def _find_in(needle_lower: str, hay_lower: str) -> int:
    if not needle_lower:
        return -1
    if len(needle_lower) >= 4:
        return hay_lower.find(needle_lower)
    match = re.search(r"(?<![\w.])" + re.escape(needle_lower) + r"(?![\w.])", hay_lower)
    return match.start() if match else -1


def _locate(value: str, segs: list[Seg]) -> Optional[Hit]:
    needle = _collapse(value).lower()
    if not needle:
        return None
    for seg in segs:
        pos = _find_in(needle, seg.lower)
        if pos < 0:
            continue
        if seg.row is not None:
            excerpt = seg.text[:400]
        elif len(seg.lower) == len(seg.text):
            start = max(0, pos - 70)
            excerpt = seg.text[start: pos + len(needle) + 70]
        else:
            excerpt = value
        return Hit(excerpt, seg.page, seg.row)
    return None


def _find_segment(source: Optional[str], segs: list[Seg]) -> Optional[int]:
    needle = _collapse(source or "").lower()
    if len(needle) < 3:
        return None
    for i, seg in enumerate(segs):
        if needle in seg.lower:
            return i
    return None


def _field(value: Optional[str], segs: list[Seg]) -> ExtractedField:
    if not value:
        return ExtractedField()
    hit = _locate(value, segs)
    if hit:
        return ExtractedField(value=value, source_text=hit.excerpt, page=hit.page, row=hit.row, verified=True)
    return ExtractedField(
        value=value,
        needs_review=True,
        review_reason="Value was not found in the source text; the model may have inferred it. Verify it.",
    )


def _lab_field(
    value: Optional[str], segs: list[Seg], hint: Optional[int], *, required: bool = False
) -> ExtractedField:
    if not value:
        if required:
            return ExtractedField(needs_review=True, review_reason="Missing in the model output; verify the source.")
        return ExtractedField()
    if hint is not None:
        hit = _locate(value, [segs[hint]])
        if hit:
            return ExtractedField(value=value, source_text=hit.excerpt, page=hit.page, row=hit.row, verified=True)
    hit = _locate(value, segs)
    if hit:
        reason = (
            "The model's quoted source row could not be matched; the value appears elsewhere in this section."
            if hint is None
            else "The value is not in the quoted source row; it appears elsewhere in this section."
        )
        return ExtractedField(
            value=value, source_text=hit.excerpt, page=hit.page, row=hit.row, needs_review=True, review_reason=reason
        )
    return ExtractedField(
        value=value,
        needs_review=True,
        review_reason="Value was not found in the source text; the model may have inferred it. Verify it.",
    )


# --------------------------------------------------------------- LLM plumbing
class _ContextTruncated(RuntimeError):
    pass


RETRYABLE = {"malformed_json", "empty_response", "schema_validation"}
SPLITTABLE = {"output_limit", "context_length"}
FATAL = {"ollama_unreachable", "model_not_installed"}


def classify_llm_error(exc: BaseException, model: str | None = None) -> tuple[str, str]:
    model = model or OLLAMA_MODEL
    if isinstance(exc, _ContextTruncated):
        return "context_length", str(exc)
    if isinstance(exc, OllamaOutputLimitError):
        return "output_limit", "The model's answer was cut off at the output-token limit."
    if isinstance(exc, OllamaEmptyResponseError):
        return "empty_response", "The model returned an empty response."
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        return "ollama_unreachable", f"Could not connect to Ollama at {OLLAMA_BASE_URL}. Make sure Ollama is running."
    if isinstance(exc, httpx.TimeoutException):
        return "ollama_timeout", "Ollama did not answer before the request timed out."
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            body = exc.response.text or ""
        except Exception:
            body = ""
        status = exc.response.status_code
        if status == 404 or "not found" in body.lower():
            return "model_not_installed", f"Model '{model}' is not available in Ollama. Run: ollama pull {model}"
        if "context" in body.lower():
            return "context_length", "Ollama rejected the request because it exceeded the model's context length."
        return "ollama_http_error", f"Ollama returned HTTP {status}: {body[:200]}"
    if isinstance(exc, httpx.HTTPError):
        return "ollama_connection_error", f"Connection to Ollama failed: {type(exc).__name__}"
    if isinstance(exc, json.JSONDecodeError):
        return "malformed_json", "The model returned malformed JSON."
    if isinstance(exc, ValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        return "schema_validation", f"The model's JSON did not match the expected schema ({where}: {first.get('msg', 'invalid')})."
    if isinstance(exc, ValueError):
        return "schema_validation", f"The model's JSON did not match the expected schema: {exc}"
    return "unexpected_error", f"{type(exc).__name__}: {exc}"


def _parse_llm_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        fenced = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
        data = json.loads(fenced)  # raises JSONDecodeError if still invalid
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object at the top level")
    return data


def _validate_chunk(data: dict[str, Any]) -> tuple[LLMChunk, list[str]]:
    warnings: list[str] = []
    raw_labs = data.get("labs", [])
    if raw_labs is None:
        raw_labs = []
    if not isinstance(raw_labs, list):
        raise ValueError("'labs' must be a list")
    chunk = LLMChunk.model_validate({k: v for k, v in data.items() if k != "labs"})
    for n, item in enumerate(raw_labs, 1):
        try:
            chunk.labs.append(LLMLab.model_validate(item))
        except ValidationError as exc:
            first = exc.errors()[0] if exc.errors() else {}
            warnings.append(f"Laboratory item {n} failed schema validation and was skipped ({first.get('msg', 'invalid')}).")
    return chunk, warnings


def _prompt(chunk: str, index: int, total: int, part: str | None) -> str:
    where = f"chunk {index} of {total}" + (f" (sub-part {part})" if part else "")
    return f'''You are a precise medical-document information extraction engine.
Return ONLY a JSON object matching the supplied JSON schema. Do not include markdown or commentary.
This is {where}. Extract all supported information present in THIS chunk. Other chunks may contain additional information.

CORE RULES
- Treat the supplied document text as the source of truth. Map information into the correct schema fields using labels, headings, table headers, nearby context, and row/column relationships.
- Do not diagnose, give advice, infer unstated facts, or invent values. Use null for missing scalar values and empty arrays/objects when a category is absent.
- Text may come from PDF extraction, OCR, Markdown, plain text, or CSV. Tables may have been flattened into whitespace-aligned lines, pipe-separated cells, or label=value pairs.
- Do not assume a fixed order of fields or columns. Map by the actual header/label, not by column position alone. Interpret combined labels such as "Age / Sex: 62 / Male" only when the relationship is clear from the source.
- If a table header is separated from its rows, use it to interpret the rows in this same chunk. If a row cannot be mapped confidently, do not guess; place relevant unclassified source content in notes when appropriate.
- CSV lines may look like "Row N: label=value | label=value". Treat each label as a column name; labels and columns can vary. Empty cells may be omitted. The first row may contain headers or data.

PATIENT AND REPORT FIELDS
- Map patient_id, patient_name, age, sex, report_date, and facility only from explicitly stated source information.
- Map conditions, medications, and allergies as separate items, preserving the wording in the document.
- Put relevant findings or clinical text that does not fit another field in notes. Keep notes concise and source-grounded.

LABORATORY RESULTS
- Return one labs object for EACH distinct measurement/observation.
- Each labs object must contain test, timestamp, result, unit, reference_range, flag, and source_text.
- Preserve repeated tests at different times or dates as separate rows. Never merge them merely because the test name matches.
- Map result, unit, reference range, flag, and timestamp using the same row and the corresponding column headers. Do not shift values between columns.
- Preserve the result, units, signs, decimal places, reference range, and flag as written. An empty cell should be an empty string or null, not a guessed value.
- Copy flags only when they are present in the source. Do not independently label a result normal, high, low, or abnormal.
- Do not mistake digits in patient IDs, timestamps, or reference ranges for a test result.
- source_text must be a short verbatim excerpt from THIS chunk that contains the specific measurement and, where possible, its row context.

VITAL SIGNS
- Return vitals as an object mapping each vital-sign name to the value exactly as reported.
- Preserve repeated observations. Include the time/date in the key when needed, for example "Blood pressure (07:00)" and "Blood pressure (10:00)".
- Keep units with the value when the source reports them. Do not combine different observations or overwrite one observation with another.

OUTPUT QUALITY
- Include all supported items in the chunk, not just the first few.
- Do not confuse section headings, IDs, timestamps, or reference ranges with clinical values.
- Do not duplicate an item unless it represents a distinct source observation.
- Never fabricate source_text. Return only JSON conforming to the schema.

DOCUMENT CHUNK:
{chunk}
'''


@dataclass
class ChunkOutcome:
    chunk: int
    part: Optional[str]
    chars: int
    text: str
    status: str = "pending"  # completed | failed | skipped
    error_code: Optional[str] = None
    error: Optional[str] = None
    data: Optional[LLMChunk] = None
    warnings: list[str] = field(default_factory=list)
    attempts: int = 0
    duration_ms: int = 0
    prompt_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    model: Optional[str] = None


async def _run_chunk(
    chunk_text: str,
    index: int,
    total: int,
    *,
    model: str | None,
    sem: asyncio.Semaphore,
    state: dict[str, Any],
    depth: int = 0,
    part: str | None = None,
) -> list[ChunkOutcome]:
    outcome = ChunkOutcome(chunk=index, part=part, chars=len(chunk_text), text=chunk_text)

    def skipped() -> list[ChunkOutcome]:
        outcome.status = "skipped"
        outcome.error_code = "not_attempted"
        outcome.error = f"Not attempted because an earlier request failed: {state['fatal']}"
        return [outcome]

    started = time.perf_counter()
    last_code = last_msg = None
    for attempt in range(1, LLM_MAX_ATTEMPTS + 1):
        outcome.attempts = attempt
        try:
            async with sem:
                if state.get("fatal"):
                    return skipped()
                meta = await ollama_generate_with_meta(
                    _prompt(chunk_text, index, total, part),
                    LLM_SCHEMA,
                    model=model,
                    num_ctx=LLM_NUM_CTX,
                )
            used = meta.get("prompt_eval_count")
            if used and LLM_NUM_CTX and used >= LLM_NUM_CTX - 16:
                raise _ContextTruncated(
                    f"The prompt used {used} of {LLM_NUM_CTX} context tokens, so the input was probably truncated."
                )
            data = _parse_llm_json(meta["text"])
            validated, warns = _validate_chunk(data)
        except Exception as exc:  # CancelledError is a BaseException and still propagates
            last_code, last_msg = classify_llm_error(exc, model)
            log.warning("LLM extraction chunk %s%s attempt %s failed: %s", index, f".{part}" if part else "", attempt, last_code)
            if last_code in RETRYABLE and attempt < LLM_MAX_ATTEMPTS:
                continue
            break
        else:
            outcome.status = "completed"
            outcome.data = validated
            outcome.warnings = warns
            outcome.prompt_tokens = meta.get("prompt_eval_count")
            outcome.output_tokens = meta.get("eval_count")
            outcome.model = meta.get("model")
            outcome.duration_ms = int((time.perf_counter() - started) * 1000)
            return [outcome]

    outcome.duration_ms = int((time.perf_counter() - started) * 1000)
    if last_code in SPLITTABLE and depth < MAX_SPLIT_DEPTH:
        pieces = _split_chunks(chunk_text, limit=max(300, len(chunk_text) // 2))
        if len(pieces) >= 2:
            results: list[ChunkOutcome] = []
            for n, piece in enumerate(pieces, 1):
                results += await _run_chunk(
                    piece, index, total, model=model, sem=sem, state=state,
                    depth=depth + 1, part=f"{part}.{n}" if part else str(n),
                )
            return results
    if last_code in FATAL:
        state["fatal"] = last_msg
    outcome.status = "failed"
    outcome.error_code = last_code
    outcome.error = last_msg
    return [outcome]




def _extract_demographics(text: str) -> tuple[ExtractedField, ExtractedField]:
    """Extract age and sex only when explicitly labelled in the source text.

    Supports separate fields (Age: 28 years; Sex: Male) and combined fields
    (Age/Sex: 28 years / Male). It deliberately does not infer demographics
    from names, diagnoses, or unrelated numbers.
    """
    source = text or ""
    age_value: str | None = None
    sex_value: str | None = None

    sex_pattern = r"(?:female|male|non[- ]?binary|intersex|unknown|unspecified|woman|man|f|m)"
    age_pattern = r"(\d{1,3})\s*(?:years?\s*old|years?|yrs?\.?|y/o)\b"

    # Combined labels, e.g. "Age / Sex: 28 years / Male" or "Age/Sex 28/M".
    combined_patterns = [
        re.compile(
            rf"(?i)\b(?:age\s*/\s*sex|age\s+and\s+sex|age-sex)\s*[:=\\-]?\s*"
            rf"(?P<age>\d{{1,3}})\s*(?:years?\s*old|years?|yrs?\.?|y/o)?\s*"
            rf"[/,;|]\s*(?P<sex>{sex_pattern})\b"
        ),
        re.compile(
            rf"(?i)\b(?:age\s*/\s*sex|age\s+and\s+sex|age-sex)\s*[:=\\-]?\s*"
            rf"(?P<age>\d{{1,3}})\s*[/,;|]\s*(?P<sex>{sex_pattern})\b"
        ),
    ]
    for pattern in combined_patterns:
        match = pattern.search(source)
        if match:
            raw_age = match.group("age")
            raw_sex = match.group("sex")
            if 0 <= int(raw_age) <= 120:
                age_value = f"{raw_age} years"
            sex_value = _normalize_sex(raw_sex)
            break

    # Separate explicitly labelled age field.
    if age_value is None:
        age_match = re.search(
            rf"(?im)\b(?:patient\s+)?age\b\s*[:=]\s*{age_pattern}",
            source,
        )
        if age_match:
            number = re.search(r"\d{1,3}", age_match.group(0))
            if number and 0 <= int(number.group(0)) <= 120:
                age_value = f"{number.group(0)} years"

    # Also support "Age: 28" where the unit is omitted.
    if age_value is None:
        age_match = re.search(
            r"(?im)\b(?:patient\s+)?age\b\s*[:=]\s*(\d{1,3})(?!\d)",
            source,
        )
        if age_match and 0 <= int(age_match.group(1)) <= 120:
            age_value = f"{age_match.group(1)} years"

    # Separate explicitly labelled sex/gender field.
    if sex_value is None:
        sex_match = re.search(
            rf"(?im)\b(?:patient\s+)?(?:sex|gender)\b\s*[:=]\s*({sex_pattern})\b",
            source,
        )
        if sex_match:
            sex_value = _normalize_sex(sex_match.group(1))

    segments = _segments(source)
    age_field = _field(age_value, segments) if age_value else ExtractedField(
        needs_review=True,
        review_reason="Age was not found in an explicitly labelled source field. Confirm it from the report.",
    )
    sex_field = _field(sex_value, segments) if sex_value else ExtractedField(
        needs_review=True,
        review_reason="Sex was not found in an explicitly labelled source field. Confirm it from the report.",
    )
    # The age field is normalized to include "years"; if the original says only
    # "Age: 28", locate the numeric token as evidence too.
    if age_value and not age_field.verified:
        number = re.search(r"\d{1,3}", age_value)
        if number:
            hit = _locate(number.group(0), segments)
            if hit:
                age_field = ExtractedField(
                    value=age_value, source_text=hit.excerpt, page=hit.page,
                    row=hit.row, verified=True
                )
    return age_field, sex_field


def _normalize_sex(value: str) -> str:
    normalized = value.strip().casefold()
    if normalized in {"m", "male", "man"}:
        return "Male"
    if normalized in {"f", "female", "woman"}:
        return "Female"
    if normalized in {"nonbinary", "non-binary"}:
        return "Non-binary"
    if normalized == "intersex":
        return "Intersex"
    if normalized in {"unknown", "unspecified"}:
        return normalized.title()
    return value.strip()

# ---------------------------------------------------------------- public API
def _empty_counts() -> dict[str, int]:
    return {"labs": 0, "conditions": 0, "medications": 0, "allergies": 0, "notes": 0, "vitals": 0}


def build_failed_report(
    message: str,
    *,
    stage: str = "llm_structuring",
    code: str = "unexpected_error",
    input_characters: int = 0,
    status: str = "failed",
    model: str | None = None,
) -> dict[str, Any]:
    """A valid report object with no extracted fields and an explicit error."""
    trace = {
        "status": status,
        "structuring_status": status,
        "complete": False,
        "stage": stage,
        "provider": None,
        "model": None,
        "method": "raw_text_only",
        "reasoning_policy": "Private chain-of-thought is not exposed. This trace shows processing steps, validation and source evidence only.",
        "input_characters": input_characters,
        "chunks_total": 0,
        "chunks_completed": 0,
        "chunks_failed": 0,
        "chunks_skipped": 0,
        "chunks": [],
        "errors": [{"stage": stage, "code": code, "message": message}],
        "stages": [{"id": stage, "label": "Raw text", "status": status, "detail": message}],
        "summary": {"lab_rows_returned": 0, "conditions": 0, "medications": 0, "allergies": 0, "vitals": 0, "notes": 0,
                    "scalar_fields_found": 0, "verified_fields": 0, "fields_needing_review": 0},
    }
    return StructuredMedicalReport(
        extraction_warnings=[message], extraction_trace=trace
    ).model_dump()


def _all_fields(report: StructuredMedicalReport) -> list[ExtractedField]:
    fields = [getattr(report, k) for k in SCALAR_FIELDS]
    fields += report.conditions + report.medications + report.allergies + report.notes
    fields += list(report.vitals.values())
    for lab in report.labs:
        fields += [lab.test, lab.result, lab.unit, lab.reference_range, lab.flag, lab.timestamp]
    return fields


async def parse_medical_report(
    text: str,
    method_by_page: dict[int, str] | None = None,
    *,
    model: str | None = None,
) -> dict[str, Any]:
    """Extract explicitly labelled demographics without inventing missing values.

    Full LLM field mapping remains disabled in this workflow. Age and sex are
    parsed deterministically because the upload validation requires these fields.
    All other report content remains available to the caller as extracted text.
    """
    started = time.perf_counter()
    source = text or ""
    if not source.strip():
        return build_failed_report(
            "No readable text was supplied.",
            stage="text_extraction",
            code="no_text",
            status="failed",
        )

    age_field, sex_field = _extract_demographics(source)
    warnings: list[str] = []
    if not age_field.value:
        warnings.append(
            "Age was not extracted from an explicitly labelled field. Confirm the patient's age."
        )
    if not sex_field.value:
        warnings.append(
            "Sex was not extracted from an explicitly labelled field. Confirm the patient's sex."
        )

    segments = _segments(source)
    fields = [age_field, sex_field]
    verified_count = sum(1 for item in fields if item.verified)
    review_count = sum(1 for item in fields if item.needs_review)
    trace = {
        "status": "completed" if age_field.value and sex_field.value else "partial",
        "structuring_status": "completed" if age_field.value and sex_field.value else "partial",
        "complete": False,
        "stage": "demographic_extraction",
        "provider": None,
        "model": None,
        "method": "deterministic_labelled_field_extraction",
        "reasoning_policy": "No diagnosis or unstated demographic values are inferred.",
        "input_characters": len(source),
        "chunks_total": 0,
        "chunks_completed": 0,
        "chunks_failed": 0,
        "chunks_skipped": 0,
        "chunks": [],
        "errors": [],
        "stages": [
            {
                "id": "demographic_extraction",
                "label": "Patient demographics",
                "status": "completed" if age_field.value and sex_field.value else "partial",
                "detail": "Extracted age and sex only when explicitly labelled in source text.",
            },
            {
                "id": "llm_mapping",
                "label": "Full medical field mapping",
                "status": "skipped",
                "detail": "Full LLM-based field mapping remains disabled; original extracted text is retained by the upload workflow.",
            },
        ],
        "summary": {
            "lab_rows_returned": 0,
            "conditions": 0,
            "medications": 0,
            "allergies": 0,
            "vitals": 0,
            "notes": 0,
            "scalar_fields_found": sum(
                1 for value in (age_field, sex_field) if value.value
            ),
            "verified_fields": verified_count,
            "fields_needing_review": review_count,
        },
    }

    report = StructuredMedicalReport(
        age=age_field,
        sex=sex_field,
        extraction_warnings=warnings,
        extraction_trace=trace,
    )
    return report.model_dump()


async def improve_medical_report_with_ai(
    extracted_text: str,
    structured_report: dict[str, Any] | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    improved = await parse_medical_report(extracted_text, model=model)
    if structured_report and isinstance(structured_report, dict):
        prior = structured_report.get("extraction_warnings", [])
        current = improved.get("extraction_warnings", [])
        improved["extraction_warnings"] = list(
            dict.fromkeys([*(prior if isinstance(prior, list) else []), *(current if isinstance(current, list) else [])])
        )
    return improved