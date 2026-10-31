import asyncio
import json

from app.services.patient.patient_state import build_patient_state
from app.services.clinical.clinical import generate_clinical_brief
from app.services.models.models import PatientInput


async def main():

    print("\n================================")
    print("OmniMed Clinical RAG Integration Test")
    print("================================\n")

    # =====================================================
    # 1. Create synthetic patient input
    # =====================================================

    patient = PatientInput(
        patient_id="OMNI-DEMO-001",

        age=62,

        sex="Male",

        conditions=[
            "Hypertension",
            "Type 2 diabetes"
        ],

        medications=[
            "Metformin",
            "Amlodipine"
        ],

        allergies=[],

        symptoms=[
            "Chest discomfort"
        ],

        labs=[],

        vitals={
            "blood_pressure": "168/96",
            "heart_rate": 88,
            "oxygen_saturation": 97
        },

        notes=[
            "Synthetic demonstration patient.",
            "Chest discomfort requires clinical review."
        ]
    )

    # =====================================================
    # 2. Build structured Patient State
    # =====================================================

    print(
        "[TEST] Building patient state..."
    )

    state = build_patient_state(
        patient
    )

    print(
        "[TEST] Patient state created."
    )

    print(
        json.dumps(
            state.model_dump(),
            indent=2,
            default=str
        )
    )

    # =====================================================
    # 3. Ask an evidence-grounded question
    # =====================================================

    clinical_question = (
        "Assess the current chest discomfort "
        "in the context of diabetes and hypertension. "
        "Consider relevant cardiovascular evidence, "
        "troponin interpretation, ECG considerations, "
        "and important missing information."
    )

    print(
        "\n[TEST] Clinical question:"
    )

    print(
        clinical_question
    )

    # =====================================================
    # 4. RAG → Qwen → Clinical Brief
    # =====================================================

    print(
        "\n[TEST] Generating evidence-grounded "
        "clinical brief..."
    )

    result = await generate_clinical_brief(

        state=state,

        clinical_question=clinical_question
    )

    # =====================================================
    # 5. Display Clinical Brief
    # =====================================================

    print(
        "\n================================"
    )

    print(
        "CLINICAL BRIEF"
    )

    print(
        "================================\n"
    )

    print(
        "Patient ID:"
    )

    print(
        result.patient_id
    )

    print(
        "\nSummary:"
    )

    print(
        result.summary
    )

    print(
        "\nKey Findings:"
    )

    for item in result.key_findings:

        print(
            f"- {item}"
        )

    print(
        "\nConcerns:"
    )

    for item in result.concerns:

        print(
            f"- {item}"
        )

    print(
        "\nMissing Information:"
    )

    for item in result.missing_information:

        print(
            f"- {item}"
        )

    print(
        "\nClinical Possibilities:"
    )

    for item in result.clinical_possibilities:

        print(
            f"- {item}"
        )

    print(
        "\nUncertainty:"
    )

    for item in result.uncertainty:

        print(
            f"- {item}"
        )

    # =====================================================
    # 6. Display retrieved evidence
    # =====================================================

    print(
        "\n================================"
    )

    print(
        "RETRIEVED EVIDENCE"
    )

    print(
        "================================"
    )

    if not result.evidence:

        print(
            "No evidence retrieved."
        )

    else:

        for index, evidence in enumerate(
            result.evidence,
            start=1
        ):

            print(
                f"\n--- Evidence {index} ---"
            )

            print(
                "Title:",
                evidence.get(
                    "title",
                    ""
                )
            )

            print(
                "Source:",
                evidence.get(
                    "source",
                    ""
                )
            )

            print(
                "Score:",
                evidence.get(
                    "score",
                    0
                )
            )

            print(
                "Chunk:",
                evidence.get(
                    "chunk_index",
                    0
                )
            )

            print(
                "Text:"
            )

            print(
                evidence.get(
                    "text",
                    ""
                )
            )

    # =====================================================
    # 7. Safety note
    # =====================================================

    print(
        "\n================================"
    )

    print(
        "SAFETY NOTE"
    )

    print(
        "================================"
    )

    print(
        result.safety_note
    )

    # =====================================================
    # 8. Final result
    # =====================================================

    print(
        "\n================================"
    )

    print(
        "CLINICAL RAG TEST COMPLETED"
    )

    print(
        "================================"
    )


if __name__ == "__main__":

    asyncio.run(
        main()
    )