"""Tests for the multi-model retrain additions in scripts/18_scheduled_retrain.py."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import importlib.util

import numpy as np
import pandas as pd
import pytest

# The script filename starts with a digit so it cannot be imported via normal import
# machinery. Use importlib to load it directly without running main().
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "api"))

_SCRIPT_PATH = ROOT / "scripts" / "18_scheduled_retrain.py"
_spec = importlib.util.spec_from_file_location("scheduled_retrain", _SCRIPT_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

_build_training_matrix = _mod._build_training_matrix
_retrain_classifier = _mod._retrain_classifier
_retrain_dropout = _mod._retrain_dropout


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_classifier_df(n: int = 40) -> pd.DataFrame:
    """Minimal DataFrame suitable for classifier retraining."""
    rng = np.random.default_rng(0)
    return pd.DataFrame({
        "age": rng.integers(50, 80, n).astype(float),
        "baseline_sppb": rng.integers(4, 12, n).astype(float),
        "overall_responder": rng.integers(0, 2, n).astype(float),
        "cohort": rng.choice(["A", "B", "C"], n),
        "gender": rng.choice(["M", "F"], n),
        "usage_frequency": rng.choice(["daily", "weekly"], n),
    })


def _make_dropout_df(n: int = 40) -> pd.DataFrame:
    """Minimal DataFrame suitable for dropout retraining."""
    rng = np.random.default_rng(1)
    return pd.DataFrame({
        "age": rng.integers(50, 80, n).astype(float),
        "baseline_sppb": rng.integers(4, 12, n).astype(float),
        "is_dropout": rng.integers(0, 2, n).astype(float),
        "cohort": rng.choice(["A", "B", "C"], n),
        "gender": rng.choice(["M", "F"], n),
        "usage_frequency": rng.choice(["daily", "weekly"], n),
    })


def _mock_existing_model(feature_names: list[str]):
    """Create a mock existing model that exposes feature_names_in_."""
    mock = MagicMock()
    mock.feature_names_in_ = np.array(feature_names)
    return mock


# ---------------------------------------------------------------------------
# _build_training_matrix
# ---------------------------------------------------------------------------

class TestBuildTrainingMatrix:
    def test_handles_missing_features_with_zeros(self):
        df = pd.DataFrame({"age": [30.0, 40.0, 50.0]})
        feature_names = ["age", "nonexistent_feature"]
        result = _build_training_matrix(df, feature_names)

        assert result.shape == (3, 2)
        np.testing.assert_array_equal(result[:, 0], [30.0, 40.0, 50.0])
        np.testing.assert_array_equal(result[:, 1], [0.0, 0.0, 0.0])

    def test_handles_categorical_encoding(self):
        df = pd.DataFrame({
            "age": [30.0, 40.0],
            "cohort": ["A", "B"],
        })
        feature_names = ["age", "cohort_A", "cohort_B"]
        result = _build_training_matrix(df, feature_names)

        assert result.shape == (2, 3)
        # Row 0: cohort=A → cohort_A=1, cohort_B=0
        assert result[0, 1] == 1.0
        assert result[0, 2] == 0.0
        # Row 1: cohort=B → cohort_A=0, cohort_B=1
        assert result[1, 1] == 0.0
        assert result[1, 2] == 1.0

    def test_returns_numpy_array(self):
        df = pd.DataFrame({"x": [1.0, 2.0]})
        result = _build_training_matrix(df, ["x"])
        assert isinstance(result, np.ndarray)

    def test_fills_nan_with_zero(self):
        df = pd.DataFrame({"age": [30.0, float("nan"), 50.0]})
        result = _build_training_matrix(df, ["age"])
        assert result[1, 0] == 0.0


# ---------------------------------------------------------------------------
# _retrain_classifier
# ---------------------------------------------------------------------------

class TestRetrainClassifier:
    def test_returns_metrics_and_model(self):
        df = _make_classifier_df(40)
        feature_names = ["age", "baseline_sppb"]
        existing_model = _mock_existing_model(feature_names)

        result = _retrain_classifier(df, existing_model)

        assert result is not None
        metrics, model = result
        assert "auc_mean" in metrics
        assert "n" in metrics
        assert metrics["n"] == 40
        assert 0.0 <= metrics["auc_mean"] <= 1.0

    def test_returns_none_for_insufficient_data(self):
        df = _make_classifier_df(5)
        existing_model = _mock_existing_model(["age", "baseline_sppb"])

        result = _retrain_classifier(df, existing_model)

        assert result is None

    def test_uses_existing_model_feature_names(self):
        df = _make_classifier_df(40)
        # Only "age" as feature — should work even though df has more columns
        existing_model = _mock_existing_model(["age"])

        result = _retrain_classifier(df, existing_model)

        assert result is not None
        _, model = result
        # The fitted model should have been trained on 1 feature
        assert model.n_features_in_ == 1

    def test_handles_categorical_features(self):
        df = _make_classifier_df(40)
        feature_names = ["age", "cohort_A", "cohort_B", "cohort_C",
                         "gender_M", "gender_F"]
        existing_model = _mock_existing_model(feature_names)

        result = _retrain_classifier(df, existing_model)

        assert result is not None
        metrics, _ = result
        assert 0.0 <= metrics["auc_mean"] <= 1.0

    def test_skips_rows_with_null_overall_responder(self):
        df = _make_classifier_df(40)
        # Null out half the target — should still have 20 usable rows
        df.loc[:19, "overall_responder"] = np.nan

        result = _retrain_classifier(df, _mock_existing_model(["age"]))

        assert result is not None
        _, model = result
        # n in metrics should reflect the 20 non-null rows
        assert result[0]["n"] == 20


# ---------------------------------------------------------------------------
# _retrain_dropout
# ---------------------------------------------------------------------------

class TestRetrainDropout:
    def test_returns_metrics_and_model(self):
        df = _make_dropout_df(40)
        existing_model = _mock_existing_model(["age", "baseline_sppb"])

        result = _retrain_dropout(df, existing_model)

        assert result is not None
        metrics, model = result
        assert "auc_mean" in metrics
        assert "n" in metrics
        assert metrics["n"] == 40
        assert 0.0 <= metrics["auc_mean"] <= 1.0

    def test_returns_none_for_insufficient_data(self):
        df = _make_dropout_df(5)
        existing_model = _mock_existing_model(["age"])

        result = _retrain_dropout(df, existing_model)

        assert result is None

    def test_handles_categorical_features(self):
        df = _make_dropout_df(40)
        feature_names = ["age", "cohort_A", "cohort_B", "gender_M", "gender_F"]
        existing_model = _mock_existing_model(feature_names)

        result = _retrain_dropout(df, existing_model)

        assert result is not None
        metrics, _ = result
        assert 0.0 <= metrics["auc_mean"] <= 1.0

    def test_skips_rows_with_null_is_dropout(self):
        df = _make_dropout_df(40)
        df.loc[:19, "is_dropout"] = np.nan

        result = _retrain_dropout(df, _mock_existing_model(["age"]))

        assert result is not None
        assert result[0]["n"] == 20
