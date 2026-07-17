import { describe, it, expect } from 'vitest'
import { loadEnv, EnvError } from '@/modules/shared/config/env'

const VALID = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  DATABASE_URL: 'postgresql://u:p@host:6543/postgres',
  APP_ENV: 'staging',
}

describe('loadEnv', () => {
  it('returns a typed config from a complete environment', () => {
    expect(loadEnv(VALID)).toEqual({
      supabaseUrl: 'https://abc.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      databaseUrl: 'postgresql://u:p@host:6543/postgres',
      appEnv: 'staging',
    })
  })

  it('lists EVERY missing key in one error, not just the first', () => {
    const { DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ...partial } = VALID
    expect(() => loadEnv(partial)).toThrow(EnvError)
    try {
      loadEnv(partial)
    } catch (e) {
      expect((e as EnvError).message).toContain('DATABASE_URL')
      expect((e as EnvError).message).toContain('SUPABASE_SERVICE_ROLE_KEY')
    }
  })

  it('rejects an unknown APP_ENV rather than defaulting silently', () => {
    expect(() => loadEnv({ ...VALID, APP_ENV: 'prod' })).toThrow(EnvError)
  })
})
