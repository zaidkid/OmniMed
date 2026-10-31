from pathlib import Path
from typing import Any
import os
import re

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from sentence_transformers import SentenceTransformer


# =========================================================
# CONFIGURATION
# =========================================================

BASE_DIR = Path(__file__).resolve().parents[2]
QDRANT_PATH = BASE_DIR / "data" / "qdrant"
# New collection name on purpose: embeddings from a different model must never
# be mixed with the old all-MiniLM-L6-v2 index.
COLLECTION_NAME = os.getenv("OMNIMED_COLLECTION", "omnimed_evidence_v2")
EMBEDDING_MODEL_NAME = os.getenv("OMNIMED_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
QUERY_PREFIX = (
    "Represent this sentence for searching relevant passages: "
    if "bge" in EMBEDDING_MODEL_NAME.lower()
    else ""
)
TOP_K = 5

QDRANT_PATH.mkdir(parents=True, exist_ok=True)
client = QdrantClient(path=str(QDRANT_PATH))

print("[OmniMed] Loading embedding model...")
embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
VECTOR_SIZE = embedding_model.get_sentence_embedding_dimension()
print(f"[OmniMed] Embedding model: {EMBEDDING_MODEL_NAME} (dimension {VECTOR_SIZE})")


# =========================================================
# MEDLINEPLUS TEXT HELPERS
# =========================================================

# MedlinePlus topics that are about the health system, not clinical content.
# They match almost any medical query and are never useful as clinical evidence.
META_CATEGORIES = {"health system", "personal health issues"}
META_TITLES = {
    "patient safety",
    "understanding medical research",
    "evaluating health information",
    "health insurance",
    "health fraud",
    "patient rights",
    "medical ethics",
}

_HEADER_RE = re.compile(r"^\s*Medical topic:.*?Summary:\s*", re.IGNORECASE | re.DOTALL)
_CATEGORIES_RE = re.compile(r"Categories:\s*(.*?)\s*Summary:", re.IGNORECASE | re.DOTALL)
_ALT_NAMES_RE = re.compile(r"Alternative names:\s*(.*?)\s*Categories:", re.IGNORECASE | re.DOTALL)


def clean_body(text: str) -> str:
    """Remove the 'Medical topic / Alternative names / Categories / Summary' header."""
    return _HEADER_RE.sub("", text or "", count=1).strip()


def parse_categories(text: str) -> list[str]:
    match = _CATEGORIES_RE.search(text or "")
    if not match:
        return []
    return [part.strip() for part in re.split(r"[,;]", match.group(1)) if part.strip()]


def parse_alternative_names(text: str) -> str:
    match = _ALT_NAMES_RE.search(text or "")
    if not match:
        return ""
    value = match.group(1).strip()
    return "" if value.lower() in {"", "not provided", "none"} else value


def is_non_clinical_topic(title: str, categories: list[str] | None) -> bool:
    if (title or "").strip().lower() in META_TITLES:
        return True
    cats = {c.strip().lower() for c in (categories or []) if c.strip()}
    return bool(cats) and cats.issubset(META_CATEGORIES)


def build_embedding_text(title: str, text: str) -> str:
    """Embed topic title + alternative names + body, without boilerplate."""
    parts = []
    if title:
        parts.append(title.strip())
    alt = parse_alternative_names(text)
    if alt:
        parts.append(f"Also called: {alt}")
    body = clean_body(text)
    if body:
        parts.append(body)
    return ". ".join(parts)


# =========================================================
# COLLECTION
# =========================================================

def initialize_collection():
    collections = client.get_collections().collections
    collection_names = [collection.name for collection in collections]

    if COLLECTION_NAME not in collection_names:
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )
        print(f"[OmniMed] Created Qdrant collection: {COLLECTION_NAME}")
        return

    try:
        existing_size = client.get_collection(COLLECTION_NAME).config.params.vectors.size
        if existing_size != VECTOR_SIZE:
            raise RuntimeError(
                f"Collection {COLLECTION_NAME} has dimension {existing_size} but the "
                f"embedding model produces {VECTOR_SIZE}. Use a new OMNIMED_COLLECTION name."
            )
    except AttributeError:
        pass
    print(f"[OmniMed] Qdrant collection already exists: {COLLECTION_NAME}")


