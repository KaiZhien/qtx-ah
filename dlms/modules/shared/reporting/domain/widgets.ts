import { can } from '@/modules/shared/authz/policy'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

/**
 * The dashboard widget registry (spec §8.5 — all four widget sets CONFIRMED).
 *
 * EVERY WIDGET IS PERMISSION-GATED, AND A DENIED WIDGET IS ABSENT. Same rule as
 * the search groups: an empty "Unpaid invoices — 0" card tells an operator that
 * Finance exists and is being withheld, and it is indistinguishable from a real
 * zero. `visibleWidgets` filters; the service never runs a denied widget's query.
 *
 * `status` is the honest half. Four of the sixteen spec'd widgets read tables that
 * do not exist on `main` yet — they belong to modules being built in parallel, or
 * to the deferred AWS work. They are declared here rather than omitted so the gap
 * is visible in the UI and in this registry, instead of the spec quietly shrinking
 * to whatever happened to be buildable. Each names its blocker; wiring one up is a
 * change to its resolver in dashboardService plus flipping `status` to 'live'.
 */

export const DASHBOARD_SECTIONS = [
  'home', 'manufacturing', 'maintenance', 'logisticsFinance', 'admin',
] as const
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number]

export type DashboardWidgetDef = {
  key: string
  label: string
  section: DashboardSection
  permission: Permission
  /**
   * null = no module clause. Used for the genuinely cross-module widgets
   * (approvals, audit activity) for the reason CROSS_MODULE_LINKS documents:
   * demanding the permission in ONE module would hide the widget from someone
   * who holds it in a different one.
   */
  module: ModuleKey | null
  status: 'live' | 'pending'
  /** Required when status is 'pending'. What has to land first. */
  pendingOn?: string
  sort: number
}

