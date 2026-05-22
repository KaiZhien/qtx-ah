"""Script 09 — Train fall risk XGBoost classifier.

Uses grp_balance_falls as the training label — a binary column (0/1) indicating
patients whose presenting condition group is balance & falls. Fully populated
across all 1716 patients, making it the strongest real fall-risk signal in the dataset.
Saves model and feature medians to models/.

Usage:
    PYTHONPATH=. python scripts/09_train_fall_risk_model.py
"""
from __future__ import annotations

import joblib
import pandas as pd
from pathlib import Path
from xgboost import XGBClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, classification_report

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "processed" / "dashboard_data.parquet"
MODELS_DIR = ROOT / "models"

FEATURES = [
    "age", "gender_M",
    "has_oa", "has_diabetes", "has_stroke", "has_parkinsons",
    "has_frailty", "has_hypertension",
    "pre_5xsst_s", "pre_vas",
]


def make_label(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Derive proxy fall-risk label and labellable row mask.

    High risk = 2+ of: TUG >= 12s, gait < 0.8 m/s, SPPB <= 6.
    TUG, gait, and SPPB are excluded from training features to avoid circularity —
    they are used only as post-prediction score adjusters at inference time.
    """
    print("Deriving proxy label from TUG / gait / SPPB thresholds")
    tug_ok  = df["pre_tug_s"].notna()
    gait_ok = df["pre_normal_gs_ms"].notna()
    sppb_ok = df["baseline_sppb"].notna()

    slow_tug  = tug_ok  & (df["pre_tug_s"]          >= 12)
    slow_gait = gait_ok & (df["pre_normal_gs_ms"]     < 0.8)
    low_sppb  = sppb_ok & (df["baseline_sppb"]        <= 6)

    measurable = tug_ok.astype(int) + gait_ok.astype(int) + sppb_ok.astype(int)
    labellable = measurable >= 2

    score = slow_tug.astype(int) + slow_gait.astype(int) + low_sppb.astype(int)
    label = (score >= 2).astype(int)
    return label, labellable


def build_X(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if "gender_M" not in out.columns:
        gender_upper = out["gender"].astype(str).str.upper()
        out["gender_M"] = gender_upper.map({"M": 1.0, "F": 0.0})  # NaN for anything else
    present = [c for c in FEATURES if c in out.columns]
    return out[present].copy()


def main() -> None:
    df = pd.read_parquet(DATA)
    y_all, labellable = make_label(df)
    X = build_X(df)

    X = X[labellable]
    y = y_all[labellable]
    print(f"Labellable rows: {labellable.sum()} / {len(df)} | Label distribution: {y.value_counts().to_dict()}")

    medians: dict = X.median().to_dict()
    X = X.fillna(medians)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    model = XGBClassifier(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        eval_metric="logloss",
        random_state=42,
    )
    model.fit(X_train, y_train)

    auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])
    print(f"AUC-ROC: {auc:.3f}")
    print(classification_report(y_test, model.predict(X_test)))

    MODELS_DIR.mkdir(exist_ok=True)
    joblib.dump(model, MODELS_DIR / "fall_risk_xgb.joblib")
    joblib.dump(medians, MODELS_DIR / "fall_risk_medians.joblib")
    print("Saved: models/fall_risk_xgb.joblib")
    print("Saved: models/fall_risk_medians.joblib")


if __name__ == "__main__":
    main()
