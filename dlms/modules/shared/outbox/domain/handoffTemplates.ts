import type { ModuleKey } from '@/modules/shared/authz/catalog'
import { approvalKindLabel } from '@/modules/shared/approvals/domain/approvalDecision'

/**
 * Pure translation from an outbox event into the shape of the task the drain
 * will create. No I/O, no clock — everything comes from the context object, so
 * this can be unit-tested without a database and the drain can call it inside or
 * outside a transaction with identical results.
 *
 * TWO REGISTRIES, because there are two kinds of producer:
 *
 *   HANDOFF_TEMPLATES, keyed by `status_transition.task_template_key` (spec
 *     §5.5) — a device crossing a department boundary.
 *   APPROVAL_TEMPLATES, keyed by `approval.kind` (spec §6.3) — a request for a
 *     second pair of eyes that has to reach the approver's queue.
 *
 * They share this module, the HandoffTask output shape, the length limits and
 * the own-property-guarded lookup rather than living apart, because every one of
 * those properties is a property of "turning an event into a task" and forking
 * them is how two registries drift into disagreeing about what a task may hold.
 *
 * The output is deliberately shaped as direct `createTask` input (see
 * modules/shared/tasks/services/taskService.ts's `createSchema`): same field
 * names, same types, and the SAME length limits enforced here rather than left
 * to the database to reject at drain time.
 */

/** Mirrors createSchema: title is 1-200 chars, description is capped at 5000. */
const TITLE_MAX = 200
const DESCRIPTION_MAX = 5000

export type HandoffTask = {
  title: string
  description: string
  module: ModuleKey
  department: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
}

export type HandoffContext = {
  deviceId: string
  deviceSn: string | null
  pcbaASnLegacy: string | null
  fromStatus: string
  toStatus: string
  reason: string | null
  changedByName: string
}

/**
 * A key an event carries but no registry holds. For a device handoff that means
 * the status graph and this module have drifted apart; for an approval it means
 * the kind has no queue destination decided yet. Either way it is data, not a
 * degraded case to paper over — so the builders throw rather than inventing a
 * generic task that would hide the disagreement, and the drain records the throw
 * as a retryable outbox failure that eventually PARKS (spec §5.5). A parked event
 * is visible in the runbook's backlog; a task saying "something needs doing" is
 * not visible as a problem at all, and lands in a real person's queue.
 *
 * `label` names WHICH vocabulary the key came from, so a failed attempt is
 * diagnosable from `outbox.last_error` alone.
 */
export class UnknownTemplateError extends Error {
  constructor(templateKey: string, label = 'task_template_key') {
    super(`No handoff template registered for ${label} "${templateKey}"`)
    this.name = 'UnknownTemplateError'
  }
}

const ELLIPSIS = '…'

/**
 * Truncates with a trailing ellipsis rather than throwing: a handoff task that
 * arrives slightly abbreviated is far better than one the drain can never
 * create because `createTask` rejects an oversized field. The result's length
 * never exceeds `max` (in UTF-16 code units — the unit `createSchema`'s zod
 * `.max()` counts, and thus what the Postgres `text` insert must satisfy),
 * including the ellipsis character itself.
 *
 * Cuts on whole code points, not UTF-16 code units: `reason`/`deviceSn` can
 * contain astral-plane characters (emoji, CJK Extension B+ names), which are
 * two code units each. Slicing on `.length` can land mid-surrogate-pair,
 * producing a lone surrogate that is not validly encodable as UTF-8 — merely
 * relocating the failure this function exists to prevent to `createTask`'s
 * insert (or corrupting it via replacement-character substitution). Iterating
 * the string (rather than indexing it) walks whole code points for free.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''

  let result = ''
  for (const codePoint of text) {
    if (result.length + codePoint.length + ELLIPSIS.length > max) break
    result += codePoint
  }
  return `${result}${ELLIPSIS}`
}

/**
 * Three tiers, in order, so a queue of handoff tasks stays distinguishable
 * even for legacy-migrated rows:
 *
 * 1. `deviceSn` — the canonical identity when present.
 * 2. `pcbaASnLegacy` — the de-facto identity for legacy-migrated rows that
 *    never got a `device_sn`. May hold a preserved range such as
 *    `"EE-02A-2603-0001 to 0015"`; rendered verbatim, never parsed.
 * 3. A short prefix of the device's UUID (`deviceId`), which every row has
 *    regardless of serial data. This is the tier that matters most: without
 *    it, two serial-less devices would both render the same fixed literal,
 *    and a logistics queue full of character-for-character identical titles
 *    is effectively useless even though each task links to a different
 *    device.
 *
 * Never renders "null" or a blank identifier at any tier.
 */
function deviceLabel(ctx: HandoffContext): string {
  const sn = ctx.deviceSn?.trim()
  if (sn) return sn

  const legacy = ctx.pcbaASnLegacy?.trim()
  if (legacy) return legacy

  return `device ${ctx.deviceId.slice(0, 8)}`
}

/** e.g. 'ready_for_delivery' -> 'ready for delivery'. */
function humanizeStatus(status: string): string {
  return status.replace(/_/g, ' ')
}

export const HANDOFF_TEMPLATES: Record<string, (ctx: HandoffContext) => HandoffTask> = {
  logistics_prepare_delivery: (ctx) => {
    const device = deviceLabel(ctx)
    const reasonClause = ctx.reason?.trim() ? ` Reason given: ${ctx.reason.trim()}.` : ''

    const title = truncate(`Prepare delivery for ${device}`, TITLE_MAX)
    const description = truncate(
      `${ctx.changedByName} moved ${device} from ${humanizeStatus(ctx.fromStatus)} to ` +
      `${humanizeStatus(ctx.toStatus)}.${reasonClause} Logistics: please prepare this device ` +
      'for outbound delivery.',
      DESCRIPTION_MAX,
    )

    return {
      title,
      description,
      module: 'logistics',
      department: 'Logistics',
      priority: 'normal',
    }
  },
}

