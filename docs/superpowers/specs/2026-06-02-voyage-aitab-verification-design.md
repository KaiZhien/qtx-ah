# Voyage Embeddings + AI Tab — Verification & Coverage Design

**Date:** 2026-06-02  
**Scope:** Verify correctness of Voyage-3-lite semantic embeddings (VoyageEmbedder, InsightService retrieval) and the AI tab frontend (AITab, PatientDrawerBody); fill coverage gaps; surface and fix any failures.

---

## Approach

Backend deep verification + frontend TypeScript type checking. No Jest/RTL setup — the real correctness risk is in the backend services. TypeScript guards the frontend API contract adequately.

---

## Section 1 — Fix the test runner

**Goal:** Confirm pytest is runnable in the project's Python environment before anything else.

**Steps:**
1. Locate the correct interpreter: check for `poetry`, a `.venv`, or a pinned Python path.
2. Verify `pytest`, `fastapi`, `sqlalchemy`, `anthropic`, and `voyageai` are importable.
3. Establish the canonical run command (e.g. `poetry run pytest` or `.venv/bin/pytest`) used for all subsequent steps.

**Success criterion:** `pytest --collect-only` lists all 31 tests without import errors.

---

## Section 2 — Run existing tests and fix failures

**Existing test files:**
| File | Tests | Coverage |
|---|---|---|
| `tests/test_voyage.py` | 4 | VoyageEmbedder — no key, timeout, success, input_type |
| `tests/test_insight.py` | 13 | InsightService — stub/real mode, embedding persistence, retrieval, prompt content |
| `tests/test_ask_api.py` | 14 | POST /ask, GET /insights, retrieval path, 503/404 guards |

**For each failure:**
- Diagnose: implementation bug vs. stale test assumption.
- Fix at the right layer — don't patch tests to hide real bugs.
- Re-run until all 31 pass.

**Success criterion:** `pytest tests/test_voyage.py tests/test_insight.py tests/test_ask_api.py -v` reports 31 passed, 0 failed.

---

## Section 3 — Coverage gap audit and new tests

After the 31 pass, audit each test file against the actual code paths. Known gaps from code review:

**VoyageEmbedder (`voyage.py`)**
- Timeout value is passed to `voyageai.Client` — no assertion on it currently.
- `result.embeddings` being empty list — code would raise `IndexError`; behaviour not tested.

**InsightService (`insight.py`)**
- `generate_session_insight`: `_call_claude` raises → should propagate as HTTP 502. Not tested.
- `answer_question`: same 502 path. Not tested.
- `_retrieve_relevant`: DB query raises exception → `except` branch returns `[]` silently. Not tested.

**Ask API (`test_ask_api.py`)**
- POST `/ask` with missing `question` field → expect 422 Unprocessable Entity.
- POST `/ask` when Claude is configured but API call fails → expect 502 passthrough.

**Output:** New test cases added to the existing three files (no new files). Re-run full suite after each addition.

**Success criterion:** All new tests pass; no regressions in the original 31.

---

## Section 4 — Frontend type checking

**Command:** `cd web && npx tsc --noEmit`

**What it validates:**
- `AITab.tsx`: `fetchInsights` return type aligns with `InsightRow[]`; `QAPanel` prop types (`onAnswer: (insight: InsightRow) => void`, `onPdfDownload: () => void`).
- `PatientDrawerBody.tsx`: `"ai"` union member is handled in the `activeTab` state type; `AITab` receives `sn` typed as `string`.

**For each error:** Fix the type declaration or component prop, not the runtime logic, unless a type error reveals an actual shape mismatch.

**Success criterion:** `tsc --noEmit` exits with code 0.

---

## Out of scope

- Jest / React Testing Library setup for the frontend.
- Integration tests against a live Postgres instance with pgvector.
- Manual end-to-end browser testing.
- Any other test files outside the three listed above.
