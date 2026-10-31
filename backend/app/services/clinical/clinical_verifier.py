from __future__ import annotations

import re
from typing import Any


# -------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------

FORBIDDEN_AUTONOMOUS_ACTION_PATTERNS = [
    r"\border\b",
    r"\bprescribe\b",
    r"\bstart\s+\w+\s+(?:mg|mcg|g|ml)\b",
    r"\bstop\s+\w+\s+(?:mg|mcg|g|ml)\b",
    r"\bincrease\s+\w+\s+(?:dose|dosage)\b",
    r"\bdecrease\s+\w+\s+(?:dose|dosage)\b",
    r"\bgive\s+\w+\s+(?:mg|mcg|g|ml)\b",
]

CONFIRMED_DIAGNOSIS_PATTERNS = [
    # Flag explicit assertions that a diagnosis is confirmed.
    # Avoid broad phrases such as "the patient has", which also match
    # history, symptoms, and missing-information statements.
    r"\bconfirmed\s+(?:diagnosis|diagnosed)\b",
    r"\bdiagnosis\s+(?:is|was)\s+confirmed\b",
    r"\bdefinitively\s+diagnos(?:is|ed)\b",
    r"\bpatient\s+(?:has been|was)\s+diagnosed\s+with\b",
    r"\bpatient is diagnosed with\b",
]

INVENTED_VALUE_PATTERNS = [
    r"\b\d+(?:\.\d+)?\s*(?:mg/dl|mmhg|ng/l|g/dl|bpm|%|mmol/l)\b",
]

REQUIRED_UNCERTAINTY_TERMS = [
    "uncertain",
    "unclear",
    "not confirmed",
    "cannot confirm",
    "requires evaluation",
    "requires assessment",
    "possible",
    "potential",
]

# Fields written by the model. The safety checks below look ONLY at these.
# Scanning the whole brief also matched the system's own safety_note
# ("...not a diagnosis or treatment order"), retrieved evidence text and quoted
# report snippets, which blocked every brief.
MODEL_AUTHORED_FIELDS = [
    "summary",
    "key_findings",
    "concerns",
    "clinical_possibilities",
    "recommended_review",
    "missing_information",
    "uncertainty",
]


# -------------------------------------------------------------------
# Utility functions
# -------------------------------------------------------------------

def _normalize_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, list):
        return " ".join(
            str(item)
            for item in value
            if item is not None
        )

    return str(value)


def _generated_text(brief: dict[str, Any]) -> str:
    """Lower-cased text of the model-authored fields only."""

    parts = [
        _normalize_text(brief.get(field))
        for field in MODEL_AUTHORED_FIELDS
    ]

    urgency = brief.get("urgency")

    if isinstance(urgency, dict):
        parts.append(
            _normalize_text(urgency.get("rationale"))
        )

    return " ".join(parts).lower()


def _collect_patient_text(patient_state: Any) -> str:
    """
    Convert the structured Patient State into searchable text.
    """

    if patient_state is None:
        return ""

    if hasattr(patient_state, "model_dump"):
        patient_state = patient_state.model_dump()

    if isinstance(patient_state, dict):
        parts = []

        def walk(value: Any):
            if isinstance(value, dict):
                for key, item in value.items():
                    parts.append(str(key))
                    walk(item)

            elif isinstance(value, list):
                for item in value:
                    walk(item)

            elif value is not None:
                parts.append(str(value))

        walk(patient_state)

        return " ".join(parts).lower()

    return str(patient_state).lower()


def _collect_evidence_text(
    evidence: list[dict[str, Any]] | None
) -> str:
    if not evidence:
        return ""

    parts = []

    for item in evidence:
        if not isinstance(item, dict):
            continue

        parts.append(
            _normalize_text(item.get("title"))
        )

        parts.append(
            _normalize_text(item.get("source"))
        )

        parts.append(
            _normalize_text(item.get("text"))
        )

    return " ".join(parts).lower()


def _get_list(
    brief: dict[str, Any],
    key: str
) -> list[str]:
    value = brief.get(key, [])

    if value is None:
        return []

    if isinstance(value, str):
        return [value]

    if isinstance(value, list):
        return [
            str(item).strip()
            for item in value
            if str(item).strip()
        ]

    return []


def _contains_any(
    text: str,
    patterns: list[str]
) -> list[str]:

    matches = []

    for pattern in patterns:
        if re.search(
            pattern,
            text,
            flags=re.IGNORECASE
        ):
            matches.append(pattern)

    return matches


# -------------------------------------------------------------------
# Individual safety checks
# -------------------------------------------------------------------

def check_autonomous_actions(
    brief: dict[str, Any]
) -> list[str]:

    matches = _contains_any(
        _generated_text(brief),
        FORBIDDEN_AUTONOMOUS_ACTION_PATTERNS
    )

    if matches:
        return [
            "Potential autonomous treatment/order instruction detected."
        ]

    return []


def check_confirmed_diagnosis(
    brief: dict[str, Any]
) -> list[str]:

    matches = _contains_any(
        _generated_text(brief),
        CONFIRMED_DIAGNOSIS_PATTERNS
    )

    if matches:
        return [
            "Potential unsupported confirmed-diagnosis statement detected. "
            "Matched pattern(s): " + ", ".join(matches)
        ]

    return []