def embed_texts(texts: list[str], is_query: bool = False):
    if not texts:
        return []
    if is_query and QUERY_PREFIX:
        texts = [QUERY_PREFIX + text for text in texts]
    embeddings = embedding_model.encode(
        texts,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return [embedding.tolist() for embedding in embeddings]


def _normalize_metadata(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def index_chunks(chunks: list[dict[str, Any]]) -> int:
    if not chunks:
        return 0

    # Categories only appear in the first chunk of a MedlinePlus topic, so share
    # them with the other chunks of the same document in this batch.
    categories_by_doc: dict[str, list[str]] = {}
    for chunk in chunks:
        cats = parse_categories(str(chunk.get("text") or ""))
        if cats:
            categories_by_doc.setdefault(str(chunk.get("document_id", "")), cats)

    kept: list[tuple[int, dict[str, Any], list[str]]] = []
    skipped = 0
    for index, chunk in enumerate(chunks):
        categories = categories_by_doc.get(str(chunk.get("document_id", "")), [])
        if is_non_clinical_topic(str(chunk.get("title") or ""), categories):
            skipped += 1
            continue
        kept.append((index, chunk, categories))

    if skipped:
        print(f"[OmniMed] Skipped {skipped} non-clinical (health-system) chunks.")
    if not kept:
        return 0

    display_texts = [str(chunk.get("text") or "") for _, chunk, _ in kept]
    embed_inputs = [
        build_embedding_text(str(chunk.get("title") or ""), text)
        for (_, chunk, _), text in zip(kept, display_texts)
    ]
    embeddings = embed_texts(embed_inputs)
    points = []

    for position, (index, chunk, categories) in enumerate(kept):
        metadata = _normalize_metadata(chunk.get("metadata"))
        document_type = (
            chunk.get("document_type")
            or metadata.get("document_type")
            or "unclassified"
        )
        clinical_topics = (
            chunk.get("clinical_topics")
            or metadata.get("clinical_topics")
            or []
        )
        point_id = chunk.get("id", index)

        payload = {
            "text": display_texts[position],
            "source": chunk.get("source", ""),
            "title": chunk.get("title", ""),
            "document_id": chunk.get("document_id", ""),
            "chunk_index": chunk.get("chunk_index", index),
            "metadata": metadata,
            "document_type": document_type,
            "clinical_topics": clinical_topics,
            "categories": categories,
            "page": chunk.get("page", metadata.get("page")),
            "page_start": chunk.get("page_start", metadata.get("page_start")),
            "page_end": chunk.get("page_end", metadata.get("page_end")),
            "section": chunk.get("section", metadata.get("section")),
            "url": chunk.get("url", metadata.get("url")),
        }
        points.append(
            PointStruct(id=point_id, vector=embeddings[position], payload=payload)
        )

    client.upsert(collection_name=COLLECTION_NAME, points=points)
    print(f"[OmniMed] Indexed {len(points)} chunks into Qdrant.")
    return len(points)


def search_documents(query: str, top_k: int = TOP_K) -> list[dict[str, Any]]:
    query = query.strip()
    if not query:
        return []
    if top_k < 1:
        raise ValueError("top_k must be at least 1.")

    if COLLECTION_NAME not in {
        collection.name for collection in client.get_collections().collections
    }:
        return []

    query_embedding = embed_texts([query], is_query=True)[0]
    results = client.query_points(
        collection_name=COLLECTION_NAME,
        query=query_embedding,
        limit=top_k,
        with_payload=True,
    ).points

    output = []
    for result in results:
        payload = result.payload or {}
        metadata = _normalize_metadata(payload.get("metadata"))
        output.append(
            {
                "text": payload.get("text", ""),
                "source": payload.get("source", ""),
                "title": payload.get("title", ""),
                "document_id": payload.get("document_id", ""),
                "chunk_index": payload.get("chunk_index", 0),
                "metadata": metadata,
                "document_type": payload.get(
                    "document_type", metadata.get("document_type", "unclassified")
                ),
                "clinical_topics": payload.get(
                    "clinical_topics", metadata.get("clinical_topics", [])
                ),
                "categories": payload.get("categories", []),
                "page": payload.get("page", metadata.get("page")),
                "page_start": payload.get("page_start", metadata.get("page_start")),
                "page_end": payload.get("page_end", metadata.get("page_end")),
                "section": payload.get("section", metadata.get("section")),
                "url": payload.get("url", metadata.get("url")),
                "score": float(result.score) if result.score is not None else None,
            }
        )
    return output


def collection_status():
    try:
        info = client.get_collection(COLLECTION_NAME)
        return {
            "collection": COLLECTION_NAME,
            "vectors_count": info.points_count or 0,
            "vector_dimension": VECTOR_SIZE,
            "embedding_model": EMBEDDING_MODEL_NAME,
            "status": str(info.status),
            "qdrant_path": str(QDRANT_PATH),
        }
    except Exception as error:
        return {
            "collection": COLLECTION_NAME,
            "vectors_count": 0,
            "vector_dimension": VECTOR_SIZE,
            "embedding_model": EMBEDDING_MODEL_NAME,
            "status": "not_initialized",
            "qdrant_path": str(QDRANT_PATH),
            "error": str(error),
        }


def close_vector_store():
    try:
        client.close()
        print("[OmniMed] Qdrant client closed.")
    except Exception as error:
        print(f"[OmniMed] Qdrant close error: {error}")