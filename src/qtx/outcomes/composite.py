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


def _z_score_column(
    series: pd.Series,
    cohort: pd.Series,
    min_cohort_n: int = 30,
) -> pd.Series:
    """Z-score a series, standardising within cohort when n >= min_cohort_n.

    For cohorts with fewer than min_cohort_n observations the global mean/SD
    (across all patients with a value) is used instead.

    Parameters
    ----------
    series:
        The improvement column to standardise.
    cohort:
        Cohort label for each patient.
    min_cohort_n:
        Minimum number of non-null observations in a cohort to use cohort-level
        standardisation. Defaults to 30.

    Returns
    -------
    pd.Series of z-scores (same index as *series*).
    """
    z = pd.Series(np.nan, index=series.index, dtype="float64")

    global_mean = series.mean()
    global_std = series.std(ddof=1)

    # Standardise each cohort separately if it has enough data
    for grp, idx in series.groupby(cohort).groups.items():
        grp_vals = series.loc[idx]
        n_valid = grp_vals.notna().sum()
        if n_valid >= min_cohort_n:
            mu = grp_vals.mean()
            sd = grp_vals.std(ddof=1)
        else:
            mu = global_mean
            sd = global_std

        if sd == 0 or pd.isna(sd):
            # All values identical — z-score is 0 for non-null entries
            z.loc[idx] = np.where(grp_vals.notna(), 0.0, np.nan)
        else:
            z.loc[idx] = (grp_vals - mu) / sd

    return z


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
