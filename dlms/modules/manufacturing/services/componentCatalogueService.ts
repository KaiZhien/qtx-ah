import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

export type ComponentTypeRow = {
  id: string; code: string; name: string
  trackingMode: 'serialized' | 'batch'; requiresFirmware: boolean
  active: boolean; sort: number; version: number
}

export async function listComponentTypes(
  actor: Actor, opts: { includeInactive?: boolean } = {},
): Promise<ComponentTypeRow[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; code: string; name: string; tracking_mode: 'serialized' | 'batch'
      requires_firmware: boolean; active: boolean; sort: number; version: number
    }>(
      `SELECT id, code, name, tracking_mode, requires_firmware, active, sort, version
         FROM component_type
        WHERE deleted_at IS NULL ${opts.includeInactive ? '' : 'AND active'}
        ORDER BY sort, name`)
    return rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, trackingMode: r.tracking_mode,
      requiresFirmware: r.requires_firmware, active: r.active, sort: r.sort, version: r.version,
    }))
  })
}

const createSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'lowercase letters, digits, underscore only'),
  name: z.string().min(1).max(200),
  trackingMode: z.enum(['serialized', 'batch']),
  requiresFirmware: z.boolean().default(false),
})

export async function createComponentType(
  actor: Actor, input: z.input<typeof createSchema>,
): Promise<{ id: string }> {
  authorize(actor, 'manage_vocabularies', 'manufacturing')
  const data = createSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO component_type (code, name, tracking_mode, requires_firmware, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
      [data.code, data.name, data.trackingMode, data.requiresFirmware, actor.id])
    return { id: rows[0].id }
  })
}

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  requiresFirmware: z.boolean().optional(),
  active: z.boolean().optional(),
  sort: z.number().int().optional(),
})

/**
 * tracking_mode is deliberately NOT updatable: existing component_installation
 * rows were shaped by it (serialized → unit, batch → batch_no), so flipping it
 * would retroactively invalidate history. A type that was created wrong is
 * deactivated and replaced, not mutated.
 */
export async function updateComponentType(
  actor: Actor, id: string, input: z.input<typeof updateSchema>, version: number,
): Promise<void> {
  authorize(actor, 'manage_vocabularies', 'manufacturing')
  const data = updateSchema.parse(input)
  await withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ version: number }>(
      `SELECT version FROM component_type WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])
    if (cur.rows.length === 0) throw new Error(`Component type ${id} not found`)
    if (cur.rows[0].version !== version) throw new OptimisticLockError('component_type', id)
    await tx.query(
      `UPDATE component_type SET
         name = COALESCE($1, name),
         requires_firmware = COALESCE($2, requires_firmware),
         active = COALESCE($3, active),
         sort = COALESCE($4, sort),
         updated_at = now(), updated_by = $5, version = version + 1
       WHERE id = $6`,
      [data.name ?? null, data.requiresFirmware ?? null, data.active ?? null,
       data.sort ?? null, actor.id, id])
  })
}
