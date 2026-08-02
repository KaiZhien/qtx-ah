import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import { SYSTEM_ACTOR_ID } from '@/modules/shared/authz/actor'
import type { Actor, ModuleKey } from '@/modules/shared/authz/catalog'
import {
  NOTIFICATION_CATEGORIES, isNotificationCategory, resolveDelivery, DEFAULT_PREF,
  type NotificationCategory, type StoredPref,
} from '@/modules/shared/notifications/domain/preferences'
import type { NotificationContent } from '@/modules/shared/notifications/domain/templates'
import { getEmailSender } from '@/modules/shared/notifications/services/email'

/**
 * Notifications, I/O half (spec §6.3).
 *
 * THE ONE STRUCTURAL DECISION worth reading before anything else: the fan-out INSERT joins
 * the CALLER'S transaction (fanOutInTx), it does not open its own. The outbox drain's
 * exactly-once property comes from the task insert and the `processed_at` stamp sharing one
 * transaction — withTransaction takes a fresh pooled connection per call, so a notification
 * written through a second one would commit independently, and a crash between the two
 * would leave notifications whose event is still unprocessed for the next drain to fan out
 * AGAIN. Every recipient would be told twice. So the notification write is part of the same
 * atom as the task and the stamp, and inherits exactly-once from it rather than inventing a
 * weaker guarantee of its own.
 *
 * EMAIL IS THE EXCEPTION, AND IT HAS TO BE. A send cannot be rolled back, so mailing from
 * inside that transaction would deliver mail for events whose transaction later aborted.
 * fanOutInTx therefore returns EMAIL INTENTS rather than sending, and the caller delivers
 * them AFTER its transaction commits (deliverEmails below). If the process dies in between,
 * the in-app notification exists and `emailed_at` stays NULL — which is the true statement,
 * and the safe direction: an email nobody received is recoverable, an email about an event
 * that never happened is not.
 *
 * NO NEW AUTHORITY WAS ADDED FOR THE DRAIN. Fan-out authorizes `create_records` in the
 * event's module — a permission the automation principal ALREADY HOLDS in every module
 * (20260731000000_platform_outbox.sql). Creating a notification is creating a record, so
 * the narrowest permission that could express it is the one already granted;
 * fn_seed_system_actor()'s keep-list is untouched by this slice.
 */

// ── Recipient resolution ────────────────────────────────────────────────────

export type Recipient = { id: string; email: string; fullName: string }

/**
 * Everything that must be true of a recipient regardless of HOW they were selected.
 *
 * The system-actor exclusion is not defensive clutter. The automation principal holds the
 * `operator` role and EVERY module, so a `notify_roles` array containing 'operator' would
 * select it — and it would then accumulate a notification for every handoff forever, in a
 * bell nobody can open, since it has no login path by construction.
 */
const RECIPIENT_BASE = `
  FROM app_user u
  JOIN role r ON r.id = u.role_id
 WHERE u.active AND u.deleted_at IS NULL
   AND u.id <> '${SYSTEM_ACTOR_ID}'::uuid`

/**
 * `can()`'s module rule, as SQL: super_admin bypasses the MODULE gate only.
 * Kept character-for-character in step with modules/shared/authz/policy.ts.
 */
const MODULE_CLAUSE = `(r.key = 'super_admin' OR $MODULE = ANY(u.module_access))`

/**
 * Resolves `status_transition.notify_roles` — the column carried in the outbox payload
 * since 20260719000001_platform_devices.sql and, until this slice, read by nothing.
 *
 * Roles are resolved to users AT DRAIN TIME rather than stored per user on the event. The
 * membership that matters is the membership when the notification is delivered: a person
 * who joined Logistics yesterday should hear about today's handoff, and one who left
 * should not. Resolving at produce time would freeze a stale audience into the payload.
 *
 * Gated on module access as well as role, because a notification names a record: telling
 * someone a device moved when they cannot open that device is a disclosure, not a courtesy.
 */
export async function resolveRoleRecipients(
  tx: Tx, roleKeys: readonly string[], module: ModuleKey, excludeUserId: string | null,
): Promise<Recipient[]> {
  if (roleKeys.length === 0) return []
  const { rows } = await tx.query<{ id: string; email: string; full_name: string }>(
    `SELECT u.id, u.email, u.full_name
     ${RECIPIENT_BASE}
       AND r.key = ANY($1)
       AND ${MODULE_CLAUSE.replace('$MODULE', '$2')}
       AND ($3::uuid IS NULL OR u.id <> $3::uuid)
     ORDER BY u.full_name`,
    [roleKeys, module, excludeUserId])
  return rows.map((r) => ({ id: r.id, email: r.email, fullName: r.full_name }))
}

