# Mandatory MFA Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Force `super_admin`/`admin`/`finance` through TOTP enrollment + challenge (session must reach AAL2) before any `(platform)` route is reachable, and give admins a way to reset a locked-out user's factor.

**Architecture:** A single gate in the `(platform)` **layout** server component (it already resolves the actor's role via DB and can read the session's AAL) redirects MFA-required users who aren't AAL2 to a new `/mfa` route that lives *outside* the platform group (so the gate can't loop). `/mfa` runs the Supabase TOTP enroll/challenge flow client-side. The load-bearing decision logic is pulled into pure, unit-tested functions; the GoTrue SDK calls (which can't run against the local Postgres harness) get thin wiring verified by type-check/build + one manual end-to-end pass. Admin factor-reset uses the Supabase admin API.

**Tech Stack:** Next.js 14 App Router (server components + server actions), TypeScript, `@supabase/ssr` (browser + server clients) over `@supabase/supabase-js` ^2.49, node-postgres via `lib/db/tx`, Vitest (unit + dockerized-Postgres integration), Tailwind + shadcn/ui.

## Global Constraints

Copied from the design spec ([2026-07-20-mfa-enforcement-design.md](../specs/2026-07-20-mfa-enforcement-design.md)) and platform conventions — every task implicitly includes these:

- **Live AAL is the only source of truth for the gate.** Enforcement reads `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` / `listFactors()`; it never gates on the stored `app_user.mfa_enrolled` bool (that bool is display-only, stamped on enroll / cleared on reset).
- **Fail closed.** If the AAL read errors or returns no data, `currentLevel` is `null` and the user is treated as **not** AAL2 (→ sent to `/mfa`). No open-access path on error.
- **MFA-required roles:** exactly `super_admin`, `admin`, `finance` — the existing `requiresMfa(roleKey)` set in `modules/shared/auth/mfaPolicy.ts`. Do not derive this from permissions.
- **Enforcement surface:** the `(platform)` route group only. `/legacy` (DLMS) is untouched.
- **Recovery = admin-initiated factor reset.** No recovery/backup codes. Super Admin self-lockout is a documented dashboard step, not built.
- **Authorization:** every new service entry point calls `authorize(actor, permission, module)` first and throws. `resetUserMfa` uses `manage_users` on `'admin'`.
- **Audited writes** to `app_user` go through `withTransaction(actor.id, …)` (owner pool; carries the audit-actor GUC). Security-trail events use `recordAuthEvent({ userId, eventType })` (fail-safe, never throws) — `mfa_enrolled` on enroll, `mfa_reset` on reset (both event types already exist).
- **Server actions** never leak a raw error — mirror the established `toUserMessage`/`toMessage` sanitization (`app/(platform)/admin/users/actions.ts`). Admin-console actions return `{ ok: true } | { error: string }` (the console's existing shape).
- **404-not-403** on id-addressed routes; the `/mfa` page redirects, it does not 403.
- **No schema change, nothing applied to cloud.** `app_user.mfa_enrolled`, `auth_event` event types, and `app_user.auth_user_id` all already exist. This plan is code-only.
- **Commit attribution:** authored solely by Reet Mitra — never a `Co-Authored-By` (or any co-author) trailer.

**Supabase client entry points (use these exact ones):**
- Browser (client components): `createBrowserClient()` from `@/lib/supabase/client`.
- Server (user-scoped, reads the session): `createClient()` from `@/lib/supabase/server`.
- Service-role (admin API): `createAdminClient()` from `@/lib/supabase/server`.

**Out of scope (follow-ups, do NOT build):** recovery/backup codes; MFA on `/legacy`; changing the post-login landing (`/login` still → `/legacy`); any migration.

---

## File Structure

- **Modify** `modules/shared/auth/mfaPolicy.ts` — add `AalLevel`, `mfaGateStatus`, `mfaStepFor` beside the existing `requiresMfa`. Pure.
- **Create** `app/mfa/page.tsx` — server route (outside `(platform)`) that resolves actor + AAL + factor state and renders the enroll/challenge screen (or redirects when satisfied).
- **Create** `components/auth/MfaEnrollChallenge.tsx` — client component running the Supabase TOTP flow.
- **Create** `app/mfa/actions.ts` — `markMfaEnrolledAction` (stamps the display flag + writes the `mfa_enrolled` event).
- **Modify** `app/(platform)/layout.tsx` — add the gate.
- **Modify** `modules/admin/services/userService.ts` — add `resetUserMfa`.
- **Modify** `app/(platform)/admin/users/actions.ts` — add `resetUserMfaAction`.
- **Modify** `components/admin/UserTable.tsx` — add the "Reset MFA" control.
- **Tests:** `__tests__/mfaPolicy.test.ts` (unit), `__tests__/integration/resetUserMfa.test.ts` (integration).

---

## Task 1: Pure gate/step decision logic

**Files:**
- Modify: `modules/shared/auth/mfaPolicy.ts`
- Test: `__tests__/mfaPolicy.test.ts`

**Interfaces:**
- Consumes: `RoleKey`, `requiresMfa` (already in the file).
- Produces:
  - `type AalLevel = 'aal1' | 'aal2'`
  - `mfaGateStatus(input: { roleKey: RoleKey; currentLevel: AalLevel | null }): 'satisfied' | 'required'`
  - `mfaStepFor(input: { hasVerifiedFactor: boolean; currentLevel: AalLevel | null }): 'enroll' | 'challenge' | 'done'`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/mfaPolicy.test.ts
import { describe, it, expect } from 'vitest'
import { requiresMfa, mfaGateStatus, mfaStepFor } from '@/modules/shared/auth/mfaPolicy'

describe('requiresMfa (unchanged)', () => {
  it('requires MFA for super_admin/admin/finance and not others', () => {
    expect(requiresMfa('super_admin')).toBe(true)
    expect(requiresMfa('admin')).toBe(true)
    expect(requiresMfa('finance')).toBe(true)
    expect(requiresMfa('manager')).toBe(false)
    expect(requiresMfa('operator')).toBe(false)
    expect(requiresMfa('viewer')).toBe(false)
  })
})

describe('mfaGateStatus', () => {
  it('is satisfied for a non-MFA role at any level', () => {
    expect(mfaGateStatus({ roleKey: 'viewer', currentLevel: null })).toBe('satisfied')
    expect(mfaGateStatus({ roleKey: 'operator', currentLevel: 'aal1' })).toBe('satisfied')
  })
  it('requires elevation for an MFA role below aal2', () => {
    expect(mfaGateStatus({ roleKey: 'admin', currentLevel: 'aal1' })).toBe('required')
    expect(mfaGateStatus({ roleKey: 'super_admin', currentLevel: null })).toBe('required') // fail closed
  })
  it('is satisfied for an MFA role at aal2', () => {
    expect(mfaGateStatus({ roleKey: 'finance', currentLevel: 'aal2' })).toBe('satisfied')
  })
})

describe('mfaStepFor', () => {
  it('is done once at aal2, whatever the factor state', () => {
    expect(mfaStepFor({ hasVerifiedFactor: true, currentLevel: 'aal2' })).toBe('done')
    expect(mfaStepFor({ hasVerifiedFactor: false, currentLevel: 'aal2' })).toBe('done')
  })
  it('enrolls when below aal2 with no verified factor', () => {
    expect(mfaStepFor({ hasVerifiedFactor: false, currentLevel: 'aal1' })).toBe('enroll')
    expect(mfaStepFor({ hasVerifiedFactor: false, currentLevel: null })).toBe('enroll') // fail closed
  })
  it('challenges when below aal2 with a verified factor', () => {
    expect(mfaStepFor({ hasVerifiedFactor: true, currentLevel: 'aal1' })).toBe('challenge')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dlms && npx vitest run __tests__/mfaPolicy.test.ts`
Expected: FAIL — `mfaGateStatus`/`mfaStepFor` not exported.

- [ ] **Step 3: Implement (append to `mfaPolicy.ts`)**

```ts
// append to modules/shared/auth/mfaPolicy.ts (keep the existing MFA_REQUIRED + requiresMfa)

/** Supabase authenticator assurance level. aal1 = password; aal2 = password + verified TOTP. */
export type AalLevel = 'aal1' | 'aal2'

/**
 * The gate (spec §5.1): does this actor still owe a second factor to enter the
 * platform? Non-MFA roles are always satisfied. For an MFA role, only a live
 * aal2 session satisfies it — a null level (AAL read failed / absent) fails
 * closed to 'required'.
 */
export function mfaGateStatus(
  input: { roleKey: RoleKey; currentLevel: AalLevel | null },
): 'satisfied' | 'required' {
  if (!requiresMfa(input.roleKey)) return 'satisfied'
  return input.currentLevel === 'aal2' ? 'satisfied' : 'required'
}

/**
 * What the /mfa screen should do given the user's factor + session state.
 * 'done' once aal2 (the page redirects away); otherwise enroll a first factor
 * or challenge an existing one. A null level fails closed toward enrolling.
 */
export function mfaStepFor(
  input: { hasVerifiedFactor: boolean; currentLevel: AalLevel | null },
): 'enroll' | 'challenge' | 'done' {
  if (input.currentLevel === 'aal2') return 'done'
  return input.hasVerifiedFactor ? 'challenge' : 'enroll'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dlms && npx vitest run __tests__/mfaPolicy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dlms/modules/shared/auth/mfaPolicy.ts dlms/__tests__/mfaPolicy.test.ts
git commit -m "feat(auth): pure MFA gate/step decision logic"
```

---

## Task 2: `/mfa` enroll/challenge screen + enrollment stamp

**Files:**
- Create: `app/mfa/page.tsx`
- Create: `components/auth/MfaEnrollChallenge.tsx`
- Create: `app/mfa/actions.ts`

**Interfaces:**
- Consumes: `getCurrentActor` (`@/modules/shared/auth/session`), `createClient`/`createBrowserClient`, `mfaGateStatus`/`mfaStepFor`/`AalLevel` (Task 1), `withTransaction` (`@/lib/db/tx`), `recordAuthEvent` (`@/modules/shared/auth/authEvents`).
- Produces: the `/mfa` route + `markMfaEnrolledAction(): Promise<{ ok: true } | { error: string }>`.

- [ ] **Step 1: Write the enrollment-stamp server action**

```ts
// app/mfa/actions.ts
'use server'

import { requireActor } from '@/modules/shared/auth/session'
import { createClient } from '@/lib/supabase/server'
import { withTransaction } from '@/lib/db/tx'
import { recordAuthEvent } from '@/modules/shared/auth/authEvents'

/**
 * Stamps the display-only `mfa_enrolled` flag after the client verifies a factor
 * and the session is genuinely AAL2. Idempotent (the WHERE clause no-ops when
 * already set, so no version churn) and non-authoritative — the gate reads live
 * AAL, never this flag. A failure here is logged, not surfaced as fatal.
 */
export async function markMfaEnrolledAction(): Promise<{ ok: true } | { error: string }> {
  try {
    const actor = await requireActor()
    const supabase = createClient()
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (data?.currentLevel !== 'aal2') return { ok: true } // not actually elevated → nothing to stamp

    await withTransaction(actor.id, async (tx) => {
      await tx.query(
        `UPDATE app_user
            SET mfa_enrolled = true, updated_at = now(), updated_by = $1, version = version + 1
          WHERE id = $1 AND mfa_enrolled = false`, [actor.id])
    })
    await recordAuthEvent({ userId: actor.id, eventType: 'mfa_enrolled' })
    return { ok: true }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'markMfaEnrolled failed', err: String(err) }))
    return { error: 'Could not record enrollment.' }
  }
}
```

- [ ] **Step 2: Write the client enroll/challenge component**

```tsx
// components/auth/MfaEnrollChallenge.tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'
import { markMfaEnrolledAction } from '@/app/mfa/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/** Wrong/expired codes are the common case; anything else gets a generic line. */
function friendly(message: string): string {
  if (/invalid|verification|code/i.test(message)) return 'That code was not accepted. Try the current 6-digit code.'
  return 'Something went wrong with two-factor setup. Refresh and try again.'
}

export function MfaEnrollChallenge({ initialStep }: { initialStep: 'enroll' | 'challenge' }) {
  const router = useRouter()
  const [supabase] = useState(() => createBrowserClient())
  const step = initialStep
  const [factorId, setFactorId] = useState<string | null>(null)
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Enroll: create a new TOTP factor and show its QR. Challenge: find the
  // verified factor and open a challenge. Runs once on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setError(null)
      if (step === 'enroll') {
        const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
        if (cancelled) return
        if (error) { setError(friendly(error.message)); return }
        setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret)
      } else {
        const { data: list, error: le } = await supabase.auth.mfa.listFactors()
        if (cancelled) return
        if (le) { setError(friendly(le.message)); return }
        const totp = list.totp?.find((f) => f.status === 'verified') ?? list.totp?.[0]
        if (!totp) { setError('No authenticator is set up. Ask an admin to reset your MFA.'); return }
        setFactorId(totp.id)
        const { data: ch, error: ce } = await supabase.auth.mfa.challenge({ factorId: totp.id })
        if (cancelled) return
        if (ce) { setError(friendly(ce.message)); return }
        setChallengeId(ch.id)
      }
    })()
    return () => { cancelled = true }
  }, [step, supabase])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setBusy(true); setError(null)
    try {
      // Enroll has no challenge yet; issue one now. Challenge pre-issued on mount.
      let chId = challengeId
      if (!chId) {
        const { data: ch, error: ce } = await supabase.auth.mfa.challenge({ factorId })
        if (ce) { setError(friendly(ce.message)); return }
        chId = ch.id
      }
      const { error: ve } = await supabase.auth.mfa.verify({ factorId, challengeId: chId, code: code.trim() })
      if (ve) { setError(friendly(ve.message)); setChallengeId(null); setCode(''); return } // consumed → re-challenge next submit
      await markMfaEnrolledAction()
      router.push('/'); router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>{step === 'enroll' ? 'Set up two-factor authentication' : 'Enter your authentication code'}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {step === 'enroll'
              ? 'Your role requires an authenticator app. Scan the code, then enter the 6-digit code to finish.'
              : 'Open your authenticator app and enter the current 6-digit code.'}
          </p>
        </CardHeader>
        <CardContent>
          {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
          {step === 'enroll' && qr && (
            <div className="mb-4 flex flex-col items-center gap-2">
              {/* Supabase returns the QR as an SVG data-URI; safe to render as an image src. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="Authenticator QR code" className="h-44 w-44" />
              {secret && <p className="font-mono text-xs text-muted-foreground break-all">Or enter manually: {secret}</p>}
            </div>
          )}
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="mfa-code">6-digit code</Label>
              <Input
                id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*"
                maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6 || !factorId}>
              {busy ? 'Verifying…' : step === 'enroll' ? 'Verify and continue' : 'Verify'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Write the `/mfa` server page**

```tsx
// app/mfa/page.tsx
import { redirect } from 'next/navigation'
import { getCurrentActor } from '@/modules/shared/auth/session'
import { createClient } from '@/lib/supabase/server'
import { mfaGateStatus, mfaStepFor, type AalLevel } from '@/modules/shared/auth/mfaPolicy'
import { MfaEnrollChallenge } from '@/components/auth/MfaEnrollChallenge'

/**
 * The MFA enrollment/challenge destination. Lives OUTSIDE the (platform) route
 * group so the platform layout's gate never redirects it back to itself. A
 * signed-in but not-yet-AAL2 MFA-required user lands here; everyone else is
 * bounced straight through.
 */
export default async function MfaPage() {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')

  const supabase = createClient()
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const currentLevel = (aal?.currentLevel ?? null) as AalLevel | null

  if (mfaGateStatus({ roleKey: actor.roleKey, currentLevel }) === 'satisfied') redirect('/')

  const { data: factors } = await supabase.auth.mfa.listFactors()
  const hasVerifiedFactor = (factors?.totp ?? []).some((f) => f.status === 'verified')
  const step = mfaStepFor({ hasVerifiedFactor, currentLevel })

  // step is 'enroll' | 'challenge' here (never 'done' — that path redirected above).
  return <MfaEnrollChallenge initialStep={step === 'challenge' ? 'challenge' : 'enroll'} />
}
```

- [ ] **Step 4: Verify types + build**

Run: `cd dlms && npx tsc --noEmit && npm run build`
Expected: clean; `/mfa` compiles. (The Supabase SDK MFA methods — `enroll`, `challenge`, `verify`, `listFactors`, `getAuthenticatorAssuranceLevel` — are on `@supabase/supabase-js` ^2.49; if a method name/shape mismatches the installed types, `tsc` will flag it — fix against the installed types, do not `any`-cast past it. `listFactors()` client-side returns `{ totp, all }`; `enroll` returns `{ id, totp: { qr_code, secret, uri } }`.)

- [ ] **Step 5: Commit**

```bash
git add dlms/app/mfa/page.tsx dlms/components/auth/MfaEnrollChallenge.tsx dlms/app/mfa/actions.ts
git commit -m "feat(auth): /mfa TOTP enroll+challenge screen and enrollment stamp"
```

---

## Task 3: Platform layout gate

**Files:**
- Modify: `app/(platform)/layout.tsx`

**Interfaces:**
- Consumes: `requiresMfa`, `mfaGateStatus`, `AalLevel` (Task 1); `createClient` (`@/lib/supabase/server`).

- [ ] **Step 1: Add the gate**

Add imports:

```tsx
import { createClient } from '@/lib/supabase/server'
import { requiresMfa, mfaGateStatus, type AalLevel } from '@/modules/shared/auth/mfaPolicy'
```

Immediately after the existing `const actor = await getCurrentActor(); if (!actor) redirect('/login')`, insert:

```tsx
  // Mandatory MFA (spec §5.2): an MFA-required role must reach AAL2 before any
  // module. The AAL read is skipped entirely for roles that don't need it, so
  // non-MFA users pay nothing. Fail closed — a null level routes to /mfa.
  if (requiresMfa(actor.roleKey)) {
    const supabase = createClient()
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    const currentLevel = (aal?.currentLevel ?? null) as AalLevel | null
    if (mfaGateStatus({ roleKey: actor.roleKey, currentLevel }) === 'required') redirect('/mfa')
  }
```

- [ ] **Step 2: Verify types + build + full unit suite**

Run: `cd dlms && npx tsc --noEmit && npm test && npm run build`
Expected: clean; unit suite still green; build compiles.

- [ ] **Step 3: Commit**

```bash
git add "dlms/app/(platform)/layout.tsx"
git commit -m "feat(auth): gate the platform area on AAL2 for MFA-required roles"
```

---

## Task 4: `resetUserMfa` service + admin action

**Files:**
- Modify: `modules/admin/services/userService.ts`
- Modify: `app/(platform)/admin/users/actions.ts`
- Test: `__tests__/integration/resetUserMfa.test.ts`

**Interfaces:**
- Consumes: `authorize` (`@/modules/shared/authz/authorize`), `withTransaction` (`@/lib/db/tx`), `createAdminClient` (`@/lib/supabase/server`), `recordAuthEvent`, `Actor`.
- Produces:
  - `resetUserMfa(actor: Actor, targetUserId: string): Promise<void>`
  - `resetUserMfaAction(targetUserId: string): Promise<{ ok: true } | { error: string }>`

- [ ] **Step 1: Write the failing integration test**

```ts
// __tests__/integration/resetUserMfa.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'

const listFactors = vi.fn()
const deleteFactor = vi.fn()
const authEventInsert = vi.fn(async () => ({ error: null }))

// createAdminClient serves BOTH the admin MFA API and recordAuthEvent's insert.
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    auth: { admin: { mfa: { listFactors, deleteFactor } } },
    from: (_t: string) => ({ insert: authEventInsert }),
  }),
  createClient: () => ({}),
  createReadClient: () => ({}),
}))

