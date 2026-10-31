"""Index short reference summaries so the verifier can ground the brief's clinical possibilities.

Run once with the backend running:   python seed_evidence.py
Entries are paraphrased summaries for development; verify against the cited guideline before
any real use, and replace them with your own curated sources.
"""
import argparse

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--api", default="http://127.0.0.1:8000")
api = parser.parse_args().api.rstrip("/")

ENTRIES = [
    ("Myocardial injury and infarction: troponin interpretation",
     "Fourth Universal Definition of Myocardial Infarction (2018), summary",
     "Myocardial injury is present when cardiac troponin exceeds the 99th percentile upper reference limit. "
     "A rise and/or fall in troponin indicates acute myocardial injury. Myocardial infarction additionally requires "
     "clinical evidence of ischaemia, such as symptoms, new ECG changes, or imaging findings. Troponin can be "
     "chronically elevated in kidney disease, so serial measurements and the change over time carry the interpretation."),
    ("Acute chest pain evaluation",
     "AHA/ACC Guideline for the Evaluation and Diagnosis of Chest Pain (2021), summary",
     "Patients with acute chest pain need prompt clinical assessment, a 12-lead ECG interpreted within minutes of "
     "arrival, and serial high-sensitivity cardiac troponin measurements. Chest pain with an abnormal ECG or rising "
     "troponin should be treated as a possible acute coronary syndrome and evaluated urgently by a clinician."),
    ("Chest discomfort: conditions that must not be missed",
     "AHA/ACC Guideline for the Evaluation and Diagnosis of Chest Pain (2021), summary",
     "The differential diagnosis of acute chest discomfort includes acute coronary syndrome, pulmonary embolism, "
     "aortic dissection, tension pneumothorax, pericarditis or myocarditis, and oesophageal rupture, as well as "
     "less urgent musculoskeletal and gastro-oesophageal causes. Time of symptom onset and ECG findings guide interpretation."),
    ("Acute kidney injury: definition",
     "KDIGO Clinical Practice Guideline for Acute Kidney Injury (2012), summary",
     "Acute kidney injury is defined by a rise in serum creatinine of at least 0.3 mg/dL within 48 hours, or to at "
     "least 1.5 times baseline within 7 days, or urine output below 0.5 mL/kg/hour for 6 hours. Assessment includes "
     "identifying the cause, reviewing nephrotoxic medicines and volume status, and monitoring the creatinine trend."),
    ("Chronic kidney disease: definition and cardiovascular risk",
     "KDIGO Clinical Practice Guideline for CKD (2024), summary",
     "Chronic kidney disease is defined by reduced eGFR (below 60 mL/min/1.73 m2) or markers of kidney damage "
     "persisting for more than three months. A single abnormal result does not establish chronicity. Chronic kidney "
     "disease is associated with higher cardiovascular risk."),
    ("Hypertension and diabetes as cardiovascular risk factors",
     "ACC/AHA Hypertension Guideline (2017) and ADA Standards of Care, summary",
     "Hypertension and diabetes mellitus are major risk factors for coronary artery disease, kidney disease and stroke. "
     "In patients with these conditions, new chest symptoms or renal function changes warrant careful review of "
     "blood pressure control, glycaemic control, and current medicines."),
    ("Documentation needed to interpret an acute presentation",
     "General clinical documentation principles, summary",
     "Interpreting an acute presentation depends on the exact time of symptom onset, serial test timings, a formal "
     "ECG interpretation, current medicines and adherence, allergies, and relevant history. Missing items should be "
     "stated explicitly rather than assumed."),
]

with httpx.Client(timeout=60) as client:
    for title, source, text in ENTRIES:
        r = client.post(f"{api}/api/evidence/index",
                        json={"title": title, "source": source, "text": text, "metadata": {"kind": "summary"}})
        print(("OK   " if r.is_success else f"FAIL {r.status_code} ") + title, "" if r.is_success else r.text[:200])