"""Unit tests for scripts/17_raise_model_evaluation.py pure helpers."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pandas as pd
import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "17_raise_model_evaluation.py"
spec = importlib.util.spec_from_file_location("raise_eval", _SCRIPT)
_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_mod)

_compute_flag_counts = _mod._compute_flag_counts
auc_gate = _mod.auc_gate
shap_gate = _mod.shap_gate
should_save_models = _mod.should_save_models


# ── _compute_flag_counts ──────────────────────────────────────────────────────

def test_flag_counts_all_false():
    row = {c: False for c in _mod.HAS_COLS + _mod.GRP_COLS + _mod.RGN_COLS}
    counts = _compute_flag_counts(row)
    assert counts == {"n_flags": 0, "n_groups": 0, "n_regions": 0}


def test_flag_counts_some_true():
    row = {"has_oa": True, "has_frailty": True, "grp_balance_falls": True, "rgn_knee": True}
    counts = _compute_flag_counts(row)
    assert counts["n_flags"] == 2
    assert counts["n_groups"] == 1
    assert counts["n_regions"] == 1


def test_flag_counts_missing_keys_treated_as_false():
    counts = _compute_flag_counts({})
    assert counts == {"n_flags": 0, "n_groups": 0, "n_regions": 0}


def test_flag_counts_truthy_int():
    row = {"has_diabetes": 1, "has_stroke": 0}
    counts = _compute_flag_counts(row)
    assert counts["n_flags"] == 1


# ── auc_gate ─────────────────────────────────────────────────────────────────

def test_auc_gate_passes_below_threshold():
    assert auc_gate(0.65) is True


def test_auc_gate_fails_at_threshold():
    assert auc_gate(0.70) is False


def test_auc_gate_fails_above_threshold():
    assert auc_gate(0.85) is False


def test_auc_gate_custom_threshold():
    assert auc_gate(0.60, threshold=0.55) is False
    assert auc_gate(0.50, threshold=0.55) is True


# ── shap_gate ─────────────────────────────────────────────────────────────────

def _make_shap_df(rows: list[tuple[str, float]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["feature", "mean_abs_shap"])


def test_shap_gate_passes_below_threshold():
    """Test that shap_gate correctly passes when confound mass is below 15% threshold."""
    shap_df = _make_shap_df([
        ("feature_a", 0.60), ("feature_b", 0.30), ("confound_col_variant1", 0.05), ("confound_col_variant2", 0.05)
    ])
    passes, pct = shap_gate(shap_df, ["confound_col"])
    assert passes is True
    assert abs(pct - 0.10) < 1e-9


def test_shap_gate_fails_above_threshold():
    """Test that shap_gate correctly fails when confound mass exceeds 15% threshold."""
    shap_df = _make_shap_df([
        ("feature_a", 0.20), ("confound_col_variant1", 0.50), ("confound_col_variant2", 0.30)
    ])
    passes, pct = shap_gate(shap_df, ["confound_col"])
    assert passes is False
    assert pct > 0.15


def test_shap_gate_exact_feature_name_match():
    """Test that shap_gate matches exact feature names (prefix not required)."""
    shap_df = _make_shap_df([("confound_col", 0.10), ("feature_a", 0.90)])
    passes, pct = shap_gate(shap_df, ["confound_col"])
    assert abs(pct - 0.10) < 1e-9


def test_shap_gate_zero_total_returns_pass():
    """Test that shap_gate passes when all SHAP values are zero."""
    shap_df = _make_shap_df([("confound_col", 0.0), ("feature_a", 0.0)])
    passes, pct = shap_gate(shap_df, ["confound_col"])
    assert passes is True
    assert pct == 0.0


def test_shap_gate_primary_indication_confound():
    """Verify shap_gate correctly identifies primary_indication_* features as confounds."""
    shap_df = _make_shap_df([
        ("age", 0.70),
        ("baseline_sppb", 0.20),
        ("primary_indication_Pain", 0.07),
        ("primary_indication_Neurological", 0.03),
    ])
    passes, pct = shap_gate(shap_df, ["primary_indication"])
    assert passes is True
    assert abs(pct - 0.10) < 1e-9  # 0.07 + 0.03 = 0.10, total = 1.0, so 10%


def test_shap_gate_primary_indication_confound_fails():
    """Verify shap_gate fails when primary_indication_* SHAP mass exceeds 15% threshold."""
    shap_df = _make_shap_df([
        ("age", 0.50),
        ("baseline_sppb", 0.20),
        ("primary_indication_Pain", 0.15),
        ("primary_indication_Neurological", 0.15),
    ])
    passes, pct = shap_gate(shap_df, ["primary_indication"])
    assert passes is False
    assert abs(pct - 0.30) < 1e-9  # 0.15 + 0.15 = 0.30, total = 1.0, so 30%


# ── should_save_models ────────────────────────────────────────────────────────

def test_should_save_when_combined_better():
    b = {"rmse_mean": 1.0, "r2_mean": 0.5}
    c = {"rmse_mean": 0.9, "r2_mean": 0.6}
    assert should_save_models(b, c) is True


def test_should_not_save_when_rmse_worse():
    b = {"rmse_mean": 1.0}
    c = {"rmse_mean": 1.1}
    assert should_save_models(b, c) is False


def test_should_not_save_when_r2_worse():
    b = {"r2_mean": 0.5}
    c = {"r2_mean": 0.4}
    assert should_save_models(b, c) is False


def test_should_save_when_combined_equal():
    b = {"rmse_mean": 1.0, "auc_roc_mean": 0.75}
    c = {"rmse_mean": 1.0, "auc_roc_mean": 0.75}
    assert should_save_models(b, c) is True


def test_should_save_skips_missing_keys():
    b = {"rmse_mean": 1.0}
    c = {"rmse_mean": 0.9, "extra": 99}
    assert should_save_models(b, c) is True
