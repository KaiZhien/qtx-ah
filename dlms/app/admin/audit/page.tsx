import { requirePermission } from '@/lib/auth/session'
import { getAuditLog } from '@/lib/services/auditService'
import { ACTIONS } from '@/lib/auth/permissions'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

interface PageProps {
  searchParams: { page?: string; action?: string; table?: string }
}

export default async function AuditLogPage({ searchParams }: PageProps) {
  await requirePermission(ACTIONS.VIEW_FULL_AUDIT_LOG)
  const page = Number(searchParams.page ?? '1')
  const { rows, total } = await getAuditLog({
    actionFilter: searchParams.action,
    tableFilter: searchParams.table,
    page,
    pageSize: 50,
  })

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
    </div>
  )
}
