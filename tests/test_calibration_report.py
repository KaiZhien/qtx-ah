"""Unit tests for scripts/21_calibration_report.py pure helpers."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "21_calibration_report.py"
spec = importlib.util.spec_from_file_location("calibration_report", _SCRIPT)
_mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(_mod)
except Exception as exc:
    raise ImportError(f"Could not load calibration_report script: {exc}") from exc

compute_cohort_metrics = _mod.compute_cohort_metrics
compute_monthly_trend = _mod.compute_monthly_trend


# ── compute_cohort_metrics ────────────────────────────────────────────────────

def test_compute_cohort_metrics_perfect_predictions():
    """Test perfect predictions → mae=0, rmse=0, mean_error=0."""
    df = pd.DataFrame({
        "cohort": ["A", "A", "A"],
        "predicted": [10.0, 20.0, 30.0],
        "actual": [10.0, 20.0, 30.0],
    })
    result = compute_cohort_metrics(df)
    assert len(result) == 1
    assert result.iloc[0]["cohort"] == "A"
    assert abs(result.iloc[0]["mae"] - 0.0) < 1e-9
    assert abs(result.iloc[0]["rmse"] - 0.0) < 1e-9
    assert abs(result.iloc[0]["bias"] - 0.0) < 1e-9


def test_compute_cohort_metrics_systematic_over_prediction():
    """Test systematic over-prediction → positive bias."""
    df = pd.DataFrame({
        "cohort": ["A", "A", "A"],
        "predicted": [15.0, 25.0, 35.0],
        "actual": [10.0, 20.0, 30.0],
    })
    result = compute_cohort_metrics(df)
    assert len(result) == 1
    assert result.iloc[0]["cohort"] == "A"
    # predicted - actual = [5, 5, 5], so bias = 5.0
    assert abs(result.iloc[0]["bias"] - 5.0) < 1e-9
    # mae = 5.0, rmse = 5.0
    assert abs(result.iloc[0]["mae"] - 5.0) < 1e-9
    assert abs(result.iloc[0]["rmse"] - 5.0) < 1e-9


def test_compute_cohort_metrics_mixed_cohorts():
    """Test mixed cohorts → correct per-cohort grouping."""
    df = pd.DataFrame({
        "cohort": ["A", "A", "B", "B"],
        "predicted": [10.0, 20.0, 100.0, 110.0],
        "actual": [10.0, 20.0, 90.0, 100.0],
    })
    result = compute_cohort_metrics(df)
    assert len(result) == 2
    # Cohort A: mae=0, rmse=0
    # Cohort B: (|100-90| + |110-100|)/2 = 10, rmse = 10
    # Sorted by mae descending, so B should be first
    assert result.iloc[0]["cohort"] == "B"
    assert abs(result.iloc[0]["mae"] - 10.0) < 1e-9
    assert result.iloc[1]["cohort"] == "A"
    assert abs(result.iloc[1]["mae"] - 0.0) < 1e-9


def test_compute_cohort_metrics_empty_dataframe():
    """Test empty DataFrame → returns empty DataFrame (no crash)."""
    df = pd.DataFrame()
    result = compute_cohort_metrics(df)
    assert isinstance(result, pd.DataFrame)
    assert result.empty


def test_compute_cohort_metrics_single_row():
    """Test single-row cohort → mae == rmse == abs(predicted - actual), n == 1."""
    df = pd.DataFrame({
        "cohort": ["X"],
        "predicted": [10.5],
        "actual": [8.0],
    })
    result = compute_cohort_metrics(df)
    assert len(result) == 1
    assert result.iloc[0]["cohort"] == "X"
    # error = |10.5 - 8.0| = 2.5
    # mae = 2.5, rmse = 2.5, bias = 10.5 - 8.0 = 2.5
    assert abs(result.iloc[0]["mae"] - 2.5) < 1e-9
    assert abs(result.iloc[0]["rmse"] - 2.5) < 1e-9
    assert result.iloc[0]["n"] == 1


# ── compute_monthly_trend ─────────────────────────────────────────────────────

def test_compute_monthly_trend_monthly_grouping():
    """Test monthly grouping → correct month extraction from predicted_at timestamps."""
    df = pd.DataFrame({
        "predicted": [10.0, 20.0, 30.0, 40.0],
        "actual": [10.0, 20.0, 30.0, 40.0],
        "predicted_at": ["2024-01-15", "2024-01-20", "2024-02-10", "2024-02-15"],
    })
    result = compute_monthly_trend(df)
    assert len(result) == 2
    # First month is 2024-01, second is 2024-02
    assert result.iloc[0]["month"] == "2024-01"
    assert abs(result.iloc[0]["mae"] - 0.0) < 1e-9
    assert abs(result.iloc[0]["rmse"] - 0.0) < 1e-9
    assert result.iloc[1]["month"] == "2024-02"
    assert abs(result.iloc[1]["mae"] - 0.0) < 1e-9
    assert abs(result.iloc[1]["rmse"] - 0.0) < 1e-9


def test_compute_monthly_trend_empty_dataframe():
    """Test empty DataFrame → returns empty DataFrame (no crash)."""
    df = pd.DataFrame()
    result = compute_monthly_trend(df)
    assert isinstance(result, pd.DataFrame)
    assert result.empty


def test_compute_monthly_trend_non_zero_errors():
    """Test monthly trend with non-zero prediction errors → mae > 0, rmse > 0."""
    df = pd.DataFrame({
        "predicted": [1.0, 0.5, 2.0, 1.0],
        "actual": [0.5, 0.5, 1.0, 1.0],
        "predicted_at": ["2024-01-10", "2024-01-20", "2024-02-10", "2024-02-15"],
    })
    result = compute_monthly_trend(df)
    assert len(result) == 2
    # 2024-01: predicted=[1.0, 0.5], actual=[0.5, 0.5]
    #   errors = [|1.0-0.5|, |0.5-0.5|] = [0.5, 0.0]
    #   mae = 0.25, rmse = sqrt(0.25/2) ≈ 0.3536
    assert result.iloc[0]["month"] == "2024-01"
    assert result.iloc[0]["mae"] > 0
    assert result.iloc[0]["rmse"] > 0
    # 2024-02: predicted=[2.0, 1.0], actual=[1.0, 1.0]
    #   errors = [|2.0-1.0|, |1.0-1.0|] = [1.0, 0.0]
    #   mae = 0.5, rmse = sqrt(1.0/2) ≈ 0.7071
    assert result.iloc[1]["month"] == "2024-02"
    assert result.iloc[1]["mae"] > 0
    assert result.iloc[1]["rmse"] > 0
