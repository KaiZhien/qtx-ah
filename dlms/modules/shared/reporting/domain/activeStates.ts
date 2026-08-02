import { REPAIR_STATUSES, type RepairStatus } from '@/modules/maintenance/domain/repairStatus'
import { DO_STATUSES, type DoStatus } from '@/modules/logistics/domain/doStatus'
import { INVOICE_STATUSES, type InvoiceStatus } from '@/modules/finance/domain/invoiceStatus'

/**
 * "Still needs someone to do something" — the state sets the dashboards count.
 *
 * DERIVED FROM EACH MODULE'S OWN VOCABULARY, never retyped. Every list below is
 * `ALL minus the terminal ones`, so a status added to a module's domain is
 * automatically ACTIVE until someone deliberately marks it terminal here — which
 * fails safe: a new state shows up on the dashboard rather than silently
 * vanishing from it. The exhaustiveness tests pin that.
 *
 * These are fixed CHECK-constrained vocabularies in TypeScript, NOT the
 * admin-editable `status_option` table. The CLAUDE.md warning about hardcoding
 * seeded vocabulary codes applies to DEVICE statuses, which are admin-extensible
 * and are therefore read from `status_option` (and ordered by its `sort_order`)
 * by the devices-by-status widget — never enumerated in code.
 *
 * WHY 'awaiting_sign_off' IS ACTIVE THOUGH IT HAS NO ORDINARY TRANSITIONS.
 * `allowedNextRepairStatuses('awaiting_sign_off')` is `[]` because sign-off is a
 * gated action rather than an ordinary edge (see repairStatus.ts's header), so
 * deriving "terminal" from "no outgoing edges" would classify it as done. It is
 * the opposite: a repair sitting in awaiting_sign_off is blocked ON A HUMAN and
 * is the single most important row an aging widget can show. Terminal states are
 * named explicitly below for exactly this reason.
 */

/** repairStatus.ts, line comment "closed / cancelled → terminal". */
export const TERMINAL_REPAIR_STATUSES: readonly RepairStatus[] = ['closed', 'cancelled']

export const ACTIVE_REPAIR_STATUSES: readonly RepairStatus[] =
  REPAIR_STATUSES.filter((s) => !TERMINAL_REPAIR_STATUSES.includes(s))

/**
 * A delivered or cancelled DO is finished. `draft` counts as outstanding: a
 * delivery due this week that nobody has prepared yet is precisely the thing the
 * widget exists to surface.
 */
export const TERMINAL_DO_STATUSES: readonly DoStatus[] = ['delivered', 'cancelled']

export const OPEN_DO_STATUSES: readonly DoStatus[] =
  DO_STATUSES.filter((s) => !TERMINAL_DO_STATUSES.includes(s))

/**
 * "Unpaid" is `issued` alone, and the three exclusions are each deliberate:
 * `draft` is not yet owed by anybody, `paid` is settled, and `void` was
 * cancelled. Counting drafts would report money that has never been billed.
 */
export const UNPAID_INVOICE_STATUSES: readonly InvoiceStatus[] = ['issued']

export const NOT_UNPAID_INVOICE_STATUSES: readonly InvoiceStatus[] =
  INVOICE_STATUSES.filter((s) => !UNPAID_INVOICE_STATUSES.includes(s))
