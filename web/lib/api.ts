import type {
  Filters,
  Patient,
  PatientProfile,
  PredictionResult,
  DosageIntake,
  DosageResult,
  FallRiskInput,
  FallRiskResult,
} from "./types";

export async function fetchPatients(filters: Filters): Promise<Patient[]> {
  const params = new URLSearchParams();
  filters.cohorts.forEach((c) => params.append("cohort", c));
  filters.usage.forEach((u) => params.append("usage", u));
  filters.ageBands.forEach((a) => params.append("age_band", a));
  filters.gender.forEach((g) => params.append("gender", g));
  if (filters.fuOnly) params.set("fu_only", "true");
  const res = await fetch(`/api/patients?${params.toString()}`);
  if (!res.ok) throw new Error(`fetchPatients: ${res.status}`);
  return res.json();
}

export async function fetchPatient(sn: number): Promise<Patient> {
  const res = await fetch(`/api/patient/${sn}`);
  if (!res.ok) throw new Error(`fetchPatient: ${res.status}`);
  return res.json();
}

export async function predictOutcomes(profile: PatientProfile): Promise<PredictionResult> {
  const res = await fetch("/api/predict/outcomes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error(`predictOutcomes: ${res.status}`);
  return res.json();
}

export async function predictDosage(intake: DosageIntake): Promise<DosageResult> {
  const res = await fetch("/api/predict/dosage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intake),
  });
  if (!res.ok) throw new Error(`predictDosage: ${res.status}`);
  return res.json();
}

export async function predictFallRisk(input: FallRiskInput): Promise<FallRiskResult> {
  const res = await fetch("/api/predict/fall-risk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`predictFallRisk: ${res.status}`);
  return res.json();
}
