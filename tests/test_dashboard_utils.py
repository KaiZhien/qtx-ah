"""Unit tests for dashboard/_utils.py pure helper functions."""
import sys
import unittest.mock as mock
from pathlib import Path

# Mock streamlit before importing _utils so cache decorators don't require a live app
sys.modules.setdefault("streamlit", mock.MagicMock())

_dashboard = Path(__file__).resolve().parent.parent / "dashboard"
if str(_dashboard) not in sys.path:
    sys.path.insert(0, str(_dashboard))

import pandas as pd
import pytest

from _utils import _unique_sorted, apply_filters


def test_unique_sorted_basic():
    s = pd.Series([3, 1, 2, 1])
    assert _unique_sorted(s) == [1, 2, 3]


def test_unique_sorted_includes_missing_sentinel():
    s = pd.Series([1.0, None, 2.0])
    result = _unique_sorted(s)
    assert "__missing__" in result
    assert 1.0 in result


def test_unique_sorted_no_duplicate_missing():
    s = pd.Series(["a", None, "__missing__"])
    result = _unique_sorted(s)
    assert result.count("__missing__") == 1


def test_apply_filters_cohort():
    df = pd.DataFrame({
        "cohort": ["A", "B", "A"],
        "usage_frequency": ["once", "once", "twice"],
        "age_band": ["60-70", "60-70", "70-80"],
        "gender": ["M", "F", "M"],
    })
    result = apply_filters(df, {"cohort": ["A"], "usage_frequency": [], "age_band": [], "gender": []})
    assert list(result["cohort"]) == ["A", "A"]


def test_apply_filters_multiple_dims():
    df = pd.DataFrame({
        "cohort": ["A", "A", "B"],
        "usage_frequency": ["once", "twice", "once"],
        "age_band": ["60-70", "60-70", "70-80"],
        "gender": ["M", "F", "M"],
    })
    result = apply_filters(df, {
        "cohort": ["A"],
        "usage_frequency": ["once"],
        "age_band": [],
        "gender": [],
    })
    assert len(result) == 1
    assert result.iloc[0]["usage_frequency"] == "once"


def test_apply_filters_empty_selection_passes_all():
    df = pd.DataFrame({
        "cohort": ["A", "B"],
        "usage_frequency": ["once", "twice"],
        "age_band": ["60-70", "70-80"],
        "gender": ["M", "F"],
    })
    result = apply_filters(df, {"cohort": [], "usage_frequency": [], "age_band": [], "gender": []})
    assert len(result) == 2
