from pathlib import Path
from typing import Any
import os
import re

import fitz

from app.services.evidence.chunker import build_chunks
from app.services.evidence.vector_store import (
    initialize_collection,
    index_chunks,
    search_documents,
    collection_status,
    clean_body,
    parse_categories,
    is_non_clinical_topic,
)

# These are ranking heuristics, not clinical validity scores.
# Similarity is a retrieval signal, not clinical validation.
MIN_EVIDENCE_SCORE = float(os.getenv("OMNIMED_MIN_EVIDENCE_SCORE", "0.50"))
MAX_EVIDENCE_RESULTS = int(os.getenv("OMNIMED_MAX_EVIDENCE_RESULTS", "5"))
MAX_EVIDENCE_CHARS = int(os.getenv("OMNIMED_MAX_EVIDENCE_CHARS", "1400"))
MAX_SUB_QUERIES = 6
TITLE_BONUS = 0.15
PASSAGE_HIT_BONUS = 0.03
RAG_DEBUG = os.getenv("OMNIMED_RAG_DEBUG", "0") == "1"

SYSTEM_DOCUMENT_TERMS = (
    "synthetic medical knowledge base",
    "clinical decision-support system should",
    "professional clinical judgment",
    "system should provide evidence",
    "retrieved evidence should",
    "the system should identify uncertainty",
    "system documentation",
    "architecture overview",
    "developer guide",
)

initialize_collection()


def extract_text_from_file(file_path: str | Path) -> str:
    """Extract text from supported file types."""
    path = Path(file_path)
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        with fitz.open(str(path)) as document:
            return "\n\n".join(
                page.get_text("text").strip()
                for page in document
                if page.get_text("text").strip()
            )

    if suffix in {".txt", ".md", ".markdown"}:
        return path.read_text(encoding="utf-8", errors="ignore")

    raise ValueError(f"Unsupported file type: {suffix}")


def _extract_pdf_pages(file_path: Path) -> list[tuple[int, str]]:
    """Extract page-aware PDF text so citations can name the actual page."""
    with fitz.open(str(file_path)) as document:
        return [
            (index + 1, page.get_text("text").strip())
            for index, page in enumerate(document)
            if page.get_text("text").strip()
        ]


def index_document(
    file_path: str | Path,
    document_id: str,
    title: str | None = None,
    source: str | None = None,
    metadata: dict[str, Any] | None = None,
):
    path = Path(file_path)
    title = title or path.stem
    source = source or path.name
    doc_metadata = dict(metadata or {})

    # Page-aware chunking for PDFs: each page is chunked separately and every
    # chunk retains its real PDF page number. Text files have no page metadata.
    if path.suffix.lower() == ".pdf":
        page_records = _extract_pdf_pages(path)
        chunks: list[dict[str, Any]] = []
        for page_number, page_text in page_records:
            page_chunks = build_chunks(
                text=page_text,
                document_id=f"{document_id}-page-{page_number}",
                title=title,
                source=source,
                metadata={**doc_metadata, "page": page_number},
            )
            for chunk in page_chunks:
                # Use the original document ID for grouping/citation; build_chunks
                # generated stable IDs using the page-specific ID.
                chunk["document_id"] = document_id
                chunk["page"] = page_number
                chunk["page_start"] = page_number
                chunk["page_end"] = page_number
                chunk["metadata"] = {
                    **(chunk.get("metadata") or {}),
                    "page": page_number,
                    "page_start": page_number,
                    "page_end": page_number,
                }
                chunks.append(chunk)
    else:
        text = extract_text_from_file(path)
        chunks = build_chunks(
            text=text,
            document_id=document_id,
            title=title,
            source=source,
            metadata=doc_metadata,
        )

    indexed_count = index_chunks(chunks)
    print(
        f"[OmniMed] Indexed {indexed_count} chunks from {path.name} "
        f"as document_type={doc_metadata.get('document_type', 'unclassified')}."
    )

    return {
        "document_id": document_id,
        "title": title,
        "source": source,
        "chunks": len(chunks),
        "indexed": indexed_count,
        "document_type": doc_metadata.get("document_type", "unclassified"),
    }


