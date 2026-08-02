import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import {
  listNotifications, unreadCount,
} from '@/modules/shared/notifications/services/notificationService'
import { CATEGORY_LABELS, isNotificationCategory } from '@/modules/shared/notifications/domain/preferences'
import { relativeAge } from '@/modules/shared/notifications/domain/age'
import {
  NotificationList, type NotificationRow,
} from '@/components/notifications/NotificationList'
import { cn } from '@/lib/utils'

type PageProps = { searchParams: { show?: string } }

/**
 * The notification centre (spec §6.3).
 *
 * NO PERMISSION GATE, and that is deliberate rather than an omission. These rows are
 * addressed to this person; `user_id = actor.id` IS the authorization, and the fan-out
 * already applied the module gate when it decided who was entitled to be told. Re-gating
 * here would mean anyone whose module access narrowed after delivery silently loses
 * messages they were already sent, with an unread count they cannot clear.
 */
export default async function NotificationsPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  const unreadOnly = searchParams.show !== 'all'

  const [items, unread] = await Promise.all([
    listNotifications(actor, { unreadOnly }),
    unreadCount(actor),
  ])

  // One clock for the whole page, so two rows rendered a second apart cannot disagree
  // about which of them is older.
  const now = new Date()

  const rows: NotificationRow[] = items.map((n) => ({
    id: n.id,
    categoryLabel: isNotificationCategory(n.category)
      ? CATEGORY_LABELS[n.category].title
      // A category delivered by a newer deploy than this render, or removed from the
      // vocabulary since. Shown as itself rather than dropped: the message is still real.
      : n.category.replace(/_/g, ' '),
    title: n.title,
    body: n.body,
    url: n.url,
    age: relativeAge(n.createdAt, now),
    read: n.readAt !== null,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Notifications</h1>
        <p className="mt-1 text-slate-600">
          Handoffs into your department, approvals waiting on you, decisions on your
          requests, and reminders for your tasks.
        </p>
      </div>

      <nav className="flex gap-1 text-sm" aria-label="Filter notifications">
        <Tab href="/notifications" active={unreadOnly}>Unread</Tab>
        <Tab href="/notifications?show=all" active={!unreadOnly}>All</Tab>
      </nav>

      <NotificationList rows={rows} unread={unread} />
    </div>
  )
}

function Tab({ href, active, children }: {
  href: string; active: boolean; children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn('rounded-md px-3 py-1.5 transition-colors',
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
    >
      {children}
    </Link>
  )
}
