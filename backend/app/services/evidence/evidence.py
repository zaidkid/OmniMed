from typing import Any

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