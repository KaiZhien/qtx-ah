#!/usr/bin/env bash
# setup.sh — Run all QTX-AH migrations and data seeding in order.
# Safe to re-run: every migration uses ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$(ls "$ROOT/.venv/bin/python3."* 2>/dev/null | head -1)"

if [[ -z "$PYTHON" || ! -x "$PYTHON" ]]; then
  echo "ERROR: No python found in $ROOT/.venv/bin/. Run 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt' first." >&2
  exit 1
fi

step() { echo; echo "==> $*"; }

# ── Phase 1: DDL migrations ──────────────────────────────────────────────────

step "Migration 12 — add notes column to sessions"
PYTHONPATH="$ROOT/api" "$PYTHON" "$ROOT/scripts/12_migrate_add_notes_column.py"

step "Migration 13 — add embedding vector + IVFFlat index to patient_insights"
PYTHONPATH="$ROOT/api" "$PYTHON" "$ROOT/scripts/13_migrate_add_embeddings.py"

step "Migration 15 — add tandem balance columns"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/15_migrate_add_tandem.py"

step "Migration 19 — create session_predictions table"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/19_migrate_add_session_predictions.py"

step "Migration 22 — add shap_top5 column to session_predictions"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/22_migrate_add_shap_top5.py"

step "Migration 23 — add bias_correction column to session_predictions"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/23_migrate_add_bias_correction.py"

step "Migration 24 — create cohort_response_curves table"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/24_migrate_cohort_response_curves.py"

step "Migration 27 — HNSW ANN index on patient_insights.embedding"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/27_migrate_add_insights_hnsw_index.py"

step "Migration 28 — drop dead fall_risk columns from session_predictions"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/28_migrate_drop_fall_risk_columns.py"

step "Migration 29 — wearable_enrollments.patient_id VARCHAR -> UUID + FK"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/29_migrate_wearable_patient_id_uuid.py"

# ── Phase 2: Data seeding and ingestion ──────────────────────────────────────

step "Script 11 — seed QTX patients (1,715 rows; idempotent upsert)"
PYTHONPATH="$ROOT/src" "$PYTHON" "$ROOT/scripts/11_seed_database.py"

step "Script 16 — ingest RAISE eldercare dataset (162 patients)"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/16_ingest_raise_data.py"

step "Script 20 — normalize RAISE usage_frequency (idempotent)"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/20_normalize_raise_usage_frequency.py"

step "Script 20 — backfill session_predictions for existing sessions (idempotent)"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/26_backfill_predictions.py"

step "Script 25 — compute and upsert cohort response curves"
PYTHONPATH="$ROOT/src:$ROOT/api" "$PYTHON" "$ROOT/scripts/25_compute_cohort_response_curves.py"

echo
echo "✓ Setup complete. Run 'make dev' to start the API and frontend."
