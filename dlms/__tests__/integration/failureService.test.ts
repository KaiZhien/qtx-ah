// __tests__/integration/failureService.test.ts
//
// Failure investigations against a real Postgres (TEST_DATABASE_URL). Mirrors
// repairService.test.ts's harness idiom: mock the supabase server module, real
// pg for setup/assertions, a per-run tag so every re-run against the same
// non-rollback database is independent, cleanup in afterAll.
//
// Run and green as of the 2026-08-04 merge (`npm run test:integration`).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  createFailure, updateFailure, changeFailureStatus, escalateFailureToEco,
  getFailure, listFailures, listFailureStatusHistory, getFailureStatusCounts,
  listEscalationEcoOptions, listRootCauseOptions,
  FailureNotFoundError, FailureSubjectNotFoundError, FailureEscalationError,
} from '@/modules/engineering/services/failureService'
import { InvalidFailureTransitionError } from '@/modules/engineering/domain/failureStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
let deviceId: string
/** Resolved from root_cause_option at run time — NEVER a hardcoded seed code. */
let causeId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const failureIds: string[] = []
const ecoIds: string[] = []
const deviceIds: string[] = []

const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['engineering']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['engineering']), active: true,
})
const outsider = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

/** Opens an FI already CLASSIFIED, so escalation/close paths are reachable. */
async function openWithRootCause(title: string): Promise<{ id: string; version: number }> {
  const c = await createFailure(op(), { title, rootCauseId: causeId })
  failureIds.push(c.id)
  const v = (await db.query(`SELECT version FROM failure_investigation WHERE id=$1`, [c.id]))
    .rows[0].version as number
  return { id: c.id, version: v }
}

async function versionOf(id: string): Promise<number> {
  return (await db.query(`SELECT version FROM failure_investigation WHERE id=$1`, [id]))
    .rows[0].version as number
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  // Whichever cause the vocabulary actually holds — the point of the table is
  // that its contents are the admin's, and prod codes have drifted from seed
  // before (CLAUDE.md). No test here may name a code.
  causeId = (await db.query(
    `SELECT id FROM root_cause_option WHERE active AND deleted_at IS NULL ORDER BY sort LIMIT 1`
  )).rows[0].id
  const dev = await db.query<{ id: string }>(
    `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
     VALUES ($1, (SELECT id FROM device_variant WHERE code='pro'),
             (SELECT code FROM status_option WHERE is_initial LIMIT 1), $2, $2)
     RETURNING id`, [`FI-DEV-${runTag}`, userId])
  deviceId = dev.rows[0].id
  deviceIds.push(deviceId)
})

afterAll(async () => {
  // history → investigation → eco → device (FK order).
  if (failureIds.length) {
    await db.query(`DELETE FROM failure_status_history WHERE failure_id = ANY($1)`, [failureIds])
    await db.query(`DELETE FROM failure_investigation WHERE id = ANY($1)`, [failureIds])
  }
  if (ecoIds.length) await db.query(`DELETE FROM eco WHERE id = ANY($1)`, [ecoIds])
  if (deviceIds.length) await db.query(`DELETE FROM device WHERE id = ANY($1)`, [deviceIds])
  await db.end()
  await getPool().end()
})

describe('authorization', () => {
  it('refuses create without create_records', async () => {
    await expect(createFailure(viewer(), { title: 'x' })).rejects.toThrow(PermissionError)
  })
  it('refuses create without engineering module access', async () => {
    await expect(createFailure(outsider(), { title: 'x' })).rejects.toThrow(PermissionError)
  })
  it('refuses the landing counts to an outsider', async () => {
    await expect(getFailureStatusCounts(outsider())).rejects.toThrow(PermissionError)
  })
})

