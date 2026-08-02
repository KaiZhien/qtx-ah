import { drainOutbox } from '@/modules/shared/outbox/services/outboxService'
import { sweepTaskReminders } from '@/modules/shared/notifications/services/reminderService'
import { expireOverrides } from '@/modules/shared/outbox/jobs/expireOverrides'

/**
 * THE scheduled jobs, in one place — the mechanism that closes "nothing schedules the
 * drain" (RB-09).
 *
 * ONE REGISTRY, TWO RUNNERS, and that is the whole point of it being data rather than
 * three hand-written route handlers:
 *
 *   app/api/cron/[job]/route.ts — LIVE TODAY. Vercel Cron issues a GET with
 *     `Authorization: Bearer $CRON_SECRET`; the route looks the job up here and runs it.
 *   scripts/worker.ts — the pg-boss path (spec §7.3), for the eventual AWS/Fargate
 *     deployment. It reads the SAME entries, so moving from cron to a worker changes the
 *     scheduling and nothing about the work. See that file's header for why it is not the
 *     live path on Vercel.
 *
 * `schedule` is the cron expression BOTH runners use, and it is duplicated into
 * `vercel.json` because Vercel reads its schedule from that file and cannot read this one.
 * The pin in __tests__/platform/shared/cronSchedule.test.ts is what stops the two drifting.
 */

export type JobResult = Record<string, unknown>

export type JobDefinition = {
  /** URL-safe id: the `[job]` path segment, and the pg-boss queue name. */
  name: string
  /** Cron expression, UTC. Mirrored in vercel.json — see the drift test. */
  schedule: string
  /** One line for the runbook and the /api/health payload. */
  description: string
  run: () => Promise<JobResult>
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: 'outbox-drain',
    // Every five minutes. The ceiling this implies is deliberate and stated in RB-09: one
    // run drains at most `limit` events (100 by default), so this is 1200 events/hour. A
    // backlog larger than that needs a bigger limit — which is now an operator-facing knob
    // (`?limit=`) rather than a code constant — not patience.
    schedule: '*/5 * * * *',
    description: 'Turns unprocessed outbox rows into handoff tasks and notifications.',
    run: () => drainOutbox(),
  },
  {
    name: 'task-reminders',
    // Once a day, 08:00 UTC. A daily job whose idempotency is a database fact rather than a
    // schedule assumption, so a retry, an overlap or a manual re-run is safe — see
    // reminderService's header.
    schedule: '0 8 * * *',
    description: 'Due-tomorrow and overdue task reminders (spec §8.3).',
    run: () => sweepTaskReminders(),
  },
  {
    name: 'expire-overrides',
    // Hourly, per spec §6.3's "Worker expires hourly".
    schedule: '0 * * * *',
    description: 'Soft-deletes user_permission_override rows whose expiry has passed.',
    run: () => expireOverrides(),
  },
]

export function findJob(name: string): JobDefinition | undefined {
  return JOBS.find((j) => j.name === name)
}
