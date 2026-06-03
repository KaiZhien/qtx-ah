"""Migration 19 — add session_predictions table."""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 19 ...")
    engine = _get_engine()
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS session_predictions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                fall_risk_score NUMERIC(5,4),
                fall_risk_label BOOLEAN,
                predicted_composite_improvement NUMERIC(7,4),
                responder_probability NUMERIC(5,4),
                dropout_probability NUMERIC(5,4),
                dosage_recommendation VARCHAR(100),
                model_versions JSONB,
                predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.commit()
        print("  session_predictions table: OK")
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS session_predictions_patient_id_idx "
            "ON session_predictions (patient_id)"
        ))
        conn.commit()
        print("  session_predictions_patient_id_idx: OK")
    print("Migration 19 complete.")


if __name__ == "__main__":
    main()
