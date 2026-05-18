"""Tests for src/qtx/missing/ — profile and impute modules.

Covers: fill_zero strategy, category_missing sentinel, complete_case row dropping,
outcome columns never imputed, and missing indicator column creation.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qtx.missing.impute import FeatureImputer, run_complete_case


# ---------------------------------------------------------------------------
# 1. fill_zero test
# ---------------------------------------------------------------------------

def test_fill_zero_imputes_nan_to_zero():
    """has_oa column with NaN → imputed to 0 using fill_zero strategy."""
    df = pd.DataFrame({
        "has_oa": [1.0, np.nan, np.nan, 1.0, 1.0],
        "age": [65, 70, 72, 68, 80],
    })
    nan_mask = df["has_oa"].isna()
    imputer = FeatureImputer(
        feature_cols=["has_oa"],
        strategy_override="fill_zero",
    )
    result = imputer.fit_transform(df)
    assert result["has_oa"].isna().sum() == 0, "Expected no NaN after fill_zero"
    # The originally-NaN cells should now be 0
    assert (result["has_oa"][nan_mask] == 0.0).all(), (
        "Expected originally-NaN cells to be filled with 0"
    )


# ---------------------------------------------------------------------------
# 2. category_missing test
# ---------------------------------------------------------------------------

def test_category_missing_imputes_nan_to_sentinel():
    """gender column with NaN → imputed to '__missing__'."""
    df = pd.DataFrame({
        "gender": ["M", np.nan, "F", np.nan],
        "age": [65, 70, 72, 68],
    })
    imputer = FeatureImputer(
        feature_cols=["gender"],
        strategy_override="category_missing",
    )
    result = imputer.fit_transform(df)
    assert result["gender"].isna().sum() == 0, "Expected no NaN after category_missing"
    assert (result["gender"] == "__missing__").sum() == 2, (
        "Expected 2 '__missing__' sentinels"
    )


# ---------------------------------------------------------------------------
# 3. complete_case test
# ---------------------------------------------------------------------------

def test_complete_case_drops_rows_with_na_age():
    """run_complete_case(df, ['age']) drops rows where age is NaN."""
    df = pd.DataFrame({
        "age": [65.0, np.nan, 72.0, np.nan, 80.0],
        "gender": ["M", "F", "M", "F", "M"],
    })
    result = run_complete_case(df, feature_cols=["age"])
    assert len(result) == 3, f"Expected 3 rows after dropping NaN age, got {len(result)}"
    assert result["age"].isna().sum() == 0, "Expected no NaN age in complete-case result"


# ---------------------------------------------------------------------------
# 4. Outcome never imputed test (complete_case strategy)
# ---------------------------------------------------------------------------

def test_outcome_cols_not_imputed_in_complete_case():
    """post_tug_s (an outcome column) should NOT be imputed in complete_case strategy.

    The FeatureImputer excludes outcome columns even if they are listed in feature_cols.
    With complete_case, only non-outcome cols are used for row filtering.
    """
    df = pd.DataFrame({
        "age": [65.0, 70.0, np.nan],
        "post_tug_s": [np.nan, 12.0, 15.0],  # outcome column — should NOT be used to filter
    })
    imputer = FeatureImputer(
        feature_cols=["age", "post_tug_s"],
        strategy_override="complete_case",
    )
    result = imputer.fit_transform(df)
    # post_tug_s is excluded → complete_case only filters on age
    # Row 2 (age=NaN) dropped; rows 0 and 1 kept → 2 rows
    assert len(result) == 2, (
        f"Expected 2 rows (complete_case on age only, outcome excluded), got {len(result)}"
    )
    # post_tug_s should still have NaN (not imputed) in row 0
    assert pd.isna(result["post_tug_s"].iloc[0]), (
        "post_tug_s (outcome) NaN should not be filled"
    )


# ---------------------------------------------------------------------------
# 5. Missing indicator test
# ---------------------------------------------------------------------------

def test_missing_indicator_adds_binary_column():
    """age with strategy 'missing_indicator' → adds age_missing column (0/1)."""
    df = pd.DataFrame({
        "age": [65.0, np.nan, 72.0, np.nan, 80.0],
        "gender": ["M", "F", "M", "F", "M"],
    })
    imputer = FeatureImputer(
        feature_cols=["age"],
        strategy_override="missing_indicator",
    )
    result = imputer.fit_transform(df)

    assert "age_missing" in result.columns, "Expected 'age_missing' indicator column"
    assert list(result["age_missing"]) == [0, 1, 0, 1, 0], (
        f"Expected [0, 1, 0, 1, 0] for age_missing, got {list(result['age_missing'])}"
    )
    # Original age column should be unchanged (still has NaN)
    assert result["age"].isna().sum() == 2, (
        "Original age column should still have NaN with missing_indicator strategy"
    )
