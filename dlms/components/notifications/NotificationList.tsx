'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  markNotificationReadAction, markAllNotificationsReadAction,
} from '@/app/(platform)/notifications/actions'
import { callFailed } from '@/components/platform/callFailed'
import { cn } from '@/lib/utils'

export type NotificationRow = {
  id: string
  categoryLabel: string
  title: string
  body: string | null
  url: string | null
  age: string
  read: boolean
}

type Props = { rows: NotificationRow[]; unread: number }

/**
 * The notification centre's list.
 *
 * OPENING ONE MARKS IT READ, and does so before navigating rather than on the destination
 * page: the destination is any of five different record pages, and making each of them
 * responsible for clearing a notification it does not know about is how one of them ends up
 * not doing it. The read is optimistic in the UI and authoritative on the server — a failed
 * mark leaves the row unread and says so, rather than silently diverging from the badge.
 *
 * Hiding a control is never the authorization: every action re-checks on the server, and
 * `markRead` is scoped to the owner in its WHERE clause, so a forged id touches nothing.
 */
export function NotificationList({ rows, unread }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [readIds, setReadIds] = useState<Set<string>>(new Set())

  const isRead = (row: NotificationRow) => row.read || readIds.has(row.id)

  const open = (row: NotificationRow) => {
    if (!isRead(row)) {
      setReadIds((prev) => new Set(prev).add(row.id))
      // The revert lives in the failure branch, so the CALL rejecting — rather
      // than the action refusing — has to revert too, or the row stays optimistically
      // read forever against a database that never heard about it. Uncaught, that
      // rejection would also take the whole page to the error boundary.
      const revert = () => setReadIds((prev) => {
        const next = new Set(prev)
        next.delete(row.id)
        return next
      })
      startTransition(async () => {
        try {
          const result = await markNotificationReadAction(row.id)
          if (!result.ok) {
            // Put it back: a badge that disagrees with the database is worse than a
            // notification that stayed unread.
            revert()
            toast.error(result.error)
          }
        } catch (err) {
          revert()
          toast.error(callFailed('notification mark-read', err))
        }
      })
    }
    if (row.url) router.push(row.url)
  }

  const markAll = () => {
    startTransition(async () => {
      try {
        const result = await markAllNotificationsReadAction()
        if (result.ok) {
          setReadIds(new Set(rows.map((r) => r.id)))
          toast.success(result.data.marked === 0
            ? 'Nothing was unread.'
            : `Marked ${result.data.marked} as read.`)
          router.refresh()
        } else {
          toast.error(result.error)
        }
      } catch (err) {
        // Nothing to revert here — this one only marks read on success.
        toast.error(callFailed('notification mark-all-read', err))
      }
    })
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-white p-8 text-center text-slate-500">
        Nothing yet. Handoffs, approvals and task reminders will show up here.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          {unread === 0 ? 'All caught up.' : `${unread} unread`}
        </p>
        <Button variant="outline" size="sm" onClick={markAll} disabled={pending || unread === 0}>
          Mark all read
        </Button>
      </div>

      <ul className="divide-y rounded-md border bg-white">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => open(row)}
              className={cn(
                'flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-slate-50',
                !isRead(row) && 'bg-sky-50/60',
              )}
            >
              <span
                aria-hidden
                className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  isRead(row) ? 'bg-transparent' : 'bg-sky-500')}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={cn('text-sm', !isRead(row) && 'font-semibold')}>
                    {row.title}
                  </span>
                  <Badge variant="secondary" className="text-xs">{row.categoryLabel}</Badge>
                  {!isRead(row) && <span className="sr-only">unread</span>}
                </span>
                {row.body && (
                  <span className="mt-1 block text-sm text-slate-600">{row.body}</span>
                )}
                <span className="mt-1 block text-xs text-slate-400">{row.age}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-right text-sm">
        <Link href="/notifications/preferences" className="text-slate-500 underline">
          Notification preferences
        </Link>
      </p>
    </div>
  )
}
