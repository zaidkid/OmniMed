"""Rule-based urgency screening of report text.

Transparent and conservative: every signal quotes the sentence it came from, the result is
always labelled as automated screening, and it can only RAISE the urgency shown to the
clinician (see merge_urgency), never lower the model's assessment. It can miss findings
and is not a triage decision.
"""
from __future__ import annotations

import re
from typing import Any

EMERGENT, URGENT, ROUTINE = "emergent", "urgent", "routine"
_ORDER = {ROUTINE: 0, URGENT: 1, EMERGENT: 2}

URGENCY_LABELS = {
    EMERGENT: "High urgency: immediate clinician review recommended",
    URGENT: "Elevated: prompt clinician review recommended",
    ROUTINE: "No urgent signals identified: routine clinician review",
}

NOTE = (
    "Automated keyword and threshold screening of the report text, combined with the model's "
    "assessment (the higher level is shown). It can miss findings and is not a triage decision."
)

_NEGATION = re.compile(
    r"(?:\bno\b|\bdenies\b|\bdenied\b|\bwithout\b|\bnegative for\b|\babsence of\b|\bnot reported\b)[^.;\n]{0,40}$",
    re.I,
)

# (id, label, severity, pattern)
_KEYWORDS: list[tuple[str, str, str, str]] = [
    ("chest_symptom", "Chest pain or discomfort", EMERGENT,
     r"chest\s+(?:pain|discomfort|tightness|pressure|heaviness)|\bangina\b"),
    ("syncope", "Syncope or collapse", EMERGENT,
     r"\bsyncop\w*|\bcollapsed?\b|loss of consciousness|\bunresponsive\b"),
    ("arrest", "Cardiac or respiratory arrest", EMERGENT,
     r"cardiac arrest|respiratory arrest|resuscitation"),
    ("stroke", "Possible stroke symptoms", EMERGENT,
     r"facial droop|slurred speech|hemiparesis|\bstroke\b|sudden weakness"),
    ("sepsis", "Sepsis mentioned", EMERGENT, r"\bsepsis\b|\bseptic\b"),
    ("bleeding", "Significant bleeding", EMERGENT,
     r"active bleeding|h(?:a)?emorrhage|\bmelena\b|hematemesis|haemoptysis|hemoptysis"),
    ("anaphylaxis", "Anaphylaxis", EMERGENT, r"anaphyla\w*"),
    ("self_harm", "Self-harm or suicidal ideation", EMERGENT, r"suicid\w*|self[- ]harm"),
    ("dka", "Diabetic ketoacidosis mentioned", EMERGENT, r"ketoacidosis|\bDKA\b"),
    ("st_elevation", "ST-segment elevation", EMERGENT, r"ST[- ]?(?:segment\s+)?elevation|\bSTEMI\b"),
    ("ecg_change", "ECG abnormality reported", URGENT,
     r"ST[- ]?(?:segment\s+)?depression|T[- ]wave inversion|\bLBBB\b|atrial fibrillation|"
     r"ventricular tachycardia|ECG[^.\n]{0,30}abnormal\w*|abnormal\w*\s+ECG|ECG\s+changes?"),
    ("dyspnea", "Shortness of breath", URGENT,
     r"shortness of breath|dyspn(?:o)?ea|breathless\w*"),
    ("aki_term", "Acute kidney injury mentioned", URGENT, r"acute kidney injury|\bAKI\b"),
]

_UNIT = r"(?:[A-Za-zµ/%]{1,8})?"
_PAIR = rf"(\d+(?:\.\d+)?)\s*{_UNIT}\s*(?:→|->|=>|\bto\b|\bthen\b|,|;)\s*(\d+(?:\.\d+)?)"
_RISING_WORDS = re.compile(
    r"rising|increas\w+|elevated|raised|positive|above (?:the )?(?:99th|upper)|\bhigh\b", re.I)
_NORMAL_WORDS = re.compile(r"negative|\bnormal\b|within normal|not elevated|undetectable", re.I)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text or "") if s.strip()]


def _negated(sentence: str, start: int) -> bool:
    return bool(_NEGATION.search(sentence[:start][-60:]))


def _pair(sentence: str, keyword: str) -> tuple[float, float] | None:
    m = re.search(rf"{keyword}[^\n]{{0,80}}?{_PAIR}", sentence, re.I)
    return (float(m.group(1)), float(m.group(2))) if m else None


def _first(sentence: str, pattern: str) -> re.Match | None:
    return re.search(pattern, sentence, re.I)


