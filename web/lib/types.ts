export type PatientTestKey =
  | "pre_vas" | "post_vas"
  | "pre_tug_s" | "post_tug_s"
  | "pre_5xsst_s" | "post_5xsst_s"
  | "pre_normal_gs_ms" | "post_normal_gs_ms"
  | "pre_fast_gs_ms" | "post_fast_gs_ms"
  | "baseline_sppb" | "post_sppb";

export type Patient = {
  sn: number;
  id: string;
  initials: string;
  age: number;
  age_band: "<50" | "50-59" | "60-69" | "70-79" | "80+";
  gender: "F" | "M";
  cohort: string;
  usage_frequency: string;
  intake_date: string;
  tags: string;
  pre_vas: number;
  pre_tug_s: number;
  pre_5xsst_s: number;
  pre_normal_gs_ms: number;
  pre_fast_gs_ms: number;
  baseline_sppb: number;
  post_vas: number | null;
  post_tug_s: number | null;
  post_5xsst_s: number | null;
  post_normal_gs_ms: number | null;
  post_fast_gs_ms: number | null;
  post_sppb: number | null;
  composite_improvement: number | null;
  overall_responder: 0 | 1 | null;
  mcid_count: number;
  is_dropout: 0 | 1;
  has_followup?: "Y" | "N" | null;
  has_oa: 0 | 1;
  has_diabetes: 0 | 1;
  has_stroke: 0 | 1;
  has_parkinsons: 0 | 1;
  has_sarcopenia?: 0 | 1 | null;
  has_frailty: 0 | 1;
  has_balance_issue?: 0 | 1 | null;
  has_post_surgery?: 0 | 1 | null;
  has_chronic_pain?: 0 | 1 | null;
  has_neuropathy?: 0 | 1 | null;
  has_cancer: 0 | 1;
  has_cardiovascular?: 0 | 1 | null;
  has_hypertension: 0 | 1;
  has_osteoporosis: 0 | 1;
  has_spinal_issue?: 0 | 1 | null;
  has_knee_issue?: 0 | 1 | null;
  has_hip_issue?: 0 | 1 | null;
  has_shoulder_issue?: 0 | 1 | null;
  has_neurological?: 0 | 1 | null;
  has_fracture?: 0 | 1 | null;
  has_autoimmune?: 0 | 1 | null;
  has_metabolic?: 0 | 1 | null;
  has_wellness_only?: 0 | 1 | null;
  has_fall_risk?: 0 | 1 | null;
};

export type WearableFeatures = {
  enrolled: boolean;
  source: "clinic_only" | "clinic_and_wearable";
  wearable_steps_30d_avg?: number | null;
  wearable_sedentary_pct_30d?: number | null;
  wearable_cadence_avg_30d?: number | null;
  wearable_hrv_trend_7d?: number | null;
  wearable_fall_events_90d?: number | null;
  wearable_compliance_rate_30d?: number | null;
};

export type Filters = {
  cohorts: string[];
  usage: string[];
  ageBands: string[];
  gender: string[];
  fuOnly: boolean;
};

export type Tweaks = {
  accent: string;
  theme: "light" | "dark";
  density: "comfortable" | "compact";
  showFunnel: boolean;
  tabularNums: boolean;
};

export type PatientProfile = {
  age: number;
  gender: string;
  cohort: string;
  usage_frequency: string;
  pre_vas: number;
  pre_tug_s: number;
  pre_5xsst_s: number;
  pre_normal_gs_ms: number;
  pre_fast_gs_ms: number;
  baseline_sppb: number;
  has_followup?: "Y" | "N" | null;
  has_oa: 0 | 1;
  has_diabetes: 0 | 1;
  has_stroke: 0 | 1;
  has_parkinsons: 0 | 1;
  has_sarcopenia?: 0 | 1 | null;
  has_frailty: 0 | 1;
  has_balance_issue?: 0 | 1 | null;
  has_post_surgery?: 0 | 1 | null;
  has_chronic_pain?: 0 | 1 | null;
  has_neuropathy?: 0 | 1 | null;
  has_cancer: 0 | 1;
  has_cardiovascular?: 0 | 1 | null;
  has_hypertension: 0 | 1;
  has_osteoporosis: 0 | 1;
  has_copd?: 0 | 1 | null;
  has_depression?: 0 | 1 | null;
  has_spinal_issue?: 0 | 1 | null;
  has_knee_issue?: 0 | 1 | null;
  has_hip_issue?: 0 | 1 | null;
  has_shoulder_issue?: 0 | 1 | null;
  has_neurological?: 0 | 1 | null;
  has_fracture?: 0 | 1 | null;
  has_autoimmune?: 0 | 1 | null;
  has_metabolic?: 0 | 1 | null;
  has_wellness_only?: 0 | 1 | null;
  has_fall_risk?: 0 | 1 | null;
};

