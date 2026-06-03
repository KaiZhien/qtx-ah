# api/routers/admin.py
"""Admin endpoints — model hot-reload. Uses the same QTX_API_KEY as all other routes."""
from __future__ import annotations

from fastapi import APIRouter

import deps

router = APIRouter()


@router.post("/admin/reload-models")
def reload_models() -> dict:
    """Reload all ML model files from disk into the running process.

    Safe to call while the API is serving requests — deps.models is a mutable
    dict and the swap is atomic at the Python interpreter level.
    """
    deps.load_all()
    loaded = [
        "classifier_xgb.joblib", "regression_xgb.joblib", "dropout_xgb.joblib",
        "dosage_frequency.joblib", "fall_risk_xgb.joblib", "fall_risk_medians.joblib",
    ]
    return {"status": "ok", "models_loaded": loaded}
