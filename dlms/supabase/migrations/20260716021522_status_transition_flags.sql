-- ============================================================
-- Status-transition flags: is_terminal / is_initial on status_option
--
-- Replaces the hardcoded 5-code transition graph (lib/domain/statusTransitions.ts)
-- with a computed rule driven by two per-status flags, so admin-added vocabulary
-- statuses become usable transition endpoints instead of failing closed.
--
--   is_terminal — a transition sink: no onward transitions (device is done).
--   is_initial  — creation-only: nothing transitions INTO it.
--
-- The domain rule allowedNextStatuses(from) = every active, non-initial status
-- other than `from`, unless `from` is terminal/unknown (→ none). Seeding the
-- flags below (Retired/Lost terminal, Stock initial) reproduces the legacy graph
-- membership exactly.
--
-- NOTE: the migration is authored here only; it is applied to the cloud project
-- separately. Committing the file does nothing by itself.
-- ============================================================

-- ── Flag columns ─────────────────────────────────────────────────────────────
ALTER TABLE status_option ADD COLUMN is_terminal boolean NOT NULL DEFAULT false;
ALTER TABLE status_option ADD COLUMN is_initial  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN status_option.is_terminal IS 'Transition sink: no onward transitions.';
COMMENT ON COLUMN status_option.is_initial  IS 'Creation-only: nothing transitions into it. Flags editable post-creation only via SQL (deliberate).';

-- Seed the legacy graph's terminal/initial semantics onto the existing codes.
UPDATE status_option SET is_terminal = true WHERE code IN ('Retired', 'Lost');
UPDATE status_option SET is_initial  = true WHERE code = 'Stock';

-- ── v_daily_throughput: derive terminal codes from the flag ──────────────────
-- Copied verbatim from 20250103000000_analytics_bugfixes.sql, changing ONLY the
-- `completed` CTE's terminal-status predicate from a hardcoded IN ('Retired',
-- 'Lost') to the flag-driven subquery. Behaviour is unchanged for the seeded
-- vocabulary; admin-added terminal statuses now count toward completions too.
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
    WHERE to_status IN (SELECT code FROM status_option WHERE is_terminal)
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

-- CREATE OR REPLACE VIEW drops the ALTER VIEW … SET (security_invoker) from
-- 20260706065811_security_hardening — re-assert it.
ALTER VIEW v_daily_throughput SET (security_invoker = true);
