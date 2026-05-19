# tests/test_dosage.py
"""Tests for src/qtx/dosage/ — prepare, train, evaluate, predict modules."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qtx.dosage.prepare import build_dosage_matrix


def _raw_supplement_df() -> pd.DataFrame:
    """Minimal synthetic supplement DataFrame matching cleaned_data.xlsx structure."""
    return pd.DataFrame({
        "S/N": [1, 2, 3, 4, 5, 6],
        "Age": [72.0, 68.0, 75.0, 55.0, 80.0, 65.0],
        "Gender": ["F", "M", "F", "M", "F", "M"],
        "Joined_with_pain": ["Y", "N", "Y", "Y", "N", "Y"],
        "frequency": ["once", "twice", "l + r 10", "once", "once", float("nan")],
        "knee_issue":           [1, 0, 0, 1, 0, 1],
        "leg_issue":            [0, 1, 0, 0, 1, 0],
        "back_spine_issue":     [0, 0, 1, 0, 0, 0],
        "balance_issue":        [0, 0, 0, 0, 1, 0],
        "upper_body_issue":     [0, 0, 0, 0, 0, 0],
        "foot_ankle_issue":     [0, 0, 0, 0, 0, 0],
        "neuro_issue":          [0, 0, 1, 0, 0, 0],
        "frailty_issue":        [0, 0, 0, 0, 1, 0],
        "metabolic_issue":      [0, 0, 0, 0, 0, 0],
        "injury_surgery_issue": [0, 1, 0, 0, 0, 0],
        "general_pain_issue":   [1, 0, 0, 1, 0, 0],
    })


def test_build_dosage_matrix_drops_nan_frequency():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    assert len(result) == 5  # row 6 (NaN frequency) is dropped


def test_build_dosage_matrix_label_values():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    assert set(result["frequency_label"].unique()).issubset({0, 1, 2})
    # once→0, twice→1, l+r10→2
    assert result[result["frequency_raw"] == "once"]["frequency_label"].iloc[0] == 0
    assert result[result["frequency_raw"] == "twice"]["frequency_label"].iloc[0] == 1
    assert result[result["frequency_raw"] == "l + r 10"]["frequency_label"].iloc[0] == 2


def test_build_dosage_matrix_encoded_columns():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    from qtx.utils.config import get_dosage_config
    cfg = get_dosage_config()
    for col in cfg["intake_features_encoded"]:
        assert col in result.columns, f"Missing encoded column: {col}"


def test_build_dosage_matrix_no_nans_in_features():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    from qtx.utils.config import get_dosage_config
    cfg = get_dosage_config()
    feature_cols = cfg["intake_features_encoded"]
    assert result[feature_cols].isna().sum().sum() == 0


def test_build_dosage_matrix_gender_encoding():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    # Gender "M" → gender_M = 1; "F" → gender_M = 0
    assert result[result["Gender_orig"] == "M"]["gender_M"].eq(1).all()
    assert result[result["Gender_orig"] == "F"]["gender_M"].eq(0).all()
