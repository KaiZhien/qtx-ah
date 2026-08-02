import { NextResponse, type NextRequest } from 'next/server'
import { drainOutbox } from '@/modules/shared/outbox/services/outboxService'
import { authorizeSharedSecret, CRON_SECRET_ENV } from '@/modules/shared/outbox/services/cronAuth'

/**
 * The HTTP trigger for the transactional-outbox drain (spec §5.5).
 * See docs/runbooks/RB-09-outbox-drain.md.
 *
 * TWO METHODS, TWO SECRETS, ONE DRAIN — and the reason is not stylistic:
 *
 *   POST + OUTBOX_DRAIN_SECRET — the original operator trigger (curl, an external
 *     scheduler). Unchanged, including its fail-closed behaviour.
 *   GET + CRON_SECRET — added so VERCEL CRON can actually drive this route. Vercel Cron
 *     issues a GET and sends `Authorization: Bearer $CRON_SECRET`; the POST-only route
 *     answered 405, which is why RB-09 recorded that "Vercel Cron cannot drive the route as
 *     written". It now can, WITHOUT weakening the POST path and without collapsing the two
 *     credentials into one — an operator's drain secret and the platform's cron secret have
 *     different blast radii and different rotation stories, and making one imply the other
 *     would silently widen whichever is weaker.
 *
 * Both paths refuse when their secret is unset. That is the property most likely to be lost
 * when a second entry point is added, so both go through the same authorizeSharedSecret.
 *
 * They authenticate on a shared secret rather than on a session because their callers have
 * no session: the drain runs as the automation principal (loadSystemActor), which by
 * construction has no login path at all
 * (20260731000000_platform_outbox.sql's app_user_system_actor_has_no_login). There is no
 * user here to authorize — the secret is the whole gate.
 *
 * `nodejs`, explicitly: the drain reaches Postgres through node-postgres, which cannot run
 * on the edge runtime. Route handlers default to nodejs today, and the default is not what
 * this depends on.
 */
export const runtime = 'nodejs'

/**
 * A FULL BATCH MUST BE ABLE TO FINISH.
 *
 * Without this the route inherits the platform's default function timeout (10s on Vercel's
 * Hobby tier, 15s on Pro), and a 100-event batch — each event doing a claim, a task insert,
 * a notification fan-out and a stamp, in its own transaction — can exceed it. The failure
 * mode that produced was genuinely bad: the function is killed mid-drain, the caller gets a
 * 504 with NO DrainResult at all, and the operator cannot tell how many events were
 * processed before the axe fell. (The events themselves are safe either way — each row's
 * transaction either committed or rolled back — but "safe" and "diagnosable" are different
 * properties, and a scheduler that sees only a 504 has no idea whether to escalate.)
 *
 * 300s is Vercel's maximum for the Pro tier's Node runtime. Deliberately generous rather
 * than tuned: the cost of an over-long ceiling is a slow failure on a broken database, and
 * the cost of an under-short one is the un-diagnosable 504 above.
 */
export const maxDuration = 300

/** Named here so the log line and the runbook can both point at one spelling. */
const SECRET_ENV = 'OUTBOX_DRAIN_SECRET'

/**
 * One response for "unset secret" and for "wrong secret" alike.
 *
 * Distinguishing them would tell an unauthenticated caller whether the endpoint is
 * currently unconfigured — which is precisely the moment it is most interesting to keep
 * probing. The misconfiguration is reported to the operator on the server's own log stream
 * instead, where the operator actually is.
 */
const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

/**
 * `?limit=` — the operator-facing control RB-09's advice needed and did not have.
 *
 * The runbook tells an operator with a backlog to "use a bigger limit", but `limit` was a
 * code-level default with no way to set it, so that advice was unactionable short of a
 * deploy. It is parsed permissively and clamped by the service's own schema (1..1000); a
 * junk value is IGNORED rather than refused, because failing a scheduled drain over a
 * malformed query string would stop the handoffs to protect a preference.
 */
function limitFrom(req: NextRequest): number | undefined {
  const raw = req.nextUrl.searchParams.get('limit')
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return undefined
  return parsed
}

/**
 * The drain itself, shared by both methods so they cannot drift in what they do — only in
 * how they are authenticated.
 */
async function runDrain(req: NextRequest) {
  try {
    const limit = limitFrom(req)
    const result = await drainOutbox(limit === undefined ? {} : { limit })

    // 200 WITH the failures in the body, not a 5xx. A poison event — an unknown template
    // key, a malformed payload, an event shape this version does not handle — is data the
    // drain is designed to record and carry on past, and the drain that recorded it did its
    // job. Failing the response would make a scheduler retry the whole batch over one bad
    // row, and would hide however many events the same call processed successfully.
    // `failed`, `failures` and `parked` are how the caller learns something is wrong; the
    // status code is not. (`parked: null` reaches the client as JSON null and means
    // UNKNOWN — the count query failed — never "nothing is parked".)
    return NextResponse.json(result)
  } catch (err) {
    // Reserved for the drain actually throwing, which it does in one case: the automation
    // principal cannot be resolved (missing, inactive, migration not applied). That is a
    // deployment fault, and a 500 is the honest signal.
    //
    // The message is returned rather than swallowed — unlike the platform's user-facing
    // surfaces, every caller here has already presented a shared secret, and
    // loadSystemActor's messages are written for exactly this operator ("apply the
    // migration", "reactivate it").
    const message = err instanceof Error ? err.message : 'The outbox drain failed'
    console.error(JSON.stringify({ level: 'error', msg: 'outbox drain failed', err: message }))
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** The operator trigger. Authenticated by OUTBOX_DRAIN_SECRET; unchanged by the cron work. */
export async function POST(req: NextRequest) {
  if (!authorizeSharedSecret(req, SECRET_ENV)) return unauthorized()
  return runDrain(req)
}

/**
 * The Vercel Cron trigger. Authenticated by CRON_SECRET — the variable Vercel actually
 * sends — and fail-closed in exactly the same way when it is unset.
 *
 * A GET that mutates is not the shape anyone would choose; it is the shape the scheduler
 * dictates. The alternative (fronting the POST with something that translates) adds a
 * component whose only job is to change a verb.
 */
export async function GET(req: NextRequest) {
  if (!authorizeSharedSecret(req, CRON_SECRET_ENV)) return unauthorized()
  return runDrain(req)
}
