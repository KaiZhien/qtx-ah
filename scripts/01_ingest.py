"""Script 01 — Ingest raw Excel into a unified raw Parquet snapshot.

Reads the source workbook via src/qtx/io/load_raw.py and persists the
raw snapshot to data/processed/raw.parquet (plus a dated copy in
data/processed/snapshots/) using src/qtx/io/persist.py.

Usage
-----
    PYTHONPATH=src python scripts/01_ingest.py
"""

from __future__ import annotations

from qtx.io.load_raw import load_raw
from qtx.io.persist import save_parquet
from qtx.utils.logging import setup_logging

setup_logging()


def main() -> None:
    # 1. Load raw data from Excel
    df = load_raw()

    # 2. Persist as Parquet (primary + versioned snapshot)
    out_path = save_parquet(df, name="raw", versioned=True)

    # 3. Print summary
    print()
    print("=" * 60)
    print("  Ingest complete")
    print("=" * 60)
    print(f"  Rows loaded   : {len(df):,}")
    print(f"  Columns       : {len(df.columns)}")
    print(f"  Output path   : {out_path}")
    print()

    # Show first few S/N values
    sn_col = "sn" if "sn" in df.columns else df.columns[0]
    print(f"  First 5 {sn_col!r} values:")
    for val in df[sn_col].head(5):
        print(f"    {val}")
    print()


if __name__ == "__main__":
    main()
