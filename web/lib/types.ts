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
  has_followup?: 0 | 1 | null;
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
  has_followup?: 0 | 1 | null;
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