import { resetUserMfa } from '@/modules/admin/services/userService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

let db: Client
let adminId: string, targetId: string
const AUTH_UID = '11111111-2222-3333-4444-555555555555'

const admin = (): Actor => ({
  id: adminId, roleKey: 'admin',
  permissions: new Set(['manage_users']), moduleAccess: new Set(['admin']), active: true,
})
const nobody = (): Actor => ({
  id: adminId, roleKey: 'operator',
  permissions: new Set([]), moduleAccess: new Set(['admin']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  adminId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => {
  if (targetId) await db.query(`DELETE FROM app_user WHERE id=$1`, [targetId])
  await db.end(); await getPool().end()
})
beforeEach(async () => {
  listFactors.mockReset(); deleteFactor.mockReset(); authEventInsert.mockClear()
  listFactors.mockResolvedValue({ data: { factors: [{ id: 'factor-1' }] }, error: null })
  deleteFactor.mockResolvedValue({ error: null })
  // fresh target each test: an MFA-enrolled admin WITH a linked auth id
  if (targetId) await db.query(`DELETE FROM app_user WHERE id=$1`, [targetId])
  targetId = (await db.query(
    `INSERT INTO app_user (email, role_id, active, mfa_enrolled, auth_user_id, created_by, updated_by)
     VALUES ('mfa-target@example.com', (SELECT id FROM role WHERE key='admin'), true, true, $1, $2, $2)
     RETURNING id`, [AUTH_UID, adminId])).rows[0].id
})

describe('resetUserMfa', () => {
  it('refuses an actor without manage_users', async () => {
    await expect(resetUserMfa(nobody(), targetId)).rejects.toThrow(PermissionError)
  })

  it('deletes the target factors, clears the flag, and writes an mfa_reset event', async () => {
    await resetUserMfa(admin(), targetId)
    expect(listFactors).toHaveBeenCalledWith({ userId: AUTH_UID })
    expect(deleteFactor).toHaveBeenCalledWith({ id: 'factor-1', userId: AUTH_UID })
    const row = await db.query(`SELECT mfa_enrolled FROM app_user WHERE id=$1`, [targetId])
    expect(row.rows[0].mfa_enrolled).toBe(false)
    expect(authEventInsert).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'mfa_reset' }))
  })

  it('throws for a user with no linked auth identity, and touches no factors', async () => {
    await db.query(`UPDATE app_user SET auth_user_id = NULL WHERE id=$1`, [targetId])
    await expect(resetUserMfa(admin(), targetId)).rejects.toThrow(/linked login/i)
    expect(deleteFactor).not.toHaveBeenCalled()
    const row = await db.query(`SELECT mfa_enrolled FROM app_user WHERE id=$1`, [targetId])
    expect(row.rows[0].mfa_enrolled).toBe(true) // unchanged
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dlms && docker compose -f docker-compose.test.yml up -d --wait && npx vitest run --config vitest.integration.config.ts __tests__/integration/resetUserMfa.test.ts`
Expected: FAIL — `resetUserMfa` not exported.

- [ ] **Step 3: Implement `resetUserMfa` (append to `userService.ts`)**

Ensure these are imported at the top of `userService.ts` (add any missing): `createAdminClient` from `@/lib/supabase/server`, `recordAuthEvent` from `@/modules/shared/auth/authEvents`. `authorize`, `withTransaction`, `Actor` are already imported.

```ts
/**
 * Resets a user's MFA (spec §5.6, the recovery path). Reads the target's linked
 * auth id, deletes every Supabase TOTP factor via the admin API, clears the
 * display flag, and trails an mfa_reset event — so the user must re-enroll on
 * next login. The whole thing runs inside one withTransaction so a factor-delete
 * failure rolls back the flag write (the external GoTrue calls are awaited
 * inside the tx deliberately — a rare admin action, kept atomic with the flag).
 */
export async function resetUserMfa(actor: Actor, targetUserId: string): Promise<void> {
  authorize(actor, 'manage_users', 'admin')

  await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ auth_user_id: string | null }>(
      `SELECT auth_user_id FROM app_user WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [targetUserId])
    if (rows.length === 0) throw new Error(`User ${targetUserId} not found`)
    const authUserId = rows[0].auth_user_id
    if (!authUserId) throw new Error('That user has no linked login yet — nothing to reset')

    const supabase = createAdminClient()
    const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId: authUserId })
    if (error) throw new Error(error.message)
    for (const f of data?.factors ?? []) {
      const { error: de } = await supabase.auth.admin.mfa.deleteFactor({ id: f.id, userId: authUserId })
      if (de) throw new Error(de.message)
    }

    await tx.query(
      `UPDATE app_user
          SET mfa_enrolled = false, updated_at = now(), updated_by = $1, version = version + 1
        WHERE id = $2`, [actor.id, targetUserId])
  })

  await recordAuthEvent({ userId: targetUserId, eventType: 'mfa_reset', detail: { by: actor.id } })
}
```

- [ ] **Step 4: Add the admin action (append to `app/(platform)/admin/users/actions.ts`)**

Add `resetUserMfa` to the existing import from `@/modules/admin/services/userService`, then:

```ts
/** Resets a user's MFA factor (admin recovery). They re-enroll on next login. */
export async function resetUserMfaAction(userId: string): Promise<ActionResult> {
  const actor = await requireActor()
  try {
    await resetUserMfa(actor, userId)
    revalidatePath('/admin/users')
    return { ok: true }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd dlms && npx vitest run --config vitest.integration.config.ts __tests__/integration/resetUserMfa.test.ts && npx tsc --noEmit`
Expected: 3/3 pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add dlms/modules/admin/services/userService.ts "dlms/app/(platform)/admin/users/actions.ts" dlms/__tests__/integration/resetUserMfa.test.ts
git commit -m "feat(auth): admin resetUserMfa service + action"
```

---

## Task 5: Admin "Reset MFA" control + full verification

**Files:**
- Modify: `components/admin/UserTable.tsx`
- Modify: `dlms/docs/superpowers/PROGRESS.md`

**Interfaces:**
- Consumes: `resetUserMfaAction` (Task 4); the existing `UserTable` row shape (already carries `mfaEnrolled`, `id`).

- [ ] **Step 1: Read `UserTable.tsx`** to match its existing control idiom (how `setUserActiveAction`/`resendInviteAction` are wired — button + pending state + toast/error). Add a per-row **"Reset MFA"** control for users the current actor can manage, following that exact idiom: it calls `resetUserMfaAction(user.id)`, shows a confirm ("This signs them out of MFA — they'll set it up again on next login."), toasts success/error from the `{ ok } | { error }` result, and refreshes. Do not change any other column or the existing controls. If the file gates controls behind a `can`/`currentUserId` check already present, reuse it; the reset control should appear wherever the other management controls do.

- [ ] **Step 2: Verify types + build**

Run: `cd dlms && npx tsc --noEmit && npm run build`
Expected: clean; `/admin/users` compiles with the new control.

- [ ] **Step 3: Full suite**

Run: `cd dlms && npx tsc --noEmit && npm test && npm run test:integration && npm run build`
Expected: type-check clean; unit + integration green; build succeeds. Record counts.

- [ ] **Step 4: Update PROGRESS.md**

Add a row to the Phase-2 table (or the standup) marking **mandatory MFA enforcement** ✅ — pure gate/step logic, layout gate, `/mfa` enroll+challenge, admin factor-reset; N unit + M integration; note the remaining rollout deps (enable TOTP on cloud, Super Admin bootstrap, one manual end-to-end pass). Flip the standup's "enable TOTP MFA" line to reflect that enforcement now exists in-app and only the dashboard toggle + manual verification remain.

- [ ] **Step 5: Commit**

```bash
git add dlms/components/admin/UserTable.tsx dlms/docs/superpowers/PROGRESS.md
git commit -m "feat(auth): Reset MFA control in the Users console; mark MFA enforcement complete"
```

---

## Manual end-to-end verification (after merge, once cloud TOTP is enabled + Super Admin bootstrapped)

Not a code task — the checklist for the one manual pass the spec calls for:
1. Enable the TOTP factor on `qtx-ops-platform` (dashboard) and bootstrap the Super Admin auth identity + link `auth_user_id`.
2. Sign in as the Super Admin → land in the platform → confirm redirect to `/mfa` (enroll) → scan QR in an authenticator → enter code → land on `/`.
3. Sign out, sign back in → confirm redirect to `/mfa` (challenge) → code → `/`.
4. As an admin, "Reset MFA" on a test user → that user's next login forces re-enrollment.
5. Confirm a non-MFA role (e.g. operator/viewer) is never sent to `/mfa`.

---

## Self-Review

**Spec coverage:**
- §5.1 pure `mfaGateStatus`/`mfaStepFor` → Task 1. §5.2 layout gate → Task 3. §5.3/§5.4 `/mfa` page + client flow → Task 2. §5.5 `markMfaEnrolledAction` → Task 2. §5.6 `resetUserMfa` → Task 4. §5.7 admin UI control → Task 5. §7 fail-closed (null AAL) → covered in Tasks 1 (tests) + 2/3 (`?? null`). §8 testing split (pure unit + resetUserMfa integration + wiring via tsc/build + manual) → Tasks 1/4 tested, 2/3/5 build-gated, manual checklist appended.
- §6 "no schema/cloud change" → honored; no migration task exists.

**Placeholder scan:** every code step carries complete code except Task 5 Step 1, which is deliberately "read the file then match its idiom" because `UserTable.tsx`'s exact control markup isn't known here — the implementer reads it and follows the established `setUserActiveAction`/`resendInviteAction` pattern. That is an instruction, not a placeholder for logic.

**Type consistency:** `AalLevel`, `mfaGateStatus`, `mfaStepFor` defined in Task 1 and consumed by Tasks 2/3 with matching signatures. `markMfaEnrolledAction`/`resetUserMfaAction` return `{ ok: true } | { error: string }` — the admin console's existing `ActionResult` shape (Task 4 reuses the file's `ActionResult`/`toUserMessage`). `resetUserMfa(actor, targetUserId): Promise<void>` consistent between Task 4 definition and its action wrapper.

**Risk notes for the implementer:**
- The Supabase MFA method names/shapes are the highest risk. `tsc` is the guard — if `enroll`/`challenge`/`verify`/`listFactors`/`getAuthenticatorAssuranceLevel`/`admin.mfa.listFactors`/`admin.mfa.deleteFactor` differ in the installed `@supabase/supabase-js` ^2.49, adjust to the installed types (never `any`-cast past a real mismatch). Client `listFactors()` → `{ totp, all }`; admin `listFactors({ userId })` → `{ factors }`.
- `getAuthenticatorAssuranceLevel()` must work in the server component (layout + `/mfa` page). It reads the session JWT; the `@supabase/ssr` server client supports it. If it ever can't resolve server-side, the `?? null` fail-closed path sends the user to `/mfa` — safe, not a lockout of non-MFA roles (they skip the check).
- Keep `/mfa` OUTSIDE `app/(platform)/` — inside it, the layout gate would loop.
