"""Script 25 — compute and upsert cohort response curves.

For each grp_* phenotype flag and each outcome metric, computes p25/p50/p75
percentile bands per session number and upserts into cohort_response_curves.

Usage:
    DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
    PYTHONPATH=src:api .venv/bin/python3.14 scripts/25_compute_cohort_response_curves.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine

GRP_FLAGS = [
    "grp_joint_disease",
    "grp_spine_back",
    "grp_neurological",
    "grp_post_surgical",
    "grp_frailty_sarcopenia",
    "grp_balance_falls",
    "grp_metabolic",
    "grp_cardiovascular",
    "grp_oncology",
    "grp_autoimmune",
    "grp_softtissue_injury",
    "grp_generalised_pain",
    "grp_osteoporosis",
    "grp_wellness",
]

METRICS = [
    "composite_improvement",
    "tug_change_pct",
    "sst_change_pct",
    "sppb_change",
    "vas_change",
    "normal_gs_change_pct",
    "fast_gs_change_pct",
]

UPSERT_SQL = """
INSERT INTO cohort_response_curves
    (grp_flag, metric, session_number, p25, p50, p75, n, computed_at)
VALUES
    (:grp_flag, :metric, :session_number, :p25, :p50, :p75, :n, :computed_at)
ON CONFLICT ON CONSTRAINT uq_response_curves_grp_metric_session
DO UPDATE SET
    p25 = EXCLUDED.p25,
    p50 = EXCLUDED.p50,
    p75 = EXCLUDED.p75,
    n   = EXCLUDED.n,
    computed_at = EXCLUDED.computed_at
"""


def _build_query(grp_flag: str, metric: str) -> str:
    return f"""
        SELECT
            s.session_number,
            COUNT(*) AS n,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY s.{metric}) AS p25,
            PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY s.{metric}) AS p50,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY s.{metric}) AS p75
        FROM sessions s
        JOIN patients p ON p.id = s.patient_id
        WHERE p.{grp_flag} = true
          AND s.{metric} IS NOT NULL
          AND (s.ingested_from IS NULL OR s.ingested_from NOT ILIKE '%raise%')
        GROUP BY s.session_number
        HAVING COUNT(*) >= 5
        ORDER BY s.session_number
    """


def main() -> None:
    print("=== Compute Cohort Response Curves ===")
    engine = _get_engine()
    now = datetime.now(timezone.utc)
    total_rows = 0

    with engine.connect() as conn:
        for grp_flag in GRP_FLAGS:
            for metric in METRICS:
                rows = conn.execute(text(_build_query(grp_flag, metric))).fetchall()
                if not rows:
                    continue
                for row in rows:
                    m = row._mapping
                    conn.execute(text(UPSERT_SQL), {
                        "grp_flag": grp_flag,
                        "metric": metric,
                        "session_number": int(m["session_number"]),
                        "p25": float(m["p25"]) if m["p25"] is not None else None,
                        "p50": float(m["p50"]) if m["p50"] is not None else None,
                        "p75": float(m["p75"]) if m["p75"] is not None else None,
                        "n": int(m["n"]),
                        "computed_at": now,
                    })
                    total_rows += 1
        conn.commit()

    print(f"  Upserted {total_rows} curve points across {len(GRP_FLAGS)} groups × {len(METRICS)} metrics.")
    print("=== Done ===")


if __name__ == "__main__":
    main()
