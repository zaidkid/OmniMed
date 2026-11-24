from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field, model_validator

class LabResult(BaseModel):
    name: str
    value: float
    unit: str
    timestamp: str

class Vitals(BaseModel):
    blood_pressure: Optional[str] = None
    heart_rate: Optional[float] = None
    spo2: Optional[float] = None
    temperature: Optional[float] = None
    respiratory_rate: Optional[float] = None

class PatientInput(BaseModel):
    patient_id: str
    age: int = Field(ge=0, le=130)
    sex: str
    conditions: List[str] = Field(default_factory=list)
    medications: List[str] = Field(default_factory=list)
    allergies: List[str] = Field(default_factory=list)
    symptoms: List[str] = Field(default_factory=list)
    labs: List[LabResult] = Field(default_factory=list)
    vitals: Vitals = Field(default_factory=Vitals)
    notes: List[str] = Field(default_factory=list)

class TimelineEvent(BaseModel):
    timestamp: str
    type: str
    name: str
    value: Optional[Any] = None
    unit: Optional[str] = None
    source: Optional[str] = None

class PatientState(BaseModel):
    patient_id: str
    age: int
    sex: str
    conditions: List[str]
    medications: List[str]
    allergies: List[str]
    symptoms: List[str]
    vitals: Vitals
    timeline: List[TimelineEvent]
    missing_information: List[str]
    notes: List[str]

class CarePlanInput(BaseModel):
    care_plan_id: Optional[str] = None
    patient_id: str
    pathway: str
    clinical_objectives: List[str] = Field(default_factory=list)
    monitoring: List[str] = Field(default_factory=list)
    pending_information: List[str] = Field(default_factory=list)
    follow_up: List[str] = Field(default_factory=list)
    safety_warnings: List[str] = Field(default_factory=list)
    uncertainty: List[str] = Field(default_factory=list)
    evidence_references: List[Any] = Field(default_factory=list)
    source_documents: List[str] = Field(default_factory=list)
    evidence_grounded: bool = False
    evidence_count: int = Field(default=0, ge=0)
    missing_sections: List[str] = Field(default_factory=list)
    generation_meta: Dict[str, Any] = Field(default_factory=dict)
    source_brief_generated_at: Optional[str] = None
    clinician_note: Optional[str] = None
    review_decisions: Dict[str, Literal["approved", "rejected"]] = Field(default_factory=dict)
    review_edits: Dict[str, str] = Field(default_factory=dict)
    review_state: Literal["awaiting_clinician_review", "reviewed", "approved"] = "awaiting_clinician_review"
    approved_at: Optional[str] = None
    created_at: Optional[str] = None

    # Saving a generated draft must never imply clinician approval.
    status: Literal["draft", "approved"] = "draft"

    @model_validator(mode="after")
    def require_complete_review_for_approval(self):
        if self.status != "approved":
            return self
        action_ids = [
            *(f"now-{i}" for i in range(len(self.clinical_objectives))),
            *(f"next-{i}" for i in range(len(self.follow_up))),
        ]
        if not action_ids or any(action_id not in self.review_decisions for action_id in action_ids):
            raise ValueError("Review every objective and follow-up item before approving the plan.")
        if not any(self.review_decisions[action_id] == "approved" for action_id in action_ids):
            raise ValueError("Approve at least one objective or follow-up item.")
        if not self.approved_at:
            raise ValueError("An approval timestamp is required.")
        return self


class CarePlan(BaseModel):
    care_plan_id: str
    patient_id: str
    pathway: str
    monitoring: List[str]
    pending_information: List[str]
    follow_up: List[str]
    clinician_note: Optional[str] = None
    status: str = "draft"
    created_at: str
    updated_at: str

class CarePlanGenerationRequest(BaseModel):
    patient_state: PatientState
    clinical_brief: Dict[str, Any]
    clinician_note: Optional[str] = None
    
class ClinicalBriefRequest(BaseModel):
    patient_state: PatientState
    clinical_question: Optional[str] = None

class ClinicalBriefResponse(BaseModel):
    patient_id: str
    summary: str
    key_findings: List[str]
    concerns: List[str]
    missing_information: List[str]
    clinical_possibilities: List[str]
    evidence: List[Dict[str, Any]]
    uncertainty: List[str]
    safety_note: str

class EvidenceSearchRequest(BaseModel):
    query: str
    top_k: int = Field(default=5, ge=1, le=20)

class EvidenceIndexRequest(BaseModel):
    title: str
    source: str
    text: str
    metadata: Dict[str, Any] = Field(default_factory=dict)

class ReassessmentRequest(BaseModel):
    previous_state: PatientState
    current_state: PatientState
    care_plan: CarePlan

class ReassessmentDecisionRequest(BaseModel):
    patient_id: str
    decision: Literal["accepted", "edit", "dismissed"]
    previous_state: PatientState
    current_state: PatientState
    care_plan: CarePlan
    clinician_note: Optional[str] = None

class ReassessmentResponse(BaseModel):
    patient_id: str
    changed_items: List[Dict[str, Any]]
    care_plan_impact: str
    rationale: List[str]
    reassessment_questions: List[str]
    evidence: List[Dict[str, Any]]
    safety_note: str
