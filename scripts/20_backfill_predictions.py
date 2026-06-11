"""Script 20 — Backfill session_predictions for all existing sessions.

Runs PredictionService over every session that doesn't yet have a prediction row.
Safe to re-run — skips sessions that already have a row.

Usage:
    PYTHONPATH=src:api python scripts/20_backfill_predictions.py
"""
from __future__ import annotations
import os

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "api"))

import joblib
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from models.clinical import Patient, Session as ClinicalSession, SessionPrediction
from services.prediction import PredictionService

DB_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah")
MODELS_DIR = ROOT / "models"


def load_models() -> dict:
    # Trusted first-party model files produced by our own training scripts (06, 08).
    # Same pattern as api/deps.py — not loading from external or user-supplied sources.
    return {
        "classifier": joblib.load(MODELS_DIR / "classifier_xgb.joblib"),
        "regression":  joblib.load(MODELS_DIR / "regression_xgb.joblib"),
        "dropout":     joblib.load(MODELS_DIR / "dropout_xgb.joblib"),
        "dosage":      joblib.load(MODELS_DIR / "dosage_frequency.joblib"),
    }


def main() -> None:
    print("Loading models ...")
    models = load_models()

    engine = create_engine(DB_URL)
    Session = sessionmaker(bind=engine)
    db = Session()

    # Find sessions without a prediction row
    rows = db.execute(text("""
        SELECT s.id AS session_id, p.id AS patient_id
        FROM sessions s
        JOIN patients p ON p.id = s.patient_id
        LEFT JOIN session_predictions sp ON sp.session_id = s.id
        WHERE sp.id IS NULL
        ORDER BY s.id
    """)).fetchall()

    total = len(rows)
    print(f"Found {total} sessions without predictions.")

    svc = PredictionService(db, models)
    done = 0
    errors = 0

    for row in rows:
        session = db.query(ClinicalSession).get(row.session_id)
        patient = db.query(Patient).get(row.patient_id)
        if session is None or patient is None:
            errors += 1
            continue
        result = svc.run(patient, session)
        if result is None:
            errors += 1
        done += 1
        if done % 200 == 0:
            db.commit()
            print(f"  {done}/{total} ({errors} errors)")

    db.commit()
    print(f"Done. {done} predictions written, {errors} errors.")
    db.close()


if __name__ == "__main__":
    main()
