from app.services.evidence.rag import retrieve_evidence


def main():
    queries = [
        "What is an A1C test and what does it measure?",
        "What are the symptoms and causes of abdominal pain?",
        "What is diabetes and how is it diagnosed?",
    ]

    for query in queries:
        print("\n" + "=" * 80)
        print(f"QUERY: {query}")
        print("=" * 80)

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
            print(f"Text: {result.get('excerpt')}")


if __name__ == "__main__":
    main()