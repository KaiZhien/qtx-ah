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
  "has_cardiovascular",
  "has_hypertension",
  "has_osteoporosis",
  "has_spinal_issue",
  "has_knee_issue",
  "has_hip_issue",
  "has_shoulder_issue",
  "has_neurological",
  "has_fracture",
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
