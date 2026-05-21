"""Prediction endpoints: outcomes and dosage."""
from __future__ import annotations

import numpy as np
import pandas as pd
from fastapi import APIRouter
from pydantic import BaseModel

import deps

router = APIRouter()

# ---------------------------------------------------------------------------
# MCID thresholds and scale factors for per-test estimation
# ---------------------------------------------------------------------------
_PER_TEST_CONFIG = [
    # (name, pre_field, mcid, scale_factor, lower_is_better)
    ("VAS (Pain)",    "pre_vas",           2.0,  -1.5,  True),
    ("TUG (s)",       "pre_tug_s",         2.5,  -2.0,  True),
    ("5xSST (s)",     "pre_5xsst_s",       2.3,  -1.5,  True),
    ("Normal GS",     "pre_normal_gs_ms",  0.1,   0.08, False),
    ("Fast GS",       "pre_fast_gs_ms",    0.1,   0.08, False),
    ("SPPB",          "baseline_sppb",     1.0,   0.5,  False),
]

# ---------------------------------------------------------------------------
# Cohort / usage / gender / indication one-hot prefix maps
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# GRP and RGN columns needed for n_groups, n_regions
# ---------------------------------------------------------------------------
_GRP_COLS = [
    "grp_joint_disease", "grp_spine_back", "grp_neurological", "grp_post_surgical",
    "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic",
    "grp_softtissue_injury", "grp_osteoporosis",
]
_RGN_COLS = [
    "rgn_spine", "rgn_knee", "rgn_ankle_foot", "rgn_hip", "rgn_lower_limb",
    "rgn_shoulder", "rgn_upper_limb", "rgn_trunk",
]
_HAS_COLS = [
    "has_oa", "has_diabetes", "has_stroke", "has_parkinsons", "has_sarcopenia",
    "has_post_surgery", "has_balance_issue", "has_chronic_pain", "has_hypertension",
    "has_frailty", "has_fall_risk", "has_neurological", "has_metabolic",
    "has_knee_issue", "has_spinal_issue",
]


