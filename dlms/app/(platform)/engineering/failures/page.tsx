import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listFailures } from '@/modules/engineering/services/failureService'
import { FailureStatusBadge, SeverityBadge } from '@/components/engineering/FailureBadges'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const PAGE_SIZE = 25

type PageProps = { searchParams: { q?: string } }

/**
 * Failure-investigation list (spec §6.3). 404-not-403 on a denial so the route
 * never confirms the section exists (spec §7.3). Search hits fi_no + title.
 */
export default async function FailureListPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const { items, nextCursor } = await listFailures(actor, {
    q: searchParams.q || undefined, limit: PAGE_SIZE,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Failure investigations</h1>
          <p className="mt-1 text-slate-600">
            Root-cause records (FI). Escalate to a change order when the fix is a design change.
          </p>
        </div>
        {can(actor, 'create_records', 'engineering') && (
          <Button asChild>
            <Link href="/engineering/failures/new">
              <Plus className="mr-1.5 h-4 w-4" />New investigation
            </Link>
          </Button>
        )}
      </div>

      <form className="flex gap-2">
        <Input
          name="q" defaultValue={searchParams.q ?? ''} className="max-w-sm"
          placeholder="Search by number or title…"
        />
        <Button type="submit" variant="outline">Search</Button>
      </form>

      {items.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          No failure investigations found.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>What failed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Root cause</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Escalated to</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-medium">
                    <Link href={`/engineering/failures/${f.id}`} className="hover:underline">
                      {f.fiNo}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/engineering/failures/${f.id}`} className="hover:underline">
                      {f.title}
                    </Link>
                  </TableCell>
                  <TableCell><FailureStatusBadge status={f.status} /></TableCell>
                  <TableCell><SeverityBadge severity={f.severity} /></TableCell>
                  <TableCell className="text-muted-foreground">{f.rootCauseName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{f.deviceLabel ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {f.ecoId && f.ecoNo
                      ? <Link href={`/engineering/eco/${f.ecoId}`} className="text-primary hover:underline">{f.ecoNo}</Link>
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {nextCursor && (
        <p className="text-xs text-muted-foreground">
          Showing the first {PAGE_SIZE}. Refine your search to narrow results.
        </p>
      )}
    </div>
  )
}
