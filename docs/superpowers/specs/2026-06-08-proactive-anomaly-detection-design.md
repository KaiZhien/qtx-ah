# Proactive Anomaly Detection — Design Spec

**Date:** 2026-06-08
**Status:** Approved
**Scope:** Backend service + API endpoint + frontend warning card

---

## Overview

After every `POST /api/patient/{sn}/session`, a new `AnomalyDetector` service evaluates four rule conditions against the freshly created session, updated trends, and latest ML predictions. If any rule fires, it makes a targeted Claude call (~256 tokens) to generate a clinical warning note and persists it as a `PatientInsight` row. The frontend surfaces the most recent warning as an amber card above `PredictionChips` in the AI tab.

The feature makes the AI layer proactive rather than reactive — clinicians see safety signals without having to ask.

---

## Architecture & Data Flow

```
POST /api/patient/{sn}/session
  │
  ├── 1. PredictionService.run()         → SessionPrediction row
  ├── 2. InsightService.generate_session_insight()  → PatientInsight (session_summary)
  ├── 3. AnomalyDetector.check_and_warn()           → PatientInsight (anomaly_warning) | no-op
  ├── 4. RetrainService.check_and_trigger()
  └── 5. CalibrationService.check_and_trigger()
```

`AnomalyDetector` is called after `InsightService` commits so it has access to:
- The newly created `ClinicalSession` ORM object (raw measurements)
- The `TrendResult` list returned by `TrendEngine` (fresh, not stale)
- The `predictions` dict from `PredictionService` (or `None` if models not loaded)
- The `Patient` ORM object (phenotype flags)

Failures are caught, logged at WARNING, and swallowed — they never fail the session creation response.

---

## Anomaly Rules

Rules are evaluated by a pure function `_detect_flags()` — no DB access, no I/O. Returns a list of `AnomalyFlag` named strings. The Claude call is only made when the list is non-empty.

| # | Name | Condition | Flag string |
|---|------|-----------|-------------|
| 1 | Metric regression | Any `TrendResult` has `direction == "declining"` | `"metric_declining:{metric_name}"` |
| 2 | Pain worsened | `session.post_vas > session.pre_vas` (both non-null) | `"pain_worsened"` |
| 3 | Responder–outcome mismatch | `session.composite_improvement < 0` AND `predictions["responder_probability"] > 0.5` | `"responder_mismatch"` |
| 4 | Unregistered fall risk | `session.post_tug_s > 12.0` AND `patient.has_fall_risk == False` | `"fall_risk_unregistered"` |

Rule 1 can produce multiple flags (one per declining metric). Rules 2–4 produce at most one flag each. All fired flags are included verbatim in the Claude prompt so the generated warning is grounded in specific named findings.

---

## New Service: `api/services/anomaly.py`

```python
class AnomalyDetector:
    def __init__(self, db: DBSession) -> None: ...

    def check_and_warn(
        self,
        patient: Patient,
        session: ClinicalSession,
        trends: list[TrendResult],
        predictions: dict | None,
        session_number: int,
    ) -> str | None:
        """
        Evaluate rules, call Claude if flags fire, persist PatientInsight.
        Returns warning text or None. Must be called inside an open transaction.
        """
```

Internal methods:
- `_detect_flags(patient, session, trends, predictions) → list[str]` — pure, no I/O
- `_build_warning_prompt(flags, session) → str` — formats the Claude user message
- `_call_claude(user_message) → str` — same pattern as InsightService._call_claude()
- `_save_warning(patient_id, content, session_number) → None` — persists PatientInsight row

**Stub mode:** If `ANTHROPIC_API_KEY` is not set and flags fire, persists a placeholder string (same stub pattern as `InsightService`) and returns it. Does not raise.

**No flags:** Returns `None` immediately, no DB write, no Claude call.

---

## Claude Prompt

Uses the existing `_SYSTEM_PROMPT` from `insight.py` (imported, not duplicated).

User message template:
```
Anomaly flags detected after session {session_number}:
{flag_list}

Session measurements: pre_tug={pre_tug_s}s, post_tug={post_tug_s}s,
pre_vas={pre_vas}, post_vas={post_vas},
composite_improvement={composite_improvement},
responder_probability={responder_probability}.

In 2–3 sentences, explain what these flags mean clinically and what the
treating physiotherapist should monitor or investigate at the next session.
Be specific to the flags listed above.
```

