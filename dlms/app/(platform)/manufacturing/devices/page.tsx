import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  listDevices, listStatusOptions, listVariantOptions,
} from '@/modules/manufacturing/services/deviceReadService'
import { DeviceFilters } from '@/components/manufacturing/DeviceFilters'
import { DeviceTable } from '@/components/manufacturing/DeviceTable'
import { Button } from '@/components/ui/button'

const PAGE_SIZE = 25

type PageProps = {
  searchParams: { q?: string; status?: string; variant?: string; review?: string }
}

/**
 * The device registry list (spec §10). Filters live in the URL's search
 * params (same convention as /tasks), so every combination — search, status,
 * variant, needs-review — is a plain server-rendered fetch through
 * listDevices; there is no client-side device cache to keep in sync with
 * whatever the read service considers visible.
 */
export default async function DevicesPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'manufacturing')) notFound()

  const filter = {
    q: searchParams.q || undefined,
    status: searchParams.status ? searchParams.status.split(',').filter(Boolean) : undefined,
    variant: searchParams.variant ? searchParams.variant.split(',').filter(Boolean) : undefined,
    needsReview: searchParams.review === '1' ? true : undefined,
    limit: PAGE_SIZE,
  }

  const [{ items, nextCursor }, statusOptions, variantOptions] = await Promise.all([
    listDevices(actor, filter),
    listStatusOptions(actor),
    listVariantOptions(actor),
  ])

  // Forces DeviceTable to remount (and drop any accumulated "Load more" pages)
  // whenever the filters actually change, rather than keeping stale state from
  // a previous filter combination.
  const filterKey = `${searchParams.q ?? ''}|${searchParams.status ?? ''}|${searchParams.variant ?? ''}|${searchParams.review ?? ''}`

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Devices</h1>
          <p className="mt-1 text-slate-600">
            The full device registry — search by serial, filter, and open a record.
          </p>
        </div>
        {can(actor, 'create_records', 'manufacturing') && (
          <Button asChild>
            <Link href="/manufacturing/devices/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New device
            </Link>
          </Button>
        )}
      </div>
      <DeviceFilters statusOptions={statusOptions} variantOptions={variantOptions} />
      <DeviceTable key={filterKey} initialItems={items} initialCursor={nextCursor} filter={filter} />
    </div>
  )
}
