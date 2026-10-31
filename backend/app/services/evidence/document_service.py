from __future__ import annotations

import codecs
import csv
import io
import re
from collections import Counter
from pathlib import Path
from typing import Any

import fitz

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}

# Marker that report_parser uses to recognise CSV text produced by this module.
CSV_MARKER = "CSV REPORT"

# Default csv field limit is 128 KB; medical exports can hold long free-text cells.
_CSV_FIELD_LIMIT = 10_000_000
_MAX_LISTED_ISSUES = 50
_MULTILINE_ROW_WARN = 25


def _usable(text: str) -> bool:
    clean = " ".join(text.split())
    return len(clean) >= 20 and sum(c.isalnum() for c in clean) / max(len(clean), 1) >= 0.35


def assess_ocr_quality(text: str) -> dict[str, Any]:
    """Heuristic OCR signal only; calibrate on a representative report set."""
    clean = " ".join(text.split())
    if not clean:
        return {"score": 0.0, "usable": False, "characters": 0, "reason": "empty"}
    alnum = sum(c.isalnum() for c in clean) / max(len(clean), 1)
    words = re.findall(r"\b[\wµμ./%-]+\b", clean, re.UNICODE)
    length = min(len(clean) / 250.0, 1.0)
    score = max(0.0, min(1.0, 0.45 * alnum + 0.55 * length))
    usable = len(clean) >= 30 and alnum >= 0.30 and score >= 0.55
    return {
        "score": round(score, 3),
        "usable": usable,
        "characters": len(clean),
        "alnum_ratio": round(alnum, 3),
        "word_count": len(words),
        "reason": "ok" if usable else "low_quality_heuristic",
    }


# --------------------------------------------------------------------------- PDF


