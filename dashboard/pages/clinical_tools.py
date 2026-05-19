"""Clinical Tools page — Patient Lookup, Intake Estimator, Dosage Recommender."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # dashboard/ for _utils

import pandas as pd
import streamlit as st

from _utils import load_data, load_models
from qtx.dosage.predict import predict_frequency
from qtx.dosage.prepare import derive_features_for_prediction
from qtx.phenotype.classify import classify
from qtx.utils.config import get_dosage_config

cfg = get_dosage_config()

LABEL_DISPLAY = {
    "once": "Once per week (one leg)",
    "twice": "Twice per week (one leg per session)",
    "lr10": "L+R 10 (20-min, 10 min each leg)",
}
CONFIDENCE_THRESHOLD = 0.50

st.set_page_config(page_title="Clinical Tools", layout="wide", initial_sidebar_state="expanded")

st.sidebar.title("Navigation")
st.sidebar.page_link("app.py", label="Overview")
st.sidebar.page_link("pages/cohort_analysis.py", label="Cohort Analysis")
st.sidebar.page_link("pages/clinical_tools.py", label="Clinical Tools")

df_full = load_data()
models = load_models()

st.title("Clinical Tools")

# ===========================================================================
# Section 1: Patient Lookup
# ===========================================================================

st.subheader("Patient Lookup")

sn_query = st.text_input("Patient S/N", placeholder="e.g. 1.0")

if sn_query.strip():
    match = df_full[df_full["sn"].astype(str) == sn_query.strip()]

    if match.empty:
        st.warning(f"Patient not found: {sn_query.strip()!r}")
    else:
        row = match.iloc[0]
        st.markdown(f"**Record for S/N: {sn_query.strip()}**")
        c1, c2, c3, c4 = st.columns(4)

        with c1:
            st.markdown("**Demographics**")
            st.write(f"Age: {row.get('age', 'N/A')}")
            st.write(f"Gender: {row.get('gender', 'N/A')}")
            st.write(f"Cohort: {row.get('cohort', 'N/A')}")
            st.write(f"Usage Frequency: {row.get('usage_frequency', 'N/A')}")

        with c2:
            st.markdown("**Baseline Scores**")
            st.write(f"VAS Pain: {row.get('pre_vas', 'N/A')}")
            st.write(f"TUG (s): {row.get('pre_tug_s', 'N/A')}")
            st.write(f"5xSST (s): {row.get('pre_5xsst_s', 'N/A')}")
            st.write(f"Normal Gait (m/s): {row.get('pre_normal_gs_ms', 'N/A')}")
            st.write(f"SPPB: {row.get('baseline_sppb', 'N/A')}")

        with c3:
            st.markdown("**Conditions**")
            has_cols = [c for c in df_full.columns if c.startswith("has_") and c != "has_followup"]
            active = [c.replace("has_", "").replace("_", " ").title() for c in has_cols if row.get(c, 0) == 1]
            if active:
                for flag in active:
                    st.write(f"- {flag}")
            else:
                st.write("None recorded")

        with c4:
            st.markdown("**Outcomes**")
            st.write(f"Post VAS: {row.get('post_vas', 'N/A')}")
            st.write(f"Post TUG (s): {row.get('post_tug_s', 'N/A')}")
            ci = row.get("composite_improvement", None)
            st.write(f"Composite Improvement: {f'{ci:.2f}' if ci is not None and not (isinstance(ci, float) and pd.isna(ci)) else 'N/A'}")
            resp = row.get("overall_responder", None)
            st.write(f"Overall Responder: {'Yes' if resp == 1 else 'No' if resp == 0 else 'N/A'}")
            drop = row.get("is_dropout", None)
            st.write(f"Dropout: {'Yes' if drop == 1 else 'No' if drop == 0 else 'N/A'}")

st.divider()

# ===========================================================================
# Section 2: Intake Estimator
# ===========================================================================

st.subheader("Intake Estimator")
st.caption("Enter patient details to get model-predicted outcomes.")

COHORT_OPTIONS = [
    "Pain & Musculoskeletal", "Neurological", "Frailty/Sarcopenia",
    "Post-Surgical/Rehab", "Wellness", "Other-Mixed", "Unclassified",
]
USAGE_OPTIONS = [
    "L+R 10 (20-min session, 10 min each leg)",
    "Once (1x/week, one leg)",
    "Twice (2x/week, one leg per session)",
]

if "regression" in models:
    FEATURE_NAMES: list[str] = list(models["regression"].feature_names_in_)
    COHORT_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("cohort_")]
    USAGE_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("usage_frequency_")]
    GENDER_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("gender_")]

    def _build_input_row(
        age: float, baseline_sppb: int, pre_tug: float, pre_5xsst: float,
        pre_normal_gs: float, usage: str, cohort: str, gender: str,
        has_flags: dict[str, int],
    ) -> pd.DataFrame:
        row: dict[str, float] = {
            "age": age,
            "baseline_sppb": float(baseline_sppb),
            "pre_normal_gs_ms": pre_normal_gs,
            "pre_tug_s": pre_tug,
            "pre_5xsst_s": pre_5xsst,
        }
        for feat in FEATURE_NAMES:
            if feat.startswith("has_"):
                row[feat] = float(has_flags.get(feat, 0))
        for col in COHORT_DUMMIES:
            row[col] = 1.0 if cohort == col.replace("cohort_", "") else 0.0
        for col in USAGE_DUMMIES:
            row[col] = 1.0 if usage == col.replace("usage_frequency_", "") else 0.0
        for col in GENDER_DUMMIES:
            row[col] = 1.0 if gender == col.replace("gender_", "") else 0.0
        for feat in FEATURE_NAMES:
            if feat not in row:
                row[feat] = 0.0
        return pd.DataFrame([row])[FEATURE_NAMES]

    ie_c1, ie_c2 = st.columns(2)
    with ie_c1:
        inp_age = st.number_input("Age", min_value=10, max_value=110, value=65, step=1, key="ie_age")
        inp_sppb = st.slider("Baseline SPPB", min_value=0, max_value=12, value=6, key="ie_sppb")
        inp_tug = st.number_input("Baseline TUG (seconds)", min_value=0.0, value=15.0, step=0.5, key="ie_tug")
        inp_5xsst = st.number_input("Baseline 5xSST (seconds)", min_value=0.0, value=20.0, step=0.5, key="ie_5xsst")
        inp_gs = st.number_input("Baseline Normal Gait Speed (m/s)", min_value=0.0, value=0.8, step=0.05, format="%.2f", key="ie_gs")
    with ie_c2:
        inp_usage = st.selectbox("Usage Frequency", USAGE_OPTIONS, key="ie_usage")
        inp_cohort = st.selectbox("Cohort", COHORT_OPTIONS, key="ie_cohort")
        inp_gender = st.selectbox("Gender", ["M", "F", "Unknown"], key="ie_gender")
        inp_tags = st.text_input(
            "Comorbidity Tags (free text)",
            placeholder="e.g. knee osteoarthritis, diabetes",
            key="ie_tags",
        )

    if st.button("Predict", type="primary", key="ie_predict"):
        try:
            classified = classify(pd.DataFrame([{"tags": inp_tags, "pain_location": ""}]))
            has_flags_derived = {col: int(classified[col].iloc[0]) for col in classified.columns if col.startswith("has_")}
        except Exception:
            has_flags_derived = {}

        X_pred = _build_input_row(
            age=float(inp_age), baseline_sppb=inp_sppb, pre_tug=inp_tug,
            pre_5xsst=inp_5xsst, pre_normal_gs=inp_gs, usage=inp_usage,
            cohort=inp_cohort,
            gender=inp_gender if inp_gender != "Unknown" else "__missing__",
            has_flags=has_flags_derived,
        )
        try:
            pred_improvement = float(models["regression"].predict(X_pred)[0])
            pred_responder = float(models["classifier"].predict_proba(X_pred)[0][1])
            pred_dropout = float(models["dropout"].predict_proba(X_pred)[0][1])
            r1, r2, r3 = st.columns(3)
            r1.metric("Predicted Composite Improvement", f"{pred_improvement:.2f}")
            r2.metric("P(Responder)", f"{pred_responder:.1%}")
            r3.metric("P(Dropout)", f"{pred_dropout:.1%}")
            st.caption("Model predictions based on similar patients. Not a clinical guarantee.")
        except Exception as e:
            st.error(f"Prediction failed: {e}")
else:
    st.info("Clinical outcome models not found. Run `make model` first.")

st.divider()

# ===========================================================================
# Section 3: Dosage Recommender
# ===========================================================================

st.subheader("Dosage Recommender")
st.caption("Predicts the recommended treatment frequency based on intake information.")

dosage_model = models.get("dosage")

if dosage_model is None:
    st.error("Dosage model not found at `models/dosage_frequency.joblib`. Run `make dosage` to train it first.")
else:
    dr_c1, dr_c2 = st.columns(2)
    with dr_c1:
        dr_age = st.number_input("Age", min_value=18, max_value=110, value=70, step=1, key="dr_age")
        dr_gender = st.selectbox("Gender", ["F", "M"], key="dr_gender")
    with dr_c2:
        dr_pain = st.selectbox("Joined with pain?", ["Y", "N"], key="dr_pain")

    st.markdown("**Reported Conditions**")
    cond_cols = st.columns(3)
    conditions = {
        "hl_knee_issue": "Knee issue",
        "hl_leg_issue": "Leg weakness",
        "hl_back_spine_issue": "Back/spine issue",
        "hl_balance_issue": "Balance issue",
        "hl_upper_body_issue": "Upper body issue",
        "hl_foot_ankle_issue": "Foot/ankle issue",
        "hl_neuro_issue": "Neurological",
        "hl_frailty_issue": "Frailty",
        "hl_metabolic_issue": "Metabolic (e.g. diabetes)",
        "hl_injury_surgery_issue": "Injury/surgery",
        "hl_general_pain_issue": "General pain",
    }
    condition_values: dict[str, int] = {}
    for i, (key, label) in enumerate(conditions.items()):
        with cond_cols[i % 3]:
            condition_values[key] = int(st.checkbox(label, key=f"dr_{key}"))

    st.markdown("---")

    if st.button("Get Recommendation", type="primary", key="dr_predict"):
        patient_base = {
            "age": float(dr_age),
            "gender_M": 1 if dr_gender == "M" else 0,
            "joined_with_pain_Y": 1 if dr_pain == "Y" else 0,
            **{k: float(v) for k, v in condition_values.items()},
        }
        patient = derive_features_for_prediction(patient_base)
        result = predict_frequency(
            patient, dosage_model, cfg["intake_features_encoded"], cfg["label_names"]
        )
        rec, conf, probs = result["recommendation"], result["confidence"], result["probabilities"]

        st.markdown("**Recommendation**")
        st.success(f"**{LABEL_DISPLAY.get(rec, rec)}**")
        st.metric("Model confidence", f"{int(conf * 100)}%")

        if conf < CONFIDENCE_THRESHOLD:
            st.warning(
                f"Confidence is below {int(CONFIDENCE_THRESHOLD * 100)}%. "
                "The patient profile is atypical — clinician judgement should take precedence."
            )

        st.markdown("**Probability breakdown**")
        for name, prob in sorted(probs.items(), key=lambda x: -x[1]):
            st.progress(prob, text=f"{LABEL_DISPLAY.get(name, name)}: {prob:.0%}")

        st.caption(
            "This recommendation is based on intake features only. "
            "Always use clinical judgement alongside this tool."
        )
