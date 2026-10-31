from contextlib import asynccontextmanager

import psycopg
import app.api.routes as routes_module
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import APP_NAME, APP_VERSION, DATABASE_URL
from app.api.routes import router
from app.services.ai.llm import OLLAMA_MODEL, ollama_warm_up
from app.services.clinical.care_plan_stream import router as care_plan_stream_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load and verify the configured Ollama model before serving requests."""
    print("\n========== OMNIMED STARTUP ==========")
    print(f"Loading Qwen model: {OLLAMA_MODEL}...")

    try:
        await ollama_warm_up()
    except Exception as exc:
        print(f"ERROR: Qwen model loading failed: {exc}")
        # Fail startup rather than running an API that cannot perform inference.
        raise
    else:
        print(f"Qwen loaded successfully: {OLLAMA_MODEL}")

    print("=====================================\n")
    yield
    print("\nOmniMed backend shutting down.\n")


app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    description=(
        "OmniMed multimodal "
        "Generative AI clinical "
        "decision-support backend."
    ),
    lifespan=lifespan,
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Registered BEFORE the main router on purpose: FastAPI serves the first route
# that matches, so this real streaming endpoint (/api/care-plans/stream) takes
# over from the stand-in stream still defined in routes.py. The router already
# carries the full "/api/..." path, so it is included without a prefix.
app.include_router(care_plan_stream_router)

app.include_router(router, prefix="/api")


def check_database() -> str:
    """Run a real round-trip query against PostgreSQL.

    Returns "connected" or "disconnected". The short connect timeout keeps
    /health fast even when the database host is unreachable (the frontend
    gives up on a status request after 5 seconds).
    """
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1;")
                cur.fetchone()
        return "connected"
    except Exception as exc:
        print(f"HEALTH: database check failed: {exc}")
        return "disconnected"


@app.get("/")
def root():
    return {
        "service": APP_NAME,
        "version": APP_VERSION,
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
def health():
    database = check_database()
    return {
        "status": "ok" if database == "connected" else "degraded",
        "service": APP_NAME,
        "version": APP_VERSION,
        "database": database,
    }


# TEMPORARY DEBUGGING
print("\n========== OMNIMED DEBUG ==========")
print("Main file:", __file__)
print("Routes file:", routes_module.__file__)

for route in app.routes:
    path = getattr(route, "path", "")
    methods = getattr(route, "methods", set()) or set()
    if "clinical-brief" in path or "care-plans" in path:
        endpoint = getattr(route, "endpoint", None)
        module = getattr(endpoint, "__module__", "?")
        print(f"Registered endpoint: {sorted(methods)} {path} -> {module}")

print("===================================\n")