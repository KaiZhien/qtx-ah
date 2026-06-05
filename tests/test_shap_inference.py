"""Tests for SHAP top-5 feature contributions at inference."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

# Ensure api/ is on the path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from services.prediction import _compute_shap_top5


def _make_X(n_features: int = 10) -> pd.DataFrame:
    cols = [f"feat_{i}" for i in range(n_features)]
    return pd.DataFrame([[float(i) for i in range(n_features)]], columns=cols)


def test_compute_shap_top5_returns_five_items():
    """Should return exactly 5 dicts each with 'feature' and 'contribution' keys."""
    X = _make_X(10)
    mock_model = MagicMock()
    shap_values = np.array([[0.1, 0.5, -0.3, 0.9, -0.2, 0.4, -0.1, 0.7, 0.05, -0.8]])

    with patch("shap.TreeExplainer") as MockExplainer:
        instance = MockExplainer.return_value
        instance.shap_values.return_value = shap_values

        result = _compute_shap_top5(mock_model, X)

    assert result is not None
    assert len(result) == 5
    for item in result:
        assert "feature" in item
        assert "contribution" in item
        assert isinstance(item["feature"], str)
        assert isinstance(item["contribution"], float)


def test_compute_shap_top5_sorted_by_abs_contribution():
    """Items should be sorted descending by absolute contribution value."""
    X = _make_X(10)
    mock_model = MagicMock()
    shap_values = np.array([[0.1, 0.5, -0.3, 0.9, -0.2, 0.4, -0.1, 0.7, 0.05, -0.8]])

    with patch("shap.TreeExplainer") as MockExplainer:
        instance = MockExplainer.return_value
        instance.shap_values.return_value = shap_values

        result = _compute_shap_top5(mock_model, X)

    assert result is not None
    abs_contributions = [abs(item["contribution"]) for item in result]
    assert abs_contributions == sorted(abs_contributions, reverse=True)

    # Top contribution should be 0.9 (feat_3) and second -0.8 (feat_9)
    assert result[0]["feature"] == "feat_3"
    assert result[0]["contribution"] == round(0.9, 4)
    assert result[1]["feature"] == "feat_9"
    assert result[1]["contribution"] == round(-0.8, 4)


def test_compute_shap_top5_returns_none_on_exception():
    """When shap raises an exception, function returns None and does not re-raise."""
    X = _make_X(10)
    mock_model = MagicMock()

    with patch("shap.TreeExplainer", side_effect=RuntimeError("shap exploded")):
        result = _compute_shap_top5(mock_model, X)

    assert result is None


def test_compute_shap_top5_handles_list_shap_values():
    """When shap_values is a list (multi-output), uses first element."""
    X = _make_X(6)
    mock_model = MagicMock()
    shap_vals_array = np.array([[0.1, 0.5, -0.3, 0.9, -0.2, 0.4]])

    with patch("shap.TreeExplainer") as MockExplainer:
        instance = MockExplainer.return_value
        # Return as a list (mimics multi-output / binary classifier format)
        instance.shap_values.return_value = [shap_vals_array]

        result = _compute_shap_top5(mock_model, X)

    assert result is not None
    assert len(result) == 5


def test_shap_top5_in_session_prediction_orm():
    """SessionPrediction ORM model must have a shap_top5 column."""
    from models.clinical import SessionPrediction
    from sqlalchemy import inspect as sa_inspect

    mapper = sa_inspect(SessionPrediction)
    column_names = [col.key for col in mapper.mapper.column_attrs]
    assert "shap_top5" in column_names, "shap_top5 column missing from SessionPrediction ORM model"
