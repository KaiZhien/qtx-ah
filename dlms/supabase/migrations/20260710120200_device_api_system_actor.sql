-- ============================================================
-- System actor for the device-api edge function
--
-- The device-api edge function (supabase/functions/device-api) inserted devices
-- with created_by = NULL / updated_by = NULL. device.created_by is `uuid NOT NULL
-- REFERENCES app_user(id)`, so those writes could never have succeeded AND the
-- fn_audit trigger would have recorded an actor-less audit row. Both are fixed by
-- attributing edge-function writes to a dedicated, non-interactive "system" actor.
--
-- This creates that actor: an auth.users row (with an unusable empty password —
-- it is never meant to log in) and the matching app_user row with role 'system'.
-- Idempotent: safe to re-run.
--
-- The fixed UUID below is the default the edge function uses; it can be overridden
-- per-deployment with the DEVICE_API_ACTOR_ID edge-function secret (which must
-- point at some existing app_user.id).
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE id = '11111111-1111-1111-1111-111111111111'
  ) THEN
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) VALUES (
      '11111111-1111-1111-1111-111111111111',
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      'system+device-api@quantumtx.internal',
      -- Unusable password: empty encrypted_password (GoTrue's invited-user
      -- convention) can never match a login attempt; avoids a pgcrypto dependency.
      '',
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}',
      '{"system_actor":true}', false,
      '', '', '', ''
    );
  END IF;
END $$;

INSERT INTO app_user (id, email, role, active) VALUES
  ('11111111-1111-1111-1111-111111111111', 'system+device-api@quantumtx.internal', 'system', true)
ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN app_user.role IS
  'viewer|engineer|admin|system. The system role is a non-interactive service actor (e.g. the device-api edge function); it holds no app permissions in the permission matrix.';
