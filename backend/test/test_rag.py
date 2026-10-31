from pathlib import Path

from app.services.evidence.rag import (
    initialize_collection,
    index_document,
    retrieve_evidence,
    rag_status
)

from app.services.evidence.vector_store import (
    close_vector_store
)


def run_query(
    query: str,
    top_k: int = 3
):

    print("\n================================")
    print(
        f"QUERY: {query}"
    )
    print("================================")

    results = retrieve_evidence(
        query=query,
        top_k=top_k
    )

    if not results:

        print(
            "No evidence found."
        )

        return

    for index, result in enumerate(
        results,
        start=1
    ):

        print(
            f"\n--- Result {index} ---"
        )

        print(
            "Score:",
            result.get(
                "score",
                0
            )
        )

        print(
            "Title:",
            result.get(
                "title",
                ""
            )
        )

        print(
            "Source:",
            result.get(
                "source",
                ""
            )
        )

        print(
            "Document ID:",
            result.get(
                "document_id",
                ""
            )
        )

        print(
            "Chunk:",
            result.get(
                "chunk_index",
                0
            )
        )

        print(
            "Text:"
        )

        print(
            result.get(
                "text",
                ""
            )
        )


def main():

    print("\n================================")
    print("OmniMed RAG Evaluation Test")
    print("================================\n")

    try:

        # =================================================
        # 1. Initialize Qdrant
        # =================================================

        initialize_collection()

        # =================================================
        # 2. Locate knowledge document
        # =================================================

        # Structure:
        #
        # omnimed/
        # ├── data/
        # │   └── knowledge/
        # │       └── test_medical.txt
        # │
        # └── backend/
        #     └── test_rag.py

        BASE_DIR = (
            Path(__file__).resolve().parents[1]
        )

        test_file = (
            BASE_DIR
            / "data"
            / "knowledge"
            / "test_medical.txt"
        )

        print(
            "[TEST] Test file path:"
        )

        print(
            test_file
        )

        print(
            "[TEST] File exists:",
            test_file.exists()
        )

        if not test_file.exists():

            raise FileNotFoundError(
                "Test medical file not found:\n"
                f"{test_file}"
            )

        # =================================================
        # 3. Index document
        # =================================================

        print(
            "\n[TEST] Indexing document..."
        )

        result = index_document(

            file_path=test_file,

            document_id="demo-medical-001",

            title=(
                "OmniMed Synthetic Medical "
                "Knowledge Base"
            ),

            source=(
                "OmniMed Synthetic Knowledge Base"
            )
        )

        print(
            "\nIndex result:"
        )

        print(result)

        # =================================================
        # 4. Run multiple retrieval tests
        # =================================================

        queries = [

            (
                "diabetes and cardiovascular "
                "risk"
            ),

            (
                "chest discomfort with "
                "elevated troponin"
            ),

            (
                "abnormal ECG and chest symptoms"
            ),

            (
                "change in creatinine "
                "and kidney function"
            ),

            (
                "medication safety and allergies"
            ),

            (
                "new information affecting "
                "an existing care plan"
            )

        ]

        for query in queries:

            run_query(
                query=query,
                top_k=3
            )

        # =================================================
        # 5. Qdrant status
        # =================================================

        print(
            "\n================================"
        )

        print(
            "Qdrant Status"
        )

        print(
            "================================"
        )

        print(
            rag_status()
        )

        # =================================================
        # 6. Completion
        # =================================================

        print(
            "\n================================"
        )

        print(
            "RAG EVALUATION COMPLETED"
        )

        print(
            "================================"
        )

    except Exception as error:

        print(
            "\n================================"
        )

        print(
            "RAG EVALUATION FAILED"
        )

        print(
            "================================"
        )

        print(
            repr(error)
        )

        raise

    finally:

        close_vector_store()


if __name__ == "__main__":

    main()