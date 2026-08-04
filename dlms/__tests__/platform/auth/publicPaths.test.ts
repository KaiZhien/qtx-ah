import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPublicPath } from '@/modules/shared/auth/publicPaths'

// ---------------------------------------------------------------------------
// The session gate's public-path match.
//
// It was `PUBLIC_PATHS.some((p) => pathname.startsWith(p))`, which is a prefix
// test over the raw string, not over path SEGMENTS: `/api/healthcheck-evil`
// matched `/api/health` and skipped the gate. No exploit today — nothing is
// routed there, and every listed endpoint authenticates on its own shared secret
// anyway — but the failure mode is that ANY future route whose path merely starts
// with a listed one is silently unauthenticated, and it would be invisible.
//
// The entries themselves are load-bearing in the other direction and pinned by
// cronRoutes.test.ts and outboxDrainRoute.test.ts: `/api/outbox/drain` missing
// from the list is the difference between the endpoint working and 307-ing to
// /login. So the tightening must keep every one of them — including the two that
// legitimately need to cover children (`/auth/confirm`, `/api/cron/[job]`).
// ---------------------------------------------------------------------------

const PATHS = ['/login', '/auth', '/unauthorized', '/api/health', '/api/outbox/drain', '/api/cron']

describe('isPublicPath', () => {
  it.each(PATHS)('matches the listed path %s exactly', (p) => {
    expect(isPublicPath(p, PATHS)).toBe(true)
  })

  it.each([
    ['/auth/confirm', 'the Supabase email-confirmation route under /auth'],
    ['/api/cron/task-reminders', 'the cron runner’s [job] segment'],
    ['/api/cron/expire-overrides', 'the other registered job'],
    ['/login/', 'a trailing slash is the same path'],
  ])('matches %s — %s', (path) => {
    expect(isPublicPath(path, PATHS)).toBe(true)
  })

  it.each([
    '/api/healthcheck-evil',   // the reported case
    '/api/health-check',
    '/api/healthz',
    '/api/outbox/drainer',
    '/api/outbox/drain-all',
    '/logins',
    '/login-as/admin',
    '/authorize',
    '/unauthorized-users',
    '/api/cronjobs',
  ])('does NOT match %s — a sibling whose name merely starts the same way', (path) => {
    expect(isPublicPath(path, PATHS)).toBe(false)
  })

  it.each([
    '/legacy/login',
    '/foo/api/health',
    '/tasks',
    '/',
  ])('does NOT match %s — the entry has to be a prefix, not appear anywhere', (path) => {
    expect(isPublicPath(path, PATHS)).toBe(false)
  })

  it('is not fooled by an empty pathname', () => {
    expect(isPublicPath('', PATHS)).toBe(false)
  })
})

describe('middleware.ts uses the shared matcher', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'middleware.ts'), 'utf8')

  it('no longer prefix-matches the raw string', () => {
    expect(/pathname\.startsWith/.test(source)).toBe(false)
  })

  it('calls isPublicPath', () => {
    expect(/\bisPublicPath\b/.test(source)).toBe(true)
  })

  it('still declares PUBLIC_PATHS as an array literal', () => {
    // The other two pins parse this declaration out of the source with a regex.
    // Moving the list into another module would pass every behavioural test here
    // and quietly turn both of those pins vacuous.
    const declaration = /const PUBLIC_PATHS = \[([^\]]*)\]/.exec(source)
    expect(declaration).not.toBeNull()
    const entries = declaration![1].split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    expect(entries).toEqual(PATHS)
  })
})
