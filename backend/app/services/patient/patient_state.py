from datetime import datetime, timezone

from app.services.models.models import (
    PatientInput,
    PatientState,
    TimelineEvent,
)


def now_iso():
    return datetime.now(
        timezone.utc
    ).isoformat()


def build_patient_state(
    patient: PatientInput,
) -> PatientState:

    timeline = []

    for lab in patient.labs:

        timeline.append(
            TimelineEvent(
                timestamp=lab.timestamp,
                type="lab",
                name=lab.name,
                value=lab.value,
                unit=lab.unit,
            )
        )

    timeline.sort(
        key=lambda event: event.timestamp
        or ""
    )

    missing_information = []

    if not patient.medications:
        missing_information.append(
            "Current medications"
        )

    if not patient.allergies:
        missing_information.append(
            "Allergy information"
        )

    if not patient.symptoms:
        missing_information.append(
            "Current symptoms"
        )

    if not patient.labs:
        missing_information.append(
            "Recent laboratory results"
        )

    if not patient.notes:
        missing_information.append(
            "Clinical notes"
        )

    return PatientState(
        patient_id=patient.patient_id,
        age=patient.age,
        sex=patient.sex,
        conditions=patient.conditions,
        medications=patient.medications,
        allergies=patient.allergies,
        symptoms=patient.symptoms,
        labs=patient.labs,
        vitals=patient.vitals,
        notes=patient.notes,
        timeline=timeline,
        missing_information=missing_information,
        updated_at=now_iso(),
    )