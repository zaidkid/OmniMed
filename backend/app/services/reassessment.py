import logging
from typing import Any

from app.services.models.models import (
    PatientState,
    CarePlan,
    ReassessmentResponse
)

from app.services.evidence.evidence import (
    search_evidence
)

log = logging.getLogger(__name__)


def detect_changes(
    previous: PatientState,
    current: PatientState
):
    changes: list[dict] = []

    def norm(value) -> str:
        return " ".join(str(value or "").split()).casefold()

    def same_value(left, right) -> bool:
        if left is None or right is None:
            return left is right
        try:
            return float(left) == float(right)
        except (TypeError, ValueError):
            return norm(left) == norm(right)

    for field, label in (
        ("conditions", "condition"),
        ("medications", "medication"),
        ("allergies", "allergy"),
        ("symptoms", "symptom"),
    ):
        old_values = {norm(value): value for value in getattr(previous, field) if norm(value)}
        new_values = {norm(value): value for value in getattr(current, field) if norm(value)}
        for key in sorted(new_values.keys() - old_values.keys()):
            changes.append({"type": f"new_{label}", "name": label.title(), "old": None, "new": new_values[key]})
        for key in sorted(old_values.keys() - new_values.keys()):
            changes.append({"type": f"removed_{label}", "name": label.title(), "old": old_values[key], "new": None})

    old_vitals = previous.vitals.model_dump()
    new_vitals = current.vitals.model_dump()
    for name in old_vitals.keys() | new_vitals.keys():
        old_value, new_value = old_vitals.get(name), new_vitals.get(name)
        if not same_value(old_value, new_value):
            changes.append({"type": "vitals_change", "name": name.replace("_", " ").title(), "old": old_value, "new": new_value})

    def latest_labs(state: PatientState) -> dict[str, Any]:
        latest: dict[str, Any] = {}
        for index, item in enumerate(state.timeline):
            if item.type.casefold() != "lab" or not norm(item.name):
                continue
            key = norm(item.name)
            candidate_key = (item.timestamp or "", index)
            existing = latest.get(key)
            if existing is None or candidate_key >= existing[0]:
                latest[key] = (candidate_key, item)
        return {name: item for name, (_, item) in latest.items()}

    old_labs, new_labs = latest_labs(previous), latest_labs(current)
    for key, current_lab in new_labs.items():
        old_lab = old_labs.get(key)
        if old_lab is None:
            changes.append({"type": "new_lab", "name": current_lab.name, "old": None,
                            "new": current_lab.value, "unit": current_lab.unit})
        elif (not same_value(old_lab.value, current_lab.value)
              or norm(old_lab.unit) != norm(current_lab.unit)):
            changes.append({"type": "changed_lab", "name": current_lab.name,
                            "old": old_lab.value, "new": current_lab.value,
                            "old_unit": old_lab.unit, "unit": current_lab.unit})

    old_notes = {norm(note): note for note in previous.notes if norm(note)}
    for note in current.notes:
        if norm(note) and norm(note) not in old_notes:
            changes.append({"type": "new_note", "name": "Clinical note", "old": None, "new": note})

    return changes


def reassess(
    previous: PatientState,
    current: PatientState,
    care_plan: CarePlan
):

    changes = detect_changes(
        previous,
        current
    )


    query = " ".join(

        [care_plan.pathway]

        +

        [
            str(
                change.get(
                    "name",
                    ""
                )
            )

            for change in changes
        ]

        +
        [str(change.get(key, "")) for change in changes for key in ("old", "new", "unit")]
        + current.conditions
        + current.medications
        + current.allergies
        + current.symptoms
    )


    try:
        evidence = search_evidence(query, top_k=5)
    except Exception:
        # Evidence can enrich a review, but its outage must not block the
        # deterministic state comparison or clinician decision workflow.
        log.exception("Evidence retrieval failed during reassessment")
        evidence = []


    if not changes:

        impact = (
            "no_material_change_detected"
        )

        rationale = [

            "No monitored patient-state "
            "changes were detected."
        ]

        questions = []


    else:

        impact = (
            "review_required"
        )

        rationale = [

            f"{len(changes)} "
            "patient-state change(s) "
            "were detected.",

            "The active care plan "
            "should be reviewed "
            "by the clinician."
        ]

        questions = [

            "Does the new information "
            "change the clinical interpretation?",

            "Does the current care plan "
            "remain appropriate?",

            "Is additional information "
            "needed before changing "
            "the plan?"
        ]


    return ReassessmentResponse(

        patient_id=
            current.patient_id,

        changed_items=
            changes,

        care_plan_impact=
            impact,

        rationale=
            rationale,

        reassessment_questions=
            questions,

        evidence=
            evidence,

        safety_note=(
            "OmniMed does not autonomously "
            "modify the clinician-approved "
            "care plan."
        )
    )
