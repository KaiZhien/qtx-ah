"""Migration 13 — add embedding column and IVFFlat index to patient_insights."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 13 ...")

    engine = _get_engine()

    with engine.connect() as conn:
        conn.execute(text(
            "ALTER TABLE patient_insights ADD COLUMN IF NOT EXISTS embedding vector(512)"
        ))
        conn.commit()
        print("  patient_insights.embedding column: OK")

        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS patient_insights_embedding_idx "
            "ON patient_insights USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)"
        ))
        conn.commit()
        print("  patient_insights_embedding_idx: OK")

    print("Migration 13 complete.")


if __name__ == "__main__":
    main()
