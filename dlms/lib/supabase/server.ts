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
