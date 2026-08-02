import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listApprovals } from '@/modules/shared/approvals/services/approvalService'
import {
  approvalRecordHref, approvalAgeLabel,
} from '@/modules/shared/approvals/domain/approvalQueue'
import {
  approvalKindLabel, APPROVAL_STATUSES, type ApprovalStatus,
} from '@/modules/shared/approvals/domain/approvalDecision'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { ApprovalQueue, type ApprovalQueueRow } from '@/components/approvals/ApprovalQueue'
import { cn } from '@/lib/utils'

type PageProps = { searchParams: { show?: string; cursor?: string } }

const moduleLabel = (key: string) =>
  MODULE_REGISTRY.find((m) => m.key === key)?.label ?? key

/**
 * Renders one snapshot field for a human. Strings lose their JSON quotes because
 * a queue is not a debugger; everything else keeps its JSON form so `null`, `0`
 * and `false` stay distinguishable from the words "null", "0" and "false".
 */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserialisable value]'
  }
}

/** camelCase / snake_case → words, so `totalSgd` reads as "total sgd". */
function renderKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

/**
 * THE approvals queue (spec §6.3) — everything waiting on this actor, across every
 * module they can enter.
 *
 * 404, NOT 403 (spec §7.3): a denial must not confirm that the section exists.
 * `listApprovals` would already return `[]` for an actor without
 * `approve_requests` — it is a list surface, and "no rows" is both true and
 * non-disclosing — but an empty queue and a queue that is none of your business
 * are different answers, and only one of them should be reachable by URL.
 *
 * WORKS WITH NO SCHEDULER. This page reads the `approval` table directly through
 * `listApprovals`. The outbox event a request emits becomes a TASK in the
 * approver's task list only when the drain runs, and nothing schedules the drain
 * (RB-09) — but the queue itself is live the moment a request commits. The task is
 * a notification; this is the record.
 */
export default async function ApprovalsPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'approve_requests')) notFound()

  const showAll = searchParams.show === 'all'
  const status: ApprovalStatus[] = showAll ? [...APPROVAL_STATUSES] : ['pending']
  // Keyset-paged: "All" accumulates every decided row forever, and the previous
  // fixed cap silently truncated the decision trail rather than paging it.
  const { items: approvals, nextCursor } = await listApprovals(actor, {
    status, cursor: searchParams.cursor,
  })

  // One clock for the whole page, so two rows requested a second apart cannot
  // disagree about which of them is older.
  const now = new Date()

  const rows: ApprovalQueueRow[] = approvals.map((a) => ({
    id: a.id,
    kindLabel: approvalKindLabel(a.kind),
    moduleLabel: moduleLabel(a.module),
    status: a.status,
    recordLabel: a.label ?? `${a.entityType.replace(/_/g, ' ')} ${a.entityId.slice(0, 8)}`,
    href: approvalRecordHref(a.entityType, a.entityId),
    requestedByName: a.requestedByName ?? 'someone',
    age: approvalAgeLabel(a.requestedAt, now),
    snapshot: Object.entries(a.snapshot)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([key, value]) => ({ key: renderKey(key), value: renderValue(value) })),
    isOwnRequest: a.requestedBy === actor.id,
    decidedByName: a.decidedByName,
    decisionNote: a.decisionNote,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Approvals</h1>
        <p className="mt-1 text-slate-600">
          Requests waiting on a second pair of eyes, across every module you can enter.
          Nobody decides their own, and a decision is final.
        </p>
      </div>

      <nav className="flex gap-1 text-sm" aria-label="Filter approvals">
        <Tab href="/approvals" active={!showAll}>Pending</Tab>
        <Tab href="/approvals?show=all" active={showAll}>All</Tab>
      </nav>

      <ApprovalQueue rows={rows} showingDecided={showAll} />

      {/*
        Forward-only, because the cursor is keyset rather than an offset: there is
        no "page number" to go back to, and a Back link that guessed one would
        skip rows inserted since. The browser's own Back button returns to the
        previous page's URL, which still holds its cursor and is therefore exact.
      */}
      {nextCursor && (
        <nav className="flex justify-end" aria-label="More approvals">
          <Link
            href={`/approvals?${new URLSearchParams({
              ...(showAll ? { show: 'all' } : {}), cursor: nextCursor,
            })}`}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700
                       transition-colors hover:bg-slate-100"
          >
            Older requests →
          </Link>
        </nav>
      )}
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
