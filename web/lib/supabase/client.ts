import { createBrowserClient as _createBrowserClient } from '@supabase/ssr'

/** Browser Supabase client — anon key only, session persisted in cookies. */
export function createBrowserClient() {
  return _createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
