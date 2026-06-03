# Dual-Loop Integration Design: ML Predictions ↔ AI Insights

## Goal

Wire the ML prediction loop (XGBoost outcome/fall risk/dropout/dosage models) and the AI reasoning loop (Claude + Voyage RAG) so they inform each other: model predictions surface in insight prompts, and new session accumulation automatically triggers model retraining.

## Context

Two independent loops currently exist:
- **ML loop:** `POST /api/predict/*` endpoints call joblib models loaded at startup via `deps.load_all()`. Predictions are computed on demand and returned to the caller but never persisted.
- **AI loop:** `InsightService.generate_session_insight()` receives a timeline dict (raw measurements + trends) and calls Claude. The prompt has no awareness of model predictions.

No integration point exists. This design adds one in each direction.

---

## Sub-project 1: ML → AI (Predictions in Insight Context)

### Section 1 — Data Model

New table `session_predictions` — one row per session, written immediately after session creation.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `session_id` | UUID FK → sessions | CASCADE delete |
| `patient_id` | UUID FK → patients | CASCADE delete |
| `fall_risk_score` | NUMERIC(5,4) | 0–1 probability |
| `fall_risk_label` | BOOLEAN | True = HIGH risk (score > 0.50) |
| `predicted_composite_improvement` | NUMERIC(7,4) | regression model output |
| `responder_probability` | NUMERIC(5,4) | classifier model output |
| `dropout_probability` | NUMERIC(5,4) | dropout model output |
| `dosage_recommendation` | VARCHAR(100) | dosage model output |
| `model_versions` | JSONB | `{"regression": "regression_xgb.joblib", ...}` — filenames active at prediction time |
| `predicted_at` | TIMESTAMPTZ | server time of inference |

This row is the foundation for future calibration tracking: once a patient accumulates more sessions, `predicted_composite_improvement` can be compared against actual `composite_improvement` to measure model drift.

Migration: `scripts/19_migrate_add_session_predictions.py`

### Section 2 — PredictionService

New `api/services/prediction.py` — `PredictionService(db, models)`.

**Refactor first:** extract `_build_feature_vector(patient, session)` from `api/routers/predict.py` into a shared helper in `api/services/prediction.py`. Both the existing `/api/predict/*` endpoints and `PredictionService` call the same function — no duplication.

**`PredictionService.run(patient, session) -> dict | None`:**
1. Calls `_build_feature_vector(patient, session)`
2. Runs all four models: fall risk, regression, responder classifier, dropout
3. Calls dosage model
4. Writes one `SessionPrediction` ORM row to the DB (does not commit — caller commits)
5. Returns the prediction dict

Error handling: if any individual model raises, log a warning and set that field to `None`. If the whole service raises, log and return `None` — a missing prediction never blocks the session write.

**Call site:** `api/routers/sessions.py`, after `TrendEngine.compute_and_save()` and before `InsightService.generate_session_insight()`.

### Section 3 — Insight Prompt Enrichment

`InsightService.generate_session_insight(timeline, patient_id, session_number, predictions=None)` — `predictions` is the dict returned by `PredictionService.run()`.

When `predictions` is not None, a structured block is injected into the timeline JSON before Claude receives it:

```
Model predictions at session start:
- Fall risk: HIGH (0.87)  [threshold > 0.50]
- Predicted composite improvement: 0.42
- Responder probability: 0.71
- Dropout risk: LOW (0.12)
- Recommended dosage: 2× / week
```

The system prompt gets one additional sentence: *"Where model predictions are provided, reference them explicitly — flag when actual measurements diverge significantly from what was predicted."*

When `predictions` is `None`, the prompt falls back to current behaviour unchanged.

The `answer_question` endpoint also passes predictions if a `SessionPrediction` row exists for the latest session — queried from DB by `patient_id` + latest `predicted_at`.

---

## Sub-project 2: AI → ML (Automated Retraining Trigger)

### Section 4 — Scheduled Retraining Script

New `scripts/18_scheduled_retrain.py` — operates in two modes.

**Trigger check (`check_and_trigger(session_count)`):**
- Reads `retrain_state.json` in project root: `{"last_retrain_session_count": N, "last_retrain_at": "ISO timestamp", "last_metrics": {...}}`
- If `session_count - last_retrain_session_count >= RETRAIN_THRESHOLD` (default 50, configurable via env var `RETRAIN_THRESHOLD`), spawns the retrain job as a background subprocess (`subprocess.Popen`) and returns immediately
- Called from `api/routers/sessions.py` after session commit, non-blocking

**Retrain job (`main()`):**
1. Queries all QTX sessions from DB (excludes `ingested_from LIKE '%raise%'`)
2. Retrains outcome regression model (`XGBRegressor`) and fall risk model (`XGBClassifier` with proxy label) using same pipelines as `scripts/09_train_fall_risk_model.py` and the regression training in `src/qtx/models/regression.py`
3. Runs 5-fold CV to get new metrics
4. Compares against `last_metrics` in `retrain_state.json` — saves new models only if metrics hold or improve
5. If saved: overwrites `models/regression_xgb.joblib` and `models/fall_risk_xgb.joblib`, then calls `POST http://localhost:8000/api/admin/reload-models`
6. Updates `retrain_state.json` with new count, timestamp, and metrics snapshot

### Section 5 — Model Hot-Reload

New `api/routers/admin.py` — `POST /api/admin/reload-models`.

- No auth required in dev (add bearer token gate before production)
- Calls `deps.load_all()` — `deps.models` is a mutable dict; overwriting its entries updates the live references in all request handlers without a server restart
- Returns `{"status": "ok", "models_loaded": [...filenames]}`

---

## Files

| File | Action |
|------|--------|
| `scripts/19_migrate_add_session_predictions.py` | New — adds `session_predictions` table |
| `api/models/clinical.py` | Modify — add `SessionPrediction` ORM class |
| `api/services/prediction.py` | New — `PredictionService` + `_build_feature_vector` (moved from predict router) |
| `api/routers/predict.py` | Modify — import `_build_feature_vector` from services instead of defining it |
| `api/routers/sessions.py` | Modify — call `PredictionService.run()` after trends, pass result to `InsightService` |
| `api/services/insight.py` | Modify — accept `predictions` kwarg, enrich prompt, update system prompt |
| `api/routers/admin.py` | New — `POST /api/admin/reload-models` |
| `scripts/18_scheduled_retrain.py` | New — `check_and_trigger()` + `main()` retrain job |
| `retrain_state.json` | New (runtime artefact) — persists retrain state; added to `.gitignore` |
| `tests/test_prediction_service.py` | New — unit tests for `PredictionService` and `_build_feature_vector` |
| `tests/test_scheduled_retrain.py` | New — unit tests for `check_and_trigger` gate logic |

No changes to `deps.py`, `voyage.py`, `report.py`, or any ML model training code.

---

## Testing

- Unit tests mock all four models and verify `PredictionService.run()` writes correct DB row and returns correct dict
- Unit tests verify `check_and_trigger` fires at threshold, not before, and is idempotent
- Existing `test_insight.py` updated: `generate_session_insight` called with and without `predictions` kwarg — both paths tested
- Integration: run `POST /api/patient/{sn}/session` with a real DB session and verify `session_predictions` row is created and the insight content references model predictions

## Error Handling

- `PredictionService` failure → logs warning, returns `None` → session and insight complete without predictions
- Retrain subprocess failure → logged to stderr, `retrain_state.json` not updated → next threshold check will retry
- `reload-models` call failure → logged, API continues with current (pre-retrain) models
