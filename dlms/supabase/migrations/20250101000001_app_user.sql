CREATE TABLE app_user (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  email      text NOT NULL,
  role       text NOT NULL CHECK (role IN ('viewer', 'engineer', 'admin', 'system')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_user IS
  'Application users with roles. Never hard-deleted; set active=false to deactivate. Audit attribution is preserved for inactive users.';
COMMENT ON COLUMN app_user.role IS 'viewer|engineer|admin|system';
COMMENT ON COLUMN app_user.active IS 'False = deactivated. Never delete a row — audit records reference actor_id.';
