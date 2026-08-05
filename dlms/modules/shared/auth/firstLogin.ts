import { getPool } from '@/lib/db/pool'
import { withTransaction } from '@/lib/db/tx'

/**
 * Resolves — and, on a first login, CREATES — the link between a Supabase auth
 * user and their platform `app_user` row. Returns the app_user id, or null when
 * the authenticated user is not a platform user at all.
 *
 * This is the missing half of the invite flow. `inviteUser` writes an app_user
 * row with `auth_user_id` NULL and then sends the Supabase invite; the seed
 * writes the bootstrap Super Admin the same way ("auth_user_id is linked on
 * first login" — supabase/seed/platform_seed.sql). Until that column is filled
 * in, `fn_resolve_actor` (which joins on `auth_user_id`) resolves nothing, so
 * the account authenticates and then resolves to no actor. Nothing else in the
 * codebase or in SQL writes the column: this function is the entire mechanism.
 *
 * Email is the join key for that first login precisely because `auth_user_id`
 * is still NULL, and it is matched case-insensitively — Supabase Auth lowercases
 * addresses, while an admin typing an invite does not. A soft-deleted row is
 * never adopted: a retired employee's row must not be handed to whoever is
 * invited at that address next.
 *
 * Runs through the pool rather than the Supabase clients on purpose. The write
 * has to be audited as the user themselves, and `fn_audit` reads the actor from
 * the `app.actor_id` GUC that only `withTransaction` sets.
 */
export async function resolvePlatformLogin(
  authUserId: string,
  email: string,
): Promise<string | null> {
  // Outside the transaction because withTransaction needs the app_user id UP
  // FRONT (audit_log.actor_id is an FK to app_user, so the auth user's id is not
  // a legal substitute) and this SELECT is what discovers it. Both branches are
  // one statement: auth_user_id and email are each UNIQUE, so at most one row
  // matches either arm, and `linked DESC` prefers an established link over an
  // email coincidence.
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id, (auth_user_id IS NOT NULL) AS linked
       FROM app_user
      WHERE auth_user_id = $1
         OR (auth_user_id IS NULL AND deleted_at IS NULL AND lower(email) = lower($2))
      ORDER BY linked DESC
      LIMIT 1`,
    [authUserId, email],
  )
  const candidate = rows[0]
  if (!candidate) return null

  return withTransaction(candidate.id, async (tx) => {
    // Re-read under FOR UPDATE: the row's link state may have changed since the
    // lookup above, and two tabs racing the same first login must serialize here
    // rather than both proceeding to link.
    const locked = await tx.query<{ auth_user_id: string | null }>(
      `SELECT auth_user_id FROM app_user WHERE id = $1 FOR UPDATE`,
      [candidate.id],
    )
    const row = locked.rows[0]
    if (!row) return null

    if (row.auth_user_id === authUserId) {
      // Deliberately does NOT bump `version` or `updated_by`: those carry the
      // optimistic-concurrency and attribution story for ADMIN edits of this
      // user, and a login is not one. Bumping version here would make an admin's
      // open edit form go stale every time its subject signed in.
      await tx.query(
        `UPDATE app_user SET last_login_at = now() WHERE id = $1 AND auth_user_id = $2`,
        [candidate.id, authUserId],
      )
      return candidate.id
    }

    // Linked to somebody else — only reachable if two auth accounts contest one
    // app_user row. Refuse rather than steal the link.
    if (row.auth_user_id !== null) return null

    const linked = await tx.query(
      `UPDATE app_user SET auth_user_id = $2, last_login_at = now()
        WHERE id = $1 AND auth_user_id IS NULL`,
      [candidate.id, authUserId],
    )
    // Belt and braces over the FOR UPDATE above: if this ever matches nothing,
    // somebody else linked the row and this login must lose, not overwrite.
    return (linked.rowCount ?? 0) === 1 ? candidate.id : null
  })
}
