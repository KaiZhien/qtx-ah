import { describe, it, expect } from 'vitest'
import {
  DASHBOARD_WIDGETS, visibleWidgets, visibleSections, liveWidgets, pendingWidgets,
  DASHBOARD_SECTIONS,
} from '@/modules/shared/reporting/domain/widgets'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u1', roleKey: 'operator',
  permissions: new Set<Permission>(['view_records']),
  moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

const financeActor = actor({
  roleKey: 'finance',
  permissions: new Set<Permission>(['view_records', 'view_finance']),
  moduleAccess: new Set<ModuleKey>(['finance', 'tasks']),
})

const keysFor = (a: Actor) => visibleWidgets(a).map((w) => w.key)

describe('DASHBOARD_WIDGETS registry', () => {
  it('declares every widget key exactly once', () => {
    const keys = DASHBOARD_WIDGETS.map((w) => w.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers all four widget sets spec §8.5 confirms', () => {
    const keys = DASHBOARD_WIDGETS.map((w) => w.key)
    for (const expected of [
      // Home
      'myTasks', 'myApprovalsPending', 'recentActivity',
      // Manufacturing
      'devicesByStatus', 'devicesByVariant', 'importsAwaitingConfirm',
      // Maintenance
      'activeRepairsByState', 'repairsByRootCause',
      // Logistics / Finance
      'deliveriesDueThisWeek', 'warrantiesExpiring',
      'invoicesPendingApproval', 'invoicesUnpaid',
      // Admin
      'userActivity', 'failedLogins', 'jobQueueHealth', 'backupStatus',
    ]) {
      expect(keys).toContain(expected)
    }
  })

  it('puts every widget in a declared section', () => {
    for (const w of DASHBOARD_WIDGETS) expect(DASHBOARD_SECTIONS).toContain(w.section)
  })

  it('gives every module-gated widget a module authorize() recognises', () => {
    for (const w of DASHBOARD_WIDGETS) {
      if (w.module !== null) expect(MODULES).toContain(w.module)
    }
  })

  it('makes every pending widget say what it is waiting on', () => {
    for (const w of pendingWidgets()) {
      expect(w.pendingOn, `${w.key} is pending but names no blocker`).toBeTruthy()
    }
  })

  it('gives every live widget NO pendingOn, so the two states cannot both be claimed', () => {
    for (const w of liveWidgets()) expect(w.pendingOn).toBeUndefined()
  })
})

describe('visibleWidgets — a user without Finance gets no Finance widget, not an empty one', () => {
  it('hides every finance widget from an operator', () => {
    const keys = keysFor(actor())
    expect(keys).not.toContain('invoicesUnpaid')
    expect(keys).not.toContain('invoicesPendingApproval')
    expect(keys).not.toContain('warrantiesExpiring')
  })

  it('shows the finance widgets to a finance actor', () => {
    const keys = keysFor(financeActor)
    expect(keys).toContain('invoicesUnpaid')
    expect(keys).toContain('invoicesPendingApproval')
  })

  it('hides the manufacturing widgets from a finance actor', () => {
    const keys = keysFor(financeActor)
    expect(keys).not.toContain('devicesByStatus')
    expect(keys).not.toContain('devicesByVariant')
  })

  it('gates importsAwaitingConfirm on import_data, matching importCommitService', () => {
    expect(keysFor(actor())).not.toContain('importsAwaitingConfirm')
    const importer = actor({
      permissions: new Set<Permission>(['view_records', 'import_data']),
    })
    expect(keysFor(importer)).toContain('importsAwaitingConfirm')
  })

  it('gates the admin widgets on manage_users / manage_settings, not bare admin access', () => {
    const fakeAdmin = actor({ moduleAccess: new Set<ModuleKey>(['admin']) })
    expect(keysFor(fakeAdmin)).not.toContain('userActivity')
    expect(keysFor(fakeAdmin)).not.toContain('jobQueueHealth')

    const su = actor({
      roleKey: 'super_admin',
      permissions: new Set<Permission>(['view_records', 'manage_users', 'manage_settings']),
      moduleAccess: new Set<ModuleKey>(['admin']),
    })
    expect(keysFor(su)).toContain('userActivity')
    expect(keysFor(su)).toContain('failedLogins')
    expect(keysFor(su)).toContain('jobQueueHealth')
  })

  it('gives a deactivated actor nothing, whatever their role', () => {
    expect(keysFor(actor({ roleKey: 'super_admin', active: false }))).toEqual([])
  })

  it('gates my-approvals on approve_requests with NO module, like the Approvals link', () => {
    // CROSS_MODULE_LINKS uses a bare permission gate: asking for it in one
    // particular module would hide it from a manager who holds it in another.
    expect(keysFor(actor())).not.toContain('myApprovalsPending')
    const approver = actor({
      permissions: new Set<Permission>(['view_records', 'approve_requests']),
    })
    expect(keysFor(approver)).toContain('myApprovalsPending')
  })

  it('requires tasks module access for My Tasks, matching the home page today', () => {
    expect(keysFor(actor())).toContain('myTasks')
    const noTasks = actor({ moduleAccess: new Set<ModuleKey>(['manufacturing']) })
    expect(keysFor(noTasks)).not.toContain('myTasks')
  })

  it('returns widgets in registry sort order', () => {
    const sorts = visibleWidgets(financeActor).map((w) => w.sort)
    expect(sorts).toEqual([...sorts].sort((a, b) => a - b))
  })
})

describe('visibleSections', () => {
  it('omits a section entirely when the actor can see none of its widgets', () => {
    expect(visibleSections(actor()).map((s) => s.section)).not.toContain('logisticsFinance')
  })

  it('never returns a section with an empty widget list', () => {
    for (const a of [actor(), financeActor]) {
      for (const s of visibleSections(a)) expect(s.widgets.length).toBeGreaterThan(0)
    }
  })

  it('keeps sections in the spec §8.5 declaration order', () => {
    const su = actor({
      roleKey: 'super_admin',
      permissions: new Set<Permission>([
        'view_records', 'view_finance', 'import_data',
        'manage_users', 'manage_settings', 'approve_requests', 'view_audit_record',
      ]),
      moduleAccess: new Set<ModuleKey>([]),
    })
    const order = visibleSections(su).map((s) => s.section)
    expect(order).toEqual(DASHBOARD_SECTIONS.filter((s) => order.includes(s)))
  })
})
