# Voyage Embeddings + AI Tab — Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify all new Voyage/InsightService/AITab implementations are correct by confirming 30 existing tests pass, filling 7 coverage gaps, fixing 57 deprecation warnings, and confirming TypeScript is clean.

**Architecture:** All production code lives in `api/services/` (Python/FastAPI). Tests are in `tests/` and use SQLite in-memory with monkeypatched external calls. Frontend type safety is validated by `tsc --noEmit` — no Jest setup.

**Tech Stack:** Python 3.14, pytest 9, FastAPI TestClient, SQLAlchemy 2, Next.js 14, TypeScript 5

---

## Pre-flight: Confirmed state

- **Test runner:** `PYTHONPATH=src:api .venv/bin/pytest` (from project root)
- **All 30 existing tests:** PASSING
- **TypeScript:** `cd web && npx tsc --noEmit` → exits 0, no errors
- **Known issues:** 57 `DeprecationWarning: datetime.utcnow()` from `api/services/insight.py:86` and `api/services/trend.py:124,132`

---

## Files touched

| File | Action |
|---|---|
| `tests/test_voyage.py` | Add 2 gap tests |
| `tests/test_insight.py` | Add 3 gap tests |
| `tests/test_ask_api.py` | Add 2 gap tests |
| `api/services/insight.py` | Fix `datetime.utcnow()` → `datetime.now(timezone.utc)` |

---

## Task 1: Add gap tests to test_voyage.py

**Files:**
- Modify: `tests/test_voyage.py`

- [ ] **Step 1: Add the two gap tests at the bottom of `tests/test_voyage.py`**

Append after the last existing test (`test_embed_uses_correct_input_type`):

```python
def test_embed_passes_timeout_to_client(monkeypatch):
    """voyageai.Client is initialized with timeout=5."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    fake_embedding = [0.1] * 1024
    fake_result = MagicMock()
    fake_result.embeddings = [fake_embedding]
    fake_client = MagicMock()
    fake_client.embed.return_value = fake_result
    mock_voyageai = MagicMock()
    mock_voyageai.Client.return_value = fake_client
    with patch.dict("sys.modules", {"voyageai": mock_voyageai}):
        VoyageEmbedder().embed("test text")
    mock_voyageai.Client.assert_called_once_with(api_key="test-key", timeout=5)


def test_embed_returns_none_on_empty_embeddings(monkeypatch):
    """Returns None when the API returns an empty embeddings list (IndexError caught)."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    fake_result = MagicMock()
    fake_result.embeddings = []
    fake_client = MagicMock()
    fake_client.embed.return_value = fake_result
    mock_voyageai = MagicMock()
    mock_voyageai.Client.return_value = fake_client
    with patch.dict("sys.modules", {"voyageai": mock_voyageai}):
        result = VoyageEmbedder().embed("test text")
    assert result is None
```

- [ ] **Step 2: Run test_voyage.py to verify all 6 pass**

Run: `PYTHONPATH=src:api .venv/bin/pytest tests/test_voyage.py -v`

Expected output:
```
6 passed
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_voyage.py
git commit -m "test: add timeout and empty-embeddings gap tests for VoyageEmbedder"
```

---

## Task 2: Add gap tests to test_insight.py

**Files:**
- Modify: `tests/test_insight.py`

- [ ] **Step 1: Add three gap tests at the bottom of `tests/test_insight.py`**

Append after the last existing test (`test_answer_question_prompt_omits_retrieved_section_when_no_results`):

```python
def test_generate_session_insight_raises_502_when_claude_fails(db_session, monkeypatch):
    """When _call_claude raises, generate_session_insight propagates as HTTP 502."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    from fastapi import HTTPException

    def raise_exc(self, msg):
        raise Exception("API down")

    monkeypatch.setattr(InsightService, "_call_claude", raise_exc)

    p = _make_patient(db_session, "I014")
    with pytest.raises(HTTPException) as exc_info:
        InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 1)
    assert exc_info.value.status_code == 502


def test_answer_question_raises_502_when_claude_fails(db_session, monkeypatch):
    """When _call_claude raises, answer_question propagates as HTTP 502."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    from fastapi import HTTPException

    def raise_exc(self, msg):
        raise Exception("API down")

    monkeypatch.setattr(InsightService, "_call_claude", raise_exc)
    monkeypatch.setattr(InsightService, "_retrieve_relevant", lambda self, *a, **kw: [])

    p = _make_patient(db_session, "I015")
    with pytest.raises(HTTPException) as exc_info:
        InsightService(db_session).answer_question(_FAKE_TIMELINE, p.id, "Is she improving?")
    assert exc_info.value.status_code == 502


def test_retrieve_relevant_returns_empty_on_db_exception(db_session, monkeypatch):
    """_retrieve_relevant swallows DB query exceptions and returns []."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-voyage-key")
    from services.insight import InsightService
    from services.voyage import VoyageEmbedder
    from unittest.mock import MagicMock

    monkeypatch.setattr(VoyageEmbedder, "embed", lambda self, text, input_type="document": [0.1] * 1024)

    p = _make_patient(db_session, "I016")

    mock_query = MagicMock()
    mock_query.filter.return_value = mock_query
    mock_query.order_by.return_value = mock_query
    mock_query.limit.return_value = mock_query
    mock_query.all.side_effect = Exception("DB exploded")
    monkeypatch.setattr(db_session, "query", lambda *a, **kw: mock_query)

    result = InsightService(db_session)._retrieve_relevant(p.id, "test question")
    assert result == []
```

