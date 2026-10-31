from app.services.evidence.vector_store import (
    client,
    COLLECTION_NAME,
    close_vector_store,
)
from qdrant_client.models import Filter, FieldCondition, MatchValue


def main():
    try:
        # Count records matching the exact old document ID.
        old_filter = Filter(
            must=[
                FieldCondition(
                    key="document_id",
                    match=MatchValue(
                        value="medlineplus-2026-10-14-en"
                    ),
                )
            ]
        )

        count_result = client.count(
            collection_name=COLLECTION_NAME,
            count_filter=old_filter,
            exact=True,
        )

        print(
            "Obsolete MedlinePlus records found:",
            count_result.count,
        )

        if count_result.count == 0:
            print("No obsolete records found. Nothing to delete.")
            return

        confirmation = input(
            "\nType DELETE OLD MEDLINEPLUS to remove only these records: "
        )

        if confirmation != "DELETE OLD MEDLINEPLUS":
            print("Cancelled. No records were deleted.")
            return

        client.delete(
            collection_name=COLLECTION_NAME,
            points_selector=old_filter,
            wait=True,
        )

        print("Obsolete MedlinePlus records deleted successfully.")

        remaining = client.count(
            collection_name=COLLECTION_NAME,
            exact=True,
        )

        print("Total records remaining:", remaining.count)

    finally:
        close_vector_store()


if __name__ == "__main__":
    main()