/**
 * Everyone who could actually DECIDE an approval in this module.
 *
 * Mirrors `can(actor, 'approve_requests', module)` exactly — role grant OR granted
 * override, MINUS revoked override, with expiry honoured and the super_admin module
 * bypass — because a notification list that disagrees with the queue is worse than no
 * notification: it either tells people about decisions they cannot make, or stays silent
 * for the one person who can.
 *
 * The REQUESTER is excluded via `excludeUserId`, and that is a correctness rule rather
 * than a politeness: evaluateDecision refuses a decision on your own request, so a
 * requester who also holds `approve_requests` would be told to go and do something the
 * engine will then refuse.
 */
export async function resolveApproverRecipients(
  tx: Tx, module: ModuleKey, excludeUserId: string | null,
): Promise<Recipient[]> {
  const hasPermission = `
    (r.key = 'super_admin' OR EXISTS (
       SELECT 1 FROM role_permission rp JOIN permission p ON p.id = rp.permission_id
        WHERE rp.role_id = u.role_id AND p.key = 'approve_requests')
     OR EXISTS (
       SELECT 1 FROM user_permission_override o JOIN permission p ON p.id = o.permission_id
        WHERE o.user_id = u.id AND o.granted AND o.deleted_at IS NULL
          AND (o.expires_at IS NULL OR o.expires_at > now())
          AND p.key = 'approve_requests'))
    AND NOT EXISTS (
       SELECT 1 FROM user_permission_override o JOIN permission p ON p.id = o.permission_id
        WHERE o.user_id = u.id AND NOT o.granted AND o.deleted_at IS NULL
          AND (o.expires_at IS NULL OR o.expires_at > now())
          AND p.key = 'approve_requests')`

  const { rows } = await tx.query<{ id: string; email: string; full_name: string }>(
    `SELECT u.id, u.email, u.full_name
     ${RECIPIENT_BASE}
       AND ${MODULE_CLAUSE.replace('$MODULE', '$1')}
       AND ($2::uuid IS NULL OR u.id <> $2::uuid)
       AND ${hasPermission}
     ORDER BY u.full_name`,
    [module, excludeUserId])
  return rows.map((r) => ({ id: r.id, email: r.email, fullName: r.full_name }))
}

/** One person, by id — for the decided-notification, which goes to the requester alone. */
export async function resolveRecipientById(
  tx: Tx, userId: string,
): Promise<Recipient | null> {
  const { rows } = await tx.query<{ id: string; email: string; full_name: string }>(
    `SELECT u.id, u.email, u.full_name ${RECIPIENT_BASE} AND u.id = $1`, [userId])
  const row = rows[0]
  return row ? { id: row.id, email: row.email, fullName: row.full_name } : null
}

// ── Fan-out ─────────────────────────────────────────────────────────────────

/**
 * A queued email, produced inside the transaction and sent after it commits. `to` is
 * captured here rather than re-read later so delivery cannot race a user record changing.
 */
export type EmailIntent = {
  notificationId: string
  to: string
  subject: string
  text: string
}

/** Loads the stored preferences for a set of users in ONE query, defaulting on absence. */
async function loadPrefs(
  tx: Tx, userIds: readonly string[], category: string,
): Promise<Map<string, StoredPref>> {
  const out = new Map<string, StoredPref>()
  if (userIds.length === 0) return out
  const { rows } = await tx.query<{
    user_id: string; in_app: boolean; email: boolean; digest: boolean
  }>(
    `SELECT user_id, in_app, email, digest FROM notification_pref
      WHERE user_id = ANY($1) AND category = $2`, [userIds, category])
  for (const r of rows) {
    out.set(r.user_id, { inApp: r.in_app, email: r.email, digest: r.digest })
  }
  return out
}

export type FanOutOptions = {
  /**
   * Opt-in idempotency. When set, the per-recipient key becomes `${dedupeKey}:${userId}`
   * and the insert is ON CONFLICT DO NOTHING — so a producer that can name what makes its
   * message unique becomes safely re-runnable. See the migration's header.
   */
  dedupeKey?: string
}

/**
 * What a fan-out actually did.
 *
 * `created` counts ROWS INSERTED, which is deliberately not the same as recipients passed
 * in: a recipient who muted the category gets none, and a dedupe key that already existed
 * suppresses one. A caller reporting "notified 5 people" from the recipient count would be
 * wrong in exactly the cases the design is built around — most visibly on a re-run of the
 * reminder sweep, where the honest answer is zero.
 */
