# Testing Guide: Voyage-3-lite Embeddings

Added in the `voyage-embeddings` implementation (2026-05-28). Covers the migration, VoyageEmbedder service, InsightService retrieval changes, and all new tests.

---

## 1. Automated test suite

Run the new tests only:

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src .venv/bin/pytest tests/test_voyage.py tests/test_insight.py tests/test_ask_api.py -v
```

Run the full suite:

```bash
PYTHONPATH=src .venv/bin/pytest tests/ api/test_api.py -v
```

Expected: all tests pass. SQLite in-memory is used — no real DB or API keys required.

---

## 2. VoyageEmbedder smoke test

Requires a real `VOYAGE_API_KEY`. Run from the project root:

```bash
VOYAGE_API_KEY=your-key-here PYTHONPATH=src .venv/bin/python - <<'EOF'
import sys; sys.path.insert(0, "api")
from services.voyage import VoyageEmbedder
v = VoyageEmbedder()
doc_vec = v.embed("Patient showed 20% TUG improvement", input_type="document")
qry_vec = v.embed("Is gait speed improving?", input_type="query")
print(f"doc_vec: {len(doc_vec)} floats, first={doc_vec[0]:.4f}")
print(f"qry_vec: {len(qry_vec)} floats, first={qry_vec[0]:.4f}")
EOF
```

Expected: two lines showing `1024 floats`.

---

## 3. Database migration

Requires PostgreSQL with the pgvector extension. Safe to run multiple times (idempotent).

```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=src .venv/bin/python scripts/13_migrate_add_embeddings.py
```

Expected output:
```
Running migration 13 ...
  patient_insights.embedding column: OK
  patient_insights_embedding_idx: OK
Migration 13 complete.
```

Verify in psql:
```sql
\d patient_insights
-- should show: embedding | vector(1024) | nullable

\di patient_insights_embedding_idx
-- should show the IVFFlat index
```

---

## 4. End-to-end API test

### Start the API

```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
ANTHROPIC_API_KEY=your-anthropic-key \
VOYAGE_API_KEY=your-voyage-key \
QTX_API_KEY=your-api-key \
PYTHONPATH=src .venv/bin/uvicorn api.main:app --reload --port 8000
```

### Ask a question (first call — no retrieval yet)

```bash
curl -s -X POST http://localhost:8000/api/patient/A001/ask \
  -H "X-Api-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"question": "Is this patient improving?"}' | python -m json.tool
```

### Ask again (second call — retrieval fires using the first answer as context)

```bash
curl -s -X POST http://localhost:8000/api/patient/A001/ask \
  -H "X-Api-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"question": "Any concerns about gait speed?"}' | python -m json.tool
```

### Verify embeddings are being stored

```sql
SELECT id, insight_type,
       embedding IS NOT NULL AS has_embedding,
       created_at
FROM patient_insights
ORDER BY created_at DESC
LIMIT 5;
```

Rows generated after the migration should show `has_embedding = true`. Rows that existed before the migration will show `false` (no backfill by design).

---

## 5. Stub mode (no API keys)

Both `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` can be absent. The service degrades gracefully:

- No `ANTHROPIC_API_KEY` → returns the stub placeholder, saves row with `model="stub"`, no embedding call made
- No `VOYAGE_API_KEY` → insight is generated and saved normally, `embedding=NULL` on the row, retrieval returns `[]`

Test stub mode:

```bash
# No ANTHROPIC_API_KEY set
QTX_API_KEY=your-api-key \
DATABASE_URL=... \
PYTHONPATH=src .venv/bin/uvicorn api.main:app --port 8000

curl -s -X POST http://localhost:8000/api/patient/A001/ask \
  -H "X-Api-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"question": "stub test"}' | python -m json.tool
# answer should be: "[AI insights unavailable — ANTHROPIC_API_KEY not configured]"
```
