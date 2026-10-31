import json
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

from app.core.config import DATABASE_URL


def get_conn():
    return psycopg.connect(
        DATABASE_URL,
        row_factory=dict_row
    )


def init_db():
    with get_conn() as conn:
        with conn.cursor() as cur:

            # -----------------------------
            # PATIENTS
            # -----------------------------
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS patients (
                    patient_id TEXT PRIMARY KEY,
                    state_json JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                );
                """
            )

            # -----------------------------
            # CARE PLANS
            # -----------------------------
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS care_plans (
                    care_plan_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL,
                    plan_json JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                );
                """
            )

            # -----------------------------
            # DOCUMENTS
            # -----------------------------
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    document_id TEXT PRIMARY KEY,
                    patient_id TEXT,
                    filename TEXT NOT NULL,
                    mime_type TEXT,
                    path TEXT NOT NULL,
                    extracted_text TEXT,
                    created_at TIMESTAMPTZ NOT NULL
                );
                """
            )

            # -----------------------------
            # EVIDENCE
            # -----------------------------
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS evidence (
                    evidence_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    source TEXT,
                    text TEXT NOT NULL,
                    metadata_json JSONB
                );
                """
            )

            # -----------------------------
            # AUDIT LOG
            # -----------------------------
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_log (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    patient_id TEXT,
                    payload_json JSONB,
                    created_at TIMESTAMPTZ NOT NULL
                );
                """
            )

        conn.commit()


# ============================================================
# PATIENTS
# ============================================================

def upsert_patient(patient_id: str, state):
    now = datetime.now(timezone.utc)

    if hasattr(state, "model_dump"):
        state_data = state.model_dump()
    else:
        state_data = state

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO patients (
                    patient_id,
                    state_json,
                    updated_at
                )
                VALUES (%s, %s, %s)
                ON CONFLICT (patient_id)
                DO UPDATE SET
                    state_json = EXCLUDED.state_json,
                    updated_at = EXCLUDED.updated_at;
                """,
                (
                    patient_id,
                    Json(state_data),
                    now
                )
            )

        conn.commit()


def get_patient(patient_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    patient_id,
                    state_json,
                    updated_at
                FROM patients
                WHERE patient_id = %s;
                """,
                (patient_id,)
            )

            return cur.fetchone()


# ============================================================
# CARE PLANS
# ============================================================

def save_care_plan(
    care_plan_id: str,
    patient_id: str,
    plan
):
    now = datetime.now(timezone.utc)

    if hasattr(plan, "model_dump"):
        plan_data = plan.model_dump()
    else:
        plan_data = plan

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO care_plans (
                    care_plan_id,
                    patient_id,
                    plan_json,
                    updated_at
                )
                VALUES (%s, %s, %s, %s);
                """,
                (
                    care_plan_id,
                    patient_id,
                    Json(plan_data),
                    now
                )
            )

        conn.commit()


def get_latest_care_plan(patient_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    care_plan_id,
                    patient_id,
                    plan_json,
                    updated_at
                FROM care_plans
                WHERE patient_id = %s
                ORDER BY updated_at DESC
                LIMIT 1;
                """,
                (patient_id,)
            )

            return cur.fetchone()


# ============================================================
# DOCUMENTS
# ============================================================

def save_document(
    document_id: str,
    patient_id: str | None,
    filename: str,
    mime_type: str | None,
    path: str,
    extracted_text: str | None
):
    now = datetime.now(timezone.utc)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO documents (
                    document_id,
                    patient_id,
                    filename,
                    mime_type,
                    path,
                    extracted_text,
                    created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s);
                """,
                (
                    document_id,
                    patient_id,
                    filename,
                    mime_type,
                    path,
                    extracted_text,
                    now
                )
            )

        conn.commit()


def list_documents(patient_id: str | None = None):
    with get_conn() as conn:
        with conn.cursor() as cur:

            if patient_id:
                cur.execute(
                    """
                    SELECT *
                    FROM documents
                    WHERE patient_id = %s
                    ORDER BY created_at DESC;
                    """,
                    (patient_id,)
                )
            else:
                cur.execute(
                    """
                    SELECT *
                    FROM documents
                    ORDER BY created_at DESC;
                    """
                )

            return cur.fetchall()


# ============================================================
# EVIDENCE
# ============================================================

def save_evidence(
    evidence_id: str,
    title: str,
    source: str | None,
    text: str,
    metadata: dict | None = None
):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO evidence (
                    evidence_id,
                    title,
                    source,
                    text,
                    metadata_json
                )
                VALUES (%s, %s, %s, %s, %s);
                """,
                (
                    evidence_id,
                    title,
                    source,
                    text,
                    Json(metadata or {})
                )
            )

        conn.commit()


def list_evidence():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM evidence
                ORDER BY title;
                """
            )

            return cur.fetchall()


# ============================================================
# AUDIT LOG
# ============================================================

def save_audit(
    event_type: str,
    patient_id: str | None,
    payload=None,
    extra=None
):
    now = datetime.now(timezone.utc)

    audit_payload = {}

    # Store the main payload safely
    if payload is not None:
        if isinstance(payload, dict):
            audit_payload.update(payload)
        else:
            audit_payload["payload"] = payload

    # Store the extra value safely
    if extra is not None:
        if isinstance(extra, dict):
            audit_payload.update(extra)
        else:
            audit_payload["extra"] = extra

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO audit_log (
                    event_type,
                    patient_id,
                    payload_json,
                    created_at
                )
                VALUES (%s, %s, %s, %s);
                """,
                (
                    event_type,
                    patient_id,
                    Json(audit_payload),
                    now
                )
            )

        conn.commit()