import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * The shared-secret gate for endpoints whose callers have no session — the outbox drain and
 * the scheduled-job runner.
 *
 * Extracted from app/api/outbox/drain/route.ts rather than reimplemented, because there are
 * now two routes and three secrets-checks between them, and the properties that matter here
 * are exactly the ones that get quietly dropped when a security check is copy-pasted:
 * constant-time comparison, hashing to defeat the length side-channel, and REFUSING WHEN THE
 * SECRET IS UNSET. The drain route's behaviour is unchanged; it now calls this.
 *
 * WHY UNSET MUST REFUSE. Treating "no secret configured" as "no authentication required"
 * turns a forgotten environment variable into a publicly drainable endpoint — and a
 * deployment that silently works without its credential is one nobody notices is missing.
 * Both callers therefore fail closed, and both report the misconfiguration to the server log
 * rather than to the caller.
 */

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` THROWS on buffers of differing length, so comparing the raw bytes would
 * need a length check first — and that check both re-introduces the early-exit timing signal
 * the function exists to remove and leaks the expected secret's length through whichever
 * branch it takes. Hashing both sides first makes every comparison exactly 32 bytes against
 * 32 bytes: the throw is unreachable, no length is observable, and the comparison itself
 * stays constant-time.
 */
export function secretMatches(presented: string, expected: string): boolean {
  const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
  return timingSafeEqual(sha256(presented), sha256(expected))
}

/**
 * The bearer token, or null when the header is absent or malformed.
 *
 * `Authorization: Bearer <secret>` specifically, because that is the shape Vercel Cron
 * sends (`Bearer $CRON_SECRET`). The scheme is matched case-insensitively per RFC 7235, and
 * `\S+` rejects an empty token so a blank credential can never reach the comparison.
 */
export function bearerToken(req: { headers: { get(name: string): string | null } }): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}

/**
 * Authorizes a request against the named environment secret.
 *
 * Returns a boolean rather than a Response so each route keeps its own body shape, and logs
 * the unset case itself so no caller can forget to. The two failures are INDISTINGUISHABLE
 * to the caller on purpose: telling an unauthenticated client that the endpoint is currently
 * unconfigured is precisely the moment it becomes most interesting to keep probing.
 */
export function authorizeSharedSecret(
  req: { headers: { get(name: string): string | null } }, secretEnv: string,
): boolean {
  const expected = process.env[secretEnv]
  if (!expected) {
    console.error(JSON.stringify({
      level: 'error',
      msg: `a scheduled endpoint refused a request: ${secretEnv} is not set`,
    }))
    return false
  }
  const presented = bearerToken(req)
  if (presented === null) return false
  return secretMatches(presented, expected)
}

/** Vercel Cron's own variable. Named here so routes and the runbook share one spelling. */
export const CRON_SECRET_ENV = 'CRON_SECRET'
