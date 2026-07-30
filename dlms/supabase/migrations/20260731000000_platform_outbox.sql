-- ===========================================================================
-- Transactional outbox for status-driven cross-department handoffs (spec §5.5).
--
-- A device status change and the intent to hand off to another department are
-- written in ONE transaction: the status change commits with an `outbox` row or
-- neither happens. A separate drain then turns unprocessed rows into tasks. That
-- is the whole point of the pattern — a handoff can never be silently lost
-- because a task-creation call failed after the status had already committed.
--
-- This migration also seeds the principal the drain runs AS. A manufacturing
-- operator moving a device ready_for_delivery → shipped spawns a LOGISTICS task,
-- and taskService.createTask refuses to link a task into a module the acting
-- user cannot enter. That refusal is the security model working correctly, not
-- an obstacle to route around — so the drain cannot run as the human who caused
-- the event, and gets a dedicated automation principal instead.
--
-- Belongs to the `qtx-ops-platform` project. Carries the platform_ token so
-- __tests__/integration/setup.ts picks it up; committing this file does nothing
-- by itself until applied via the Supabase MCP/CLI to the cloud project.
-- ===========================================================================

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,            -- 'device' today
  aggregate_id uuid NOT NULL,              -- deliberately no FK: an outbox row is a historical
                                           -- fact about an aggregate, and must survive the
                                           -- aggregate being removed rather than cascade with it
  event_type text NOT NULL,                -- 'device_status_changed' today
  payload jsonb NOT NULL,                  -- everything the drain needs; self-contained by design,
                                           -- so draining never re-reads (and re-interprets) a
                                           -- device row that has since moved on
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,                -- NULL = still owed a handoff
  attempts integer NOT NULL DEFAULT 0,     -- incremented by the drain on each try, so a poison
                                           -- row is visible rather than merely slow
  last_error text,
  -- The human who caused the event. The drain runs as the automation principal below, so without
  -- this the trail would record only the effect; created_by records the cause.
  created_by uuid NOT NULL REFERENCES app_user(id)
);
COMMENT ON TABLE outbox IS
  'Transactional outbox (spec §5.5): one row per boundary-crossing device status change, written in the same transaction as the change itself and drained into tasks asynchronously. Deliberately exempt from the updated_*/deleted_at/version table shape: rows are append-then-mark-processed, never user-edited (so there is no optimistic-concurrency contention for `version` to arbitrate — the drain claims rows by lock, not by version) and never soft-deleted. The processing timeline that updated_at would carry is already recorded, with actor and before/after values, by the audit trigger attached below.';
COMMENT ON COLUMN outbox.aggregate_type IS
  'Left unconstrained on purpose. A CHECK listing today''s single value (''device'') would make every future aggregate a schema migration, which defeats the point of a generic outbox; the drain dispatches on this value and ignores what it does not recognise.';
COMMENT ON COLUMN outbox.event_type IS
  'Left unconstrained, same reasoning as aggregate_type. ''device_status_changed'' is the only producer today.';
COMMENT ON COLUMN outbox.processed_at IS
  'Set once the handoff has been created. Never reset — a redelivery would duplicate the task.';

-- The drain's ONLY query shape: oldest-first over the rows still owed a handoff.
-- Partial so it stays proportional to the backlog rather than to history — processed
-- rows accumulate forever (they are the audit trail of what was handed off) and must
-- not make the drain's index grow with them.
CREATE INDEX outbox_unprocessed ON outbox(occurred_at) WHERE processed_at IS NULL;
-- Covers the app_user FK: an unindexed referencing column turns every parent delete
-- into a sequential scan (same reasoning as import_batch_created_by).
CREATE INDEX outbox_created_by ON outbox(created_by);

-- Audited, unlike import_row: this table is low-volume (one row per boundary-crossing
-- status change, not one per spreadsheet line) and its processing history — when a
-- handoff was drained, how many attempts it took, what the last error was — is
-- operationally interesting rather than transient staging noise.
SELECT fn_attach_audit('outbox');

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
-- No policy: deny-via-REST, per 20260720000000_platform_rls.sql. All access is
-- through the service-role/owner write path.

-- ---------------------------------------------------------------------------
-- fn_resolve_actor_by_user_id — fn_resolve_actor keyed on app_user.id.
--
-- The drain has an app_user.id (the automation principal below) and no
-- auth_user_id, because the principal deliberately has no login path. Body,
-- row shape and SECURITY DEFINER SET search_path hardening are a deliberate
-- mirror of 20260718000002_platform_resolve_actor.sql — the ONLY difference is
-- the lookup column, so that loadActor()'s override-folding semantics (expired
-- overrides filtered here, grants added, revokes subtracted) are identical for
-- an automated caller and a human one. Keep the two bodies in step.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_resolve_actor_by_user_id(p_app_user_id uuid)
RETURNS TABLE (
  id uuid, role_key text, module_access text[], active boolean,
  role_permissions text[], granted_overrides text[], revoked_overrides text[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    u.id,
    r.key,
    u.module_access,
    u.active AND u.deleted_at IS NULL,
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM role_permission rp
                JOIN permission p ON p.id = rp.permission_id
               WHERE rp.role_id = u.role_id), '{}'),
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM user_permission_override o
                JOIN permission p ON p.id = o.permission_id
               WHERE o.user_id = u.id AND o.granted AND o.deleted_at IS NULL
                 AND (o.expires_at IS NULL OR o.expires_at > now())), '{}'),
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM user_permission_override o
                JOIN permission p ON p.id = o.permission_id
               WHERE o.user_id = u.id AND NOT o.granted AND o.deleted_at IS NULL
                 AND (o.expires_at IS NULL OR o.expires_at > now())), '{}')
  FROM app_user u
  JOIN role r ON r.id = u.role_id
  WHERE u.id = p_app_user_id;
