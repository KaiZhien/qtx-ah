-- ============================================================
-- Security hardening (audit remediation P0)
--   1. security_invoker on the 5 analytics views (they were SECURITY DEFINER
--      by default → they bypassed audit_log / device RLS for the caller).
--   2. Pin search_path on SECURITY DEFINER / trigger functions (was mutable →
--      search_path-injection risk).
--   3. Revoke anon EXECUTE on SECURITY DEFINER functions reachable via REST RPC.
--   4. Revoke the broad anon SELECT granted in 20250101000008_grants.sql. The app
--      talks to Postgres as service_role, so it is unaffected by this revoke.
-- ============================================================

-- ── 1. security_invoker on the analytics views ───────────────────────────────
-- Views default to SECURITY DEFINER semantics; forcing security_invoker makes
-- them run with the querying role's privileges so RLS is respected.
ALTER VIEW v_status_transition    SET (security_invoker = true);
ALTER VIEW v_phase_transition     SET (security_invoker = true);
ALTER VIEW v_status_dwell         SET (security_invoker = true);
ALTER VIEW v_current_distribution SET (security_invoker = true);
ALTER VIEW v_daily_throughput     SET (security_invoker = true);

-- ── 2. Pin search_path on SECURITY DEFINER / trigger functions ───────────────
-- All five functions are zero-argument; signatures use () accordingly.
ALTER FUNCTION fn_device_touch()          SET search_path = public, pg_temp;
ALTER FUNCTION auth_user_role()           SET search_path = public, pg_temp;
ALTER FUNCTION fn_draft_touch()           SET search_path = public, pg_temp;
ALTER FUNCTION fn_audit()                 SET search_path = public, pg_temp;
ALTER FUNCTION fn_snapshot_device_stats() SET search_path = public, pg_temp;

-- ── 3. Revoke anon EXECUTE on SECURITY DEFINER functions exposed via REST RPC ──
REVOKE EXECUTE ON FUNCTION auth_user_role()           FROM anon;
REVOKE EXECUTE ON FUNCTION fn_audit()                 FROM anon;
REVOKE EXECUTE ON FUNCTION fn_snapshot_device_stats() FROM anon;

-- ── 4. Revoke broad anon SELECT (undo 20250101000008_grants.sql:12,21-22) ─────
-- App uses service_role → unaffected. anon should have no table read access.
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM anon;

-- NOTE: rls_auto_enable() appears only in the Supabase advisors output and is NOT
-- defined as a plain function in any migration in this repo, so its EXECUTE revoke
-- is intentionally OMITTED here rather than risk a failing migration.

-- ── Manual dashboard steps (NOT executable — perform in the Supabase dashboard) ─
-- 1. Enable leaked-password protection: Authentication → Providers → Password →
--    "Prevent use of leaked passwords" (HaveIBeenPwned check).
-- 2. Move the pg_net extension out of the public schema (Database → Extensions →
--    relocate pg_net to a dedicated schema, e.g. `extensions`).
