import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listFirmwareReleases } from '@/modules/engineering/services/engineeringReadService'
import { EngStatusBadge } from '@/components/engineering/EngStatusBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const PAGE_SIZE = 25

type PageProps = { searchParams: { q?: string } }

const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

/** Firmware release list (spec §6.3). Search hits version + component type name. */
export default async function FirmwareListPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const { items, nextCursor } = await listFirmwareReleases(actor, {
    q: searchParams.q || undefined, limit: PAGE_SIZE,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Firmware releases</h1>
          <p className="mt-1 text-slate-600">Firmware builds by component type.</p>
        </div>
        {can(actor, 'create_records', 'engineering') && (
          <Button asChild>
            <Link href="/engineering/firmware/new"><Plus className="mr-1.5 h-4 w-4" />New release</Link>
          </Button>
        )}
      </div>

      <form className="flex gap-2">
        <Input name="q" defaultValue={searchParams.q ?? ''} placeholder="Search by version or component…" className="max-w-sm" />
        <Button type="submit" variant="outline">Search</Button>
      </form>

      {items.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          No firmware releases found.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Component type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Release date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    <Link href={`/engineering/firmware/${r.id}`} className="hover:underline">{r.fwVersion}</Link>
                  </TableCell>
                  <TableCell>{r.componentTypeName}</TableCell>
                  <TableCell><EngStatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-muted-foreground">{fmtDate(r.releaseDate)}</TableCell>
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
