import type {
  Filters,
  Patient,
  PatientProfile,
  PredictionResult,
  DosageIntake,
  DosageResult,
  FallRiskInput,
  FallRiskResult,
  WearableFeatures,
  TimelineResponse,
  InsightRow,
} from "./types";

const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? "";

function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "X-Api-Key": API_KEY, ...extra };
}

export async function fetchPatients(filters: Filters): Promise<Patient[]> {
  const params = new URLSearchParams();
  filters.cohorts.forEach((c) => params.append("cohort", c));
  filters.usage.forEach((u) => params.append("usage", u));
  filters.ageBands.forEach((a) => params.append("age_band", a));
  filters.gender.forEach((g) => params.append("gender", g));
  if (filters.fuOnly) params.set("fu_only", "true");
  const res = await fetch(`/api/patients?${params.toString()}`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`fetchPatients: ${res.status}`);
  return res.json();
}

export async function fetchPatient(sn: number): Promise<Patient> {
  const res = await fetch(`/api/patient/${sn}`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`fetchPatient: ${res.status}`);
  return res.json();
}

export async function predictOutcomes(profile: PatientProfile): Promise<PredictionResult> {
  const res = await fetch("/api/predict/outcomes", {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error(`predictOutcomes: ${res.status}`);
  return res.json();
}

export async function predictDosage(intake: DosageIntake): Promise<DosageResult> {
  const res = await fetch("/api/predict/dosage", {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(intake),
  });
  if (!res.ok) throw new Error(`predictDosage: ${res.status}`);
  return res.json();
}

export async function predictFallRisk(input: FallRiskInput): Promise<FallRiskResult> {
  const res = await fetch("/api/predict/fall-risk", {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`predictFallRisk: ${res.status}`);
  return res.json();
}

export async function fetchWearableFeatures(patientId: string): Promise<WearableFeatures> {
  const res = await fetch(`/api/wearable/${encodeURIComponent(patientId)}/features`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`fetchWearableFeatures: ${res.status}`);
  return res.json();
}

export async function enrollPatient(
  patientId: string,
  deviceBrand: string
): Promise<{ widget_url: string; patient_id: string }> {
  const res = await fetch("/api/wearable/enroll", {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ patient_id: patientId, enrolled_by: "clinician", device_brand: deviceBrand }),
  });
  if (!res.ok) throw new Error(`enrollPatient: ${res.status}`);
  return res.json();
}

export async function fetchWearableSummary(): Promise<{ enrolled_count: number }> {
  const res = await fetch("/api/wearable/summary", {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`fetchWearableSummary: ${res.status}`);
  return res.json();
}

export async function fetchTimeline(sn: string): Promise<TimelineResponse> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/timeline`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`fetchTimeline: ${res.status}`);
  return res.json();
}

export async function fetchInsights(sn: string): Promise<InsightRow[]> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/insights`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`fetchInsights: ${res.status}`);
  return res.json();
}

export async function askQuestion(
  sn: string,
  question: string
): Promise<{ answer: string; model: string }> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/ask`, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`askQuestion: ${res.status}`);
  return res.json();
}

export function downloadPatientPdf(sn: string): void {
  const key = process.env.NEXT_PUBLIC_API_KEY ?? "";
  window.open(`/api/patient/${encodeURIComponent(sn)}/report.pdf?key=${key}`, "_blank");
}
