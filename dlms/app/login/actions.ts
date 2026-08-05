'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolvePlatformLogin } from '@/modules/shared/auth/firstLogin'
import { loadActor } from '@/modules/shared/authz/actor'
import type { Actor } from '@/modules/shared/authz/catalog'

// Deliberately not exported: every export of a 'use server' module must be an
// async function, so these constants stay module-private.
const ACTIVATION_PENDING_MESSAGE =
  'Your email is confirmed, but your account is awaiting admin activation. ' +
  'Please try again once an admin has activated your account.'

/**
 * Shown when the platform lookup itself failed — the database is unreachable,
 * fn_resolve_actor is missing, and so on. Fixed and uninformative on purpose:
 * the caller is unauthenticated, so the raw error is both useless to them and a
 * disclosure. The detail goes to the server log instead.
 */
const LOGIN_UNAVAILABLE_MESSAGE = 'Something went wrong — please try again'

export async function loginAction(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  const supabase = createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    return { error: error.message }
  }

  const authUserId = data.user?.id ?? ''

  // THE PLATFORM IS RESOLVED FIRST, AND LEGACY IS THE FALLBACK.
  //
  // This action serves two deployments off two differently-shaped schemas. On
  // legacy DLMS, app_user.id IS the auth user's id; on the platform, app_user.id
  // is its own uuid and the auth link lives in app_user.auth_user_id — which is
  // also NULL until the first login fills it in. The legacy read below therefore
  // cannot answer the platform question at all (and would be blocked anyway:
  // platform tables are RLS-enabled with no policy for `authenticated`), so a
  // platform match has to decide the outcome before that read is reached.
  let platformUserId: string | null = null
  let actor: Actor | null = null
  try {
    platformUserId = await resolvePlatformLogin(authUserId, email)
    if (platformUserId) actor = await loadActor(authUserId)
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'platform login resolution failed',
      err: err instanceof Error ? err.message : String(err),
    }))
    await supabase.auth.signOut()
    return { error: LOGIN_UNAVAILABLE_MESSAGE }
  }

  if (platformUserId) {
    // An inactive or unresolvable actor is a deliberate refusal, not a fault —
    // no error-level log. Same sentence as the legacy path below: a signed-out
    // caller learns nothing from the difference, and there is nothing else they
    // can do about either.
    if (!actor || !actor.active) {
      await supabase.auth.signOut()
      return { error: ACTIVATION_PENDING_MESSAGE }
    }
    redirect('/')
  }

  // Signup creates app_user with active: false; an admin must activate it before
  // login. getCurrentUser() filters eq('active', true), so without this check an
  // unactivated user would authenticate then be silently bounced back to /login.
  const { data: appUser } = await supabase
    .from('app_user')
    .select('*')
    .eq('id', authUserId)
    .eq('active', true)
    .single()

  if (!appUser) {
    await supabase.auth.signOut()
    return { error: ACTIVATION_PENDING_MESSAGE }
  }

  redirect('/legacy')
}
