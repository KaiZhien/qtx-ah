import { cache as reactCache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { loadActor } from '@/modules/shared/authz/actor'
import type { Actor } from '@/modules/shared/authz/catalog'
import { requiresMfa, mfaGateStatus, type AalLevel } from '@/modules/shared/auth/mfaPolicy'

export class UnauthenticatedError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'UnauthenticatedError'
  }
}

/**
 * A signed-in actor of an MFA-required role invoked a privileged action while
 * their session is still AAL1 (password only, no verified TOTP challenge). The
 * page-level gate (app/(platform)/layout.tsx) never ran for a server-action
 * dispatch, so it is caught HERE instead. Callers reload → the layout gate then
 * routes them to /mfa to finish the second factor.
 */
export class MfaRequiredError extends Error {
  constructor() {
    super('Two-factor authentication required')
    this.name = 'MfaRequiredError'
  }
}

/**
 * React's cache() only exists at runtime on the React build Next.js aliases
 * 'react' to during an actual build/dev server (or on React 19+). The plain
 * npm 'react' package that Vitest/Node resolve directly is 18.3.1 and has no
 * such export, even though @types/react (via next-env.d.ts -> react/experimental
 * -> react/canary) types it as if it always exists. Falling back to identity
 * keeps this module runnable under the test runner — losing within-request
 * dedup ONLY there, never in the deployed app where the real cache() is used.
 */
const cache: typeof reactCache =
  typeof reactCache === 'function' ? reactCache : (fn) => fn

/**
 * The acting user for this request, or null.
 *
 * Deactivation is enforced HERE rather than only at login: an admin who
 * deactivates an account expects existing sessions to stop working immediately,
 * and Supabase's own token stays valid until it expires. Returning null for an
 * inactive user makes the next request from that session behave as signed-out.
 *
 * React's cache() dedupes this within a request, so a page rendering ten
 * permission-gated components resolves the actor once.
 */
export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const supabase = createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null

  const actor = await loadActor(data.user.id)
  if (!actor || !actor.active) return null
  return actor
})

export async function requireActor(): Promise<Actor> {
  const actor = await getCurrentActor()
  if (!actor) throw new UnauthenticatedError()
  return actor
}

/**
 * requireActor + the action-layer half of the mandatory-MFA gate (spec §7).
 *
 * The (platform) layout only gates page rendering; Next.js does not run layouts
 * for server-action dispatches, so a privileged action needs its own AAL check.
 * This is the enforcement point for the capability layer: use it in every
 * (platform) 'use server' module in place of requireActor.
 *
 * Non-MFA roles skip the AAL read entirely and pay nothing (mirrors the layout).
 * For an MFA-required role, the live Supabase AAL is read and — fail closed — a
 * null/absent level (SDK error or no data) counts as not-AAL2 → MfaRequiredError.
 */
export async function requireAal2Actor(): Promise<Actor> {
  const actor = await requireActor()
  if (!requiresMfa(actor.roleKey)) return actor

  const supabase = createClient()
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const currentLevel = (data?.currentLevel ?? null) as AalLevel | null
  if (mfaGateStatus({ roleKey: actor.roleKey, currentLevel }) === 'required') {
    throw new MfaRequiredError()
  }
  return actor
}
