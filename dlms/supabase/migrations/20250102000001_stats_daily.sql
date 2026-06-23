-- =============================================================================
-- Daily Snapshot Table and Function
-- =============================================================================

-- Daily snapshot table
CREATE TABLE IF NOT EXISTS device_stats_daily (
  snapshot_date  date    NOT NULL,
  status         text    NOT NULL,
  phase          text    NOT NULL,
  device_count   integer NOT NULL DEFAULT 0,
  unit_count     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_date, status, phase)
);

-- Snapshot function: upserts today's distribution from v_current_distribution
CREATE OR REPLACE FUNCTION fn_snapshot_device_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO device_stats_daily (snapshot_date, status, phase, device_count, unit_count)
  SELECT
    CURRENT_DATE,
    status,
    phase,
    device_count,
    unit_count
  FROM v_current_distribution
  ON CONFLICT (snapshot_date, status, phase) DO UPDATE
    SET device_count = EXCLUDED.device_count,
        unit_count   = EXCLUDED.unit_count;
END;
$$;

-- Backfill today so the dashboard has data immediately
SELECT fn_snapshot_device_stats();
