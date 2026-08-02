'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { setNotificationPreferenceAction } from '@/app/(platform)/notifications/actions'

export type PreferenceRowView = {
  category: string
  title: string
  hint: string
  inApp: boolean
  email: boolean
  digest: boolean
}

type Channel = 'inApp' | 'email' | 'digest'

/**
 * The per-user preferences screen (spec §6.3).
 *
 * SAVES ON TOGGLE, with no Save button. There is nothing to batch — each row is
 * independent, each write is a single upsert — and a Save button on a screen of switches is
 * the classic way to lose a change someone believed they had made. A failed write reverts
 * the switch and says why, so the control always shows what is actually stored.
 *
 * The three channels are independent by design (see notification_pref's column comments):
 * turning the bell off does not silence email, because they answer different questions.
 * `digest` suppresses the immediate email — the resolver honours that from day one even
 * though no digest job consumes it yet, which is why the hint below says "later" rather
 * than promising a schedule.
 */
export function PreferenceTable({ rows }: { rows: PreferenceRowView[] }) {
  const [state, setState] = useState(rows)
  const [pending, startTransition] = useTransition()

  const toggle = (category: string, channel: Channel) => {
    const current = state.find((r) => r.category === category)
    if (!current) return
    const next = { ...current, [channel]: !current[channel] }

    setState((prev) => prev.map((r) => (r.category === category ? next : r)))

    startTransition(async () => {
      const result = await setNotificationPreferenceAction({
        category: next.category, inApp: next.inApp, email: next.email, digest: next.digest,
      })
      if (!result.ok) {
        // Revert: a switch that shows a setting the server rejected is a lie the user will
        // act on.
        setState((prev) => prev.map((r) => (r.category === category ? current : r)))
        toast.error(result.error)
      }
    })
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Notify me about</TableHead>
          <TableHead className="w-24 text-center">In app</TableHead>
          <TableHead className="w-24 text-center">Email</TableHead>
          <TableHead className="w-28 text-center">Digest</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.map((row) => (
          <TableRow key={row.category}>
            <TableCell>
              <div className="font-medium text-slate-900">{row.title}</div>
              <div className="text-sm text-slate-500">{row.hint}</div>
            </TableCell>
            {(['inApp', 'email', 'digest'] as Channel[]).map((channel) => (
              <TableCell key={channel} className="text-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-slate-900"
                  checked={row[channel]}
                  disabled={pending}
                  onChange={() => toggle(row.category, channel)}
                  aria-label={`${channel} notifications for ${row.title}`}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