export const DASHBOARD_WIDGETS: readonly DashboardWidgetDef[] = [
  // ── Home (spec: "everyone" — but each underlying table keeps its own gate) ──
  { key: 'myTasks', label: 'My tasks & overdue', section: 'home',
    permission: 'view_records', module: 'tasks', status: 'live', sort: 1 },
  { key: 'myApprovalsPending', label: 'My approvals pending', section: 'home',
    permission: 'approve_requests', module: null, status: 'live', sort: 2 },
  { key: 'recentActivity', label: 'Recent activity on my records', section: 'home',
    permission: 'view_audit_record', module: null, status: 'live', sort: 3 },

  // ── Manufacturing ──────────────────────────────────────────────────────────
  { key: 'devicesByStatus', label: 'Devices by status', section: 'manufacturing',
    permission: 'view_records', module: 'manufacturing', status: 'live', sort: 10 },
  { key: 'devicesByVariant', label: 'Devices by variant', section: 'manufacturing',
    permission: 'view_records', module: 'manufacturing', status: 'live', sort: 11 },
  { key: 'importsAwaitingConfirm', label: 'Imports awaiting confirm', section: 'manufacturing',
    permission: 'import_data', module: 'manufacturing', status: 'live', sort: 12 },

  // ── Maintenance ────────────────────────────────────────────────────────────
  { key: 'activeRepairsByState', label: 'Active repairs by state (days in state)',
    section: 'maintenance', permission: 'view_records', module: 'maintenance',
    status: 'live', sort: 20 },
  { key: 'repairsByRootCause', label: 'Repairs by root cause (30/90 d)',
    section: 'maintenance', permission: 'view_records', module: 'maintenance',
    status: 'pending',
    pendingOn: 'A root-cause vocabulary. `repair` has only free-text '
      + '`fault_description`/`diagnosis`, which cannot be grouped. Needs agent '
      + "ENGINEERING's failure/RCA work (`failure_investigation`) or a "
      + '`root_cause_option` vocabulary on `repair`.',
    sort: 21 },

  // ── Logistics / Finance ────────────────────────────────────────────────────
  { key: 'deliveriesDueThisWeek', label: 'Deliveries due this week',
    section: 'logisticsFinance', permission: 'view_records', module: 'logistics',
    status: 'live', sort: 30 },
  // Gated on view_records + finance, NOT view_finance, matching agent FINANCE's own
  // warrantyService: a warranty date is a service entitlement, not money, and the
  // payload carries no buyer identity. This is deliberate, not a copy-paste slip.
  { key: 'warrantiesExpiring', label: 'Warranties expiring (0-30 / 31-60 / 61-90 d)',
    section: 'logisticsFinance', permission: 'view_records', module: 'finance',
    status: 'pending',
    pendingOn: 'agent FINANCE\'s `getWarrantyExpiryCounts(actor)`. Their windows are '
      + 'CUMULATIVE (30 ⊆ 60 ⊆ 90); `disjointFromCumulative` converts them and is '
      + 'unit-tested. See reporting/adapters/pendingSources.ts#fetchWarrantyExpiryCounts.',
    sort: 31 },
  { key: 'invoicesPendingApproval', label: 'Invoices pending approval',
    section: 'logisticsFinance', permission: 'view_finance', module: 'finance',
    status: 'live', sort: 32 },
  { key: 'invoicesUnpaid', label: 'Unpaid invoices', section: 'logisticsFinance',
    permission: 'view_finance', module: 'finance', status: 'live', sort: 33 },

  // ── Admin ──────────────────────────────────────────────────────────────────
  { key: 'userActivity', label: 'User activity', section: 'admin',
    permission: 'manage_users', module: 'admin', status: 'live', sort: 40 },
  { key: 'failedLogins', label: 'Failed logins', section: 'admin',
    permission: 'manage_users', module: 'admin', status: 'live', sort: 41 },
  { key: 'jobQueueHealth', label: 'Job queue health', section: 'admin',
    permission: 'manage_settings', module: 'admin', status: 'pending',
    pendingOn: 'agent NOTIFICATIONS\' `getQueueHealth()` in '
      + '`modules/shared/outbox/services/queueHealth.ts`, which `/api/health` also '
      + 'calls so the two can never disagree. A duplicate implementation reading '
      + '`outbox` directly was written here and DELETED rather than kept as a '
      + 'fallback. See reporting/adapters/pendingSources.ts#fetchQueueHealth.',
    sort: 42 },
  { key: 'backupStatus', label: 'Backup status', section: 'admin',
    permission: 'manage_settings', module: 'admin', status: 'pending',
    pendingOn: 'Spec §12 puts nightly `pg_dump` → S3 with Object Lock on the worker, '
      + 'and there is no AWS account (PROGRESS item 6, deferred). No '
      + '`backup_verification` table exists to read. Nothing to query yet.',
    sort: 43 },
]

export function liveWidgets(): DashboardWidgetDef[] {
  return DASHBOARD_WIDGETS.filter((w) => w.status === 'live')
}

export function pendingWidgets(): DashboardWidgetDef[] {
  return DASHBOARD_WIDGETS.filter((w) => w.status === 'pending')
}

/** Pure: the widgets this actor may see, in registry order. */
export function visibleWidgets(actor: Actor): DashboardWidgetDef[] {
  return DASHBOARD_WIDGETS
    .filter((w) => can(actor, w.permission, w.module ?? undefined))
    .sort((a, b) => a.sort - b.sort)
}

export type DashboardSectionView = {
  section: DashboardSection
  widgets: DashboardWidgetDef[]
}

/**
 * The widgets this actor may see, grouped into sections, in spec order.
 *
 * A section with no visible widgets is dropped entirely rather than rendered
 * empty — a "Logistics / Finance" heading over nothing is the same disclosure an
 * empty widget would be.
 */
export function visibleSections(actor: Actor): DashboardSectionView[] {
  const visible = visibleWidgets(actor)
  return DASHBOARD_SECTIONS
    .map((section) => ({ section, widgets: visible.filter((w) => w.section === section) }))
    .filter((s) => s.widgets.length > 0)
}
