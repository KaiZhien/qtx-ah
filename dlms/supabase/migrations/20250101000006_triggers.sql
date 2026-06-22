-- ============================================================
-- fn_device_touch: BEFORE INSERT/UPDATE on device
-- Maintains normalized columns, version counter, and updated_at.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_device_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Maintain normalized serial columns (single source of truth: §5.1.5)
  NEW.device_sn_normalized  := CASE WHEN NEW.device_sn IS NOT NULL THEN upper(trim(NEW.device_sn)) ELSE NULL END;
  NEW.pcba_a_sn_normalized  := upper(trim(NEW.pcba_a_sn));
  NEW.pcba_b_sn_normalized  := CASE WHEN NEW.pcba_b_sn IS NOT NULL THEN upper(trim(NEW.pcba_b_sn)) ELSE NULL END;

  IF TG_OP = 'INSERT' THEN
    NEW.version    := 1;
    NEW.updated_at := now();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.version    := OLD.version + 1;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER device_touch
  BEFORE INSERT OR UPDATE ON device
  FOR EACH ROW EXECUTE FUNCTION fn_device_touch();


-- ============================================================
-- fn_audit: AFTER INSERT/UPDATE on device (and future tables)
-- Append-only audit log. Reads actor from GUC app.actor_id.
-- This trigger is the ONLY writer to audit_log (§5.1.6).
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
  -- Determine actor from session GUC (set by service layer before each mutation)
  BEGIN
    v_actor_id := current_setting('app.actor_id', true)::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor_id := NULL;
  END;

  v_new_json := to_jsonb(NEW);

  IF TG_OP = 'INSERT' THEN
    v_action       := 'insert';
    v_old_json     := NULL;
    v_changed_cols := '{}';

  ELSIF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);

    -- Soft-delete: deleted_at transitions from NULL to non-NULL
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      v_action := 'soft_delete';
    ELSE
      v_action := 'update';
    END IF;

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

CREATE TRIGGER audit_device
  AFTER INSERT OR UPDATE ON device
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
