-- ============================================================
-- device_assignment — many-to-many device ↔ engineer assignment
-- service_event     — append-only service/maintenance event log
-- (Tier-3 #1)
-- ============================================================

-- Many-to-many device ↔ engineer assignment
CREATE TABLE device_assignment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid NOT NULL REFERENCES app_user(id),
  UNIQUE (device_id, user_id)
);
CREATE INDEX ON device_assignment(user_id);
CREATE INDEX ON device_assignment(device_id);

-- Append-only service/maintenance event log
CREATE TABLE service_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  occurred_on date NOT NULL DEFAULT current_date,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON service_event(device_id, occurred_on DESC);

-- ============================================================
-- RLS — device_assignment
-- ============================================================
ALTER TABLE device_assignment ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can view assignments
CREATE POLICY "device_assignment_select" ON device_assignment
  FOR SELECT USING (
    auth_user_role() IN ('viewer', 'engineer', 'admin', 'system')
  );

-- Engineer or admin can assign devices
CREATE POLICY "device_assignment_insert" ON device_assignment
  FOR INSERT WITH CHECK (
    auth_user_role() IN ('engineer', 'admin')
  );

-- Engineer or admin can unassign (delete the row)
CREATE POLICY "device_assignment_delete" ON device_assignment
  FOR DELETE USING (
    auth_user_role() IN ('engineer', 'admin')
  );

-- No edits — only insert/delete
CREATE POLICY "device_assignment_no_update" ON device_assignment
  FOR UPDATE USING (false);

-- ============================================================
-- RLS — service_event
-- ============================================================
ALTER TABLE service_event ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can view service events
CREATE POLICY "service_event_select" ON service_event
  FOR SELECT USING (
    auth_user_role() IN ('viewer', 'engineer', 'admin', 'system')
  );

-- Engineer or admin can log events
CREATE POLICY "service_event_insert" ON service_event
  FOR INSERT WITH CHECK (
    auth_user_role() IN ('engineer', 'admin')
  );

-- Append-only — no updates
CREATE POLICY "service_event_no_update" ON service_event
  FOR UPDATE USING (false);

-- Append-only — no deletes
CREATE POLICY "service_event_no_delete" ON service_event
  FOR DELETE USING (false);
