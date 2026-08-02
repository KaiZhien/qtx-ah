import Link from 'next/link'
import { getCurrentActor } from '@/modules/shared/auth/session'
import { unreadCount } from '@/modules/shared/notifications/services/notificationService'

/**
 * The bell in the platform shell.
 *
 * A SERVER COMPONENT that resolves its own actor and its own count, so the shared layout's
 * only change is `<NotificationBell />` — one additive line in a file six other agents are
 * also touching this wave. Everything this needs to know it fetches itself.
 *
 * IT NEVER THROWS. The layout renders on every authenticated page, so an exception here
 * takes down the entire platform — and the most likely cause is the most mundane one: the
 * `notification` table does not exist yet, because this slice's migration is committed and
 * not yet applied (four others sit ahead of it). A missing bell badge on an unmigrated
 * deployment is a cosmetic gap; a 500 on every page is an outage. So the count is best
 * effort and falls back to "no badge".
 */
export async function NotificationBell() {
  const actor = await getCurrentActor()
  if (!actor) return null

  let unread = 0
  try {
    unread = await unreadCount(actor)
  } catch (err) {
    // Logged, not surfaced — see the header. An unmigrated database is the expected cause.
    console.error(JSON.stringify({
      level: 'error', msg: 'notification bell could not read the unread count',
      err: err instanceof Error ? err.message : String(err),
    }))
  }

  return (
    <Link
      href="/notifications"
      className="relative rounded-md p-2 text-slate-600 transition-colors hover:bg-slate-100"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      {/* Inline SVG rather than an icon dependency: one glyph does not justify a package. */}
      <svg
        aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      {unread > 0 && (
        <span
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center
                     rounded-full bg-sky-600 px-1 text-[10px] font-semibold text-white"
        >
          {/* Capped: a runaway backlog must not stretch the header. */}
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  )
}
