"""Tests for src/qtx/outcomes/ — change_scores, composite, and responders modules.

Covers: direction-corrected improvement scores, MCID threshold logic,
NaN propagation, breadth_of_response counting, overall_responder threshold,
and is_dropout detection.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from qtx.outcomes.change_scores import compute_change_scores
from qtx.outcomes.composite import (
    apply_composite_normalizer,
    compute_composite,
    fit_composite_normalizer,
)
from qtx.outcomes.responders import compute_responders


# ---------------------------------------------------------------------------
# Helper: minimal df with a single patient row
# ---------------------------------------------------------------------------

def _make_df(**overrides) -> pd.DataFrame:
    """Build a single-row df with all required columns, applying any overrides."""
    defaults = {
        "sn": "T001",
        "has_followup": "Y",
        "pre_vas": 8.0,
        "post_vas": 5.0,
        "pre_tug_s": 20.0,
        "post_tug_s": 15.0,
        "pre_5xsst_s": 30.0,
        "post_5xsst_s": 25.0,
        "pre_normal_gs_ms": 0.8,
        "post_normal_gs_ms": 1.0,
        "pre_fast_gs_ms": 1.2,
        "post_fast_gs_ms": 1.4,
        "baseline_sppb": 7.0,
        "post_sppb": 9.0,
    }
    defaults.update(overrides)
    return pd.DataFrame([defaults])


# ---------------------------------------------------------------------------
# 1. Direction correction test
# ---------------------------------------------------------------------------

def test_tug_improvement_direction():
    """pre_tug=20, post_tug=15 → tug_improvement = 5 (positive = better)."""
    df = _make_df(pre_tug_s=20.0, post_tug_s=15.0)
    result = compute_change_scores(df)
    assert result.at[0, "tug_improvement"] == pytest.approx(5.0)


def test_vas_improvement_direction():
    """pre_vas=8, post_vas=5 → vas_improvement = 3 (positive = better)."""
    df = _make_df(pre_vas=8.0, post_vas=5.0)
    result = compute_change_scores(df)
    assert result.at[0, "vas_improvement"] == pytest.approx(3.0)


def test_normal_gs_improvement_direction():
    """pre_normal_gs=0.8, post_normal_gs=1.0 → normal_gs_improvement = 0.2 (positive = better)."""
    df = _make_df(pre_normal_gs_ms=0.8, post_normal_gs_ms=1.0)
    result = compute_change_scores(df)
    assert result.at[0, "normal_gs_improvement"] == pytest.approx(0.2)


# ---------------------------------------------------------------------------
# 2. MCID test for responders
# ---------------------------------------------------------------------------

def test_tug_responder_above_mcid():
    """tug_improvement=4.0 (>= 3.0 MCID) → tug_responder = 1."""
    df = _make_df(pre_tug_s=20.0, post_tug_s=16.0)  # improvement = 4.0
    df = compute_change_scores(df)
    result = compute_responders(df)
    assert result.at[0, "tug_responder"] == pytest.approx(1.0)


def test_vas_responder_below_mcid():
    """vas_improvement=1.0 (< 2.0 MCID) → vas_responder = 0."""
    df = _make_df(pre_vas=5.0, post_vas=4.0)  # improvement = 1.0 < 2.0 MCID
    df = compute_change_scores(df)
    result = compute_responders(df)
    assert result.at[0, "vas_responder"] == pytest.approx(0.0)


def test_sppb_responder_above_mcid():
    """sppb_improvement=1.5 (>= 1.0 MCID) → sppb_responder = 1."""
    df = _make_df(baseline_sppb=7.0, post_sppb=8.5)  # improvement = 1.5
    df = compute_change_scores(df)
    result = compute_responders(df)
    assert result.at[0, "sppb_responder"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# 3. NaN propagation test
# ---------------------------------------------------------------------------

def test_nan_post_tug_propagates():
    """post_tug=NaN → tug_improvement=NaN → tug_responder=NaN."""
    df = _make_df(pre_tug_s=20.0, post_tug_s=float("nan"))
    df = compute_change_scores(df)
    assert pd.isna(df.at[0, "tug_improvement"]), "Expected tug_improvement=NaN"
    result = compute_responders(df)
    assert pd.isna(result.at[0, "tug_responder"]), "Expected tug_responder=NaN"


# ---------------------------------------------------------------------------
# 4. Breadth of response test
# ---------------------------------------------------------------------------

def test_breadth_three_responders():
    """Patient who is responder in 3 tests → breadth_of_response == 3."""
    # tug_improvement=5 >= 3 MCID → responder
    # vas_improvement=3 >= 2 MCID → responder
    # sppb_improvement=2 >= 1 MCID → responder
    # normal_gs_improvement=0.03 < 0.05 MCID → not responder
    # no sst or fast_gs data → NaN
    df = _make_df(
        pre_tug_s=20.0, post_tug_s=15.0,   # tug improvement=5
        pre_vas=8.0, post_vas=5.0,          # vas improvement=3
        baseline_sppb=7.0, post_sppb=9.0,  # sppb improvement=2
        pre_normal_gs_ms=0.8, post_normal_gs_ms=0.82,  # improvement=0.02 < MCID
        pre_fast_gs_ms=1.2, post_fast_gs_ms=1.25,  # improvement=0.05 < 0.10 MCID
        pre_5xsst_s=30.0, post_5xsst_s=28.0,  # sst improvement=2/30 < 10% MCID
    )
    df = compute_change_scores(df)
    result = compute_responders(df)
    breadth = result.at[0, "breadth_of_response"]
    assert breadth == pytest.approx(3.0), f"Expected breadth=3, got {breadth}"


# ---------------------------------------------------------------------------
# 5. Overall responder test
# ---------------------------------------------------------------------------

def test_overall_responder_breadth_gte_2():
    """breadth >= 2 → overall_responder == 1."""
    # Create a patient with exactly 2 responders (TUG + VAS)
    df = _make_df(
        pre_tug_s=20.0, post_tug_s=15.0,  # tug improvement=5 → responder
        pre_vas=8.0, post_vas=5.0,          # vas improvement=3 → responder
        # Set gait/sst/sppb so they're non-responders (small change)
        pre_normal_gs_ms=0.8, post_normal_gs_ms=0.81,
        pre_fast_gs_ms=1.2, post_fast_gs_ms=1.21,
        baseline_sppb=7.0, post_sppb=7.5,
        pre_5xsst_s=30.0, post_5xsst_s=29.0,
    )
    df = compute_change_scores(df)
    result = compute_responders(df)
    assert result.at[0, "overall_responder"] == pytest.approx(1.0), (
        f"Expected overall_responder=1, got {result.at[0, 'overall_responder']}"
    )


def test_overall_responder_breadth_1():
    """breadth == 1 → overall_responder == 0."""
    # Only TUG is a responder; everything else below MCID or NaN
    df = _make_df(
        pre_tug_s=20.0, post_tug_s=15.0,  # tug improvement=5 → responder
        pre_vas=5.0, post_vas=4.5,          # vas improvement=0.5 < 2.0 MCID
        pre_normal_gs_ms=0.8, post_normal_gs_ms=0.81,
        pre_fast_gs_ms=1.2, post_fast_gs_ms=1.21,
        baseline_sppb=7.0, post_sppb=7.5,
        pre_5xsst_s=30.0, post_5xsst_s=29.0,
    )
    df = compute_change_scores(df)
    result = compute_responders(df)
    assert result.at[0, "overall_responder"] == pytest.approx(0.0), (
        f"Expected overall_responder=0, got {result.at[0, 'overall_responder']}"
    )


# ---------------------------------------------------------------------------
# 6. Dropout test
# ---------------------------------------------------------------------------

def test_dropout_no_followup():
    """has_followup == 'N' → is_dropout == 1."""
    df = _make_df(has_followup="N")
    # Need improvement columns — compute them but some may be NaN since post may be present
    df = compute_change_scores(df)
    result = compute_responders(df)
    assert result.at[0, "is_dropout"] == 1, (
        f"Expected is_dropout=1 for has_followup='N', got {result.at[0, 'is_dropout']}"
    )


# ---------------------------------------------------------------------------
# 7. Composite normalizer: fit/apply == deployed compute_composite
# ---------------------------------------------------------------------------

def _make_composite_df(n: int = 120, seed: int = 1) -> pd.DataFrame:
    """Synthetic frame with the 6 improvement columns + cohort for composite."""
    rng = np.random.default_rng(seed)
    cohorts = rng.choice(["Pain & MSK", "Neurological", "Frailty"], n)
    df = pd.DataFrame({"cohort": cohorts})
    for col in [
        "vas_improvement", "tug_improvement", "sst_improvement",
        "normal_gs_improvement", "fast_gs_improvement", "sppb_improvement",
    ]:
        vals = rng.normal(0, 1, n)
        # sprinkle NaNs so min_tests logic is exercised
        vals[rng.random(n) < 0.2] = np.nan
        df[col] = vals
    return df


def test_fit_apply_matches_compute_composite_on_same_frame():
    """The deployed compute_composite must equal fit-then-apply on the same frame.

    Guards the refactor that split _z_score_column into fit/apply primitives.
    """
    df = _make_composite_df()
    deployed = compute_composite(df.copy())["composite_improvement"].to_numpy()
    norm = fit_composite_normalizer(df, min_cohort_n=30)
    refit = apply_composite_normalizer(df, norm, min_tests_required=1).to_numpy()
    np.testing.assert_allclose(refit, deployed, equal_nan=True)


def test_apply_composite_respects_min_tests_required():
    """Rows with fewer available tests than min_tests_required → NaN composite."""
    df = pd.DataFrame(
        {
            "cohort": ["A", "A", "A"],
            "vas_improvement": [1.0, np.nan, 2.0],
            "tug_improvement": [np.nan, np.nan, 3.0],
        }
    )
    norm = fit_composite_normalizer(df, min_cohort_n=30)
    # row 1 has 0 tests → NaN under any min_tests >= 1
    comp2 = apply_composite_normalizer(df, norm, min_tests_required=2)
    assert pd.isna(comp2.iloc[1])  # 0 tests
    assert pd.isna(comp2.iloc[0])  # only 1 test, needs 2
    assert not pd.isna(comp2.iloc[2])  # 2 tests
