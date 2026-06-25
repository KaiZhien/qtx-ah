ALTER TABLE extracted_device_draft
  ADD COLUMN IF NOT EXISTS corrections jsonb;
