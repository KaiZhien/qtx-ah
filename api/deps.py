"""Global singletons loaded once at startup."""
import pandas as pd
import joblib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # quantumtx-ah/
DATA_PATH = ROOT / "data" / "processed" / "dashboard_data.parquet"
MODELS_DIR = ROOT / "models"

df: pd.DataFrame = None
models: dict = {}


def _normalize_age_band(age):
    """Map age to dashboard age band labels matching the frontend constants."""
    if pd.isna(age):
        return None
    age = int(age)
    if age < 50:   return "<50"
    if age < 60:   return "50-59"
    if age < 70:   return "60-69"
    if age < 80:   return "70-79"
    return "80+"


def load_all():
    global df, models
    df = pd.read_parquet(DATA_PATH)
    df["age_band"] = df["age"].apply(_normalize_age_band)
    models = {
        "classifier": joblib.load(MODELS_DIR / "classifier_xgb.joblib"),
        "regression": joblib.load(MODELS_DIR / "regression_xgb.joblib"),
        "dropout":    joblib.load(MODELS_DIR / "dropout_xgb.joblib"),
        "dosage":     joblib.load(MODELS_DIR / "dosage_frequency.joblib"),
    }
