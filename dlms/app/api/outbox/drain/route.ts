import { NextResponse, type NextRequest } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { drainOutbox } from '@/modules/shared/outbox/services/outboxService'

/**
 * POST /api/outbox/drain — the HTTP trigger for the transactional-outbox drain
 * (spec §5.5). See docs/runbooks/RB-09-outbox-drain.md.
 *
 * NOTHING CALLS THIS ON A SCHEDULE TODAY. It exists so that something can — a
 * Vercel Cron entry, an external scheduler, a human with curl — and so that the
 * eventual pg-boss worker (spec §7.3) replaces the *scheduling* rather than the
 * logic. Until one of those is wired, handoff tasks appear only when a drain is
 * run by hand, here or through `npm run outbox:drain`.
 *
 * It authenticates on a shared secret rather than on a session, because its
 * callers have no session: the drain runs as the automation principal
 * (loadSystemActor), which by construction has no login path at all
 * (20260731000000_platform_outbox.sql's app_user_system_actor_has_no_login).
 * There is no user here to authorize — the secret is the whole gate, which is
 * why the unset case below refuses rather than defaults open.
 *
 * `nodejs`, explicitly: the drain reaches Postgres through node-postgres, which
 * cannot run on the edge runtime. Route handlers default to nodejs today, and
 * the default is not what this depends on.
 */
export const runtime = 'nodejs'

/** Named here so the log line and the runbook can both point at one spelling. */
const SECRET_ENV = 'OUTBOX_DRAIN_SECRET'

/**
 * One response for "unset secret" and for "wrong secret" alike.
 *
 * Distinguishing them would tell an unauthenticated caller whether the endpoint
 * is currently unconfigured — which is precisely the moment it is most
 * interesting to keep probing. The misconfiguration is reported to the operator
 * on the server's own log stream instead, where the operator actually is.
 */
const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` THROWS on buffers of differing length, so comparing the raw
 * bytes would need a length check first — and that check both re-introduces the
 * early-exit timing signal the function exists to remove and leaks the expected
 * secret's length through whichever branch it takes. Hashing both sides first
 * makes every comparison exactly 32 bytes against 32 bytes: the throw is
 * unreachable, no length is observable, and the comparison itself stays
 * constant-time.
 */
function secretMatches(presented: string, expected: string): boolean {
  const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
  return timingSafeEqual(sha256(presented), sha256(expected))
}

/**
 * The bearer token, or null when the header is absent or malformed.
 *
 * `Authorization: Bearer <secret>` specifically, because that is the shape
 * Vercel Cron sends (`Bearer $CRON_SECRET`) — see the runbook's scheduling
 * section. The scheme is matched case-insensitively per RFC 7235, and `\S+`
 * rejects an empty token so a blank credential can never reach the comparison.
 */
function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}

export async function POST(req: NextRequest) {
  // An unset (or empty) secret REFUSES every request. The alternative — treating
  // "no secret configured" as "no authentication required" — turns a forgotten
  // environment variable into a publicly drainable endpoint, and a deployment
  // that silently works without its credential is one nobody notices is missing.
  const expected = process.env[SECRET_ENV]
  if (!expected) {
    console.error(JSON.stringify({
      level: 'error',
      msg: `outbox drain endpoint refused a request: ${SECRET_ENV} is not set`,
    }))
    return unauthorized()
  }

  const presented = bearerToken(req)
  if (presented === null || !secretMatches(presented, expected)) return unauthorized()

  try {
    const result = await drainOutbox()

    // 200 WITH the failures in the body, not a 5xx. A poison event — an unknown
    // template key, a malformed payload, an event shape this version does not
    // handle — is data the drain is designed to record and carry on past, and
    // the drain that recorded it did its job. Failing the response would make a
    // scheduler retry the whole batch over one bad row, and would hide however
    // many events the same call processed successfully. `failed`, `failures` and
    // `parked` are how the caller learns something is wrong; the status code is
    // not. (`parked: null` reaches the client as JSON null and means UNKNOWN —
    // the count query failed — never "nothing is parked".)
    return NextResponse.json(result)
  } catch (err) {
    // Reserved for the drain actually throwing, which it does in one case: the
    // automation principal cannot be resolved (missing, inactive, migration not
    // applied). That is a deployment fault, and a 500 is the honest signal.
    //
    // The message is returned rather than swallowed — unlike the platform's
    // user-facing surfaces, every caller here has already presented the shared
    // secret, and loadSystemActor's messages are written for exactly this
    // operator ("apply the migration", "reactivate it").
    const message = err instanceof Error ? err.message : 'The outbox drain failed'
    console.error(JSON.stringify({ level: 'error', msg: 'outbox drain failed', err: message }))
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
