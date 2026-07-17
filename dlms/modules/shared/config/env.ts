import { z } from 'zod'

export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  APP_ENV: z.enum(['development', 'staging', 'production']),
})

export type PlatformEnv = {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  databaseUrl: string
  appEnv: 'development' | 'staging' | 'production'
}

/** Validates the whole environment at once so a misconfigured deploy fails loudly at boot. */
export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): PlatformEnv {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new EnvError(`Invalid environment — ${detail}`)
  }
  const e = parsed.data
  return {
    supabaseUrl: e.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: e.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: e.DATABASE_URL,
    appEnv: e.APP_ENV,
  }
}
