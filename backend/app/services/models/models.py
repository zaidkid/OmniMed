from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

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
    patient_id: str
    pathway: str
    monitoring: List[str] = Field(default_factory=list)
    pending_information: List[str] = Field(default_factory=list)
    follow_up: List[str] = Field(default_factory=list)
    clinician_note: Optional[str] = None

    # Saving a generated draft must never imply clinician approval.
    status: str = "draft"


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

class ReassessmentResponse(BaseModel):
    patient_id: str
    changed_items: List[Dict[str, Any]]
    care_plan_impact: str
    rationale: List[str]
    reassessment_questions: List[str]
    evidence: List[Dict[str, Any]]
    safety_note: str
