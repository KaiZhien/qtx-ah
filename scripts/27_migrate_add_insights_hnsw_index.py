"""Migration 27 — HNSW ANN index on patient_insights.embedding.

Replaces the IVFFlat index from migration 13 with an HNSW index using
vector_cosine_ops — matching the `<=>` (cosine distance) retrieval in
api/services/insight.py::_retrieve_relevant. HNSW needs pgvector >= 0.5.0
on the server; the CREATE INDEX fails with a clear Postgres error otherwise.
Idempotent — safe to re-run.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 27 ...")

    engine = _get_engine()

    with engine.connect() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS patient_insights_embedding_hnsw_idx "
            "ON patient_insights USING hnsw (embedding vector_cosine_ops)"
        ))
        conn.commit()
        print("  patient_insights_embedding_hnsw_idx (hnsw, cosine): OK")

        # Superseded IVFFlat index from migration 13 — drop so the planner
        # always uses HNSW for <=> retrieval.
        conn.execute(text("DROP INDEX IF EXISTS patient_insights_embedding_idx"))
        conn.commit()
        print("  old ivfflat patient_insights_embedding_idx dropped: OK")

    print("Migration 27 complete.")


if __name__ == "__main__":
    main()
