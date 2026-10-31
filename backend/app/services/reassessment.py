from app.services.models.models import (
    PatientState,
    CarePlan,
    ReassessmentResponse
)

from app.services.evidence.evidence import (
    search_evidence
)


def detect_changes(
    previous: PatientState,
    current: PatientState
):

    changes = []


    old_labs = {
        item.name: item
        for item in previous.timeline
    }


    new_labs = {
        item.name: item
        for item in current.timeline
    }


    for name, current_lab in new_labs.items():

        if name not in old_labs:

            changes.append({

                "type":
                    "new_lab",

                "name":
                    name,

                "old":
                    None,

                "new":
                    current_lab.value,

                "unit":
                    current_lab.unit
            })

            continue


        old_lab = old_labs[name]


        if old_lab.value != current_lab.value:

            changes.append({

                "type":
                    "changed_lab",

                "name":
                    name,

                "old":
                    old_lab.value,

                "new":
                    current_lab.value,

                "unit":
                    current_lab.unit
            })


    if (
        previous.vitals.model_dump()
        !=
        current.vitals.model_dump()
    ):

        changes.append({

            "type":
                "vitals_change",

            "name":
                "vitals",

            "old":
                previous.vitals.model_dump(),

            "new":
                current.vitals.model_dump()
        })


    if (
        set(previous.symptoms)
        !=
        set(current.symptoms)
    ):

        changes.append({

            "type":
                "symptom_change",

            "name":
                "symptoms",

            "old":
                previous.symptoms,

            "new":
                current.symptoms
        })


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

        current.conditions

        +

        current.symptoms
    )


    evidence = search_evidence(
        query,
        top_k=5
    )


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