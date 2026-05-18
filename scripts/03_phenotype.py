"""Script 03 — Assign phenotype groups, regions, and binary flags.

Loads cleaned.parquet, applies classify.py rules driven by
config/phenotypes.yaml, validates output with validate.py, and
writes phenotyped.parquet to data/processed/ (versioned snapshot included).

Usage:
    PYTHONPATH=src python scripts/03_phenotype.py [--sample N]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Ensure src/ is on the path when run as a script
_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from qtx.io.persist import load_parquet, save_parquet
from qtx.phenotype.classify import classify
from qtx.phenotype.validate import coverage_report, unmatched_fragments
from qtx.utils.config import get_path
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Phenotype classification pipeline")
    parser.add_argument(
        "--sample",
        type=int,
        default=0,
        metavar="N",
        help="Print N random (text_blob, primary_indication, cohort) examples",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    # ------------------------------------------------------------------
    # 1. Load cleaned.parquet
    # ------------------------------------------------------------------
    log.info("Loading cleaned.parquet ...")
    df = load_parquet("cleaned")
    log.info("Loaded %d rows, %d columns", len(df), df.shape[1])

    # ------------------------------------------------------------------
    # 2. Classify → save phenotyped.parquet (versioned)
    # ------------------------------------------------------------------
    log.info("Running phenotype classification ...")
    phenotyped = classify(df)
    log.info("Classification complete. New columns: %d total columns", phenotyped.shape[1])

    save_parquet(phenotyped, "phenotyped", versioned=True)
    log.info("phenotyped.parquet saved.")

    # ------------------------------------------------------------------
    # 3. Coverage report → print
    # ------------------------------------------------------------------
    log.info("Generating coverage report ...")
    cov = coverage_report(phenotyped)
    print("\n=== Phenotype Coverage Report ===")
    print(cov.to_string(index=False))

    # ------------------------------------------------------------------
    # 4. Unmatched fragments → save reports/unmatched_tags.csv
    # ------------------------------------------------------------------
    reports_dir = get_path("reports")
    unmatched_path = reports_dir / "unmatched_tags.csv"
    log.info("Finding unmatched fragments ...")
    unmatched = unmatched_fragments(phenotyped, output_path=unmatched_path)
    log.info("Unmatched fragments: %d unique tokens", len(unmatched))

    # ------------------------------------------------------------------
    # 5. Summary
    # ------------------------------------------------------------------
    n_total = len(phenotyped)
    n_unclassified = (phenotyped["primary_indication"] == "Unclassified").sum()
    n_classified = n_total - n_unclassified

    print("\n=== Classification Summary ===")
    print(f"Total patients:  {n_total}")
    print(f"Classified:      {n_classified}  ({100*n_classified/n_total:.1f}%)")
    print(f"Unclassified:    {n_unclassified}  ({100*n_unclassified/n_total:.1f}%)")

    print("\n=== Cohort Distribution ===")
    cohort_counts = (
        phenotyped["cohort"]
        .value_counts()
        .rename_axis("cohort")
        .reset_index(name="n_patients")
    )
    cohort_counts["pct"] = (cohort_counts["n_patients"] / n_total * 100).round(1)
    print(cohort_counts.to_string(index=False))

    print("\n=== Primary Indication Distribution ===")
    ind_counts = (
        phenotyped["primary_indication"]
        .value_counts()
        .rename_axis("primary_indication")
        .reset_index(name="n_patients")
    )
    ind_counts["pct"] = (ind_counts["n_patients"] / n_total * 100).round(1)
    print(ind_counts.to_string(index=False))

    # ------------------------------------------------------------------
    # 6. Optional sample
    # ------------------------------------------------------------------
    if args.sample > 0:
        # Reconstruct text blob for display purposes
        import re, pandas as pd

        _ws = re.compile(r"\s+")

        def _blob(row: pd.Series) -> str:
            parts = []
            for col in ("tags", "pain_location"):
                val = row.get(col, None)
                if val is None:
                    continue
                try:
                    if pd.isna(val):
                        continue
                except TypeError:
                    pass
                parts.append(str(val).strip())
            return _ws.sub(" ", " ".join(parts)).strip()

        sample_df = phenotyped.sample(min(args.sample, n_total), random_state=42)
        print(f"\n=== {args.sample} Random Examples ===")
        for _, row in sample_df.iterrows():
            print(
                f"  text: {_blob(row)!r}\n"
                f"  → primary_indication={row['primary_indication']!r},"
                f" cohort={row['cohort']!r}\n"
            )


if __name__ == "__main__":
    main()
