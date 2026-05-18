"""Script 07 — Build feature matrix and export slim dashboard-ready Parquet files.

1. Calls build_feature_matrix() which saves featured.parquet
2. Saves a slim dashboard_data.parquet with only the columns needed for the dashboard
3. Prints summary: total rows, feature columns, % with followup

Usage:
    PYTHONPATH=src python scripts/07_export_dashboard_data.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure src/ is on the path when run directly
_src = Path(__file__).resolve().parents[1] / "src"
if str(_src) not in sys.path:
    sys.path.insert(0, str(_src))

from qtx.features.build import build_feature_matrix
from qtx.io.persist import save_parquet
from qtx.utils.logging import get_logger, setup_logging

setup_logging()
log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Dashboard column definitions
# ---------------------------------------------------------------------------

_IDENTITY_COLS = [
    "sn",
    "name",
    "cohort",
    "primary_indication",
    "age",
    "age_band",
    "gender",
    "record_type",
    "usage_frequency",
]

_PRE_COLS = [
    "pre_vas",
    "pre_tug_s",
    "pre_5xsst_s",
    "pre_normal_gs_ms",
    "pre_fast_gs_ms",
    "baseline_sppb",
]

_POST_COLS = [
    "post_vas",
    "post_tug_s",
    "post_5xsst_s",
    "post_normal_gs_ms",
    "post_fast_gs_ms",
    "post_sppb",
]

_OUTCOME_COLS = [
    "composite_improvement",
    "overall_responder",
    "breadth_of_response",
    "is_dropout",
    "has_followup",
]


def _select_dashboard_columns(df):
    """Select only the columns needed for the dashboard from the full feature matrix."""
    # Dynamic column groups
    has_flag_cols = [c for c in df.columns if c.startswith("has_")]
    grp_cols = [c for c in df.columns if c.startswith("grp_")]
    rgn_cols = [c for c in df.columns if c.startswith("rgn_")]

    desired = (
        _IDENTITY_COLS
        + _PRE_COLS
        + _POST_COLS
        + _OUTCOME_COLS
        + has_flag_cols
        + grp_cols
        + rgn_cols
    )

    # Deduplicate while preserving order
    seen: set[str] = set()
    ordered: list[str] = []
    for col in desired:
        if col not in seen:
            seen.add(col)
            ordered.append(col)

    # Only keep columns that actually exist
    available = [c for c in ordered if c in df.columns]
    missing = [c for c in ordered if c not in df.columns]
    if missing:
        log.warning("Dashboard columns not found in feature matrix (skipped): %s", missing)

    return df[available]


def main() -> None:
    log.info("=" * 60)
    log.info("Script 07: Build feature matrix + export dashboard data")
    log.info("=" * 60)

    # ------------------------------------------------------------------
    # Step 1: Build the full feature matrix (saves featured.parquet)
    # ------------------------------------------------------------------
    log.info("Building feature matrix...")
    featured_df = build_feature_matrix()

    # ------------------------------------------------------------------
    # Step 2: Select dashboard columns and save dashboard_data.parquet
    # ------------------------------------------------------------------
    log.info("Selecting dashboard columns...")
    dashboard_df = _select_dashboard_columns(featured_df)

    save_parquet(dashboard_df, "dashboard_data", versioned=True)
    log.info("dashboard_data.parquet saved: %d rows, %d columns", *dashboard_df.shape)

    # ------------------------------------------------------------------
    # Step 3: Print summary
    # ------------------------------------------------------------------
    total_rows = len(featured_df)
    feature_cols = dashboard_df.shape[1]
    n_followup = (featured_df["has_followup"] == "Y").sum()
    pct_followup = 100.0 * n_followup / total_rows if total_rows > 0 else 0.0

    print()
    print("=" * 60)
    print("  Dashboard Export Summary")
    print("=" * 60)
    print(f"  Total rows          : {total_rows:,}")
    print(f"  Dashboard columns   : {feature_cols}")
    print(f"  With followup (Y)   : {n_followup:,} / {total_rows:,}  ({pct_followup:.1f}%)")
    print(f"  Dropout (is_dropout): {(featured_df['is_dropout'] == 1).sum():,}")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
