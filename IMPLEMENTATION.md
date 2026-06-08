# QTX-AH — Implementation Roadmap

**Generated:** 2026-06-08  
**Codebase state:** v0.2.0 — 483 tests passing, dual-loop ML+AI live, RAISE integrated  
**Purpose:** Feed each section independently into Claude Code as a self-contained implementation task.

Each section is self-contained: it names every file to touch, every function to write, and every test to add. Sections are ordered by ROI, not dependency.

---

## Table of Contents

1. [Retrain Regression Model with Longitudinal Features](#1-retrain-regression-model-with-longitudinal-features)
2. [Per-Patient Bayesian Residual Correction](#2-per-patient-bayesian-residual-correction)
3. [Proactive Anomaly Detection](#3-proactive-anomaly-detection)
4. [Treatment Plan Generation](#4-treatment-plan-generation)
5. [Cohort Percentile Ranks](#5-cohort-percentile-ranks)
6. [Wire Wearable Cadence into Fall Risk](#6-wire-wearable-cadence-into-fall-risk)
7. [Secrets Rotation and Environment Hardening](#7-secrets-rotation-and-environment-hardening)
8. [CORS Hardening](#8-cors-hardening)
9. [Background Task Queue for Retrain Jobs](#9-background-task-queue-for-retrain-jobs)
10. [Session Preparation Workflow](#10-session-preparation-workflow)
11. [Comparative Cohort Response Curves](#11-comparative-cohort-response-curves)
12. [Admin Dashboard for Model Health](#12-admin-dashboard-for-model-health)
13. [Wire POST /api/import/file to Real Pipeline](#13-wire-post-apiimportfile-to-real-pipeline)
14. [Retire Streamlit Dashboard](#14-retire-streamlit-dashboard)
15. [Dosage and Dropout Calibration Tracking](#15-dosage-and-dropout-calibration-tracking)

---

## 1. Retrain Regression Model with Longitudinal Features

### Context

The regression model currently achieves R² = 0.022, which is a credibility liability when shown to clinicians or hospital stakeholders. The root cause is that the model treats every patient as if it is their first-ever session — it has no memory of what happened in prior sessions.

Three longitudinal features were added to the inference feature vector in the last commit (`session_number`, `prior_avg_composite_improvement`, `trend_tug_magnitude`) and are already being written into `SessionPrediction` rows via `_get_longitudinal_features()` in `api/services/prediction.py`. However, the model artifacts (`models/regression_xgb.joblib`) were trained without these features. The model therefore ignores them at inference time because `feature_names_in_` on the loaded XGBoost object does not include them.

This task retrains the regression model end-to-end — updating the training query, the feature list in `config/models.yaml`, and the retrain script — so that the loaded model actually uses the longitudinal features it receives.

### Files to change

| File | Change |
|------|--------|
| `config/models.yaml` | Add three longitudinal features to `regression_composite.features` |
| `scripts/18_scheduled_retrain.py` | Extend the training SQL query to compute longitudinal features per row; update `REGRESSION_FEATURES` list |
| `src/qtx/models/regression.py` | Ensure the offline training script (`scripts/06_train_models.py`) path also includes longitudinal features when training from Parquet |
| `scripts/06_train_models.py` | Add longitudinal column computation step before model training |

### Step-by-step

#### 1.1 Update `config/models.yaml`

In the `regression_composite.features` list, append after `# categorical`:

```yaml
    # longitudinal session features
    - session_number
    - prior_avg_composite_improvement
    - trend_tug_magnitude
```

The `primary_indication` categorical entry should remain. These three new entries go immediately after the `rgn_trunk` entry and before `primary_indication`.

#### 1.2 Update `scripts/18_scheduled_retrain.py` — SQL query

The current `_load_qtx_sessions()` function fetches one row per session from `sessions JOIN patients`. It needs two additional computed columns:

**`session_number`**: Already present in the `sessions` table as `s.session_number`. Just add it to the SELECT clause. The current query may omit it — verify and add `s.session_number` to the SELECT.

**`prior_avg_composite_improvement`**: A window function over all prior sessions for the same patient:

```sql
AVG(s2.composite_improvement) OVER (
    PARTITION BY s.patient_id
    ORDER BY s.session_number
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
) AS prior_avg_composite_improvement
```

Add this as a subquery or window expression. Use `COALESCE(..., 0.0)` to default NULL (first session, no prior rows) to 0.

**`trend_tug_magnitude`**: A lateral join to `patient_trends`:

```sql
LEFT JOIN LATERAL (
    SELECT magnitude
    FROM patient_trends
    WHERE patient_id = s.patient_id
      AND metric ILIKE '%tug%'
    ORDER BY computed_at DESC
    LIMIT 1
) tug_trend ON true
```

Then `COALESCE(tug_trend.magnitude, 0.0) AS trend_tug_magnitude`.

The final SQL should look like:

```sql
SELECT
    p.age, p.gender, p.cohort, p.baseline_sppb AS patient_sppb,
    [... all existing columns ...],
    s.session_number,
    COALESCE(
        AVG(s.composite_improvement) OVER (
            PARTITION BY s.patient_id
            ORDER BY s.session_number
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0.0
    ) AS prior_avg_composite_improvement,
    COALESCE(tug_trend.magnitude, 0.0) AS trend_tug_magnitude
FROM sessions s
JOIN patients p ON p.id = s.patient_id
LEFT JOIN LATERAL (
    SELECT magnitude FROM patient_trends
    WHERE patient_id = s.patient_id AND metric ILIKE '%tug%'
    ORDER BY computed_at DESC LIMIT 1
) tug_trend ON true
WHERE s.ingested_from NOT ILIKE '%raise%'
  AND s.composite_improvement IS NOT NULL
```

#### 1.3 Update `REGRESSION_FEATURES` in `scripts/18_scheduled_retrain.py`

The list already has `session_number`, `prior_avg_composite_improvement`, and `trend_tug_magnitude` at lines 51–54. Verify these exactly match the column aliases in the SQL query above.

#### 1.4 Run the retrain

After making the code changes, run:

```bash
PYTHONPATH=src:api .venv/bin/python3.14 scripts/18_scheduled_retrain.py
```

The script will:
1. Load all QTX sessions with longitudinal features computed
2. Train a new XGBRegressor with 5-fold CV
3. Compare new CV metrics against `retrain_state.json` baseline
4. Save to `models/regression_xgb.joblib` only if metrics hold/improve
5. Call `POST /api/admin/reload-models` to hot-swap the live model

Monitor the output. If R² stays at ~0.022, the longitudinal features are present but the model is failing to use them — check that the features are not all 0 for session 1 rows (expected, as those patients have no prior history). The model should learn to use them for session 2+ patients when they exist.

#### 1.5 Validate at inference

After retraining, call `POST /api/patient/{sn}/session` for a patient who has had prior sessions. Check `GET /api/patient/{sn}/predictions/latest` — the `shap_top5` JSON should now include `session_number` or `prior_avg_composite_improvement` as high-contributing features for multi-session patients.

#### 1.6 Tests to add

In `tests/test_longitudinal_features.py` (already exists), add:

- A test that verifies the retrained model's `feature_names_in_` includes all three longitudinal feature names.
- A test that verifies `_get_longitudinal_features()` returns `prior_avg_composite_improvement = 0.0` for a patient with no prior sessions and a non-zero value for a patient with two sessions.
- A test that when `session_number = 3` and `prior_avg_composite_improvement = 0.15`, the prediction differs from the same patient at `session_number = 1` with `prior_avg_composite_improvement = 0.0`.

---

## 2. Per-Patient Bayesian Residual Correction

### Context

XGBoost learns population-level relationships. For any individual patient who consistently over- or under-performs the model's predictions, the uncorrected output is systematically biased. This feature computes a running bias estimate per patient using their own prediction history and subtracts it from the raw model output at inference time — no retraining required.

The mechanism: after each session, `session_predictions` stores both `predicted_composite_improvement` (model output) and the session stores `composite_improvement` (actual). Once a patient has ≥2 sessions with both values present, we can compute `bias = AVG(predicted - actual)`. Subtracting this from the next prediction gives a corrected estimate calibrated to that specific patient's response pattern.

### Files to change

| File | Change |
|------|--------|
| `api/services/prediction.py` | Add `_compute_patient_bias()` function; apply correction in `_run()` after regression inference |
| `api/models/clinical.py` | No schema changes needed |
| `tests/test_prediction_service.py` | Add tests for bias correction |

### Step-by-step

#### 2.1 Add `_compute_patient_bias()` to `api/services/prediction.py`

Add this function after the existing `_get_longitudinal_features()` function:

```python
def _compute_patient_bias(patient_id: uuid.UUID, db: DBSession) -> float:
    """Compute per-patient prediction bias from session history.
    
    Returns AVG(predicted - actual) over sessions where both values exist.
    Returns 0.0 if fewer than 2 sessions with complete prediction history.
    """
    from models.clinical import SessionPrediction, Session as ClinicalSession
    from sqlalchemy import and_

    rows = (
        db.query(
            SessionPrediction.predicted_composite_improvement,
            ClinicalSession.composite_improvement,
        )
        .join(ClinicalSession, SessionPrediction.session_id == ClinicalSession.id)
        .filter(
            SessionPrediction.patient_id == patient_id,
            SessionPrediction.predicted_composite_improvement.isnot(None),
            ClinicalSession.composite_improvement.isnot(None),
        )
        .all()
    )

    if len(rows) < 2:
        return 0.0

    residuals = [
        float(predicted) - float(actual)
        for predicted, actual in rows
    ]
    return sum(residuals) / len(residuals)
```

The `< 2` guard is deliberate: with only one prior session the bias estimate is too noisy to be useful.

#### 2.2 Apply correction in `PredictionService._run()`

In the regression block (lines 197–205 of `prediction.py`), after computing `predictions["predicted_composite_improvement"]`, add:

```python
# Apply per-patient bias correction if sufficient history exists
bias = _compute_patient_bias(patient.id, self._db)
if bias != 0.0:
    raw = predictions["predicted_composite_improvement"]
    predictions["predicted_composite_improvement"] = raw - bias
    predictions["bias_correction_applied"] = round(bias, 4)
    logger.debug("Bias correction %.4f applied for patient %s", bias, patient.id)
```

Store `bias_correction_applied` in the predictions dict so the caller (insight service) can reference it.

#### 2.3 Surface bias correction in `SessionPrediction` ORM

Add a new column to `api/models/clinical.py` in the `SessionPrediction` class:

```python
bias_correction: Mapped[float | None] = mapped_column(Numeric(7, 4), nullable=True)
```

Add a migration script `scripts/23_migrate_add_bias_correction.py`:

```python
"""Migration 23 — add bias_correction column to session_predictions."""
from sqlalchemy import create_engine, text
import os

DB_URL = os.environ["DATABASE_URL"]
engine = create_engine(DB_URL)

with engine.begin() as conn:
    conn.execute(text("""
        ALTER TABLE session_predictions
        ADD COLUMN IF NOT EXISTS bias_correction NUMERIC(7,4)
    """))
    print("Migration 23 complete.")
```

Run with:
```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=src:api .venv/bin/python3.14 scripts/23_migrate_add_bias_correction.py
```

#### 2.4 Update `SessionPrediction` row creation in `_run()`

In the `row = SessionPrediction(...)` block, add:

```python
bias_correction=predictions.get("bias_correction_applied"),
```

#### 2.5 Expose in `GET /api/patient/{sn}/predictions/latest`

In `api/routers/sessions.py`, in the response dict for `predictions/latest`, add:

```python
"bias_correction": float(row.bias_correction) if row.bias_correction is not None else None,
```

#### 2.6 Surface in frontend `PredictionChips`

In `web/components/clinical/PredictionChips.tsx`, if `bias_correction` is non-null, add a small annotation beneath the predicted improvement chip: `(bias-corrected)` in muted text. This is informational only — clinicians should know the number has been personalised.

#### 2.7 Tests

In `tests/test_prediction_service.py`:

- Mock `_compute_patient_bias` returning 0.05 and verify the final `predicted_composite_improvement` is `raw - 0.05`.
- Test that `_compute_patient_bias` returns 0.0 when fewer than 2 prior sessions exist.
- Test that `_compute_patient_bias` correctly computes the mean of multiple residuals.

---

## 3. Proactive Anomaly Detection

### Context

The system currently generates insights reactively: Claude summarises what happened after each session and answers clinician questions. There is no automatic flag when something is going wrong. This feature adds an `AnomalyDetector` that runs after every `POST /api/patient/{sn}/session`, checks a set of clinical rules against the new session data and patient trend history, and generates a warning-level insight via Claude when any rule fires.

The anomaly card should appear above `PredictionChips` in the AI tab, visually distinct (amber border), and not clutter the session summary card.

### Rules to implement

| ID | Rule | Clinical basis |
|----|------|---------------|
| `METRIC_REGRESSION` | Any trend with `direction = "declining"` for ≥ 2 sessions AND `sessions_used ≥ 3` | Sustained decline is not noise |
| `POST_SESSION_PAIN_INCREASE` | `post_vas > pre_vas + 1.0` in this session | Pain worsening after session is a red flag |
| `PREDICTION_DIVERGENCE` | `composite_improvement < 0` AND `responder_probability > 0.65` | Model predicted responder but patient declined |
| `FALL_RISK_TUG` | `post_tug_s > 12.0` AND NOT `patient.has_fall_risk` | Crossed clinical fall-risk threshold without existing flag |
| `HIGH_DROPOUT_RISK` | `dropout_probability > 0.75` | Very high modelled risk of not returning |

Any session can fire multiple rules. When any rule fires, generate exactly one Claude call that summarises all fired rules in a concise clinical warning.

### Files to change

| File | Change |
|------|--------|
| `api/services/anomaly.py` | New file: `AnomalyDetector` class |
| `api/routers/sessions.py` | Call `AnomalyDetector.check_and_flag()` after `InsightService.generate_session_insight()` |
| `api/models/clinical.py` | Add `insight_type = "anomaly_alert"` — no schema change needed, just a new value |
| `api/services/insight.py` | Add `generate_anomaly_alert()` method |
| `web/components/clinical/AITab.tsx` | Render anomaly alerts above session summaries with amber styling |
| `web/lib/types.ts` | Add `anomaly_alert` to `InsightType` union |
| `tests/test_anomaly_detection.py` | New test file |

### Step-by-step

#### 3.1 Create `api/services/anomaly.py`

```python
"""AnomalyDetector — checks clinical rules after every session and flags warnings."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from sqlalchemy.orm import Session as DBSession

from models.clinical import PatientTrend, Session as ClinicalSession

logger = logging.getLogger(__name__)

FALL_RISK_TUG_THRESHOLD = 12.0
PREDICTION_DIVERGENCE_RESPONDER_THRESHOLD = 0.65
HIGH_DROPOUT_THRESHOLD = 0.75
PAIN_INCREASE_THRESHOLD = 1.0
MIN_SESSIONS_FOR_TREND = 3


@dataclass
class AnomalyFlag:
    rule_id: str
    description: str
    severity: str  # "warning" | "alert"


class AnomalyDetector:
    def __init__(self, db: DBSession) -> None:
        self._db = db

    def check(
        self,
        patient,
        session: ClinicalSession,
        predictions: dict | None,
    ) -> list[AnomalyFlag]:
        flags: list[AnomalyFlag] = []
        flags.extend(self._check_metric_regression(patient, session))
        flags.extend(self._check_pain_increase(session))
        if predictions:
            flags.extend(self._check_prediction_divergence(session, predictions))
            flags.extend(self._check_fall_risk_tug(patient, session, predictions))
            flags.extend(self._check_high_dropout(predictions))
        return flags

    def _check_metric_regression(self, patient, session) -> list[AnomalyFlag]:
        trends = (
            self._db.query(PatientTrend)
            .filter(
                PatientTrend.patient_id == patient.id,
                PatientTrend.direction == "declining",
                PatientTrend.sessions_used >= MIN_SESSIONS_FOR_TREND,
            )
            .all()
        )
        flags = []
        for t in trends:
            flags.append(AnomalyFlag(
                rule_id="METRIC_REGRESSION",
                description=f"{t.metric} has been declining for {t.sessions_used} sessions "
                            f"(first={t.first_value:.2f}, last={t.last_value:.2f})",
                severity="warning",
            ))
        return flags

    def _check_pain_increase(self, session) -> list[AnomalyFlag]:
        if (
            session.post_vas is not None
            and session.pre_vas is not None
            and float(session.post_vas) > float(session.pre_vas) + PAIN_INCREASE_THRESHOLD
        ):
            return [AnomalyFlag(
                rule_id="POST_SESSION_PAIN_INCREASE",
                description=f"VAS pain worsened after session: pre={float(session.pre_vas):.1f}, "
                            f"post={float(session.post_vas):.1f}",
                severity="alert",
            )]
        return []

    def _check_prediction_divergence(self, session, predictions) -> list[AnomalyFlag]:
        ci = predictions.get("predicted_composite_improvement") or (
            float(session.composite_improvement) if session.composite_improvement else None
        )
        rp = predictions.get("responder_probability")
        if ci is not None and rp is not None and ci < 0 and rp > PREDICTION_DIVERGENCE_RESPONDER_THRESHOLD:
            return [AnomalyFlag(
                rule_id="PREDICTION_DIVERGENCE",
                description=f"Model predicted responder ({rp:.0%} probability) but "
                            f"composite improvement is negative ({ci:+.3f})",
                severity="warning",
            )]
        return []

    def _check_fall_risk_tug(self, patient, session, predictions) -> list[AnomalyFlag]:
        post_tug = float(session.post_tug_s) if session.post_tug_s is not None else None
        if (
            post_tug is not None
            and post_tug > FALL_RISK_TUG_THRESHOLD
            and not patient.has_fall_risk
        ):
            return [AnomalyFlag(
                rule_id="FALL_RISK_TUG",
                description=f"Post-session TUG {post_tug:.1f}s exceeds fall-risk threshold (12s); "
                            f"patient not flagged as has_fall_risk",
                severity="alert",
            )]
        return []

    def _check_high_dropout(self, predictions) -> list[AnomalyFlag]:
        dp = predictions.get("dropout_probability")
        if dp is not None and dp > HIGH_DROPOUT_THRESHOLD:
            return [AnomalyFlag(
                rule_id="HIGH_DROPOUT_RISK",
                description=f"Dropout model predicts {dp:.0%} probability of not returning "
                            f"for follow-up",
                severity="warning",
            )]
        return []
```

#### 3.2 Add `generate_anomaly_alert()` to `api/services/insight.py`

Add a new prompt template constant at the top of the file:

```python
_ANOMALY_ALERT_TEMPLATE = """\
Patient timeline data:
{timeline_json}

The following clinical anomalies were automatically detected for session {session_number}:
{anomaly_list}

In 2-4 sentences per anomaly, explain what each finding means clinically and what the \
physiotherapist should prioritise reviewing. Be direct and action-oriented. \
Do not repeat the raw numbers — interpret them."""
```

Add the method to `InsightService`:

```python
def generate_anomaly_alert(
    self,
    timeline: dict,
    patient_id: uuid.UUID,
    session_number: int,
    anomalies: list,  # list of AnomalyFlag dataclasses
) -> str:
    """Generate a clinical warning insight for fired anomaly rules."""
    if not self._api_key:
        content = f"[Anomaly alert — {len(anomalies)} rule(s) fired — AI unavailable]"
        self._save_insight(
            patient_id=patient_id,
            content=content,
            model="stub",
            insight_type="anomaly_alert",
            session_number=session_number,
        )
        return content

    anomaly_list = "\n".join(
        f"- [{a.severity.upper()}] {a.rule_id}: {a.description}"
        for a in anomalies
    )
    user_message = _ANOMALY_ALERT_TEMPLATE.format(
        timeline_json=json.dumps(timeline, indent=2),
        session_number=session_number,
        anomaly_list=anomaly_list,
    )
    try:
        content = self._call_claude(user_message)
    except Exception as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail="AI service unavailable") from exc

    embedding = VoyageEmbedder().embed(content, input_type="document")
    self._save_insight(
        patient_id=patient_id,
        content=content,
        model=self.MODEL,
        insight_type="anomaly_alert",
        session_number=session_number,
        embedding=embedding,
    )
    return content
```

#### 3.3 Wire into `api/routers/sessions.py`

After the existing `InsightService.generate_session_insight()` call, add:

```python
from services.anomaly import AnomalyDetector

# Run anomaly detection
detector = AnomalyDetector(db)
anomaly_flags = detector.check(patient, session, predictions)
if anomaly_flags:
    logger.info(
        "Anomaly detector fired %d rule(s) for patient %s session %d",
        len(anomaly_flags), sn, session.session_number,
    )
    insight_svc.generate_anomaly_alert(
        timeline=timeline,
        patient_id=patient.id,
        session_number=session.session_number,
        anomalies=anomaly_flags,
    )
```

The `timeline` dict is already built earlier in the session router — pass it through directly.

#### 3.4 Update frontend `AITab.tsx`

In `web/components/clinical/AITab.tsx`, query insights and partition them by `insight_type`:

```typescript
const anomalyAlerts = insights.filter(i => i.insight_type === 'anomaly_alert')
const sessionSummaries = insights.filter(i => i.insight_type === 'session_summary')
```

Render `anomalyAlerts` first, each wrapped in a component with amber left-border:

```tsx
{anomalyAlerts.length > 0 && (
  <div className="anomaly-section">
    {anomalyAlerts.map(alert => (
      <div key={alert.id} className="anomaly-card">
        <span className="anomaly-label">Clinical Alert</span>
        <InsightCard insight={alert} />
      </div>
    ))}
  </div>
)}
```

Add to `web/app/globals.css`:

```css
.anomaly-card {
  border-left: 3px solid var(--color-warning, #f59e0b);
  padding-left: 0.75rem;
  margin-bottom: 0.5rem;
}
.anomaly-label {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-warning, #f59e0b);
  display: block;
  margin-bottom: 0.25rem;
}
```

#### 3.5 Update `web/lib/types.ts`

Add `'anomaly_alert'` to the `InsightType` union wherever it is defined.

#### 3.6 Tests to add

Create `tests/test_anomaly_detection.py`:

- Test each rule fires independently with crafted mock session/patient/predictions data.
- Test that when no rules fire, `check()` returns an empty list.
- Test that `METRIC_REGRESSION` only fires when `sessions_used >= 3` (not for 2).
- Test that `PREDICTION_DIVERGENCE` does not fire when `responder_probability = 0.5` (below threshold).
- Test that `HIGH_DROPOUT_RISK` fires when `dropout_probability = 0.80` and does not fire at `0.74`.
- Integration test: POST a session with `post_vas > pre_vas + 1.0` and verify an `anomaly_alert` insight row is written to the DB.

---

## 4. Treatment Plan Generation

### Context

Every feature in the system helps a clinician understand what happened. This one helps them decide what to do next. The data required to generate a treatment plan already exists: 24 comorbidity flags, trend directions and magnitudes, ML predictions (responder probability, dropout risk, dosage recommendation), SHAP top-5 features, RAISE-validated response patterns. Claude simply needs to be asked to synthesise them into a structured plan.

The output is a `treatment_plan` insight stored in `patient_insights`, rendered as a `PlanCard` checklist in the AI tab. A clinician who reviews it before walking into a session has everything they need without opening a separate system.

### New endpoint

```
POST /api/patient/{sn}/suggest_plan
```

Request body (all optional — if omitted, uses latest session data):
```json
{
  "session_focus": "optional clinician-supplied focus (e.g., 'gait and fall prevention')",
  "plan_sessions": 4
}
```

Response:
```json
{
  "plan": "...(generated plan text)...",
  "insight_id": "uuid",
  "generated_at": "iso8601"
}
```

### Files to change

| File | Change |
|------|--------|
| `api/routers/plan.py` | New file: `POST /api/patient/{sn}/suggest_plan` |
| `api/main.py` | Register `plan` router |
| `api/services/insight.py` | Add `generate_treatment_plan()` method |
| `web/components/clinical/PlanCard.tsx` | New component: renders structured plan as checklist |
| `web/components/clinical/AITab.tsx` | Add "Generate Plan" button + render `PlanCard` |
| `web/lib/api.ts` | Add `suggestPlan(sn, body)` function |
| `web/lib/types.ts` | Add `TreatmentPlan` and `PlanRequest` types |
| `tests/test_plan_api.py` | New test file |

### Step-by-step

#### 4.1 Add plan prompt template to `api/services/insight.py`

```python
_TREATMENT_PLAN_TEMPLATE = """\
You are generating a structured physiotherapy treatment plan for a single patient.
Base the plan ONLY on the data provided below. Do not introduce general advice unconnected to this patient's specific measurements, phenotype, and trends.

Patient data:
{patient_json}

Latest session data:
{session_json}

ML model signals:
{predictions_json}

Trend history:
{trends_json}

Generate a structured {n_sessions}-session treatment plan in the following exact format. \
Use bullet points. Be specific to this patient's conditions and measured deficits:

**Session Focus:** [one sentence: what this patient's programme should prioritise and why]

**Session-by-Session Plan:**
- Session 1: [specific intervention focus + monitoring targets]
- Session 2: [progression or pivot based on expected trajectory]
- Session 3: [...]
- Session 4: [...]

**Key Metrics to Monitor:**
- [metric] — target: [specific value based on MCID thresholds]
- [metric] — watch for: [regression threshold]

**Risk Flags:**
- [any dropout/fall risk/phenotype-specific cautions derived from the data]

**Dosage Recommendation:** [from model signal; explain rationale in one sentence]"""
```

Add the method:

```python
def generate_treatment_plan(
    self,
    patient,
    timeline: dict,
    predictions: dict | None,
    patient_id: uuid.UUID,
    session_number: int,
    clinician_focus: str | None = None,
    plan_sessions: int = 4,
) -> str:
    """Generate a structured multi-session treatment plan for this patient."""
    if not self._api_key:
        content = "[Treatment plan unavailable — ANTHROPIC_API_KEY not configured]"
        self._save_insight(
            patient_id=patient_id,
            content=content,
            model="stub",
            insight_type="treatment_plan",
            session_number=session_number,
        )
        return content

    patient_dict = {
        "age": patient.age,
        "age_band": patient.age_band,
        "gender": patient.gender,
        "cohort": patient.cohort,
        "baseline_sppb": patient.baseline_sppb,
        "has_frailty": patient.has_frailty,
        "has_diabetes": patient.has_diabetes,
        "has_neurological": patient.has_neurological,
        "has_stroke": patient.has_stroke,
        "has_parkinsons": patient.has_parkinsons,
        "has_fall_risk": patient.has_fall_risk,
        "has_balance_issue": patient.has_balance_issue,
        "has_chronic_pain": patient.has_chronic_pain,
        "has_oa": patient.has_oa,
        "has_knee_issue": patient.has_knee_issue,
        "has_spinal_issue": patient.has_spinal_issue,
        "primary_indication": patient.primary_indication,
        "clinician_focus": clinician_focus or "not specified",
    }

    predictions_formatted = _format_predictions(predictions) if predictions else {}
    if predictions and predictions.get("shap_top5"):
        predictions_formatted["top_predictive_features"] = predictions["shap_top5"]

    user_message = _TREATMENT_PLAN_TEMPLATE.format(
        patient_json=json.dumps(patient_dict, indent=2),
        session_json=json.dumps(timeline.get("sessions", [{}])[-1], indent=2),
        predictions_json=json.dumps(predictions_formatted, indent=2),
        trends_json=json.dumps(timeline.get("trends", []), indent=2),
        n_sessions=plan_sessions,
    )

    try:
        content = self._call_claude(user_message)
    except Exception as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail="AI service unavailable") from exc

    embedding = VoyageEmbedder().embed(content, input_type="document")
    self._save_insight(
        patient_id=patient_id,
        content=content,
        model=self.MODEL,
        insight_type="treatment_plan",
        session_number=session_number,
        embedding=embedding,
    )
    return content
```

#### 4.2 Create `api/routers/plan.py`

```python
"""Treatment plan generation endpoint."""
from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, SessionPrediction
from services.insight import InsightService
from routers.sessions import _session_to_dict, _trend_to_dict

router = APIRouter()


class PlanRequest(BaseModel):
    session_focus: str | None = None
    plan_sessions: int = 4


@router.post("/patient/{sn}/suggest_plan")
def suggest_plan(
    sn: str,
    body: PlanRequest,
    db: DBSession = Depends(get_db),
):
    patient = db.query(Patient).filter_by(sn=sn).first()
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")

    # Build timeline (reuse existing pattern from sessions router)
    from models.clinical import Session as ClinicalSession, PatientTrend, PatientInsight
    sessions = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id)
        .order_by(ClinicalSession.session_number)
        .all()
    )
    trends = db.query(PatientTrend).filter_by(patient_id=patient.id).all()

    latest_session = sessions[-1] if sessions else None
    session_number = latest_session.session_number if latest_session else 1

    timeline = {
        "patient": {
            "sn": patient.sn,
            "age": patient.age,
            "cohort": patient.cohort,
            "primary_indication": patient.primary_indication,
        },
        "sessions": [_session_to_dict(s) for s in sessions],
        "trends": [_trend_to_dict(t) for t in trends],
    }

    # Get latest predictions
    pred_row = (
        db.query(SessionPrediction)
        .filter_by(patient_id=patient.id)
        .order_by(SessionPrediction.predicted_at.desc())
        .first()
    )
    predictions = None
    if pred_row:
        predictions = {
            "predicted_composite_improvement": float(pred_row.predicted_composite_improvement) if pred_row.predicted_composite_improvement else None,
            "responder_probability": float(pred_row.responder_probability) if pred_row.responder_probability else None,
            "dropout_probability": float(pred_row.dropout_probability) if pred_row.dropout_probability else None,
            "dosage_recommendation": pred_row.dosage_recommendation,
            "shap_top5": pred_row.shap_top5,
        }

    svc = InsightService(db)
    plan_text = svc.generate_treatment_plan(
        patient=patient,
        timeline=timeline,
        predictions=predictions,
        patient_id=patient.id,
        session_number=session_number,
        clinician_focus=body.session_focus,
        plan_sessions=body.plan_sessions,
    )

    db.commit()

    return {
        "plan": plan_text,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
```

#### 4.3 Register router in `api/main.py`

Import and include the new router:

```python
from routers.plan import router as plan_router
app.include_router(plan_router, prefix="/api")
```

Add it alongside the existing router includes.

#### 4.4 Create `web/components/clinical/PlanCard.tsx`

```tsx
import React from 'react'

interface PlanCardProps {
  plan: string
  generatedAt: string
  onGenerate?: () => void
  loading?: boolean
}

export function PlanCard({ plan, generatedAt, onGenerate, loading }: PlanCardProps) {
  const lines = plan.split('\n')

  return (
    <div className="plan-card">
      <div className="plan-card-header">
        <span className="plan-label">Treatment Plan</span>
        <span className="plan-timestamp">{generatedAt}</span>
      </div>
      <div className="plan-content">
        {lines.map((line, i) => {
          if (line.startsWith('**') && line.endsWith('**')) {
            return <h4 key={i} className="plan-section-header">{line.replace(/\*\*/g, '')}</h4>
          }
          if (line.startsWith('- ')) {
            return <li key={i} className="plan-item">{line.slice(2)}</li>
          }
          return line ? <p key={i}>{line}</p> : null
        })}
      </div>
      {onGenerate && (
        <button className="btn btn-secondary" onClick={onGenerate} disabled={loading}>
          {loading ? 'Generating...' : 'Regenerate Plan'}
        </button>
      )}
    </div>
  )
}
```

Add CSS in `globals.css`:
```css
.plan-card {
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1rem;
  background: var(--color-surface-raised);
}
.plan-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.plan-label {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-accent);
}
.plan-section-header {
  font-size: 0.85rem;
  font-weight: 600;
  margin-top: 0.75rem;
  margin-bottom: 0.25rem;
}
.plan-item {
  margin-left: 1rem;
  font-size: 0.85rem;
  line-height: 1.5;
  list-style-type: disc;
}
```

#### 4.5 Wire into `AITab.tsx`

Add a "Generate Treatment Plan" button that calls `suggestPlan(sn, { session_focus: '' })` via `api.ts`. Show a `PlanCard` when a `treatment_plan` insight exists in the insights list. The button should be disabled while loading.

#### 4.6 Tests

In `tests/test_plan_api.py`:

- Test `POST /api/patient/{sn}/suggest_plan` returns 200 and a `plan` string in stub mode.
- Test 404 is returned for unknown patient SN.
- Test that a `treatment_plan` row is written to `patient_insights` after the call.
- Test that `plan_sessions=6` is accepted and surfaces correctly in the prompt context.

---

## 5. Cohort Percentile Ranks

### Context

Every patient view shows raw numbers (TUG = 11.2s, SPPB = 7). These are meaningless to clinicians without context. "Your patient's TUG improvement is in the 62nd percentile among frailty patients" is a finding. Raw numbers are not.

The existing `GET /api/patient/{sn}/benchmark` endpoint computes percentile rank but only for the current cohort. This feature extends it to compute `PERCENT_RANK()` per outcome metric partitioned by the patient's phenotype group (`grp_*` flag) as well as their cohort, and surfaces this in a new `BenchmarkCard` in the AI tab.

### Files to change

| File | Change |
|------|--------|
| `api/routers/benchmark.py` | Extend existing endpoint to return per-metric ranks |
| `api/services/benchmark.py` | New file (or inline in router): SQL-based percentile computation |
| `web/components/clinical/BenchmarkCard.tsx` | New component |
| `web/components/clinical/AITab.tsx` | Render `BenchmarkCard` |
| `web/lib/api.ts` | Add or extend `getPatientBenchmark(sn)` |
| `web/lib/types.ts` | Add `BenchmarkResult` type |
| `tests/test_benchmark_api.py` | New or extend existing test file |

### Step-by-step

#### 5.1 Design the SQL query

The query should compute `PERCENT_RANK()` for the target patient across the cohort population. For each metric where the patient has a value, compute what fraction of the cohort performs worse.

For `composite_improvement` (higher = better):
```sql
SELECT
    s_target.composite_improvement AS patient_value,
    PERCENT_RANK() OVER (
        PARTITION BY p.cohort
        ORDER BY s.composite_improvement ASC
    ) AS percentile_in_cohort
FROM sessions s
JOIN patients p ON p.id = s.patient_id
WHERE s.composite_improvement IS NOT NULL
  AND p.cohort = :cohort
```

For TUG (lower = better — TUG improvement means the number went down):
```sql
PERCENT_RANK() OVER (
    PARTITION BY p.cohort
    ORDER BY s.tug_change_pct DESC  -- more negative = bigger improvement = higher rank
) AS tug_improvement_percentile
```

Build this as a CTE or multiple sub-selects, one per metric. The final response should return:

```json
{
  "patient_sn": "QTX-0042",
  "cohort": "Frailty / Sarcopenia",
  "cohort_n": 142,
  "benchmarks": [
    {
      "metric": "composite_improvement",
      "patient_value": 0.42,
      "percentile": 0.78,
      "percentile_display": "78th",
      "n_compared": 112,
      "higher_is_better": true
    },
    {
      "metric": "tug_change_pct",
      "patient_value": -0.18,
      "percentile": 0.61,
      "percentile_display": "61st",
      "n_compared": 108,
      "higher_is_better": false
    }
  ]
}
```

#### 5.2 Implement `api/services/benchmark.py`

Create a new `BenchmarkService` class with a single method:

```python
class BenchmarkService:
    METRICS = [
        ("composite_improvement", True, "sessions"),
        ("tug_change_pct", False, "sessions"),   # lower TUG % change = better? No — tug_change_pct is negative when improved
        ("sst_change_pct", False, "sessions"),
        ("sppb_change", True, "sessions"),
        ("vas_change", False, "sessions"),        # negative vas_change = pain reduced = better
        ("normal_gs_change_pct", True, "sessions"),
        ("fast_gs_change_pct", True, "sessions"),
    ]

    def __init__(self, db: DBSession) -> None:
        self._db = db

    def compute(self, patient) -> dict:
        ...
```

For each metric, execute a raw SQL query using SQLAlchemy `text()` that:
1. Filters to all sessions in the same `cohort` as the patient (use `WHERE p.cohort = :cohort`).
2. Computes `PERCENT_RANK()` ordered by the metric value ascending or descending depending on `higher_is_better`.
3. Identifies the patient's own row and extracts their percentile.

Use a CTE to avoid running N separate queries:

```sql
WITH ranked AS (
    SELECT
        p.id AS patient_id,
        s.composite_improvement,
        s.tug_change_pct,
        s.sst_change_pct,
        s.sppb_change,
        s.vas_change,
        s.normal_gs_change_pct,
        s.fast_gs_change_pct,
        PERCENT_RANK() OVER (ORDER BY s.composite_improvement ASC NULLS LAST) AS pct_composite,
        PERCENT_RANK() OVER (ORDER BY s.tug_change_pct DESC NULLS LAST) AS pct_tug,
        PERCENT_RANK() OVER (ORDER BY s.sst_change_pct DESC NULLS LAST) AS pct_sst,
        PERCENT_RANK() OVER (ORDER BY s.sppb_change ASC NULLS LAST) AS pct_sppb,
        PERCENT_RANK() OVER (ORDER BY s.vas_change DESC NULLS LAST) AS pct_vas,
        PERCENT_RANK() OVER (ORDER BY s.normal_gs_change_pct ASC NULLS LAST) AS pct_ngs,
        PERCENT_RANK() OVER (ORDER BY s.fast_gs_change_pct ASC NULLS LAST) AS pct_fgs,
        COUNT(*) OVER () AS cohort_n
    FROM sessions s
    JOIN patients p ON p.id = s.patient_id
    WHERE p.cohort = :cohort
      AND s.ingested_from NOT ILIKE '%raise%'
)
SELECT * FROM ranked WHERE patient_id = :patient_id
```

Note: `tug_change_pct` is negative when the patient improved (TUG decreased). `PERCENT_RANK() ORDER BY tug_change_pct DESC` correctly ranks a value of -0.20 above -0.10, meaning 20% improvement beats 10%.

#### 5.3 Update `api/routers/benchmark.py`

Replace the existing implementation with one that calls `BenchmarkService.compute()` and returns the structured response.

#### 5.4 Create `web/components/clinical/BenchmarkCard.tsx`

A component that renders a horizontal bar chart row per metric, showing the percentile position as a filled bar. Use a simple CSS bar (no external chart library needed):

```tsx
function PercentileBar({ percentile, label, value, unit }: {
  percentile: number
  label: string
  value: number
  unit?: string
}) {
  const pct = Math.round(percentile * 100)
  const ordinal = pct === 1 ? '1st' : pct === 2 ? '2nd' : pct === 3 ? '3rd' : `${pct}th`

  return (
    <div className="benchmark-row">
      <div className="benchmark-label">{label}</div>
      <div className="benchmark-bar-track">
        <div className="benchmark-bar-fill" style={{ width: `${pct}%` }} />
        <span className="benchmark-bar-label">{ordinal} percentile</span>
      </div>
      <div className="benchmark-value">{value} {unit}</div>
    </div>
  )
}
```

Add this `BenchmarkCard` to the AI tab, rendered after `PredictionChips` and before `InsightCard` history.

#### 5.5 Tests

In `tests/test_benchmark_api.py`:

- Test that the endpoint returns a `benchmarks` array with at least one entry when the patient has session data.
- Test that `percentile` is between 0.0 and 1.0.
- Test that a patient who is the only one in their cohort gets `percentile = 0.0` (they rank last among themselves).
- Test 404 for unknown patient SN.

---

## 6. Wire Wearable Cadence into Fall Risk

### Context

`api/services/wearable_features.py` already computes `wearable_cadence_avg_30d` — the patient's average walking cadence over the last 30 days from Terra wearable data. This feature is stored in the `wearable_activity` table but is not used anywhere in inference. The fall risk adjuster in `prediction.py` ignores it. This task wires the computed cadence into the feature vector for the dosage model and adds it as a contextual signal in the anomaly detector.

Note: The fall risk model (`fall_risk_xgb.joblib`) is owned by a separate team and is excluded from this codebase. The cadence should be surfaced as context to Claude in the insight prompt and as an input to the anomaly detector (low-cadence = elevated fall risk signal).

### Files to change

| File | Change |
|------|--------|
| `api/services/wearable_features.py` | Verify `wearable_cadence_avg_30d` is computed and returned |
| `api/routers/sessions.py` | Load wearable features before building insight context; pass cadence to timeline |
| `api/services/anomaly.py` | Add `LOW_CADENCE` rule |
| `api/services/insight.py` | Add cadence to `_SYSTEM_PROMPT` context block |

### Step-by-step

#### 6.1 Verify wearable feature computation

Read `api/services/wearable_features.py` and confirm `wearable_cadence_avg_30d` is computed. If the function signature is `compute_wearable_features(patient_id, db, as_of_date)` → verify return dict contains `cadence_avg_30d` key.

#### 6.2 Load cadence in `sessions.py` before insight generation

In the session creation router, before calling `InsightService.generate_session_insight()`, add:

```python
from services.wearable_features import compute_wearable_features

wearable_feats = {}
try:
    wearable_feats = compute_wearable_features(
        patient_id=patient.id,
        db=db,
        as_of_date=session.session_date or date.today(),
    )
except Exception as exc:
    logger.warning("Wearable feature computation failed: %s", exc)

# Add to timeline context
timeline["wearable"] = {
    "cadence_avg_30d": wearable_feats.get("cadence_avg_30d"),
    "steps_avg_7d": wearable_feats.get("steps_avg_7d"),
}
```

#### 6.3 Add `LOW_CADENCE` anomaly rule

In `api/services/anomaly.py`, add:

```python
LOW_CADENCE_THRESHOLD = 80.0  # steps per minute — below this is associated with elevated fall risk

def _check_low_cadence(self, patient, wearable_feats: dict) -> list[AnomalyFlag]:
    cadence = wearable_feats.get("cadence_avg_30d")
    if cadence is not None and cadence < LOW_CADENCE_THRESHOLD:
        return [AnomalyFlag(
            rule_id="LOW_CADENCE",
            description=f"30-day average walking cadence is {cadence:.0f} steps/min "
                        f"(below fall-risk threshold of {LOW_CADENCE_THRESHOLD:.0f} steps/min)",
            severity="warning",
        )]
    return []
```

Update `check()` method signature to accept `wearable_feats: dict | None = None` and call `_check_low_cadence`.

#### 6.4 Surface in Claude context

In the `_SYSTEM_PROMPT` in `insight.py`, add one sentence:

```
Walking cadence (from wearable, if present): below 80 steps/min is associated with elevated fall risk — note and flag any wearable cadence value in this range.
```

#### 6.5 Tests

In `tests/test_wearable_features.py` (existing), add:

- Test that `LOW_CADENCE` fires when `cadence_avg_30d = 75` and does not fire at `90`.
- Test that the rule does not fire (no exception) when `cadence_avg_30d` is `None` (no wearable data).

---

## 7. Secrets Rotation and Environment Hardening

### Context

The `.env` file at the project root contains live API keys: `QTX_API_KEY`, `QTX_ADMIN_KEY`, `VOYAGE_API_KEY`, and `ANTHROPIC_API_KEY`. The file is in `.gitignore` but may be present in git history from a prior accidental commit. All four keys must be rotated and the project must be hardened to prevent future accidental exposure.

### Steps

#### 7.1 Rotate all four keys immediately

Generate new values:
```bash
# New QTX_API_KEY
python3 -c "import secrets; print(secrets.token_hex(32))"

# New QTX_ADMIN_KEY (must differ from QTX_API_KEY)
python3 -c "import secrets; print(secrets.token_hex(32))"

# Voyage: log into https://dash.voyageai.com and rotate the key
# Anthropic: log into https://console.anthropic.com and rotate the key
```

Update `.env` with all four new values. Update `web/.env.local` with the new `QTX_API_KEY` value for `NEXT_PUBLIC_API_KEY`.

#### 7.2 Clean git history

If the `.env` file was ever committed (check with `git log --all --full-history -- .env`), clean it:

```bash
# Using BFG Repo-Cleaner (recommended)
brew install bfg
bfg --delete-files .env --no-blob-protection
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force
```

If BFG is not available, use `git filter-branch`:
```bash
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch .env' \
  --prune-empty --tag-name-filter cat -- --all
```

#### 7.3 Add `.env` to `.gitignore` with verification

Confirm `.gitignore` contains `.env` (already present). Also add:
```
.env.local
.env.*.local
**/.env
**/retrain_state.json
```

#### 7.4 Add a pre-commit hook to block secrets

Create `.git/hooks/pre-commit`:

```bash
#!/bin/bash
# Block accidental commits of .env files or files containing API keys
if git diff --cached --name-only | grep -qE '\.env$|\.env\.local$'; then
    echo "ERROR: Attempt to commit an .env file. Remove it from staging and retry."
    exit 1
fi

# Scan for Anthropic key patterns
if git diff --cached | grep -qE 'sk-ant-[a-zA-Z0-9\-]{90,}'; then
    echo "ERROR: Possible Anthropic API key found in staged changes."
    exit 1
fi

# Scan for Voyage key patterns
if git diff --cached | grep -qE 'pa-[a-zA-Z0-9]{30,}'; then
    echo "ERROR: Possible Voyage API key found in staged changes."
    exit 1
fi
```

Make executable:
```bash
chmod +x .git/hooks/pre-commit
```

#### 7.5 Document the secret injection pattern in HANDOFF.md

Update the "Environment files" section in `HANDOFF.md` to explicitly state: "These files are gitignored. In production, inject all four keys as environment variables at the deployment layer. Never commit them to source control."

#### 7.6 Add `.env.example` with placeholder values

Create `.env.example` (safe to commit) showing required keys:

```
QTX_API_KEY=<generate with: python3 -c "import secrets; print(secrets.token_hex(32))">
QTX_ADMIN_KEY=<must differ from QTX_API_KEY>
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah
VOYAGE_API_KEY=<from dash.voyageai.com>
ANTHROPIC_API_KEY=<from console.anthropic.com>
LOG_LEVEL=INFO
RETRAIN_THRESHOLD=50
CALIBRATION_DRIFT_THRESHOLD=0.30
CALIBRATION_MIN_COHORT_N=20
TERRA_WEBHOOK_SECRET=
TERRA_DEV_ID=
TERRA_API_KEY=
```

---

## 8. CORS Hardening

### Context

`api/main.py` currently hard-codes `http://localhost:3000` as the allowed CORS origin. When the application is deployed, the frontend will be served from a different domain. CORS must be environment-driven rather than hardcoded.

### Files to change

| File | Change |
|------|--------|
| `api/main.py` | Read `ALLOWED_ORIGINS` from environment variable |
| `.env` | Add `ALLOWED_ORIGINS=http://localhost:3000` |
| `.env.example` | Document `ALLOWED_ORIGINS` |

### Step-by-step

#### 8.1 Update `api/main.py`

Find the `CORSMiddleware` configuration. Replace the hardcoded list with:

```python
import os

_raw_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

#### 8.2 Update `.env`

Add:
```
ALLOWED_ORIGINS=http://localhost:3000
```

For production, this will be set to the actual deployed frontend URL (e.g., `https://qtx.alexandrahospital.sg`).

#### 8.3 Tests

In `tests/test_middleware.py` (existing), add:

- Test that a request with `Origin: http://localhost:3000` succeeds when `ALLOWED_ORIGINS=http://localhost:3000`.
- Test that a request with `Origin: http://evil.example.com` is rejected when `ALLOWED_ORIGINS=http://localhost:3000`.
- Test that multiple origins work when `ALLOWED_ORIGINS=http://localhost:3000,http://staging.example.com`.

---

## 9. Background Task Queue for Retrain Jobs

### Context

`RetrainService.check_and_trigger()` and `CalibrationService.check_and_trigger()` currently spawn the retrain job by calling `subprocess.Popen` (or equivalent), which is synchronous from the API server's perspective. At the current scale of 1–2 sessions per day this is fine. As the programme scales, a slow retrain could block the session creation response.

This task wraps the retrain invocation in FastAPI's `BackgroundTasks` so it runs after the HTTP response is returned, and adds proper logging and state tracking for background job health.

### Files to change

| File | Change |
|------|--------|
| `api/routers/sessions.py` | Accept `BackgroundTasks` parameter; pass to services |
| `api/services/retrain.py` | Change `check_and_trigger()` to accept `BackgroundTasks` |
| `api/services/calibration.py` | Same change |

### Step-by-step

#### 9.1 Update `api/routers/sessions.py`

In the `create_session` route handler, add `background_tasks: BackgroundTasks` as a parameter:

```python
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

@router.post("/patient/{sn}/session")
def create_session(
    sn: str,
    body: NewSessionRequest,
    background_tasks: BackgroundTasks,
    db: DBSession = Depends(get_db),
):
    ...
    # Pass to services
    RetrainService(db).check_and_trigger(
        session_count=total_sessions,
        background_tasks=background_tasks,
    )
    CalibrationService.check_and_trigger(
        db=db,
        background_tasks=background_tasks,
    )
```

#### 9.2 Update `api/services/retrain.py`

Change `check_and_trigger` signature:

```python
from fastapi import BackgroundTasks

def check_and_trigger(self, session_count: int, background_tasks: BackgroundTasks) -> bool:
    ...
    if should_retrain:
        background_tasks.add_task(self._run_retrain_job)
        return True
    return False

def _run_retrain_job(self) -> None:
    """Runs in FastAPI background after response is sent."""
    import subprocess
    result = subprocess.run(
        [sys.executable, "scripts/18_scheduled_retrain.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        logger.error("Retrain job failed:\n%s", result.stderr)
    else:
        logger.info("Retrain job completed successfully")
```

#### 9.3 Update `api/services/calibration.py`

Apply the same pattern: accept `background_tasks: BackgroundTasks` and use `background_tasks.add_task()` instead of `Popen`.

#### 9.4 Tests

In `tests/test_retrain_service.py` (existing):

- Mock `BackgroundTasks` and verify `add_task` is called when the trigger condition is met.
- Verify `add_task` is NOT called when the threshold is not reached.

---

## 10. Session Preparation Workflow

### Context

The "Prepare Session" button already exists in `QAPanel.tsx` (wired to the ask endpoint with a pre-defined question). This task properly wires a dedicated pre-session briefing that generates a compact, focused summary of what the clinician needs to know before the patient walks in:

- Last session delta on every metric
- Current trend directions
- Model predictions and risk flags
- One or two specific questions to ask the patient

This is distinct from the general Q&A and the session summary. It should be generated on demand (not automatically after every session) and cached — regenerating it should only happen if the clinician requests it.

### Files to change

| File | Change |
|------|--------|
| `api/services/insight.py` | Add `generate_pre_session_brief()` method with dedicated prompt |
| `api/routers/ask.py` | Add dedicated `POST /api/patient/{sn}/prepare_session` endpoint |
| `web/components/clinical/QAPanel.tsx` | Wire "Prepare Session" button to new endpoint; cache result |
| `web/lib/api.ts` | Add `prepareSession(sn)` function |
| `tests/test_ask_api.py` | Add tests for prepare_session endpoint |

### Step-by-step

#### 10.1 Add prompt template to `api/services/insight.py`

```python
_PRE_SESSION_BRIEF_TEMPLATE = """\
Patient timeline data:
{timeline_json}

You are preparing a physiotherapist for their next session with this patient. \
The session has not happened yet — this is a pre-session briefing.

Provide a compact clinical briefing with these four sections (use the exact headers below):

**Last Session Summary** (2 sentences max)
What happened in the most recent session. Key metric changes only.

**Current Trajectory** (2 sentences max)
What the trends are telling us. Which metrics are improving, plateauing, or declining.

**Watch For Today** (3 bullet points)
The 3 most important things to observe or measure in today's session, grounded in this patient's specific data.

**Suggested Questions** (2 bullet points)
Two specific questions the physiotherapist should ask the patient at the start of the session."""
```

Add method:

```python
def generate_pre_session_brief(
    self,
    timeline: dict,
    patient_id: uuid.UUID,
    session_number: int,
) -> str:
    if not self._api_key:
        content = "[Pre-session brief unavailable — ANTHROPIC_API_KEY not configured]"
        self._save_insight(
            patient_id=patient_id,
            content=content,
            model="stub",
            insight_type="pre_session_brief",
            session_number=session_number,
        )
        return content

    user_message = _PRE_SESSION_BRIEF_TEMPLATE.format(
        timeline_json=json.dumps(timeline, indent=2),
    )
    try:
        content = self._call_claude(user_message)
    except Exception as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail="AI service unavailable") from exc

    embedding = VoyageEmbedder().embed(content, input_type="document")
    self._save_insight(
        patient_id=patient_id,
        content=content,
        model=self.MODEL,
        insight_type="pre_session_brief",
        session_number=session_number,
        embedding=embedding,
    )
    return content
```

#### 10.2 Add `POST /api/patient/{sn}/prepare_session` to `api/routers/ask.py`

```python
@router.post("/patient/{sn}/prepare_session")
def prepare_session(sn: str, db: DBSession = Depends(get_db)):
    patient = db.query(Patient).filter_by(sn=sn).first()
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")

    # Check if a pre_session_brief already exists for the latest session
    # to avoid regenerating on every button press
    latest_session = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id)
        .order_by(ClinicalSession.session_number.desc())
        .first()
    )
    session_number = latest_session.session_number if latest_session else 1

    existing = (
        db.query(PatientInsight)
        .filter_by(
            patient_id=patient.id,
            insight_type="pre_session_brief",
            session_number=session_number,
        )
        .order_by(PatientInsight.created_at.desc())
        .first()
    )
    if existing:
        db.close()
        return {"brief": existing.content, "cached": True}

    # Build timeline (same as ask endpoint)
    timeline = _build_timeline(patient, db)
    svc = InsightService(db)
    brief = svc.generate_pre_session_brief(
        timeline=timeline,
        patient_id=patient.id,
        session_number=session_number,
    )
    db.commit()
    return {"brief": brief, "cached": False}
```

Extract `_build_timeline(patient, db)` as a shared helper at the top of `ask.py` to avoid duplication with the Q&A endpoint.

#### 10.3 Update `QAPanel.tsx`

Replace the existing "Prepare Session" button handler with one that:
1. Calls `prepareSession(sn)` from `api.ts`
2. Shows a loading spinner while waiting
3. Renders the returned brief in a distinct `PreSessionCard` component (styled like an info panel, not an insight card)
4. Shows "Refreshing..." if the brief was cached and the clinician clicks again (add a `?force=true` param to skip the cache check)

#### 10.4 Tests

In `tests/test_ask_api.py`:

- Test that `POST /api/patient/{sn}/prepare_session` returns 200 with `brief` and `cached: false` for a patient with sessions.
- Test that a second call returns `cached: true` without re-calling Claude.
- Test 404 for unknown patient.

---

## 11. Comparative Cohort Response Curves

### Context

The CohortsPage shows static breakdowns but has no time-series view. Clinicians cannot see how quickly patients in a given phenotype group typically respond — which is the most clinically useful reference when setting patient expectations.

This feature adds a `cohort_response_curves` table that stores p25/p50/p75 percentile bands per outcome metric by session number, partitioned by `grp_*` phenotype group. A background job recomputes the curves after each retrain. The frontend renders a shaded percentile band behind the patient's own metric line in `MetricChart.tsx`.

### Files to change

| File | Change |
|------|--------|
| `api/models/clinical.py` | Add `CohortResponseCurve` ORM model |
| `scripts/24_migrate_cohort_response_curves.py` | New migration |
| `scripts/25_compute_cohort_response_curves.py` | New script to compute and upsert curves |
| `scripts/18_scheduled_retrain.py` | Call script 25 after successful retrain |
| `api/routers/cohorts.py` | New router (or extend patients.py): `GET /api/cohort/{grp_flag}/response_curves` |
| `api/main.py` | Register router |
| `web/components/charts/ResponseCurveChart.tsx` | New chart component |
| `web/components/pages/CohortsPage.tsx` | Render curve chart |
| `web/lib/types.ts` | Add `ResponseCurve` type |

### Step-by-step

#### 11.1 Add ORM model

In `api/models/clinical.py`, add:

```python
class CohortResponseCurve(Base):
    __tablename__ = "cohort_response_curves"
    __table_args__ = (
        UniqueConstraint("grp_flag", "metric", "session_number",
                         name="uq_response_curves_grp_metric_session"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    grp_flag: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    metric: Mapped[str] = mapped_column(String(50), nullable=False)
    session_number: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    p25: Mapped[float | None] = mapped_column(Numeric(8, 4), nullable=True)
    p50: Mapped[float | None] = mapped_column(Numeric(8, 4), nullable=True)
    p75: Mapped[float | None] = mapped_column(Numeric(8, 4), nullable=True)
    n: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
```

#### 11.2 Create migration `scripts/24_migrate_cohort_response_curves.py`

```python
"""Migration 24 — create cohort_response_curves table."""
from sqlalchemy import create_engine, text
import os

DB_URL = os.environ["DATABASE_URL"]
engine = create_engine(DB_URL)

with engine.begin() as conn:
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS cohort_response_curves (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            grp_flag VARCHAR(50) NOT NULL,
            metric VARCHAR(50) NOT NULL,
            session_number SMALLINT NOT NULL,
            p25 NUMERIC(8,4),
            p50 NUMERIC(8,4),
            p75 NUMERIC(8,4),
            n SMALLINT NOT NULL,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_response_curves_grp_metric_session
                UNIQUE (grp_flag, metric, session_number)
        );
        CREATE INDEX IF NOT EXISTS ix_response_curves_grp_flag
            ON cohort_response_curves (grp_flag);
    """))
    print("Migration 24 complete.")
```

#### 11.3 Create `scripts/25_compute_cohort_response_curves.py`

For each `grp_*` flag and each metric (`composite_improvement`, `tug_change_pct`, `sst_change_pct`, `sppb_change`, `vas_change`, `normal_gs_change_pct`, `fast_gs_change_pct`), compute the 25th/50th/75th percentile at each session number using PostgreSQL `PERCENTILE_CONT`:

```sql
SELECT
    s.session_number,
    COUNT(*) AS n,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY s.composite_improvement) AS p25,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY s.composite_improvement) AS p50,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY s.composite_improvement) AS p75
FROM sessions s
JOIN patients p ON p.id = s.patient_id
WHERE p.{grp_flag} = true
  AND s.composite_improvement IS NOT NULL
  AND s.ingested_from NOT ILIKE '%raise%'
GROUP BY s.session_number
HAVING COUNT(*) >= 5
ORDER BY s.session_number
```

Upsert results into `cohort_response_curves` with `ON CONFLICT DO UPDATE`. Run this for all 9 `grp_*` flags × 7 metrics = 63 queries (fast — each is a single aggregation).

#### 11.4 Add `GET /api/cohort/{grp_flag}/response_curves` endpoint

Returns all curve data for a given group flag, optionally filtered by metric:

```json
{
  "grp_flag": "grp_frailty_sarcopenia",
  "curves": [
    {
      "metric": "composite_improvement",
      "points": [
        {"session_number": 1, "p25": 0.02, "p50": 0.12, "p75": 0.31, "n": 142},
        {"session_number": 2, "p25": 0.05, "p50": 0.18, "p75": 0.44, "n": 38}
      ]
    }
  ]
}
```

#### 11.5 Update `MetricChart.tsx` to show population bands

When `grp_flag` is available (from the patient's phenotype), fetch the response curves for that group and overlay the p25–p75 band as a shaded area behind the patient's line. The patient's own trajectory should be a solid line; the band should be a semi-transparent fill.

Use the Recharts `AreaChart` or add a shaded `ReferenceArea` to the existing Plotly chart. Keep the population band muted (opacity 0.15) so it does not obscure the patient line.

---

## 12. Admin Dashboard for Model Health

### Context

Model health is currently visible via `ModelHealthCard` on the Overview page, but there is no dedicated admin view for: current model versions, last retrain timestamp, training set size, CV metrics history, and a trigger button for manual retraining. This information is all available from `retrain_state.json` and `GET /api/calibration` but requires SSH access to view.

### Files to change

| File | Change |
|------|--------|
| `api/routers/admin.py` | Add `GET /api/admin/model_status` endpoint |
| `api/main.py` | Ensure admin router is registered (it already is) |
| `web/components/pages/AdminPage.tsx` | New page |
| `web/components/clinical/ModelHealthCard.tsx` | Extend to show full status from new endpoint |
| `web/app/layout.tsx` or `Sidebar.tsx` | Add "Admin" nav item |
| `web/lib/api.ts` | Add `getModelStatus()` and `triggerRetrain()` |

### Step-by-step

#### 12.1 Add `GET /api/admin/model_status` to `api/routers/admin.py`

This endpoint requires the same `X-Admin-Key` header as `reload-models`.

```python
@router.get("/admin/model_status")
def get_model_status(request: Request):
    _verify_admin_key(request)
    
    import json
    from pathlib import Path
    
    state_path = Path(__file__).resolve().parent.parent.parent / "retrain_state.json"
    state = {}
    if state_path.exists():
        state = json.loads(state_path.read_text())

    models_dir = Path(__file__).resolve().parent.parent.parent / "models"
    model_files = {}
    for f in models_dir.glob("*.joblib"):
        stat = f.stat()
        model_files[f.name] = {
            "size_mb": round(stat.st_size / 1_048_576, 2),
            "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        }

    return {
        "models": model_files,
        "retrain_state": state,
        "db_ready": deps._db_ready,
    }
```

#### 12.2 Add `POST /api/admin/trigger_retrain` to `api/routers/admin.py`

```python
@router.post("/admin/trigger_retrain")
def trigger_retrain(request: Request, background_tasks: BackgroundTasks):
    _verify_admin_key(request)
    
    def _run():
        import subprocess, sys
        from pathlib import Path
        ROOT = Path(__file__).resolve().parent.parent.parent
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "18_scheduled_retrain.py")],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            logger.error("Manual retrain failed:\n%s", result.stderr)
        else:
            logger.info("Manual retrain completed")

    background_tasks.add_task(_run)
    return {"status": "retrain_scheduled"}
```

#### 12.3 Create `web/components/pages/AdminPage.tsx`

Build a page that:

1. Shows a table of model files with size and last-modified timestamp.
2. Shows the contents of `retrain_state.json` in a formatted display: last retrain at, training set size, CV metrics (RMSE, MAE, R², AUC-ROC).
3. Shows `GET /api/calibration` output (per-cohort drift status) — this is already rendered in `ModelHealthCard` but should be repeated here in full.
4. Has a "Trigger Manual Retrain" button that calls `POST /api/admin/trigger_retrain`. The button should be disabled for 30 seconds after clicking (retrain runs in background; no webhook to confirm completion).
5. Has a "Hot-reload Models" button that calls `POST /api/admin/reload-models`.

The page should be accessible at `/admin` in the Next.js app and require an admin key entered via a simple text input stored in `sessionStorage` (not `localStorage` — expires when tab closes).

#### 12.4 Add "Admin" nav item to `Sidebar.tsx`

Add a gear icon link to `/admin` at the bottom of the sidebar. This does not need auth at the nav level — the page itself prompts for the admin key before showing data.

---

## 13. Wire POST /api/import/file to Real Pipeline

### Context

`POST /api/import/file` in `api/routers/import_data.py` exists but the implementation is illustrative — it accepts a file upload but does not actually run the `src/qtx/` pipeline. This task wires the uploaded file through the full pipeline: ingestion → cleaning → phenotyping → outcomes → feature engineering → DB upsert.

### Files to change

| File | Change |
|------|--------|
| `api/routers/import_data.py` | Replace stub implementation with real pipeline call |
| `api/services/ingest.py` | Verify `IngestPipeline.upsert_from_df(df)` accepts a fully-processed DataFrame |

### Step-by-step

#### 13.1 Implement the pipeline in `import_data.py`

The upload handler should:

1. Save the uploaded file to a temp path.
2. Call each pipeline stage in order via subprocess or direct import:
   - `qtx.io.load.load_excel(path)` → raw DataFrame
   - `qtx.clean.pipeline.clean(df, cfg)` → cleaned DataFrame
   - `qtx.phenotype.tagger.tag(df, cfg)` → phenotyped DataFrame
   - `qtx.outcomes.pipeline.compute_outcomes(df, cfg)` → outcomes DataFrame
   - `qtx.features.builder.build_features(df, cfg)` → featured DataFrame
3. Pass the featured DataFrame to `IngestPipeline(db).upsert(df)`.
4. Return an `IngestSummary` with counts of inserted, updated, and errored rows.

```python
@router.post("/import/file")
async def import_file(
    file: UploadFile = File(...),
    db: DBSession = Depends(get_db),
):
    import tempfile, shutil
    from pathlib import Path
    from qtx.utils.config import get_cleaning_config, get_phenotype_config, get_outcomes_config

    suffix = Path(file.filename).suffix if file.filename else ".xlsx"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    try:
        from qtx.io.load import load_excel
        from qtx.clean.pipeline import clean
        from qtx.phenotype.tagger import tag
        from qtx.outcomes.pipeline import compute_outcomes
        from qtx.features.builder import build_features

        raw = load_excel(tmp_path)
        cleaned = clean(raw, get_cleaning_config())
        phenotyped = tag(cleaned, get_phenotype_config())
        outcomes_df = compute_outcomes(phenotyped, get_outcomes_config())
        featured = build_features(outcomes_df)

        pipeline = IngestPipeline(db)
        summary = pipeline.upsert(featured)
        db.commit()

        return {
            "inserted": summary.inserted,
            "updated": summary.updated,
            "errors": summary.errors,
            "filename": file.filename,
        }
    finally:
        tmp_path.unlink(missing_ok=True)
```

If any pipeline stage raises an exception, return HTTP 422 with the error message. The upload file is always cleaned up in `finally`.

#### 13.2 Tests

In `tests/test_import_api.py` (existing), add:

- An integration test that uploads a minimal valid Excel file and verifies `inserted > 0`.
- A test that uploading a malformed file returns 422 with an informative error message.

---

## 14. Retire Streamlit Dashboard

### Context

`dashboard/app.py` (Streamlit) was the original UI before the Next.js application was built. It reads from `data/processed/dashboard_data.parquet`, which is no longer updated. The canonical UI is `web/`. Keeping both creates confusion about which one is authoritative.

### Steps

#### 14.1 Verify the Streamlit dashboard is truly unused

Confirm that `dashboard/app.py` and `dashboard/app_external.py` do not contain any logic that has not been replicated in `web/` or `api/`. The Makefile's `make dashboard` target points to these files.

#### 14.2 Remove or archive

Option A (preferred): delete `dashboard/` entirely and remove the `dashboard` target from `Makefile`.

Option B: move to `dashboard/_archive/` and update `Makefile` to remove the target.

If deleting, run `grep -r "dashboard/" . --include="*.py" --include="*.md"` first to catch any remaining references.

#### 14.3 Update HANDOFF.md and README.md

Remove the Streamlit setup instructions from both docs. The canonical UI is the Next.js app started via `make dev`.

---

## 15. Dosage and Dropout Calibration Tracking

### Context

`CalibrationService` tracks MAE drift for the **regression** model (composite improvement prediction) per cohort. It alerts when per-cohort MAE drifts ≥30% from the baseline established at last retrain. However, the classifier (responder prediction, AUC = 0.739) and dropout model (AUC = 0.998) are not tracked at all. If their performance degrades silently, the system will surface unreliable risk signals without any warning.

This task adds AUC drift tracking for the classifier and dropout models to `retrain_state.json` and surfaces them in `GET /api/calibration`.

### Files to change

| File | Change |
|------|--------|
| `api/services/calibration.py` | Add AUC drift computation for classifier and dropout models |
| `scripts/18_scheduled_retrain.py` | Write AUC baselines for classifier and dropout after retrain |
| `api/routers/calibration.py` | No change (already returns `CalibrationService.get_report()`) |
| `web/components/clinical/ModelHealthCard.tsx` | Render classifier and dropout AUC status |
| `tests/test_calibration_service.py` | Extend tests |

### Step-by-step

#### 15.1 Update `retrain_state.json` schema

After retraining, `scripts/18_scheduled_retrain.py` writes `calibration_baseline: {cohort: mae}` to track regression. Add two new top-level keys:

```json
{
  "last_retrain_at": "...",
  "last_retrain_session_count": 1877,
  "last_metrics": {
    "regression_mae": 0.411,
    "regression_rmse": 0.589,
    "regression_r2": 0.038
  },
  "calibration_baseline": {
    "Pain & Musculoskeletal": 0.415,
    "Neurological": 0.425,
    "Frailty / Sarcopenia": 0.361
  },
  "classifier_auc_baseline": 0.739,
  "dropout_auc_baseline": 0.998
}
```

In `scripts/18_scheduled_retrain.py`, in `_retrain_classifier()` and `_retrain_dropout()`, compute mean CV AUC and write to state:

```python
state["classifier_auc_baseline"] = float(mean_cv_auc_classifier)
state["dropout_auc_baseline"] = float(mean_cv_auc_dropout)
_write_state(state)
```

#### 15.2 Add AUC drift check to `CalibrationService.get_report()`

In `api/services/calibration.py`, after building the per-cohort MAE report, add:

```python
# Classifier AUC drift
classifier_auc_baseline = state.get("classifier_auc_baseline")
current_classifier_auc = cls._compute_current_classifier_auc(db)

# Dropout AUC drift
dropout_auc_baseline = state.get("dropout_auc_baseline")
current_dropout_auc = cls._compute_current_dropout_auc(db)
```

For `_compute_current_classifier_auc(db)`: query `session_predictions.responder_probability` joined to `sessions.overall_responder` for sessions with both values. Compute AUC-ROC using `sklearn.metrics.roc_auc_score`. Return `None` if fewer than 20 paired rows.

Append to the report:
```json
{
  "model_auc_drift": [
    {
      "model": "classifier",
      "baseline_auc": 0.739,
      "current_auc": 0.731,
      "drift_pct": -1.1,
      "status": "OK",
      "n": 342
    },
    {
      "model": "dropout",
      "baseline_auc": 0.998,
      "current_auc": 0.995,
      "drift_pct": -0.3,
      "status": "OK",
      "n": 342
    }
  ]
}
```

Status thresholds for AUC (lower AUC = worse): `OK` if drift > -5%, `WARNING` if -5% to -10%, `ALERT` if < -10%. Note the direction: for AUC, drift is `(current - baseline) / baseline * 100`. A positive drift means the model improved; negative means degraded.

#### 15.3 Update `ModelHealthCard.tsx`

Add a second section below the existing cohort MAE table. For each entry in `model_auc_drift`:

```tsx
<tr>
  <td>{entry.model === 'classifier' ? 'Responder Classifier' : 'Dropout Predictor'}</td>
  <td>{entry.baseline_auc.toFixed(3)}</td>
  <td>{entry.current_auc?.toFixed(3) ?? '—'}</td>
  <td>{entry.drift_pct !== null ? `${entry.drift_pct > 0 ? '+' : ''}${entry.drift_pct.toFixed(1)}%` : '—'}</td>
  <td><StatusPill status={entry.status} /></td>
</tr>
```

#### 15.4 Tests

In `tests/test_calibration_service.py` (existing), add:

- Test that `_compute_current_classifier_auc` returns `None` when fewer than 20 paired rows exist.
- Test that AUC drift status is `OK` at -3%, `WARNING` at -7%, `ALERT` at -12%.
- Test that `get_report()` includes a `model_auc_drift` key in its return value.
- Test that `classifier_auc_baseline` and `dropout_auc_baseline` are written to `retrain_state.json` after retrain.

---

## Implementation Order Recommendation

For maximum ROI given the current state of the system:

| Order | Feature | Reason |
|-------|---------|--------|
| 1 | **#7 — Secrets Rotation** | Must be done before any external access. Blocks go-live. |
| 2 | **#8 — CORS Hardening** | Two-line change. Blocks go-live. |
| 3 | **#1 — Regression Retrain** | Fixes R² credibility gap. Needed before demos to hospital. |
| 4 | **#3 — Anomaly Detection** | High clinical value. Uses existing trend + prediction infrastructure. |
| 5 | **#4 — Treatment Plan Generation** | Highest new clinical value. First output clinicians can act on. |
| 6 | **#2 — Bayesian Residual Correction** | Low effort, improves prediction quality automatically per patient. |
| 7 | **#5 — Cohort Percentile Ranks** | Transforms raw numbers into clinically interpretable signals. |
| 8 | **#9 — Background Task Queue** | Architectural hygiene. Prevents retrain from blocking session response. |
| 9 | **#10 — Session Preparation** | Clinician UX. The brief before every session. |
| 10 | **#15 — Calibration Tracking** | Completes model observability. Classifier + dropout drift now tracked. |
| 11 | **#11 — Cohort Response Curves** | Big-bet feature. Requires schema + script + frontend chart. |
| 12 | **#12 — Admin Dashboard** | Operational tooling. Useful when the team grows. |
| 13 | **#6 — Wearable Cadence** | Wires an existing computed feature. Low-risk addition. |
| 14 | **#13 — Import File Pipeline** | Infrastructure. Enables real-time data ingestion from UI. |
| 15 | **#14 — Retire Streamlit** | Cleanup. Do last to avoid confusion during active development. |

---

## Testing Conventions

All new test files must:

1. Live in `tests/` alongside existing test files.
2. Add `api/` and `src/` to `sys.path` at the top (follow pattern in existing test files).
3. Use pytest fixtures from `tests/conftest.py` where applicable.
4. Not require a live database — mock `get_db()` using `unittest.mock.patch` or an in-memory SQLite substitute.
5. Not require live API keys — stub the Anthropic and Voyage clients by checking for `ANTHROPIC_API_KEY` absence (existing `InsightService.STUB_RESPONSE` pattern handles this).

Run all tests with:
```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -v
```

Expected: all 483 existing tests continue to pass. New tests add to this count.
