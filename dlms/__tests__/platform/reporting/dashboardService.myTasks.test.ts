import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

/**
 * `getMyTasksWidget` and the TWO-GATE TASK VISIBILITY RULE (spec §8.3).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * Every other task read applies `canSeeTask`: `taskService.listTasksFor`,
 * `taskService.getTask`, and `searchService.searchTasks`. The Home dashboard's
 * "My tasks" widget did NOT — it selected `WHERE assignee_id = $1` and rendered
 * the titles. Being the assignee is not a waiver of the module gate
 * (tasks/domain/visibility.ts is explicit about that), so a Finance user could
 * assign an operator a task titled with an invoice number and a buyer name and
 * the operator would read it on their dashboard while `/tasks`, `/tasks/{id}`
 * and ⌘K all correctly refused it.
 *
 * The COUNTS are part of the leak, not just the titles: a `+1` on "open" is a
 * disclosure that a record exists in a module the reader cannot enter.
 *
 * ── HOW IT IS TESTED ───────────────────────────────────────────────────────
 * The service is I/O, so `withTransaction` and `unstable_cache` are stubbed and
 * the SQL result is supplied directly. That is deliberate: the rule under test
 * is the JS-side visibility filter and the fact that the query FETCHES the
 * columns the rule needs — not the SQL itself, which the integration suite
 * exercises against a real database.
 */

const captured: { text: string; values: unknown[] | undefined }[] = []
let nextRows: Record<string, unknown>[] = []

vi.mock('next/cache', () => ({
  // Pass-through: the cache key is a security boundary and is tested on its own
  // (domain/cacheKey.ts + the integration suite). Here it must not memoize
  // across cases, or the second test would read the first one's rows.
  unstable_cache: (fn: () => unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}))

vi.mock('@/lib/db/tx', () => ({
  withTransaction: (_actorId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: (text: string, values?: unknown[]) => {
        captured.push({ text, values })
        return Promise.resolve({ rows: nextRows })
      },
    }),
  OptimisticLockError: class OptimisticLockError extends Error {},
}))

const { getMyTasksWidget } = await import(
  '@/modules/shared/reporting/services/dashboardService')

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'priya', roleKey: 'operator',
  permissions: new Set<Permission>(['view_records']),
  moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

/** One task row as the widget's SELECT returns it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  title: 'Calibrate the jig',
  due_date: null,
  status: 'open',
  overdue: false,
  created_by: 'dana',
  assignee_id: 'priya',
  confidential: false,
  linked_modules: [],
  ...over,
})

beforeEach(() => {
  captured.length = 0
  nextRows = []
})

describe('getMyTasksWidget — the module gate is not waived by being the assignee', () => {
  it('HIDES a finance-linked task from an operator who cannot enter Finance', async () => {
    // The concrete leak. Dana (finance) files "Chase overdue payment
    // INV-2026-0042 — Acme Corp", links it to the sales_invoice, and assigns it
    // to Priya (operator; manufacturing + tasks). /tasks, /tasks/{id} and ⌘K all
    // show her nothing. The dashboard must agree.
    nextRows = [row({
      id: 'leak',
      title: 'Chase overdue payment INV-2026-0042 — Acme Corp',
      linked_modules: ['finance'],
    })]

    const d = await getMyTasksWidget(actor())

    expect(d.soonest).toEqual([])
    expect(d.soonest.map((t) => t.title)).not.toContain(
      'Chase overdue payment INV-2026-0042 — Acme Corp')
  })

  it('does not COUNT the hidden task either — a +1 is itself a disclosure', async () => {
    nextRows = [
      row({ id: 'mine', title: 'Rework PCBA-A', linked_modules: ['manufacturing'] }),
      row({ id: 'leak', title: 'Chase INV-2026-0042', linked_modules: ['finance'] }),
    ]

    const d = await getMyTasksWidget(actor())

    expect(d.open).toBe(1)
  })

  it('does not count a hidden OVERDUE task in the overdue tile', async () => {
    nextRows = [
      row({ id: 'leak', linked_modules: ['finance'], overdue: true }),
      row({ id: 'mine', linked_modules: ['manufacturing'], overdue: true }),
    ]

    const d = await getMyTasksWidget(actor())

    expect(d.overdue).toBe(1)
    expect(d.open).toBe(1)
  })

  it('requires EVERY linked module, not merely one', async () => {
    // A task linked to both a device and an invoice is as sensitive as the
    // invoice. This is why the rule takes a LIST.
    nextRows = [row({ linked_modules: ['manufacturing', 'finance'] })]
    expect((await getMyTasksWidget(actor())).open).toBe(0)
  })

  it('shows an UNLINKED task — no links means no module gate', async () => {
    nextRows = [row({ linked_modules: [] })]
    const d = await getMyTasksWidget(actor())
    expect(d.open).toBe(1)
    expect(d.soonest[0].title).toBe('Calibrate the jig')
  })

  it('shows a finance-linked task to someone who CAN enter Finance', async () => {
    nextRows = [row({ linked_modules: ['finance'] })]
    const d = await getMyTasksWidget(actor({
      moduleAccess: new Set<ModuleKey>(['finance', 'tasks']),
    }))
    expect(d.open).toBe(1)
  })

  it('shows it to an admin, who is above the module gate', async () => {
    nextRows = [row({ linked_modules: ['finance'] })]
    const d = await getMyTasksWidget(actor({
      roleKey: 'admin',
      permissions: new Set<Permission>(['view_records', 'manage_users']),
      moduleAccess: new Set<ModuleKey>(['admin', 'tasks']),
    }))
    expect(d.open).toBe(1)
  })
})

describe('getMyTasksWidget — confidentiality, the other half of the rule', () => {
  it('shows a confidential task to its ASSIGNEE (this widget is assignee-scoped)', async () => {
    nextRows = [row({ confidential: true, assignee_id: 'priya', created_by: 'dana' })]
    expect((await getMyTasksWidget(actor())).open).toBe(1)
  })

  it('still refuses a confidential task whose LINK the actor cannot enter', async () => {
    // Involvement never waives the module gate — the two gates are independent
    // and both must pass.
    nextRows = [row({
      confidential: true, assignee_id: 'priya', linked_modules: ['finance'],
    })]
    expect((await getMyTasksWidget(actor())).open).toBe(0)
  })

  it('refuses everything to a deactivated actor with the permission', async () => {
    nextRows = [row()]
    // authorize() rejects first; canSeeTask would refuse too. Either way, no rows.
    await expect(getMyTasksWidget(actor({ active: false }))).rejects.toThrow()
  })
})

describe('getMyTasksWidget — the query must FETCH what the rule needs', () => {
  it('selects linked_modules, created_by, assignee_id and confidential', async () => {
    nextRows = []
    await getMyTasksWidget(actor())
    const sql = captured.map((c) => c.text).join('\n')
    // Without these columns the filter cannot run at all, and the obvious "fix"
    // is to drop the filter rather than to widen the SELECT.
    expect(sql).toMatch(/linked_modules/)
    expect(sql).toMatch(/task_link/)
    expect(sql).toMatch(/t\.created_by/)
    expect(sql).toMatch(/t\.assignee_id/)
    expect(sql).toMatch(/t\.confidential/)
  })

  it('treats a NULL linked_modules as unlinked rather than throwing', async () => {
    // COALESCE makes this unreachable from Postgres, but a null here must degrade
    // to "no links", not to a TypeError on a dashboard.
    nextRows = [row({ linked_modules: null })]
    expect((await getMyTasksWidget(actor())).open).toBe(1)
  })
})