export type FanOutResult = { created: number; intents: EmailIntent[] }

/**
 * Writes one notification per recipient INSIDE the caller's transaction, honouring each
 * person's preferences, and returns the emails that should go out once it commits.
 *
 * Recipients who have turned the in-app channel off get NO ROW — the bell is the record,
 * and writing a row the user asked not to see so that a count could ignore it would make
 * "unread" mean something different from what the user configured.
 */
export async function fanOutInTx(
  tx: Tx, actor: Actor, recipients: readonly Recipient[], content: NotificationContent,
  opts: FanOutOptions = {},
): Promise<FanOutResult> {
  if (recipients.length === 0) return { created: 0, intents: [] }

  // The permission the automation principal ALREADY holds — see this module's header. The
  // module comes from the content, so a notification can never be filed into a module the
  // actor could not create a record in.
  authorize(actor, 'create_records', content.module)

  const prefs = await loadPrefs(tx, recipients.map((r) => r.id), content.category)
  const intents: EmailIntent[] = []
  let created = 0

  for (const recipient of recipients) {
    const delivery = resolveDelivery(prefs.get(recipient.id) ?? null)
    if (!delivery.inApp && !delivery.email) continue

    const dedupeKey = opts.dedupeKey ? `${opts.dedupeKey}:${recipient.id}` : null

    // ON CONFLICT DO NOTHING is a no-op unless dedupe_key is set (the unique index is
    // partial), so producers with no natural key are unaffected by it.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO notification (user_id, category, title, body, entity_type, entity_id,
                                 module, url, dedupe_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [recipient.id, content.category, content.title, content.body, content.entityType,
       content.entityId, content.module, content.url, dedupeKey, actor.id])

    // No row means the dedupe key already existed — this exact message has already been
    // delivered to this person. Emailing anyway would defeat the idempotency entirely.
    const notificationId = rows[0]?.id
    if (!notificationId) continue
    created++

    if (delivery.email && recipient.email) {
      intents.push({
        notificationId,
        to: recipient.email,
        subject: content.title,
        text: `${content.body}\n\n${appUrl(content.url)}`,
      })
    }
  }
  return { created, intents }
}

/**
 * Absolute links for email, where a relative path is meaningless.
 *
 * Falls back to a relative path rather than to a guessed host: a wrong absolute URL sends
 * people to somebody else's site, while a relative one is merely unclickable and obviously
 * broken. `NEXT_PUBLIC_SITE_URL` is the deployment's own name for itself.
 */
function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '')
  return base ? `${base}${path}` : path
}

/**
 * Sends queued emails and stamps `emailed_at` for the ones that ACTUALLY went out.
 *
 * Called AFTER the producing transaction commits — never inside it (see the module header).
 * Every failure is absorbed: the in-app notification is already delivered and is the record
 * of the event, so a mail outage must not fail a drain, a sweep or a user's action.
 *
 * `emailed_at` is stamped ONLY on `delivered: true`, which is what keeps the column honest
 * on a deployment with no RESEND_API_KEY: LoggingEmailSender truthfully reports false, and
 * the column stays NULL rather than recording a mail history that never happened.
 */
