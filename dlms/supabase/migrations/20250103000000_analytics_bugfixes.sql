-- =============================================================================
-- Analytics Bugfixes
-- BUG-10: Idempotent cron scheduling
-- BUG-02: v_status_transition / v_phase_transition include device-creation rows
-- BUG-02: v_status_dwell recreated to pick up updated base view
-- BUG-12: v_daily_throughput terminal status codes corrected to match seed vocab
-- BUG-13: fn_snapshot_device_stats COALESCE guard for NULL status/phase
-- =============================================================================

-- -----------------------------------------------------------------------------
-- BUG-10: Idempotent cron re-scheduling
-- Unschedule daily-stats if it already exists, then recreate it.
-- Weekly-digest is deliberately NOT rescheduled here (placeholder URLs remain).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('dlms-daily-stats');
EXCEPTION WHEN others THEN NULL;
END $$;

SELECT cron.schedule(
  'dlms-daily-stats',
  '0 23 * * *',
  $$ SELECT fn_snapshot_device_stats(); $$
);

DO $$
BEGIN
  PERFORM cron.unschedule('dlms-weekly-digest');
EXCEPTION WHEN others THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- BUG-02: v_status_transition — add synthetic origin row from INSERT events
-- so v_status_dwell captures the full dwell period from device creation.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_status_transition AS
-- Status changes (updates)
SELECT
  row_id                      AS device_id,
  old_values->>'status'       AS from_status,
  new_values->>'status'       AS to_status,
  actor_id,
  occurred_at
FROM audit_log
WHERE table_name = 'device'
  AND action = 'update'
  AND 'status' = ANY(changed_columns)

UNION ALL

-- Device creation: synthetic origin entry (from_status = NULL = "device birth")
SELECT
  row_id                      AS device_id,
  NULL                        AS from_status,
  new_values->>'status'       AS to_status,
  actor_id,
  occurred_at
FROM audit_log
WHERE table_name = 'device'
  AND action = 'insert';

-- -----------------------------------------------------------------------------
-- BUG-02: v_phase_transition — add synthetic origin row from INSERT events
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_phase_transition AS
SELECT
  row_id                      AS device_id,
  old_values->>'phase'        AS from_phase,
  new_values->>'phase'        AS to_phase,
  actor_id,
  occurred_at
FROM audit_log
WHERE table_name = 'device'
  AND action = 'update'
  AND 'phase' = ANY(changed_columns)

UNION ALL

SELECT
  row_id                      AS device_id,
  NULL                        AS from_phase,
  new_values->>'phase'        AS to_phase,
  actor_id,
  occurred_at
FROM audit_log
WHERE table_name = 'device'
  AND action = 'insert';

-- -----------------------------------------------------------------------------
-- BUG-02: v_status_dwell — recreate to pick up the updated v_status_transition.
-- The WHERE to_status IS NOT NULL guard excludes any rows where to_status is null.
-- LEAD window correctly handles the new origin rows without further changes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_status_dwell AS
WITH transitions AS (
  SELECT
    device_id,
    to_status          AS status,
    occurred_at        AS entered_at,
    LEAD(occurred_at) OVER (PARTITION BY device_id ORDER BY occurred_at) AS exited_at
  FROM v_status_transition
  WHERE to_status IS NOT NULL  -- exclude any rows where to_status is null
)
SELECT
  device_id,
  status,
  entered_at,
  COALESCE(exited_at, now())              AS exited_at,
  COALESCE(exited_at, now()) - entered_at AS dwell_interval
FROM transitions;

-- -----------------------------------------------------------------------------
-- BUG-12: v_daily_throughput — corrected terminal status codes.
-- Seed vocabulary (status_option.code): 'Stock', 'In Use', 'Repair', 'Retired', 'Lost'
-- Terminal statuses (device no longer active/in-service): 'Retired', 'Lost'
-- Original codes 'shipped', 'completed', 'closed' do not exist in the vocabulary.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_throughput AS
WITH
  created AS (
    SELECT created_at::date AS day, COUNT(*) AS cnt
    FROM device
    GROUP BY created_at::date  -- no deleted_at filter: historical counts are immutable
  ),
  completed AS (
    SELECT occurred_at::date AS day, COUNT(DISTINCT device_id) AS cnt
    FROM v_status_transition
    WHERE to_status IN ('Retired', 'Lost')
      AND from_status IS NOT NULL  -- exclude device-creation synthetic rows
    GROUP BY occurred_at::date
  ),
  all_days AS (
    SELECT day FROM created
    UNION
    SELECT day FROM completed
  )
SELECT
  d.day,
  COALESCE(c.cnt, 0) AS devices_created,
  COALESCE(cp.cnt, 0) AS devices_completed
FROM all_days d
LEFT JOIN created c ON c.day = d.day
LEFT JOIN completed cp ON cp.day = d.day
ORDER BY d.day;

-- -----------------------------------------------------------------------------
-- BUG-13: fn_snapshot_device_stats — COALESCE guard for NULL status/phase.
-- v_current_distribution can return NULL for status/phase when a device has a
-- vocab code with no matching status_option/phase_option entry, causing a
-- NOT NULL violation on device_stats_daily insert.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_snapshot_device_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO device_stats_daily (snapshot_date, status, phase, device_count, unit_count)
  SELECT
    CURRENT_DATE,
    COALESCE(status, 'unknown'),
    COALESCE(phase, 'unknown'),
    device_count,
    unit_count
  FROM v_current_distribution
  ON CONFLICT (snapshot_date, status, phase) DO UPDATE
    SET device_count = EXCLUDED.device_count,
        unit_count   = EXCLUDED.unit_count;
END;
$$;
