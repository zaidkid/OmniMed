from __future__ import annotations

import hashlib
import re
from typing import Any


def normalize_text(text: str) -> str:
    """Normalize whitespace while retaining paragraph boundaries."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(lines).strip()


def chunk_text(
    text: str,
    chunk_size: int = 800,
    chunk_overlap: int = 150,
) -> list[str]:
    """Create overlapping chunks, preferring paragraph boundaries."""
    text = normalize_text(text)
    if not text:
        return []
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero.")
    if chunk_overlap < 0 or chunk_overlap >= chunk_size:
        raise ValueError("chunk_overlap must be non-negative and smaller than chunk_size.")

    paragraphs = [
        part.strip()
        for part in re.split(r"\n\s*\n", text)
        if part.strip()
    ]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        if len(paragraph) > chunk_size:
            if current:
                chunks.append(current)
                current = ""
            start = 0
            while start < len(paragraph):
                end = min(start + chunk_size, len(paragraph))
                part = paragraph[start:end].strip()
                if part:
                    chunks.append(part)
                if end >= len(paragraph):
                    break
                start = end - chunk_overlap
            continue

        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= chunk_size:
            current = candidate
        else:
            if current:
                chunks.append(current)
            overlap = current[-chunk_overlap:] if chunk_overlap else ""
            current = f"{overlap}\n\n{paragraph}".strip()

    if current:
        chunks.append(current)
    return chunks


def _stable_point_id(document_id: str, chunk_index: int) -> int:
    """Return a repeatable positive integer suitable for a Qdrant point ID."""
    key = f"{document_id}:{chunk_index}".encode("utf-8")
    digest = hashlib.sha256(key).digest()
    return int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)


def _infer_document_type(
    metadata: dict[str, Any],
    title: str,
    source: str,
) -> str:
    """Use explicit metadata where possible; infer only obvious system docs."""
    explicit = metadata.get("document_type")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().lower()

    label = f"{title} {source}".lower()
    system_terms = (
        "synthetic medical knowledge base",
        "system documentation",
        "architecture",
        "prompt guide",
        "safety rules",
        "developer guide",
        "omnimed design",
    )
    if any(term in label for term in system_terms):
        return "system_documentation"

    # Do not automatically call an unknown document clinical evidence.
    return "unclassified"


def build_chunks(
    text: str,
    document_id: str,
    title: str,
    source: str,
    metadata: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    base_metadata = dict(metadata or {})
    document_type = _infer_document_type(base_metadata, title, source)
    clinical_topics = base_metadata.get("clinical_topics", [])
    if not isinstance(clinical_topics, list):
        clinical_topics = [str(clinical_topics)]

    raw_chunks = chunk_text(text)
    chunks = []
    for index, chunk in enumerate(raw_chunks):
        chunk_metadata = dict(base_metadata)
        chunk_metadata["document_type"] = document_type
        chunk_metadata["clinical_topics"] = clinical_topics
        chunks.append(
            {
                "id": _stable_point_id(document_id, index),
                "document_id": document_id,
                "chunk_index": index,
                "text": chunk,
                "title": title,
                "source": source,
                "metadata": chunk_metadata,
                "document_type": document_type,
                "clinical_topics": clinical_topics,
                # Page/section metadata should be supplied by the ingestion
                # layer when it extracts page-aware PDF content.
                "page": base_metadata.get("page"),
                "page_start": base_metadata.get("page_start"),
                "page_end": base_metadata.get("page_end"),
                "section": base_metadata.get("section"),
                "url": base_metadata.get("url"),
            }
        )
    return chunks
