/**
 * Server-side clinician email allowlist — the app's real authorization gate.
 *
 * Supabase's "allow signups" toggle is dashboard-only. Until it is disabled,
 * anyone holding the public anon key could self-register and obtain a valid
 * session. This allowlist makes self-signup useless: only emails explicitly
 * listed in CLINICIAN_EMAIL_ALLOWLIST (server-only, comma-separated) may use
 * the app.
 *
 * FAILS CLOSED: an unset or empty allowlist authorizes NO ONE. Never open.
 * Used by both the BFF proxy (web/app/api/[...path]/route.ts) and the
 * middleware page gate (web/middleware.ts).
 */
export function getAllowlist(): string[] {
  return (process.env.CLINICIAN_EMAIL_ALLOWLIST ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false
  const allow = getAllowlist()
  if (allow.length === 0) return false // fail closed — empty/unset denies everyone
  return allow.includes(email.trim().toLowerCase())
}
