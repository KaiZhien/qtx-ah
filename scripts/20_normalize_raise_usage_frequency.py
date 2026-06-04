"""Backfill usage_frequency for RAISE sessions.

Sets usage_frequency = 'Once (1x/week, one leg)' on all RAISE sessions
where usage_frequency IS NULL. RAISE is a once-weekly programme.

Safe to re-run — the AND usage_frequency IS NULL guard makes it idempotent.
Expected: 162 rows updated on first run, 0 on subsequent runs.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running normalization: RAISE usage_frequency ...")
    engine = _get_engine()

    with engine.connect() as conn:
        result = conn.execute(text("""
            UPDATE sessions
            SET usage_frequency = 'Once (1x/week, one leg)'
            WHERE ingested_from ILIKE '%raise%' AND usage_frequency IS NULL
        """))
        conn.commit()
        rows_updated = result.rowcount
        print(f"  Rows updated: {rows_updated}")

    print("Normalization complete.")


if __name__ == "__main__":
    main()
