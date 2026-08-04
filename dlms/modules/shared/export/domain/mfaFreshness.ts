/**
 * "Super Admin + fresh MFA" (spec §12, §7.4) — the second half of the
 * full-system-export ceremony.
 *
 * AAL2 alone is not enough here. A session reaches AAL2 once and stays there for
 * as long as it lives, so an unattended laptop signed in this morning still
 * satisfies `requireAal2Actor` this afternoon. The whole control on a full-system
 * export is the ceremony at the moment of the request — spec §12 says the
 * requester ceremony IS the control, in place of field redaction — so the second
 * factor must have been presented RECENTLY, not merely at some point.
 *
 * The input is Supabase's `currentAuthenticationMethods` from
 * `auth.mfa.getAuthenticatorAssuranceLevel()`: the AMR claim, one entry per
 * authentication method with the instant it was satisfied.
 *
 * ── THE TIMESTAMP IS A NUMBER, IN SECONDS, AND GETTING THAT WRONG DISABLED THE
 *    WHOLE FEATURE ─────────────────────────────────────────────────────────
 * `AMREntry.timestamp` in @supabase/auth-js is documented as "number of seconds
 * since 1st January 1970 (UNIX epoch) in UTC". An earlier version of this module
 * declared it `string` and aged it with `Date.parse(m.timestamp)`.
 * `Date.parse(1754300000)` is `NaN`, so the freshness check returned false for
 * EVERY real request: a Super Admin who had entered their TOTP code five seconds
 * earlier got a 403, and the export could never be downloaded at all. Twelve unit
 * tests were green throughout, because they built ISO strings the production code
 * never sees. That is why the type here is now structurally the SDK's own — the
 * route passes `currentAuthenticationMethods` with no cast, so a shape change in
 * a future SDK is a compile error rather than a silent, permanent refusal.
 *
 * ── AND `string[]` IS A REAL SHAPE TOO ─────────────────────────────────────
 * `currentAuthenticationMethods` is typed `AMREntry[] | string[]`: the RFC-8176
 * form is a bare list of method names — `['password', 'otp']` — with no times in
 * it. It is handled explicitly below rather than falling through some coercion,
 * and it REFUSES, because "when" is the only question this function asks and that
 * form cannot answer it.
 *
 * Pure, with `now` injected — the house convention.
 */

/** One AMR entry. Structurally `AMREntry` from @supabase/auth-js. */
export type AuthenticationMethod = {
  method: string
  /** UNIX epoch **SECONDS**, UTC. Not milliseconds, and not a string. */
  timestamp: number
}

/**
 * Exactly what `getAuthenticatorAssuranceLevel()` hands back, per entry: either
 * the detailed object or the RFC-8176 bare method name.
 */
export type AuthenticationMethodClaim = AuthenticationMethod | string

/** Five minutes: long enough to fill in a reason, short enough to need the device. */
export const EXPORT_MFA_MAX_AGE_SECONDS = 300

/**
 * Tolerance for the auth server's clock running ahead of ours. A modest skew is
 * ordinary; an hour is not, and a far-future stamp would otherwise stay "fresh"
 * indefinitely, which is the one direction this check must not fail in.
 */
export const MFA_CLOCK_SKEW_SECONDS = 60

/**
 * Why a claim was refused — or `'fresh'` when it was not.
 *
 * This exists because the failure that shipped here was INDISTINGUISHABLE from
 * the expected one: "the export is always 403" and "your code expired" produced
 * the same response, the same message and the same (absent) log line. The route
 * records this alongside its refusal so the next such defect is one grep away.
 */
export type MfaFreshnessReason =
  | 'fresh'
  /** No AMR claim at all — not signed in, or the claim could not be read. */
  | 'no-methods'
  /** Methods present, none of them a second factor (password-only session). */
  | 'no-second-factor'
  /** A second factor is present but carries no usable time (RFC-8176 string form). */
  | 'no-timestamp'
  /** Timed, but outside the freshness window — or implausibly far in the future. */
  | 'stale'

/**
 * A method counts as a second factor when its name mentions TOTP or MFA.
 * Supabase has spelled this 'totp' and 'mfa/totp' across versions, and matching
 * loosely fails safe in the right direction: an unrecognised NEW factor name
 * fails closed (refuse the export) rather than open.
 */
function isSecondFactor(m: AuthenticationMethodClaim): boolean {
  const name = typeof m === 'string' ? m : m?.method
  return /totp|mfa/i.test(name ?? '')
}

/** Epoch milliseconds for an entry, or null when it carries no usable time. */
function epochMsOf(m: AuthenticationMethodClaim): number | null {
  // RFC-8176 form: a method name and nothing else. Not an error — just unanswerable.
  if (typeof m === 'string') return null
  const t = m?.timestamp
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  return t * 1000
}

/**
 * Whether a second factor was presented within `maxAgeSeconds`, and why not.
 *
 * FAILS CLOSED on everything ambiguous: no methods, no second factor among them,
 * a missing or non-finite timestamp, the timestamp-free RFC-8176 form, or a
 * timestamp implausibly far in the future all refuse. The cost of a false
 * negative is re-entering a TOTP code; the cost of a false positive is a
 * full-system export of every record the company holds.
 *
 * The most recent satisfying entry wins: re-challenging an already-AAL2 session
 * appends a newer stamp, and that is exactly the act being demanded here.
 */
export function mfaFreshnessReason(
  methods: readonly AuthenticationMethodClaim[] | null | undefined,
  now: Date,
  maxAgeSeconds: number = EXPORT_MFA_MAX_AGE_SECONDS,
): MfaFreshnessReason {
  if (!methods || methods.length === 0) return 'no-methods'

  const secondFactors = methods.filter(isSecondFactor)
  if (secondFactors.length === 0) return 'no-second-factor'

  let sawTimestamp = false
  for (const m of secondFactors) {
    const at = epochMsOf(m)
    if (at === null) continue
    sawTimestamp = true
    const ageSeconds = (now.getTime() - at) / 1000
    if (ageSeconds < -MFA_CLOCK_SKEW_SECONDS) continue
    if (ageSeconds <= maxAgeSeconds) return 'fresh'
  }

  // A second factor with no readable time is a DIFFERENT problem from one that
  // has simply aged out, and conflating them is what hid this bug for a release.
  return sawTimestamp ? 'stale' : 'no-timestamp'
}

/**
 * The gate itself. `mfaFreshnessReason(...) === 'fresh'` by construction, so the
 * two can never disagree about a claim — the reason exists to explain a refusal,
 * never to decide one differently.
 */
export function isMfaFresh(
  methods: readonly AuthenticationMethodClaim[] | null | undefined,
  now: Date,
  maxAgeSeconds: number = EXPORT_MFA_MAX_AGE_SECONDS,
): boolean {
  return mfaFreshnessReason(methods, now, maxAgeSeconds) === 'fresh'
}
