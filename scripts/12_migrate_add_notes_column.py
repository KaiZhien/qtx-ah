"""Migration 12 — add notes column to sessions and create patient_trends table.

Safe to run on an existing database. Run once after deploying Sub-project 2.

Usage
-----
    DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/db \\
    PYTHONPATH=src .venv/bin/python scripts/12_migrate_add_notes_column.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import init_db, _get_engine


def main() -> None:
    print("Running migration 12 ...")

    engine = _get_engine()

    with engine.connect() as conn:
        # Add notes column if it doesn't already exist (idempotent)
        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notes TEXT"
        ))
        conn.commit()
        print("  sessions.notes column: OK")

    # create_all creates patient_trends table if it doesn't exist
    init_db()
    print("  patient_trends table: OK")
    print("Migration 12 complete.")


if __name__ == "__main__":
    main()
