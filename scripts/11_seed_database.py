"""Script 11 — Seed PostgreSQL from dashboard_data.parquet.

Reads the fully-processed parquet file and upserts all rows into the
patients, sessions, and patient_conditions tables. Safe to re-run.

Usage
-----
    DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/db \\
    PYTHONPATH=src .venv/bin/python scripts/11_seed_database.py
"""
from __future__ import annotations

import sys
from pathlib import Path

# Add api/ to path so bare imports (from db import ...) work
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import pandas as pd
from db import init_db, get_db
from services.ingest import IngestPipeline


PARQUET_PATH = Path(__file__).resolve().parent.parent / "data" / "processed" / "dashboard_data.parquet"


def main() -> None:
    if not PARQUET_PATH.exists():
        print(f"ERROR: {PARQUET_PATH} not found.")
        print("Run scripts 01–07 first to generate dashboard_data.parquet.")
        sys.exit(1)

    print(f"Loading {PARQUET_PATH} ...")
    df = pd.read_parquet(PARQUET_PATH)
    print(f"  Loaded {len(df):,} rows, {len(df.columns)} columns")

    print("Initialising database schema ...")
    init_db()

    print("Running ingest pipeline ...")
    db = next(get_db())
    try:
        pipeline = IngestPipeline(db, source_filename=PARQUET_PATH.name)
        summary = pipeline.upsert(df)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print()
    print("=" * 50)
    print("  Seed complete")
    print("=" * 50)
    print(f"  Inserted : {summary.inserted:,}")
    print(f"  Updated  : {summary.updated:,}")
    print(f"  Skipped  : {summary.skipped:,}")
    print(f"  Errors   : {len(summary.errors):,}")
    print()

    if summary.errors:
        print("Errors:")
        for err in summary.errors:
            print(f"  row {err.row_index} sn={err.sn!r}: {err.reason}")
        sys.exit(1)


if __name__ == "__main__":
    main()