def extract_pdf_pages(path: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    with fitz.open(path) as doc:
        if doc.needs_pass:
            raise ValueError("The PDF is password-protected and cannot be read.")
        for number, page in enumerate(doc, 1):
            error = None
            try:
                text = page.get_text("text", sort=True).strip()
            except Exception as exc:  # one bad page must not hide the others
                text = ""
                error = f"{type(exc).__name__}: {exc}"
            tables: list[dict[str, Any]] = []
            try:
                for table in page.find_tables().tables:
                    rows = table.extract()
                    if rows:
                        tables.append(
                            {"rows": [[str(c).strip() if c is not None else "" for c in row] for row in rows]}
                        )
            except (AttributeError, RuntimeError, ValueError):
                pass
            output.append(
                {
                    "page": number,
                    "text": text,
                    "needs_ocr": not _usable(text),
                    "tables": tables,
                    "error": error,
                }
            )
    return output


def extract_pdf_text(path: Path) -> str:
    pages = []
    for item in extract_pdf_pages(path):
        text = item["text"]
        table_lines = [" | ".join(row) for table in item["tables"] for row in table["rows"]]
        if table_lines:
            text = (text + "\n\nExtracted tables:\n" + "\n".join(table_lines)).strip()
        if text:
            pages.append(f"[Page {item['page']}]\n{text}")
    return "\n\n".join(pages).strip()


# ----------------------------------------------------------------- text decoding


def decode_bytes(data: bytes) -> tuple[str, str, list[str]]:
    """Decode bytes without ever failing. Returns (text, encoding, warnings)."""
    warnings: list[str] = []
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        try:
            return data.decode("utf-16"), "utf-16", warnings
        except UnicodeDecodeError:
            pass
    try:
        return data.decode("utf-8-sig"), "utf-8", warnings
    except UnicodeDecodeError:
        pass
    try:
        text = data.decode("cp1252")
        warnings.append("File is not valid UTF-8; it was decoded as Windows-1252.")
        return text, "cp1252", warnings
    except UnicodeDecodeError:
        pass
    warnings.append("File encoding could not be determined; it was decoded as Latin-1.")
    return data.decode("latin-1"), "latin-1", warnings


# ------------------------------------------------------------------------- CSV


def _detect_delimiter(text: str) -> str:
    """Pick the delimiter whose column count is most consistent over the first lines."""
    lines = text.splitlines()[:200]
    best, best_score = ",", -1.0
    for candidate in (",", ";", "\t", "|"):
        try:
            rows = [r for r in csv.reader(lines, delimiter=candidate) if r]
        except csv.Error:
            continue
        if not rows:
            continue
        width, count = Counter(len(r) for r in rows).most_common(1)[0]
        if width < 2:
            continue
        score = count / len(rows) + min(width, 20) / 1000.0
        if score > best_score:
            best, best_score = candidate, score
    return best


def _is_number(value: str) -> bool:
    try:
        float(value.replace(",", ""))
        return True
    except ValueError:
        return False


def _looks_like_header(row: list[str]) -> bool:
    cells = [c.strip() for c in row if c and c.strip()]
    if not cells:
        return False
    if any(_is_number(c) for c in cells):
        return False
    lowered = [c.casefold() for c in cells]
    return len(set(lowered)) == len(lowered)


def _unique_labels(row: list[str], width: int) -> list[str]:
    labels: list[str] = []
    seen: Counter[str] = Counter()
    for i in range(width):
        base = row[i].strip() if i < len(row) and row[i].strip() else f"Column {i + 1}"
        seen[base.casefold()] += 1
        labels.append(base if seen[base.casefold()] == 1 else f"{base} (col {i + 1})")
    return labels


def _one_line(value: str) -> str:
    return " ".join(str(value).split())


def parse_csv_text(text: str, delimiter: str) -> tuple[list[tuple[int, list[str]]], dict[str, Any]]:
    """Parse CSV text into (record_number, cells) pairs without dropping rows.

    Record numbers count every record the csv module yields, including blank
    ones, so they line up with the original file for ordinary files.
    """
    csv.field_size_limit(_CSV_FIELD_LIMIT)
    nul_count = text.count("\x00")
    if nul_count:
        text = text.replace("\x00", "")
    reader = csv.reader(
        io.StringIO(text, newline=""),
        delimiter=delimiter,
        quotechar='"',
        doublequote=True,
        strict=False,
    )
    records: list[tuple[int, list[str]]] = []
    issues: list[dict[str, Any]] = []
    blank_rows = 0
    unparsed_rows = 0
    index = 0
    previous_line = 0
    while True:
        try:
            row = next(reader)
        except StopIteration:
            break
        except csv.Error as exc:
            index += 1
            unparsed_rows += 1
            if len(issues) < _MAX_LISTED_ISSUES:
                issues.append({"row": index, "problem": f"Row could not be parsed and was skipped: {exc}"})
            previous_line = reader.line_num
            continue
        index += 1
        span = reader.line_num - previous_line
        previous_line = reader.line_num
        if span >= _MULTILINE_ROW_WARN and len(issues) < _MAX_LISTED_ISSUES:
            issues.append(
                {
                    "row": index,
                    "problem": f"Row spans {span} physical lines; a quote may be unbalanced. "
                    "Its content is kept but later rows may have been merged into it.",
                }
            )
        if not row or all(not str(c).strip() for c in row):
            blank_rows += 1
            continue
        records.append((index, [str(c) for c in row]))
    stats = {
        "issues": issues,
        "blank_rows": blank_rows,
        "unparsed_rows": unparsed_rows,
        "nul_bytes_removed": nul_count,
        "total_records": index,
    }
    return records, stats


def extract_csv_with_info(path: Path) -> tuple[str, dict[str, Any]]:
    """Decode a CSV of any shape and serialise it for the LLM.

    Pure file decoding: no medical field is identified here. Each data row keeps
    its original row number and its column label, e.g.
        Row 7: Test=Hemoglobin | Result=12.1 | Unit=g/dL
    Empty cells are omitted. Rows with extra cells are kept (labelled "Column k").
    """
    text, encoding, warnings = decode_bytes(path.read_bytes())
    info: dict[str, Any] = {"type": "csv", "encoding": encoding, "warnings": list(warnings)}
    if not text.strip():
        info.update({"records": 0, "data_rows": 0, "max_columns": 0, "header_detected": False, "issues": []})
        return "", info

    delimiter = _detect_delimiter(text)
    records, stats = parse_csv_text(text, delimiter)
    info.update(
        {
            "delimiter": delimiter,
            "issues": stats["issues"],
            "blank_rows": stats["blank_rows"],
            "unparsed_rows": stats["unparsed_rows"],
        }
    )
    if stats["nul_bytes_removed"]:
        info["warnings"].append(f"{stats['nul_bytes_removed']} NUL byte(s) were removed before parsing.")
    if stats["unparsed_rows"]:
        info["warnings"].append(
            f"{stats['unparsed_rows']} row(s) could not be parsed and were skipped; see 'issues' for row numbers."
        )
    for issue in stats["issues"]:
        if "spans" in issue["problem"]:
            info["warnings"].append(f"Row {issue['row']}: {issue['problem']}")

    if not records:
        info.update({"records": 0, "data_rows": 0, "max_columns": 0, "header_detected": False})
        return "", info

    width = max(len(cells) for _, cells in records)
    first_number, first_cells = records[0]
    header = _looks_like_header(first_cells)
    labels = _unique_labels(first_cells if header else [], width)
    data_records = records[1:] if header else records

    ragged = [n for n, cells in records if len(cells) != len(first_cells)]
    info.update(
        {
            "records": len(records),
            "data_rows": len(data_records),
            "max_columns": width,
            "header_detected": header,
            "ragged_rows": len(ragged),
            "ragged_row_examples": ragged[:20],
        }
    )
    if ragged:
        info["warnings"].append(
            f"{len(ragged)} row(s) have a different number of columns than the first row; "
            "extra cells are kept and labelled 'Column k'."
        )

    out = [
        CSV_MARKER,
        "Decoded programmatically. Every cell value below is verbatim; empty cells are omitted.",
        f"Records: {len(records)} | Maximum columns: {width} | Delimiter: {delimiter!r} | Encoding: {encoding}",
        'Each data line reads "Row N: label=value | label=value" (N is the record number in the file).',
        (
            "The first row was treated as column labels. If those labels look like data instead, treat them as data."
            if header
            else "No header row was detected; columns are labelled Column 1, Column 2, ..."
        ),
        "",
    ]
    if header:
        out.append(
            f"Row {first_number}: [column labels] "
            + " | ".join(_one_line(c) or "(blank)" for c in first_cells)
        )
    for number, cells in data_records:
        parts = []
        for i in range(max(width, len(cells))):
            value = _one_line(cells[i]) if i < len(cells) else ""
            if not value:
                continue
            label = labels[i] if i < len(labels) else f"Column {i + 1}"
            parts.append(f"{label}={value}")
        if parts:
            out.append(f"Row {number}: " + " | ".join(parts))
    return "\n".join(out).strip(), info


def extract_csv_text(path: Path) -> str:
    return extract_csv_with_info(path)[0]


# ------------------------------------------------------------------- other files


def extract_text_file(path: Path) -> str:
    return decode_bytes(path.read_bytes())[0].strip()


def extract_document_with_info(path: Path, content_type: str | None = None) -> tuple[str, dict[str, Any]]:
    suffix = path.suffix.lower()
    mime = (content_type or "").split(";")[0].strip().lower()
    if suffix == ".pdf" or mime == "application/pdf":
        return extract_pdf_text(path), {"type": "pdf"}
    if suffix == ".csv" or mime in {"text/csv", "application/csv"}:
        return extract_csv_with_info(path)
    if suffix in {".txt", ".md", ".markdown"} or mime.startswith("text/"):
        text, encoding, warnings = decode_bytes(path.read_bytes())
        return text.strip(), {"type": "text", "encoding": encoding, "warnings": warnings}
    if suffix in IMAGE_SUFFIXES or mime.startswith("image/"):
        return "", {"type": "image"}
    raise ValueError(f"Unsupported document format: {suffix or mime or 'unknown'}")


def extract_document(path: Path, content_type: str | None = None) -> str:
    return extract_document_with_info(path, content_type)[0]