def _metadata(result: dict[str, Any]) -> dict[str, Any]:
    value = result.get("metadata")
    return value if isinstance(value, dict) else {}


def _is_system_document(result: dict[str, Any]) -> bool:
    metadata = _metadata(result)
    document_type = str(
        result.get("document_type") or metadata.get("document_type") or ""
    ).strip().lower()

    # Explicit classification wins. Unclassified is not assumed to be clinical.
    if document_type in {"system_documentation", "system", "internal_documentation"}:
        return True
    if document_type in {"clinical_reference", "clinical_guideline", "research_paper"}:
        return False
    if document_type in {"unclassified", ""}:
        title = str(result.get("title") or "")
        source = str(result.get("source") or "")
        text = str(result.get("text") or "")[:600]
        combined = f"{title} {source} {text}".lower()
        return any(term in combined for term in SYSTEM_DOCUMENT_TERMS) or "unclassified" == document_type
    return False


# Words that appear in nearly every health article. They must not count as
# evidence that a passage is relevant to this patient.
GENERIC_QUERY_TERMS = {
    "summarize", "summary", "important", "findings", "identify", "uncertainties",
    "uncertainty", "list", "clinician", "review", "clinical", "patient", "patients",
    "report", "information", "available", "medical", "evidence", "please",
    "explain", "provide", "include", "consider", "assessment", "evaluate",
    "evaluation", "medicine", "medicines", "medication", "medications", "history",
    "family", "health", "care", "test", "tests", "doctor", "provider", "symptom",
    "symptoms", "treatment", "treatments", "risk", "type", "condition",
    "conditions", "problem", "problems", "management", "disease", "diseases",
    "signs", "years", "year", "old", "male", "female", "daily", "dose",
}
QUERY_STOPWORDS = {
    "about", "after", "again", "against", "all", "also", "and", "any", "are",
    "because", "been", "before", "being", "between", "both", "but", "can",
    "could", "did", "does", "during", "each", "for", "from", "had", "has",
    "have", "here", "how", "into", "its", "may", "might", "more", "most",
    "not", "our", "out", "over", "same", "should", "some", "such", "than",
    "that", "the", "their", "them", "then", "there", "these", "they", "this",
    "those", "through", "under", "was", "were", "what", "when", "where",
    "which", "while", "who", "why", "will", "with", "would", "you", "your",
}


def _query_terms(query: str) -> set[str]:
    """Extract meaningful terms from the query, excluding generic instructions."""
    terms = {
        token.lower()
        for token in re.findall(r"[A-Za-z][A-Za-z0-9-]{2,}", query or "")
    }
    return terms - QUERY_STOPWORDS - GENERIC_QUERY_TERMS


def _term_hits(terms: set[str], haystack: str) -> set[str]:
    haystack = haystack.lower()
    return {t for t in terms if re.search(rf"\b{re.escape(t)}", haystack)}


def _lexical_signals(result: dict[str, Any], terms: set[str]) -> tuple[set[str], set[str]]:
    metadata = _metadata(result)
    title = str(result.get("title") or metadata.get("title") or "")
    body = clean_body(str(result.get("text") or ""))
    return _term_hits(terms, title), _term_hits(terms, body)


def _passes_lexical_gate(title_hits: set[str], text_hits: set[str]) -> bool:
    """Strict gate: a query term in the title, or at least two in the passage."""
    return bool(title_hits) or len(text_hits) >= 2


def _is_meta_result(result: dict[str, Any]) -> bool:
    categories = result.get("categories") or parse_categories(str(result.get("text") or ""))
    return is_non_clinical_topic(str(result.get("title") or ""), categories)


def _valid_result(result: dict[str, Any]) -> bool:
    text = str(result.get("text") or "").strip()
    if not text or _is_system_document(result) or _is_meta_result(result):
        return False
    try:
        score = float(result.get("score"))
    except (TypeError, ValueError):
        return False
    return score >= MIN_EVIDENCE_SCORE


def _excerpt(text: str, limit: int = MAX_EVIDENCE_CHARS) -> str:
    text = re.sub(r"\s+", " ", clean_body(text)).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"


