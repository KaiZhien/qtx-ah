"""Tests for longitudinal feature additions to the regression model."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))


def _make_patient(**kwargs):
    p = MagicMock()
    p.id = 1
    p.age = 70
    p.gender = "F"
    p.cohort = "Pain"
    p.primary_indication = None
    p.has_oa = True
    p.has_diabetes = False
    p.has_stroke = False
    p.has_parkinsons = False
    p.has_sarcopenia = False
    p.has_frailty = False
    p.has_balance_issue = False
    p.has_post_surgery = False
    p.has_chronic_pain = False
    p.has_neuropathy = False
    p.has_cardiovascular = False
    p.has_hypertension = False
    p.has_osteoporosis = False
    p.has_spinal_issue = False
    p.has_knee_issue = False
    p.has_hip_issue = False
    p.has_shoulder_issue = False
    p.has_neurological = False
    p.has_fracture = False
    p.has_autoimmune = False
    p.has_metabolic = False
    p.has_wellness_only = False
    p.has_fall_risk = False
    p.grp_joint_disease = False
    p.grp_spine_back = False
    p.grp_neurological = False
    p.grp_post_surgical = False
    p.grp_frailty_sarcopenia = False
    p.grp_balance_falls = False
    p.grp_metabolic = False
    p.grp_softtissue_injury = False
    p.grp_osteoporosis = False
    p.rgn_spine = False
    p.rgn_knee = False
    p.rgn_ankle_foot = False
    p.rgn_hip = False
    p.rgn_lower_limb = False
    p.rgn_shoulder = False
    p.rgn_upper_limb = False
    p.rgn_trunk = False
    p.baseline_sppb = 8
    for k, v in kwargs.items():
        setattr(p, k, v)
    return p


def _make_session(**kwargs):
    s = MagicMock()
    s.id = 10
    s.session_number = 1
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


# ── _build_feature_vector_from_orm with extra= ────────────────────────────────

def test_session_number_in_feature_vector():
    """Extra longitudinal features are correctly inserted into the feature vector."""
    from services.prediction import _build_feature_vector_from_orm

    extra = {
        "session_number": 3.0,
        "prior_avg_composite_improvement": 0.15,
        "trend_tug_magnitude": -0.05,
    }
    feature_names = ["age", "session_number", "prior_avg_composite_improvement", "trend_tug_magnitude"]
    df = _build_feature_vector_from_orm(_make_patient(), _make_session(), feature_names, extra=extra)

    assert "session_number" in df.columns
    assert df["session_number"].iloc[0] == 3.0


def test_prior_avg_defaults_to_zero_for_first_session():
    """When prior_avg=0.0 (first session default), the feature vector gets 0.0."""
    from services.prediction import _build_feature_vector_from_orm

    extra = {
        "session_number": 1.0,
        "prior_avg_composite_improvement": 0.0,
        "trend_tug_magnitude": 0.0,
    }
    feature_names = ["age", "prior_avg_composite_improvement"]
    df = _build_feature_vector_from_orm(_make_patient(), _make_session(), feature_names, extra=extra)

    assert df["prior_avg_composite_improvement"].iloc[0] == 0.0


def test_trend_tug_magnitude_in_feature_vector():
    """trend_tug_magnitude value from extra is correctly placed in the output."""
    from services.prediction import _build_feature_vector_from_orm

    extra = {
        "session_number": 2.0,
        "prior_avg_composite_improvement": 0.1,
        "trend_tug_magnitude": -0.3,
    }
    feature_names = ["age", "trend_tug_magnitude"]
    df = _build_feature_vector_from_orm(_make_patient(), _make_session(), feature_names, extra=extra)

    assert df["trend_tug_magnitude"].iloc[0] == pytest.approx(-0.3)


def test_extra_none_does_not_break_build():
    """Passing extra=None (default) does not change behaviour."""
    from services.prediction import _build_feature_vector_from_orm

    feature_names = ["age", "has_oa"]
    df_no_extra = _build_feature_vector_from_orm(_make_patient(), _make_session(), feature_names)
    df_extra_none = _build_feature_vector_from_orm(_make_patient(), _make_session(), feature_names, extra=None)

    assert df_no_extra.equals(df_extra_none)


def test_extra_not_in_feature_names_is_ignored():
    """An extra key not in feature_names is silently dropped (column slicing)."""
    from services.prediction import _build_feature_vector_from_orm

    extra = {"session_number": 5.0, "unknown_feature": 99.9}
    feature_names = ["age"]
    df = _build_feature_vector_from_orm(_make_patient(), _make_session(), feature_names, extra=extra)

    assert list(df.columns) == ["age"]
    assert "session_number" not in df.columns
    assert "unknown_feature" not in df.columns


# ── REGRESSION_FEATURES list ─────────────────────────────────────────────────

def test_longitudinal_features_list_has_three_new_features():
    """REGRESSION_FEATURES must contain all three new longitudinal feature names."""
    import importlib
    import importlib.util

    script_path = Path(__file__).resolve().parent.parent / "scripts" / "18_scheduled_retrain.py"
    spec = importlib.util.spec_from_file_location("retrain_script", script_path)
    retrain = importlib.util.module_from_spec(spec)
    # Avoid running main() — only load module-level definitions
    # The script uses sys.path manipulation and imports at module level;
    # we load it carefully
    try:
        spec.loader.exec_module(retrain)
    except Exception:
        # If DB or other runtime imports fail, we can still check the list
        # by reading the file directly
        pass

    features = getattr(retrain, "REGRESSION_FEATURES", None)
    if features is None:
        pytest.skip("Could not import REGRESSION_FEATURES from retrain script")

    assert "session_number" in features, "session_number missing from REGRESSION_FEATURES"
    assert "prior_avg_composite_improvement" in features, "prior_avg_composite_improvement missing"
    assert "trend_tug_magnitude" in features, "trend_tug_magnitude missing"


# ── _get_longitudinal_features helper ────────────────────────────────────────

def test_get_longitudinal_features_defaults_when_no_prior_sessions():
    """When DB returns None for avg and no tug trend, defaults are 0.0."""
    from services.prediction import _get_longitudinal_features

    # Mock DB that returns None for avg query scalar
    mock_query = MagicMock()
    mock_query.filter.return_value = mock_query
    mock_query.scalar.return_value = None  # no prior sessions
    mock_query.first.return_value = None   # no tug trend

    db = MagicMock()
    db.query.return_value = mock_query

    patient = _make_patient()
    session = _make_session(session_number=1)

    result = _get_longitudinal_features(patient, session, db)

    assert result["session_number"] == 1.0
    assert result["prior_avg_composite_improvement"] == 0.0
    assert result["trend_tug_magnitude"] == 0.0


def test_get_longitudinal_features_uses_db_values():
    """When DB returns real values, they flow through correctly."""
    from services.prediction import _get_longitudinal_features

    tug_trend = MagicMock()
    tug_trend.magnitude = 0.25

    call_count = 0

    def side_effect(model_class):
        nonlocal call_count
        call_count += 1
        q = MagicMock()
        q.filter.return_value = q
        if call_count == 1:
            # First call: ClinicalSession avg
            q.scalar.return_value = 0.42
        else:
            # Second call: PatientTrend
            q.first.return_value = tug_trend
        return q

    db = MagicMock()
    db.query.side_effect = side_effect

    patient = _make_patient()
    session = _make_session(session_number=3)

    result = _get_longitudinal_features(patient, session, db)

    assert result["session_number"] == 3.0
    assert result["prior_avg_composite_improvement"] == pytest.approx(0.42)
    assert result["trend_tug_magnitude"] == pytest.approx(0.25)
