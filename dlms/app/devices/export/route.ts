import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import { listDevices } from '@/lib/services/deviceService'
import { CSV_EXPORT_HEADERS } from '@/lib/i18n/fields'

function csvCell(val: unknown): string {
  if (val === null || val === undefined) return ''
  const s = String(val)
  // Quote if contains comma, double-quote, newline, or carriage return (RFC 4180)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replaceAll('"', '""') + '"'
  }
  return s
}

export async function GET(req: NextRequest) {
  try {
    await requirePermission(ACTIONS.EXPORT_DATA)

    const { searchParams } = req.nextUrl
    const status = searchParams.get('status') ?? undefined
    const phase = searchParams.get('phase') ?? undefined
    const search = searchParams.get('search') ?? undefined
    const customer = searchParams.get('customer') ?? undefined

    const { rows } = await listDevices({ status, phase, search, customer, pageSize: 10000 })

    // Build CSV using the same logic as exportDevicesAction
    const headers = Object.values(CSV_EXPORT_HEADERS)
    const keys = Object.keys(CSV_EXPORT_HEADERS) as (keyof typeof CSV_EXPORT_HEADERS)[]

    const csvRows = rows.map(row =>
      keys
        .map(k => {
          const val = (row as Record<string, unknown>)[k]
          return csvCell(val)
        })
        .join(',')
    )

    const csv = [headers.join(','), ...csvRows].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="devices-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
