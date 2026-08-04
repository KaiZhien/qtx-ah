import type { ModuleKey } from '@/modules/shared/authz/catalog'
import type { NotificationCategory } from '@/modules/shared/notifications/domain/preferences'

/**
 * Pure translation from a drained outbox event into the MESSAGE a person reads.
 *
 * The sibling of modules/shared/outbox/domain/handoffTemplates.ts, and deliberately a
 * separate module rather than more entries in that one: a task and a notification answer
 * different questions ("what must be done, by which department" vs "what happened, and why
 * is it your business"), have different length budgets, and — decisively — the drain
 * creates ONE task per event but N notifications per event. Folding them together would
 * mean one registry whose entries return two unrelated shapes.
 *
 * No I/O and no clock: everything comes from the context object, so the drain can call
 * these inside its transaction with identical results, and they unit-test without a
 * database.
 */

/** The bell renders a single line; anything longer is noise rather than information. */
const TITLE_MAX = 200
const BODY_MAX = 2000

export type NotificationContent = {
  category: NotificationCategory
  title: string
  body: string
  entityType: string
  entityId: string
  module: ModuleKey
  /**
   * Where clicking it goes. Built here and STORED (see the migration) rather than derived
   * at read time, so the link a user was sent stays what it was even if a route moves.
   */
  url: string
}

/** Shared with handoffTemplates' truncate: cut on whole code points, never mid-surrogate. */
const ELLIPSIS = '…'
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

const humanize = (s: string): string => s.replace(/_/g, ' ')

// ── Device handoffs (spec §5.5, notify_roles) ───────────────────────────────

export type HandoffNotificationContext = {
  deviceId: string
  deviceSn: string | null
  pcbaASnLegacy: string | null
  fromStatus: string
  toStatus: string
  reason: string | null
  changedByName: string
  /**
   * The handoff task the SAME transaction just created, and the only safe link target.
   *
   * The obvious destination is the device page, and it is wrong: `module` below selects an
   * audience holding the RECEIVING department's access (logistics), while
   * /manufacturing/devices/[id] calls notFound() without `view_records` in MANUFACTURING.
   * So linking the device notifies exactly the people who then 404 on the click — the
   * branch's own fixture is that user, a logistics manager with ['logistics','tasks'].
   *
   * /tasks/[id] is reachable by the audience the gate already selected, and points at the
   * queue item this event actually created. createTaskInTx returns the id for this reason;
   * do not discard it again.
   */
  taskId: string
  /**
   * The RECEIVING module — the handoff template's own `module`, not 'manufacturing'.
   *
   * A device is a manufacturing record, but a handoff is addressed to the department the
   * device just landed in, and the drain already treats it that way: createTaskInTx links
   * the device with `module: handoff.module` (logistics for the one edge that exists). The
   * notification must use the SAME module or the two disagree about who is entitled to
   * hear about the same event — the task would reach Logistics while the notification was
   * gated on manufacturing access most of them do not have.
   */
  module: ModuleKey
}

/**
 * Three tiers, mirroring handoffTemplates.deviceLabel exactly — canonical serial, legacy
 * PCBA serial, then a short uuid prefix. Restated rather than imported because that one is
 * module-private, and the property that matters (never render "null", never render a fixed
 * literal that makes two devices indistinguishable) is worth pinning in both files' tests.
 */
function deviceLabel(ctx: HandoffNotificationContext): string {
  const sn = ctx.deviceSn?.trim()
  if (sn) return sn
  const legacy = ctx.pcbaASnLegacy?.trim()
  if (legacy) return legacy
  return `device ${ctx.deviceId.slice(0, 8)}`
}

export function buildHandoffNotification(
  ctx: HandoffNotificationContext,
): NotificationContent {
  const device = deviceLabel(ctx)
  const reasonClause = ctx.reason?.trim() ? ` Reason given: ${ctx.reason.trim()}.` : ''

  return {
    category: 'status_handoff',
    title: truncate(`${device} is now ${humanize(ctx.toStatus)}`, TITLE_MAX),
    body: truncate(
      `${ctx.changedByName} moved ${device} from ${humanize(ctx.fromStatus)} to `
      + `${humanize(ctx.toStatus)}.${reasonClause}`,
      BODY_MAX,
    ),
    entityType: 'device',
    entityId: ctx.deviceId,
    module: ctx.module,
    // The TASK, not the device — see `taskId` above. entityType stays 'device' because the
    // notification is ABOUT a device; only the click target has to respect the audience.
    url: `/tasks/${ctx.taskId}`,
  }
}

// ── Approvals (spec §6.3) ───────────────────────────────────────────────────

export type ApprovalNotificationContext = {
  approvalId: string
  kind: string
  module: ModuleKey
  entityType: string
  entityId: string
  label: string | null
  requestedByName: string
}

/** Two tiers, mirroring handoffTemplates.recordLabel: never a bare literal, never "null". */
function recordLabel(ctx: { entityType: string; entityId: string; label: string | null }): string {
  const label = ctx.label?.trim()
  if (label) return label
  return `${humanize(ctx.entityType)} ${ctx.entityId.slice(0, 8)}`
}

/**
 * Sent to everyone who can DECIDE this request.
 *
 * The url points at `/approvals` — the queue — rather than at the record under approval,
 * because the queue is where the decision is actually made and it is scoped to exactly the
 * requests this person may act on.
 */
export function buildApprovalRequestedNotification(
  ctx: ApprovalNotificationContext,
): NotificationContent {
  const record = recordLabel(ctx)
  return {
    category: 'approval_requested',
    title: truncate(`Approval needed: ${record}`, TITLE_MAX),
    body: truncate(
      `${ctx.requestedByName} asked for approval on ${record}. `
      + 'Review it against the snapshot the request captured, then approve or reject.',
      BODY_MAX,
    ),
    entityType: 'approval',
    entityId: ctx.approvalId,
    module: ctx.module,
    url: '/approvals',
  }
}

export type ApprovalDecidedContext = Omit<ApprovalNotificationContext, 'requestedByName'> & {
  decidedByName: string
  decision: 'approved' | 'rejected'
  note: string | null
}

/**
 * Sent to the REQUESTER, and to nobody else.
 *
 * The note is carried verbatim on a rejection, and that is not a nicety:
 * approvalService.RejectionNeedsNoteError refuses a rejection without one precisely so the
 * requester is not left guessing what has to change. Dropping it here would undo that rule
 * at the only moment it matters.
 */
export function buildApprovalDecidedNotification(
  ctx: ApprovalDecidedContext,
): NotificationContent {
  const record = recordLabel(ctx)
  const noteClause = ctx.note?.trim() ? ` Note: ${ctx.note.trim()}` : ''

  return {
    category: 'approval_decided',
    title: truncate(
      `${ctx.decision === 'approved' ? 'Approved' : 'Rejected'}: ${record}`, TITLE_MAX),
    body: truncate(
      `${ctx.decidedByName} ${ctx.decision} your request on ${record}.${noteClause}`,
      BODY_MAX,
    ),
    entityType: 'approval',
    entityId: ctx.approvalId,
    module: ctx.module,
    url: '/approvals',
  }
}
