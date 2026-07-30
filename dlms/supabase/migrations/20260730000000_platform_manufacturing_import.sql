-- ===========================================================================
-- Manufacturing: bulk-import staging (spec §7.5 "Import confirm (per draft
-- row) | draft → device/units/installations + audit (row-level, resumable
-- batch)", §4.1 Manufacturing → Import).
--
-- Two tables. import_batch is one uploaded file. import_row is one prospective
-- device: a sheet row that carried a ranged serial fans out to N import_rows,
-- distinguished by unit_no.
--
-- Parsing happens server-side and lands here BEFORE anything is committed, so
-- the client never round-trips parsed data back for commit (the tamper hole in
-- the legacy lib/services/importService.ts path).
--
-- Belongs to the `qtx-ops-platform` project. Carries the platform_ token so
-- __tests__/integration/setup.ts picks it up; committing this file does
-- nothing by itself until applied via the Supabase MCP/CLI to the cloud
-- project.
-- ===========================================================================

CREATE TABLE import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_filename text NOT NULL,
  source_sha256 text NOT NULL,            -- content hash; surfaced so a re-upload is recognisable
  source_kind text NOT NULL
    CONSTRAINT import_batch_kind CHECK (source_kind IN ('xlsx','csv')),
  -- Every device needs a variant and the traceability sheet has no variant
  -- column, so the uploader picks one for the file. An optional per-row
  -- Variant column overrides it (see importMapping.ts).
  default_variant_id uuid NOT NULL REFERENCES device_variant(id),
  status text NOT NULL DEFAULT 'draft'
    CONSTRAINT import_batch_status CHECK (status IN ('draft','committing','committed','cancelled')),
  row_count integer NOT NULL DEFAULT 0,
  unmapped_headers jsonb NOT NULL DEFAULT '[]'::jsonb,  -- sheet columns we ignored, shown to the reviewer
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE import_batch IS
  'One uploaded spreadsheet, staged for review before commit (spec §7.5). Never the system of record — device is.';
COMMENT ON COLUMN import_batch.status IS
  'draft = staged, awaiting review; committing = a commit pass is running; committed = no valid rows remain; cancelled = abandoned by the uploader.';

CREATE TABLE import_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  source_row_no integer NOT NULL,          -- 1-based row number in the sheet, for "row 42 says…"
  unit_no integer NOT NULL DEFAULT 1,      -- 1..N when one sheet row's serial range fanned out
  raw jsonb NOT NULL,                      -- mapped-but-unvalidated cell values, verbatim
  parsed jsonb,                            -- ImportDeviceDraft; NULL unless status='valid'
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'valid'
    CONSTRAINT import_row_status
    CHECK (status IN ('valid','invalid','needs_review','committed','skipped','failed')),
  device_id uuid REFERENCES device(id),    -- set in the same tx that creates the device
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id)
);
COMMENT ON TABLE import_row IS
  'One prospective device from a staged import. Deliberately NOT audit-attached: it is transient staging (a 5000-row file would otherwise write 5000+ audit_log rows), and the durable record — the created device and its components — carries its own audit trail. import_batch IS audited, so who imported what is never lost.';
COMMENT ON COLUMN import_row.status IS
  'valid = ready to commit; invalid = failed validation; needs_review = serial notation a human must resolve; committed = device created (device_id set); skipped = duplicate or deliberately excluded; failed = commit attempt errored, retryable.';
COMMENT ON COLUMN import_row.unit_no IS
  'A sheet row reading "…0001 to 0015" expands to 15 import_rows sharing source_row_no with unit_no 1..15.';

CREATE UNIQUE INDEX import_row_unique ON import_row(batch_id, source_row_no, unit_no);
CREATE INDEX import_row_batch_status ON import_row(batch_id, status);

-- Audit: batch only, by design (see the import_row table comment).
SELECT fn_attach_audit('import_batch');

ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row   ENABLE ROW LEVEL SECURITY;
-- No policy on either table: deny-via-REST. All access is through the
-- service-role write path in modules/manufacturing/services/import*.
