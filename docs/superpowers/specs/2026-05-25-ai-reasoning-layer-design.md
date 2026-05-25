# Sub-project 3 — AI Reasoning Layer: Design Spec

**Date:** 2026-05-25
**Status:** Approved — ready for implementation plan

---

## Goal

Add Claude-powered clinical insight generation to the platform. After each new session, Claude automatically summarises the patient's progress trajectory. Clinicians can also ask free-text questions about any patient and get answers grounded purely in that patient's own data.

---

## Architecture

```
POST /api/patient/{sn}/session
        │  (existing: create session, run TrendEngine)
        │
        ▼
  InsightService.generate_session_insight(timeline, session_number, db)
        │  builds prompt from timeline dict
        │  calls Anthropic claude-sonnet-4-6
        │  saves PatientInsight row to DB
        └──▶  returns insight text

        Response: { sn, session_number, trends, insight }

POST /api/patient/{sn}/ask
        │
        ▼
  InsightService.answer_question(timeline, question, db)
        │  builds prompt with question appended
        │  calls Claude
        │  saves PatientInsight row (type=qa_response)
        └──▶  returns { answer, model }

GET /api/patient/{sn}/insights
        └──▶  lists all saved PatientInsight rows for patient (ordered by created_at desc)
```

All three endpoints share `InsightService`. The only differences are the prompt template used and the `insight_type` stored.

---

## 1. Schema — `PatientInsight` table

New ORM model added to `api/models/clinical.py`.

```python
class PatientInsight(Base):
    __tablename__ = "patient_insights"

    id:             UUID PK
    patient_id:     UUID FK → patients.id  CASCADE DELETE
    session_number: SmallInt  nullable   — set for session_summary, null for qa_response
    insight_type:   String(20) NOT NULL  — "session_summary" | "qa_response"
    question:       Text       nullable  — set for qa_response, null for session_summary
    content:        Text       NOT NULL  — generated text from Claude
    model:          String(50) NOT NULL  — e.g. "claude-sonnet-4-6"
    created_at:     DateTime(tz) NOT NULL  default utcnow
```

No unique constraint — multiple insights per patient/session are allowed (clinicians may regenerate).

---

## 2. InsightService

**`api/services/insight.py`** — single class, two public methods.

```python
class InsightService:
    STUB_RESPONSE = "[AI insights unavailable — ANTHROPIC_API_KEY not configured]"
    MODEL = "claude-sonnet-4-6"

    def __init__(self, db: DBSession) -> None: ...

    def generate_session_insight(
        self, timeline: dict, session_number: int
    ) -> str: ...

    def answer_question(
        self, timeline: dict, question: str
    ) -> str: ...
```

### Stub mode

If `ANTHROPIC_API_KEY` is absent from the environment, both methods return `STUB_RESPONSE` immediately and save a `PatientInsight` row with `content = STUB_RESPONSE` and `model = "stub"`. No exception is raised.

### System prompt (shared)

> *"You are a clinical physiotherapy assistant reviewing longitudinal data for a single patient. Reason only from the data provided. Do not compare this patient to others. Be concise and clinically relevant. Never speculate beyond what the data supports."*

### Session summary prompt

User message:
```
Patient timeline data:
{timeline_json}

The patient just completed session {N}. In 3–5 bullet points, summarise:
1. Overall progress trajectory across all sessions
2. Notable changes in this session compared to prior sessions
3. Any measurements that warrant clinician attention
```

### Q&A prompt

User message:
```
Patient timeline data:
{timeline_json}

Clinician question: {question}

Answer the question in 2–4 sentences based only on this patient's data above.
```

### Error handling

Anthropic API errors (timeout, rate limit, 5xx) are caught and re-raised as `HTTPException(502, "AI service unavailable")`. No `PatientInsight` row is saved on error.

---

## 3. API Endpoints

Implemented in **`api/routers/ask.py`**, registered at prefix `/api`.

### `POST /api/patient/{sn}/ask`

**Request body:**
```json
{ "question": "Is her gait speed improving fast enough for discharge planning?" }
```

**Response 200:**
```json
{
  "answer": "Based on two sessions, gait speed has improved from 0.9 to 1.1 m/s — an early signal but not yet confirmed. With only 2 data points, discharge planning is premature.",
  "model": "claude-sonnet-4-6"
}
```

**Errors:** 404 patient not found, 503 DB not ready, 502 AI service unavailable.

### `GET /api/patient/{sn}/insights`

Returns all `PatientInsight` rows for the patient, ordered by `created_at` descending.

**Response 200:**
```json
[
  {
    "id": "uuid",
    "session_number": 2,
    "insight_type": "session_summary",
    "question": null,
    "content": "- Pain score improved from 6.0 to 3.0...\n- TUG shows early improving signal...",
    "model": "claude-sonnet-4-6",
    "created_at": "2026-05-25T10:00:00Z"
  },
  {
    "id": "uuid",
    "session_number": null,
    "insight_type": "qa_response",
    "question": "Is her gait speed improving fast enough for discharge planning?",
    "content": "Based on two sessions, gait speed has improved...",
    "model": "claude-sonnet-4-6",
    "created_at": "2026-05-25T10:05:00Z"
  }
]
```

**Errors:** 404 patient not found, 503 DB not ready.

### Modified: `POST /api/patient/{sn}/session`

Response now includes `insight`:
```json
{
  "sn": "1",
  "session_number": 2,
  "trends": [...],
  "insight": "- Pain score improved from 6.0 to 3.0 this session...\n- TUG shows early improving signal..."
}
```

---

## 4. Environment

Add to `.env.example`:
```
# Required for AI insight generation (Sub-project 3)
# Sign Anthropic BAA before sending patient data to production
ANTHROPIC_API_KEY=
```

---

## 5. File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `api/models/clinical.py` | Modify | Add `PatientInsight` model |
| `api/services/insight.py` | Create | `InsightService` — prompt building, Anthropic API call, DB save |
| `api/routers/ask.py` | Create | `POST /api/patient/{sn}/ask`, `GET /api/patient/{sn}/insights` |
| `api/routers/sessions.py` | Modify | Call `InsightService` after `TrendEngine`, add `insight` to response |
| `api/main.py` | Modify | Register `ask` router |
| `.env.example` | Modify | Add `ANTHROPIC_API_KEY` |
| `tests/test_insight.py` | Create | `InsightService` unit tests with monkeypatched Anthropic client |
| `tests/test_ask_api.py` | Create | `POST /ask` and `GET /insights` API tests |

---

## 6. Testing Strategy

- **`tests/test_insight.py`** — unit tests for `InsightService` using a monkeypatched Anthropic client. Covers: stub mode returns `STUB_RESPONSE` and saves row with `model="stub"`, real mode sends correct system prompt and saves insight row, `answer_question` saves row with correct `insight_type="qa_response"` and `question` field set, Anthropic error raises 502.
- **`tests/test_ask_api.py`** — API tests using `TestClient` + SQLite in-memory + `InsightService` monkeypatched to return fixed text. Covers: `POST /ask` returns 200 with `answer`, `GET /insights` returns ordered list, `POST /session` response includes `insight` key, 404 on unknown sn for both endpoints, 503 when `_db_ready = False`, stub mode returns 200.
- Existing `test_sessions_api.py` updated: `POST /session` response now includes `insight` — assertions loosened to allow the extra key (no test currently checks for its absence).

---

## 7. Out of Scope (Sub-project 4)

- Embeddings (Voyage-3-lite) and semantic search over sessions
- Multi-turn conversation history
- Frontend insight cards and Q&A interface
- PDF export of insights
- Prompt editing UI
- Streaming responses
