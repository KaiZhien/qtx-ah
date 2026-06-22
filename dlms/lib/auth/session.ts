import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { can } from '@/lib/auth/permissions'
import type { AppUser } from '@/lib/types'
import type { Action } from '@/lib/auth/permissions'

const DEV_COOKIE = 'dlms-dev-user-id'

/**
 * Get the currently authenticated user.
 * In dev mode (NEXT_PUBLIC_DEV_MODE=true), reads the demo user from a cookie
 * and looks them up in app_user. Falls back to Supabase Auth in all other cases.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  const supabase = createClient()

  // Dev mode: cookie-based role switching for demos
  if (process.env.NEXT_PUBLIC_DEV_MODE === 'true') {
    const cookieStore = cookies()
    const devUserId = cookieStore.get(DEV_COOKIE)?.value
    if (devUserId) {
      const { data } = await supabase
        .from('app_user')
        .select('*')
        .eq('id', devUserId)
        .eq('active', true)
        .single()
      if (data) return data as AppUser
    }
  }

  // Production / standard auth path
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null

  const { data: appUser } = await supabase
    .from('app_user')
    .select('*')
    .eq('id', user.id)
    .eq('active', true)
    .single()

  return appUser as AppUser | null
}

/**
 * Require authentication. Redirects to /login if not authenticated.
 */
export async function requireAuth(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

/**
 * Require a specific permission. Returns the user if authorized.
 * Redirects to /unauthorized if authenticated but not permitted.
 * Redirects to /login if not authenticated.
 */
export async function requirePermission(action: Action): Promise<AppUser> {
  const user = await requireAuth()
  if (!can(user.role as import('@/lib/types').Role, action)) {
    redirect('/unauthorized')
  }
  return user
}
