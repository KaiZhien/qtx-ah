"""Migration 24 — create cohort_response_curves table."""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 24 ...")
    engine = _get_engine()
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS cohort_response_curves (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                grp_flag VARCHAR(50) NOT NULL,
                metric VARCHAR(50) NOT NULL,
                session_number SMALLINT NOT NULL,
                p25 NUMERIC(8,4),
                p50 NUMERIC(8,4),
                p75 NUMERIC(8,4),
                n SMALLINT NOT NULL,
                computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT uq_response_curves_grp_metric_session
                    UNIQUE (grp_flag, metric, session_number)
            )
        """))
        conn.commit()
        print("  cohort_response_curves table: OK")
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_response_curves_grp_flag "
            "ON cohort_response_curves (grp_flag)"
        ))
        conn.commit()
        print("  ix_response_curves_grp_flag: OK")
    print("Migration 24 complete.")


if __name__ == "__main__":
    main()
