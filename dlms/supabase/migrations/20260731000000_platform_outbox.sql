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
  'Transactional outbox (spec §5.5): one row per boundary-crossing device status change, written in the same transaction as the change itself and drained into tasks asynchronously. Deliberately exempt from the updated_*/deleted_at/version table shape: rows are append-then-mark-processed, never user-edited (so there is no optimistic-concurrency contention for `version` to arbitrate — the drain claims rows by lock, not by version) and never soft-deleted. The processing timeline that updated_at would carry is already recorded, with before/after values, by the audit trigger attached below — but the ACTOR on those rows is correct only if the drain wraps its writes in withTransaction(systemActorId), which sets the app.actor_id GUC fn_audit reads. With no GUC, fn_audit falls back to updated_by then created_by; this table has no updated_by, so every drain action would be attributed to the human who caused the event rather than to the automation. The drain owes that wrapper.';
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
-- grantees, then re-grant to exactly the role that needs it.
--
-- anon and authenticated MUST stay in that REVOKE list. This repo's bootstrap
-- (20250101000008_grants.sql) runs `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
-- FUNCTIONS TO anon, authenticated, service_role` — it covers FUNCTIONS as well as
-- TABLES — so on a real Supabase project both roles receive an explicit EXECUTE grant
-- on this function the moment it is created, independently of the PUBLIC default.
-- Dropping them from the REVOKE because a test database shows no such grant would be a
-- real hole: __tests__/integration/setup.ts reproduces only the TABLES half of that
-- bootstrap, so the harness understates what cloud actually grants.
-- service_role is then re-granted explicitly rather than left to that same default,
-- so the one grantee that needs EXECUTE says so in this file.
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
-- (A third caller, trg_reconcile_system_actor below, invokes it on every
-- role_permission write. That is enforcement, not seeding — but it is also why, on a
-- from-scratch database, the principal is in fact created by the seed's FIRST
-- role_permission INSERT rather than by the SELECT at the end of platform_seed.sql.
-- Both still converge on the same state; neither call site becomes redundant.)
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
--
-- IT RECONCILES; IT DOES NOT MERELY INITIALIZE. Calling this once at seed time would
-- leave the narrowness true only until someone edited the matrix — and the matrix is
-- runtime data by design (20260718000000_platform_rbac.sql: "the Super Admin edits the
-- matrix at runtime", via modules/admin/services/roleService.ts). A Super Admin ticking
-- delete_records for `operator` would otherwise hand that authority to the one identity
-- nobody logs in as. So: (a) the upsert below re-asserts the whole derived set on every
-- call rather than skipping rows that already exist, which is what lets a re-run HEAL a
-- revocation somebody flipped, soft-deleted or gave an expiry; and (b) trg_reconcile_system_actor
-- below re-runs this function on every role_permission write, so the grant and its matching
-- revocation land in the same transaction. This function stays the single definition of
-- what the principal may do — the trigger calls into it rather than restating the derivation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_seed_system_actor()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- The legacy DLMS project already uses the all-ones UUID for its own system actor.
  -- A distinct constant keeps the two from being conflated once DLMS becomes this
  -- platform's Manufacturing module and the two schemas finally share a database.
  v_id      uuid := '22222222-2222-2222-2222-222222222222';
  v_role_id uuid;
  v_reason  text :=
    'Automation principal: narrowed to the minimum the outbox drain needs (spec 5.5).';
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
  -- same predicate fn_resolve_actor uses to compute role_permissions (no deleted_at
  -- filter — deliberately identical), so the two can never disagree about what the
  -- operator role holds.
  --
  -- UPSERT, not ON CONFLICT DO NOTHING. user_permission_override's UNIQUE constraint is
  -- documented as "removal is a soft delete, never a hard delete; re-granting resurrects
  -- the same row via UPSERT ... Writers MUST go through the upsert"
  -- (20260718000000_platform_rbac.sql). DO NOTHING would honour the letter of that
  -- constraint and break its purpose: a revocation an admin had flipped to granted,
  -- soft-deleted, or given an expiry would conflict, be skipped, and survive every
  -- re-run — leaving the principal permanently wider with no way back short of manual
  -- SQL. Re-asserting granted=false / deleted_at=NULL / expires_at=NULL heals all three.
  --
  -- The DO UPDATE ... WHERE is what keeps this idempotent: a row already in the intended
  -- state is not rewritten, so re-running bumps no `version` and writes no audit_log
  -- noise. That property is load-bearing for the dual call site and for the reconcile
  -- trigger below, which fires on EVERY role_permission write.
  INSERT INTO user_permission_override (user_id, permission_id, granted, reason,
                                        expires_at, created_by, updated_by)
  SELECT v_id, p.id, false, v_reason, NULL, v_id, v_id
    FROM role_permission rp
    JOIN permission p ON p.id = rp.permission_id
   WHERE rp.role_id = v_role_id
     AND p.key NOT IN ('view_records', 'create_records')
  ON CONFLICT (user_id, permission_id) DO UPDATE SET
        granted    = false,
        reason     = EXCLUDED.reason,
        expires_at = NULL,
        deleted_at = NULL,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by,
        version    = user_permission_override.version + 1
   WHERE user_permission_override.granted
      OR user_permission_override.deleted_at IS NOT NULL
      OR user_permission_override.expires_at IS NOT NULL
      OR user_permission_override.reason IS DISTINCT FROM EXCLUDED.reason;

  RETURN v_id;
END $$;
COMMENT ON FUNCTION fn_seed_system_actor() IS
  'Idempotent RECONCILIATION of the outbox drain''s automation principal (spec §5.5): re-derives its revocations from the `operator` role''s current grants and heals any that were flipped, soft-deleted or given an expiry. Returns the actor id, or NULL when it did nothing because the `operator` role does not exist yet. Called from 20260731000000_platform_outbox.sql, from supabase/seed/platform_seed.sql (see that migration''s header for why removing either call site breaks a real deployment path), and from trg_reconcile_system_actor on every role_permission write.';

-- Seed-time helper; no REST client should ever call it. Same PUBLIC-not-anon rule as
-- above, and no re-grant: the only callers are this migration, platform_seed.sql (both
-- applied as the owner) and trg_reconcile_system_actor below, which is SECURITY DEFINER
-- and so reaches this function as its owner regardless of who fired the trigger.
REVOKE EXECUTE ON FUNCTION fn_seed_system_actor() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ENFORCEMENT 1 of 3 — the principal cannot widen when the role matrix moves.
--
-- role_permission is runtime data (see fn_seed_system_actor's header). Re-running the
-- reconciliation on every write to it is what turns "narrow at seed time" into "narrow,
-- full stop": a Super Admin granting `operator` a permission through
-- roleService.setRolePermission commits the grant and its matching revocation in the SAME
-- transaction, so there is no window in which the automation principal holds it.
--
-- Statement-level, not row-level: platform_seed.sql grants a whole role's column in one
-- INSERT ... SELECT, and reconciling once per statement rather than once per granted row
-- keeps seeding linear. The reconciliation reads the post-statement state either way.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_reconcile_system_actor()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Recursion guard. fn_seed_system_actor() writes app_user and user_permission_override
  -- and never role_permission, so today it cannot re-enter this trigger; the depth check
  -- keeps that true even if some future trigger on either of those tables writes back to
  -- role_permission. pg_trigger_depth() is 1 for this trigger's own invocation.
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  PERFORM fn_seed_system_actor();
  RETURN NULL;   -- AFTER STATEMENT: return value is ignored
END $$;

CREATE TRIGGER trg_reconcile_system_actor
  AFTER INSERT OR UPDATE OR DELETE ON role_permission
  FOR EACH STATEMENT EXECUTE FUNCTION fn_reconcile_system_actor();
COMMENT ON TRIGGER trg_reconcile_system_actor ON role_permission IS
  'Re-derives the outbox automation principal''s revocations after any change to the role x permission matrix, so granting the `operator` role a permission never silently widens the principal (spec §5.5). Delegates to fn_seed_system_actor() — the single definition of what that principal may do.';

-- ---------------------------------------------------------------------------
-- ENFORCEMENT 2 of 3 — the principal's authority has no additive route at all,
-- and no route to make a revocation temporary either.
--
-- Reconciliation above makes a widening self-healing; this makes it unreachable. The
-- principal's effective set must be role-grants MINUS revocations, so a `granted` override
-- row targeting it is refused outright rather than quietly waiting to be reconciled away.
-- Closes the path through roleService.addOverride, whose upsert sets
-- `granted = EXCLUDED.granted, deleted_at = NULL` and would otherwise flip a revocation
-- into a grant from the admin console.
--
-- A non-NULL `expires_at` on a revocation is refused for the same reason, not a smaller
-- one. roleService.addOverride accepts an expiry on ANY override, including a revoke — so an
-- admin can leave one of this principal's revocations set to lapse on a schedule. The
-- reconciling upsert in fn_seed_system_actor() re-asserts `expires_at = NULL` on its next
-- run (see its header), so the widening is healed EVENTUALLY, but nothing guarantees a
-- `role_permission` write or a manual re-run happens before the expiry hits. For a role a
-- human actually holds, a time-limited revocation is an ordinary, reviewable configuration —
-- someone chose the date and is accountable for what happens on it. For a standing identity
-- nobody logs in as and nobody watches, that review never happens: an expiring revocation on
-- this principal is not a smaller version of a grant, it IS a grant, just deferred to a timer
-- instead of an admin click. So the guard refuses both `granted = true` and any non-NULL
-- `expires_at`, and the error names which of the two was attempted.
--
-- The WHEN clause keeps this off the hot path: the function body is only ever reached for a
-- row that is the system actor's AND (additive OR carries an expiry).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_forbid_system_actor_grant()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.granted THEN
    RAISE EXCEPTION
      'Cannot grant permissions to the outbox automation principal (% / system@qtx.internal): its authority is the operator role MINUS revocations, by construction (spec 5.5). Widen fn_seed_system_actor()''s keep-list in a migration instead.',
      NEW.user_id
      USING ERRCODE = '23514';
  ELSE
    RAISE EXCEPTION
      'Cannot put an expiry on a revocation for the outbox automation principal (% / system@qtx.internal): a time-limited revocation on a standing identity nobody logs in as and nobody watches is a scheduled privilege escalation, not a legitimate configuration — the permission would return the moment it lapses with nothing guaranteed to notice or re-run the reconciliation first. Revoke it permanently (expires_at NULL) instead.',
      NEW.user_id
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE TRIGGER trg_forbid_system_actor_grant
  BEFORE INSERT OR UPDATE ON user_permission_override
  FOR EACH ROW
  WHEN (NEW.user_id = '22222222-2222-2222-2222-222222222222'::uuid
        AND (NEW.granted OR NEW.expires_at IS NOT NULL))
  EXECUTE FUNCTION fn_forbid_system_actor_grant();
COMMENT ON TRIGGER trg_forbid_system_actor_grant ON user_permission_override IS
  'Refuses any additive (granted = true) override on the outbox automation principal, and refuses any non-NULL expires_at on one of its revocations. Its authority is role grants minus revocations with no route to add a grant, and no route to make a revocation temporary — a time-limited revocation on an identity nobody logs in as and nobody watches is a scheduled escalation, not a legitimate configuration (spec §5.5).';

-- ---------------------------------------------------------------------------
-- ENFORCEMENT 3 of 3 — the principal cannot acquire a login path.
--
-- The header above asserts "auth_user_id stays NULL: this principal must have NO login
-- path", but asserting it in a comment left `UPDATE app_user SET auth_user_id = ...`
-- succeeding. It is unreachable today — the only login path is fn_resolve_actor, which
-- keys on auth_user_id, and no application code writes that column — but platform_seed.sql
-- says "auth_user_id is linked on first login (Task 5)", so a linking path is planned.
-- If that path ever matches on email, an auth.users row for system@qtx.internal would
-- make the automation principal directly assumable by whoever created it.
--
-- A CHECK rather than a trigger: app_user already states its invariants this way
-- (module_access_known), and a CHECK cannot be bypassed by disabling a trigger.
-- ---------------------------------------------------------------------------
ALTER TABLE app_user ADD CONSTRAINT app_user_system_actor_has_no_login
  CHECK (auth_user_id IS NULL OR id <> '22222222-2222-2222-2222-222222222222'::uuid);
COMMENT ON CONSTRAINT app_user_system_actor_has_no_login ON app_user IS
  'The outbox drain''s automation principal (spec §5.5) must never be loggable-in-as. Its authority is deliberately un-human: every module, narrowed to two permissions, resolved only by fn_resolve_actor_by_user_id from the drain. Linking an auth.users row to it would turn that into an account.';

-- Call site 1 of 2 (cloud path). A no-op returning NULL on a from-scratch database.
SELECT fn_seed_system_actor();
