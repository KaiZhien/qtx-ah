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
  AnomalyWarning,
  PlanRequest,
  TreatmentPlanResponse,
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

export interface ShapContribution {
  feature: string;
  contribution: number;
}

export interface LatestPredictions {
  predicted_composite_improvement: number | null;
  responder_probability: number | null;
  dropout_probability: number | null;
  dosage_recommendation: string | null;
  predicted_at: string | null;
  shap_top5: ShapContribution[] | null;
  bias_correction: number | null;
}

export async function fetchLatestPredictions(sn: string): Promise<LatestPredictions | null> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/predictions/latest`, {
    headers: apiHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || Object.keys(data).length === 0) return null;
  return data as LatestPredictions;
}

export interface CohortCalibration {
  cohort: string;
  n: number;
  current_mae: number;
  baseline_mae: number | null;
  drift_pct: number | null;
  status: "OK" | "WARNING" | "ALERT" | "NO_BASELINE";
}

export interface ModelAucDrift {
  model: "classifier" | "dropout";
  baseline_auc: number | null;
  current_auc: number | null;
  drift_pct: number | null;
  status: "OK" | "WARNING" | "ALERT" | "NO_BASELINE";
  n: number;
}

export interface CalibrationReport {
  generated_at: string;
  drift_threshold: number;
  min_cohort_n: number;
  total_matchable: number;
  cohorts: CohortCalibration[];
  model_auc_drift?: ModelAucDrift[];
}

export async function fetchCalibration(): Promise<CalibrationReport | null> {
  const res = await fetch("/api/calibration", {
    headers: apiHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || Object.keys(data).length === 0) return null;
  return data as CalibrationReport;
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

export interface PreSessionBrief {
  brief: string;
  cached: boolean;
  created_at: string;
}

export async function prepareSession(sn: string, force?: boolean): Promise<PreSessionBrief> {
  const url = `/api/patient/${encodeURIComponent(sn)}/prepare_session${force ? "?force=true" : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`prepareSession: ${res.status}`);
  return res.json();
}

export interface BenchmarkResult {
  cohort_percentile: number | null;
}

export async function fetchBenchmark(sn: string): Promise<BenchmarkResult | null> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/benchmark`, {
    headers: apiHeaders(),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchLatestAnomaly(sn: string): Promise<AnomalyWarning | null> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/anomalies/latest`, {
    headers: apiHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchLatestAnomaly failed: ${res.status}`);
  const data = await res.json();
  if (data === null) return null;
  return data as AnomalyWarning;
}

export async function suggestPlan(
  sn: string,
  body: PlanRequest = {}
): Promise<TreatmentPlanResponse> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/suggest_plan`, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`suggestPlan: ${res.status}`);
  return res.json();
}

export function downloadPatientPdf(sn: string): void {
  const key = process.env.NEXT_PUBLIC_API_KEY ?? "";
  window.open(`/api/patient/${encodeURIComponent(sn)}/report.pdf?key=${key}`, "_blank");
}
