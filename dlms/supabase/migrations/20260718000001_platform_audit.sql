-- ===========================================================================
-- Audit trail (spec §6.3/§11). Two changes vs the DLMS original:
--   1. Actor comes from the app.actor_id GUC set by withTransaction(), with the
--      legacy column-sniffing kept as fallback for triggers fired outside a tx.
--   2. Grants are asymmetric across the two tables, and deliberately so:
--        - audit_log: NO application role — anon, authenticated, or
--          service_role — holds INSERT/UPDATE/DELETE. Writes arrive only
--          through fn_audit()'s SECURITY DEFINER path, which runs as the
--          function owner and so bypasses grants and RLS entirely; no write
--          grant is needed anywhere for that path to keep working.
--        - auth_event: same lockdown, except service_role also holds INSERT,
--          because recordAuthEvent() (a later task) writes login/lockout/etc.
--          events through the Supabase service-role client — a direct DML
--          path, not a SECURITY DEFINER function, so it genuinely needs the
--          grant. service_role still never gets UPDATE or DELETE on either
--          table.
--      service_role matters here because it is NOT a passive default: on a
--      real Supabase project every newly created public-schema table starts
--      with service_role already holding full DML (see
--      20250101000008_grants.sql's ALTER DEFAULT PRIVILEGES), and service_role
--      is BYPASSRLS, so the RLS policies below cannot backstop it — the
--      REVOKEs below are the only thing between service_role (the identity
--      every admin-client path in this codebase runs as) and the ability to
--      tamper with the trail. Omitting service_role from the REVOKE, or
--      REVOKing both tables identically, would silently leave that door open.
--      That, not a trigger, is what makes the trail tamper-resistant against
--      ordinary application-role privileges: nobody holding anon,
--      authenticated, or service_role privileges can forge, edit, or erase
--      history through a direct DML statement — only append via the audited
--      paths above.
--      Caveat this does NOT cover: the application's own transactional write
--      path (lib/db/tx.ts, via DATABASE_URL) connects as the `postgres` OWNER
--      role, which grants don't meaningfully constrain — an owner can always
--      re-grant itself privileges or drop the table. That's total database
--      compromise, a different (and separate) concern from a compromised or
--      buggy application-role path, and not something a GRANT/REVOKE can fix.
--
-- Belongs to the new `qtx-ops-platform` project (see the sibling
-- 20260718000000_platform_rbac.sql header for why this directory holds both the
-- new platform schema and the pre-existing DLMS migrations side by side).
-- ===========================================================================
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name  text NOT NULL,
  row_id      uuid,                     -- NULL for composite-keyed tables (there are no text-keyed tables in this schema)
  action      text NOT NULL CHECK (action IN ('insert','update','soft_delete','delete')),
  actor_id    uuid REFERENCES app_user(id),
  old_values  jsonb,
  new_values  jsonb,
  changed_columns text[],
  reason      text,                     -- populated where the workflow demands one
  ip_address  inet,
  session_id  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_row_idx ON audit_log(table_name, row_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, occurred_at DESC);
CREATE INDEX audit_log_time_brin ON audit_log USING brin (occurred_at);

CREATE TABLE auth_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES app_user(id),
  email       text,                     -- recorded even when the user is unknown (failed login)
  event_type  text NOT NULL CHECK (event_type IN
                ('login_success','login_failure','lockout','logout',
                 'mfa_enrolled','mfa_reset','password_reset','permission_denied','session_revoked')),
  detail      jsonb,
  ip_address  inet,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_event_user_idx ON auth_event(user_id, occurred_at DESC);
CREATE INDEX auth_event_type_idx ON auth_event(event_type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- audit_log: no role — not PUBLIC, not anon, not authenticated, and not
-- service_role either — may INSERT, UPDATE, or DELETE. fn_audit() below runs
-- SECURITY DEFINER, so it writes audit_log with the function owner's
-- privileges regardless of the calling role's own grants; no write grant is
-- needed by anyone for that path to keep working. `authenticated` and
-- `service_role` get SELECT only.
REVOKE ALL ON audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON audit_log TO authenticated, service_role;

-- auth_event: same lockdown, except service_role additionally gets INSERT —
-- recordAuthEvent() (a later task) writes through the Supabase service-role
-- client, a direct DML path that (unlike audit_log's SECURITY DEFINER
-- trigger) genuinely needs a grant to work. service_role still never gets
-- UPDATE or DELETE: once written, an auth event is as immutable as an
-- audit_log row. That is what makes both trails tamper-resistant: nobody
-- holding ordinary application privileges — including service_role — can
-- forge an entry, edit one, or erase history; they can only append to it via
-- the audited code paths above.
REVOKE ALL ON auth_event FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON auth_event TO authenticated;
GRANT SELECT, INSERT ON auth_event TO service_role;
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_event ENABLE ROW LEVEL SECURITY;

-- Permissive SELECT policy for now: every authenticated caller can SELECT
-- every row. Per-record audit visibility (e.g. scoping which rows a
-- non-admin may see) is enforced in the service layer today, not here. Full
-- RLS read policies that narrow this at the database level are planned for
-- week 3 — until then, this policy exists only so RLS being enabled doesn't
-- itself block the reads the grant above allows. There is deliberately no
-- INSERT/UPDATE/DELETE policy on either table: with no corresponding grant,
-- RLS has nothing to gate for those commands, and all real writes go through
-- fn_audit()'s SECURITY DEFINER path or the service-role client, both of
-- which bypass RLS entirely.
CREATE POLICY audit_log_select_authenticated ON audit_log
  FOR SELECT TO authenticated USING (true);
CREATE POLICY auth_event_select_authenticated ON auth_event
  FOR SELECT TO authenticated USING (true);
COMMENT ON POLICY audit_log_select_authenticated ON audit_log IS
  'Permissive placeholder: service layer enforces per-record audit visibility today. Narrower RLS read policies land week 3.';
COMMENT ON POLICY auth_event_select_authenticated ON auth_event IS
  'Permissive placeholder: service layer enforces per-record audit visibility today. Narrower RLS read policies land week 3.';

CREATE OR REPLACE FUNCTION fn_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_old jsonb; v_new jsonb; v_rec jsonb;
  v_action text; v_changed text[]; v_actor uuid; v_row uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD); v_new := NULL; v_rec := v_old;
    v_action := 'delete'; v_changed := '{}';
  ELSIF TG_OP = 'INSERT' THEN
    v_old := NULL; v_new := to_jsonb(NEW); v_rec := v_new;
    v_action := 'insert'; v_changed := '{}';
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_rec := v_new;
    SELECT coalesce(array_agg(key), '{}') INTO v_changed
      FROM jsonb_each(v_new) WHERE v_old -> key IS DISTINCT FROM value;
    IF v_changed = '{}' THEN RETURN NEW; END IF;   -- no-op update: don't pollute the trail
    v_action := CASE
      WHEN v_old->>'deleted_at' IS NULL AND v_new->>'deleted_at' IS NOT NULL THEN 'soft_delete'
      ELSE 'update' END;
  END IF;

  -- Actor: GUC first (set by withTransaction), then row columns (legacy path).
  BEGIN
    v_actor := nullif(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN others THEN v_actor := NULL;
  END;
  IF v_actor IS NULL THEN
    v_actor := coalesce(
      (v_rec->>'updated_by')::uuid,
      (v_rec->>'created_by')::uuid
    );
  END IF;

  BEGIN v_row := (v_rec->>'id')::uuid; EXCEPTION WHEN others THEN v_row := NULL; END;

  INSERT INTO audit_log (table_name, row_id, action, actor_id, old_values, new_values,
                         changed_columns, session_id)
  VALUES (TG_TABLE_NAME, v_row, v_action, v_actor, v_old, v_new, v_changed,
          nullif(current_setting('app.session_id', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION fn_attach_audit(p_table text)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_audit_%1$I AFTER INSERT OR UPDATE OR DELETE ON %1$I
     FOR EACH ROW EXECUTE FUNCTION fn_audit()', p_table);
END $$;

-- One-time migration-setup function (attaches the four audit triggers below) — no
-- REST client should ever call it. Follows the same pattern as
-- 20260706070156_function_execute_hardening.sql: revoke the PUBLIC default plus the
-- explicit anon/authenticated grantees; service_role keeps EXECUTE via the explicit
-- ACL entry it already holds from 20250101000008_grants.sql's ALTER DEFAULT
-- PRIVILEGES, so calling it below (as the migration-applying owner) is unaffected.
REVOKE EXECUTE ON FUNCTION fn_attach_audit(text) FROM PUBLIC, anon, authenticated;

SELECT fn_attach_audit(t) FROM unnest(ARRAY[
  'role','role_permission','app_user','user_permission_override'
]) AS t;
