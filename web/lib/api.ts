import type {
  BenchmarkResult,
  Filters,
  Patient,
  PaginatedPatients,
  PatientProfile,
  PredictionResult,
  DosageIntake,
  DosageResult,
  WearableFeatures,
  TimelineResponse,
  InsightRow,
  AnomalyWarning,
  ResponseCurvesResponse,
  MetricSeriesResponse,
  LatestPredictions,
  CalibrationReport,
  PreSessionBrief,
  ModelStatusResponse,
} from "./types";

// Requests go through the same-origin BFF proxy (web/app/api/[...path]/route.ts),
// which validates the clinician session server-side and injects the API key.
// The browser never holds a key.
function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...extra };
}

/**
 * Fetch one page of patients. GET /api/patients returns a paginated envelope
 * `{ items, total, limit, offset }`. `limit` is capped at 1000 server-side.
 */
export async function fetchPatients(
  filters: Filters,
  opts: { limit?: number; offset?: number } = {}
): Promise<PaginatedPatients> {
  const params = new URLSearchParams();
  filters.cohorts.forEach((c) => params.append("cohort", c));
  filters.usage.forEach((u) => params.append("usage", u));
  filters.ageBands.forEach((a) => params.append("age_band", a));
  filters.gender.forEach((g) => params.append("gender", g));
  if (filters.fuOnly) params.set("fu_only", "true");
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const res = await fetch(`/api/patients?${params.toString()}`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`fetchPatients: ${res.status}`);
  return res.json();
}

/**
 * Fetch the full filtered cohort by paging through the envelope until every
 * record is collected. The dashboard aggregates over the whole set, so it needs
 * all pages (the cohort is ~1.7k rows > the 1000-row page cap).
 */
export async function fetchAllPatients(filters: Filters): Promise<Patient[]> {
  const pageSize = 1000;
  const first = await fetchPatients(filters, { limit: pageSize, offset: 0 });
  const items = [...first.items];
  while (items.length < first.total && first.items.length > 0) {
    const page = await fetchPatients(filters, { limit: pageSize, offset: items.length });
    if (page.items.length === 0) break;
    items.push(...page.items);
  }
  return items;
}

export async function fetchPatient(sn: string): Promise<Patient> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}`, {
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

export async function fetchLatestPredictions(sn: string): Promise<LatestPredictions | null> {
  const res = await fetch(`/api/patient/${encodeURIComponent(sn)}/predictions/latest`, {
    headers: apiHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || Object.keys(data).length === 0) return null;
  return data as LatestPredictions;
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

export async function prepareSession(sn: string, force?: boolean): Promise<PreSessionBrief> {
  const url = `/api/patient/${encodeURIComponent(sn)}/prepare_session${force ? "?force=true" : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`prepareSession: ${res.status}`);
  return res.json();
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

export function downloadPatientPdf(sn: string): void {
  // Same-origin navigation carries the session cookie; the BFF proxy authorizes
  // and injects the API key, then streams the PDF back.
  window.open(`/api/patient/${encodeURIComponent(sn)}/report.pdf`, "_blank");
}

export async function getModelStatus(adminKey: string): Promise<ModelStatusResponse> {
  const res = await fetch("/api/admin/model_status", {
    headers: { "X-Admin-Key": adminKey },
  });
  if (!res.ok) throw new Error(`getModelStatus: ${res.status}`);
  return res.json();
}

export async function triggerRetrain(adminKey: string): Promise<{ status: string }> {
  const res = await fetch("/api/admin/trigger_retrain", {
    method: "POST",
    headers: { "X-Admin-Key": adminKey },
  });
  if (!res.ok) throw new Error(`triggerRetrain: ${res.status}`);
  return res.json();
}

export async function reloadModels(adminKey: string): Promise<{ status: string; models_loaded: string[] }> {
  const res = await fetch("/api/admin/reload-models", {
    method: "POST",
    headers: { "X-Admin-Key": adminKey },
  });
  if (!res.ok) throw new Error(`reloadModels: ${res.status}`);
  return res.json();
}

export async function getResponseCurves(
  grpFlag: string,
  metric?: string
): Promise<ResponseCurvesResponse | null> {
  const url = `/api/cohort/${encodeURIComponent(grpFlag)}/response_curves${metric ? `?metric=${encodeURIComponent(metric)}` : ""}`;
  const res = await fetch(url, { headers: apiHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getResponseCurves: ${res.status}`);
  return res.json();
}

export async function fetchMetricSeries(
  sn: string,
  metric: "vas_change" | "tug_change_pct"
): Promise<MetricSeriesResponse> {
  const res = await fetch(
    `/api/patient/${encodeURIComponent(sn)}/metric_series?metric=${metric}`,
    { headers: apiHeaders() }
  )
  if (!res.ok) throw new Error(`fetchMetricSeries: ${res.status}`)
  return res.json()
}
