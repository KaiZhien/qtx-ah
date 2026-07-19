import { createAdminClient } from '@/lib/supabase/server'
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
