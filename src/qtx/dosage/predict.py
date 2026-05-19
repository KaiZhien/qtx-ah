"""Inference wrapper for the dosage frequency recommender.

Public API:
  predict_frequency(patient_dict, model, feature_names, label_names) -> dict
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def predict_frequency(
    patient_dict: dict,
    model,
    feature_names: list[str],
    label_names: list[str],
) -> dict:
    """Predict the recommended treatment frequency for a single intake patient.

    Args:
        patient_dict:  Mapping of feature name → value. Missing features default
                       to 0 (conservative: condition assumed absent / field unknown).
        model:         Fitted CalibratedClassifierCV from train_dosage_model().
        feature_names: List of encoded feature names in the order the model expects.
        label_names:   List of class name strings indexed by integer label.

    Returns dict with:
        recommendation  — str label name with highest predicted probability
        confidence      — float probability of the recommended class
        probabilities   — dict mapping each label_name to its predicted probability
    """
    row = {feat: float(patient_dict.get(feat, 0)) for feat in feature_names}
    X = pd.DataFrame([row], columns=feature_names)
    proba = model.predict_proba(X)[0]
    predicted_class = int(np.argmax(proba))
    return {
        "recommendation": label_names[predicted_class],
        "confidence": float(proba[predicted_class]),
        "probabilities": {
            name: float(p) for name, p in zip(label_names, proba)
        },
    }
