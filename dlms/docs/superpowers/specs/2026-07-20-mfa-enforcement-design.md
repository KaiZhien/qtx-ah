# Mandatory MFA Enforcement — Design

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-07-20 |
| **Status** | Approved (design) |
| **Depends on** | Cloud Auth standup (TOTP factor enabled on `qtx-ops-platform`; Super Admin auth identity bootstrapped) |
| **Parent** | [ops-platform design §D35, interview "Admins mandatory MFA"](2026-07-17-ops-platform-design.md) |

## 1. Problem

The platform already *declares* which roles must use MFA — `modules/shared/auth/mfaPolicy.ts` exports `requiresMfa(roleKey)` returning true for `super_admin`, `admin`, `finance` — and the admin console tracks an `mfa_enrolled` flag and the audit layer has `mfa_enrolled` / `mfa_reset` event types. But **nothing enforces it**: `getCurrentActor()` (`modules/shared/auth/session.ts`) and `middleware.ts` only verify a valid Supabase session (AAL1 / password), never the authenticator assurance level. An admin whose password is stolen holds full powers with no second factor. Enabling the Supabase TOTP factor makes MFA *available* but not *required*.

This spec adds the missing enforcement: the three MFA-required platform roles cannot reach any `(platform)` route until their session is **AAL2** (password + a verified TOTP challenge).

## 2. Goal & non-goals

**Goal.** Force `super_admin`/`admin`/`finance` through TOTP enrollment (first time) and a TOTP challenge (each new session) before they can use the platform; give admins a way to reset a locked-out user's factor.