def check_invented_values(
    brief: dict[str, Any],
    patient_state: Any
) -> list[str]:

    brief_text = _generated_text(brief)
    patient_text = _collect_patient_text(
        patient_state
    )

    reported_values = re.findall(
        r"\b\d+(?:\.\d+)?\s*(?:mg/dl|mmhg|ng/l|g/dl|bpm|%|mmol/l)\b",
        brief_text,
        flags=re.IGNORECASE
    )

    unsupported_values = []

    for value in reported_values:
        normalized = value.lower().replace(" ", "")

        if normalized not in patient_text.replace(" ", ""):
            unsupported_values.append(value)

    if unsupported_values:
        return [
            "Potentially invented clinical value(s): "
            + ", ".join(unsupported_values)
        ]

    return []


def check_uncertainty(
    brief: dict[str, Any]
) -> list[str]:

    possibilities = _get_list(
        brief,
        "clinical_possibilities"
    )

    uncertainty = _get_list(
        brief,
        "uncertainty"
    )

    if possibilities and not uncertainty:
        return [
            "Clinical possibilities were generated without an explicit uncertainty section."
        ]

    uncertainty_text = " ".join(
        uncertainty
    ).lower()

    if possibilities and uncertainty_text:
        if not any(
            term in uncertainty_text
            for term in REQUIRED_UNCERTAINTY_TERMS
        ):
            return [
                "Uncertainty section may not clearly communicate that clinical possibilities are unconfirmed."
            ]

    return []


def check_evidence_support(
    brief: dict[str, Any],
    evidence: list[dict[str, Any]] | None
) -> list[str]:

    possibilities = _get_list(
        brief,
        "clinical_possibilities"
    )

    evidence_text = _collect_evidence_text(
        evidence
    )

    if not possibilities:
        return []

    if not evidence_text:
        return [
            "Clinical possibilities were generated without retrieved evidence."
        ]

    unsupported = []

    # Avoid treating generic words as evidence of clinical relevance.
    generic_words = {
        "patient", "clinical", "possibly", "possible", "potential",
        "could", "would", "should", "might", "may", "with", "from",
        "that", "this", "these", "those", "have", "has", "been",
        "being", "because", "based", "information", "evaluation",
        "assessment", "condition", "findings", "symptoms", "evidence",
    }

    for possibility in possibilities:
        words = {
            word.lower()
            for word in re.findall(r"[A-Za-z]{4,}", possibility)
            if word.lower() not in generic_words
        }

        if not words:
            unsupported.append(possibility)
            continue

        # This remains a lexical heuristic, not clinical validation.
        # Require at least two distinct non-generic terms to overlap.
        meaningful_matches = {
            word for word in words if word in evidence_text
        }

        if len(meaningful_matches) < min(2, len(words)):
            unsupported.append(possibility)

    if unsupported:
        return [
            "Potentially unsupported clinical possibilities: "
            + "; ".join(unsupported)
        ]

    return []


# -------------------------------------------------------------------
# Main verifier
# -------------------------------------------------------------------

def verify_clinical_brief(
    brief: dict[str, Any],
    patient_state: Any,
    evidence: list[dict[str, Any]] | None = None
) -> dict[str, Any]:

    safety_issues: list[str] = []
    warnings: list[str] = []

    if not isinstance(brief, dict):
        return {
            "status": "blocked",
            "safe": False,
            "evidence_grounded": False,
            "issues": [
                "Clinical brief is not a JSON object."
            ],
            "warnings": [],
            "verified_brief": None
        }

    # ---------------------------------------------------------------
    # Safety checks
    # ---------------------------------------------------------------

    safety_issues.extend(
        check_autonomous_actions(brief)
    )

    diagnosis_issues = check_confirmed_diagnosis(brief)
    safety_issues.extend(diagnosis_issues)

    if diagnosis_issues:
        # Log only the matched rule names/message, not patient text.
        print(
            "[OmniMed verifier] Diagnosis check triggered: "
            + " | ".join(diagnosis_issues),
            flush=True,
        )

    safety_issues.extend(
        check_invented_values(
            brief,
            patient_state
        )
    )

    # ---------------------------------------------------------------
    # Uncertainty checks
    # ---------------------------------------------------------------

    warnings.extend(
        check_uncertainty(brief)
    )

    # ---------------------------------------------------------------
    # Evidence grounding
    # ---------------------------------------------------------------

    evidence_issues = check_evidence_support(
        brief,
        evidence
    )

    if evidence_issues:
        warnings.extend(
            evidence_issues
        )

    evidence_grounded = (
        len(evidence_issues) == 0
    )

    # ---------------------------------------------------------------
    # Final decision
    # ---------------------------------------------------------------

    safe = len(safety_issues) == 0

    if safe and evidence_grounded:
        status = "verified"

    elif safe:
        status = "needs_review"

    else:
        status = "blocked"

    # ---------------------------------------------------------------
    # Return verification metadata
    # ---------------------------------------------------------------

    return {
        "status": status,
        "safe": safe,
        "evidence_grounded": evidence_grounded,
        "issues": safety_issues,
        "warnings": warnings,
        "verification": {
            "autonomous_actions_checked": True,
            "confirmed_diagnosis_checked": True,
            "clinical_values_checked": True,
            "uncertainty_checked": True,
            "evidence_support_checked": True
        },
        "verified_brief": (
            brief
            if safe
            else None
        )
    }