"""Dosage Frequency Recommender — intake form page.

Streamlit auto-discovers this file as 'Dosage Recommender' in the sidebar.
Run the full dashboard with: streamlit run dashboard/app.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

import joblib
import streamlit as st

from qtx.dosage.predict import predict_frequency
from qtx.dosage.prepare import derive_features_for_prediction
from qtx.utils.config import get_dosage_config, get_project_root

PROJECT_ROOT = get_project_root()
cfg = get_dosage_config()

LABEL_DISPLAY = {
    "once": "Once per week (one leg)",
    "twice": "Twice per week (one leg per session)",
    "lr10": "L+R 10 (20-min, 10 min each leg)",
}

CONFIDENCE_THRESHOLD = 0.50


@st.cache_resource
def load_dosage_model():
    model_path = PROJECT_ROOT / cfg["model_path"]
    if not model_path.exists():
        return None
    return joblib.load(model_path)


model = load_dosage_model()

st.title("Dosage Frequency Recommender")
st.caption("Predicts the recommended treatment frequency based on intake information.")

if model is None:
    st.error(
        "Model not found at `models/dosage_frequency.joblib`. "
        "Run `make dosage` to train it first."
    )
    st.stop()

st.markdown("### Patient Intake Information")

col1, col2 = st.columns(2)
with col1:
    age = st.number_input("Age", min_value=18, max_value=110, value=70, step=1)
    gender = st.selectbox("Gender", ["F", "M"])
with col2:
    joined_with_pain = st.selectbox("Joined with pain?", ["Y", "N"])

st.markdown("### Reported Conditions")

condition_cols = st.columns(3)
conditions = {
    "hl_knee_issue":           "Knee issue",
    "hl_leg_issue":            "Leg weakness",
    "hl_back_spine_issue":     "Back/spine issue",
    "hl_balance_issue":        "Balance issue",
    "hl_upper_body_issue":     "Upper body issue",
    "hl_foot_ankle_issue":     "Foot/ankle issue",
    "hl_neuro_issue":          "Neurological",
    "hl_frailty_issue":        "Frailty",
    "hl_metabolic_issue":      "Metabolic (e.g. diabetes)",
    "hl_injury_surgery_issue": "Injury/surgery",
    "hl_general_pain_issue":   "General pain",
}
condition_values: dict[str, int] = {}
for i, (key, label) in enumerate(conditions.items()):
    with condition_cols[i % 3]:
        condition_values[key] = int(st.checkbox(label))

st.markdown("---")

if st.button("Get Recommendation", type="primary"):
    patient_base = {
        "age": float(age),
        "gender_M": 1 if gender == "M" else 0,
        "joined_with_pain_Y": 1 if joined_with_pain == "Y" else 0,
        **{k: float(v) for k, v in condition_values.items()},
    }
    patient = derive_features_for_prediction(patient_base)

    result = predict_frequency(
        patient,
        model,
        cfg["intake_features_encoded"],
        cfg["label_names"],
    )

    rec = result["recommendation"]
    conf = result["confidence"]
    probs = result["probabilities"]

    st.markdown("### Recommendation")
    st.success(f"**{LABEL_DISPLAY.get(rec, rec)}**")

    conf_pct = int(conf * 100)
    st.metric("Model confidence", f"{conf_pct}%")

    if conf < CONFIDENCE_THRESHOLD:
        st.warning(
            f"Confidence is below {int(CONFIDENCE_THRESHOLD * 100)}%. "
            "The patient profile is atypical — clinician judgement should take precedence."
        )

    st.markdown("##### Probability breakdown")
    for name, prob in sorted(probs.items(), key=lambda x: -x[1]):
        display = LABEL_DISPLAY.get(name, name)
        st.progress(prob, text=f"{display}: {prob:.0%}")

    st.caption(
        "This recommendation is based on intake features only (age, gender, reported conditions). "
        "It does not account for external activity, medication, or social factors. "
        "Always use clinical judgement alongside this tool."
    )
