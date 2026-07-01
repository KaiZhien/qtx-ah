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
    // Component-revision filters (traceability drill-through)
    pcba_a_hw_rev?: string; pcba_a_bom_rev?: string; pcba_a_fw_ver?: string
    pcba_b_hw_rev?: string; pcba_b_bom_rev?: string; pcba_b_fw_ver?: string
    screen_model?: string;  hmi_ver?: string
    myQueue?: string
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
      pcba_a_hw_rev: searchParams.pcba_a_hw_rev,
      pcba_a_bom_rev: searchParams.pcba_a_bom_rev,
      pcba_a_fw_ver: searchParams.pcba_a_fw_ver,
      pcba_b_hw_rev: searchParams.pcba_b_hw_rev,
      pcba_b_bom_rev: searchParams.pcba_b_bom_rev,
      pcba_b_fw_ver: searchParams.pcba_b_fw_ver,
      screen_model: searchParams.screen_model,
      hmi_ver: searchParams.hmi_ver,
      sort: searchParams.sort,
      dir: searchParams.dir,
      myQueueUserId: searchParams.myQueue === '1' ? user.id : undefined,
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
