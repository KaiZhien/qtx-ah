import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

/**
 * EVERY HEADLINE NUMBER ON A DASHBOARD CARD IS A REAL `COUNT(*)`.
 *
 * They used to be `rows.length` over a capped page, which made each of them
 * silently `min(true count, LIMIT)`:
 *
 *   - `failedLogins` capped at 200 on the SECURITY widget, so a 5,000-attempt
 *     credential-stuffing burst rendered "200 in the last 24h" — and stayed
 *     pinned there however much worse it got;
 *   - `invoicesUnpaid` was internally inconsistent: the count came from a
 *     `LIMIT 200` page while the money came from a second, uncapped SUM, so one
 *     card could read "200 unpaid · SGD 4,180,000".
 *
 * The shape being pinned here is structural — an aggregate statement for the
 * numbers, a small LIMIT for the rows shown underneath — because the regression
 * is invisible in any fixture smaller than the cap, which is every fixture
 * anybody writes.
 */

type Q = { text: string; values: unknown[] | undefined }
const captured: Q[] = []
let queue: Record<string, unknown>[][] = []

vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}))

vi.mock('@/lib/db/tx', () => ({
  withTransaction: (_actorId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: (text: string, values?: unknown[]) => {
        captured.push({ text, values })
        return Promise.resolve({ rows: queue.shift() ?? [] })
      },
    }),
  OptimisticLockError: class OptimisticLockError extends Error {},
}))

const {
  getFailedLogins, getUserActivity, getUnpaidInvoices,
  getDeliveriesDueThisWeek, getInvoicesPendingApproval,
} = await import('@/modules/shared/reporting/services/dashboardService')

const admin = (over: Partial<Actor> = {}): Actor => ({
  id: 'sa', roleKey: 'super_admin',
  permissions: new Set<Permission>([
    'view_records', 'view_finance', 'manage_users', 'manage_settings']),
  moduleAccess: new Set<ModuleKey>(['admin', 'finance', 'logistics']),
  active: true,
  ...over,
})

/** Every statement issued, joined — for asserting the SHAPE of the query set. */
const sql = () => captured.map((c) => c.text).join('\n;\n')

/** The statement that carries the aggregate, i.e. the one holding count(*). */
const countStatements = () => captured.filter((c) => /count\(\*\)/.test(c.text))

/** The statement that fetches display rows, i.e. the one holding LIMIT. */
const rowStatements = () => captured.filter((c) => /LIMIT/.test(c.text))

beforeEach(() => {
  captured.length = 0
  queue = []
})

describe('failed logins — the count an attack must be able to move', () => {
  it('reports the DATABASE count, not the length of the sample it renders', async () => {
    queue = [
      [{ last24h: '5000', last7d: '5200' }],
      [{ email: 'a@example.com', occurred_at: '2026-08-04T00:00:00Z' }],
    ]
    const d = await getFailedLogins(admin())

    expect(d.last24h).toBe(5000)
    expect(d.last7d).toBe(5200)
    // The sample is five addresses; the numbers above are not five.
    expect(d.rows).toHaveLength(1)
  })

  it('asks for the counts in an aggregate and the rows under a small LIMIT', async () => {
    queue = [[{ last24h: '0', last7d: '0' }], []]
    await getFailedLogins(admin())

    expect(countStatements()).toHaveLength(1)
    expect(rowStatements()).toHaveLength(1)
    // No 200-row page anywhere: that literal IS the defect being removed.
    expect(sql()).not.toMatch(/LIMIT\s+200/)
  })

  it('counts the 24h window in SQL, not by re-testing each fetched row', async () => {
    expect(sql()).not.toMatch(/within_24h/)
    queue = [[{ last24h: '3', last7d: '9' }], []]
    await getFailedLogins(admin())
    expect(sql()).toMatch(/FILTER \(WHERE occurred_at > now\(\) - interval '24 hours'\)/)
  })
})

describe('user activity', () => {
  it('counts active and never-signed-in users across the whole table', async () => {
    queue = [[{ active: '412', never_in: '37' }], []]
    const d = await getUserActivity(admin())
    expect(d.activeUsers).toBe(412)
    expect(d.neverLoggedIn).toBe(37)
  })
})

describe('unpaid invoices — the count and the money must describe ONE population', () => {
  it('takes count, overdue and the sum from a single aggregate statement', async () => {
    queue = [
      [{ n: '900', overdue: '140', total: '4180000.00' }],
      [{ id: 'i1', invoice_no: 'INV-1', due_date: null, total_sgd: '10.00' }],
    ]
    const d = await getUnpaidInvoices(admin())

    expect(d.count).toBe(900)
    expect(d.overdue).toBe(140)
    expect(d.totalSgd).toBe('4180000.00')
    // One statement produced all three, so they cannot describe different sets.
    expect(countStatements()).toHaveLength(1)
    expect(countStatements()[0].text).toMatch(/sum\(i\.total_sgd\)/)
  })

  it('keeps the money a STRING summed in SQL, never a JS float', async () => {
    queue = [[{ n: '2', overdue: '0', total: '0.30' }], []]
    const d = await getUnpaidInvoices(admin())
    expect(typeof d.totalSgd).toBe('string')
    expect(d.totalSgd).toBe('0.30')
  })

  it('renders SGD 0 rather than nothing when there is no unpaid invoice', async () => {
    queue = [[{ n: '0', overdue: '0', total: '0' }], []]
    const d = await getUnpaidInvoices(admin())
    expect(d.count).toBe(0)
    expect(d.totalSgd).toBe('0')
  })
})

describe('deliveries due this week', () => {
  it('splits due-vs-overdue in SQL against current_date', async () => {
    queue = [[{ due: '31', overdue: '4' }], []]
    const d = await getDeliveriesDueThisWeek(admin())
    expect(d.dueThisWeek).toBe(31)
    expect(d.overdue).toBe(4)
    expect(countStatements()[0].text).toMatch(/current_date/)
  })
})

describe('invoices pending approval', () => {
  it('counts every pending request, not the first page of them', async () => {
    queue = [[{ n: '73' }], []]
    const d = await getInvoicesPendingApproval(admin())
    expect(d.pending).toBe(73)
    expect(sql()).not.toMatch(/LIMIT\s+50/)
  })
})