def _build_feature_vector(profile: "PatientProfile", feature_names: list[str]) -> pd.DataFrame:
    """Build a single-row DataFrame matching model's expected feature_names."""
    row: dict[str, float] = {}

    # Direct numeric features
    row["age"] = float(profile.age)
    row["baseline_sppb"] = float(profile.baseline_sppb)
    row["pre_normal_gs_ms"] = float(profile.pre_normal_gs_ms)
    row["pre_tug_s"] = float(profile.pre_tug_s)
    row["pre_5xsst_s"] = float(profile.pre_5xsst_s)
    row["pre_vas"] = float(profile.pre_vas)
    row["pre_fast_gs_ms"] = float(profile.pre_fast_gs_ms)

    # Condition flags
    row["has_oa"] = float(profile.has_oa)
    row["has_diabetes"] = float(profile.has_diabetes)
    row["has_hypertension"] = float(profile.has_hypertension)
    row["has_frailty"] = float(profile.has_frailty)
    row["has_stroke"] = float(profile.has_stroke)
    row["has_parkinsons"] = float(profile.has_parkinsons)
    row["has_cancer"] = float(profile.has_cancer)
    row["has_copd"] = float(profile.has_copd)
    row["has_depression"] = float(profile.has_depression)
    row["has_osteoporosis"] = float(profile.has_osteoporosis)
    # Other flags default to 0
    row["has_sarcopenia"] = 0.0
    row["has_post_surgery"] = 0.0
    row["has_balance_issue"] = 0.0
    row["has_chronic_pain"] = 0.0
    row["has_fall_risk"] = 0.0
    row["has_neurological"] = 0.0
    # has_metabolic is a proxy for has_diabetes; the intake API has no separate
    # metabolic field, so we reuse the diabetes flag as the closest surrogate.
    row["has_metabolic"] = float(profile.has_diabetes)
    row["has_knee_issue"] = 0.0
    row["has_spinal_issue"] = 0.0

    # n_flags: sum only the 15 has_ columns the model was trained on (_HAS_COLS).
    # PatientProfile fields has_cancer, has_copd, has_depression, has_osteoporosis
    # have no direct model counterparts, so they must NOT contribute to n_flags.
    row["n_flags"] = sum(row.get(c, 0.0) for c in _HAS_COLS)

    # grp_ columns: all zero by default (derive from cohort if possible)
    for col in _GRP_COLS:
        row[col] = 0.0

    # Map cohort to grp columns
    _COHORT_TO_GRP = {
        "Pain & Musculoskeletal": "grp_joint_disease",
        "Neurological":           "grp_neurological",
        "Frailty/Sarcopenia":     "grp_frailty_sarcopenia",
        "Post-Surgical/Rehab":    "grp_post_surgical",
        "Wellness":               None,
        "Other-Mixed":            None,
        "Unclassified":           None,
    }
    grp_col = _COHORT_TO_GRP.get(profile.cohort)
    if grp_col and grp_col in row:
        row[grp_col] = 1.0

    row["n_groups"] = sum(row.get(c, 0.0) for c in _GRP_COLS)

    # rgn_ columns: all zero
    for col in _RGN_COLS:
        row[col] = 0.0
    row["n_regions"] = 0.0

    # Cohort one-hot
    for col in feature_names:
        if col.startswith("cohort_"):
            cohort_val = col.replace("cohort_", "")
            row[col] = 1.0 if profile.cohort == cohort_val else 0.0

    # Usage frequency one-hot
    for col in feature_names:
        if col.startswith("usage_frequency_"):
            usage_val = col.replace("usage_frequency_", "")
            row[col] = 1.0 if profile.usage_frequency == usage_val else 0.0

    # Gender one-hot
    for col in feature_names:
        if col.startswith("gender_"):
            gender_val = col.replace("gender_", "")
            row[col] = 1.0 if profile.gender == gender_val else 0.0

    # primary_indication: all zeros (Unclassified = all dummies 0)
    for col in feature_names:
        if col.startswith("primary_indication_"):
            row[col] = 0.0

    # Fill any remaining features with 0
    for feat in feature_names:
        if feat not in row:
            row[feat] = 0.0

    return pd.DataFrame([row])[feature_names]


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class PatientProfile(BaseModel):
    age: float
    gender: str
    cohort: str
    usage_frequency: str
    pre_vas: float
    pre_tug_s: float
    pre_5xsst_s: float
    pre_normal_gs_ms: float
    pre_fast_gs_ms: float
    baseline_sppb: float
    has_oa: int = 0
    has_diabetes: int = 0
    has_hypertension: int = 0
    has_frailty: int = 0
    has_osteoporosis: int = 0
    has_stroke: int = 0
    has_parkinsons: int = 0
    has_cancer: int = 0
    has_copd: int = 0
    has_depression: int = 0


class DosageRequest(BaseModel):
    age: float
    gender: str  # "M" or "F"
    joined_with_pain: str = "N"  # "Y" or "N"
    hl_knee_issue: int = 0
    hl_leg_issue: int = 0
    hl_back_spine_issue: int = 0
    hl_balance_issue: int = 0
    hl_upper_body_issue: int = 0
    hl_foot_ankle_issue: int = 0
    hl_neuro_issue: int = 0
    hl_frailty_issue: int = 0
    hl_metabolic_issue: int = 0
    hl_injury_surgery_issue: int = 0
    hl_general_pain_issue: int = 0


_DOSAGE_LABEL_MAP = {0: "Once / week", 1: "Twice / week", 2: "L+R 10 (both legs)"}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/predict/outcomes")
def predict_outcomes(profile: PatientProfile) -> dict:
    """Predict clinical outcomes for a patient profile."""
    clf = deps.models["classifier"]
    reg = deps.models["regression"]
    drop = deps.models["dropout"]

    feature_names_clf = list(clf.feature_names_in_)
    feature_names_drop = list(drop.feature_names_in_)

    X_clf = _build_feature_vector(profile, feature_names_clf)
    X_drop = _build_feature_vector(profile, feature_names_drop)

    p_responder = float(clf.predict_proba(X_clf)[0][1])
    p_dropout = float(drop.predict_proba(X_drop)[0][1])
    composite_improvement = float(reg.predict(X_clf)[0])

    # Per-test predictions
    per_test = []
    for name, pre_field, mcid, scale, lower_is_better in _PER_TEST_CONFIG:
        baseline = getattr(profile, pre_field, None)
        if baseline is None:
            continue
        predicted = float(baseline) + composite_improvement * scale
        if lower_is_better:
            meets_mcid = (float(baseline) - predicted) >= mcid
        else:
            meets_mcid = (predicted - float(baseline)) >= mcid
        per_test.append({
            "name": name,
            "baseline": float(baseline),
            "predicted": round(predicted, 2),
            "mcid": bool(meets_mcid),
        })

    # Feature contributions from classifier (access XGBoost inside pipeline)
    xgb_model = clf["model"] if hasattr(clf, "__getitem__") else clf
    importances = xgb_model.feature_importances_
    total = importances.sum()
    norm_importances = importances / total if total > 0 else importances

    top_indices = np.argsort(norm_importances)[::-1][:8]
    contributions = []
    for idx in top_indices:
        feat = feature_names_clf[idx]
        val = float(norm_importances[idx])
        # Direction: positive if patient's value >= dataset mean
        patient_val = float(X_clf[feat].iloc[0])
        try:
            feat_mean = float(deps.df[feat].mean()) if feat in deps.df.columns else 0.5
        except Exception:
            feat_mean = 0.5
        direction = "positive" if patient_val >= feat_mean else "negative"
        contributions.append({"feature": feat, "value": round(val, 4), "direction": direction})

    return {
        "composite_improvement": round(composite_improvement, 4),
        "p_responder": round(p_responder, 4),
        "p_dropout": round(p_dropout, 4),
        "per_test": per_test,
        "contributions": contributions,
    }


