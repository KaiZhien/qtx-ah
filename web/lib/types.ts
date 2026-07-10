export type PatientTestKey =
  | "pre_vas" | "post_vas"
  | "pre_tug_s" | "post_tug_s"
  | "pre_5xsst_s" | "post_5xsst_s"
  | "pre_normal_gs_ms" | "post_normal_gs_ms"
  | "pre_fast_gs_ms" | "post_fast_gs_ms"
  | "baseline_sppb" | "post_sppb";

// The API serialises `sn` as a String(20) column (values like "OLD123"), all
// condition/group/region flags + has_followup/is_dropout as JSON booleans, and
// overall_responder as a nullable boolean. Keep these in lock-step with the
// api/routers/patients.py `_row_to_dict` serialisation.
export type Patient = {
  sn: string;
  id: string;
  name?: string;
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
  overall_responder: boolean | null;
  mcid_count: number;
  is_dropout: boolean;
  has_followup?: boolean;
  has_oa: boolean;
  has_diabetes: boolean;
  has_stroke: boolean;
  has_parkinsons: boolean;
  has_sarcopenia?: boolean;
  has_frailty: boolean;
  has_balance_issue?: boolean;
  has_post_surgery?: boolean;
  has_chronic_pain?: boolean;
  has_neuropathy?: boolean;
  has_cancer: boolean;
  has_cardiovascular?: boolean;
  has_hypertension: boolean;
  has_osteoporosis: boolean;
  has_spinal_issue?: boolean;
  has_knee_issue?: boolean;
  has_hip_issue?: boolean;
  has_shoulder_issue?: boolean;
  has_neurological?: boolean;
  has_fracture?: boolean;
  has_autoimmune?: boolean;
  has_metabolic?: boolean;
  has_wellness_only?: boolean;
  has_fall_risk?: boolean;
};

/** Paginated envelope returned by GET /api/patients. */
export type PaginatedPatients = {
  items: Patient[];
  total: number;
  limit: number;
  offset: number;
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

export type BenchmarkMetric = {
  metric: string;
  patient_value: number;
  percentile: number;
  percentile_display: string;
  n_compared: number;
  higher_is_better: boolean;
};

export interface ResponseCurvePoint {
  session_number: number
  p25: number | null
  p50: number | null
  p75: number | null
  n: number
}

export interface ResponseCurve {
  metric: string
  points: ResponseCurvePoint[]
}

export interface ResponseCurvesResponse {
  grp_flag: string
  curves: ResponseCurve[]
}

export type BenchmarkResult = {
  cohort: string | null;
  cohort_n: number;
  cohort_percentile: number | null;
  benchmarks: BenchmarkMetric[];
};

export interface MetricSeriesPoint {
  session_number: number
  value: number
}

export interface MetricSeriesResponse {
  sn: string
  metric: string
  points: MetricSeriesPoint[]
}

// ---------------------------------------------------------------------------
// Wire DTOs for the remaining API endpoints. These previously lived inline in
// web/lib/api.ts; consolidated here so every response/DTO type has one home.
// ---------------------------------------------------------------------------

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

export interface PreSessionBrief {
  brief: string;
  cached: boolean;
  created_at: string;
}

export interface ModelFileInfo {
  size_mb: number;
  modified_at: string;
}

export interface RetrainMetrics {
  rmse_mean?: number;
  mae_mean?: number;
  r2_mean?: number;
  auc_roc_mean?: number;
  n?: number;
}

export interface RetrainState {
  last_retrain_at?: string;
  last_retrain_session_count?: number;
  last_metrics?: RetrainMetrics;
  error?: string;
}

export interface ModelStatusResponse {
  models: Record<string, ModelFileInfo>;
  retrain_state: RetrainState;
  db_ready: boolean;
}
