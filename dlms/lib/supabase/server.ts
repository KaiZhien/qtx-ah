import { createServerClient as _createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/lib/types/database.types'

/** Standard server client — uses the anon key and respects RLS */
export function createClient() {
  const cookieStore = cookies()
  return _createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Ignore when called from a Server Component (cookies are read-only)
          }
        },
      },
    }
  )
}

/**
 * Admin client — uses the service role key to bypass RLS.
 * For use ONLY in the service layer to set GUCs and perform writes.
 * Never pass this client to UI components.
 */
export function createAdminClient() {
  return _createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {},
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  )
}

/**
 * Read-path client. User-scoped (RLS-enforced) normally; falls back to the
 * admin client under dev-mode impersonation, where there is no real Supabase
 * session (auth.uid() = NULL → RLS empty results / 42501 after the anon-SELECT
 * revoke). Mirrors the session.ts dev-mode guard exactly: server-only var +
 * NODE_ENV, so it is inert in production builds.
 */
export function createReadClient() {
  if (process.env.DLMS_DEV_MODE === 'true' && process.env.NODE_ENV !== 'production') {
    return createAdminClient()
  }
  return createClient()
}