/**
 * Dispatches on templateKey; throws UnknownTemplateError rather than falling
 * back. `task_template_key` is admin-editable free text, so any string —
 * including the name of an inherited `Object.prototype` member such as
 * `"constructor"` or `"toString"` — is a plausible input. A plain truthiness
 * check on `HANDOFF_TEMPLATES[templateKey]` would walk the prototype chain
 * and either hand back an inherited method mistyped as `HandoffTask` or throw
 * a raw `TypeError`; the explicit `hasOwnProperty` guard restricts resolution
 * to keys this module actually registered.
 */
export function buildHandoffTask(templateKey: string, ctx: HandoffContext): HandoffTask {
  if (!Object.prototype.hasOwnProperty.call(HANDOFF_TEMPLATES, templateKey)) {
    throw new UnknownTemplateError(templateKey)
  }
  return HANDOFF_TEMPLATES[templateKey](ctx)
}

// ── Approval requests (spec §6.3) ───────────────────────────────────────────

/**
 * The department queue each module's work lands in — `task.department`, matched
 * against `app_user.department` by taskService's `scope: 'department'` filter.
 *
 * Title-Cased module names, which is what platform_seed.sql actually writes
 * ('Engineering') and what logistics_prepare_delivery already hardcodes
 * ('Logistics'). Named once here rather than restated per template so a queue
 * cannot be misspelled into existence for one kind and not another.
 */
export const MODULE_DEPARTMENTS: Record<ModuleKey, string> = {
  engineering: 'Engineering',
  finance: 'Finance',
  logistics: 'Logistics',
  manufacturing: 'Manufacturing',
  maintenance: 'Maintenance',
  tasks: 'Tasks',
  admin: 'Admin',
}

/**
 * Everything an approval task is built from. Self-contained like HandoffContext,
 * and for the same reason: the drain builds the task from the event's payload
 * alone and never re-reads a record that may have moved on since.
 *
 * `module` is READ FROM THE EVENT rather than derived from `kind` here. The
 * migration's header is explicit that the module is a property of the ENTITY, so
 * a kind→module map in code "becomes a lie while a stored column stays true" the
 * day a kind spans two modules. The service derives and validates that pair once,
 * on the way in; this module consumes what was stored.
 */
export type ApprovalContext = {
  approvalId: string
  entityType: string
  entityId: string
  module: ModuleKey
  /** Human reference for the record under approval (an invoice number, say). */
  label: string | null
  requestedByName: string
}

/**
 * Two tiers, mirroring deviceLabel's reasoning: the caller's human reference when
 * it supplied one, and otherwise the entity type plus a short prefix of its uuid.
 * Never a bare literal — a queue of character-for-character identical titles is
 * useless even though each task links to a different record.
 */
function recordLabel(ctx: ApprovalContext): string {
  const label = ctx.label?.trim()
  if (label) return label
  return `${ctx.entityType.replace(/_/g, ' ')} ${ctx.entityId.slice(0, 8)}`
}

/**
 * Keyed by `approval.kind`, and DELIBERATELY not exhaustive over the CHECK set.
 *
 * `invoice` is registered because Finance is the engine's first real consumer
 * (spec BR-4: records at or above finance_approval_threshold_sgd). `eco` and
 * `repair_signoff` are not: Engineering's ECO step and Maintenance's repair
 * sign-off still run through their own direct permission gates, so nothing yet
 * decides which queue such a request should land in or what the task should say.
 * Registering a placeholder for them would put a task that answers no question
 * into a real person's queue; leaving them unregistered parks the event where the
 * runbook can see it, and the approvals queue page reads the `approval` table
 * directly and so works for every kind regardless.
 */
export const APPROVAL_TEMPLATES: Record<string, (ctx: ApprovalContext) => HandoffTask> = {
  invoice: (ctx) => {
    const record = recordLabel(ctx)
    return {
      title: truncate(`Approve ${record}`, TITLE_MAX),
      description: truncate(
        `${ctx.requestedByName} asked for approval to issue ${record}. Check the total and the ` +
        'buyer against the snapshot the request captured, then approve or reject it. A rejection ' +
        'needs a note saying what has to change, and nobody may decide their own request.',
        DESCRIPTION_MAX,
      ),
      module: ctx.module,
      department: MODULE_DEPARTMENTS[ctx.module],
      // An approval BLOCKS the work that asked for it — an invoice cannot be issued
      // until someone decides — so it outranks the ordinary department handoff.
      priority: 'high',
    }
  },
}

/**
 * Dispatches on the approval's kind. Guarded with hasOwnProperty for the same
 * reason buildHandoffTask is: an inherited `Object.prototype` member ("constructor",
 * "toString") would otherwise resolve to a method mistyped as a HandoffTask, and the
 * value being looked up here reaches this function through a jsonb payload with no
 * schema behind it.
 *
 * The kind is named in the error so a parked event is diagnosable from
 * `outbox.last_error` without re-deriving anything.
 */
export function buildApprovalTask(kind: string, ctx: ApprovalContext): HandoffTask {
  if (!Object.prototype.hasOwnProperty.call(APPROVAL_TEMPLATES, kind)) {
    throw new UnknownTemplateError(`${kind} (${approvalKindLabel(kind)})`, 'approval kind')
  }
  return APPROVAL_TEMPLATES[kind](ctx)
}
