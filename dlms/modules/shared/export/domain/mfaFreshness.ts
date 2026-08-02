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
 * Pure, with `now` injected — the house convention.
 */

export type AuthenticationMethod = { method: string; timestamp: string }

/** Five minutes: long enough to fill in a reason, short enough to need the device. */
export const EXPORT_MFA_MAX_AGE_SECONDS = 300

/**
 * Tolerance for the auth server's clock running ahead of ours. A modest skew is
 * ordinary; an hour is not, and a far-future stamp would otherwise stay "fresh"
 * indefinitely, which is the one direction this check must not fail in.
 */
export const MFA_CLOCK_SKEW_SECONDS = 60

/**
 * Whether a second factor was presented within `maxAgeSeconds`.
 *
 * FAILS CLOSED on everything ambiguous: no methods, no second factor among them,
 * an unparseable timestamp, or a timestamp implausibly far in the future all
 * return false. The cost of a false negative is re-entering a TOTP code; the cost
 * of a false positive is a full-system export of every record the company holds.
 *
 * A method counts as a second factor when its name mentions TOTP or MFA.
 * Supabase has spelled this 'totp' and 'mfa/totp' across versions, and matching
 * loosely fails safe in the right direction: an unrecognised NEW factor name
 * fails closed (refuse the export) rather than open.
 */
export function isMfaFresh(
  methods: readonly AuthenticationMethod[] | null | undefined,
  now: Date,
  maxAgeSeconds: number = EXPORT_MFA_MAX_AGE_SECONDS,
): boolean {
  if (!methods || methods.length === 0) return false

  const secondFactors = methods.filter((m) => /totp|mfa/i.test(m.method ?? ''))
  if (secondFactors.length === 0) return false

  // The most recent satisfying entry wins: re-challenging an already-AAL2 session
  // appends a newer stamp, and that is exactly the act being demanded here.
  return secondFactors.some((m) => {
    const at = Date.parse(m.timestamp ?? '')
    if (Number.isNaN(at)) return false
    const ageSeconds = (now.getTime() - at) / 1000
    if (ageSeconds < -MFA_CLOCK_SKEW_SECONDS) return false
    return ageSeconds <= maxAgeSeconds
  })
}
