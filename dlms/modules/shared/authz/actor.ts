import { createAdminClient } from '@/lib/supabase/server'
import { getPool } from '@/lib/db/pool'
import type { Actor, ModuleKey, Permission, RoleKey } from './catalog'

type Row = {
  id: string
  role_key: RoleKey
  module_access: string[]
  active: boolean
  role_permissions: string[]
  granted_overrides: string[]
  revoked_overrides: string[]
}

/**
 * The generated Database type (lib/types/database.types.ts) is generated from
 * the existing DLMS Supabase project and has no entry for fn_resolve_actor,
 * which belongs to the separate ops-platform project this migration targets
 * (see 20260718000002_platform_resolve_actor.sql's header). Typing the RPC
 * call site directly, rather than widening or hand-editing the generated
 * types file, keeps that drift contained to this one function.
 */
type ResolveActorRpc = (
  fn: 'fn_resolve_actor',
  args: { p_auth_user_id: string },
) => Promise<{ data: Row[] | null; error: { message: string } | null }>

/**
 * Resolves the acting user's full authorization state in ONE query.
 *
 * Overrides are folded in here (grants added, revokes subtracted, expired ones
 * ignored) so the pure policy never has to know they exist. Uses the admin
 * client deliberately: this is a read that FEEDS authorization decisions, and
 * must not itself be subject to the RLS policies it is about to justify.
 */
export async function loadActor(authUserId: string): Promise<Actor | null> {
  const supabase = createAdminClient()
  const rpc = supabase.rpc.bind(supabase) as unknown as ResolveActorRpc
  const { data, error } = await rpc('fn_resolve_actor', { p_auth_user_id: authUserId })
  if (error) throw new Error(`loadActor failed: ${error.message}`)
  const row = data?.[0]
  if (!row) return null
  return toActor(row)
}

/**
 * The single definition of "resolved row → Actor", shared by the human path above and
 * the automation path below.
 *
 * fn_resolve_actor and fn_resolve_actor_by_user_id are deliberate mirrors of each other
 * (see 20260731000000_platform_outbox.sql's header: "Keep the two bodies in step"), and
 * that mirroring is only worth anything if the FOLDING is shared too — otherwise the two
 * SQL bodies could agree while the two call sites disagreed about what an expired grant
 * or a revoke means.
 */
function toActor(row: Row): Actor {
  const permissions = new Set<Permission>(row.role_permissions as Permission[])
  for (const p of row.granted_overrides) permissions.add(p as Permission)
  for (const p of row.revoked_overrides) permissions.delete(p as Permission)

  return {
    id: row.id,
    roleKey: row.role_key,
    permissions,
    moduleAccess: new Set(row.module_access as ModuleKey[]),
    active: row.active,
  }
}

/**
 * The outbox drain's automation principal (spec §5.5), seeded by
 * supabase/migrations/20260731000000_platform_outbox.sql. Read from that migration, not
 * invented here — the value is also asserted by the migration's own trigger WHEN clause
 * and CHECK constraint, which are what stop it from acquiring grants or a login path.
 */
export const SYSTEM_ACTOR_ID = '22222222-2222-2222-2222-222222222222'

const SYSTEM_ACTOR_MIGRATION = '20260731000000_platform_outbox.sql'

/**
 * Resolves the automation principal the outbox drain runs as.
 *
 * Goes through the POOL rather than the Supabase admin client that loadActor uses, on
 * purpose. This principal has no auth_user_id and no login path by construction, so there
 * is no session, no cookie and no request to bind to: the drain runs from a cron script
 * and a route handler whose only credential is DATABASE_URL. Reading through the same
 * connection budget as the transactions it is about to open keeps the drain to ONE
 * credential and one failure mode, and matches how the other actor-free server reads in
 * this codebase already work (userService, roleService, tasks/directory). The override
 * folding is genuinely shared with loadActor via toActor() above, which is the part that
 * had to stay identical.
 *
 * THROWS rather than returning null. A missing or deactivated principal is a deployment
 * fault — a migration that was never applied, or an admin who deactivated an account
 * without realising what it was. Degrading around it would be worse than failing: `can()`
 * denies everything to an inactive actor, so the drain would burn every event's attempts
 * on PermissionErrors and park a whole backlog that was never actually broken.
 */
export async function loadSystemActor(): Promise<Actor> {
  const { rows } = await getPool().query<Row>(
    `SELECT * FROM fn_resolve_actor_by_user_id($1)`, [SYSTEM_ACTOR_ID])

  const row = rows[0]
  if (!row) {
    throw new Error(
      `The outbox automation principal ${SYSTEM_ACTOR_ID} does not exist. It is seeded by ` +
      `supabase/migrations/${SYSTEM_ACTOR_MIGRATION} (and by supabase/seed/platform_seed.sql ` +
      'on a from-scratch database) — apply them before draining the outbox.')
  }

  const actor = toActor(row)
  if (!actor.active) {
    throw new Error(
      `The outbox automation principal ${SYSTEM_ACTOR_ID} is inactive or soft-deleted, so it ` +
      'can perform nothing. It is not an ordinary account: see ' +
      `supabase/migrations/${SYSTEM_ACTOR_MIGRATION}. Reactivate it before draining the outbox.`)
  }
  return actor
}
