"""CalibrationService — monitors per-cohort prediction drift and triggers retraining."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic

from sqlalchemy import text

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parents[2]
_RETRAIN_SCRIPT = _ROOT / "scripts" / "18_scheduled_retrain.py"
_STATE_PATH = _ROOT / "retrain_state.json"
_CACHE_TTL_SECONDS = 3600

_SQL = text("""
SELECT
    p.cohort,
    COUNT(*) as n,
    AVG(ABS(sp.predicted_composite_improvement - s.composite_improvement)) as mae,
    AVG(sp.predicted_composite_improvement - s.composite_improvement) as bias
FROM (
    SELECT DISTINCT ON (session_id)
           session_id, patient_id, predicted_composite_improvement
    FROM   session_predictions
    WHERE  predicted_composite_improvement IS NOT NULL
    ORDER  BY session_id, predicted_at DESC
) sp
JOIN sessions s ON s.id = sp.session_id
JOIN patients p ON p.id = sp.patient_id
WHERE  s.composite_improvement IS NOT NULL
  AND  (s.ingested_from NOT ILIKE '%raise%' OR s.ingested_from IS NULL)
GROUP BY p.cohort
""")


class CalibrationService:
    _cache: dict = {"computed_at": None, "metrics": {}}

    @classmethod
    def _read_state(cls) -> dict:
        if not _STATE_PATH.exists():
            return {}
        try:
            return json.loads(_STATE_PATH.read_text())
        except Exception:
            return {}

    @classmethod
    def compute_cohort_metrics(cls, db) -> dict[str, dict]:
        """Query session_predictions vs actuals, return per-cohort metrics.

        Returns {cohort: {"mae": float, "n": int, "bias": float}} for cohorts
        with n >= CALIBRATION_MIN_COHORT_N. Result is cached for _CACHE_TTL_SECONDS.
        """
        min_n = int(os.environ.get("CALIBRATION_MIN_COHORT_N", "20"))

        now = monotonic()
        computed_at = cls._cache["computed_at"]
        if computed_at is not None and (now - computed_at) < _CACHE_TTL_SECONDS:
            return cls._cache["metrics"]

        rows = db.execute(_SQL).fetchall()
        metrics: dict[str, dict] = {}
        for row in rows:
            cohort, n, mae, bias = row.cohort, row.n, row.mae, row.bias
            if n is None or n < min_n:
                continue
            metrics[cohort] = {
                "mae": float(mae) if mae is not None else 0.0,
                "n": int(n),
                "bias": float(bias) if bias is not None else 0.0,
            }

        cls._cache["computed_at"] = now
        cls._cache["metrics"] = metrics
        return metrics

    @classmethod
    def check_and_trigger(cls, db) -> None:
        """Check per-cohort drift and spawn retrain subprocess if threshold exceeded.

        Non-blocking — any exception is caught and logged, never raises.
        """
        try:
            metrics = cls.compute_cohort_metrics(db)
            state = cls._read_state()
            baseline: dict[str, float] = state.get("calibration_baseline", {})
            drift_threshold = float(os.environ.get("CALIBRATION_DRIFT_THRESHOLD", "0.30"))
            min_n = int(os.environ.get("CALIBRATION_MIN_COHORT_N", "20"))

            spawned = False
            for cohort, m in metrics.items():
                if m["n"] < min_n:
                    continue
                if cohort not in baseline:
                    continue
                baseline_mae = baseline[cohort]
                if baseline_mae == 0:
                    continue
                drift = (m["mae"] - baseline_mae) / baseline_mae
                if drift > drift_threshold:
                    logger.warning(
                        "Calibration drift detected for cohort %s: drift=%.3f > threshold=%.3f — spawning retrain",
                        cohort, drift, drift_threshold,
                    )
                    if not spawned:
                        try:
                            env = os.environ.copy()
                            env["PYTHONPATH"] = (
                                str(_ROOT / "src") + os.pathsep + str(_ROOT / "api")
                            )
                            subprocess.Popen(
                                [sys.executable, str(_RETRAIN_SCRIPT)],
                                env=env,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                            )
                            spawned = True
                        except Exception as exc:
                            logger.warning("Failed to spawn retrain subprocess: %s", exc)
        except Exception as exc:
            logger.warning("CalibrationService.check_and_trigger failed: %s", exc)

    @classmethod
    def get_report(cls, db) -> dict:
        """Return a calibration drift report for all tracked cohorts."""
        metrics = cls.compute_cohort_metrics(db)
        state = cls._read_state()
        baseline: dict[str, float] = state.get("calibration_baseline", {})
        drift_threshold = float(os.environ.get("CALIBRATION_DRIFT_THRESHOLD", "0.30"))
        min_n = int(os.environ.get("CALIBRATION_MIN_COHORT_N", "20"))

        cohort_rows = []
        for cohort, m in sorted(metrics.items(), key=lambda x: -x[1]["mae"]):
            baseline_mae = baseline.get(cohort)
            if baseline_mae is None:
                status = "NO_BASELINE"
                drift_pct = None
            else:
                drift_pct = (m["mae"] - baseline_mae) / baseline_mae * 100 if baseline_mae else None
                if drift_pct is None:
                    status = "NO_BASELINE"
                elif drift_pct < 15:
                    status = "OK"
                elif drift_pct < 30:
                    status = "WARNING"
                else:
                    status = "ALERT"

            cohort_rows.append({
                "cohort": cohort,
                "n": m["n"],
                "current_mae": round(m["mae"], 4),
                "baseline_mae": round(baseline_mae, 4) if cohort in baseline else None,
                "drift_pct": round(drift_pct, 2) if baseline_mae else None,
                "status": status,
            })

        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "drift_threshold": drift_threshold,
            "min_cohort_n": min_n,
            "total_matchable": sum(v["n"] for v in metrics.values()),
            "cohorts": cohort_rows,
        }