def _citation_record(result: dict[str, Any], number: int) -> dict[str, Any]:
    metadata = _metadata(result)
    title = str(result.get("title") or "Untitled source")
    source = str(result.get("source") or "Source unavailable")
    page = result.get("page", metadata.get("page"))
    page_start = result.get("page_start", metadata.get("page_start", page))
    page_end = result.get("page_end", metadata.get("page_end", page))
    section = result.get("section", metadata.get("section"))
    url = result.get("url", metadata.get("url"))
    document_type = result.get(
        "document_type", metadata.get("document_type", "unclassified")
    )
    score = float(result["score"])

    if page_start is not None and page_end is not None and page_start != page_end:
        page_label = f"pp. {page_start}–{page_end}"
    elif page_start is not None:
        page_label = f"p. {page_start}"
    else:
        page_label = None

    return {
        "citation_id": f"E{number}",
        "label": f"[E{number}]",
        "title": title,
        "source": source,
        "document_id": result.get("document_id"),
        "chunk_index": result.get("chunk_index"),
        "document_type": document_type,
        "page": page,
        "page_start": page_start,
        "page_end": page_end,
        "page_label": page_label,
        "section": section,
        "url": url,
        "excerpt": _excerpt(str(result.get("text") or "")),
        "text": str(result.get("text") or "").strip(),
        "score": score,
        "rank_score": result.get("rank_score"),
        "matched_terms": result.get("matched_terms", []),
        "relevance_note": (
            "Passed semantic retrieval and a query-term relevance filter; "
            "this is not clinical validation."
        ),
        "metadata": metadata,
    }


def _source_key(item: dict[str, Any]) -> str:
    metadata = _metadata(item)
    return (
        str(item.get("url") or metadata.get("url") or "").strip().lower()
        or str(item.get("document_id") or metadata.get("document_id") or "").strip().lower()
        or str(item.get("title") or "").strip().lower()
    )


def _normalize_queries(query: str | list[str] | None) -> list[str]:
    if query is None:
        return []
    raw = [query] if isinstance(query, str) else list(query)
    seen: set[str] = set()
    queries: list[str] = []
    for item in raw:
        text = str(item or "").strip()
        if text and text.lower() not in seen:
            seen.add(text.lower())
            queries.append(text)
    return queries[:MAX_SUB_QUERIES]


def retrieve_evidence(query: str | list[str], top_k: int = 5) -> list[dict[str, Any]]:
    """Retrieve evidence for one query or a list of focused queries
    (e.g. one per problem: "hypertension blood pressure", "type 2 diabetes")."""
    queries = _normalize_queries(query)
    if not queries:
        return []
    if top_k < 1:
        raise ValueError("top_k must be at least 1.")

    limit = min(top_k, MAX_EVIDENCE_RESULTS)
    candidate_count = max(top_k * 8, MAX_EVIDENCE_RESULTS * 8)

    ranked_lists: list[list[dict[str, Any]]] = []
    total_candidates = 0

    for sub_query in queries:
        terms = _query_terms(sub_query)
        if not terms:
            print(
                f"[OmniMed] Skipped query with no specific clinical terms: {sub_query[:80]!r}",
                flush=True,
            )
            continue

        candidates = search_documents(query=sub_query, top_k=candidate_count)
        total_candidates += len(candidates)
        eligible: list[dict[str, Any]] = []

        for item in candidates:
            valid = _valid_result(item)
            title_hits, text_hits = _lexical_signals(item, terms)
            passes = valid and _passes_lexical_gate(title_hits, text_hits)

            if RAG_DEBUG:
                print(
                    f"[OmniMed][debug] q={sub_query[:40]!r} score={item.get('score'):.3f} "
                    f"title={item.get('title')!r} valid={valid} "
                    f"title_hits={sorted(title_hits)} text_hits={sorted(text_hits)} "
                    f"pass={passes}",
                    flush=True,
                )
            if not passes:
                continue

            ranked = dict(item)
            ranked["rank_score"] = (
                float(item["score"])
                + (TITLE_BONUS if title_hits else 0.0)
                + PASSAGE_HIT_BONUS * min(len(text_hits), 3)
            )
            ranked["matched_terms"] = sorted(title_hits | text_hits)
            eligible.append(ranked)

        eligible.sort(key=lambda entry: entry["rank_score"], reverse=True)
        ranked_lists.append(eligible)

    # Round-robin across sub-queries so every problem gets coverage, one source
    # at a time, then show the best-ranked evidence first.
    selected: list[dict[str, Any]] = []
    seen_sources: set[str] = set()
    positions = [0] * len(ranked_lists)
    while len(selected) < limit:
        progressed = False
        for i, candidates in enumerate(ranked_lists):
            while positions[i] < len(candidates):
                item = candidates[positions[i]]
                positions[i] += 1
                key = _source_key(item)
                if key and key in seen_sources:
                    continue
                selected.append(item)
                if key:
                    seen_sources.add(key)
                progressed = True
                break
            if len(selected) >= limit:
                break
        if not progressed:
            break

    selected.sort(key=lambda entry: entry["rank_score"], reverse=True)
    citations = [_citation_record(item, i) for i, item in enumerate(selected, 1)]
    print(
        f"[OmniMed] RAG: {len(queries)} query(ies), {total_candidates} candidates; "
        f"{len(citations)} passed type, topic, score, and relevance filters.",
        flush=True,
    )
    if not citations:
        print(
            "[OmniMed] No sufficiently relevant clinical references found. "
            "The brief must state that relevant evidence was unavailable.",
            flush=True,
        )
    return citations


