-- ============================================================
-- Extend the audit trigger to ALL mutable tables
--
-- Previously fn_audit was attached ONLY to `device`, so role/active changes on
-- app_user, vocabulary edits (status_option / phase_option), device_assignment,
-- service_event, and report_subscriber mutations went unaudited — contradicting
-- the admin audit-log's "every mutation" claim.
--
-- fn_audit was written for the `device` row shape (uuid `id`, `deleted_at`,
-- `created_by`/`updated_by`, `version`). The other tables differ:
--   • status_option / phase_option have a TEXT `code` PK and NO `id` column.
--   • app_user / vocab / device_assignment / report_subscriber have NO deleted_at.
--   • device_assignment / report_subscriber allow hard DELETE (unassign / remove).
--   • none of them have created_by/updated_by (device_assignment has assigned_by).
--
-- This migration makes fn_audit shape-agnostic (reads columns out of the jsonb
-- row snapshot so a missing column yields NULL instead of a runtime error), adds
-- DELETE support, and relaxes two audit_log invariants that only held for device:
--   • row_id  → now NULLable (text-PK tables have no uuid to record).
--   • new_values → now NULLable (a hard DELETE has no "new" row).
--   • action CHECK → now also allows 'delete'.
--
-- search_path is pinned inline (20260706065811_security_hardening pinned it via
-- ALTER FUNCTION; CREATE OR REPLACE would otherwise drop that setting).
-- ============================================================

-- ── Relax audit_log invariants that were device-specific ─────────────────────
ALTER TABLE audit_log ALTER COLUMN row_id     DROP NOT NULL;
ALTER TABLE audit_log ALTER COLUMN new_values DROP NOT NULL;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_check
  CHECK (action IN ('insert', 'update', 'soft_delete', 'delete'));

COMMENT ON COLUMN audit_log.row_id IS
  'Primary-key uuid of the affected row. NULL for text-keyed tables (status_option / phase_option) whose identity lives in new_values/old_values instead.';
COMMENT ON COLUMN audit_log.action IS
  'insert = new record; update = field change; soft_delete = deleted_at set null→non-null; delete = hard row deletion (device_assignment unassign, report_subscriber removal).';

-- ── Shape-agnostic fn_audit ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_old_json     jsonb;
  v_new_json     jsonb;
  v_rec_json     jsonb;   -- the representative row (NEW, or OLD on delete)
  v_changed_cols text[];
  v_action       text;
  v_actor_id     uuid;
  v_row_id       uuid;
  v_key          text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_json     := to_jsonb(OLD);
    v_new_json     := NULL;              -- no "new" row for a hard delete
    v_rec_json     := v_old_json;
    v_action       := 'delete';
    v_changed_cols := '{}';
    -- Best-effort actor (these tables have no updated_by today → NULL).
    v_actor_id     := (v_old_json->>'updated_by')::uuid;

  ELSIF TG_OP = 'INSERT' THEN
    v_new_json     := to_jsonb(NEW);
    v_rec_json     := v_new_json;
    v_old_json     := NULL;
    v_action       := 'insert';
    v_changed_cols := '{}';
    -- device sets created_by; device_assignment records assigned_by; others NULL.
    v_actor_id     := COALESCE(
                        (v_new_json->>'created_by')::uuid,
                        (v_new_json->>'assigned_by')::uuid
                      );

  ELSE  -- UPDATE
    v_new_json := to_jsonb(NEW);
    v_old_json := to_jsonb(OLD);
    v_rec_json := v_new_json;

    -- Soft-delete detection only for tables that actually have deleted_at.
    IF (v_new_json ? 'deleted_at')
       AND (v_old_json->>'deleted_at') IS NULL
       AND (v_new_json->>'deleted_at') IS NOT NULL THEN
      v_action := 'soft_delete';
    ELSE
      v_action := 'update';
    END IF;

    v_actor_id := (v_new_json->>'updated_by')::uuid;

    -- Compute changed_columns (excluding system-maintained columns).
    v_changed_cols := '{}';
    FOR v_key IN SELECT jsonb_object_keys(v_new_json) LOOP
      IF (v_old_json->v_key) IS DISTINCT FROM (v_new_json->v_key) THEN
        IF v_key NOT IN ('version', 'updated_at') THEN
          v_changed_cols := array_append(v_changed_cols, v_key);
        END IF;
      END IF;
    END LOOP;

    -- Skip write if only version/updated_at changed (no meaningful change).
    IF array_length(v_changed_cols, 1) IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  -- row_id: the row's uuid `id` when present; NULL for text-keyed tables.
  -- (`->>'id'` yields NULL for a missing key, and NULL::uuid = NULL — no error.)
  v_row_id := (v_rec_json->>'id')::uuid;

  INSERT INTO audit_log (
    actor_id, action, table_name, row_id,
    old_values, new_values, changed_columns,
    request_id, occurred_at
  ) VALUES (
    v_actor_id,
    v_action,
    TG_TABLE_NAME,
    v_row_id,
    v_old_json,
    v_new_json,
    v_changed_cols,
    current_setting('app.request_id', true),
    now()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- ── Attach the trigger to the remaining mutable tables ───────────────────────
-- Each mirrors device's `audit_device` trigger, scoped to the operations each
-- table's RLS actually permits (see 20250101000007_rls.sql / 20250111000000).

-- app_user: role/active changes (UPDATE) and sign-up (INSERT). Never hard-deleted.
DROP TRIGGER IF EXISTS audit_app_user ON app_user;
CREATE TRIGGER audit_app_user
  AFTER INSERT OR UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- status_option / phase_option: admin vocabulary edits (INSERT + UPDATE).
DROP TRIGGER IF EXISTS audit_status_option ON status_option;
CREATE TRIGGER audit_status_option
  AFTER INSERT OR UPDATE ON status_option
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

DROP TRIGGER IF EXISTS audit_phase_option ON phase_option;
CREATE TRIGGER audit_phase_option
  AFTER INSERT OR UPDATE ON phase_option
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- device_assignment: assign (INSERT) / unassign (DELETE). No UPDATE (no_update RLS).
DROP TRIGGER IF EXISTS audit_device_assignment ON device_assignment;
CREATE TRIGGER audit_device_assignment
  AFTER INSERT OR DELETE ON device_assignment
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- service_event: append-only log (INSERT only).
DROP TRIGGER IF EXISTS audit_service_event ON service_event;
CREATE TRIGGER audit_service_event
  AFTER INSERT ON service_event
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- report_subscriber: admin manages subscribers (INSERT / UPDATE / DELETE).
DROP TRIGGER IF EXISTS audit_report_subscriber ON report_subscriber;
CREATE TRIGGER audit_report_subscriber
  AFTER INSERT OR UPDATE OR DELETE ON report_subscriber
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
