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


def load_all() -> None:
    """Load all ML models and the patient DataFrame at startup."""
    global df, models
    missing: list[str] = []

    # Patient data
    try:
        df = pd.read_parquet(DATA_PATH)
        df["age_band"] = df["age"].apply(_normalize_age_band)
    except FileNotFoundError:
        missing.append(str(DATA_PATH))
        print(f"[deps] MISSING data file: {DATA_PATH}")

    # Models
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
            f"Startup failed — {len(missing)} required file(s) not found:\n"
            + "\n".join(f"  {p}" for p in missing)
        )
