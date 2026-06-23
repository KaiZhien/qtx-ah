-- =============================================================================
-- Analytics Cron Jobs
-- =============================================================================

-- Enable extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Nightly stats snapshot at 23:00 UTC
SELECT cron.schedule(
  'dlms-daily-stats',
  '0 23 * * *',
  $$ SELECT fn_snapshot_device_stats(); $$
);

-- Weekly digest at 08:00 UTC every Monday
-- NOTE: replace <EDGE_FUNCTION_URL> and <SERVICE_ROLE_KEY> with real values before deploying.
-- These are intentionally left as placeholders — set them via Supabase secrets/Vault in production.
-- The cron job will fail gracefully (HTTP error) until real values are configured.
DO $$
BEGIN
  -- Only schedule if pg_net is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule(
      'dlms-weekly-digest',
      '0 8 * * 1',
      format(
        $cron$
          SELECT net.http_post(
            url    := '<EDGE_FUNCTION_URL>/weekly-digest',
            headers := jsonb_build_object(
              'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
              'Content-Type',  'application/json'
            ),
            body   := '{}'::jsonb
          );
        $cron$
      )
    );
  END IF;
END $$;