$$;

-- EXECUTE defaults to PUBLIC, so revoking from `anon` alone is a NO-OP — anon would
-- still hold the privilege through PUBLIC. Revoke the PUBLIC default plus the explicit
-- grantees, then re-grant to exactly the role that needs it. service_role is granted
-- explicitly rather than relying on ALTER DEFAULT PRIVILEGES, which in this repo's
-- bootstrap covers TABLES, not FUNCTIONS.
REVOKE EXECUTE ON FUNCTION fn_resolve_actor_by_user_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_resolve_actor_by_user_id(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- fn_seed_system_actor — the automation principal, as an idempotent function.
--
-- WHY A FUNCTION, AND WHY IT IS CALLED FROM TWO PLACES. Migrations are applied
-- BEFORE supabase/seed/platform_seed.sql (see __tests__/integration/setup.ts:
-- the migration loop, THEN the seed), but `role` is populated only by that seed.
-- app_user.role_id is NOT NULL REFERENCES role(id), so a plain INSERT ... SELECT
-- FROM role WHERE key='operator' in this migration would insert ZERO ROWS,
-- SILENTLY, on any database migrated from scratch. The escape hatch the sibling
-- migration uses for the same ordering problem — making the referencing column
-- nullable, see component_type.created_by in 20260720000001_platform_components.sql
-- — is unavailable here, because role_id cannot be nullable.
--
-- So the logic lives in one idempotent function called from BOTH orders:
--   * from the end of this migration — correct on the cloud project, where the
--     seed has long since run and `operator` exists;
--   * from platform_seed.sql — correct on a from-scratch database, where this
--     migration's own call found no roles and returned NULL.
-- Whichever call runs second is a no-op. DO NOT DELETE EITHER CALL SITE: dropping
-- the migration's call silently strips the principal from cloud (and handoffs then
-- fail invisibly — the status change still commits, the task just never appears);
-- dropping the seed's call breaks every from-scratch database, including CI.
--
-- WHY IT IS NARROWED BY OVERRIDE RATHER THAN BY A NEW ROLE. A seventh role
-- granting one permission would ripple through RoleKey in
-- modules/shared/authz/catalog.ts, the generated permission-matrix suite, the
-- seed-drift guard and the Super Admin console's 24×6 grid. user_permission_override
-- is the mechanism the platform already has for "this principal, narrower than its
-- role", and fn_resolve_actor already folds it in. Neither the override rows nor
-- the all-modules grant is an oversight: the principal needs every module because a
-- handoff by definition crosses department boundaries, and the revocations are what
-- keep that breadth from also being depth.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_seed_system_actor()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- The legacy DLMS project already uses the all-ones UUID for its own system actor.
  -- A distinct constant keeps the two from being conflated once DLMS becomes this
  -- platform's Manufacturing module and the two schemas finally share a database.
  v_id      uuid := '22222222-2222-2222-2222-222222222222';
  v_role_id uuid;
BEGIN
  SELECT id INTO v_role_id FROM role WHERE key = 'operator';
  IF v_role_id IS NULL THEN
    RETURN NULL;   -- roles not seeded yet; the platform_seed.sql call site will do it
  END IF;

  -- auth_user_id stays NULL: this principal must have NO login path. It exists only to
  -- be resolved by fn_resolve_actor_by_user_id from the drain.
  INSERT INTO app_user (id, auth_user_id, email, full_name, role_id,
                        module_access, active, created_by, updated_by)
  VALUES (v_id, NULL, 'system@qtx.internal', 'QTX Automation (system)', v_role_id,
          ARRAY['engineering','finance','logistics','manufacturing',
                'maintenance','tasks','admin']::text[],
          true, v_id, v_id)   -- self-attributed: no human authored it
  ON CONFLICT DO NOTHING;

  -- Revoke every operator permission EXCEPT the two the drain actually needs.
  -- Derived from role_permission rather than from a hand-written list, and using the
  -- same predicate fn_resolve_actor uses to compute role_permissions, so the two can
  -- never disagree: if the operator role gains a permission later, it is revoked here
  -- automatically instead of silently widening the automation principal.
  INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
  SELECT v_id, p.id, false,
         'Automation principal: narrowed to the minimum the outbox drain needs (spec 5.5).',
         v_id
    FROM role_permission rp
    JOIN permission p ON p.id = rp.permission_id
   WHERE rp.role_id = v_role_id
     AND p.key NOT IN ('view_records', 'create_records')
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END $$;
COMMENT ON FUNCTION fn_seed_system_actor() IS
  'Idempotent seed of the outbox drain''s automation principal (spec §5.5). Returns the actor id, or NULL when it did nothing because the `operator` role does not exist yet. Called from BOTH 20260731000000_platform_outbox.sql and supabase/seed/platform_seed.sql — see that migration''s header for why removing either call site breaks a real deployment path.';

-- Seed-time helper; no REST client should ever call it. Same PUBLIC-not-anon rule as
-- above, and no re-grant: the only callers are this migration and platform_seed.sql,
-- both applied as the owner.
REVOKE EXECUTE ON FUNCTION fn_seed_system_actor() FROM PUBLIC, anon, authenticated;

-- Call site 1 of 2 (cloud path). A no-op returning NULL on a from-scratch database.
SELECT fn_seed_system_actor();
