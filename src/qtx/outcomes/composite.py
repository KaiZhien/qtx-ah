"""Build the composite improvement score from available per-test change scores.

Implements the z_mean_available_case method: each test's improvement is
z-scored within cohort (if n >= 30) or globally (otherwise), then averaged
across all tests where the patient has a value.

Requires at least min_tests_required non-missing tests per config/outcomes.yaml.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qtx.utils.config import get_outcomes_config
from qtx.utils.logging import get_logger

log = get_logger(__name__)

# The 6 improvement columns in order
IMPROVEMENT_COLS = [
    "vas_improvement",
    "tug_improvement",
    "sst_improvement",
    "normal_gs_improvement",
    "fast_gs_improvement",
    "sppb_improvement",
]


def _fit_zscore_stats(
    series: pd.Series,
    cohort: pd.Series,
    min_cohort_n: int = 30,
) -> dict:
    """Fit z-score normalisation statistics for one improvement column.

    Returns a dict with the global (mean, sd) plus a per-cohort mapping of
    (mean, sd) for every cohort that has at least *min_cohort_n* non-null
    observations. Cohorts below the threshold are intentionally omitted so
    that :func:`_apply_zscore` falls back to the global statistics for them.

    Splitting fit/apply lets cross-validation fit the statistics on the
    training fold ONLY and apply them to the validation fold — the deployed
    :func:`compute_composite` path simply fits and applies on the same frame.
    """
    series = series.astype("float64")
    stats = {
        "global": (series.mean(), series.std(ddof=1)),
        "cohorts": {},
    }
    for grp, idx in series.groupby(cohort).groups.items():
        grp_vals = series.loc[idx]
        if grp_vals.notna().sum() >= min_cohort_n:
            stats["cohorts"][grp] = (grp_vals.mean(), grp_vals.std(ddof=1))
    return stats


def _apply_zscore(series: pd.Series, cohort: pd.Series, stats: dict) -> pd.Series:
    """Apply fitted z-score *stats* to *series*, standardising within cohort.

    Rows whose cohort was not fitted with its own statistics (small cohorts,
    or cohorts unseen at fit time) fall back to the global mean/SD. Matches the
    original ``_z_score_column`` semantics when stats were fitted on the same
    frame.
    """
    series = series.astype("float64")
    z = pd.Series(np.nan, index=series.index, dtype="float64")
    global_mean, global_std = stats["global"]

    for grp, idx in series.groupby(cohort).groups.items():
        grp_vals = series.loc[idx]
        mu, sd = stats["cohorts"].get(grp, (global_mean, global_std))
        if sd == 0 or pd.isna(sd):
            # All values identical — z-score is 0 for non-null entries
            z.loc[idx] = np.where(grp_vals.notna(), 0.0, np.nan)
        else:
            z.loc[idx] = (grp_vals - mu) / sd

    return z


def _z_score_column(
    series: pd.Series,
    cohort: pd.Series,
    min_cohort_n: int = 30,
) -> pd.Series:
    """Z-score a series, standardising within cohort when n >= min_cohort_n.

    For cohorts with fewer than min_cohort_n observations the global mean/SD
    (across all patients with a value) is used instead. Thin wrapper over
    :func:`_fit_zscore_stats` + :func:`_apply_zscore` fitted on the same series.

    Returns pd.Series of z-scores (same index as *series*).
    """
    stats = _fit_zscore_stats(series, cohort, min_cohort_n)
    return _apply_zscore(series, cohort, stats)


def fit_composite_normalizer(
    df: pd.DataFrame,
    min_cohort_n: int = 30,
) -> dict:
    """Fit per-test z-score statistics used to build ``composite_improvement``.

    Only the improvement columns present in *df* are fitted. The returned
    normaliser is consumed by :func:`apply_composite_normalizer`.

    This is the leak-free entry point for cross-validation: fit on the training
    fold, apply to the validation fold.
    """
    available_cols = [c for c in IMPROVEMENT_COLS if c in df.columns]
    cohort = df["cohort"]
    return {
        "cols": available_cols,
        "per_col": {
            col: _fit_zscore_stats(df[col], cohort, min_cohort_n)
            for col in available_cols
        },
    }


def apply_composite_normalizer(
    df: pd.DataFrame,
    normalizer: dict,
    min_tests_required: int = 1,
) -> pd.Series:
    """Compute ``composite_improvement`` for *df* using a fitted *normalizer*.

    Row-wise mean of the available per-test z-scores; rows with fewer than
    *min_tests_required* available tests are set to NaN.
    """
    cohort = df["cohort"]
    z_cols = {
        f"z_{col}": _apply_zscore(df[col], cohort, normalizer["per_col"][col])
        for col in normalizer["cols"]
    }
    z_df = pd.DataFrame(z_cols, index=df.index)
    n_available = z_df.notna().sum(axis=1)
    composite = z_df.mean(axis=1)
    composite[n_available < min_tests_required] = np.nan
    return composite


def compute_composite(df: pd.DataFrame) -> pd.DataFrame:
    """Compute the composite improvement score for each patient.

    Algorithm (method = "z_mean_available_case" from outcomes.yaml):
    1. For each of the 6 improvement columns, z-score the values:
       - Standardise within cohort if n >= 30 (cohort mean and SD from patients
         with that test)
       - Else standardise globally (across all patients with that test)
    2. For each patient, average the z-scores for all tests where the patient
       has a value (i.e., where improvement != NaN)
    3. If patient has fewer than min_tests_required available z-scores →
       composite = NaN
    4. Store as composite_improvement column

    Returns df with composite_improvement added.
    """
    cfg = get_outcomes_config()
    composite_cfg = cfg.get("composite", {})
    method = composite_cfg.get("method", "z_mean_available_case")
    min_tests = composite_cfg.get("min_tests_required", 1)

    if method != "z_mean_available_case":
        raise NotImplementedError(f"Composite method {method!r} not implemented")

    df = df.copy()
    cohort = df["cohort"]

    # Only include improvement columns that are actually present in df
    available_cols = [c for c in IMPROVEMENT_COLS if c in df.columns]
    log.info("Computing composite over %d improvement columns: %s", len(available_cols), available_cols)

    # Step 1 — z-score each test
    z_cols: list[str] = []
    for col in available_cols:
        z_col = f"z_{col}"
        df[z_col] = _z_score_column(df[col], cohort)
        z_cols.append(z_col)
        log.debug(
            "Z-scored %s → %s (non-null: %d)", col, z_col, df[z_col].notna().sum()
        )

    # Step 2 — row-wise mean of available z-scores
    z_df = df[z_cols]
    n_available = z_df.notna().sum(axis=1)

    # Step 3 — require min_tests_required
    composite = z_df.mean(axis=1)  # nanmean by default
    composite[n_available < min_tests] = np.nan

    df["composite_improvement"] = composite
    log.info(
        "composite_improvement: %d non-null values (min_tests=%d)",
        df["composite_improvement"].notna().sum(),
        min_tests,
    )

    return df