- [ ] **Step 2: Run test_insight.py to verify all 16 pass**

Run: `PYTHONPATH=src:api .venv/bin/pytest tests/test_insight.py -v`

Expected output:
```
16 passed
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_insight.py
git commit -m "test: add 502 propagation and DB exception swallow gap tests for InsightService"
```

---

## Task 3: Add gap tests to test_ask_api.py

**Files:**
- Modify: `tests/test_ask_api.py`

- [ ] **Step 1: Add two gap tests at the bottom of `tests/test_ask_api.py`**

Append after the last existing test (`test_stub_mode_returns_200_regardless_of_retrieval`):

```python
def test_ask_missing_question_field_returns_422(client):
    """POST /ask with a missing 'question' field returns 422 Unprocessable Entity."""
    resp = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={})
    assert resp.status_code == 422


def test_ask_returns_502_when_claude_api_fails(client, monkeypatch):
    """When Claude is configured but the API call raises, /ask returns 502."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "real-key")
    from services.insight import InsightService

    def raise_exc(self, msg):
        raise Exception("API down")

    monkeypatch.setattr(InsightService, "_call_claude", raise_exc)
    monkeypatch.setattr(InsightService, "_retrieve_relevant", lambda self, *a, **kw: [])

    resp = client.post(
        f"/api/patient/{_PATIENT_SN}/ask",
        json={"question": "will this 502?"},
    )
    assert resp.status_code == 502
```

- [ ] **Step 2: Run test_ask_api.py to verify all 15 pass**

Run: `PYTHONPATH=src:api .venv/bin/pytest tests/test_ask_api.py -v`

Expected output:
```
15 passed
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_ask_api.py
git commit -m "test: add 422 and 502 gap tests for POST /ask endpoint"
```

---

## Task 4: Fix datetime.utcnow() deprecation in insight.py

**Files:**
- Modify: `api/services/insight.py`

- [ ] **Step 1: Update the import line in `api/services/insight.py`**

Find line (currently near top of file):
```python
from datetime import datetime
```

Replace with:
```python
from datetime import datetime, timezone
```

- [ ] **Step 2: Replace the deprecated call on line 86**

Find:
```python
            created_at=datetime.utcnow(),
```

Replace with:
```python
            created_at=datetime.now(timezone.utc),
```

- [ ] **Step 3: Run all three test files and confirm warnings are reduced**

Run: `PYTHONPATH=src:api .venv/bin/pytest tests/test_voyage.py tests/test_insight.py tests/test_ask_api.py -v 2>&1 | grep -E "(passed|failed|DeprecationWarning: datetime.datetime.utcnow)"`

Expected: `38 passed` with no `datetime.utcnow` deprecation warnings from `insight.py` (warnings from `trend.py` may remain — they are out of scope).

- [ ] **Step 4: Commit**

```bash
git add api/services/insight.py
git commit -m "fix: replace deprecated datetime.utcnow() with datetime.now(timezone.utc) in InsightService"
```

---

## Task 5: Full suite verification

- [ ] **Step 1: Run all 37 new tests together**

Run: `PYTHONPATH=src:api .venv/bin/pytest tests/test_voyage.py tests/test_insight.py tests/test_ask_api.py -v`

Expected: `37 passed, 0 failed`

- [ ] **Step 2: Confirm TypeScript is still clean**

Run: `cd web && npx tsc --noEmit`

Expected: exits with code 0, no output.

- [ ] **Step 3: Run the broader test suite to check for regressions**

Run: `PYTHONPATH=src:api .venv/bin/pytest tests/ -v --ignore=tests/test_voyage.py --ignore=tests/test_insight.py --ignore=tests/test_ask_api.py 2>&1 | tail -10`

Expected: all other tests pass (pre-existing state).

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test: verify Voyage embeddings + AI tab — 37 tests passing, tsc clean"
```
