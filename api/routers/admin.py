"""Admin endpoints — model hot-reload, model status, retrain trigger.
Protected by QTX_ADMIN_KEY (separate from QTX_API_KEY)."""
from __future__ import annotations

import datetime
import hmac
import json
import os
import subprocess
import sys
from datetime import timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request

import deps
from services.prediction import _shap_explainer_cache
from services.rate_limit import rate_limit

router = APIRouter()

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_RETRAIN_STATE_PATH: Path = _PROJECT_ROOT / "retrain_state.json"
_MODELS_DIR: Path = _PROJECT_ROOT / "models"


def require_admin_key(request: Request) -> None:
    """Verify X-Admin-Key header matches QTX_ADMIN_KEY env var."""
    expected = os.environ.get("QTX_ADMIN_KEY", "")
    if not expected:
        raise HTTPException(status_code=503, detail="QTX_ADMIN_KEY is not configured")
    provided = request.headers.get("X-Admin-Key", "")
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing admin key")


@router.post("/admin/reload-models", dependencies=[Depends(require_admin_key)])
def reload_models() -> dict:
    """Reload all ML model files from disk into the running process."""
    deps.load_all()
    _shap_explainer_cache.clear()
    loaded = [
        "classifier_xgb.joblib", "regression_xgb.joblib",
        "dropout_xgb.joblib", "dosage_frequency.joblib",
    ]
    return {"status": "ok", "models_loaded": loaded}


@router.get("/admin/model_status", dependencies=[Depends(require_admin_key)])
def model_status() -> dict:
    """Return model file metadata, retrain state, and DB readiness."""
    models: dict = {}
    for search_dir in [_PROJECT_ROOT, _MODELS_DIR]:
        if search_dir.exists():
            for f in sorted(search_dir.glob("*.joblib")):
                stat = f.stat()
                models[f.name] = {
                    "size_mb": round(stat.st_size / (1024 * 1024), 3),
                    "modified_at": datetime.datetime.fromtimestamp(
                        stat.st_mtime, tz=timezone.utc
                    ).isoformat(),
                }

    retrain_state: dict = {}
    if _RETRAIN_STATE_PATH.exists():
        try:
            retrain_state = json.loads(_RETRAIN_STATE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            retrain_state = {"error": "could not parse retrain_state.json"}

    try:
        db_ready = deps._db_ready
    except Exception:
        db_ready = False

    return {"models": models, "retrain_state": retrain_state, "db_ready": db_ready}


def _run_retrain() -> None:
    """Background task: launch the scheduled retrain script."""
    script = _PROJECT_ROOT / "scripts" / "18_scheduled_retrain.py"
    if not script.exists():
        return
    subprocess.Popen(
        [sys.executable, str(script)],
        cwd=str(_PROJECT_ROOT),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


@router.post(
    "/admin/trigger_retrain",
    dependencies=[Depends(require_admin_key), Depends(rate_limit("trigger_retrain", default_limit=5))],
)
def trigger_retrain(background_tasks: BackgroundTasks) -> dict:
    """Schedule a background retrain job."""
    background_tasks.add_task(_run_retrain)
    return {"status": "retrain_scheduled"}
