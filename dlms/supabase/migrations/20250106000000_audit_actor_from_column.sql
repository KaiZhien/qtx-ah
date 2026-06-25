-- ============================================================
-- Migration: audit actor from row column instead of GUC
--
-- The previous fn_audit() read actor_id from current_setting('app.actor_id', true),
-- but setSessionContext() in deviceService.ts was a no-op stub, so audit_log.actor_id
-- was always NULL.
--
-- Fix: read actor_id directly from the row's created_by (INSERT) or updated_by
-- (UPDATE/soft-delete) columns, which are correctly set by the service layer.
-- This removes the dependency on the GUC being set per-transaction.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_old_json     jsonb;
  v_new_json     jsonb;
  v_changed_cols text[];
  v_action       text;
  v_actor_id     uuid;
  v_key          text;
BEGIN
  v_new_json := to_jsonb(NEW);

  IF TG_OP = 'INSERT' THEN
    v_action       := 'insert';
    v_old_json     := NULL;
    v_changed_cols := '{}';
    -- Actor from created_by column (set by service layer)
    BEGIN
      v_actor_id := (NEW.created_by)::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_actor_id := NULL;
    END;

  ELSIF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);

    -- Soft-delete: deleted_at transitions from NULL to non-NULL
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      v_action := 'soft_delete';
    ELSE
      v_action := 'update';
    END IF;

    -- Actor from updated_by column (set by service layer)
    BEGIN
      v_actor_id := (NEW.updated_by)::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_actor_id := NULL;
    END;

    -- Compute changed_columns
    v_changed_cols := '{}';
    FOR v_key IN SELECT jsonb_object_keys(v_new_json) LOOP
      IF (v_old_json->v_key) IS DISTINCT FROM (v_new_json->v_key) THEN
        -- Exclude system-maintained columns from changed_columns list
        IF v_key NOT IN ('version', 'updated_at') THEN
          v_changed_cols := array_append(v_changed_cols, v_key);
        END IF;
      END IF;
    END LOOP;

    -- Skip write if only version/updated_at changed (no meaningful change)
    IF array_length(v_changed_cols, 1) IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO audit_log (
    actor_id, action, table_name, row_id,
    old_values, new_values, changed_columns,
    request_id, occurred_at
  ) VALUES (
    v_actor_id,
    v_action,
    TG_TABLE_NAME,
    NEW.id,
    v_old_json,
    v_new_json,
    v_changed_cols,
    current_setting('app.request_id', true),
    now()
  );

  RETURN NEW;
END;
$$;
