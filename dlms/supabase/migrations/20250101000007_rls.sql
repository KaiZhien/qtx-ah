-- ============================================================
-- Row Level Security — permission matrix (§3)
-- Two-layer enforcement: RLS backstop + app-layer checks.
-- ============================================================

-- Helper: get the authenticated user's role
CREATE OR REPLACE FUNCTION auth_user_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM app_user WHERE id = auth.uid() AND active = true
$$;

-- ============================================================
-- app_user
-- ============================================================
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;

-- Users can read their own row; admin can read all
CREATE POLICY "app_user_select" ON app_user
  FOR SELECT USING (
    id = auth.uid()
    OR auth_user_role() = 'admin'
  );

-- Only admin can update (role, active)
CREATE POLICY "app_user_update" ON app_user
  FOR UPDATE USING (auth_user_role() = 'admin');

-- INSERT is handled at sign-up time by a trigger (or admin script); block direct app inserts
CREATE POLICY "app_user_insert" ON app_user
  FOR INSERT WITH CHECK (auth_user_role() = 'admin');

-- ============================================================
-- status_option / phase_option
-- ============================================================
ALTER TABLE status_option ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase_option  ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read active options
CREATE POLICY "status_option_select" ON status_option
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "phase_option_select" ON phase_option
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Only admin can manage vocabularies (§3)
CREATE POLICY "status_option_insert" ON status_option
  FOR INSERT WITH CHECK (auth_user_role() = 'admin');

CREATE POLICY "status_option_update" ON status_option
  FOR UPDATE USING (auth_user_role() = 'admin');

CREATE POLICY "phase_option_insert" ON phase_option
  FOR INSERT WITH CHECK (auth_user_role() = 'admin');

CREATE POLICY "phase_option_update" ON phase_option
  FOR UPDATE USING (auth_user_role() = 'admin');

-- ============================================================
-- device
-- ============================================================
ALTER TABLE device ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can view active (non-deleted) records
CREATE POLICY "device_select_active" ON device
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (deleted_at IS NULL OR auth_user_role() = 'admin')
  );

-- engineer and admin can create records
CREATE POLICY "device_insert" ON device
  FOR INSERT WITH CHECK (
    auth_user_role() IN ('engineer', 'admin')
  );

-- engineer and admin can update (soft-delete permission enforced at app layer)
CREATE POLICY "device_update" ON device
  FOR UPDATE USING (
    auth_user_role() IN ('engineer', 'admin')
  );

-- Hard deletes are never allowed from the application
CREATE POLICY "device_no_delete" ON device
  FOR DELETE USING (false);

-- ============================================================
-- audit_log
-- ============================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Per-record history: engineer/admin can see audit entries for specific rows
-- Full audit log: admin only (UI enforces this; RLS allows admin + engineer for their own rows)
CREATE POLICY "audit_log_select" ON audit_log
  FOR SELECT USING (
    auth_user_role() IN ('engineer', 'admin')
  );

-- No app-layer inserts/updates/deletes (trigger only)
CREATE POLICY "audit_log_no_insert" ON audit_log
  FOR INSERT WITH CHECK (false);

CREATE POLICY "audit_log_no_update" ON audit_log
  FOR UPDATE USING (false);

CREATE POLICY "audit_log_no_delete" ON audit_log
  FOR DELETE USING (false);

-- ============================================================
-- extracted_device_draft
-- ============================================================
ALTER TABLE extracted_device_draft ENABLE ROW LEVEL SECURITY;

-- engineer and admin can view drafts
CREATE POLICY "draft_select" ON extracted_device_draft
  FOR SELECT USING (auth_user_role() IN ('engineer', 'admin'));

-- Only admin/engineer can update (confirm/reject)
CREATE POLICY "draft_update" ON extracted_device_draft
  FOR UPDATE USING (auth_user_role() IN ('engineer', 'admin'));

-- INSERT is done by the extraction worker (system role) or seeding; allow admin/engineer too for Phase 0 seeding
CREATE POLICY "draft_insert" ON extracted_device_draft
  FOR INSERT WITH CHECK (auth_user_role() IN ('engineer', 'admin', 'system'));

CREATE POLICY "draft_no_delete" ON extracted_device_draft
  FOR DELETE USING (false);
