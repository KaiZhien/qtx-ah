"""Script 04 — Compute outcome change scores, MCID flags, and composite score.

Loads phenotyped.parquet, runs change_scores → composite → responders,
and writes outcomes.parquet to data/processed/ (versioned snapshot included).

Usage:
    PYTHONPATH=src python scripts/04_outcomes.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure src/ is on the path when run as a script
_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

import pandas as pd

from qtx.io.persist import load_parquet, save_parquet
from qtx.outcomes.change_scores import compute_change_scores
from qtx.outcomes.composite import compute_composite
from qtx.outcomes.responders import compute_responders
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def main() -> None:
    # ------------------------------------------------------------------
    # 1. Load phenotyped.parquet
    # ------------------------------------------------------------------
    log.info("Loading phenotyped.parquet ...")
    df = load_parquet("phenotyped")
    log.info("Loaded %d rows, %d columns", len(df), df.shape[1])

    # ------------------------------------------------------------------
    # 2. Compute change scores
    # ------------------------------------------------------------------
    log.info("Computing change scores ...")
    df = compute_change_scores(df)

    # ------------------------------------------------------------------
    # 3. Compute composite
    # ------------------------------------------------------------------
    log.info("Computing composite improvement score ...")
    df = compute_composite(df)

    # ------------------------------------------------------------------
    # 4. Compute responders
    # ------------------------------------------------------------------
    log.info("Computing responder flags ...")
    df = compute_responders(df)

    # ------------------------------------------------------------------
    # 5. Save outcomes.parquet (versioned)
    # ------------------------------------------------------------------
    save_parquet(df, "outcomes", versioned=True)
    log.info("outcomes.parquet saved.")

    # ------------------------------------------------------------------
    # 6. Summary
    # ------------------------------------------------------------------
    n_total = len(df)
    n_followup = (df["has_followup"] == "Y").sum()
    n_overall_responders = (df["overall_responder"] == 1).sum()
    mean_composite = df["composite_improvement"].mean()

    print("\n=== Outcomes Summary ===")
    print(f"Total patients:          {n_total}")
    print(f"With follow-up:          {n_followup}  ({100 * n_followup / n_total:.1f}%)")
    print(f"Overall responders:      {n_overall_responders}  ({100 * n_overall_responders / n_followup:.1f}% of those with followup)")
    print(f"Mean composite improv.:  {mean_composite:.4f}")

    print("\n=== Breadth of Response Distribution ===")
    breadth_dist = (
        df["breadth_of_response"]
        .value_counts(dropna=False)
        .sort_index()
        .rename_axis("breadth")
        .reset_index(name="n")
    )
    breadth_dist["pct"] = (breadth_dist["n"] / n_total * 100).round(1)
    print(breadth_dist.to_string(index=False))

    # ------------------------------------------------------------------
    # 7. Direction-correction verification (5 example rows)
    # ------------------------------------------------------------------
    print("\n=== Direction Correction Verification ===")
    print("TUG (lower post = positive improvement):")
    tug_mask = df["tug_improvement"].notna()
    tug_ex = df.loc[tug_mask, ["sn", "pre_tug_s", "post_tug_s", "tug_improvement"]].head(5)
    print(tug_ex.to_string(index=False))

    print("\nVAS (lower post = positive improvement):")
    vas_mask = df["vas_improvement"].notna()
    vas_ex = df.loc[vas_mask, ["sn", "pre_vas", "post_vas", "vas_improvement"]].head(5)
    print(vas_ex.to_string(index=False))

    print("\nNormal GS (higher post = positive improvement):")
    gs_mask = df["normal_gs_improvement"].notna()
    gs_ex = df.loc[gs_mask, ["sn", "pre_normal_gs_ms", "post_normal_gs_ms", "normal_gs_improvement"]].head(5)
    print(gs_ex.to_string(index=False))

    # ------------------------------------------------------------------
    # 8. Responder counts per test
    # ------------------------------------------------------------------
    print("\n=== Per-test Responder Counts ===")
    responder_cols = [
        "vas_responder", "tug_responder", "sst_responder",
        "normal_gs_responder", "fast_gs_responder", "sppb_responder",
    ]
    for col in responder_cols:
        if col not in df.columns:
            continue
        n_yes = (df[col] == 1).sum()
        n_no = (df[col] == 0).sum()
        n_na = df[col].isna().sum()
        print(f"  {col:<24s}  yes={n_yes:4d}  no={n_no:4d}  NaN={n_na:4d}")

    print(f"\nNew columns added: {df.shape[1] - load_parquet('phenotyped').shape[1]}")


if __name__ == "__main__":
    main()
