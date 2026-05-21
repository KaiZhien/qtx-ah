"""Global singletons loaded once at startup."""
import pandas as pd
import joblib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # quantumtx-ah/
DATA_PATH = ROOT / "data" / "processed" / "dashboard_data.parquet"
MODELS_DIR = ROOT / "models"

df: pd.DataFrame = None
models: dict = {}


def load_all():
    global df, models
    df = pd.read_parquet(DATA_PATH)
    models = {
        "classifier": joblib.load(MODELS_DIR / "classifier_xgb.joblib"),
        "regression": joblib.load(MODELS_DIR / "regression_xgb.joblib"),
        "dropout":    joblib.load(MODELS_DIR / "dropout_xgb.joblib"),
        "dosage":     joblib.load(MODELS_DIR / "dosage_frequency.joblib"),
    }
