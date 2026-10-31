import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"

APP_NAME = os.getenv(
    "APP_NAME",
    "OmniMed API"
)

APP_VERSION = os.getenv(
    "APP_VERSION",
    "0.2.0"
)

DATABASE_URL = os.getenv(
    "DATABASE_URL"
)

UPLOAD_DIR = Path(
    os.getenv(
        "UPLOAD_DIR",
        str(DATA_DIR / "uploads")
    )
)

KNOWLEDGE_DIR = Path(
    os.getenv(
        "KNOWLEDGE_DIR",
        str(DATA_DIR / "knowledge")
    )
)

OLLAMA_BASE_URL = os.getenv(
    "OLLAMA_BASE_URL",
    "http://127.0.0.1:11434"
).rstrip("/")

OLLAMA_MODEL = os.getenv(
    "OLLAMA_MODEL",
    "qwen3:4b"
)

REQUIRE_EVIDENCE_FOR_CLINICAL_OUTPUT = (
    os.getenv(
        "REQUIRE_EVIDENCE_FOR_CLINICAL_OUTPUT",
        "true"
    ).lower()
    == "true"
)

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not configured."
    )

UPLOAD_DIR.mkdir(
    parents=True,
    exist_ok=True
)

KNOWLEDGE_DIR.mkdir(
    parents=True,
    exist_ok=True
)