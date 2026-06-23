import { Suspense } from 'react'
import { DeviceTable } from '@/components/device/DeviceTable'
import { listDevices, getDistinctCustomers } from '@/lib/services/deviceService'
import { getStatuses, getPhases } from '@/lib/services/vocabularyService'
import { requireAuth } from '@/lib/auth/session'
import type { Role } from '@/lib/types'

interface PageProps {
  searchParams: {
    q?: string; status?: string; phase?: string; customer?: string; model?: string
    buildFrom?: string; buildTo?: string; shipFrom?: string; shipTo?: string; page?: string
    sort?: string; dir?: string
  }
}

export default async function DevicesPage({ searchParams }: PageProps) {
  const user = await requireAuth()
  const page = Number(searchParams.page ?? '1')
  const pageSize = 50

  const [{ rows, total }, statuses, phases, customers] = await Promise.all([
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
  ])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Devices</h1>
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
