from app.services.clinical.clinical_verifier import (
    verify_clinical_brief
)


patient_state = {
    "patient_id": "OMNI-DEMO-001",
    "age": 62,
    "sex": "male",
    "conditions": [
        "Hypertension",
        "Type 2 diabetes"
    ],
    "symptoms": [
        "Chest discomfort"
    ],
    "medications": [
        "Metformin",
        "Amlodipine"
    ],
    "vitals": {
        "blood_pressure": "168/96 mmHg"
    },
    "labs": {
        "troponin": "86 ng/L",
        "creatinine": "1.4 mg/dL"
    }
}


evidence = [
    {
        "title": "Chest Pain Clinical Guidance",
        "source": "Test Medical Knowledge Base",
        "text": """
        Chest discomfort with elevated troponin may require
        evaluation for acute coronary syndrome. Serial troponin
        testing and ECG assessment may be relevant.
        """
    }
]


brief = {
    "summary": (
        "A patient with hypertension and diabetes "
        "presents with chest discomfort and requires "
        "further clinical evaluation."
    ),
    "key_findings": [
        "Persistent hypertension",
        "Chest discomfort",
        "Elevated troponin"
    ],
    "concerns": [
        "Cardiovascular risk"
    ],
    "missing_information": [
        "ECG findings",
        "Symptom onset"
    ],
    "clinical_possibilities": [
        "Acute coronary syndrome"
    ],
    "uncertainty": [
        "Acute coronary syndrome is not confirmed "
        "and requires further evaluation."
    ]
}


result = verify_clinical_brief(
    brief=brief,
    patient_state=patient_state,
    evidence=evidence
)


print("\n================================")
print("OmniMed Safety Verification Test")
print("================================")

print(
    "Status:",
    result["status"]
)

print(
    "Safe:",
    result["safe"]
)

print(
    "Evidence grounded:",
    result["evidence_grounded"]
)

print(
    "Issues:",
    result["issues"]
)

print(
    "Warnings:",
    result["warnings"]
)

print(
    "Verification:",
    result["verification"]
)