`max_tokens=256`. The tight token budget forces a concise, actionable note.

---

## Storage

Persisted as a `PatientInsight` row with:

| Field | Value |
|-------|-------|
| `insight_type` | `"anomaly_warning"` |
| `session_number` | current session number |
| `content` | Claude response text (or stub) |
| `model` | `"claude-sonnet-4-6"` (or `"stub"`) |
| `embedding` | `None` — anomaly warnings are not semantically retrieved |
| `question` | `None` |

No migration required — `PatientInsight` already supports this shape. The new `insight_type` value is the only addition.

---

## New API Endpoint

**`GET /api/patient/{sn}/anomalies/latest`**

Location: `api/routers/anomaly.py` (new file, registered in `main.py`).

Auth: standard `X-Api-Key` middleware (same as all patient endpoints).

Response when warning exists:
```json
{
  "session_number": 4,
  "content": "TUG exceeded fall-risk threshold at 13.2 s...",
  "created_at": "2026-06-08T10:32:00+00:00"
}
```

Response when no warning exists:
```json
null
```

Query: `PatientInsight` filtered by `patient_id + insight_type="anomaly_warning"`, ordered by `session_number DESC`, `limit 1`.

Error responses: `404` if patient not found, `503` if DB not ready.

---

## Session Pipeline Change (`api/routers/sessions.py`)

```python
# After InsightService commit — step 3
try:
    from services.anomaly import AnomalyDetector
    AnomalyDetector(db).check_and_warn(
        patient, session, trends, predictions, new_sn
    )
    db.commit()
except Exception as exc:
    logger.warning("Anomaly detection failed: %s", exc)
```

`trends` is the `list[TrendResult]` already returned by `TrendEngine.compute_and_save()` and currently only used for the response body. It is passed directly to `AnomalyDetector` — no additional DB query needed.

---

## Frontend

### New type (`web/lib/types.ts`)
```typescript
export interface AnomalyWarning {
  session_number: number;
  content: string;
  created_at: string;
}
```

### New fetch function (`web/lib/api.ts`)
```typescript
export async function fetchLatestAnomaly(sn: string): Promise<AnomalyWarning | null>
```
Calls `GET /api/patient/{sn}/anomalies/latest`, returns parsed JSON or `null` on 404/null response.

### New component (`web/components/clinical/AnomalyWarningCard.tsx`)

Amber left-border card (consistent with existing warning styling in `PredictionChips`). Renders:
- Warning icon + "Clinical Alert — Session {session_number}" header
- The Claude warning text
- Does not render when `warning` prop is `null`

### `AITab.tsx` changes

Add `fetchLatestAnomaly(sn)` to the existing `Promise.all`. Store result in `anomaly` state. Render `<AnomalyWarningCard warning={anomaly} />` above the "Model signals" section when non-null.

---

## Testing

### `tests/test_anomaly_service.py`
- Each of the four rules fires correctly given matching input
- Each rule does not fire when condition is not met
- Multiple flags can fire in the same session
- No flags → `check_and_warn` returns `None`, no DB row written, no Claude call
- Stub mode (no API key): flags fire → stub row persisted, no exception raised
- `_detect_flags` is tested as a pure function (no DB required)

### `tests/test_anomaly_api.py`
- `GET /api/patient/{sn}/anomalies/latest` returns `null` when no warning rows exist
- Returns the most recent warning (by session_number) when multiple exist
- Returns `404` for unknown patient SN
- Returns `401` without `X-Api-Key`

---

## Files Changed

| File | Change |
|------|--------|
| `api/services/anomaly.py` | **New** — AnomalyDetector service |
| `api/routers/anomaly.py` | **New** — GET /api/patient/{sn}/anomalies/latest |
| `api/main.py` | Register new anomaly router |
| `api/routers/sessions.py` | Add AnomalyDetector call to session pipeline |
| `web/lib/types.ts` | Add AnomalyWarning type |
| `web/lib/api.ts` | Add fetchLatestAnomaly function |
| `web/components/clinical/AnomalyWarningCard.tsx` | **New** — warning card component |
| `web/components/clinical/AITab.tsx` | Fetch anomaly + render AnomalyWarningCard |
| `tests/test_anomaly_service.py` | **New** — service unit tests |
| `tests/test_anomaly_api.py` | **New** — API endpoint tests |
