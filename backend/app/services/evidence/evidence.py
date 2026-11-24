import hashlib
from typing import Any

from app.services.evidence.chunker import build_chunks
from app.services.evidence.vector_store import index_chunks

from app.services.evidence.rag import (
    index_document,
    retrieve_evidence,
    build_evidence_context,
    rag_status,
)


def index_evidence(
    file_path: str,
    document_id: str,
    title: str | None = None,
    source: str | None = None,
    metadata: dict[str, Any] | None = None,
):
    return index_document(
        file_path=file_path,
        document_id=document_id,
        title=title,
        source=source,
        metadata=metadata,
    )


def index_text_evidence(
    title: str,
    source: str,
    text: str,
    metadata: dict[str, Any] | None = None,
):
    """Chunk and index text submitted from the Evidence Library UI."""
    clean_title = title.strip()
    clean_source = source.strip()
    clean_text = text.strip()
    if not clean_title or not clean_text:
        raise ValueError("Evidence title and text are required.")

    digest = hashlib.sha256(
        f"{clean_title}\0{clean_source}\0{clean_text}".encode("utf-8")
    ).hexdigest()[:24]
    document_id = f"manual-evidence-{digest}"
    doc_metadata = dict(metadata or {})
    doc_metadata.setdefault("document_type", "clinical_reference")
    doc_metadata.setdefault("source_type", "user_supplied")
    chunks = build_chunks(
        text=clean_text,
        document_id=document_id,
        title=clean_title,
        source=clean_source or "User supplied",
        metadata=doc_metadata,
    )
    indexed = index_chunks(chunks)
    return {
        "document_id": document_id,
        "title": clean_title,
        "source": clean_source or "User supplied",
        "chunks": len(chunks),
        "indexed": indexed,
        "document_type": doc_metadata["document_type"],
    }


def search_evidence(
    query: str | list[str],
    top_k: int = 3,
):
    """query may be one string or a list of focused queries (one per problem)."""
    if isinstance(query, str):
        if not query.strip():
            raise ValueError("Search query cannot be empty.")
    elif not any(str(item).strip() for item in (query or [])):
        raise ValueError("Search query cannot be empty.")

    if top_k < 1:
        raise ValueError("top_k must be at least 1.")

    return retrieve_evidence(
        query=query,
        top_k=top_k,
    )


def evidence_context(results):
    return build_evidence_context(results)


def evidence_status():
    return rag_status()
