# Codebase Hardening — Design Spec

**Date:** 2026-05-25  
**Status:** Approved

## Goal

Fix 14 confirmed bugs across security, ML inference, ML training pipeline, API robustness, and frontend. Retrain deployed models after pipeline fixes.

---

## 1. API Authentication

**Approach:** Shared API key in environment variable.

- New env var: `QTX_API_KEY` (backend), `NEXT_PUBLIC_API_KEY` (frontend)
- New FastAPI dependency `require_api_key` in `api/deps.py` — reads `QTX_API_KEY`, validates `X-Api-Key` request header, raises HTTP 401 if missing or wrong
- Applied via `Depends(require_api_key)` on every router except `/webhooks/terra` (uses Terra HMAC)
- `web/lib/api.ts` — add `"X-Api-Key": process.env.NEXT_PUBLIC_API_KEY` to all fetch calls
- `web/.env.local.example` — document the new variable

---

## 2. ML Inference Correctness

**`api/routers/fall_risk.py`**

- Rename `has_heart_disease` → `has_hypertension` in `FallRiskRequest` (field name, pydantic model, feature vector)
- Add `has_frailty: int` (0|1) as an explicit clinician-supplied field in `FallRiskRequest`; remove the `has_frailty = float(walking_aid == "frame")` inference hack
- Remove the duplicate frailty signal: keep `+12` post-hoc score for frame users, remove the `has_frailty=1` injection for frame users (now caller-supplied)
- Update `FallRiskInput` TypeScript type and `FallRiskForm.tsx` UI to use `has_hypertension` and `has_frailty`

**`api/routers/predict.py`**

- Build `X_reg` from `list(reg.feature_names_in_)` separately from `X_clf`; pass `X_reg` to `reg.predict()`
- Clip per-test predicted values to physiological bounds: TUG ≥ 1.0s, gait speed [0.1, 2.5] m/s, VAS [0, 100], SPPB [0, 12], 5xSST ≥ 3.0s

---

## 3. API Robustness

**`api/db.py`**

- Add `except: db.rollback()` branch in `get_db` generator

**`api/routers/webhooks.py`**

- Wrap `terra_svc.ingest_payload(payload, db)` in `try/except Exception` → return HTTP 400 with error detail (Terra will not retry 4xx)

**`api/routers/wearable.py`**

- Wrap `confirm_enrollment` insert in `try/except IntegrityError` → return 409 Conflict

---

## 4. ML Training Pipeline + Retrain

**`scripts/09_train_fall_risk_model.py`**

- Compute `medians = X_train.median()` (not `X.median()`) after `train_test_split`

**`src/qtx/outcomes/composite.py` + `scripts/06_train_models.py`**

- Move z-scoring of composite outcome columns inside CV folds using a `sklearn.pipeline.Pipeline` that wraps `FeatureImputer` + estimator; z-score statistics computed on train split only within each fold

**After fixes:** run `make model` or equivalent to retrain all 6 `.joblib` files

---

## 5. Frontend Fixes

**`web/components/clinical/PatientLookup.tsx`**

- Replace `p.tags.toLowerCase()` with `(p.tags ?? "").toLowerCase()` on line 20

**`web/lib/types.ts`**

- Change `has_followup?: 0 | 1 | null` to match actual API value `"Y" | "N" | null`

**`web/components/fall-risk/FallRiskForm.tsx`**

- In `step1Valid()`, validate age is a finite integer in [1, 120]; show inline error if not
- Rename `has_heart_disease` → `has_hypertension` field and label
- Add `has_frailty` toggle field (0|1) to patient self-report section

---

## Out of Scope

- Full RBAC / per-user authorization (deferred — single-shared-key is sufficient for internal tool)
- `load_raw.py` hardcoded column index (low risk, no active workbook layout changes expected)
- `persist.py` pd.NA stringification (affects data pipeline output only, not inference path)
- `src/qtx/outcomes/responders.py` mcid_pct silent drop (no pct keys currently in config)
