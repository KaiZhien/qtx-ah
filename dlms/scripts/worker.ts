/**
 * The pg-boss worker (spec §7.3) — the SELF-HOSTED scheduling path.
 *
 * ══ READ THIS BEFORE ASSUMING IT RUNS ANYWHERE TODAY ══════════════════════════
 *
 * THIS IS NOT THE LIVE PATH, and it cannot be on the current deployment. pg-boss schedules
 * work from a LONG-RUNNING PROCESS that holds a database connection and wakes on a timer.
 * Vercel has no such process: functions are invoked per request and frozen in between, so a
 * worker started inside one is killed the moment the response is sent. Nothing about this
 * file changes that.
 *
 * What actually schedules the jobs today is VERCEL CRON hitting the HTTP routes —
 * `vercel.json` + `app/api/cron/[job]/route.ts` + the GET on `app/api/outbox/drain`. That is
 * the live mechanism, it is wired, and RB-09 documents it.
 *
 * This file exists so the eventual AWS/Fargate (or any container) deployment is a
 * deployment decision rather than a rewrite: it reads the SAME registry the cron routes do
 * (modules/shared/outbox/jobs/registry.ts), so the schedule and the work never diverge
 * between the two runners. Moving to it means running this process somewhere that stays
 * alive and REMOVING the crons from vercel.json — running both would double every job.
 *
 * IT IS ALSO NOT INSTALLABLE AS COMMITTED. `pg-boss` is deliberately NOT in package.json:
 * adding a dependency that nothing on the live path imports would put it in every Vercel
 * build for no benefit. The import below is therefore dynamic through a non-literal
 * specifier — which is also why TypeScript does not fail on it — and the process exits with
 * an instruction rather than a stack trace when the package is absent.
 *
 * To actually run it:
 *   npm install pg-boss
 *   DATABASE_URL=... APP_ENV=production npx tsx scripts/worker.ts
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { JOBS } from '../modules/shared/outbox/jobs/registry'

/**
 * A non-literal specifier, so TypeScript cannot resolve it and therefore cannot fail the
 * build over a package that is intentionally absent. The honesty cost is that a typo here
 * is a runtime error rather than a compile one; the alternative is a dependency in every
 * production build for a path that does not run there.
 */
const PG_BOSS = 'pg-boss'

type BossLike = {
  start(): Promise<unknown>
  stop(opts?: { graceful?: boolean }): Promise<unknown>
  schedule(name: string, cron: string, data?: unknown, options?: unknown): Promise<unknown>
  work(name: string, handler: () => Promise<unknown>): Promise<unknown>
  on(event: string, handler: (err: unknown) => void): void
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set — the worker has nothing to connect to.')
    process.exit(1)
  }

  let PgBoss: new (opts: unknown) => BossLike
  try {
    PgBoss = (await import(PG_BOSS)).default
  } catch {
    console.error(
      'pg-boss is not installed. It is deliberately absent from package.json because the '
      + 'live scheduling path is Vercel Cron over the HTTP routes (see this file\'s header '
      + 'and docs/runbooks/RB-09-outbox-drain.md). To use this worker instead:\n'
      + '  npm install pg-boss\n'
      + 'and remove the "crons" entries from vercel.json so the jobs do not run twice.')
    process.exit(1)
  }

  const boss = new PgBoss({
    connectionString,
    // Matches lib/db/pool.ts's posture: TLS is verified everywhere except a local container
    // with no TLS listener.
    ssl: process.env.APP_ENV === 'development' ? undefined : { rejectUnauthorized: true },
  })

  // pg-boss surfaces background failures on this event rather than by rejecting; without a
  // listener they are silent, which for a scheduler is the worst possible failure mode.
  boss.on('error', (err) => {
    console.error(JSON.stringify({
      level: 'error', msg: 'pg-boss error',
      err: err instanceof Error ? err.message : String(err),
    }))
  })

  await boss.start()

  for (const job of JOBS) {
    // The schedule comes from the shared registry, NOT from a second list here — that is
    // the entire reason the registry is data. `singletonKey` keeps one instance of each job
    // in flight even if several workers are running, which matters most for the drain: RB-09
    // notes that overlapping drains can burn two attempts on one row inside a single wave.
    await boss.schedule(job.name, job.schedule, {}, { singletonKey: job.name })
    await boss.work(job.name, async () => {
      const started = Date.now()
      try {
        const result = await job.run()
        console.info(JSON.stringify({
          level: 'info', msg: 'job finished', job: job.name, ms: Date.now() - started, result,
        }))
        return result
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error', msg: 'job failed', job: job.name,
          err: err instanceof Error ? err.message : String(err),
        }))
        throw err   // let pg-boss record the failure and apply its retry policy
      }
    })
    console.info(`scheduled ${job.name} (${job.schedule}) — ${job.description}`)
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`${signal} received — finishing in-flight jobs before exiting.`)
    // Graceful: an in-flight drain is mid-transaction, and killing it would roll the current
    // row back (safe) but pointlessly burn an attempt on it (not free — the cap is global).
    await boss.stop({ graceful: true })
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  console.info(`worker up with ${JOBS.length} scheduled jobs`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