def build_evidence_context(results: list[dict[str, Any]]) -> str:
    """Format evidence as traceable source cards for the LLM prompt."""
    if not results:
        return (
            "EVIDENCE STATUS: NO_RELEVANT_CLINICAL_EVIDENCE\n"
            "No eligible clinical references were retrieved. Do not claim that "
            "the brief is evidence-grounded. Do not invent sources or citations. "
            "State this limitation clearly."
        )

    sections = [
        "EVIDENCE STATUS: CLINICAL_REFERENCES_RETRIEVED",
        "CITATION RULE: Use exact labels such as [E1] only when that source's "
        "excerpt supports the statement. Never invent citations, page numbers, "
        "or URLs. If a claim is not supported, say that evidence is insufficient.",
    ]

    for result in results:
        citation_id = str(result.get("citation_id") or "")
        title = str(result.get("title") or "Untitled source")
        source = str(result.get("source") or "Source unavailable")
        page_label = str(result.get("page_label") or "Page not provided")
        section = str(result.get("section") or "Section not provided")
        url = str(result.get("url") or "URL not provided")
        excerpt = _excerpt(str(result.get("text") or ""))

        sections.append(
            f"\n\n[{citation_id}] SOURCE CARD\n"
            f"Title: {title}\n"
            f"Source: {source}\n"
            f"URL: {url}\n"
            f"Location: {page_label}; {section}\n"
            f"Document type: {result.get('document_type', 'unclassified')}\n"
            f"Relevance note: Retrieval filters passed; this does not prove that "
            f"the source supports a clinical claim.\n"
            f"Passage: {excerpt}"
        )

    return "\n".join(sections)


def format_evidence_for_display(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Create the frontend evidence-panel structure without retrieval scores."""
    if not results:
        return {
            "status": "unavailable",
            "message": (
                "No eligible clinical references were retrieved. Review the original "
                "record and consult an appropriate clinical source."
            ),
            "citations": [],
        }

    citations = []
    for result in results:
        citations.append(
            {
                "citation_id": result.get("citation_id"),
                "label": result.get("label"),
                "title": result.get("title"),
                "source": result.get("source"),
                "document_id": result.get("document_id"),
                "page_label": result.get("page_label"),
                "section": result.get("section"),
                "url": result.get("url"),
                "excerpt": result.get("excerpt"),
                "document_type": result.get("document_type"),
                "relevance_note": result.get("relevance_note"),
            }
        )

    return {
        "status": "available",
        "message": f"{len(citations)} eligible clinical reference(s) retrieved.",
        "citations": citations,
    }


def rag_status():
    return collection_status()