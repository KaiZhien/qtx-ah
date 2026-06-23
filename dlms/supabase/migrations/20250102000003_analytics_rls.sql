-- =============================================================================
-- Analytics RLS Policies and Grants
-- =============================================================================

-- RLS for device_stats_daily
ALTER TABLE device_stats_daily ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read snapshots
CREATE POLICY "analytics_stats_select"
  ON device_stats_daily
  FOR SELECT
  TO authenticated
  USING (true);

-- Writes are function-only (blocked from direct app writes)
CREATE POLICY "analytics_stats_insert_block"
  ON device_stats_daily
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY "analytics_stats_update_block"
  ON device_stats_daily
  FOR UPDATE
  TO authenticated
  USING (false);

-- Grant SELECT on views to authenticated role
GRANT SELECT ON v_status_transition    TO authenticated;
GRANT SELECT ON v_phase_transition     TO authenticated;
GRANT SELECT ON v_status_dwell         TO authenticated;
GRANT SELECT ON v_current_distribution TO authenticated;
GRANT SELECT ON v_daily_throughput     TO authenticated;
GRANT SELECT ON device_stats_daily     TO authenticated;
