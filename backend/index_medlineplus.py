from pathlib import Path
import hashlib
import html
import re
import sys
import xml.etree.ElementTree as ET

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from app.services.evidence.chunker import build_chunks
from app.services.evidence.vector_store import (
    initialize_collection,
    index_chunks,
    close_vector_store,
)

XML_PATH = (
    BACKEND_DIR
    / "data"
    / "clinical_references"
    / "mplus_topics_2026-10-14.xml"
)

DATA_DIR = BACKEND_DIR / "data" / "clinical_references"


def clean_text(value: str) -> str:
    """Convert XML/HTML content into readable plain text."""
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def stable_document_id(url: str, title: str) -> str:
    """Generate a repeatable ID for each MedlinePlus topic."""
    key = (url.strip() or title.strip()).lower()
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]
    return f"medlineplus-{digest}"


def main():
    if not XML_PATH.exists():
        raise FileNotFoundError(f"XML file not found: {XML_PATH}")

    print("[OmniMed] Parsing MedlinePlus XML...")
    root = ET.parse(XML_PATH).getroot()

    topics = []

    for topic in root.findall("health-topic"):
        attrs = topic.attrib

        if attrs.get("language", "").strip().lower() != "english":
            continue

        title = clean_text(attrs.get("title", ""))
        url = attrs.get("url", "").strip()

        summary_element = topic.find("full-summary")
        summary = (
            clean_text(" ".join(summary_element.itertext()))
            if summary_element is not None
            else ""
        )

        if not summary:
            summary = clean_text(attrs.get("meta-desc", ""))

        if not title or not summary:
            continue

        aliases = [
            clean_text(" ".join(item.itertext()))
            for item in topic.findall("also-called")
        ]
        aliases = [item for item in aliases if item]

        groups = [
            clean_text(" ".join(item.itertext()))
            for item in topic.findall("group")
        ]
        groups = [item for item in groups if item]

        topics.append(
            {
                "title": title,
                "url": url,
                "summary": summary,
                "aliases": aliases,
                "groups": groups,
            }
        )

    if not topics:
        raise RuntimeError("No usable English medical topics found.")

    print(f"[OmniMed] English topics prepared: {len(topics)}")

    all_chunks = []

    for topic in topics:
        title = topic["title"]
        url = topic["url"]
        document_id = stable_document_id(url, title)

        text = "\n".join(
            [
                f"Medical topic: {title}",
                f"Alternative names: {', '.join(topic['aliases']) or 'Not provided'}",
                f"Categories: {', '.join(topic['groups']) or 'Not provided'}",
                f"Summary: {topic['summary']}",
            ]
        )

        metadata = {
            "document_type": "medical_reference",
            "clinical_topics": topic["groups"] or ["general_health"],
            "url": url,
            "source_type": "consumer_health_information",
            "dataset": "MedlinePlus Health Topics",
            "language": "English",
            "topic_title": title,
        }

        chunks = build_chunks(
            text=text,
            document_id=document_id,
            title=title,
            source="MedlinePlus",
            metadata=metadata,
        )

        all_chunks.extend(chunks)

    print(f"[OmniMed] Total chunks prepared: {len(all_chunks)}")

    # Group chunks into batches to avoid embedding the entire dataset at once.
    batch_size = 64
    total_indexed = 0

    try:
        initialize_collection()

        for start in range(0, len(all_chunks), batch_size):
            batch = all_chunks[start:start + batch_size]
            total_indexed += index_chunks(batch)

            completed = min(start + batch_size, len(all_chunks))
            print(
                f"[OmniMed] Progress: {completed}/{len(all_chunks)} chunks"
            )

        print("\n[OmniMed] Indexing completed.")
        print(f"[OmniMed] Topics processed: {len(topics)}")
        print(f"[OmniMed] Chunks indexed: {total_indexed}")

    finally:
        close_vector_store()


if __name__ == "__main__":
    main()