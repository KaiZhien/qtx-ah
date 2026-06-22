-- Phase 2 staging table (§6.3)
-- The extraction worker writes only here. Promotion to device happens on human confirm.
CREATE TABLE extracted_device_draft (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_file_path         text NOT NULL,
  source_file_hash         text NOT NULL UNIQUE,  -- idempotency key; dedupe duplicate uploads
  status                   text NOT NULL DEFAULT 'pending_review'
                             CHECK (status IN ('pending_review', 'confirmed', 'rejected')),
  extracted_payload        jsonb NOT NULL,
  extraction_model_version text,
  reviewed_by              uuid REFERENCES app_user(id),
  promoted_device_id       uuid REFERENCES device(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE extracted_device_draft IS
  'Phase 2 staging: extraction worker writes here. Promoted to device on engineer/admin confirm. source_file_hash ensures idempotency.';
COMMENT ON COLUMN extracted_device_draft.extracted_payload IS
  'Versioned JSON: { "version": "1.0", "fields": { "<field>": { "value": ..., "confidence": 0.0-1.0, "source_quote": "..." } } }';
COMMENT ON COLUMN extracted_device_draft.source_file_hash IS
  'SHA-256 of the uploaded file. Unique — re-uploading the same file returns the existing draft.';

CREATE INDEX extracted_device_draft_status_idx ON extracted_device_draft(status);
CREATE INDEX extracted_device_draft_created_at_idx ON extracted_device_draft(created_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION fn_draft_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER draft_touch
  BEFORE UPDATE ON extracted_device_draft
  FOR EACH ROW EXECUTE FUNCTION fn_draft_touch();
