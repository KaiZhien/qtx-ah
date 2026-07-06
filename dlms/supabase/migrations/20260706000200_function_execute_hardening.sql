-- Follow-up to 20260706000000_security_hardening: the earlier `REVOKE EXECUTE ...
-- FROM anon` did not take effect because EXECUTE is granted to PUBLIC by default
-- (and 20250101000008_grants.sql also granted it explicitly to anon/authenticated).
-- Revoke from PUBLIC + the explicit grantees. service_role keeps EXECUTE via its
-- own explicit grant, so the app (service_role) and DB triggers are unaffected.
--
-- Verified: no application code calls any of these via .rpc(); fn_audit is a trigger
-- function (runs regardless of caller EXECUTE), fn_snapshot_device_stats runs under
-- cron (superuser), rls_auto_enable is a one-time setup function.

-- Trigger / cron / setup SECURITY DEFINER functions: no REST client should call them.
REVOKE EXECUTE ON FUNCTION fn_audit()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_snapshot_device_stats() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rls_auto_enable()          FROM PUBLIC, anon, authenticated;

-- auth_user_role() is invoked inside RLS USING() policies, so `authenticated` and
-- `service_role` MUST retain EXECUTE. Remove only anon/PUBLIC (anon is pre-login and
-- never needs it). Revoking authenticated here would break RLS for signed-in users.
REVOKE EXECUTE ON FUNCTION auth_user_role() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION auth_user_role() TO authenticated, service_role;