**Non-goals (explicit follow-ups, do not build here):**
- **AAL2 enforcement at the server-action/capability layer.** This build gates *page rendering* via the platform layout; it does NOT gate direct server-action dispatches (Next.js layouts don't run for actions — see §7). Closing that is the **immediate follow-up** (`assertAal2()` in `requireActor` or the privileged actions), tracked separately, so the capability layer is genuinely AAL2-only.
- Recovery/backup codes (chosen recovery path is admin-initiated factor reset).
- Enforcing MFA on the `/legacy` DLMS app (it has its own separate auth/roles).
- Changing the post-login landing route (`/login` still redirects to `/legacy`; see §7).
- Deriving `requiresMfa` from permissions — it stays an explicit role set so adding a permission can't silently relax a login requirement (existing decision, preserved).

## 3. Key decisions (resolved)

| Decision | Choice | Why |
|---|---|---|
| Enforcement gate location | The `(platform)` **layout server component** | It already resolves the actor (role via DB) and can read session AAL; one check covers every platform route. Middleware can't (no DB → no role); `requireActor()` is too deep and called too widely. |
| Recovery on lost device | **Admin-initiated factor reset** | Fits the admin model; reuses the existing `mfa_reset` event; no code-shipping of backup secrets. Super Admin self-recovers via the Supabase dashboard. |
| Enforcement surface | **`(platform)` area only** | The MFA-required roles are platform roles; `/legacy` keeps its own auth. |
| Source of truth for the gate | **Live Supabase AAL / factors**, never the stored `mfa_enrolled` bool | The bool is a display convenience that can drift; the gate must read the real session state. |

## 4. Architecture & flow

```
password login (unchanged)  ──►  any (platform) route
                                        │
                          PlatformLayout (server component)
                                        │  actor = getCurrentActor()
                                        │  if !actor → /login   (existing)
                                        │  if requiresMfa(role) && AAL != aal2 → /mfa
                                        ▼
                                   render module
```

`/mfa` (a route **outside** the `(platform)` group, so the gate cannot loop on it; still session-required via middleware):

```
/mfa server page: resolve actor + AAL
   if !requiresMfa(role) || AAL == aal2 → redirect '/'
   else render <MfaEnrollChallenge>  (client)
        step = mfaStepFor({ hasVerifiedFactor, currentLevel })
          'enroll'    → mfa.enroll(totp) → show QR+secret → mfa.challenge → mfa.verify(code)
          'challenge' → mfa.challenge(existing factor) → mfa.verify(code)
        on AAL2 → server action markMfaEnrolled() → router.push('/')
```

AAL is read via the Supabase SDK's `auth.mfa.getAuthenticatorAssuranceLevel()` which returns `{ currentLevel, nextLevel }` off the session JWT `aal` claim (works both server-side in the layout and client-side). The enroll/challenge/verify calls run **client-side** (browser Supabase client) because they mutate the browser session to AAL2; the refreshed cookie is picked up by middleware so the next server render sees AAL2.

## 5. Components & interfaces

### 5.1 Pure decision logic — `modules/shared/auth/mfaPolicy.ts` (extend)
No I/O; unit-tested. Keeps `requiresMfa` unchanged and adds:

```ts
export type AalLevel = 'aal1' | 'aal2'

/** The gate: does this actor still owe a second factor to enter the platform? */
export function mfaGateStatus(input: { roleKey: RoleKey; currentLevel: AalLevel | null }):
  'satisfied' | 'required' {
  if (!requiresMfa(input.roleKey)) return 'satisfied'
  return input.currentLevel === 'aal2' ? 'satisfied' : 'required'
}

/** What the /mfa screen should do given the user's factor + session state. */
export function mfaStepFor(input: { hasVerifiedFactor: boolean; currentLevel: AalLevel | null }):
  'enroll' | 'challenge' | 'done' {
  if (input.currentLevel === 'aal2') return 'done'
  return input.hasVerifiedFactor ? 'challenge' : 'enroll'
}
```

`currentLevel: null` (SDK returned no data / error) is treated as not-AAL2 → fail-closed to `required`/`enroll`.

### 5.2 Gate wiring — `app/(platform)/layout.tsx` (modify)
After the existing `actor`/`redirect('/login')` block, add: if `mfaGateStatus({ roleKey: actor.roleKey, currentLevel })` is `'required'`, `redirect('/mfa')`. `currentLevel` comes from `createClient().auth.mfa.getAuthenticatorAssuranceLevel()`. Only calls the SDK when `requiresMfa(actor.roleKey)` is true, so non-MFA roles pay nothing.

### 5.3 `/mfa` route — `app/mfa/page.tsx` (new, outside the group)
Server component. Resolves the actor (`getCurrentActor()`; if none → `/login`) and AAL. If `mfaGateStatus` is `'satisfied'` → `redirect('/')` (nobody sits on `/mfa` who doesn't need it). Otherwise renders `<MfaEnrollChallenge initialStep=… />`.

### 5.4 `components/auth/MfaEnrollChallenge.tsx` (new, client)
Uses the browser Supabase client (`lib/supabase/client.ts`). Drives `mfaStepFor`:
- **enroll:** `mfa.enroll({ factorType: 'totp' })` → render `data.totp.qr_code` (SVG data-URI) + `data.totp.secret` for manual entry → user submits 6-digit code → `mfa.challenge({ factorId })` → `mfa.verify({ factorId, challengeId, code })`.
- **challenge:** list factors, pick the verified TOTP factor → `mfa.challenge` → `mfa.verify`.
- On verify success (session now AAL2): call `markMfaEnrolledAction()` then `router.push('/')` + `router.refresh()`.
- Errors (wrong code, expired challenge) are shown inline; the raw SDK error is mapped to a friendly message, never dumped.

### 5.5 `app/mfa/actions.ts` (new, server action)
`markMfaEnrolledAction()`: re-resolves the actor (must be signed in), and if the session is genuinely AAL2, sets `app_user.mfa_enrolled = true` for the actor and writes `recordAuthEvent({ userId, eventType: 'mfa_enrolled' })`. Idempotent (safe to call when already true). This flag is display-only; it never gates.

### 5.6 Admin reset — `modules/admin/services/userService.ts` (add `resetUserMfa`)
```ts
export async function resetUserMfa(actor: Actor, targetUserId: string): Promise<void>
```
`authorize(actor, 'manage_users', 'admin')` first. Look up the target `app_user` (its `auth_user_id`; error if unlinked). Via the Supabase **admin** API list the target's factors and delete each; set `app_user.mfa_enrolled = false`; `recordAuthEvent({ userId: targetUserId, eventType: 'mfa_reset', detail: { by: actor.id } })`. Next login → no factor → forced re-enroll. Guard: the last-admin / self rules already in `userService` are unaffected (reset doesn't change role/active).

### 5.7 Admin UI — `app/(platform)/admin/users/{actions.ts, page.tsx}` + user table (modify)
`resetUserMfaAction(targetUserId)` wraps `resetUserMfa` with the established `{ ok } | { ok:false, error }` sanitization contract. A "Reset MFA" control appears per user for actors with `manage_users`, confirms ("This signs them out of MFA; they re-enroll next login"), calls the action, toasts, refreshes. Shows the `mfaEnrolled` state the console already loads.

## 6. Data & auth model (already present — no migration)
- `app_user.mfa_enrolled boolean` — exists (`20260718000000_platform_rbac.sql`); display flag only.
- `auth_event.event_type` includes `'mfa_enrolled'`, `'mfa_reset'` — exists (`authEvents.ts`).
- `app_user.auth_user_id` — the link `fn_resolve_actor` matches on; the reset path reads it to address the Supabase admin factor API. **This build changes no schema and applies nothing to cloud.**

## 7. Known interactions & error handling
- **Post-login landing.** `/login` still redirects to `/legacy`. An MFA-required user therefore reaches the gate the moment they open a platform route, not immediately at login. Redirecting platform users straight to `/` after login is a noted follow-up, not part of this build.
- **Scope of enforcement — page rendering, NOT server actions (important).** The gate lives in the platform layout, which Next.js runs for page/segment *rendering* but **not** for server-action dispatches. So a session at AAL1 (valid password cookie, no TOTP) is redirected away from every platform page, yet can still invoke a privileged server action directly (the action IDs are in the client bundle); those actions check `requireActor()` + `authorize()` but not AAL. This build therefore gates the **UI**, not the **capability layer** — it raises the bar for a stolen password but does not fully close it. Making privileged actions AAL2-only is the immediate follow-up (§2 non-goals). This is not deployed and has no live users at time of writing, so the residual risk is accepted for this increment and tracked, not shipped as "complete enforcement."
- **AAL read failure.** If `getAuthenticatorAssuranceLevel()` errors or returns no data, `currentLevel` is `null` → `mfaGateStatus` returns `'required'` (fail closed) → the user is sent to `/mfa`, which will enroll or challenge. No open-access path on error.
- **Deactivation still wins.** `getCurrentActor()` already returns null for inactive users before the MFA check runs, so a deactivated admin is bounced to `/login`, never to `/mfa`.
- **Reset of an unlinked user** (`auth_user_id` NULL) throws a clear service error surfaced through the action contract.
- **`markMfaEnrolledAction` called at AAL1** (e.g. verify raced): it checks AAL2 before stamping and no-ops otherwise; the flag is non-authoritative regardless.

## 8. Testing strategy
- **Pure (`mfaPolicy.ts`):** unit tests for `mfaGateStatus` (each role × {aal1, aal2, null}) and `mfaStepFor` ({factor?, level} matrix), including the `null` fail-closed cases.
- **`resetUserMfa`:** unit test with the `__tests__/supabaseChainMock.ts` pattern + a mocked `auth.admin.mfa` (asserts: authorizes `manage_users`; lists + deletes each factor; sets `mfa_enrolled=false`; writes the `mfa_reset` event; throws on an unlinked user).
- **`markMfaEnrolledAction` / `resetUserMfaAction`:** unit tests that a raw error never leaks (the sanitization contract), mirroring `deviceWriteActions`/`componentActions`.
- **Gate wiring & `/mfa` client flow:** the GoTrue enroll/challenge/verify calls cannot run against the local Postgres integration harness, so they are covered by (a) the pure functions above and (b) thin components that delegate to them with a mocked Supabase auth client; verified end-to-end by **one manual pass** against the cloud `qtx-ops-platform` project after TOTP is enabled and the Super Admin identity is bootstrapped.
- **Whole suite:** `npx tsc --noEmit`, `npm test`, `npm run build` stay green; no new integration-DB tests required (no schema change).

## 9. Rollout dependencies (outside this build, tracked in PROGRESS standup)
1. Enable the TOTP factor on `qtx-ops-platform` (dashboard) — without it, `mfa.enroll` fails.
2. Bootstrap the Super Admin auth identity + link `app_user.auth_user_id` — without a login there is nothing to enroll.
3. After merge: the manual end-to-end verification pass (enroll → sign out → sign in → challenge → reset → re-enroll).
