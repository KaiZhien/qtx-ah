import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listEcrs } from '@/modules/engineering/services/engineeringReadService'
import { EngStatusBadge, PriorityBadge } from '@/components/engineering/EngStatusBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const PAGE_SIZE = 25

type PageProps = { searchParams: { q?: string } }

/** ECR list (spec §4). Search hits ecr_no + title; keyset first page (basic). */
export default async function EcrListPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const { items, nextCursor } = await listEcrs(actor, {
    q: searchParams.q || undefined, limit: PAGE_SIZE,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Change requests</h1>
          <p className="mt-1 text-slate-600">Engineering change requests (ECR).</p>
        </div>
        {can(actor, 'create_records', 'engineering') && (
          <Button asChild>
            <Link href="/engineering/ecr/new"><Plus className="mr-1.5 h-4 w-4" />New request</Link>
          </Button>
        )}
      </div>

      <form className="flex gap-2">
        <Input name="q" defaultValue={searchParams.q ?? ''} placeholder="Search by number or title…" className="max-w-sm" />
        <Button type="submit" variant="outline">Search</Button>
      </form>

      {items.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          No change requests found.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Variant</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((e) => (
                <TableRow key={e.id} className="cursor-pointer">
                  <TableCell className="font-medium">
                    <Link href={`/engineering/ecr/${e.id}`} className="hover:underline">{e.ecrNo}</Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/engineering/ecr/${e.id}`} className="hover:underline">{e.title}</Link>
                  </TableCell>
                  <TableCell><PriorityBadge priority={e.priority} /></TableCell>
                  <TableCell><EngStatusBadge status={e.status} /></TableCell>
                  <TableCell className="text-muted-foreground">{e.variantName ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {nextCursor && (
        <p className="text-xs text-muted-foreground">Showing the first {PAGE_SIZE}. Refine your search to narrow results.</p>
      )}
    </div>
  )
}
