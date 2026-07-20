import { z } from 'zod'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

/**
 * Engineering read paths (spec §4/§8): ECR, ECO, and firmware-release lists +
 * detail, plus the vocab pickers the forms need and the landing counts. Every
 * entry point calls authorize(view_records, 'engineering') first; detail
 * getters return null for unknown/soft-deleted ids so the page can 404 without
 * a thrown path (spec §7.3 — a denial or a miss must not confirm existence).
 *
 * Lists use keyset pagination on (created_at DESC, id DESC) — the same reason
 * as listDevices: OFFSET drifts as rows are inserted mid-session.
 */

export type VocabOption = { code: string; label: string }
export type EngStatusCount = { status: string; count: number }

// ── shared keyset cursor (created_at, id) ───────────────────────────────────
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url')
}
function decodeCursor(cursor: string): [Date, string] {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|')
  return [new Date(ts), id]
}
// Escape LIKE metacharacters so a needle containing %/_ can't act as a wildcard.
function likeNeedle(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

// ═══════════════════════════ ECR ═══════════════════════════════════════════
export type EcrListItem = {
  id: string; ecrNo: string; title: string; status: string
  priority: string; variantName: string | null; createdAt: Date
}
export type EcrDetail = EcrListItem & {
  description: string | null; reason: string | null
  deviceId: string | null; deviceLabel: string | null
  variantId: string | null; version: number
  createdByName: string; updatedAt: Date
}

const ecrFilterSchema = z.object({
  q: z.string().max(100).optional(),
  status: z.array(z.string()).optional(),
  priority: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type EcrFilter = z.input<typeof ecrFilterSchema>

export async function listEcrs(
  actor: Actor, filter: EcrFilter = {},
): Promise<{ items: EcrListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'engineering')
  const f = ecrFilterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['e.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.q) {
      const needle = p(likeNeedle(f.q))
      conditions.push(`(lower(e.ecr_no) LIKE ${needle} ESCAPE '\\' OR lower(e.title) LIKE ${needle} ESCAPE '\\')`)
    }
    if (f.status?.length) conditions.push(`e.status = ANY(${p(f.status)})`)
    if (f.priority?.length) conditions.push(`e.priority = ANY(${p(f.priority)})`)
    if (f.cursor) {
      const [ts, id] = decodeCursor(f.cursor)
      conditions.push(`(e.created_at, e.id) < (${p(ts)}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; ecr_no: string; title: string; status: string
      priority: string; variant_name: string | null; created_at: Date
    }>(
      `SELECT e.id, e.ecr_no, e.title, e.status, e.priority, v.name AS variant_name, e.created_at
         FROM ecr e
         LEFT JOIN device_variant v ON v.id = e.variant_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]
    return {
      items: page.map((r) => ({
        id: r.id, ecrNo: r.ecr_no, title: r.title, status: r.status,
        priority: r.priority, variantName: r.variant_name, createdAt: r.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    }
  })
}

export async function getEcr(actor: Actor, id: string): Promise<EcrDetail | null> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; ecr_no: string; title: string; status: string; priority: string
      description: string | null; reason: string | null
      device_id: string | null; device_sn: string | null; device_legacy: string | null
      variant_id: string | null; variant_name: string | null; version: number
      created_by_name: string; created_at: Date; updated_at: Date
    }>(
      `SELECT e.id, e.ecr_no, e.title, e.status, e.priority, e.description, e.reason,
              e.device_id, d.device_sn, d.pcba_a_sn_legacy AS device_legacy,
              e.variant_id, v.name AS variant_name, e.version,
              u.full_name AS created_by_name, e.created_at, e.updated_at
         FROM ecr e
         LEFT JOIN device d ON d.id = e.device_id
         LEFT JOIN device_variant v ON v.id = e.variant_id
         JOIN app_user u ON u.id = e.created_by
        WHERE e.id = $1 AND e.deleted_at IS NULL`, [id])
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id, ecrNo: r.ecr_no, title: r.title, status: r.status, priority: r.priority,
      description: r.description, reason: r.reason, deviceId: r.device_id,
      deviceLabel: r.device_sn ?? r.device_legacy, variantId: r.variant_id,
      variantName: r.variant_name, version: r.version, createdByName: r.created_by_name,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }
  })
}

