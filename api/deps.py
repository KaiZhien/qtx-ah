"""Global singletons loaded once at startup."""
from __future__ import annotations

import joblib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # quantumtx-ah/
MODELS_DIR = ROOT / "models"

models: dict = {}
_db_ready: bool = False  # True once DB is reachable and has patient rows


def load_all() -> None:
    """Load ML models and verify DB connectivity at startup.

    DB failures are logged as warnings (not exceptions) so the wearable
    and prediction endpoints continue to serve even if the clinical DB is
    temporarily unavailable. Patient-listing endpoints check _db_ready
    and return 503 when False.
    """
    global models, _db_ready

    # --- DB health check (non-fatal) ---
    try:
        from db import init_db, get_db
        from models.clinical import Patient
        from sqlalchemy import func, select

        init_db()
        db = next(get_db())
        try:
            count = db.execute(select(func.count()).select_from(Patient)).scalar()
        finally:
            db.close()

        if count == 0:
            print(
                "[deps] WARNING: patients table is empty — "
                "run: DATABASE_URL=... PYTHONPATH=src .venv/bin/python scripts/11_seed_database.py"
            )
            _db_ready = False
        else:
            print(f"[deps] DB ready — {count:,} patients loaded")
            _db_ready = True

    except Exception as exc:
        print(f"[deps] WARNING: DB unavailable at startup: {exc}")
        _db_ready = False

    # --- ML models (fatal if missing) ---
    missing: list[str] = []
    model_files = {
        "classifier":        MODELS_DIR / "classifier_xgb.joblib",
        "regression":        MODELS_DIR / "regression_xgb.joblib",
        "dropout":           MODELS_DIR / "dropout_xgb.joblib",
        "dosage":            MODELS_DIR / "dosage_frequency.joblib",
        "fall_risk":         MODELS_DIR / "fall_risk_xgb.joblib",
        "fall_risk_medians": MODELS_DIR / "fall_risk_medians.joblib",
    }
    for name, path in model_files.items():
        try:
            models[name] = joblib.load(path)
        except FileNotFoundError:
            missing.append(str(path))
            print(f"[deps] MISSING model file: {path} — run the training script first")

    if missing:
        raise RuntimeError(
            f"Startup failed — {len(missing)} model file(s) not found:\n"
            + "\n".join(f"  {p}" for p in missing)
        )
