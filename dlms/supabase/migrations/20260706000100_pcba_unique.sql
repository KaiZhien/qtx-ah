-- Partial unique index on the normalized PCBA-A serial (de-facto device identity).
-- Mirrors device_device_sn_unique (20250101000003_device.sql): unique only when
-- present ('' sentinel default) and not soft-deleted.
CREATE UNIQUE INDEX IF NOT EXISTS device_pcba_a_sn_normalized_unique
  ON device(pcba_a_sn_normalized)
  WHERE pcba_a_sn_normalized <> '' AND deleted_at IS NULL;
