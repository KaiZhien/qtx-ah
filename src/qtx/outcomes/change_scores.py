"""Compute per-test change scores for each outcome measure.

For each outcome test (VAS, TUG, 5xSST, normal gait speed, fast gait speed,
SPPB) computes direction-corrected improvement scores (positive = better),
plus raw change and percentage change where applicable.

Direction is driven by config/outcomes.yaml tests.*.higher_is_better.
"""

from __future__ import annotations

import pandas as pd

from qtx.utils.config import get_outcomes_config
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def compute_change_scores(df: pd.DataFrame) -> pd.DataFrame:
    """Compute improvement scores for each test, direction-corrected so that
    POSITIVE always means improvement.

    Formulas:
    - vas_improvement       = -(post_vas - pre_vas)           # lower VAS = better
    - tug_improvement       = -(post_tug_s - pre_tug_s)       # lower TUG = better
    - sst_improvement       = -(post_5xsst_s - pre_5xsst_s)   # lower SST = better
    - normal_gs_improvement = post_normal_gs_ms - pre_normal_gs_ms  # higher = better
    - fast_gs_improvement   = post_fast_gs_ms - pre_fast_gs_ms      # higher = better
    - sppb_improvement      = post_sppb - baseline_sppb              # higher = better

    Also computes raw changes (without direction correction):
    - tug_change_computed_s   = post_tug_s - pre_tug_s
    - tug_change_computed_pct = (post_tug_s - pre_tug_s) / pre_tug_s * 100
    - sst_change_computed_pct = (post_5xsst_s - pre_5xsst_s) / pre_5xsst_s * 100

    If either pre or post is NaN, the improvement score is NaN.
    Returns df with new improvement columns added.
    """
    cfg = get_outcomes_config()
    tests = cfg.get("tests", {})
    df = df.copy()

    # ------------------------------------------------------------------
    # VAS: lower is better → negate
    # ------------------------------------------------------------------
    if "vas" in tests:
        pre = df["pre_vas"].astype("float64")
        post = df["post_vas"].astype("float64")
        df["vas_improvement"] = -(post - pre)
        log.debug("Computed vas_improvement for %d rows", df["vas_improvement"].notna().sum())

    # ------------------------------------------------------------------
    # TUG: lower is better → negate
    # ------------------------------------------------------------------
    if "tug" in tests:
        pre = df["pre_tug_s"].astype("float64")
        post = df["post_tug_s"].astype("float64")
        raw_change = post - pre
        df["tug_improvement"] = -raw_change
        df["tug_change_computed_s"] = raw_change
        # pct change relative to pre (raw, not direction-corrected)
        df["tug_change_computed_pct"] = raw_change / pre * 100
        log.debug("Computed tug_improvement for %d rows", df["tug_improvement"].notna().sum())

    # ------------------------------------------------------------------
    # 5xSST: lower is better → negate
    # ------------------------------------------------------------------
    if "sst" in tests:
        pre = df["pre_5xsst_s"].astype("float64")
        post = df["post_5xsst_s"].astype("float64")
        raw_change = post - pre
        df["sst_improvement"] = -raw_change
        df["sst_change_computed_pct"] = raw_change / pre * 100
        log.debug("Computed sst_improvement for %d rows", df["sst_improvement"].notna().sum())

    # ------------------------------------------------------------------
    # Normal gait speed: higher is better → no negation
    # ------------------------------------------------------------------
    if "normal_gs" in tests:
        pre = df["pre_normal_gs_ms"].astype("float64")
        post = df["post_normal_gs_ms"].astype("float64")
        df["normal_gs_improvement"] = post - pre
        log.debug(
            "Computed normal_gs_improvement for %d rows",
            df["normal_gs_improvement"].notna().sum(),
        )

    # ------------------------------------------------------------------
    # Fast gait speed: higher is better → no negation
    # ------------------------------------------------------------------
    if "fast_gs" in tests:
        pre = df["pre_fast_gs_ms"].astype("float64")
        post = df["post_fast_gs_ms"].astype("float64")
        df["fast_gs_improvement"] = post - pre
        log.debug(
            "Computed fast_gs_improvement for %d rows",
            df["fast_gs_improvement"].notna().sum(),
        )

    # ------------------------------------------------------------------
    # SPPB: higher is better → no negation
    # ------------------------------------------------------------------
    if "sppb" in tests:
        pre = df["baseline_sppb"].astype("float64")
        post = df["post_sppb"].astype("float64")
        df["sppb_improvement"] = post - pre
        log.debug(
            "Computed sppb_improvement for %d rows",
            df["sppb_improvement"].notna().sum(),
        )

    return df
