"""Seed OmniMed's cited diabetes GraphRAG demo: python scripts/seed_graph_rag.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.graph_rag import seed_demo


if __name__ == "__main__":
    count = seed_demo()
    print(f"Seeded {count} cited graph facts (idempotent).")
