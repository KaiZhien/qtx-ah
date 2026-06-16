"""Tests that build_feature_matrix() always produces the three longitudinal columns."""
import pandas as pd
import numpy as np
import pytest
from unittest.mock import patch, MagicMock


@pytest.fixture(autouse=True)
def _no_io(monkeypatch):
    with patch("qtx.features.build.save_parquet"):
        yield


def _minimal_outcomes_df():
    return pd.DataFrame({
        "sn": ["001", "002"],
        "name": ["Alice", "Bob"],
        "cohort": ["Orthopaedic", "Neurological"],
        "primary_indication": ["OA", "Stroke"],
        "age": [72, 65],
        "age_band": ["70-79", "60-69"],
        "gender": ["F", "M"],
        "record_type": ["Active", "Active"],
        "usage_frequency": ["1x/week", "2x/week"],
        "has_oa": [1, 0],
        "has_diabetes": [0, 1],
        "has_followup": ["Y", "Y"],
        "is_dropout": [0, 0],
        "pre_vas": [6.0, 4.0],
        "post_vas": [3.0, 2.0],
        "pre_tug_s": [14.2, 11.0],
        "post_tug_s": [11.5, 9.0],
        "pre_5xsst_s": [20.0, 18.0],
        "post_5xsst_s": [16.0, 15.0],
        "pre_normal_gs_ms": [0.7, 0.9],
        "post_normal_gs_ms": [0.85, 1.0],
        "pre_fast_gs_ms": [1.0, 1.2],
        "post_fast_gs_ms": [1.2, 1.4],
        "baseline_sppb": [7, 9],
        "post_sppb": [9, 11],
        "composite_improvement": [0.5, 0.8],
        "overall_responder": [1, 1],
        "breadth_of_response": [0.8, 1.0],
        "n_flags": [1, 1],
        "n_groups": [1, 1],
        "n_regions": [1, 1],
    })


def test_longitudinal_columns_present_after_build():
    """build_feature_matrix() must always produce all three longitudinal columns."""
    from qtx.features.build import build_feature_matrix
    df = _minimal_outcomes_df()
    result = build_feature_matrix(df)
    assert "session_number" in result.columns, "session_number missing from feature matrix"
    assert "prior_avg_composite_improvement" in result.columns
    assert "trend_tug_magnitude" in result.columns


def test_longitudinal_columns_default_values():
    """For first-time patients (Parquet source), longitudinal features default to 0/1."""
    from qtx.features.build import build_feature_matrix
    df = _minimal_outcomes_df()
    result = build_feature_matrix(df)
    assert (result["session_number"] == 1.0).all(), "Default session_number should be 1"
    assert (result["prior_avg_composite_improvement"] == 0.0).all()
    assert (result["trend_tug_magnitude"] == 0.0).all()


def test_longitudinal_columns_dtype_float():
    """Longitudinal columns must be float64 for XGBoost compatibility."""
    from qtx.features.build import build_feature_matrix
    df = _minimal_outcomes_df()
    result = build_feature_matrix(df)
    for col in ["session_number", "prior_avg_composite_improvement", "trend_tug_magnitude"]:
        assert result[col].dtype in [float, "float64"], f"{col} must be float64"


def test_longitudinal_columns_fillna_when_present():
    """Exercises the else-branch: columns already present get NaN filled with defaults."""
    from qtx.features.build import build_feature_matrix
    df = _minimal_outcomes_df()
    # Add the three longitudinal columns with at least one NaN each
    df["session_number"] = [3.0, float("nan")]
    df["prior_avg_composite_improvement"] = [float("nan"), 0.3]
    df["trend_tug_magnitude"] = [0.1, float("nan")]
    result = build_feature_matrix(df)
    # NaN in session_number → filled with default 1.0
    assert result["session_number"].isna().sum() == 0, "session_number still has NaN"
    assert result.loc[result["session_number"] != 3.0, "session_number"].eq(1.0).all(), \
        "NaN in session_number should be filled with 1.0"
    # NaN in prior_avg_composite_improvement → filled with default 0.0
    assert result["prior_avg_composite_improvement"].isna().sum() == 0
    assert result.loc[result["prior_avg_composite_improvement"] != 0.3,
                      "prior_avg_composite_improvement"].eq(0.0).all(), \
        "NaN in prior_avg_composite_improvement should be filled with 0.0"
    # NaN in trend_tug_magnitude → filled with default 0.0
    assert result["trend_tug_magnitude"].isna().sum() == 0
    assert result.loc[result["trend_tug_magnitude"] != 0.1,
                      "trend_tug_magnitude"].eq(0.0).all(), \
        "NaN in trend_tug_magnitude should be filled with 0.0"
    # All three must be float64
    for col in ["session_number", "prior_avg_composite_improvement", "trend_tug_magnitude"]:
        assert result[col].dtype in [float, "float64"], f"{col} must be float64"
