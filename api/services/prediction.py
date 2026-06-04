# api/services/prediction.py
"""PredictionService — runs all ML models for a patient+session and persists results."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

import pandas as pd
from sqlalchemy.orm import Session as DBSession

logger = logging.getLogger(__name__)

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
_DOSAGE_LABEL_MAP = {0: "Once / week", 1: "Twice / week", 2: "L+R 10 (both legs)"}


def _f(val, default: float = 0.0) -> float:
    """Safe float conversion — returns default for None."""
    return float(val) if val is not None else default


def _get_longitudinal_features(patient, session, db) -> dict[str, float]:
    """Compute longitudinal features that require DB access."""
    from models.clinical import Session as ClinicalSession, PatientTrend
    from sqlalchemy import func

    # prior_avg_composite_improvement
    prior_avg = db.query(func.avg(ClinicalSession.composite_improvement)).filter(
        ClinicalSession.patient_id == patient.id,
        ClinicalSession.session_number < session.session_number,
        ClinicalSession.composite_improvement.isnot(None),
    ).scalar()

    # trend_tug_magnitude
    tug_trend = db.query(PatientTrend).filter(
        PatientTrend.patient_id == patient.id,
        PatientTrend.metric.ilike('%tug%'),
    ).first()

    return {
        "session_number": float(session.session_number or 1),
        "prior_avg_composite_improvement": float(prior_avg) if prior_avg is not None else 0.0,
        "trend_tug_magnitude": float(tug_trend.magnitude) if (tug_trend and tug_trend.magnitude is not None) else 0.0,
    }


def _build_feature_vector_from_orm(patient, session, feature_names: list[str], extra: dict | None = None) -> pd.DataFrame:
    """Build a single-row DataFrame from ORM Patient + Session objects."""
    row: dict[str, float] = {}

    row["age"] = _f(patient.age)
    sppb = session.baseline_sppb if session.baseline_sppb is not None else patient.baseline_sppb
    row["baseline_sppb"] = _f(sppb)
    row["pre_normal_gs_ms"] = _f(session.pre_normal_gs_ms)
    row["pre_tug_s"] = _f(session.pre_tug_s)
    row["pre_5xsst_s"] = _f(session.pre_5xsst_s)
    row["pre_vas"] = _f(session.pre_vas)
    row["pre_fast_gs_ms"] = _f(session.pre_fast_gs_ms)

    for col in _HAS_COLS:
        row[col] = _f(getattr(patient, col, False))
    for col in _GRP_COLS:
        row[col] = _f(getattr(patient, col, False))
    for col in _RGN_COLS:
        row[col] = _f(getattr(patient, col, False))

    row["n_flags"] = sum(row.get(c, 0.0) for c in _HAS_COLS)
    row["n_groups"] = sum(row.get(c, 0.0) for c in _GRP_COLS)
    row["n_regions"] = sum(row.get(c, 0.0) for c in _RGN_COLS)

    cohort = patient.cohort or ""
    usage = session.usage_frequency or ""
    gender = (patient.gender or "").upper()

    for col in feature_names:
        if col.startswith("cohort_"):
            row[col] = 1.0 if cohort == col[len("cohort_"):] else 0.0
        elif col.startswith("usage_frequency_"):
            row[col] = 1.0 if usage == col[len("usage_frequency_"):] else 0.0
        elif col.startswith("gender_"):
            row[col] = 1.0 if gender == col[len("gender_"):].upper() else 0.0
        elif col.startswith("primary_indication_"):
            row[col] = 0.0

    if extra:
        row.update(extra)

    for feat in feature_names:
        if feat not in row:
            row[feat] = 0.0

    return pd.DataFrame([row])[feature_names]


def _build_dosage_vector_from_orm(patient, session, feature_names: list[str]) -> pd.DataFrame:
    """Build dosage model feature vector from ORM objects using proxy field mappings."""
    age = _f(patient.age)
    age65 = float(age >= 65)
    age75 = float(age >= 75)
    joined_pain = float(bool(session.joined_with_pain))
    knee = float(bool(getattr(patient, "has_knee_issue", False)) or bool(getattr(patient, "rgn_knee", False)))
    leg = float(bool(getattr(patient, "rgn_lower_limb", False)))
    back = float(bool(getattr(patient, "has_spinal_issue", False)) or bool(getattr(patient, "rgn_spine", False)))
    balance = float(bool(getattr(patient, "has_balance_issue", False)))
    upper = float(bool(getattr(patient, "rgn_upper_limb", False)) or bool(getattr(patient, "has_shoulder_issue", False)))
    foot = float(bool(getattr(patient, "rgn_ankle_foot", False)))
    neuro = float(bool(getattr(patient, "has_neurological", False)))
    frail = float(bool(getattr(patient, "has_frailty", False)))
    metabolic = float(bool(getattr(patient, "has_metabolic", False)))
    surgery = float(bool(getattr(patient, "has_post_surgery", False)))
    pain = float(bool(getattr(patient, "has_chronic_pain", False)))
    gender_m = 1.0 if (patient.gender or "").upper() == "M" else 0.0

    base = {
        "age": age, "gender_M": gender_m,
        "joined_with_pain_Y": joined_pain,
        "hl_knee_issue": knee, "hl_leg_issue": leg,
        "hl_back_spine_issue": back, "hl_balance_issue": balance,
        "hl_upper_body_issue": upper, "hl_foot_ankle_issue": foot,
        "hl_neuro_issue": neuro, "hl_frailty_issue": frail,
        "hl_metabolic_issue": metabolic, "hl_injury_surgery_issue": surgery,
        "hl_general_pain_issue": pain,
        "age_above_65": age65, "age_above_75": age75,
        "bilateral_lower_limb_load": min(knee + leg + foot + balance, 4.0),
        "inflammatory_burden": knee + back + pain + surgery,
        "elderly_frailty": age65 * frail,
        "muscle_atrophy_risk": min(age65 * (frail + neuro + leg), 3.0),
        "pain_with_knee": knee * joined_pain,
    }
    row = {feat: float(base.get(feat, 0.0)) for feat in feature_names}
    return pd.DataFrame([row], columns=feature_names)


class PredictionService:
    def __init__(self, db: DBSession, models: dict) -> None:
        self._db = db
        self._models = models

    def run(self, patient, session) -> dict | None:
        """Run all model inferences for a patient+session.

        Writes a SessionPrediction row (caller commits). Returns prediction dict or None.
        """
        try:
            return self._run(patient, session)
        except Exception as exc:
            logger.warning("PredictionService.run failed: %s", exc)
            return None

    def _run(self, patient, session) -> dict:
        from models.clinical import SessionPrediction

        predictions: dict = {}
        model_versions: dict = {}

        longitudinal = _get_longitudinal_features(patient, session, self._db)

        try:
            reg = self._models["regression"]
            X = _build_feature_vector_from_orm(patient, session, list(reg.feature_names_in_), extra=longitudinal)
            predictions["predicted_composite_improvement"] = float(reg.predict(X)[0])
            model_versions["regression"] = "regression_xgb.joblib"
        except Exception as exc:
            logger.warning("Regression inference failed: %s", exc)
            predictions["predicted_composite_improvement"] = None

        try:
            clf = self._models["classifier"]
            X = _build_feature_vector_from_orm(patient, session, list(clf.feature_names_in_), extra=longitudinal)
            predictions["responder_probability"] = float(clf.predict_proba(X)[0][1])
            model_versions["classifier"] = "classifier_xgb.joblib"
        except Exception as exc:
            logger.warning("Classifier inference failed: %s", exc)
            predictions["responder_probability"] = None

        try:
            drop = self._models["dropout"]
            X = _build_feature_vector_from_orm(patient, session, list(drop.feature_names_in_), extra=longitudinal)
            predictions["dropout_probability"] = float(drop.predict_proba(X)[0][1])
            model_versions["dropout"] = "dropout_xgb.joblib"
        except Exception as exc:
            logger.warning("Dropout inference failed: %s", exc)
            predictions["dropout_probability"] = None

        try:
            dos = self._models["dosage"]
            X = _build_dosage_vector_from_orm(patient, session, list(dos.feature_names_in_))
            dos_class = int(dos.predict(X)[0])
            predictions["dosage_recommendation"] = _DOSAGE_LABEL_MAP.get(dos_class, str(dos_class))
            model_versions["dosage"] = "dosage_frequency.joblib"
        except Exception as exc:
            logger.warning("Dosage inference failed: %s", exc)
            predictions["dosage_recommendation"] = None

        row = SessionPrediction(
            id=uuid.uuid4(),
            session_id=session.id,
            patient_id=patient.id,
            predicted_composite_improvement=predictions.get("predicted_composite_improvement"),
            responder_probability=predictions.get("responder_probability"),
            dropout_probability=predictions.get("dropout_probability"),
            dosage_recommendation=predictions.get("dosage_recommendation"),
            model_versions=model_versions,
            predicted_at=datetime.now(timezone.utc),
        )
        self._db.add(row)
        self._db.flush()
        return predictions
