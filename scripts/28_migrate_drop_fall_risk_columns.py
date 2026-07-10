"""Migration 28 — drop dead columns session_predictions.fall_risk_score / fall_risk_label.

These columns were created by migration 19 but are never written by any code
path (PredictionService populates the other prediction columns only). The
ORM columns were removed in the same change. Idempotent — safe to re-run.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 28 ...")

    engine = _get_engine()

    with engine.connect() as conn:
        conn.execute(text(
            "ALTER TABLE session_predictions DROP COLUMN IF EXISTS fall_risk_score"
        ))
        conn.commit()
        print("  session_predictions.fall_risk_score dropped: OK")

        conn.execute(text(
            "ALTER TABLE session_predictions DROP COLUMN IF EXISTS fall_risk_label"
        ))
        conn.commit()
        print("  session_predictions.fall_risk_label dropped: OK")

    print("Migration 28 complete.")


if __name__ == "__main__":
    main()
