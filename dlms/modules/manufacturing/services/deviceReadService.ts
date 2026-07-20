import { z } from 'zod'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

export type DeviceListItem = {
  id: string
  deviceSn: string | null
  legacySn: string | null
  variantCode: string
  variantName: string
  status: string
  statusLabel: string
  productName: string | null
  customer: string | null
  buildDate: Date | null
  needsDataReview: boolean
}

export type DeviceDetail = DeviceListItem & {
  modelNo: string | null
  destination: string | null
  phase: string | null
  remarks: string | null
  shipDate: Date | null
  deliveredDate: Date | null
  version: number
  statusHistory: {
    fromStatus: string | null; toStatus: string; reason: string | null
    changedByName: string; changedAt: Date
  }[]
}

const filterSchema = z.object({
  q: z.string().max(100).optional(),
  status: z.array(z.string()).optional(),
  variant: z.array(z.string()).optional(),
  needsReview: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type DeviceFilter = z.input<typeof filterSchema>

/**
 * The device registry list (spec §10).
 *
 * Search hits the normalized column with a trigram index, so "00412" finds
 * "QTX-P-00412" — people search by the fragment they remember, not the whole
 * string. Legacy rows whose identity lives in pcba_a_sn_legacy (ranges like
 * "EE-02A-2603-0001 to 0015") are searchable by the same query.
 *
 * Keyset pagination on (created_at, id): OFFSET would drift as devices are added
 * during a session, silently skipping or repeating rows.
 */
export async function listDevices(
  actor: Actor, filter: DeviceFilter,
): Promise<{ items: DeviceListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'manufacturing')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['d.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.q) {
      // Strip whitespace/hyphens (matches device_sn_normalized's trigger-side
      // normalization) then escape LIKE metacharacters (%, _, and the escape
      // char itself) so a serial containing them can't act as a wildcard.
      const stripped = f.q.toLowerCase().replace(/[\s-]/g, '')
      const escaped = stripped.replace(/[\\%_]/g, (c) => `\\${c}`)
      const needle = p(`%${escaped}%`)
      conditions.push(`(d.device_sn_normalized LIKE ${needle} ESCAPE '\\'
                     OR lower(translate(coalesce(d.pcba_a_sn_legacy, ''), ' -', '')) LIKE ${needle} ESCAPE '\\')`)
    }
    if (f.status?.length) conditions.push(`d.status = ANY(${p(f.status)})`)
    if (f.variant?.length) conditions.push(`v.code = ANY(${p(f.variant)})`)
    if (f.needsReview !== undefined) conditions.push(`d.needs_data_review = ${p(f.needsReview)}`)
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(d.created_at, d.id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; device_sn: string | null; pcba_a_sn_legacy: string | null
      variant_code: string; variant_name: string; status: string; status_label: string
      product_name: string | null; customer: string | null; build_date: Date | null
      needs_data_review: boolean; created_at: Date
    }>(
      `SELECT d.id, d.device_sn, d.pcba_a_sn_legacy, v.code AS variant_code, v.name AS variant_name,
              d.status, s.label_en AS status_label, d.product_name, d.customer, d.build_date,
              d.needs_data_review, d.created_at
         FROM device d
         JOIN device_variant v ON v.id = d.variant_id
         JOIN status_option s ON s.code = d.status
        WHERE ${conditions.join(' AND ')}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((r) => ({
        id: r.id, deviceSn: r.device_sn, legacySn: r.pcba_a_sn_legacy,
        variantCode: r.variant_code, variantName: r.variant_name,
        status: r.status, statusLabel: r.status_label, productName: r.product_name,
        customer: r.customer, buildDate: r.build_date, needsDataReview: r.needs_data_review,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

/** Returns null for unknown ids so the page can 404 without a thrown error path. */
export async function getDevice(actor: Actor, deviceId: string): Promise<DeviceDetail | null> {
  authorize(actor, 'view_records', 'manufacturing')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; device_sn: string | null; pcba_a_sn_legacy: string | null
      variant_code: string; variant_name: string; status: string; status_label: string
      product_name: string | null; model_no: string | null; customer: string | null
      destination: string | null; phase: string | null; remarks: string | null
      build_date: Date | null; ship_date: Date | null; delivered_date: Date | null
      needs_data_review: boolean; version: number
    }>(
      `SELECT d.id, d.device_sn, d.pcba_a_sn_legacy, v.code AS variant_code, v.name AS variant_name,
              d.status, s.label_en AS status_label, d.product_name, d.model_no, d.customer,
              d.destination, d.phase, d.remarks, d.build_date, d.ship_date, d.delivered_date,
              d.needs_data_review, d.version
         FROM device d
         JOIN device_variant v ON v.id = d.variant_id
         JOIN status_option s ON s.code = d.status
        WHERE d.id = $1 AND d.deleted_at IS NULL`, [deviceId])
    const r = rows[0]
    if (!r) return null

    const history = await tx.query<{
      from_status: string | null; to_status: string; reason: string | null
      changed_by_name: string; changed_at: Date
    }>(
      `SELECT h.from_status, h.to_status, h.reason, u.full_name AS changed_by_name, h.changed_at
         FROM device_status_history h JOIN app_user u ON u.id = h.changed_by
        WHERE h.device_id = $1 ORDER BY h.changed_at DESC`, [deviceId])

    return {
      id: r.id, deviceSn: r.device_sn, legacySn: r.pcba_a_sn_legacy,
      variantCode: r.variant_code, variantName: r.variant_name,
      status: r.status, statusLabel: r.status_label, productName: r.product_name,
      modelNo: r.model_no, customer: r.customer, destination: r.destination,
      phase: r.phase, remarks: r.remarks, buildDate: r.build_date, shipDate: r.ship_date,
      deliveredDate: r.delivered_date, needsDataReview: r.needs_data_review, version: r.version,
      statusHistory: history.rows.map((h) => ({
        fromStatus: h.from_status, toStatus: h.to_status, reason: h.reason,
        changedByName: h.changed_by_name, changedAt: h.changed_at,
      })),
    }
  })
}

export type DeviceStatusCount = { status: string; statusLabel: string; count: number }

/**
 * One grouped query behind the Manufacturing landing page's device-counts-by-
 * status widget (spec §8.5). Ordered by the vocabulary's own sort_order so the
 * widget reads left-to-right in lifecycle order, not alphabetically.
 */
export async function getDeviceStatusCounts(actor: Actor): Promise<DeviceStatusCount[]> {
  authorize(actor, 'view_records', 'manufacturing')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: string; status_label: string; count: string }>(
      `SELECT s.code AS status, s.label_en AS status_label, count(d.id)::text AS count
         FROM status_option s
         LEFT JOIN device d ON d.status = s.code AND d.deleted_at IS NULL
        GROUP BY s.code, s.label_en, s.sort_order
        ORDER BY s.sort_order`)
    return rows.map((r) => ({ status: r.status, statusLabel: r.status_label, count: Number(r.count) }))
  })
}

export type VocabOption = { code: string; label: string }

/** Active status codes for the filter bar and any other status picker. */
export async function listStatusOptions(actor: Actor): Promise<VocabOption[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ code: string; label_en: string }>(
      `SELECT code, label_en FROM status_option WHERE active ORDER BY sort_order`)
    return rows.map((r) => ({ code: r.code, label: r.label_en }))
  })
}

/** Active variant codes for the filter bar. */
export async function listVariantOptions(actor: Actor): Promise<VocabOption[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ code: string; name: string }>(
      `SELECT code, name FROM device_variant WHERE active ORDER BY name`)
    return rows.map((r) => ({ code: r.code, label: r.name }))
  })
}

/** Active phase codes for the create/edit forms (legacy manufacturing phase). */
export async function listPhaseOptions(actor: Actor): Promise<VocabOption[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ code: string; label_en: string }>(
      `SELECT code, label_en FROM phase_option WHERE active ORDER BY sort_order`)
    return rows.map((r) => ({ code: r.code, label: r.label_en }))
  })
}