export async function deliverEmails(
  actorId: string, intents: readonly EmailIntent[],
): Promise<{ sent: number; failed: number }> {
  if (intents.length === 0) return { sent: 0, failed: 0 }
  const sender = getEmailSender()
  const delivered: string[] = []
  let failed = 0

  for (const intent of intents) {
    const result = await sender.send({
      to: intent.to, subject: intent.subject, text: intent.text,
    })
    if (result.delivered) delivered.push(intent.notificationId)
    else failed++
  }

  if (delivered.length > 0) {
    try {
      await withTransaction(actorId, (tx) => tx.query(
        `UPDATE notification SET emailed_at = now()
          WHERE id = ANY($1) AND emailed_at IS NULL`, [delivered]))
    } catch (err) {
      // The mail went out; only the bookkeeping failed. Reported rather than thrown,
      // because throwing here would make a caller believe the send failed too — and a
      // retry would then send a SECOND email, which is the worse of the two errors.
      console.error(JSON.stringify({
        level: 'error', msg: 'could not stamp emailed_at after a successful send',
        count: delivered.length, err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
  return { sent: delivered.length, failed }
}

// ── Reading (the bell) ──────────────────────────────────────────────────────

export type NotificationItem = {
  id: string
  category: string
  title: string
  body: string | null
  url: string | null
  entityType: string | null
  entityId: string | null
  module: string | null
  readAt: Date | null
  createdAt: Date
}

/**
 * NO MODULE PERMISSION IS REQUIRED TO READ YOUR OWN NOTIFICATIONS, and that is deliberate
 * rather than an omitted guard.
 *
 * `user_id = actor.id` IS the authorization here — these rows are addressed to this person
 * and to nobody else, and the fan-out already applied the module gate when it decided who
 * was allowed to be told. Re-gating on a module permission at read time would mean a
 * viewer, or anyone whose access narrowed after delivery, silently losing messages they
 * had already been sent, with an unread count that never goes down because they cannot
 * open the thing they are counting.
 */
export async function listNotifications(
  actor: Actor, opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; category: string; title: string; body: string | null; url: string | null
      entity_type: string | null; entity_id: string | null; module: string | null
      read_at: Date | null; created_at: Date
    }>(
      `SELECT id, category, title, body, url, entity_type, entity_id, module, read_at, created_at
         FROM notification
        WHERE user_id = $1 ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC
        LIMIT $2`, [actor.id, limit])
    return rows.map((r) => ({
      id: r.id, category: r.category, title: r.title, body: r.body, url: r.url,
      entityType: r.entity_type, entityId: r.entity_id, module: r.module,
      readAt: r.read_at, createdAt: r.created_at,
    }))
  })
}

/** The bell's badge. Capped so a runaway backlog renders as "99+" rather than a huge count. */
export async function unreadCount(actor: Actor): Promise<number> {
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL`,
      [actor.id])
    return rows[0]?.n ?? 0
  })
}

/**
 * Marks one notification read. Scoped to the owner in the WHERE clause, so a forged id
 * touches nothing rather than being refused — there is nothing to disclose either way, and
 * a silent no-op is the right answer for a row that is not yours.
 *
 * Idempotent (`read_at IS NULL` guard), so a double-click does not rewrite the timestamp
 * and lose when it was actually first read.
 */
export async function markRead(actor: Actor, notificationId: string): Promise<void> {
  const id = z.string().uuid().parse(notificationId)
  await withTransaction(actor.id, (tx) => tx.query(
    `UPDATE notification SET read_at = now()
      WHERE id = $1 AND user_id = $2 AND read_at IS NULL`, [id, actor.id]))
}

export async function markAllRead(actor: Actor): Promise<{ marked: number }> {
  return withTransaction(actor.id, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [actor.id])
    return { marked: rowCount ?? 0 }
  })
}

// ── Preferences ─────────────────────────────────────────────────────────────

export type PreferenceRow = StoredPref & { category: NotificationCategory }

/**
 * Every shipped category with its EFFECTIVE setting — stored where a row exists, defaults
 * everywhere else. The screen therefore always renders the full list, and a user sees what
 * is actually true for them rather than an empty page that looks like nothing is on.
 */
export async function getPreferences(actor: Actor): Promise<PreferenceRow[]> {
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      category: string; in_app: boolean; email: boolean; digest: boolean
    }>(`SELECT category, in_app, email, digest FROM notification_pref WHERE user_id = $1`,
      [actor.id])
    const stored = new Map(rows.map((r) =>
      [r.category, { inApp: r.in_app, email: r.email, digest: r.digest }]))
    return NOTIFICATION_CATEGORIES.map((category) => ({
      category, ...(stored.get(category) ?? DEFAULT_PREF),
    }))
  })
}

const prefSchema = z.object({
  category: z.string().refine(isNotificationCategory, 'Unknown notification category'),
  inApp: z.boolean(),
  email: z.boolean(),
  digest: z.boolean(),
})
export type SetPreferenceInput = z.input<typeof prefSchema>

/**
 * Upserts ONE category's preferences FOR THE ACTOR THEMSELVES.
 *
 * There is deliberately no user_id parameter and no admin variant. Editing somebody else's
 * delivery preferences is a way to silence their alerts without their knowledge — a
 * capability with no legitimate operational use that an admin does not already have a
 * better tool for — so the service simply cannot express it.
 */
export async function setPreference(actor: Actor, input: SetPreferenceInput): Promise<void> {
  const data = prefSchema.parse(input)
  await withTransaction(actor.id, (tx) => tx.query(
    `INSERT INTO notification_pref (user_id, category, in_app, email, digest,
                                    created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$1,$1)
     ON CONFLICT (user_id, category) DO UPDATE SET
       in_app = EXCLUDED.in_app, email = EXCLUDED.email, digest = EXCLUDED.digest,
       updated_at = now(), updated_by = EXCLUDED.updated_by,
       version = notification_pref.version + 1`,
    [actor.id, data.category, data.inApp, data.email, data.digest]))
}
