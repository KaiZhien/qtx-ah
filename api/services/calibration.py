"""CalibrationService — monitors per-cohort prediction drift and triggers retraining."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic

from sklearn.metrics import roc_auc_score
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
    _cache_lock: threading.Lock = threading.Lock()
    _last_spawn_at: float | None = None
    _SPAWN_COOLDOWN_SECONDS: int = 3600

    _SQL_CLASSIFIER_AUC = text("""
        SELECT
            sp.responder_probability,
            s.overall_responder
        FROM (
            SELECT DISTINCT ON (session_id)
                   session_id, responder_probability
            FROM   session_predictions
            WHERE  responder_probability IS NOT NULL
            ORDER  BY session_id, predicted_at DESC
        ) sp
        JOIN sessions s ON s.id = sp.session_id
        WHERE  s.overall_responder IS NOT NULL
          AND  (s.ingested_from NOT ILIKE '%raise%' OR s.ingested_from IS NULL)
    """)

    _SQL_DROPOUT_AUC = text("""
        SELECT
            sp.dropout_probability,
            s.is_dropout
        FROM (
            SELECT DISTINCT ON (session_id)
                   session_id, dropout_probability
            FROM   session_predictions
            WHERE  dropout_probability IS NOT NULL
            ORDER  BY session_id, predicted_at DESC
        ) sp
        JOIN sessions s ON s.id = sp.session_id
        WHERE  s.is_dropout IS NOT NULL
          AND  (s.ingested_from NOT ILIKE '%raise%' OR s.ingested_from IS NULL)
    """)

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
        """Query session_predictions vs actuals, return per-cohort metrics."""
        min_n = int(os.environ.get("CALIBRATION_MIN_COHORT_N", "20"))

        now = monotonic()
        with cls._cache_lock:
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

        with cls._cache_lock:
            cls._cache = {"computed_at": now, "metrics": metrics}
        return metrics

    @classmethod
    def _compute_current_classifier_auc(cls, db) -> float | None:
        rows = db.execute(cls._SQL_CLASSIFIER_AUC).fetchall()
        if len(rows) < 20:
            return None
        y_score = [row.responder_probability for row in rows]
        y_true = [row.overall_responder for row in rows]
        try:
            return float(roc_auc_score(y_true, y_score))
        except Exception as exc:
            logger.warning("classifier roc_auc_score failed: %s", exc)
            return None


    @classmethod
    def _compute_current_dropout_auc(cls, db) -> float | None:
        rows = db.execute(cls._SQL_DROPOUT_AUC).fetchall()
        if len(rows) < 20:
            return None
        y_score = [row.dropout_probability for row in rows]
        y_true = [row.is_dropout for row in rows]
        try:
            return float(roc_auc_score(y_true, y_score))
        except Exception as exc:
            logger.warning("dropout roc_auc_score failed: %s", exc)
            return None

    @classmethod
    def check_and_trigger(cls, db, background_tasks) -> None:
        """Check per-cohort drift and queue retrain via BackgroundTasks if threshold exceeded.

        Returns immediately; any exception is caught and logged, never raises.
        """
        try:
            now = monotonic()
            if cls._last_spawn_at is not None and (now - cls._last_spawn_at) < cls._SPAWN_COOLDOWN_SECONDS:
                return

            metrics = cls.compute_cohort_metrics(db)
            state = cls._read_state()
            baseline: dict[str, float] = state.get("calibration_baseline", {})
            drift_threshold = float(os.environ.get("CALIBRATION_DRIFT_THRESHOLD", "0.30"))
            min_n = int(os.environ.get("CALIBRATION_MIN_COHORT_N", "20"))

            for cohort, m in metrics.items():
                if m["n"] < min_n:
                    continue
                if cohort not in baseline:
                    continue
                baseline_mae = baseline[cohort]
                if baseline_mae == 0:
                    continue
                drift = (m["mae"] - baseline_mae) / baseline_mae
                if drift >= drift_threshold:
                    logger.warning(
                        "Calibration drift detected for cohort %s: drift=%.3f > threshold=%.3f — queuing retrain",
                        cohort, drift, drift_threshold,
                    )
                    background_tasks.add_task(cls._spawn_retrain_subprocess)
                    cls._last_spawn_at = monotonic()
                    break  # only queue one retrain per call
        except Exception as exc:
            logger.exception("CalibrationService.check_and_trigger failed: %s", exc)

    @classmethod
    def _spawn_retrain_subprocess(cls) -> None:
        """Run the retrain script in-process after the HTTP response completes."""
        try:
            env = os.environ.copy()
            existing_pythonpath = os.environ.get("PYTHONPATH", "")
            env["PYTHONPATH"] = (
                str(_ROOT / "src") + os.pathsep + str(_ROOT / "api")
                + (os.pathsep + existing_pythonpath if existing_pythonpath else "")
            )
            result = subprocess.run(
                [sys.executable, str(_RETRAIN_SCRIPT)],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if result.returncode != 0:
                logger.error("Retrain script exited with non-zero code %d", result.returncode)
            else:
                logger.info("Calibration retrain script completed successfully")
        except Exception as exc:
            logger.error("Failed to spawn retrain subprocess: %s", exc)

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
            if baseline_mae is None or baseline_mae == 0:
                status = "NO_BASELINE"
                drift_pct = None
            else:
                drift_pct = (m["mae"] - baseline_mae) / baseline_mae * 100
                if drift_pct < 15:
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
                "drift_pct": round(drift_pct, 2) if drift_pct is not None else None,
                "status": status,
            })

        classifier_baseline = state.get("classifier_auc_baseline")
        dropout_baseline = state.get("dropout_auc_baseline")

        clf_rows = db.execute(cls._SQL_CLASSIFIER_AUC).fetchall()
        drop_rows = db.execute(cls._SQL_DROPOUT_AUC).fetchall()
        clf_n = len(clf_rows)
        drop_n = len(drop_rows)

        current_classifier_auc = cls._compute_current_classifier_auc(db)
        current_dropout_auc = cls._compute_current_dropout_auc(db)

        def _auc_row(model: str, bl: float | None, current: float | None, n: int) -> dict:
            if bl is None:
                return {
                    "model": model,
                    "baseline_auc": None,
                    "current_auc": round(current, 4) if current is not None else None,
                    "drift_pct": None,
                    "status": "NO_BASELINE",
                    "n": n,
                }
            if current is None:
                return {
                    "model": model,
                    "baseline_auc": round(bl, 4),
                    "current_auc": None,
                    "drift_pct": None,
                    "status": "INSUFFICIENT_DATA",
                    "n": n,
                }
            drift_pct = (current - bl) / bl * 100
            if drift_pct > -5.0:
                auc_status = "OK"
            elif drift_pct > -10.0:
                auc_status = "WARNING"
            else:
                auc_status = "ALERT"
            return {
                "model": model,
                "baseline_auc": round(bl, 4),
                "current_auc": round(current, 4),
                "drift_pct": round(drift_pct, 2),
                "status": auc_status,
                "n": n,
            }

        model_auc_drift = [
            _auc_row("classifier", classifier_baseline, current_classifier_auc, clf_n),
            _auc_row("dropout", dropout_baseline, current_dropout_auc, drop_n),
        ]

        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "drift_threshold": drift_threshold,
            "min_cohort_n": min_n,
            "total_matchable": sum(v["n"] for v in metrics.values()),
            "cohorts": cohort_rows,
            "model_auc_drift": model_auc_drift,
        }
