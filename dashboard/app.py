"""Streamlit dashboard — internal clinical analytics view for QuantumTX AH.

Loads dashboard-ready Parquet data from data/processed/, renders:
  - Sidebar filters (cohort, usage_frequency, age_band, gender, record_type)
  - KPI strip (N patients, % with follow-up, mean composite improvement, % responders)
  - Pre vs Post boxplots by test
  - Phenotype-to-outcome horizontal bar chart
  - Intake Estimator with ML-backed predictions

Run with: streamlit run dashboard/app.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure src/ is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import joblib
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from qtx.utils.config import get_project_root
from qtx.phenotype.classify import classify

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="QuantumTX AH — Clinical Dashboard",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROJECT_ROOT = get_project_root()
DATA_PATH = PROJECT_ROOT / "data" / "processed" / "dashboard_data.parquet"
MODELS_DIR = PROJECT_ROOT / "models"

# ---------------------------------------------------------------------------
# Data & model loaders (cached)
# ---------------------------------------------------------------------------


@st.cache_data
def load_data() -> pd.DataFrame:
    return pd.read_parquet(DATA_PATH)


@st.cache_resource
def load_models() -> dict:
    return {
        "regression": joblib.load(MODELS_DIR / "regression.joblib"),
        "classifier": joblib.load(MODELS_DIR / "classifier.joblib"),
        "dropout": joblib.load(MODELS_DIR / "dropout.joblib"),
    }


df_full = load_data()
models = load_models()

# ---------------------------------------------------------------------------
# Sidebar filters
# ---------------------------------------------------------------------------

st.sidebar.title("Navigation")
st.sidebar.page_link("app.py", label="Clinical Dashboard", icon="🏥")
st.sidebar.page_link("pages/dosage_recommender.py", label="Dosage Recommender", icon="💊")
st.sidebar.divider()
st.sidebar.title("Filters")

# Helper: sorted unique values including NaN replacement
def _unique_sorted(series: pd.Series) -> list:
    vals = sorted(series.dropna().unique().tolist())
    if series.isna().any() and "__missing__" not in vals:
        vals.append("__missing__")
    return vals


all_cohorts = _unique_sorted(df_full["cohort"])
all_usage = _unique_sorted(df_full["usage_frequency"])
all_age_bands = _unique_sorted(df_full["age_band"])
all_genders = _unique_sorted(df_full["gender"])
all_record_types = _unique_sorted(df_full["record_type"])

sel_cohort = st.sidebar.multiselect("Cohort", all_cohorts, default=all_cohorts)
sel_usage = st.sidebar.multiselect("Usage Frequency", all_usage, default=all_usage)
sel_age_band = st.sidebar.multiselect("Age Band", all_age_bands, default=all_age_bands)
sel_gender = st.sidebar.multiselect("Gender", all_genders, default=all_genders)
sel_record_type = st.sidebar.multiselect("Record Type", all_record_types, default=all_record_types)

if st.sidebar.button("Reset Filters"):
    st.rerun()

# ---------------------------------------------------------------------------
# Apply filters
# ---------------------------------------------------------------------------

df = df_full.copy()

if sel_cohort:
    df = df[df["cohort"].isin(sel_cohort)]
if sel_usage:
    df = df[df["usage_frequency"].isin(sel_usage)]
if sel_age_band:
    df = df[df["age_band"].isin(sel_age_band)]
if sel_gender:
    df = df[df["gender"].isin(sel_gender)]
if sel_record_type:
    df = df[df["record_type"].isin(sel_record_type)]

st.title("QuantumTX AH — Clinical Analytics Dashboard")

if df.empty:
    st.warning("No data matches the current filters. Please adjust your selections.")
    st.stop()

# ---------------------------------------------------------------------------
# KPI strip
# ---------------------------------------------------------------------------

df_followup = df[df["has_followup"] == 1] if "has_followup" in df.columns else pd.DataFrame()

# Fallback: treat rows with any post value as having followup
if df_followup.empty:
    post_cols = ["post_vas", "post_tug_s", "post_5xsst_s", "post_normal_gs_ms", "post_sppb"]
    existing_post = [c for c in post_cols if c in df.columns]
    if existing_post:
        df_followup = df[df[existing_post].notna().any(axis=1)]

n_patients = len(df)
pct_followup = 100 * len(df_followup) / n_patients if n_patients > 0 else 0.0

if not df_followup.empty and "composite_improvement" in df_followup.columns:
    mean_improvement = df_followup["composite_improvement"].mean()
    if pd.isna(mean_improvement):
        mean_improvement = None
else:
    mean_improvement = None

if not df_followup.empty and "overall_responder" in df_followup.columns:
    pct_responders = 100 * df_followup["overall_responder"].mean()
    if pd.isna(pct_responders):
        pct_responders = None
else:
    pct_responders = None

col1, col2, col3, col4 = st.columns(4)
col1.metric("N Patients", f"{n_patients:,}")
col2.metric("% with Follow-up", f"{pct_followup:.1f}%")
col3.metric(
    "Mean Composite Improvement",
    f"{mean_improvement:.2f}" if mean_improvement is not None else "N/A",
    help="Of patients with follow-up data",
)
col4.metric(
    "% Overall Responders",
    f"{pct_responders:.1f}%" if pct_responders is not None else "N/A",
    help="Of patients with follow-up data",
)

st.divider()

# ---------------------------------------------------------------------------
# Section 1: Pre vs Post by test
# ---------------------------------------------------------------------------

st.subheader("Pre vs Post by Test")

TEST_PAIRS = [
    ("VAS (Pain)", "pre_vas", "post_vas"),
    ("TUG (s)", "pre_tug_s", "post_tug_s"),
    ("5xSST (s)", "pre_5xsst_s", "post_5xsst_s"),
    ("Normal Gait Speed (m/s)", "pre_normal_gs_ms", "post_normal_gs_ms"),
    ("Fast Gait Speed (m/s)", "pre_fast_gs_ms", "post_fast_gs_ms"),
    ("SPPB", "baseline_sppb", "post_sppb"),
]

# Filter to available columns
TEST_PAIRS = [
    (label, pre, post)
    for label, pre, post in TEST_PAIRS
    if pre in df.columns and post in df.columns
]

if TEST_PAIRS:
    # Build 2-row × 3-col subplot grid
    n_tests = len(TEST_PAIRS)
    n_cols = 3
    n_rows = (n_tests + n_cols - 1) // n_cols

    fig_prepost = make_subplots(
        rows=n_rows,
        cols=n_cols,
        subplot_titles=[t[0] for t in TEST_PAIRS],
        vertical_spacing=0.15,
        horizontal_spacing=0.08,
    )

    COLORS = {"Pre": "#4C78A8", "Post": "#F58518"}

    for idx, (label, pre_col, post_col) in enumerate(TEST_PAIRS):
        row = idx // n_cols + 1
        col = idx % n_cols + 1

        # Only include paired (both non-null) observations
        paired = df[[pre_col, post_col]].dropna()

        for phase, col_name, color in [("Pre", pre_col, COLORS["Pre"]), ("Post", post_col, COLORS["Post"])]:
            fig_prepost.add_trace(
                go.Box(
                    y=paired[col_name],
                    name=phase,
                    marker_color=color,
                    showlegend=(idx == 0),
                    legendgroup=phase,
                    boxmean=True,
                ),
                row=row,
                col=col,
            )

    fig_prepost.update_layout(
        height=420 * n_rows,
        title_text="Pre vs Post Comparison (Paired Observations)",
        boxmode="group",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    )

    st.plotly_chart(fig_prepost, use_container_width=True)
else:
    st.info("No pre/post test columns found in the filtered data.")

st.divider()

# ---------------------------------------------------------------------------
# Section 2: Phenotype-to-outcome breakdown
# ---------------------------------------------------------------------------

st.subheader("Mean Composite Improvement by Comorbidity Flag")

has_cols = [c for c in df.columns if c.startswith("has_") and c != "has_followup"]

if has_cols and "composite_improvement" in df.columns:
    rows = []
    for col in has_cols:
        sub = df[df[col] == 1]["composite_improvement"].dropna()
        if len(sub) >= 10:
            rows.append({"flag": col.replace("has_", "").replace("_", " ").title(), "mean_improvement": sub.mean(), "n": len(sub)})

    if rows:
        flag_df = pd.DataFrame(rows).sort_values("mean_improvement", ascending=True)

        fig_flags = go.Figure(go.Bar(
            x=flag_df["mean_improvement"],
            y=flag_df["flag"],
            orientation="h",
            marker_color="#54A24B",
            text=[f"n={r['n']}" for _, r in flag_df.iterrows()],
            textposition="outside",
        ))
        fig_flags.update_layout(
            title="Mean Composite Improvement by Comorbidity Flag",
            xaxis_title="Mean Composite Improvement",
            yaxis_title="",
            height=max(400, 40 * len(flag_df)),
            margin=dict(l=200),
        )
        st.plotly_chart(fig_flags, use_container_width=True)
    else:
        st.info("No comorbidity flags have >= 10 patients with composite improvement data.")
else:
    st.info("Comorbidity flag or composite_improvement data not available.")

st.divider()

# ---------------------------------------------------------------------------
# Section 3: Intake Estimator
# ---------------------------------------------------------------------------

COHORT_OPTIONS = [
    "Pain & Musculoskeletal",
    "Neurological",
    "Frailty/Sarcopenia",
    "Post-Surgical/Rehab",
    "Wellness",
    "Other-Mixed",
    "Unclassified",
]

USAGE_OPTIONS = [
    "L+R 10 (20-min session, 10 min each leg)",
    "Once (1x/week, one leg)",
    "Twice (2x/week, one leg per session)",
]

# Feature names from the models (all three share the same feature set)
FEATURE_NAMES: list[str] = list(models["regression"].feature_names_in_)

# Categorical dummy columns derived from feature names
COHORT_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("cohort_")]
USAGE_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("usage_frequency_")]
GENDER_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("gender_")]


def _build_input_row(
    age: float,
    baseline_sppb: int,
    pre_tug: float,
    pre_5xsst: float,
    pre_normal_gs: float,
    usage: str,
    cohort: str,
    gender: str,
    has_flags: dict[str, int],
) -> pd.DataFrame:
    """Build a one-row DataFrame with the exact columns expected by the models."""
    row: dict[str, float] = {}

    # Numeric features
    row["age"] = age
    row["baseline_sppb"] = float(baseline_sppb)
    row["pre_normal_gs_ms"] = pre_normal_gs
    row["pre_tug_s"] = pre_tug
    row["pre_5xsst_s"] = pre_5xsst

    # has_* flags present in model features
    for feat in FEATURE_NAMES:
        if feat.startswith("has_"):
            row[feat] = float(has_flags.get(feat, 0))

    # Cohort dummies (drop first = Frailty/Sarcopenia is the reference)
    for col in COHORT_DUMMIES:
        cohort_val = col.replace("cohort_", "")
        row[col] = 1.0 if cohort == cohort_val else 0.0

    # Usage frequency dummies
    for col in USAGE_DUMMIES:
        usage_val = col.replace("usage_frequency_", "")
        row[col] = 1.0 if usage == usage_val else 0.0

    # Gender dummies (gender_M only)
    for col in GENDER_DUMMIES:
        gender_val = col.replace("gender_", "")
        row[col] = 1.0 if gender == gender_val else 0.0

    # Ensure all expected features are present (fill missing with 0)
    for feat in FEATURE_NAMES:
        if feat not in row:
            row[feat] = 0.0

    return pd.DataFrame([row])[FEATURE_NAMES]


with st.expander("Intake Estimator — Predicted Benefit"):
    st.markdown("Enter patient details to get model-predicted outcomes.")

    ec1, ec2 = st.columns(2)
    with ec1:
        inp_age = st.number_input("Age", min_value=10, max_value=110, value=65, step=1)
        inp_sppb = st.slider("Baseline SPPB", min_value=0, max_value=12, value=6)
        inp_tug = st.number_input("Baseline TUG (seconds)", min_value=0.0, value=15.0, step=0.5)
        inp_5xsst = st.number_input("Baseline 5xSST (seconds)", min_value=0.0, value=20.0, step=0.5)
        inp_gs = st.number_input("Baseline Normal Gait Speed (m/s)", min_value=0.0, value=0.8, step=0.05, format="%.2f")

    with ec2:
        inp_usage = st.selectbox("Usage Frequency", USAGE_OPTIONS)
        inp_cohort = st.selectbox("Cohort", COHORT_OPTIONS)
        inp_gender = st.selectbox("Gender", ["M", "F", "Unknown"])
        inp_tags = st.text_input(
            "Comorbidity Tags (free text)",
            placeholder="e.g. knee osteoarthritis, diabetes",
            help="Used to derive has_* flags via the phenotype classifier",
        )

    predict_btn = st.button("Predict", type="primary")

    if predict_btn:
        # Derive has_* flags from tags text
        tags_df = pd.DataFrame([{"tags": inp_tags, "pain_location": ""}])
        try:
            classified = classify(tags_df)
            has_flags_derived: dict[str, int] = {
                col: int(classified[col].iloc[0])
                for col in classified.columns
                if col.startswith("has_")
            }
        except Exception as e:
            st.warning(f"Phenotype classification failed ({e}). Using zero flags.")
            has_flags_derived = {}

        # Resolve gender value for dummies
        gender_for_model = inp_gender if inp_gender != "Unknown" else "__missing__"

        # Build input row
        X_pred = _build_input_row(
            age=float(inp_age),
            baseline_sppb=inp_sppb,
            pre_tug=inp_tug,
            pre_5xsst=inp_5xsst,
            pre_normal_gs=inp_gs,
            usage=inp_usage,
            cohort=inp_cohort,
            gender=gender_for_model,
            has_flags=has_flags_derived,
        )

        try:
            pred_improvement = float(models["regression"].predict(X_pred)[0])
            pred_responder = float(models["classifier"].predict_proba(X_pred)[0][1])
            pred_dropout = float(models["dropout"].predict_proba(X_pred)[0][1])

            res_col1, res_col2, res_col3 = st.columns(3)
            res_col1.metric("Predicted Composite Improvement", f"{pred_improvement:.2f}")
            res_col2.metric("P(Responder)", f"{pred_responder:.1%}")
            res_col3.metric("P(Dropout)", f"{pred_dropout:.1%}")

            st.caption(
                "These are model predictions based on similar patients in the programme. "
                "Not a clinical guarantee."
            )
        except Exception as e:
            st.error(f"Prediction failed: {e}")
