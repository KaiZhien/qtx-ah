import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import {
  getOverviewMetrics,
  getThroughputSeries,
  getStatusDurations,
  getTransitionFunnel,
  getEngineerActivity,
} from '@/lib/services/analyticsService'
import { listDevices } from '@/lib/services/deviceService'
import type { AnalyticsRange } from '@/lib/types'
import { generateExcel } from '@/lib/export/excel'
import { renderAnalyticsPdf } from '@/lib/export/pdf'

export async function GET(req: NextRequest) {
  const user = await requirePermission(ACTIONS.EXPORT_DATA)

  const { searchParams } = req.nextUrl
  const format = searchParams.get('format') ?? 'xlsx'
  const rangeParam = searchParams.get('range') ?? '30d'
  const range = (['7d', '30d', '90d'].includes(rangeParam) ? rangeParam : '30d') as AnalyticsRange

  const [overview, throughput, durations, transitions, engineerActivity, { rows: devices }] =
    await Promise.all([
      getOverviewMetrics(),
      getThroughputSeries(range),
      getStatusDurations(),
      getTransitionFunnel(),
      user.role === 'admin' ? getEngineerActivity(range) : Promise.resolve([]),
      listDevices({ pageSize: 10000 }),
    ])

  if (format === 'pdf') {
    const buffer = await renderAnalyticsPdf({ overview, throughput, durations, transitions, range })
    const date = new Date().toISOString().split('T')[0]
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="dlms-analytics-${date}.pdf"`,
      },
    })
  }

  // Default: xlsx
  return generateExcel({ overview, throughput, durations, transitions, engineerActivity, devices })
}
