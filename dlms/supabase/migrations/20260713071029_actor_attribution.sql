-- ============================================================
-- Audit actor attribution for app_user / status_option / phase_option
--
-- fn_audit (20260710120000_audit_all_tables) resolves the acting user from the
-- row snapshot: UPDATE reads new.updated_by; INSERT reads
-- COALESCE(created_by, assigned_by). app_user, status_option and phase_option
-- carried NONE of those columns, so admin role/active changes and vocabulary
-- edits landed in audit_log with actor_id = NULL — the admin audit page showed
-- no actor for them.
--
-- This migration:
--   1. Adds a nullable updated_by uuid (FK → app_user.id) to those three tables.
--      The services (userService / vocabularyService) now stamp the acting
--      admin's id onto every mutation payload.
--   2. Re-creates fn_audit with ONE change vs. 20260710120000: the INSERT
--      branch's actor COALESCE gains updated_by as a final fallback, so the new
--      vocabulary-option INSERTs (which carry updated_by) get attributed. The
--      UPDATE branch already reads updated_by, so it is unchanged. Everything
--      else — SECURITY DEFINER, the pinned search_path, DELETE handling, the
--      shape-agnostic jsonb reads, and the no-op skip logic — is identical.
--
-- search_path is pinned inline here (CREATE OR REPLACE would otherwise drop the
-- ALTER FUNCTION setting from 20260706065811_security_hardening).
--
-- NOTE: the migration is authored here only; it is applied to the cloud project
-- separately. Committing the file does nothing by itself.
-- ============================================================

-- ── Actor-attribution columns ────────────────────────────────────────────────
ALTER TABLE app_user      ADD COLUMN updated_by uuid REFERENCES app_user(id);
ALTER TABLE status_option ADD COLUMN updated_by uuid REFERENCES app_user(id);
ALTER TABLE phase_option  ADD COLUMN updated_by uuid REFERENCES app_user(id);

COMMENT ON COLUMN app_user.updated_by IS
  'Acting user id for audit attribution: the admin who last changed this account''s role/active state. NULL for self-service signup rows (no acting admin). Read by fn_audit to populate audit_log.actor_id.';
COMMENT ON COLUMN status_option.updated_by IS
  'Acting user id for audit attribution: the admin who last inserted/toggled this vocabulary option. Read by fn_audit to populate audit_log.actor_id.';
COMMENT ON COLUMN phase_option.updated_by IS
  'Acting user id for audit attribution: the admin who last inserted/toggled this vocabulary option. Read by fn_audit to populate audit_log.actor_id.';

-- ── fn_audit: add updated_by as a final INSERT-actor fallback ─────────────────
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
    -- Best-effort actor from the deleted row's updated_by (device_assignment /
    -- report_subscriber have none → NULL; hard delete carries no acting id).
    v_actor_id     := (v_old_json->>'updated_by')::uuid;

  ELSIF TG_OP = 'INSERT' THEN
    v_new_json     := to_jsonb(NEW);
    v_rec_json     := v_new_json;
    v_old_json     := NULL;
    v_action       := 'insert';
    v_changed_cols := '{}';
    -- device sets created_by; device_assignment records assigned_by;
    -- status_option / phase_option INSERTs carry updated_by (admin add-option).
    v_actor_id     := COALESCE(
                        (v_new_json->>'created_by')::uuid,
                        (v_new_json->>'assigned_by')::uuid,
                        (v_new_json->>'updated_by')::uuid
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
