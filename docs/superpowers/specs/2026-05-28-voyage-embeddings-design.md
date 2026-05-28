# Voyage-3-lite Embeddings for PatientInsight — Design Spec

**Date:** 2026-05-28
**Status:** Approved
**Scope:** Sub-project 2 — Patient Knowledge Graph

---

## Goal

Add semantic embeddings to `patient_insights` so that `InsightService` can retrieve past relevant insights before calling Claude. This augments the AI's context window with the most pertinent prior reasoning for a given patient, improving answer accuracy without cross-patient data leakage.

---

## Approach

Synchronous embedding on save (Option A). Voyage-3-lite is called immediately after Claude returns text, in the same transaction. If Voyage is unavailable or times out, the insight saves with `embedding=NULL` and a warning is logged — the insight is never lost due to an embedding failure.

Retrieval is pure cosine similarity (top-5). No recency bias. Patient population is small (~1,700 patients, most with 1–2 sessions) so competing insight volume per patient is low.

---

## Section 1: Schema & Migration

**New column on `patient_insights`:**
```sql
ALTER TABLE patient_insights ADD COLUMN embedding vector(1024);
```

- `vector(1024)` matches Voyage-3-lite's output dimension
- `NULL` = embedding failed or not yet computed; excluded from retrieval automatically

**pgvector IVFFlat index:**
```sql
CREATE INDEX ON patient_insights USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
```

`lists = 10` is appropriate for small per-patient insight counts.

**ORM addition to `api/models/clinical.py`:**
```python
from pgvector.sqlalchemy import Vector
embedding: Mapped[list[float] | None] = mapped_column(Vector(1024), nullable=True)
```

**Migration script:** `scripts/13_migrate_add_embeddings.py`
- Adds the column and index on the live DB
- Idempotent (uses `IF NOT EXISTS` guards)
- Does not backfill existing rows (historical insights have no embedding)

---

## Section 2: VoyageEmbedder Service

**File:** `api/services/voyage.py`

```python
class VoyageEmbedder:
    MODEL = "voyage-3-lite"
    DIMENSION = 1024

    def embed(self, text: str, input_type: str = "document") -> list[float] | None:
        ...
```

- `input_type="document"` when embedding insight content for storage
- `input_type="query"` when embedding a clinician question for retrieval
- Returns `None` silently if `VOYAGE_API_KEY` is not set
- Returns `None` on API failure (timeout, network error) after logging a warning
- 5-second HTTP timeout enforced on every call
- No retry logic — failure falls back to `NULL` embedding

**Env var:** `VOYAGE_API_KEY` added to `.env.example`

---

## Section 3: InsightService Changes

**File:** `api/services/insight.py`

### On save — embed the content

`_save_insight()` gains an optional `embedding: list[float] | None = None` parameter.

After `_call_claude()` returns text:
1. Call `VoyageEmbedder().embed(content, input_type="document")`
2. Pass the result (vector or `None`) into `_save_insight()`
3. Persist the row regardless of embedding outcome

### On answer — retrieve before prompting

New private method `_retrieve_relevant(patient_id, question, k=5) -> list[PatientInsight]`:

1. Call `VoyageEmbedder().embed(question, input_type="query")`
2. If embedding returns `None` or patient has no stored embeddings → return `[]`
3. Query `patient_insights` ordered by `embedding <=> query_vector` (pgvector cosine distance), filtered to `patient_id`, limited to `k`

Called at the top of `answer_question()` before building the Claude prompt.

### Updated prompt structure for `answer_question()`

```
Relevant past insights for this patient:
- [session N summary, date] <content>
- [Q&A, date] <content>

Patient timeline data:
{ ... }

Clinician question: <question>

Answer in 2-4 sentences based only on this patient's data above.
```

Retrieved insights section is omitted entirely if `_retrieve_relevant()` returns `[]`.

### `generate_session_insight()` — no retrieval

Session summaries reason over the full timeline JSON, which is already complete context. No retrieval added here.

---

## Section 4: Testing

**`tests/test_voyage.py`** (new):
- Returns `None` when `VOYAGE_API_KEY` not set
- Returns `None` on HTTP timeout (mock)
- Returns list of length 1024 on success (mock)
- Uses correct `input_type` for document vs query

**`tests/test_insight.py`** additions:
- Saving insight calls embedder and stores vector on the row
- Saving insight with embedder returning `None` persists row with `embedding=NULL`
- `_retrieve_relevant()` returns `[]` when patient has no stored embeddings
- `_retrieve_relevant()` returns `[]` when question embedding returns `None`
- `answer_question()` prompt includes retrieved insights section when results exist
- `answer_question()` prompt omits retrieved section when no results

**`tests/test_ask_api.py`** additions:
- API response shape is unchanged regardless of whether retrieval finds results
- Stub mode (no API key) still returns stub response with correct HTTP 200

**Test strategy:** pgvector cosine queries are mocked at the service level in unit tests (SQLite in-memory does not support pgvector). Integration tests that need the real DB are skipped with `pytest.mark.skipif` when `DATABASE_URL` is not set.

---

## Dependency Changes

- `pgvector` Python package (already used for the ORM Vector type)
- `voyageai` Python package added to `api/requirements-api.txt`
- `VOYAGE_API_KEY` env var added to `.env.example`

---

## Out of Scope

- Backfilling embeddings for existing `patient_insights` rows
- Recency bias in retrieval scoring
- Exposing a `GET /api/patient/{sn}/similar-insights` endpoint to the frontend
- Embedding patient timeline JSON or session measurement rows
