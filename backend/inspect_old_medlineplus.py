from app.services.evidence.vector_store import (
    client,
    COLLECTION_NAME,
    close_vector_store,
)


def main():
    offset = None
    matches = []

    try:
        while True:
            records, offset = client.scroll(
                collection_name=COLLECTION_NAME,
                limit=100,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )

            for record in records:
                payload = record.payload or {}

                if payload.get("title") == "MedlinePlus Health Topics":
                    matches.append(
                        {
                            "id": record.id,
                            "document_id": payload.get("document_id"),
                            "title": payload.get("title"),
                            "source": payload.get("source"),
                            "url": payload.get("url"),
                        }
                    )

            if offset is None:
                break

        print(f"\nOld MedlinePlus records found: {len(matches)}")

        for item in matches[:10]:
            print(item)

        if len(matches) > 10:
            print(f"...and {len(matches) - 10} more.")

        print("\nInspection only. No records were deleted.")

    finally:
        close_vector_store()


if __name__ == "__main__":
    main()