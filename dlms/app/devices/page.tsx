import { Suspense } from 'react'
import { DeviceTable } from '@/components/device/DeviceTable'
import { listDevices, getDistinctCustomers, getExpiringWarrantyCount } from '@/lib/services/deviceService'
import { getStatuses, getPhases } from '@/lib/services/vocabularyService'
import { requireAuth } from '@/lib/auth/session'
import type { Role } from '@/lib/types'
import { WarrantyBanner } from '@/components/device/WarrantyBanner'

interface PageProps {
  searchParams: {
    q?: string; status?: string; phase?: string; customer?: string; model?: string
    buildFrom?: string; buildTo?: string; shipFrom?: string; shipTo?: string; page?: string
    sort?: string; dir?: string; batchCreated?: string
  }
}

export default async function DevicesPage({ searchParams }: PageProps) {
  const user = await requireAuth()
  const page = Number(searchParams.page ?? '1')
  const pageSize = 50

  const [{ rows, total }, statuses, phases, customers, expiringCount] = await Promise.all([
    listDevices({
      search: searchParams.q,
      status: searchParams.status,
      phase: searchParams.phase,
      customer: searchParams.customer,
      model: searchParams.model,
      buildDateFrom: searchParams.buildFrom,
      buildDateTo: searchParams.buildTo,
      shipDateFrom: searchParams.shipFrom,
      shipDateTo: searchParams.shipTo,
      sort: searchParams.sort,
      dir: searchParams.dir,
      page,
      pageSize,
    }),
    getStatuses(),
    getPhases(),
    getDistinctCustomers(),
    getExpiringWarrantyCount(),
  ])

  const batchCreated = searchParams.batchCreated ? Number(searchParams.batchCreated) : null

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Devices</h1>
      {batchCreated && batchCreated > 1 && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
          {batchCreated} devices created successfully.
        </div>
      )}
      <WarrantyBanner count={expiringCount} />
      <DeviceTable
        devices={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        statuses={statuses}
        phases={phases}
        customers={customers}
        userRole={(user?.role ?? 'viewer') as Role}
        initialSearch={searchParams.q}
        initialStatus={searchParams.status}
        initialPhase={searchParams.phase}
        initialCustomer={searchParams.customer}
      />
    </div>
  )
}
