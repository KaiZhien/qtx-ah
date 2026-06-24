import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { createAdminClient } from '@/lib/supabase/server'
import { FIELD_LABELS } from '@/lib/i18n/fields'
import type { Role, DeviceRow } from '@/lib/types'

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.EXPORT_DATA)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const ids = searchParams.get('ids')?.split(',').filter(Boolean) ?? []
  const q = searchParams.get('q') ?? ''
  const status = searchParams.get('status') ?? ''
  const phase = searchParams.get('phase') ?? ''
  const customer = searchParams.get('customer') ?? ''

  const supabase = createAdminClient()
  let query = supabase.from('device').select('*').is('deleted_at', null)

  if (ids.length > 0) {
    // Export only selected IDs — ignore other filters
    query = query.in('id', ids)
  } else {
    // Apply regular filters
    if (q) {
      const raw = q.trim()
      if (/^[A-Za-z0-9\-_ ~]+$/.test(raw)) {
        const term = raw.toUpperCase()
        query = query.or([
          `pcba_a_sn_normalized.ilike.%${term}%`,
          `pcba_b_sn_normalized.ilike.%${term}%`,
          `device_sn_normalized.ilike.%${term}%`,
          `customer.ilike.%${term}%`,
          `product_name.ilike.%${term}%`,
          `model_no.ilike.%${term}%`,
          `screen_model.ilike.%${term}%`,
          `destination.ilike.%${term}%`,
        ].join(','))
      }
    }
    if (status) query = query.eq('status', status)
    if (phase) query = query.eq('phase', phase)
    if (customer) query = query.ilike('customer', `%${customer}%`)
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(10000)
  if (error) {
    return new NextResponse('Export failed', { status: 500 })
  }

  const rows = (data ?? []) as DeviceRow[]
  const headers = Object.keys(FIELD_LABELS).join(',')
  const csvRows = rows.map((d) =>
    Object.keys(FIELD_LABELS)
      .map((k) => {
        const v = (d as Record<string, unknown>)[k]
        if (v == null) return ''
        const str = String(v)
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str
      })
      .join(',')
  )
  const csv = [headers, ...csvRows].join('\n')

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="devices-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
