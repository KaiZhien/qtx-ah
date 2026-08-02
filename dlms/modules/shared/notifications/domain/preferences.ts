/**
 * What actually gets delivered, for one person and one category (spec §6.3).
 *
 * Pure and I/O-free, per the house rule for `domain/` modules — the service loads the
 * stored row (or fails to find one) and asks this.
 */

/**
 * The shipped vocabulary. Deliberately code-side rather than a CHECK constraint, for the
 * reason the migration states: a CHECK would make every new category a schema migration.
 * Because a missing notification_pref row means DEFAULTS, adding a category here is a
 * complete change — delivered to everyone under the default policy on deploy, with no
 * backfill.
 */
export const NOTIFICATION_CATEGORIES = [
  /** A device crossed a department boundary and your role was named in notify_roles. */
  'status_handoff',
  /** Something needs a second pair of eyes and you are one of the people who can give it. */
  'approval_requested',
  /** A request you raised was approved or rejected. */
  'approval_decided',
  /** A task assigned to you falls due tomorrow, or has gone past its due date. */
  'task_reminder',
] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}

/** Human labels for the preferences screen, so the UI does not invent its own wording. */
export const CATEGORY_LABELS: Record<NotificationCategory, { title: string; hint: string }> = {
  status_handoff: {
    title: 'Device handoffs',
    hint: 'A device moved into your department and someone needs to pick it up.',
  },
  approval_requested: {
    title: 'Approvals waiting on you',
    hint: 'A request needs a decision and you are one of the people who can make it.',
  },
  approval_decided: {
    title: 'Decisions on your requests',
    hint: 'Something you sent for approval was approved or rejected.',
  },
  task_reminder: {
    title: 'Task reminders',
    hint: 'A task assigned to you is due tomorrow, or is already overdue.',
  },
}

export type StoredPref = { inApp: boolean; email: boolean; digest: boolean }

/**
 * What a user gets before they have ever visited the preferences screen.
 *
 * in-app ON: a bell entry is free to deliver and free to ignore, and the failure mode of
 * over-delivery (noise, which the user can fix) is recoverable where under-delivery
 * (missing the approval you were the only approver for) is not.
 *
 * email OFF: email is intrusive, costs money and leaves the platform. Nobody should be
 * mailed because a default said so — opting in is a decision a person makes.
 */
export const DEFAULT_PREF: StoredPref = { inApp: true, email: false, digest: false }

export type Delivery = { inApp: boolean; email: boolean }

/**
 * Resolves a stored row — or its absence — into the two things the sender acts on.
 *
 * `null` means NO ROW, and that is the common case rather than an edge one: rows are
 * written only when a user changes something. It resolves to DEFAULT_PREF, which is what
 * lets a new category and a newly invited user both work with no backfill.
 *
 * The one non-obvious rule is `digest`. It means "roll this up and send it later", so an
 * immediate email as well would be exactly what the setting exists to prevent — the email
 * channel is suppressed here. The in-app copy is deliberately kept: no digest job consumes
 * this flag yet (spec §8.3's digest is a separate slice), and dropping the bell entry too
 * would make a user who chose "digest" silently receive NOTHING at all until that slice
 * ships. Honouring the intent must not mean losing the message.
 */
export function resolveDelivery(stored: StoredPref | null): Delivery {
  const pref = stored ?? DEFAULT_PREF
  return {
    inApp: pref.inApp,
    email: pref.email && !pref.digest,
  }
}