@router.post("/predict/dosage")
def predict_dosage(req: DosageRequest) -> dict:
    """Predict recommended treatment frequency (dosage)."""
    model = deps.models["dosage"]
    feature_names: list[str] = list(model.feature_names_in_)

    # Build base dict
    patient_base = {
        "age": float(req.age),
        "gender_M": 1 if req.gender == "M" else 0,
        "joined_with_pain_Y": 1 if req.joined_with_pain == "Y" else 0,
        "hl_knee_issue": float(req.hl_knee_issue),
        "hl_leg_issue": float(req.hl_leg_issue),
        "hl_back_spine_issue": float(req.hl_back_spine_issue),
        "hl_balance_issue": float(req.hl_balance_issue),
        "hl_upper_body_issue": float(req.hl_upper_body_issue),
        "hl_foot_ankle_issue": float(req.hl_foot_ankle_issue),
        "hl_neuro_issue": float(req.hl_neuro_issue),
        "hl_frailty_issue": float(req.hl_frailty_issue),
        "hl_metabolic_issue": float(req.hl_metabolic_issue),
        "hl_injury_surgery_issue": float(req.hl_injury_surgery_issue),
        "hl_general_pain_issue": float(req.hl_general_pain_issue),
    }

    # Derive engineered features
    age = float(req.age)
    age_above_65 = float(age >= 65)
    age_above_75 = float(age >= 75)
    knee = float(req.hl_knee_issue)
    leg = float(req.hl_leg_issue)
    foot = float(req.hl_foot_ankle_issue)
    bal = float(req.hl_balance_issue)
    back = float(req.hl_back_spine_issue)
    gp = float(req.hl_general_pain_issue)
    inj = float(req.hl_injury_surgery_issue)
    frail = float(req.hl_frailty_issue)
    neuro = float(req.hl_neuro_issue)
    pain_y = 1.0 if req.joined_with_pain == "Y" else 0.0

    patient_base.update({
        "age_above_65": age_above_65,
        "age_above_75": age_above_75,
        "bilateral_lower_limb_load": min(knee + leg + foot + bal, 4.0),
        "inflammatory_burden": knee + back + gp + inj,
        "elderly_frailty": age_above_65 * frail,
        "muscle_atrophy_risk": min(age_above_65 * (frail + neuro + leg), 3.0),
        "pain_with_knee": knee * pain_y,
    })

    # Build feature row
    row = {feat: float(patient_base.get(feat, 0)) for feat in feature_names}
    X = pd.DataFrame([row], columns=feature_names)

    proba = model.predict_proba(X)[0]
    classes = model.classes_  # [0, 1, 2]

    predicted_idx = int(np.argmax(proba))
    predicted_class = int(classes[predicted_idx])
    recommendation = _DOSAGE_LABEL_MAP.get(predicted_class, str(predicted_class))
    confidence = float(proba[predicted_idx])

    probabilities = {
        _DOSAGE_LABEL_MAP.get(int(c), str(c)): float(p)
        for c, p in zip(classes, proba)
    }

    return {
        "recommendation": recommendation,
        "confidence": round(confidence, 4),
        "probabilities": {k: round(v, 4) for k, v in probabilities.items()},
    }
