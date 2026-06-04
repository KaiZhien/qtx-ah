"""Unit tests for PredictionService."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


def _make_patient(**kwargs):
    p = MagicMock()
    p.id = uuid.uuid4()
    p.age = 70
    p.gender = "F"
    p.cohort = "Pain"
    p.primary_indication = None
    p.has_oa = True
    p.has_diabetes = False
    p.has_stroke = False
    p.has_parkinsons = False
    p.has_sarcopenia = False
    p.has_frailty = True
    p.has_balance_issue = False
    p.has_post_surgery = False
    p.has_chronic_pain = True
    p.has_neuropathy = False
    p.has_cancer = False
    p.has_cardiovascular = False
    p.has_hypertension = True
    p.has_osteoporosis = False
    p.has_spinal_issue = False
    p.has_knee_issue = True
    p.has_hip_issue = False
    p.has_shoulder_issue = False
    p.has_neurological = False
    p.has_fracture = False
    p.has_autoimmune = False
    p.has_metabolic = False
    p.has_wellness_only = False
    p.has_fall_risk = False
    p.grp_joint_disease = True
    p.grp_spine_back = False
    p.grp_neurological = False
    p.grp_post_surgical = False
    p.grp_frailty_sarcopenia = False
    p.grp_balance_falls = False
    p.grp_metabolic = False
    p.grp_cardiovascular = False
    p.grp_oncology = False
    p.grp_autoimmune = False
    p.grp_softtissue_injury = False
    p.grp_generalised_pain = False
    p.grp_osteoporosis = False
    p.grp_wellness = False
    p.rgn_knee = True
    p.rgn_hip = False
    p.rgn_spine = False
    p.rgn_shoulder = False
    p.rgn_ankle_foot = False
    p.rgn_lower_limb = False
    p.rgn_upper_limb = False
    p.rgn_bilateral = False
    p.rgn_trunk = False
    p.baseline_sppb = 8
    for k, v in kwargs.items():
        setattr(p, k, v)
    return p


def _make_session(**kwargs):
    s = MagicMock()
    s.id = uuid.uuid4()
    s.pre_tug_s = 12.5
    s.pre_vas = 5.0
    s.pre_5xsst_s = 15.0
    s.pre_normal_gs_ms = 0.75
    s.pre_fast_gs_ms = None
    s.baseline_sppb = 8
    s.post_sppb = None
    s.usage_frequency = "Once / week"
    s.joined_with_pain = True
    for k, v in kwargs.items():
        setattr(s, k, v)
    return s


def _make_models():
    features = ["age", "baseline_sppb", "pre_tug_s", "pre_5xsst_s", "pre_vas",
                "pre_normal_gs_ms", "pre_fast_gs_ms", "has_oa", "has_diabetes",
                "has_hypertension", "has_frailty", "has_stroke", "has_parkinsons",
                "has_sarcopenia", "has_post_surgery", "has_balance_issue",
                "has_chronic_pain", "has_fall_risk", "has_neurological",
                "has_metabolic", "has_knee_issue", "has_spinal_issue",
                "grp_joint_disease", "grp_spine_back", "grp_neurological",
                "grp_post_surgical", "grp_frailty_sarcopenia", "grp_balance_falls",
                "grp_metabolic", "grp_softtissue_injury", "grp_osteoporosis",
                "rgn_spine", "rgn_knee", "rgn_ankle_foot", "rgn_hip",
                "rgn_lower_limb", "rgn_shoulder", "rgn_upper_limb", "rgn_trunk",
                "n_flags", "n_groups", "n_regions",
                "cohort_Pain", "gender_F"]
    reg = MagicMock()
    reg.feature_names_in_ = np.array(features)
    reg.predict.return_value = np.array([0.42])
    clf = MagicMock()
    clf.feature_names_in_ = np.array(features)
    clf.predict_proba.return_value = np.array([[0.29, 0.71]])
    drop = MagicMock()
    drop.feature_names_in_ = np.array(features)
    drop.predict_proba.return_value = np.array([[0.88, 0.12]])
    dos = MagicMock()
    dos.feature_names_in_ = np.array(["age", "gender_M", "joined_with_pain_Y",
                                       "hl_knee_issue", "hl_leg_issue", "hl_back_spine_issue",
                                       "hl_balance_issue", "hl_upper_body_issue", "hl_foot_ankle_issue",
                                       "hl_neuro_issue", "hl_frailty_issue", "hl_metabolic_issue",
                                       "hl_injury_surgery_issue", "hl_general_pain_issue",
                                       "age_above_65", "age_above_75", "bilateral_lower_limb_load",
                                       "inflammatory_burden", "elderly_frailty", "muscle_atrophy_risk",
                                       "pain_with_knee"])
    dos.predict.return_value = np.array([1])
    return {"regression": reg, "classifier": clf, "dropout": drop, "dosage": dos}


# ── _build_feature_vector_from_orm ───────────────────────────────────────────

def test_feature_vector_shape():
    from services.prediction import _build_feature_vector_from_orm
    df = _build_feature_vector_from_orm(_make_patient(), _make_session(), ["age", "has_oa", "cohort_Pain", "gender_F", "n_flags"])
    assert df.shape == (1, 5)


def test_feature_vector_none_values_become_zero():
    from services.prediction import _build_feature_vector_from_orm
    session = _make_session(pre_tug_s=None, pre_fast_gs_ms=None)
    df = _build_feature_vector_from_orm(_make_patient(), session, ["pre_tug_s", "pre_fast_gs_ms"])
    assert df["pre_tug_s"].iloc[0] == 0.0
    assert df["pre_fast_gs_ms"].iloc[0] == 0.0


def test_feature_vector_cohort_onehot():
    from services.prediction import _build_feature_vector_from_orm
    patient = _make_patient(cohort="Pain")
    df = _build_feature_vector_from_orm(patient, _make_session(), ["cohort_Pain", "cohort_Neurological"])
    assert df["cohort_Pain"].iloc[0] == 1.0
    assert df["cohort_Neurological"].iloc[0] == 0.0


def test_feature_vector_gender_onehot():
    from services.prediction import _build_feature_vector_from_orm
    patient = _make_patient(gender="F")
    df = _build_feature_vector_from_orm(patient, _make_session(), ["gender_M", "gender_F"])
    assert df["gender_F"].iloc[0] == 1.0
    assert df["gender_M"].iloc[0] == 0.0


def test_feature_vector_n_flags_counts_true_has_cols():
    from services.prediction import _build_feature_vector_from_orm
    # has_oa=T, has_frailty=T, has_hypertension=T, has_knee_issue=T, has_chronic_pain=T → 5
    df = _build_feature_vector_from_orm(_make_patient(), _make_session(), ["n_flags"])
    assert df["n_flags"].iloc[0] == 5.0


# ── PredictionService.run ─────────────────────────────────────────────────────

def test_run_returns_dict_with_all_keys():
    from services.prediction import PredictionService
    result = PredictionService(MagicMock(), _make_models()).run(_make_patient(), _make_session())
    assert result is not None
    for key in ["predicted_composite_improvement", "responder_probability",
                "dropout_probability", "dosage_recommendation"]:
        assert key in result


def test_run_writes_db_row():
    from services.prediction import PredictionService
    db = MagicMock()
    PredictionService(db, _make_models()).run(_make_patient(), _make_session())
    db.add.assert_called_once()
    db.flush.assert_called_once()


def test_run_returns_none_on_catastrophic_failure():
    from services.prediction import PredictionService
    db = MagicMock()
    db.add.side_effect = Exception("DB exploded")
    assert PredictionService(db, _make_models()).run(_make_patient(), _make_session()) is None


def test_run_individual_model_failure_yields_none_field():
    from services.prediction import PredictionService
    db = MagicMock()
    models = _make_models()
    models["regression"].predict.side_effect = Exception("model broken")
    result = PredictionService(db, models).run(_make_patient(), _make_session())
    assert result is not None
    assert result["predicted_composite_improvement"] is None
    assert result["responder_probability"] is not None