describe('createFailure', () => {
  it('opens at `open` with an auto FI-YYYY-NNNN reference and an opening history row', async () => {
    const res = await createFailure(op(), {
      title: `Burn-in failure ${runTag}`, severity: 'high', deviceId,
      description: 'unit fails at 40 min', containment: 'batch quarantined',
    })
    failureIds.push(res.id)
    expect(res.fiNo).toMatch(/^FI-\d{4}-\d{4}$/)

    const row = await db.query(
      `SELECT status, severity, device_id, reported_by, created_by, version, closed_at
         FROM failure_investigation WHERE id=$1`, [res.id])
    expect(row.rows[0]).toMatchObject({
      status: 'open', severity: 'high', device_id: deviceId,
      reported_by: userId, created_by: userId, version: 1, closed_at: null,
    })

    const history = await listFailureStatusHistory(op(), res.id)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ fromStatus: null, toStatus: 'open' })
  })

  it('allows a standalone investigation with no device and no repair', async () => {
    const res = await createFailure(op(), { title: `Process failure ${runTag}` })
    failureIds.push(res.id)
    const row = await db.query(
      `SELECT device_id, repair_id FROM failure_investigation WHERE id=$1`, [res.id])
    expect(row.rows[0]).toMatchObject({ device_id: null, repair_id: null })
  })

  it('refuses a device that does not exist', async () => {
    await expect(createFailure(op(), {
      title: 'x', deviceId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(FailureSubjectNotFoundError)
  })

  // root_cause_id had no such check, so a vocabulary row deleted while the form
  // was open produced a raw 23503 and "Something went wrong" — the one FK on
  // this table whose target is admin-editable, and so the likeliest to move.
  it('refuses a root cause that does not exist, by name rather than by 23503', async () => {
    const err = await createFailure(op(), {
      title: `Bad-cause ${runTag}`, rootCauseId: '00000000-0000-0000-0000-000000000000',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(FailureSubjectNotFoundError)
    expect((err as FailureSubjectNotFoundError).subject).toBe('root cause')
  })

  it('refuses the same on update', async () => {
    const c = await createFailure(op(), { title: `Bad-cause-update ${runTag}` })
    failureIds.push(c.id)
    await expect(updateFailure(op(), {
      id: c.id, version: await versionOf(c.id),
      rootCauseId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(FailureSubjectNotFoundError)
  })

  // …but an INACTIVE cause still writes: the picker filters on active, the write
  // must not, or a record classified before the cause was retired becomes
  // uneditable without silently losing its classification.
  it('accepts an INACTIVE root cause, because the picker is not the boundary', async () => {
    const retired = (await db.query<{ id: string }>(
      `INSERT INTO root_cause_option (code, name, active, sort)
       VALUES ($1,$2,false,999) RETURNING id`,
      [`retired-${runTag}`, `Retired cause ${runTag}`])).rows[0].id
    const c = await createFailure(op(), {
      title: `Inactive-cause ${runTag}`, rootCauseId: retired,
    })
    failureIds.push(c.id)
    const { rows } = await db.query(
      `SELECT root_cause_id FROM failure_investigation WHERE id=$1`, [c.id])
    expect(rows[0].root_cause_id).toBe(retired)

    // The option list still hides it, which is the pairing that matters.
    expect((await listRootCauseOptions(op())).map((o) => o.id)).not.toContain(retired)

    await db.query(`UPDATE failure_investigation SET root_cause_id=NULL WHERE id=$1`, [c.id])
    await db.query(`DELETE FROM root_cause_option WHERE id=$1`, [retired])
  })
})

describe('reads', () => {
  it('getFailure returns null for an unknown id (→ 404)', async () => {
    expect(await getFailure(op(), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('listFailures finds this run\'s investigation by title fragment', async () => {
    const res = await createFailure(op(), { title: `Findable ${runTag}` })
    failureIds.push(res.id)
    const { items } = await listFailures(op(), { q: `findable ${runTag}` })
    expect(items.map((i) => i.id)).toContain(res.id)
  })

  it('filters by device — and only this run\'s rows are asserted on', async () => {
    const res = await createFailure(op(), { title: `Device-scoped ${runTag}`, deviceId })
    failureIds.push(res.id)
    const { items } = await listFailures(op(), { deviceId })
    expect(items.map((i) => i.id)).toContain(res.id)
    expect(items.every((i) => i.deviceId === deviceId)).toBe(true)
  })

  it('surfaces the root-cause classification for the §8.5 dashboard join', async () => {
    const res = await createFailure(op(), { title: `Classified ${runTag}`, rootCauseId: causeId })
    failureIds.push(res.id)
    const detail = await getFailure(op(), res.id)
    expect(detail?.rootCauseId).toBe(causeId)
    expect(detail?.rootCauseCode).toBeTruthy()
    expect(detail?.rootCauseName).toBeTruthy()
    const { items } = await listFailures(op(), { rootCauseId: causeId })
    expect(items.map((i) => i.id)).toContain(res.id)
    expect(items.every((i) => i.rootCauseId === causeId)).toBe(true)
  })

  it('listRootCauseOptions returns the ACTIVE vocabulary, resolved not hardcoded', async () => {
    const options = await listRootCauseOptions(op())
    expect(options.length).toBeGreaterThan(0)
    expect(options.map((o) => o.id)).toContain(causeId)
    const { rows } = await db.query<{ active: boolean }>(
      `SELECT active FROM root_cause_option WHERE id = ANY($1)`, [options.map((o) => o.id)])
    expect(rows.every((r) => r.active)).toBe(true)
  })

  it('getFailureStatusCounts includes at least this run\'s open row', async () => {
    const res = await createFailure(op(), { title: `Counted ${runTag}` })
    failureIds.push(res.id)
    const counts = await getFailureStatusCounts(op())
    const open = counts.find((c) => c.status === 'open')
    expect(open && open.count).toBeGreaterThanOrEqual(1)
    expect(open?.statusLabel).toBe('Open')
  })
})

describe('lifecycle preconditions', () => {
  it('refuses root_cause_identified until a root cause is CLASSIFIED, then allows it', async () => {
    const c = await createFailure(op(), { title: `Precondition ${runTag}` })
    failureIds.push(c.id)
    let v = await versionOf(c.id)
    const investigating = await changeFailureStatus(op(), {
      id: c.id, version: v, toStatus: 'investigating',
    })

    await expect(changeFailureStatus(op(), {
      id: c.id, version: investigating.version, toStatus: 'root_cause_identified',
    })).rejects.toThrow(InvalidFailureTransitionError)
    // nothing was written
    expect((await db.query(`SELECT status FROM failure_investigation WHERE id=$1`, [c.id]))
      .rows[0].status).toBe('investigating')

    // PROSE ALONE IS NOT ENOUGH — this is the whole point of the vocabulary.
    const prosed = await updateFailure(op(), {
      id: c.id, version: investigating.version, rootCause: 'cold solder joint',
    })
    await expect(changeFailureStatus(op(), {
      id: c.id, version: prosed.version, toStatus: 'root_cause_identified',
    })).rejects.toThrow(InvalidFailureTransitionError)

    const edited = await updateFailure(op(), {
      id: c.id, version: prosed.version, rootCauseId: causeId,
    })
    v = edited.version
    const identified = await changeFailureStatus(op(), {
      id: c.id, version: v, toStatus: 'root_cause_identified',
    })
    expect(identified.status).toBe('root_cause_identified')
  })

  it('refuses closing when the classification was cleared after it was identified', async () => {
    const c = await createFailure(op(), {
      title: `Blanked ${runTag}`, rootCauseId: causeId, correctiveAction: 'fix',
    })
    failureIds.push(c.id)
    let v = await versionOf(c.id)
    v = (await changeFailureStatus(op(), { id: c.id, version: v, toStatus: 'investigating' })).version
    v = (await changeFailureStatus(op(), { id: c.id, version: v, toStatus: 'root_cause_identified' })).version
    v = (await changeFailureStatus(op(), { id: c.id, version: v, toStatus: 'corrective_action' })).version
    v = (await updateFailure(op(), { id: c.id, version: v, rootCauseId: null })).version

    await expect(changeFailureStatus(op(), { id: c.id, version: v, toStatus: 'closed' }))
      .rejects.toThrow(InvalidFailureTransitionError)
  })

  it('walks the full happy path and stamps closed_at exactly once', async () => {
    const c = await createFailure(op(), {
      title: `Happy ${runTag}`, rootCauseId: causeId, correctiveAction: 'fix',
    })
    failureIds.push(c.id)
    let v = await versionOf(c.id)
    for (const to of ['investigating', 'root_cause_identified', 'corrective_action', 'closed']) {
      v = (await changeFailureStatus(op(), { id: c.id, version: v, toStatus: to as never })).version
    }
    const row = await db.query(
      `SELECT status, closed_at FROM failure_investigation WHERE id=$1`, [c.id])
    expect(row.rows[0].status).toBe('closed')
    expect(row.rows[0].closed_at).not.toBeNull()

    const history = await listFailureStatusHistory(op(), c.id)
    expect(history.map((h) => h.toStatus))
      .toEqual(['closed', 'corrective_action', 'root_cause_identified', 'investigating', 'open'])
  })

  it('requires a note to cancel and stores it on the history row', async () => {
    const c = await createFailure(op(), { title: `Cancel ${runTag}` })
    failureIds.push(c.id)
    const v = await versionOf(c.id)
    await expect(changeFailureStatus(op(), { id: c.id, version: v, toStatus: 'cancelled' }))
      .rejects.toThrow(InvalidFailureTransitionError)

    const cancelled = await changeFailureStatus(op(), {
      id: c.id, version: v, toStatus: 'cancelled', note: `duplicate ${runTag}`,
    })
    expect(cancelled.status).toBe('cancelled')
    const history = await listFailureStatusHistory(op(), c.id)
    expect(history[0].note).toBe(`duplicate ${runTag}`)
  })

  it('is fail-closed on an illegal jump and on a stale version', async () => {
    const c = await createFailure(op(), { title: `Illegal ${runTag}` })
    failureIds.push(c.id)
    const v = await versionOf(c.id)
    await expect(changeFailureStatus(op(), { id: c.id, version: v, toStatus: 'closed' }))
      .rejects.toThrow(InvalidFailureTransitionError)
    await expect(changeFailureStatus(op(), { id: c.id, version: 999, toStatus: 'investigating' }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('throws FailureNotFoundError for an unknown id on the write path', async () => {
    await expect(updateFailure(op(), {
      id: '00000000-0000-0000-0000-000000000000', version: 1, title: 'x',
    })).rejects.toThrow(FailureNotFoundError)
  })
})

describe('escalation to a change order', () => {
  it('raises a NEW ECO through the engineering service and links it', async () => {
    const fi = await openWithRootCause(`Escalate-new ${runTag}`)
    const res = await escalateFailureToEco(op(), {
      id: fi.id, version: fi.version,
      newEco: { title: `From FI ${runTag}`, effectivityDate: '2026-09-01' },
    })
    ecoIds.push(res.ecoId)
    expect(res.ecoNo).toMatch(/^ECO-\d{4}-\d{4}$/)

    const row = await db.query(`SELECT eco_id FROM failure_investigation WHERE id=$1`, [fi.id])
    expect(row.rows[0].eco_id).toBe(res.ecoId)
    const eco = await db.query(
      `SELECT status, effectivity_date::text AS d FROM eco WHERE id=$1`, [res.ecoId])
    expect(eco.rows[0]).toMatchObject({ status: 'draft', d: '2026-09-01' })
  })

  it('links an EXISTING change order, and re-linking the same one is idempotent', async () => {
    const fi = await openWithRootCause(`Escalate-existing ${runTag}`)
    const seeded = await escalateFailureToEco(op(), {
      id: fi.id, version: fi.version, newEco: { title: `Target ${runTag}` },
    })
    ecoIds.push(seeded.ecoId)

    const again = await escalateFailureToEco(op(), {
      id: fi.id, version: seeded.version, ecoId: seeded.ecoId,
    })
    expect(again.version).toBe(seeded.version) // no second version bump
  })

  it('refuses re-escalating to a DIFFERENT order', async () => {
    const fi = await openWithRootCause(`Escalate-conflict ${runTag}`)
    const first = await escalateFailureToEco(op(), {
      id: fi.id, version: fi.version, newEco: { title: `First ${runTag}` },
    })
    ecoIds.push(first.ecoId)
    const other = await escalateFailureToEco(op(), {
      id: (await openWithRootCause(`Other ${runTag}`)).id, version: 1,
      newEco: { title: `Second ${runTag}` },
    })
    ecoIds.push(other.ecoId)

    await expect(escalateFailureToEco(op(), {
      id: fi.id, version: first.version, ecoId: other.ecoId,
    })).rejects.toThrow(FailureEscalationError)
  })

  /**
   * I6 — createEco used to commit BEFORE any precondition was evaluated, so
   * every refusal on the `newEco` path left a permanent unlinked draft ECO with
   * an `eco_no` burned out of the year's sequence. This test PROVED it and did
   * not notice: it never pushed the created ECO to `ecoIds`, so the leak
   * accumulated in the test database on every run. The read-only pre-pass now
   * refuses first, and the assertion below is the pin.
   */
  it('refuses escalation with no classified root cause, minting NO change order', async () => {
    const c = await createFailure(op(), { title: `No-cause ${runTag}` })
    failureIds.push(c.id)
    const ecoTitle = `Never ${runTag}`
    await expect(escalateFailureToEco(op(), {
      id: c.id, version: await versionOf(c.id), newEco: { title: ecoTitle },
    })).rejects.toThrow(FailureEscalationError)

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eco WHERE title = $1`, [ecoTitle])
    expect(rows[0].n).toBe('0')
  })

  it('mints no change order for a STALE version either', async () => {
    const fi = await openWithRootCause(`Stale-escalate ${runTag}`)
    const ecoTitle = `Stale never ${runTag}`
    await expect(escalateFailureToEco(op(), {
      id: fi.id, version: fi.version + 99, newEco: { title: ecoTitle },
    })).rejects.toThrow(OptimisticLockError)
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eco WHERE title = $1`, [ecoTitle])
    expect(rows[0].n).toBe('0')
  })

  it('mints no SECOND change order when a double-submitted form re-escalates', async () => {
    // The realistic case: the user clicks Escalate twice. The first commits, the
    // second used to create a whole new draft ECO and only THEN discover the FI
    // was already linked.
    const fi = await openWithRootCause(`Double-submit ${runTag}`)
    const first = await escalateFailureToEco(op(), {
      id: fi.id, version: fi.version, newEco: { title: `Double first ${runTag}` },
    })
    ecoIds.push(first.ecoId)

    const secondTitle = `Double second ${runTag}`
    await expect(escalateFailureToEco(op(), {
      id: fi.id, version: first.version, newEco: { title: secondTitle },
    })).rejects.toThrow(FailureEscalationError)
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eco WHERE title = $1`, [secondTitle])
    expect(rows[0].n).toBe('0')
  })

  it('refuses escalation from a terminal investigation', async () => {
    const c = await createFailure(op(), { title: `Terminal ${runTag}`, rootCauseId: causeId })
    failureIds.push(c.id)
    const cancelled = await changeFailureStatus(op(), {
      id: c.id, version: await versionOf(c.id), toStatus: 'cancelled', note: 'stop',
    })
    await expect(escalateFailureToEco(op(), {
      id: c.id, version: cancelled.version, ecoId: ecoIds[0],
    })).rejects.toThrow(FailureEscalationError)
  })

  it('offers only non-terminal change orders as escalation targets', async () => {
    const options = await listEscalationEcoOptions(op())
    const ids = options.map((o) => o.id)
    if (ids.length > 0) {
      const { rows } = await db.query<{ status: string }>(
        `SELECT status FROM eco WHERE id = ANY($1)`, [ids])
      expect(rows.every((r) => ['draft', 'submitted', 'approved'].includes(r.status))).toBe(true)
    }
  })
})

/**
 * ORDERING, not merely outcome — the same property deviceWriteService.test.ts
 * pins for changeDeviceStatus. authorize.ts is "the choke point. Every service
 * entry point calls this before touching data": a denied call must never reach
 * the pool, or a denial during a database outage surfaces as a connection error
 * (a 500) instead of a PermissionError (a 403), and every other assertion in
 * this file stays green while it happens.
 *
 * escalateFailureToEco is the one worth pinning hardest: it now runs a read-only
 * pre-pass BEFORE createEco, which is exactly the kind of "just add a read at
 * the top" edit that tends to arrive above the guard.
 *
 * Proven the only way the outcome distinguishes the two: point a FRESH module
 * graph's pool at an unreachable port.
 */
describe('failureService — guards run before the connection', () => {
  it('authorizes and validates before it ever acquires a connection', async () => {
    const previous = process.env.DATABASE_URL
    vi.resetModules()
    process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/unreachable'
    try {
      const svc = await import('@/modules/engineering/services/failureService')
      const authz = await import('@/modules/shared/authz/authorize')

      await expect(svc.createFailure(viewer(), { title: 'x' }))
        .rejects.toThrow(authz.PermissionError)
      await expect(svc.changeFailureStatus(viewer(), {
        id: crypto.randomUUID(), version: 1, toStatus: 'investigating',
      })).rejects.toThrow(authz.PermissionError)
      await expect(svc.escalateFailureToEco(viewer(), {
        id: crypto.randomUUID(), version: 1, newEco: { title: 'never' },
      })).rejects.toThrow(authz.PermissionError)
      await expect(svc.getFailureStatusCounts(outsider()))
        .rejects.toThrow(authz.PermissionError)

      // …and validation, which must also fail before a connection is asked for —
      // including the refine that forbids naming BOTH escalation targets, since
      // that one lives on the schema rather than in the transaction.
      await expect(svc.updateFailure(op(), { id: 'not-a-uuid', version: 1 }))
        .rejects.toThrow(/uuid/i)
      await expect(svc.escalateFailureToEco(op(), {
        id: crypto.randomUUID(), version: 1,
        ecoId: crypto.randomUUID(), newEco: { title: 'both' },
      })).rejects.toThrow(/exactly one/i)
    } finally {
      process.env.DATABASE_URL = previous
      vi.resetModules()
    }
  })
})
