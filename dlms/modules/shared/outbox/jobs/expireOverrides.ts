import { withTransaction } from '@/lib/db/tx'
import { loadSystemActor } from '@/modules/shared/authz/actor'

/**
 * Materialises expired permission overrides (spec §6.3: "Worker expires hourly").
 *
 * WHY THIS CHANGES NOBODY'S AUTHORITY, which is the only reason it is safe to run as an
 * automation principal that holds no user-management permission.
 *
 * `fn_resolve_actor` and `fn_resolve_actor_by_user_id` both already filter overrides on
 * `expires_at IS NULL OR expires_at > now()`. An override whose expiry has passed is
 * therefore ALREADY INERT at every authorization decision — a lapsed grant confers nothing
 * and a lapsed revoke subtracts nothing, an hour before this job runs and an hour after.
 * All this does is stop the admin console from displaying rows that no longer do anything,
 * so "why does this user still show a revoke they clearly don't have?" stops being a
 * question. It cannot widen anyone (the grant it soft-deletes was not being counted) and it
 * cannot narrow anyone (nor was the revoke).
 *
 * That is what lets it run without `manage_roles_permissions`. It is not an exception to
 * the authorization rule, and no grant was added to the automation principal for it: a
 * write that provably cannot change any actor's effective permissions is not a permission
 * change. Were that reasoning ever to stop holding — were the resolver to stop filtering on
 * expiry, say — this job would become a privilege change and would need a real gate.
 *
 * SOFT DELETE, never a hard one. 20260718000000_platform_rbac.sql is explicit that removal
 * from user_permission_override "is a soft delete, never a hard delete; re-granting
 * resurrects the same row via UPSERT". Deleting the row would break that resurrection path
 * and erase the record that the override once existed.
 *
 * THE AUTOMATION PRINCIPAL'S OWN ROWS ARE UNREACHABLE FROM HERE, by construction rather
 * than by a filter: trg_forbid_system_actor_grant refuses any non-NULL `expires_at` on its
 * overrides, so none of them can ever match `expires_at < now()`. (Its own revocations are
 * permanent and stay permanent, which is the guarantee that trigger exists to make.)
 */
export type ExpireOverridesResult = { expired: number }

export async function expireOverrides(): Promise<ExpireOverridesResult> {
  const system = await loadSystemActor()

  return withTransaction(system.id, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE user_permission_override
          SET deleted_at = now(), updated_at = now(), updated_by = $1,
              version = version + 1
        WHERE deleted_at IS NULL
          AND expires_at IS NOT NULL
          AND expires_at < now()`,
      [system.id])
    return { expired: rowCount ?? 0 }
  })
}
