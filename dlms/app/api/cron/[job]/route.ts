import { NextResponse, type NextRequest } from 'next/server'
import { findJob, JOBS } from '@/modules/shared/outbox/jobs/registry'
import { authorizeSharedSecret, CRON_SECRET_ENV } from '@/modules/shared/outbox/services/cronAuth'

/**
 * GET /api/cron/[job] — the scheduled-job runner (spec §7.3).
 *
 * Vercel Cron issues a GET with `Authorization: Bearer $CRON_SECRET`, so that is exactly
 * what this accepts. One dynamic route rather than one handler per job, because the jobs are
 * already data (modules/shared/outbox/jobs/registry.ts) and the alternative is three files
 * that differ by one identifier and drift in their auth.
 *
 * Fail-closed on an unset CRON_SECRET, identically to the drain route, via the same
 * authorizeSharedSecret. An unauthenticated endpoint that runs arbitrary registered jobs is
 * a materially worse hole than an unauthenticated drain, so the property matters more here,
 * not less.
 *
 * AUTH BEFORE LOOKUP, deliberately: answering 404 for an unknown job before checking the
 * secret would let an unauthenticated caller enumerate which jobs exist.
 *
 * `nodejs` and `maxDuration` for the same reasons the drain route states — node-postgres
 * cannot run on the edge, and a job killed at the default timeout returns no result at all,
 * leaving an operator unable to tell what ran.
 */
export const runtime = 'nodejs'
export const maxDuration = 300

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

export async function GET(
  req: NextRequest, { params }: { params: { job: string } },
) {
  if (!authorizeSharedSecret(req, CRON_SECRET_ENV)) return unauthorized()

  const job = findJob(params.job)
  if (!job) {
    // The caller has already presented the secret, so naming the alternatives is help for
    // an operator rather than disclosure — and a cron entry pointing at a job that no
    // longer exists is exactly the mistake this message should make obvious.
    return NextResponse.json({
      error: `Unknown job "${params.job}"`,
      known: JOBS.map((j) => j.name),
    }, { status: 404 })
  }

  try {
    const started = Date.now()
    const result = await job.run()
    return NextResponse.json({ job: job.name, ms: Date.now() - started, result })
  } catch (err) {
    // A job that THREW is a 500, unlike a drain that merely recorded failed events. The
    // distinction is the one the drain already draws: bad data is a 200 with the detail in
    // the body, a broken deployment is a 500. Only the latter reaches here.
    const message = err instanceof Error ? err.message : 'The job failed'
    console.error(JSON.stringify({
      level: 'error', msg: 'scheduled job failed', job: job.name, err: message,
    }))
    return NextResponse.json({ job: job.name, error: message }, { status: 500 })
  }
}
