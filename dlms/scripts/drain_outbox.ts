// The transactional-outbox drain (spec §5.5), as a command.
//
// Turns unprocessed `outbox` rows — written in the same transaction as the
// device status change that caused them — into cross-department handoff tasks,
// exactly once. All of the logic lives in
// modules/shared/outbox/services/outboxService.ts; this file is a trigger, the
// sibling of app/api/outbox/drain/route.ts, and the two share that one
// implementation rather than each carrying half of it.
//
// NOTHING RUNS THIS ON A SCHEDULE TODAY. Handoff tasks appear only when a drain
// is run — here, or through the route. See docs/runbooks/RB-09-outbox-drain.md.
//
// Unlike migrate_demo.ts / migrate_components.ts, this script does NOT refuse to
// run under APP_ENV=production. Those two are one-shot demo migrations that have
// no business touching production; this is ordinary production operations, and
// production is where the backlog it drains actually accumulates.

import { fileURLToPath } from 'node:url'
import { getPool } from '@/lib/db/pool'
import {
  drainOutbox, MAX_ATTEMPTS, type DrainResult,
} from '@/modules/shared/outbox/services/outboxService'

/**
 * The one summary printer.
 *
 * Counts on stdout; anything that needs a human on stderr. `claimed` is always
 * `processed + failed` — rows another concurrent drain already held are skipped
 * and counted by neither.
 */
function reportResult(result: DrainResult): void {
  console.log(`Claimed:   ${result.claimed}`)
  console.log(`Processed: ${result.processed}`)
  console.log(`Failed:    ${result.failed}`)

  if (result.failures.length > 0) {
    // Not fatal to the drain — a bad event is data, recorded on its own row and
    // retried by the next run — but it IS what makes this process exit 1, so the
    // ids and errors have to be readable without going to the database.
    console.error(`Failed events (${result.failures.length}) — attempts incremented, still unprocessed:`)
    for (const f of result.failures) console.error(`  outbox ${f.outboxId}: ${f.error}`)
  }

  // Three genuinely different readings, and collapsing any two of them would
  // mislead. See DrainResult.parked: null is UNKNOWN, never "nothing parked".
  if (result.parked === null) {
    console.error(
      `Parked (attempts >= ${MAX_ATTEMPTS}): UNKNOWN — the parked-count query failed, so this ` +
      `run cannot say whether a backlog exists. Do NOT read this as zero; query it by hand ` +
      `(see docs/runbooks/RB-09-outbox-drain.md, "Investigating a parked event").`)
  } else if (result.parked > 0) {
    console.error(
      `Parked (attempts >= ${MAX_ATTEMPTS}): ${result.parked} — these are NOT retried by any ` +
      `future drain. They stay unprocessed until a human fixes the cause and resets attempts. ` +
      `See docs/runbooks/RB-09-outbox-drain.md, "Investigating a parked event".`)
  } else {
    console.log(`Parked:    0`)
  }
}

export async function main(): Promise<void> {
  // The drain's ONLY credential. It resolves its own principal through the pool
  // (loadSystemActor) — there is no session, no cookie and no Supabase client on
  // this path — so a missing URL is the whole failure, and saying so beats a
  // connection error naming `undefined`.
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required (the platform project). The drain connects as the owner of ' +
      'fn_resolve_actor_by_user_id — see docs/runbooks/RB-09-outbox-drain.md, Prerequisites.')
  }

  try {
    console.log('Draining the outbox...')
    const result = await drainOutbox()
    reportResult(result)

    // Non-zero on any failed event, so a scheduled invocation surfaces it rather
    // than logging into the void. Deliberately NOT gated on `parked` too: a
    // standing backlog is a human's open item, and failing every subsequent run
    // on it would make the exit code permanently red and therefore ignored —
    // reportResult puts it on stderr instead. A run that parks a row on this very
    // pass also failed it, so that case still exits 1.
    if (result.failed > 0) process.exitCode = 1
  } finally {
    // drainOutbox borrows from the getPool() singleton, so this script owns that
    // pool's lifetime. Without closing it the process sits idle for
    // idleTimeoutMillis (30s) after the summary prints, which reads as a hang —
    // and an operator who Ctrl-Cs it gets exit 130 instead of the real code,
    // which a wrapping scheduler would misread as something other than the
    // failure it was. Same reasoning as migrate_components.ts.
    await getPool().end()
  }
}

// Only run main() when this file is executed directly (npm run outbox:drain),
// not when imported for its exports by the test suite. Compared via
// import.meta.url (not require.main, which doesn't exist once this file is
// loaded as ESM by vitest/vite-node) against argv so a plain import never
// triggers a live database connection.
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