// ═══════════════════════════ ECO ═══════════════════════════════════════════
export type EcoListItem = {
  id: string; ecoNo: string; title: string; status: string
  ecrNo: string | null; createdAt: Date
}
export type EcoDetail = EcoListItem & {
  description: string | null; ecrId: string | null
  effectivityDate: Date | null; effectivitySerial: string | null; effectivityNotes: string | null
  version: number; createdByName: string; updatedAt: Date
}

const ecoFilterSchema = z.object({
  q: z.string().max(100).optional(),
  status: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type EcoFilter = z.input<typeof ecoFilterSchema>

export async function listEcos(
  actor: Actor, filter: EcoFilter = {},
): Promise<{ items: EcoListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'engineering')
  const f = ecoFilterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['o.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.q) {
      const needle = p(likeNeedle(f.q))
      conditions.push(`(lower(o.eco_no) LIKE ${needle} ESCAPE '\\' OR lower(o.title) LIKE ${needle} ESCAPE '\\')`)
    }
    if (f.status?.length) conditions.push(`o.status = ANY(${p(f.status)})`)
    if (f.cursor) {
      const [ts, id] = decodeCursor(f.cursor)
      conditions.push(`(o.created_at, o.id) < (${p(ts)}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; eco_no: string; title: string; status: string
      ecr_no: string | null; created_at: Date
    }>(
      `SELECT o.id, o.eco_no, o.title, o.status, e.ecr_no, o.created_at
         FROM eco o
         LEFT JOIN ecr e ON e.id = o.ecr_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]
    return {
      items: page.map((r) => ({
        id: r.id, ecoNo: r.eco_no, title: r.title, status: r.status,
        ecrNo: r.ecr_no, createdAt: r.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    }
  })
}

export async function getEco(actor: Actor, id: string): Promise<EcoDetail | null> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; eco_no: string; title: string; status: string
      description: string | null; ecr_id: string | null; ecr_no: string | null
      effectivity_date: Date | null; effectivity_serial: string | null; effectivity_notes: string | null
      version: number; created_by_name: string; created_at: Date; updated_at: Date
    }>(
      `SELECT o.id, o.eco_no, o.title, o.status, o.description, o.ecr_id, e.ecr_no,
              o.effectivity_date, o.effectivity_serial, o.effectivity_notes, o.version,
              u.full_name AS created_by_name, o.created_at, o.updated_at
         FROM eco o
         LEFT JOIN ecr e ON e.id = o.ecr_id
         JOIN app_user u ON u.id = o.created_by
        WHERE o.id = $1 AND o.deleted_at IS NULL`, [id])
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id, ecoNo: r.eco_no, title: r.title, status: r.status, description: r.description,
      ecrId: r.ecr_id, ecrNo: r.ecr_no, effectivityDate: r.effectivity_date,
      effectivitySerial: r.effectivity_serial, effectivityNotes: r.effectivity_notes,
      version: r.version, createdByName: r.created_by_name,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }
  })
}

// ══════════════════════ Firmware releases ══════════════════════════════════
export type FirmwareListItem = {
  id: string; fwVersion: string; status: string
  componentTypeName: string; componentTypeCode: string
  releaseDate: Date | null; createdAt: Date
}
export type FirmwareDetail = FirmwareListItem & {
  componentTypeId: string; changelog: string | null
  version: number; createdByName: string; updatedAt: Date
}

