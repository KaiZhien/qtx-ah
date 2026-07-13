import Link from 'next/link'
import { requirePermission } from '@/lib/auth/session'
import { getAuditLog } from '@/lib/services/auditService'
import { ACTIONS } from '@/lib/auth/permissions'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const PAGE_SIZE = 50

interface PageProps {
  searchParams: { page?: string; action?: string; table?: string }
}

export default async function AuditLogPage({ searchParams }: PageProps) {
  await requirePermission(ACTIONS.VIEW_FULL_AUDIT_LOG)
  // Parse defensively: a missing / non-numeric / <1 page falls back to 1 so a
  // negative range never reaches PostgREST.
  const parsed = Math.floor(Number(searchParams.page))
  const requestedPage = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
  const { rows, total } = await getAuditLog({
    actionFilter: searchParams.action,
    tableFilter: searchParams.table,
    page: requestedPage,
    pageSize: PAGE_SIZE,
  })

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // Clamp the displayed page so an out-of-range ?page= (empty table) still shows
  // a sane "Page X of Y" and working Prev/Next links.
  const currentPage = Math.min(requestedPage, totalPages)

  // Preserve the active ?action / ?table filters when paging.
  const hrefForPage = (p: number) => {
    const params = new URLSearchParams()
    if (searchParams.action) params.set('action', searchParams.action)
    if (searchParams.table) params.set('table', searchParams.table)
    params.set('page', String(p))
    return `/admin/audit?${params.toString()}`
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Audit Log</h1>
      <p className="text-sm text-muted-foreground">{total} total entries (append-only)</p>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Table</TableHead>
              <TableHead>Row ID</TableHead>
              <TableHead>Changed Fields</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-xs tabular-nums">{new Date(entry.occurred_at).toLocaleString()}</TableCell>
                <TableCell className="text-xs">{entry.actor_email ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={entry.action === 'soft_delete' ? 'destructive' : entry.action === 'insert' ? 'success' : 'outline'} className="text-xs">
                    {entry.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs font-mono">{entry.table_name}</TableCell>
                <TableCell className="text-xs font-mono">{entry.row_id ? `${entry.row_id.slice(0, 8)}…` : '—'}</TableCell>
                <TableCell className="text-xs">{entry.changed_columns.join(', ') || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>Page {currentPage} of {totalPages} ({total} entries)</span>
        <div className="flex items-center gap-2">
          {currentPage > 1 ? (
            <Button asChild variant="outline" size="icon">
              <Link href={hrefForPage(currentPage - 1)} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="icon" disabled aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          {currentPage < totalPages ? (
            <Button asChild variant="outline" size="icon">
              <Link href={hrefForPage(currentPage + 1)} aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="icon" disabled aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