def _numeric_signals(s: str) -> list[tuple[str, str, str]]:
    """(id, label, severity) for vital-sign and laboratory thresholds found in one sentence."""
    found: list[tuple[str, str, str]] = []

    if m := _first(s, r"(?:\bBP\b|blood pressure)\D{0,12}(\d{2,3})\s*/\s*(\d{2,3})"):
        sys_, dia = int(m.group(1)), int(m.group(2))
        if 40 <= sys_ < 90:
            found.append(("low_bp", f"Low blood pressure ({sys_}/{dia})", EMERGENT))
        elif sys_ >= 180 or dia >= 120:
            found.append(("high_bp", f"Severely raised blood pressure ({sys_}/{dia})", URGENT))

    if m := _first(s, r"(?:SpO2|SpO₂|O2 sat\w*|oxygen saturation)\D{0,12}(\d{2,3})"):
        v = int(m.group(1))
        if 50 <= v < 90:
            found.append(("low_spo2", f"Low oxygen saturation ({v}%)", EMERGENT))
        elif 90 <= v < 94:
            found.append(("low_spo2", f"Borderline oxygen saturation ({v}%)", URGENT))

    if m := _first(s, r"(?:\bHR\b|heart rate|pulse)\D{0,12}(\d{2,3})"):
        v = int(m.group(1))
        if 20 <= v < 40 or 130 < v <= 250:
            found.append(("abnormal_hr", f"Marked heart rate abnormality ({v}/min)", EMERGENT))
        elif 40 <= v < 50 or 110 < v <= 130:
            found.append(("abnormal_hr", f"Heart rate abnormality ({v}/min)", URGENT))

    if m := _first(s, r"potassium\D{0,12}(\d+(?:\.\d+)?)"):
        v = float(m.group(1))
        if v >= 6.5 or 0 < v < 2.8:
            found.append(("potassium", f"Critical potassium ({v:g})", EMERGENT))
        elif v >= 5.5:
            found.append(("potassium", f"Raised potassium ({v:g})", URGENT))

    if m := _first(s, r"glucose\D{0,12}(\d+(?:\.\d+)?)\s*(mg/dL|mmol/L)?"):
        v, unit = float(m.group(1)), (m.group(2) or ("mg/dL" if float(m.group(1)) > 30 else "mmol/L"))
        low, high = (54, 400) if unit == "mg/dL" else (3.0, 22)
        if 0 < v < low or v > high:
            found.append(("glucose", f"Critical glucose ({v:g} {unit})", EMERGENT))

    if _first(s, r"troponin"):
        pair = _pair(s, r"troponin")
        rising = bool(_RISING_WORDS.search(s)) or (pair is not None and pair[0] > 0 and pair[1] >= 1.5 * pair[0])
        if rising and not (_NORMAL_WORDS.search(s) and not _RISING_WORDS.search(s)):
            tail = f" ({pair[0]:g} to {pair[1]:g})" if pair else ""
            found.append(("troponin", f"Troponin rising or elevated{tail}", EMERGENT))

    if _first(s, r"creatinine"):
        pair = _pair(s, r"creatinine")
        rise = pair is not None and pair[0] > 0 and (pair[1] - pair[0] >= 0.3 or pair[1] >= 1.5 * pair[0])
        if rise or re.search(r"creatinine[^.\n]{0,40}(?:rising|increas\w+|elevated|raised)", s, re.I):
            tail = f" ({pair[0]:g} to {pair[1]:g})" if pair else ""
            found.append(("creatinine", f"Creatinine rise{tail}: meets possible acute kidney injury "
                          "criteria if within 48 hours", URGENT))
    return found


def screen_report(text: str) -> dict[str, Any]:
    """Return {level, label, signals[{id,label,severity,snippet}], method, note}."""
    signals: dict[str, dict[str, str]] = {}

    def add(sig_id: str, label: str, severity: str, snippet: str) -> None:
        if sig_id not in signals:
            signals[sig_id] = {"id": sig_id, "label": label, "severity": severity, "snippet": snippet[:220]}

    for sentence in _sentences(text):
        for sig_id, label, severity, pattern in _KEYWORDS:
            m = re.search(pattern, sentence, re.I)
            if m and not _negated(sentence, m.start()):
                add(sig_id, label, severity, sentence)
        for sig_id, label, severity in _numeric_signals(sentence):
            add(sig_id, label, severity, sentence)

    if "chest_symptom" in signals and "troponin" in signals:
        add("chest_troponin", "Chest symptoms together with rising troponin", EMERGENT,
            "Cardiac-type symptom and troponin change found in the same report. "
            "This combination warrants immediate clinician review.")

    level = ROUTINE
    for sig in signals.values():
        if _ORDER[sig["severity"]] > _ORDER[level]:
            level = sig["severity"]
    ordered = sorted(signals.values(), key=lambda x: -_ORDER[x["severity"]])
    return {"level": level, "label": URGENCY_LABELS[level], "signals": ordered,
            "method": "rule_based", "note": NOTE}


def merge_urgency(rule_level: str | None, model_level: str | None) -> str:
    """The higher of the two levels. The model can never lower a rule-based flag."""
    levels = [x for x in (rule_level, model_level) if x in _ORDER]
    return max(levels, key=_ORDER.get) if levels else ROUTINE