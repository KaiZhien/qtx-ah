import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { CSV_EXPORT_HEADERS } from '@/lib/i18n/fields'
import type {
  OverviewMetrics,
  ThroughputPoint,
  StatusDuration,
  TransitionEdge,
  EngineerActivity,
  DeviceRow,
} from '@/lib/types'

interface GenerateExcelParams {
  overview: OverviewMetrics
  throughput: ThroughputPoint[]
  durations: StatusDuration[]
  transitions: TransitionEdge[]
  engineerActivity: EngineerActivity[]
  devices: DeviceRow[]
}

export async function generateExcel({
  overview,
  throughput,
  durations,
  transitions,
  engineerActivity,
  devices,
}: GenerateExcelParams): Promise<NextResponse> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'DLMS'
  wb.created = new Date()

  // Sheet 1: Overview KPIs
  const overviewSheet = wb.addWorksheet('Overview')
  overviewSheet.addRow(['Metric', 'Value'])
  overviewSheet.addRow(['Total Devices', overview.totalDevices])
  overviewSheet.addRow(['Total Units', overview.totalUnits])
  overviewSheet.addRow([])
  overviewSheet.addRow(['Status', 'Device Count', 'Unit Count'])
  overview.byStatus.forEach(s => overviewSheet.addRow([s.label_en, s.device_count, s.unit_count]))

  // Sheet 2: Throughput
  const throughputSheet = wb.addWorksheet('Throughput')
  throughputSheet.addRow(['Date', 'Devices Created', 'Devices Completed'])
  throughput.forEach(p => throughputSheet.addRow([p.day, p.devicesCreated, p.devicesCompleted]))

  // Sheet 3: Bottlenecks
  const bottleneckSheet = wb.addWorksheet('Bottlenecks')
  bottleneckSheet.addRow(['Status', 'Avg Days', 'Median Days', 'Sample Count'])
  durations.forEach(d =>
    bottleneckSheet.addRow([d.status, d.avgDays.toFixed(1), d.medianDays.toFixed(1), d.sampleCount])
  )

  // Sheet 4: Transitions
  const transSheet = wb.addWorksheet('Transitions')
  transSheet.addRow(['From Status', 'To Status', 'Count'])
  transitions.forEach(t => transSheet.addRow([t.fromStatus, t.toStatus, t.count]))

  // Sheet 5: Engineer Activity (only if data present)
  if (engineerActivity.length > 0) {
    const engSheet = wb.addWorksheet('Engineer Activity')
    engSheet.addRow(['Email', 'Changes', 'Distinct Devices'])
    engineerActivity.forEach(e =>
      engSheet.addRow([e.actorEmail, e.changeCount, e.distinctDevices])
    )
  }

  // Sheet 6: Raw Devices
  const devSheet = wb.addWorksheet('All Devices')
  const keys = Object.keys(CSV_EXPORT_HEADERS) as (keyof typeof CSV_EXPORT_HEADERS)[]
  const headers = Object.values(CSV_EXPORT_HEADERS)
  devSheet.addRow(headers)
  devices.forEach(row => {
    devSheet.addRow(
      keys.map(k => {
        const val = (row as Record<string, unknown>)[k]
        return val ?? ''
      })
    )
  })

  const buffer = await wb.xlsx.writeBuffer()
  const date = new Date().toISOString().split('T')[0]
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="dlms-analytics-${date}.xlsx"`,
    },
  })
}