const firmwareFilterSchema = z.object({
  q: z.string().max(100).optional(),
  status: z.array(z.string()).optional(),
  componentTypeId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type FirmwareFilter = z.input<typeof firmwareFilterSchema>

export async function listFirmwareReleases(
  actor: Actor, filter: FirmwareFilter = {},
): Promise<{ items: FirmwareListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'engineering')
  const f = firmwareFilterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['fr.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.q) {
      const needle = p(likeNeedle(f.q))
      conditions.push(`(lower(fr.fw_version) LIKE ${needle} ESCAPE '\\' OR lower(ct.name) LIKE ${needle} ESCAPE '\\')`)
    }
    if (f.status?.length) conditions.push(`fr.status = ANY(${p(f.status)})`)
    if (f.componentTypeId) conditions.push(`fr.component_type_id = ${p(f.componentTypeId)}`)
    if (f.cursor) {
      const [ts, id] = decodeCursor(f.cursor)
      conditions.push(`(fr.created_at, fr.id) < (${p(ts)}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; fw_version: string; status: string; component_type_name: string
      component_type_code: string; release_date: Date | null; created_at: Date
    }>(
      `SELECT fr.id, fr.fw_version, fr.status, ct.name AS component_type_name,
              ct.code AS component_type_code, fr.release_date, fr.created_at
         FROM firmware_release fr
         JOIN component_type ct ON ct.id = fr.component_type_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY fr.created_at DESC, fr.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]
    return {
      items: page.map((r) => ({
        id: r.id, fwVersion: r.fw_version, status: r.status,
        componentTypeName: r.component_type_name, componentTypeCode: r.component_type_code,
        releaseDate: r.release_date, createdAt: r.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    }
  })
}

export async function getFirmwareRelease(actor: Actor, id: string): Promise<FirmwareDetail | null> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; fw_version: string; status: string; component_type_id: string
      component_type_name: string; component_type_code: string; changelog: string | null
      release_date: Date | null; version: number; created_by_name: string
      created_at: Date; updated_at: Date
    }>(
      `SELECT fr.id, fr.fw_version, fr.status, fr.component_type_id, ct.name AS component_type_name,
              ct.code AS component_type_code, fr.changelog, fr.release_date, fr.version,
              u.full_name AS created_by_name, fr.created_at, fr.updated_at
         FROM firmware_release fr
         JOIN component_type ct ON ct.id = fr.component_type_id
         JOIN app_user u ON u.id = fr.created_by
        WHERE fr.id = $1 AND fr.deleted_at IS NULL`, [id])
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id, fwVersion: r.fw_version, status: r.status, componentTypeId: r.component_type_id,
      componentTypeName: r.component_type_name, componentTypeCode: r.component_type_code,
      changelog: r.changelog, releaseDate: r.release_date, version: r.version,
      createdByName: r.created_by_name, createdAt: r.created_at, updatedAt: r.updated_at,
    }
  })
}

// ══════════════════════ Vocab pickers & landing counts ═════════════════════

/** Active component types (id + label) for the firmware create/edit form. */
export async function listComponentTypeOptions(
  actor: Actor,
): Promise<{ id: string; label: string }[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; name: string; code: string }>(
      `SELECT id, name, code FROM component_type
        WHERE deleted_at IS NULL AND active ORDER BY sort, name`)
    return rows.map((r) => ({ id: r.id, label: `${r.name} (${r.code})` }))
  })
}

/** Active device variants for the ECR create/edit form. */
export async function listVariantOptions(actor: Actor): Promise<{ id: string; label: string }[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM device_variant WHERE active ORDER BY name`)
    return rows.map((r) => ({ id: r.id, label: r.name }))
  })
}

/** Open ECRs (id + no + title) for the ECO create form's "realises" picker. */
export async function listOpenEcrOptions(
  actor: Actor,
): Promise<{ id: string; label: string }[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; ecr_no: string; title: string }>(
      `SELECT id, ecr_no, title FROM ecr
        WHERE deleted_at IS NULL AND status IN ('submitted','accepted')
        ORDER BY created_at DESC LIMIT 100`)
    return rows.map((r) => ({ id: r.id, label: `${r.ecr_no} — ${r.title}` }))
  })
}

export type EngineeringCounts = {
  ecr: EngStatusCount[]; eco: EngStatusCount[]; firmware: EngStatusCount[]
}

/** Status counts for each entity, one grouped query apiece (landing widgets). */
export async function getEngineeringCounts(actor: Actor): Promise<EngineeringCounts> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const grouped = async (table: string) => {
      const { rows } = await tx.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM ${table}
          WHERE deleted_at IS NULL GROUP BY status`)
      return rows.map((r) => ({ status: r.status, count: Number(r.count) }))
    }
    return { ecr: await grouped('ecr'), eco: await grouped('eco'), firmware: await grouped('firmware_release') }
  })
}
