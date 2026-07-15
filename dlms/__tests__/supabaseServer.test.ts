import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Unit tests for the three server-side Supabase client factories, focused on
// WHICH Supabase key each one hands to @supabase/ssr. createReadClient carries
// the RLS read-path dev-mode fallback, so its key selection is the point.
//
// We mock @supabase/ssr to capture the `key` (2nd) argument createServerClient
// receives, and stub next/headers so createClient's cookies() call is inert in
// the node test environment.
// ---------------------------------------------------------------------------

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn((_url: string, _key: string) => ({ _url, _key })),
}))

vi.mock('@supabase/ssr', () => ({ createServerClient }))
vi.mock('next/headers', () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
}))

import { createClient, createAdminClient, createReadClient } from '@/lib/supabase/server'

const SUPABASE_URL = 'http://sentinel.supabase.local'
const ANON_KEY = 'sentinel-anon-key'
const SERVICE_ROLE_KEY = 'sentinel-service-role-key'

/** The `key` (2nd) argument the most recent createServerClient call received. */
function lastKey(): unknown {
  return createServerClient.mock.calls.at(-1)?.[1]
}

beforeEach(() => {
  createServerClient.mockClear()
  // Sentinel values so the key assertion is exact.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createClient / createAdminClient', () => {
  it('createClient always uses the anon key', () => {
    createClient()
    expect(lastKey()).toBe(ANON_KEY)
  })

  it('createAdminClient always uses the service-role key', () => {
    createAdminClient()
    expect(lastKey()).toBe(SERVICE_ROLE_KEY)
  })
})

describe('createReadClient dev-mode fallback matrix', () => {
  it('DLMS_DEV_MODE=true + development → service-role key (admin fallback)', () => {
    vi.stubEnv('DLMS_DEV_MODE', 'true')
    vi.stubEnv('NODE_ENV', 'development')
    createReadClient()
    expect(lastKey()).toBe(SERVICE_ROLE_KEY)
  })

  it('DLMS_DEV_MODE=true + production → anon key (guard inert in prod)', () => {
    vi.stubEnv('DLMS_DEV_MODE', 'true')
    vi.stubEnv('NODE_ENV', 'production')
    createReadClient()
    expect(lastKey()).toBe(ANON_KEY)
  })

  it('DLMS_DEV_MODE=false + development → anon key', () => {
    vi.stubEnv('DLMS_DEV_MODE', 'false')
    vi.stubEnv('NODE_ENV', 'development')
    createReadClient()
    expect(lastKey()).toBe(ANON_KEY)
  })

  it('DLMS_DEV_MODE unset + production → anon key', () => {
    vi.stubEnv('DLMS_DEV_MODE', undefined)
    vi.stubEnv('NODE_ENV', 'production')
    createReadClient()
    expect(lastKey()).toBe(ANON_KEY)
  })
})
