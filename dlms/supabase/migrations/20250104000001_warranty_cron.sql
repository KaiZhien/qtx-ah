-- =============================================================================
-- Warranty Alerts Cron Job
-- Runs daily at 08:00 UTC and invokes the warranty-alerts Edge Function.
-- NOTE: replace <EDGE_FUNCTION_URL> and <SERVICE_ROLE_KEY> with real values before deploying.
-- These are intentionally left as placeholders — set them via Supabase secrets/Vault in production.
-- The cron job will fail gracefully (HTTP error) until real values are configured.
-- =============================================================================

-- Idempotent scheduling: unschedule first if the job already exists, then recreate.
DO $$
BEGIN
  PERFORM cron.unschedule('dlms-warranty-alerts');
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$
BEGIN
  -- Only schedule if pg_net is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule(
      'dlms-warranty-alerts',
      '0 8 * * *',
      format(
        $cron$
          SELECT net.http_post(
            url    := '<EDGE_FUNCTION_URL>/warranty-alerts',
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
