"""Derive overall responder and dropout flags from per-test MCID columns.

overall_responder: 1 if the patient met MCID on >= threshold_for_overall_responder
tests (from config/outcomes.yaml). is_dropout: 1 if has_followup == "N".
Also computes breadth_of_response (count of tests where responder == 1).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qtx.utils.config import get_outcomes_config
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def _responder_flag(
    improvement: pd.Series,
    mcid_abs: float | None = None,
    mcid_pct: float | None = None,
    pct_denominator: pd.Series | None = None,
    require_both: bool = False,
) -> pd.Series:
    """Compute a per-test responder flag.

    Returns:
    - 1.0  if improvement meets at least one of the MCID criteria (or both if require_both)
    - 0.0  if tested but criterion not met
    - NaN  if improvement is NaN (not tested / missing)

    Parameters
    ----------
    improvement:
        Direction-corrected improvement values (positive = better).
    mcid_abs:
        Minimum clinically important difference in absolute units. None to skip.
    mcid_pct:
        MCID as fraction of pre-test value (e.g. 0.10 for 10%). None to skip.
    pct_denominator:
        Pre-test values used in the percentage criterion. Required when mcid_pct
        is not None.
    require_both:
        If True, BOTH criteria must be met (AND logic). Default is False (OR).
    """
    criteria: list[pd.Series] = []

    if mcid_abs is not None:
        criteria.append(improvement >= mcid_abs)

    if mcid_pct is not None:
        if pct_denominator is None:
            raise ValueError("pct_denominator required when mcid_pct is set")
        pct_improvement = improvement / pct_denominator.astype("float64")
        criteria.append(pct_improvement >= mcid_pct)

    if not criteria:
        raise ValueError("At least one of mcid_abs or mcid_pct must be provided")

    if len(criteria) == 1:
        met = criteria[0]
    elif require_both:
        met = criteria[0]
        for c in criteria[1:]:
            met = met & c
    else:
        # OR logic: responder if ANY criterion is satisfied
        met = criteria[0]
        for c in criteria[1:]:
            met = met | c

    # Convert to float with NaN preservation
    flag = met.astype("float64")
    flag[improvement.isna()] = np.nan
    return flag


def compute_responders(df: pd.DataFrame) -> pd.DataFrame:
    """Compute per-test responder flags and overall responder status.

    Per-test responder logic (from outcomes.yaml tests.*.mcid_abs / mcid_pct):
    - vas_responder:      vas_improvement >= mcid_abs (2.0)
    - tug_responder:      tug_improvement >= mcid_abs (3.0) OR
                          tug_improvement / pre_tug_s >= mcid_pct (0.10)
    - sst_responder:      sst_improvement / pre_5xsst_s >= mcid_pct (0.10)
    - normal_gs_responder: normal_gs_improvement >= mcid_abs (0.05)
    - fast_gs_responder:   fast_gs_improvement >= mcid_abs (0.10)
    - sppb_responder:     sppb_improvement >= mcid_abs (1.0)

    For each test:
    - 1 if improvement meets MCID criterion (responder)
    - 0 if improvement does not meet criterion (tested but non-responder)
    - NaN if improvement is NaN (not tested / no follow-up)

    breadth_of_response: count of tests where responder flag == 1 (0–6)
    overall_responder:   1 if breadth >= threshold_for_overall_responder (2), else 0
                         NaN if patient has no follow-up at all (all flags NaN)
    is_dropout:          1 if has_followup == "N", else 0

    Returns df with all responder columns added.
    """
    cfg = get_outcomes_config()
    tests_cfg = cfg.get("tests", {})
    breadth_cfg = cfg.get("responder_breadth", {})
    threshold = breadth_cfg.get("threshold_for_overall_responder", 2)

    df = df.copy()

    # ------------------------------------------------------------------
    # Per-test responder flags
    # ------------------------------------------------------------------
    responder_cols: list[str] = []

    # VAS — absolute only
    if "vas" in tests_cfg and "vas_improvement" in df.columns:
        vas_cfg = tests_cfg["vas"]
        df["vas_responder"] = _responder_flag(
            df["vas_improvement"],
            mcid_abs=vas_cfg.get("mcid_abs"),
        )
        responder_cols.append("vas_responder")
        log.debug("vas_responder: %d yes, %d no, %d NaN",
                  (df["vas_responder"] == 1).sum(),
                  (df["vas_responder"] == 0).sum(),
                  df["vas_responder"].isna().sum())

    # TUG — abs OR pct
    if "tug" in tests_cfg and "tug_improvement" in df.columns:
        tug_cfg = tests_cfg["tug"]
        df["tug_responder"] = _responder_flag(
            df["tug_improvement"],
            mcid_abs=tug_cfg.get("mcid_abs"),
            mcid_pct=tug_cfg.get("mcid_pct"),
            pct_denominator=df["pre_tug_s"],
        )
        responder_cols.append("tug_responder")
        log.debug("tug_responder: %d yes, %d no, %d NaN",
                  (df["tug_responder"] == 1).sum(),
                  (df["tug_responder"] == 0).sum(),
                  df["tug_responder"].isna().sum())

    # SST — pct only
    if "sst" in tests_cfg and "sst_improvement" in df.columns:
        sst_cfg = tests_cfg["sst"]
        df["sst_responder"] = _responder_flag(
            df["sst_improvement"],
            mcid_abs=sst_cfg.get("mcid_abs"),  # will be None
            mcid_pct=sst_cfg.get("mcid_pct"),
            pct_denominator=df["pre_5xsst_s"],
        )
        responder_cols.append("sst_responder")
        log.debug("sst_responder: %d yes, %d no, %d NaN",
                  (df["sst_responder"] == 1).sum(),
                  (df["sst_responder"] == 0).sum(),
                  df["sst_responder"].isna().sum())

    # Normal gait speed — absolute only
    if "normal_gs" in tests_cfg and "normal_gs_improvement" in df.columns:
        ngs_cfg = tests_cfg["normal_gs"]
        df["normal_gs_responder"] = _re_flag_abs(
            df["normal_gs_improvement"],
            mcid_abs=ngs_cfg.get("mcid_abs"),
        )
        responder_cols.append("normal_gs_responder")
        log.debug("normal_gs_responder: %d yes, %d no, %d NaN",
                  (df["normal_gs_responder"] == 1).sum(),
                  (df["normal_gs_responder"] == 0).sum(),
                  df["normal_gs_responder"].isna().sum())

    # Fast gait speed — absolute only
    if "fast_gs" in tests_cfg and "fast_gs_improvement" in df.columns:
        fgs_cfg = tests_cfg["fast_gs"]
        df["fast_gs_responder"] = _re_flag_abs(
            df["fast_gs_improvement"],
            mcid_abs=fgs_cfg.get("mcid_abs"),
        )
        responder_cols.append("fast_gs_responder")
        log.debug("fast_gs_responder: %d yes, %d no, %d NaN",
                  (df["fast_gs_responder"] == 1).sum(),
                  (df["fast_gs_responder"] == 0).sum(),
                  df["fast_gs_responder"].isna().sum())

    # SPPB — absolute only
    if "sppb" in tests_cfg and "sppb_improvement" in df.columns:
        sppb_cfg = tests_cfg["sppb"]
        df["sppb_responder"] = _re_flag_abs(
            df["sppb_improvement"],
            mcid_abs=sppb_cfg.get("mcid_abs"),
        )
        responder_cols.append("sppb_responder")
        log.debug("sppb_responder: %d yes, %d no, %d NaN",
                  (df["sppb_responder"] == 1).sum(),
                  (df["sppb_responder"] == 0).sum(),
                  df["sppb_responder"].isna().sum())

    # ------------------------------------------------------------------
    # breadth_of_response: count of responder flags == 1
    # ------------------------------------------------------------------
    if responder_cols:
        resp_df = df[responder_cols]
        df["breadth_of_response"] = (resp_df == 1).sum(axis=1).astype("float64")
        # Where ALL flags are NaN → breadth is NaN (no follow-up)
        all_nan = resp_df.isna().all(axis=1)
        df.loc[all_nan, "breadth_of_response"] = np.nan
    else:
        df["breadth_of_response"] = np.nan

    # ------------------------------------------------------------------
    # overall_responder
    # ------------------------------------------------------------------
    overall = (df["breadth_of_response"] >= threshold).astype("float64")
    # NaN where breadth is NaN
    overall[df["breadth_of_response"].isna()] = np.nan
    df["overall_responder"] = overall

    # ------------------------------------------------------------------
    # is_dropout
    # ------------------------------------------------------------------
    df["is_dropout"] = (df["has_followup"] == "N").astype(int)

    log.info(
        "Responders computed. Overall responders: %d / %d with followup",
        (df["overall_responder"] == 1).sum(),
        (df["has_followup"] == "Y").sum(),
    )

    return df


def _re_flag_abs(improvement: pd.Series, mcid_abs: float | None) -> pd.Series:
    """Helper: absolute-criterion-only responder flag (avoids _responder_flag needing both args)."""
    return _responder_flag(improvement, mcid_abs=mcid_abs)
