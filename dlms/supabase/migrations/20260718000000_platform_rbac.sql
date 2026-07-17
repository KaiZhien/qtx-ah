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
  created_by uuid,                     -- FK to app_user added below: app_user doesn't exist yet at this point
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  version    integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE role IS 'Six seeded roles (spec §3.1). is_system rows cannot be deleted; their permission grants remain editable by a Super Admin.';

CREATE TABLE permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  sort        integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE permission IS 'The 24 permissions of spec §3.2. Reference data — rows are added only by migration, never edited or soft-deleted at runtime. Deliberately exempt from the id/created_*/updated_*/deleted_at/version table-shape convention applied elsewhere: there is no runtime writer for this table to attribute or version.';

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
COMMENT ON COLUMN app_user.email IS
  'Unconditionally UNIQUE (not scoped by deleted_at): deliberate. The spec''s removal mechanism is active = false, not
   deletion, and audit attribution must keep resolving to a stable row — so a soft-deleted user''s email stays
   reserved rather than becoming re-usable.';
CREATE INDEX app_user_role_idx ON app_user(role_id);
CREATE INDEX app_user_active_idx ON app_user(active) WHERE active AND deleted_at IS NULL;

-- role.created_by/updated_by reference app_user, but role is created above app_user to satisfy
-- app_user.role_id's own NOT NULL FK — so the constraints are added here, once both tables exist.
ALTER TABLE role
  ADD CONSTRAINT role_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_user(id),
  ADD CONSTRAINT role_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES app_user(id);

CREATE TABLE role_permission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id       uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT role_permission_role_id_permission_id_key UNIQUE (role_id, permission_id)
);
COMMENT ON TABLE role_permission IS
  'The §3.2 role→permission matrix, as data — the most security-sensitive table in the system. Carries the standard
   id/created_*/updated_*/deleted_at/version table shape (surrogate id replaces the former composite PK) so
   fn_audit can attribute a non-NULL row_id to every grant/revoke; UNIQUE(role_id, permission_id) preserves the
   original functional-key guarantee that a role cannot hold the same permission twice.';

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
  CONSTRAINT user_permission_override_user_id_permission_id_key UNIQUE (user_id, permission_id)
);
COMMENT ON TABLE user_permission_override IS
  'Rare per-user exceptions to the role matrix. reason is mandatory so the audit trail explains itself.';
COMMENT ON CONSTRAINT user_permission_override_user_id_permission_id_key ON user_permission_override IS
  'Deliberately unconditional (NOT scoped to WHERE deleted_at IS NULL). Contract: exactly one standing override row
   per (user_id, permission_id) for all time; removal is a soft delete, never a hard delete; re-granting resurrects
   the same row via UPSERT (ON CONFLICT (user_id, permission_id) DO UPDATE SET ..., deleted_at = NULL), which is why
   the constraint must stay unconditional — a partial unique index WHERE deleted_at IS NULL would let a second row
   be inserted instead of resurrecting the first, and ON CONFLICT would have nothing to conflict against. Writers
   MUST go through the upsert; a bare INSERT after a soft delete will violate this constraint by design.';

-- System roles are undeletable — guards ONLY against deleting a seeded role row (role.is_system). The distinct
-- last-Super-Admin invariant (at least one active Super Admin user must always exist) is an app-level check over
-- app_user, not enforced here.
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
