-- ===========================================================================
-- Audit trail (spec §6.3/§11). Two changes vs the DLMS original:
--   1. Actor comes from the app.actor_id GUC set by withTransaction(), with the
--      legacy column-sniffing kept as fallback for triggers fired outside a tx.
--   2. No application role holds any write grant on audit_log at all — not even
--      INSERT. Every write reaches it through fn_audit()'s SECURITY DEFINER
--      path (or, for auth_event, the service-role client), both of which bypass
--      grants and RLS entirely. That, not a trigger, is what makes the trail
--      tamper-resistant: nobody with ordinary application privileges can forge,
--      edit, or erase history — only append to it through the audited paths.
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
-- No role — not public, not anon, not authenticated — may INSERT, UPDATE, or
-- DELETE either audit table directly. Writes reach these tables through
-- exactly two paths, neither of which needs (or should have) a direct grant:
-- fn_audit() below runs SECURITY DEFINER, so it writes audit_log with the
-- function owner's privileges regardless of the calling role's own grants;
-- auth_event is written by recordAuthEvent() through the Supabase
-- service-role client, which likewise bypasses both grants and RLS.
-- `authenticated` therefore gets SELECT only — no INSERT, no UPDATE, no
-- DELETE. That is what makes the trail tamper-resistant: nobody holding
-- ordinary application privileges can forge an entry, edit one, or erase
-- history; they can only append to it via the audited code paths above.
-- ---------------------------------------------------------------------------
REVOKE ALL ON audit_log, auth_event FROM PUBLIC, anon, authenticated;
GRANT SELECT ON audit_log, auth_event TO authenticated;

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

SELECT fn_attach_audit(t) FROM unnest(ARRAY[
  'role','role_permission','app_user','user_permission_override'
]) AS t;
