"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ClipboardList, RefreshCw, Search } from "lucide-react";
import Shell from "../../components/Shell";
import { API } from "../../components/Ui";

type Plan = {
  care_plan_id: string; patient_id: string; pathway?: string; status?: string;
  updated_at?: string; source_brief_generated_at?: string; evidence_grounded?: boolean;
  clinical_objectives?: unknown[]; follow_up?: unknown[]; source_documents?: unknown[];
  evidence_references?: unknown[]; safety_note?: string; clinician_note?: string;
};
const strings = (value: unknown) => Array.isArray(value) ? value.map((x) => typeof x === "string" ? x : JSON.stringify(x)) : [];
const date = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : "Date unavailable";

export default function SavedCarePlansPage() {
  const [patientId, setPatientId] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const autoLoadPatient = useRef(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("patient_id");
    if (id) { autoLoadPatient.current = true; setPatientId(id); }
  }, []);

  const load = useCallback(async () => {
    const id = patientId.trim();
    if (!id) { setError("Enter a patient ID to load saved plans."); setPlans([]); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(`${API}/api/care-plans?patient_id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 220)}`);
      setPlans(await response.json() as Plan[]);
      setLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load saved care plans."); }
    finally { setLoading(false); }
  }, [patientId]);

  useEffect(() => {
    if (patientId.trim() && autoLoadPatient.current) {
      autoLoadPatient.current = false;
      void load();
    }
  }, [patientId, load]);

  return <Shell><main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 24px 48px", color: "#0f172a" }}>
    <header style={{ marginBottom: 24 }}>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 750 }}>Saved care plans</h1>
      <p style={{ color: "#64748b", margin: "7px 0 0" }}>Review saved drafts and approved plan snapshots for a patient.</p>
    </header>
    <section style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", background: "white", border: "1px solid #e2e8f0", borderRadius: 14, padding: 18, marginBottom: 18 }}>
      <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>Patient ID
        <input value={patientId} onChange={(e) => setPatientId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} placeholder="Enter patient ID" style={{ width: 280, maxWidth: "80vw", padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 9, font: "inherit" }} />
      </label>
      <button type="button" disabled={loading || !patientId.trim()} onClick={() => void load()} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#2563eb", border: 0, borderRadius: 9, color: "white", padding: "10px 14px", cursor: "pointer", opacity: loading ? .6 : 1 }}>
        {loading ? <RefreshCw size={15} /> : <Search size={15} />}{loading ? "Loading…" : "Load plans"}
      </button>
      {patientId.trim() && <Link href={`/?tab=Clinical%20Brief&patient_id=${encodeURIComponent(patientId.trim())}`} style={{ color: "#2563eb", fontSize: 13, padding: 10 }}>Generate a new plan</Link>}
    </section>
    {error && <div role="alert" style={{ padding: 14, marginBottom: 16, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10 }}>{error}</div>}
    {!loading && loaded && plans.length === 0 && !error && <div style={{ textAlign: "center", padding: 42, background: "white", border: "1px solid #e2e8f0", borderRadius: 14, color: "#64748b" }}><ClipboardList size={28} style={{ margin: "0 auto 10px" }} /><p>No saved care plans for this patient yet.</p><Link href={`/?tab=Clinical%20Brief&patient_id=${encodeURIComponent(patientId.trim())}`} style={{ color: "#2563eb" }}>Open the clinical workspace</Link></div>}
    <div style={{ display: "grid", gap: 14 }}>
      {plans.map((plan) => {
        const open = expanded === plan.care_plan_id;
        const objectives = strings(plan.clinical_objectives), followup = strings(plan.follow_up);
        const sources = [...strings(plan.source_documents), ...strings(plan.evidence_references)];
        return <article key={plan.care_plan_id} style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 14, overflow: "hidden" }}>
          <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? null : plan.care_plan_id)} style={{ width: "100%", display: "flex", gap: 14, alignItems: "center", textAlign: "left", border: 0, background: "white", padding: 18, cursor: "pointer", color: "inherit" }}>
            <span style={{ width: 42, height: 42, display: "grid", placeItems: "center", borderRadius: 11, background: "#eff6ff", color: "#2563eb", flexShrink: 0 }}><ClipboardList size={20} /></span>
            <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: "block", fontSize: 16 }}>{plan.pathway || "Care plan"}</strong><small style={{ color: "#64748b" }}>Updated {date(plan.updated_at)} · Plan {plan.care_plan_id.slice(0, 8)}</small></span>
            <span style={{ borderRadius: 99, padding: "5px 10px", fontSize: 12, fontWeight: 700, background: plan.status === "approved" ? "#dcfce7" : "#fef3c7", color: plan.status === "approved" ? "#166534" : "#92400e" }}>{plan.status || "draft"}</span>
          </button>
          {open && <div style={{ borderTop: "1px solid #e2e8f0", padding: "18px 22px", lineHeight: 1.6 }}>
            <p style={{ marginTop: 0, color: "#475569" }}>Patient {plan.patient_id} · {plan.evidence_grounded ? "Evidence passages were retrieved" : "No evidence passages were recorded"}</p>
            {plan.safety_note && <p style={{ padding: 12, background: "#fff7ed", color: "#9a3412", borderRadius: 9 }}>{plan.safety_note}</p>}
            {[["Clinical objectives", objectives], ["Follow-up", followup], ["Sources", sources]].map(([title, items]) => <section key={title as string} style={{ marginTop: 14 }}><strong>{title as string}</strong>{(items as string[]).length ? <ul style={{ marginTop: 6 }}>{(items as string[]).map((item, i) => <li key={i}>{item}</li>)}</ul> : <p style={{ color: "#94a3b8", margin: "4px 0" }}>None recorded.</p>}</section>)}
            {plan.status === "approved" && <p style={{ display: "flex", alignItems: "center", gap: 7, color: "#15803d" }}><CheckCircle2 size={16} /> Approved snapshot</p>}
            <Link href={`/reassessment?patient_id=${encodeURIComponent(plan.patient_id)}`} style={{ display: "inline-block", marginTop: 8, color: "#2563eb" }}>Open reassessment</Link>
          </div>}
        </article>;
      })}
    </div>
  </main></Shell>;
}
