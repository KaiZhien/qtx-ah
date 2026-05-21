export const COHORTS = [
  "Pain & Musculoskeletal",
  "Frailty/Sarcopenia",
  "Post-Surgical/Rehab",
  "Neurological",
  "Wellness",
  "Other-Mixed",
  "Unclassified",
];

export const COHORT_COLORS: Record<string, string> = {
  "Pain & Musculoskeletal": "#3b6bd9",
  "Frailty/Sarcopenia": "#7c5ad6",
  "Post-Surgical/Rehab": "#3aa394",
  "Neurological": "#d97746",
  "Wellness": "#5fa84a",
  "Other-Mixed": "#9aa3b2",
  "Unclassified": "#c8cdd6",
};

export const USAGE = [
  "Once (1x/week, one leg)",
  "Twice (2x/week, one leg per session)",
  "L+R 10 (20-min session, 10 min each leg)",
];

export const AGE_BANDS = ["<50", "50-59", "60-69", "70-79", "80+"];

export const FLAGS = [
  "has_followup",
  "has_oa",
  "has_diabetes",
  "has_stroke",
  "has_parkinsons",
  "has_sarcopenia",
  "has_frailty",
  "has_balance_issue",
  "has_post_surgery",
  "has_chronic_pain",
  "has_neuropathy",
  "has_cancer",
  "has_cardiovascular",
  "has_hypertension",
  "has_osteoporosis",
  "has_spinal_issue",
  "has_knee_issue",
  "has_hip_issue",
  "has_shoulder_issue",
  "has_neurological",
  "has_fracture",
  "has_autoimmune",
  "has_metabolic",
  "has_wellness_only",
  "has_fall_risk",
];

export const TEST_PAIRS: [string, string, string][] = [
  ["VAS (Pain)", "pre_vas", "post_vas"],
  ["TUG (s)", "pre_tug_s", "post_tug_s"],
  ["5xSST (s)", "pre_5xsst_s", "post_5xsst_s"],
  ["Normal Gait Speed (m/s)", "pre_normal_gs_ms", "post_normal_gs_ms"],
  ["Fast Gait Speed (m/s)", "pre_fast_gs_ms", "post_fast_gs_ms"],
  ["SPPB", "baseline_sppb", "post_sppb"],
];

export const DEFAULT_TWEAKS: import("./types").Tweaks = {
  accent: "#3357c4",
  theme: "light",
  density: "comfortable",
  showFunnel: true,
  tabularNums: true,
};

export const DEFAULT_FILTERS: import("./types").Filters = {
  cohorts: COHORTS,
  usage: USAGE,
  ageBands: AGE_BANDS,
  gender: ["F", "M"],
  fuOnly: false,
};

export const TESTS: {
  key: string;
  label: string;
  unit: string;
  pre: import("./types").PatientTestKey;
  post: import("./types").PatientTestKey;
  higherBetter: boolean;
  mcid: string;
}[] = [
  { key: "vas", label: "VAS (Pain)", unit: "0–10", pre: "pre_vas", post: "post_vas", higherBetter: false, mcid: "≥2 pts" },
  { key: "tug", label: "TUG", unit: "seconds", pre: "pre_tug_s", post: "post_tug_s", higherBetter: false, mcid: "≥3 s or 10%" },
  { key: "sst", label: "5×SST", unit: "seconds", pre: "pre_5xsst_s", post: "post_5xsst_s", higherBetter: false, mcid: "≥10%" },
  { key: "ngs", label: "Normal Gait", unit: "m/s", pre: "pre_normal_gs_ms", post: "post_normal_gs_ms", higherBetter: true, mcid: "≥0.05 m/s" },
  { key: "fgs", label: "Fast Gait", unit: "m/s", pre: "pre_fast_gs_ms", post: "post_fast_gs_ms", higherBetter: true, mcid: "≥0.10 m/s" },
  { key: "sppb", label: "SPPB", unit: "0–12", pre: "baseline_sppb", post: "post_sppb", higherBetter: true, mcid: "≥1 pt" },
];

export const FLAG_LABELS: Record<string, string> = {
  has_oa: "Osteoarthritis",
  has_diabetes: "Diabetes",
  has_stroke: "Stroke",
  has_parkinsons: "Parkinson's",
  has_sarcopenia: "Sarcopenia",
  has_frailty: "Frailty",
  has_balance_issue: "Balance issue",
  has_post_surgery: "Post-surgery",
  has_chronic_pain: "Chronic pain",
  has_neuropathy: "Neuropathy",
  has_cardiovascular: "Cardiovascular",
  has_hypertension: "Hypertension",
  has_osteoporosis: "Osteoporosis",
  has_spinal_issue: "Spinal",
  has_knee_issue: "Knee",
  has_hip_issue: "Hip",
  has_shoulder_issue: "Shoulder",
  has_neurological: "Neurological",
  has_fracture: "Fracture",
};
