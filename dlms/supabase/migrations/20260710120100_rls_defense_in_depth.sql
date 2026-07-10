-- ============================================================
-- RLS defense-in-depth (§3)
--
-- The app talks to Postgres as service_role (bypasses RLS), so these changes
-- cannot affect the application itself — they close the *direct-PostgREST* path
-- available to an engineer/admin JWT.
--
--   1. device_update / app_user_update had a USING clause but NO WITH CHECK, so
--      an UPDATE could write a row into a state the policy would never have let
--      you SELECT/target. Add WITH CHECK mirroring each USING.
--
--   2. Soft-delete is admin-only, but that rule lived ONLY in the app
--      (deviceService.softDeleteDevice). With a raw engineer JWT, PostgREST would
--      happily set device.deleted_at. Enforce admin-only deleted_at writes at the
--      RLS layer: an engineer may only write rows whose deleted_at stays NULL.
--
-- Policy style mirrors 20250101000007_rls.sql (auth_user_role() helper).
-- ============================================================

-- ── device UPDATE: mirror USING + admin-only deleted_at ──────────────────────
-- USING gates which rows can be TARGETED: engineers only active rows — so they
-- can neither soft-delete nor un-delete (mirrors device_select_active). WITH
-- CHECK gates the row's post-UPDATE state: engineers may not leave a row
-- soft-deleted. Admins retain full soft-delete/restore ability.
DROP POLICY IF EXISTS "device_update" ON device;
CREATE POLICY "device_update" ON device
  FOR UPDATE
  USING (
    auth_user_role() IN ('engineer', 'admin')
    AND (deleted_at IS NULL OR auth_user_role() = 'admin')
  )
  WITH CHECK (
    auth_user_role() IN ('engineer', 'admin')
    -- Only admins may leave a row in a soft-deleted state (set deleted_at).
    AND (deleted_at IS NULL OR auth_user_role() = 'admin')
  );

-- ── app_user UPDATE: mirror USING with an explicit WITH CHECK ─────────────────
DROP POLICY IF EXISTS "app_user_update" ON app_user;
CREATE POLICY "app_user_update" ON app_user
  FOR UPDATE
  USING (auth_user_role() = 'admin')
  WITH CHECK (auth_user_role() = 'admin');
