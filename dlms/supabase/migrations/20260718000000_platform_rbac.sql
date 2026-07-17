-- ===========================================================================
-- Platform RBAC (spec §3). Roles and permissions are DATA, not code: the Super
-- Admin edits the matrix at runtime. Enforcement lives at one authorize() choke
-- point in the service layer; RLS mirrors the read rules as defense-in-depth.
--
-- NOTE: this schema belongs to the new `qtx-ops-platform` Supabase project, not
-- the existing DLMS project — it is authored here (alongside the legacy DLMS
-- migrations in this same directory) but applied separately. It intentionally
-- reuses table names DLMS already has (app_user, audit_log) because DLMS itself
-- is slated to become this platform's Manufacturing module via a later
-- freeze-weekend cutover; until then the two schemas are never applied to the
-- same database. Committing this file does nothing by itself.
-- ===========================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE role (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  description text,
  is_system  boolean NOT NULL DEFAULT false,   -- seeded roles: undeletable
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
COMMENT ON TABLE role IS 'Six seeded roles (spec §3.1). is_system rows cannot be deleted; their permission grants remain editable by a Super Admin.';

CREATE TABLE permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  sort        integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE permission IS 'The 24 permissions of spec §3.2. Reference data — rows are added only by migration.';

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  uuid UNIQUE,                    -- Supabase auth.users.id; NULL until invite accepted
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  role_id       uuid NOT NULL REFERENCES role(id),
  department    text,                            -- organizational attribute, NOT an access boundary
  module_access text[] NOT NULL DEFAULT '{}',
  user_kind     text NOT NULL DEFAULT 'employee'
                CHECK (user_kind IN ('employee', 'external')),  -- 'external' reserved for the future portal
  active        boolean NOT NULL DEFAULT true,
  mfa_enrolled  boolean NOT NULL DEFAULT false,
  invited_at    timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT module_access_known CHECK (
    module_access <@ ARRAY['engineering','finance','logistics','manufacturing','maintenance','tasks','admin']::text[]
  )
);
COMMENT ON COLUMN app_user.module_access IS
  'Modules this user may enter. Checked BEFORE permissions by authorize(). super_admin bypasses this gate in policy code.';
COMMENT ON COLUMN app_user.department IS
  'Organizational attribute used for task routing and dashboards. Never an access control input (spec BR-3).';
CREATE INDEX app_user_role_idx ON app_user(role_id);
CREATE INDEX app_user_active_idx ON app_user(active) WHERE deleted_at IS NULL;

CREATE TABLE role_permission (
  role_id       uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_permission_override (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  permission_id uuid NOT NULL REFERENCES permission(id),
  granted       boolean NOT NULL,               -- true = extra grant; false = revoke from role
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  expires_at    timestamptz,                    -- NULL = permanent; worker sweeps expiries hourly
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (user_id, permission_id)
);
COMMENT ON TABLE user_permission_override IS
  'Rare per-user exceptions to the role matrix. reason is mandatory so the audit trail explains itself.';

-- System roles are undeletable (guards the last-Super-Admin invariant at the DB floor)
CREATE OR REPLACE FUNCTION fn_protect_system_role()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'Cannot delete a system role (%)', OLD.key USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_protect_system_role BEFORE DELETE ON role
  FOR EACH ROW EXECUTE FUNCTION fn_protect_system_role();