export type DosageIntake = {
  age: number;
  gender: string;
  joined_with_pain?: string;
  hl_knee_issue?: number;
  hl_leg_issue?: number;
  hl_back_spine_issue?: number;
  hl_balance_issue?: number;
  hl_upper_body_issue?: number;
  hl_foot_ankle_issue?: number;
  hl_neuro_issue?: number;
  hl_frailty_issue?: number;
  hl_metabolic_issue?: number;
  hl_injury_surgery_issue?: number;
  hl_general_pain_issue?: number;
};

export type PerTestPrediction = {
  name: string;
  baseline: number;
  predicted: number;
  mcid: boolean;
};

export type Contribution = {
  feature: string;
  value: number;
  direction: "positive" | "negative";
};

export type PredictionResult = {
  composite_improvement: number;
  p_responder: number;
  p_dropout: number;
  per_test: PerTestPrediction[];
  contributions: Contribution[];
};

export type DosageResult = {
  recommendation: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type FallRiskInput = {
  // Patient self-report
  age: number;
  gender: "M" | "F";
  falls_history: 0 | 1 | 2;
  walking_aid: "none" | "stick" | "frame";
  exercise_frequency: "rarely" | "1-2" | "3+";
  has_oa: 0 | 1;
  has_diabetes: 0 | 1;
  has_stroke: 0 | 1;
  has_parkinsons: 0 | 1;
  has_hypertension: 0 | 1;   // renamed from has_heart_disease
  has_frailty: 0 | 1;        // new explicit clinician field
  polypharmacy: 0 | 1;
  // Clinician (optional)
  pre_tug_s?: number | null;
  pre_5xsst_s?: number | null;
  pre_normal_gs_ms?: number | null;
  baseline_sppb?: number | null;
  pre_vas?: number | null;
  patient_id?: string;
};

export type FallRiskFactor = {
  label: string;
  impact: "high" | "moderate";
  explanation: string;
};

export type FallRiskResult = {
  risk_score: number;
  risk_label: "low" | "moderate" | "elevated" | "high";
  confidence: "standard" | "high";
  source?: "clinic_only" | "clinic_and_wearable";
  top_factors: FallRiskFactor[];
  cohort_stat: { improvement_pct: number; cohort_size: number };
};

export type TimelineSession = {
  session_number: number;
  session_date: string | null;
  notes: string | null;
  post_vas: number | null;
  post_tug_s: number | null;
  post_5xsst_s: number | null;
  post_normal_gs_ms: number | null;
  post_fast_gs_ms: number | null;
  post_sppb: number | null;
  composite_improvement: number | null;
  overall_responder: boolean | null;
  is_dropout: boolean;
};

export type TrendRow = {
  metric: string;
  direction: string;
  sessions_used: number;
  magnitude: number | null;
  first_value: number | null;
  last_value: number | null;
};

export type TimelineResponse = {
  patient: {
    sn: string;
    name: string;
    age: number;
    gender: string;
    cohort: string;
    primary_indication: string;
  };
  sessions: TimelineSession[];
  trends: TrendRow[];
};

export type InsightRow = {
  id: string;
  session_number: number | null;
  insight_type: string;
  question: string | null;
  content: string;
  model: string;
  created_at: string;
};

export interface AnomalyWarning {
  session_number: number | null;
  content: string;
  created_at: string;
}

export interface PlanRequest {
  session_focus?: string;
  plan_sessions?: number;
}

export interface TreatmentPlanResponse {
  plan: string;
  generated_at: string;
}


export type BenchmarkMetric = {
  metric: string;
  patient_value: number;
  percentile: number;
  percentile_display: string;
  n_compared: number;
  higher_is_better: boolean;
};

export type BenchmarkResult = {
  cohort: string | null;
  cohort_n: number;
  cohort_percentile: number | null;
  benchmarks: BenchmarkMetric[];
};
