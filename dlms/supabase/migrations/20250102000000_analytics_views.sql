-- =============================================================================
-- Analytics Views
-- =============================================================================

-- 1. v_status_transition: Reconstructs status changes from audit_log
CREATE OR REPLACE VIEW v_status_transition AS
SELECT
  row_id                         AS device_id,
  old_values->>'status'          AS from_status,
  new_values->>'status'          AS to_status,
  actor_id,
  occurred_at
FROM audit_log
WHERE table_name = 'device'
  AND 'status' = ANY(changed_columns);

-- 2. v_phase_transition: Reconstructs phase changes from audit_log
CREATE OR REPLACE VIEW v_phase_transition AS
SELECT
  row_id                        AS device_id,
  old_values->>'phase'          AS from_phase,
  new_values->>'phase'          AS to_phase,
  actor_id,
  occurred_at
FROM audit_log
WHERE table_name = 'device'
  AND 'phase' = ANY(changed_columns);

-- 3. v_status_dwell: Per-device time spent in each status using LEAD window
CREATE OR REPLACE VIEW v_status_dwell AS
WITH transitions AS (
  SELECT
    device_id,
    to_status          AS status,
    occurred_at        AS entered_at,
    LEAD(occurred_at) OVER (PARTITION BY device_id ORDER BY occurred_at) AS exited_at
  FROM v_status_transition
)
SELECT
  device_id,
  status,
  entered_at,
  COALESCE(exited_at, now())                  AS exited_at,
  COALESCE(exited_at, now()) - entered_at     AS dwell_interval
FROM transitions;

-- 4. v_current_distribution: Current active-device counts by status and phase
CREATE OR REPLACE VIEW v_current_distribution AS
SELECT
  d.status,
  d.phase,
  so.label_en   AS status_label_en,
  so.label_zh   AS status_label_zh,
  po.label_en   AS phase_label_en,
  po.label_zh   AS phase_label_zh,
  COUNT(*)      AS device_count,
  COALESCE(SUM(d.qty), 0) AS unit_count
FROM device d
LEFT JOIN status_option so ON so.code = d.status
LEFT JOIN phase_option  po ON po.code = d.phase
WHERE d.deleted_at IS NULL
GROUP BY d.status, d.phase, so.label_en, so.label_zh, po.label_en, po.label_zh;

-- 5. v_daily_throughput: Devices created per day + devices reaching terminal status per day.
-- Terminal status codes: 'shipped', 'completed', 'closed'
-- NOTE: Adjust terminal status codes once status_option vocabulary is confirmed.
CREATE OR REPLACE VIEW v_daily_throughput AS
WITH created AS (
  SELECT
    created_at::date AS day,
    COUNT(*)         AS devices_created
  FROM device
  WHERE deleted_at IS NULL
  GROUP BY created_at::date
),
completed AS (
  SELECT
    occurred_at::date          AS day,
    COUNT(DISTINCT device_id)  AS devices_completed
  FROM v_status_transition
  WHERE to_status IN ('shipped', 'completed', 'closed')
  GROUP BY occurred_at::date
),
all_days AS (
  SELECT day FROM created
  UNION
  SELECT day FROM completed
)
SELECT
  d.day,
  COALESCE(c.devices_created, 0)   AS devices_created,
  COALESCE(x.devices_completed, 0) AS devices_completed
FROM all_days d
LEFT JOIN created   c ON c.day = d.day
LEFT JOIN completed x ON x.day = d.day
ORDER BY d.day;
