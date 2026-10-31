
from app.services.evidence.vector_store import (
    client,
    COLLECTION_NAME,
    QDRANT_PATH,
    collection_status,
)

def main():
    print("\n" + "=" * 60)
    print("OMNIMED — QDRANT DATABASE DIAGNOSTICS")
    print("=" * 60)

    print(f"\nDatabase path: {QDRANT_PATH}")
    print(f"Collection: {COLLECTION_NAME}")

    status = collection_status()

    print("\n--- Collection Status ---")
    for key, value in status.items():
        print(f"{key}: {value}")

    if status.get("status") == "not_initialized":
        print("\nCollection is not initialized or could not be inspected.")
        return

    print("\n--- Stored Document Chunks ---")

    try:
        result = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=100,
            with_payload=True,
            with_vectors=False,
        )

        points, next_offset = result
        print(f"Points displayed: {len(points)}")

        if not points:
            print("No indexed chunks were found.")
            return

        for index, point in enumerate(points, start=1):
            payload = point.payload or {}
            metadata = payload.get("metadata") or {}

            print(f"\nChunk #{index}")
            print(f"  Point ID: {point.id}")
            print(f"  Title: {payload.get('title', 'Unknown')}")
            print(f"  Source: {payload.get('source', 'Unknown')}")
            print(f"  Document ID: {payload.get('document_id', 'Unknown')}")
            print(
                "  Document type: "
                f"{payload.get('document_type', metadata.get('document_type', 'unclassified'))}"
            )
            print(
                "  Clinical topics: "
                f"{payload.get('clinical_topics', metadata.get('clinical_topics', []))}"
            )
            print(f"  Page: {payload.get('page', 'Not provided')}")

            text = str(payload.get("text") or "")
            preview = " ".join(text.split())[:300]
            print(f"  Text preview: {preview or '[No text stored]'}")

        if next_offset is not None:
            print(
                "\nNote: More than 100 chunks may exist. "
                "This script displayed only the first page of results."
            )

    except Exception as error:
        print(f"\nInspection failed: {type(error).__name__}: {error}")

    print("\n" + "=" * 60)
    print("DIAGNOSTICS COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
