-- Staff-directory read floor for an internal tool: any authenticated user may
-- read ACTIVE app_user rows (assignee pickers, audit actor emails, service-event
-- author display, embedded joins). Admin retains full visibility incl. inactive.
-- Replaces app_user_select (20250101000007_rls.sql, FOR SELECT) wholesale --
-- policies are OR-combined, but replacing keeps a single readable definition.
-- auth_user_role() is SECURITY DEFINER and search_path-pinned (20260706 hardening).
DROP POLICY IF EXISTS "app_user_select" ON app_user;
CREATE POLICY "app_user_select" ON app_user
  FOR SELECT USING (
    (auth.uid() IS NOT NULL AND active = true)   -- directory floor
    OR id = auth.uid()                            -- own row even if inactive
    OR auth_user_role() = 'admin'                 -- admin sees all incl. inactive
  );
