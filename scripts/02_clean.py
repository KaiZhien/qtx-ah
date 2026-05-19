"""Script 02 — Clean and normalise the raw snapshot.

Loads raw.parquet, applies normalise → plausibility checks → audit log,
and writes cleaned.parquet to data/processed/ (versioned snapshot).
Audit CSV is written to data/audit/clean_audit.csv.

Usage:
    PYTHONPATH=src python scripts/02_clean.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure src/ is on the path when run directly
_src = Path(__file__).resolve().parent.parent / "src"
if str(_src) not in sys.path:
    sys.path.insert(0, str(_src))

from qtx.clean.audit import AuditLog
from qtx.clean.normalise import normalise
from qtx.clean.plausibility import flag_plausibility
from qtx.io.load_supplement import load_supplement
from qtx.io.persist import load_parquet, save_parquet
from qtx.utils.logging import get_logger, setup_logging

setup_logging()
log = get_logger(__name__)


def main() -> None:
    # ------------------------------------------------------------------
    # 1. Load raw snapshot
    # ------------------------------------------------------------------
    log.info("Loading raw.parquet …")
    raw_df = load_parquet("raw")
    log.info("Raw: %d rows × %d columns", *raw_df.shape)

    audit = AuditLog()

    # ------------------------------------------------------------------
    # 2. Normalise
    # ------------------------------------------------------------------
    log.info("Running normalise() …")
    clean_df = normalise(raw_df, audit=audit)
    log.info("After normalise: %d rows × %d columns", *clean_df.shape)

    # ------------------------------------------------------------------
    # 3. Plausibility flags
    # ------------------------------------------------------------------
    log.info("Running flag_plausibility() …")
    clean_df = flag_plausibility(clean_df, audit=audit)
    log.info("After plausibility: %d rows × %d columns", *clean_df.shape)

    # ------------------------------------------------------------------
    # 4. Merge tags_clean from hand-cleaned supplement
    # ------------------------------------------------------------------
    log.info("Merging tags_clean from supplement …")
    supp = load_supplement()
    if not supp.empty:
        clean_df = clean_df.merge(supp[["sn", "tags_clean"]], on="sn", how="left")
        n_filled = clean_df["tags_clean"].notna().sum()
        log.info("tags_clean merged: %d rows have a value", n_filled)
    else:
        clean_df["tags_clean"] = None

    # ------------------------------------------------------------------
    # 5. Save cleaned parquet (versioned)
    # ------------------------------------------------------------------
    out_path = save_parquet(clean_df, "cleaned", versioned=True)
    log.info("Saved cleaned data → %s", out_path)

    # ------------------------------------------------------------------
    # 6. Save audit log
    # ------------------------------------------------------------------
    audit_path = audit.save()
    log.info("Audit log → %s  (%d rows)", audit_path, len(audit))

    # ------------------------------------------------------------------
    # 7. Print summary
    # ------------------------------------------------------------------
    print()
    print("=" * 60)
    print("CLEAN PIPELINE SUMMARY")
    print("=" * 60)
    print(f"  Rows in cleaned output : {len(clean_df):,}")
    print(f"  Audit rows written     : {len(audit):,}")
    print()

    # Flag value counts
    flag_cols = [c for c in clean_df.columns if c.endswith("_flag") and c != "name_flag"]
    if flag_cols:
        import pandas as pd

        all_flags = pd.concat(
            [clean_df[c].dropna() for c in flag_cols], ignore_index=True
        )
        flag_counts = all_flags.value_counts()
        print("  Plausibility flag counts:")
        for flag_val, cnt in flag_counts.items():
            print(f"    {flag_val:6s}: {cnt:,}")
        print()

    # Legacy record count
    if "record_type" in clean_df.columns:
        legacy_count = (clean_df["record_type"] == "Legacy").sum()
        print(f"  Legacy records ('OLD' prefix): {legacy_count:,}")

    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
