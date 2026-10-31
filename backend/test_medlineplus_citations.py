from app.services.evidence.rag import retrieve_evidence
from app.services.evidence.vector_store import close_vector_store


def main():
    queries = [
        "What does an A1C test measure?",
        "What causes abdominal pain?",
        "How is diabetes diagnosed?",
    ]

    try:
        for query in queries:
            print("\n" + "=" * 70)
            print(f"QUERY: {query}")
            print("=" * 70)

            results = retrieve_evidence(query, top_k=3)

            if not results:
                print("No eligible evidence retrieved.")
                continue

            for result in results:
                print(f"\nTitle: {result.get('title')}")
                print(f"Source: {result.get('source')}")
                print(f"Document type: {result.get('document_type')}")
                print(f"URL: {result.get('url')}")
                print(f"Score: {result.get('score')}")
                print(f"Excerpt: {result.get('excerpt')}")

    finally:
        close_vector_store()


if __name__ == "__main__":
    main()