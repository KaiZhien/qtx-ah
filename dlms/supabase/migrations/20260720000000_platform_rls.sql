-- ===========================================================================
-- Platform RLS defense-in-depth: deny-via-REST posture (spec §11.1, Task R1).
--
-- The qtx-ops-platform schema is now live on a cloud Supabase project, where
-- every public-schema table is exposed via the auto-generated PostgREST API
-- to anyone holding the public anon key — UNLESS the table has row-level
-- security enabled. None of these 14 tables had it, so anon/authenticated
-- could SELECT (and, per the default DML grant those roles carry on every
-- new table — see 20250101000008_grants.sql) write every row in role,
-- app_user, task, device, etc. through a bare REST call.
--
-- The fix is enabling RLS with NO anon/authenticated policies, not hand-
-- writing permissive ones — because no application code path is ever those
-- roles against these tables:
--   - All app reads/writes go through withTransaction() (node-postgres,
--     connects as the `postgres` table OWNER via DATABASE_URL) — table
--     owners always bypass RLS, policies or not.
--   - Authorization resolution and auth-event writes go through
--     createAdminClient() (the service_role client) — service_role carries
--     BYPASSRLS, so it too is unaffected regardless of policies.
--   - The only createClient() (authenticated-JWT) calls in platform code are
--     supabase.auth.getUser() (session.ts, middleware) — an auth call, not a
--     table read.
-- So enabling RLS with zero policies makes PostgREST deny every SELECT/
-- INSERT/UPDATE/DELETE against these tables for anon and authenticated (RLS
-- enabled + no matching policy = deny, per Postgres semantics), while every
-- real app path — which never runs as those roles — is untouched. This is
-- strictly safer than writing per-role policies today and requires no policy
-- design. Narrower per-record read policies are a later refinement, to be
-- added only if a supabase-js (authenticated-JWT) read path is ever
-- introduced for one of these tables.
--
-- Deliberately NOT FORCE ROW LEVEL SECURITY: FORCE would also gate the owner
-- connection (withTransaction) and fn_audit's SECURITY DEFINER writes (which
-- run as the function owner) — either would break the one path this
-- migration must leave alone.
--
-- Deliberately NOT touching audit_log / auth_event: they already carry RLS
-- plus a permissive `authenticated` SELECT policy from Task 2
-- (20260718000001_platform_audit.sql) — a deliberate design decision
-- anticipating a future audit UI. That means any authenticated caller can
-- read every audit_log/auth_event row via REST today; tightening that read
-- policy belongs to the future audit-UI task, not this one. Follow-up, not a
-- fix: recorded here, addressed there.
-- ===========================================================================

ALTER TABLE role                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission               ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_override  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_link                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comment              ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_option             ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase_option              ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_variant            ENABLE ROW LEVEL SECURITY;
ALTER TABLE device                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_status_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_transition         ENABLE ROW LEVEL SECURITY;

-- No CREATE POLICY statements follow, by design — see header above.

-- ── Advisor hygiene: revoke RPC EXECUTE on the trigger functions ────────────
-- These are trigger functions (RETURNS trigger) — Postgres refuses to invoke
-- a trigger function directly via a bare SELECT/RPC call (it can only fire
-- from an actual trigger), so the advisor's flag isn't actually exploitable
-- via /rest/v1/rpc/<fn>. Revoked anyway for cleanliness, matching the pattern
-- already used in 20260706070156_function_execute_hardening.sql and
-- 20260718000002_platform_resolve_actor.sql. fn_resolve_actor and
-- fn_attach_audit already have EXECUTE revoked from these roles (see
-- 20260718000002_platform_resolve_actor.sql / 20260718000001_platform_audit.sql)
-- — not re-revoked here, though doing so would be harmless.
REVOKE EXECUTE ON FUNCTION fn_audit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_device_normalize() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_task_comment_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_protect_system_role() FROM PUBLIC, anon, authenticated;
