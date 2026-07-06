'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createDevice, updateDevice, changeStatus, softDeleteDevice, getDevice, getDeviceByPcbaSn } from '@/lib/services/deviceService'
import { assignDevice, unassignDevice } from '@/lib/services/assignmentService'
import { addServiceEvent } from '@/lib/services/serviceEventService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { pairSerialRanges } from '@/lib/domain/serialRange'
import type { DeviceInput, Role } from '@/lib/types'

// Batch creation: expands serial ranges and creates one device per unit.
// Single unit falls through to the normal device detail page.
export async function createDeviceBatchAction(input: DeviceInput): Promise<never> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.CREATE_DEVICE)) throw new Error('Unauthorized')

  const result = pairSerialRanges(input.pcba_a_sn ?? '', input.pcba_b_sn ?? null)
  if ('error' in result) throw new Error(result.error)

  const { units } = result
  if (units.length === 0) throw new Error('No serial numbers provided')

  if (units.length === 1) {
    const device = await createDevice(
      { ...input, pcba_a_sn: units[0].pcba_a_sn, ...(units[0].pcba_b_sn != null ? { pcba_b_sn: units[0].pcba_b_sn } : {}), qty: 1 },
      user.id, user.role as Role
    )
    revalidatePath('/devices')
    redirect(`/devices/${device.id}`)
  }

  for (const unit of units) {
    await createDevice(
      { ...input, pcba_a_sn: unit.pcba_a_sn, ...(unit.pcba_b_sn != null ? { pcba_b_sn: unit.pcba_b_sn } : { pcba_b_sn: undefined }), qty: 1 },
      user.id, user.role as Role
    )
  }
  revalidatePath('/devices')
  redirect(`/devices?batchCreated=${units.length}`)
}

export async function updateDeviceAction(id: string, input: Partial<DeviceInput>, version: number) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.EDIT_DEVICE)) throw new Error('Unauthorized')
  const device = await updateDevice(id, input, version, user.id, user.role as Role)
  revalidatePath(`/devices/${id}`)
  return device
}

export async function softDeleteAction(id: string) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.SOFT_DELETE)) throw new Error('Unauthorized')
  await softDeleteDevice(id, user.id, user.role as Role)
  revalidatePath('/devices')
  redirect('/devices')
}

// Inline table create — does not redirect, returns the new row
export async function createDeviceRowAction(
  input: DeviceInput
): Promise<{ id: string } | { error: string; existingId?: string }> {
  try {
    const user = await getCurrentUser()
    if (!user || !can(user.role as Role, ACTIONS.CREATE_DEVICE)) return { error: 'Unauthorized' }

    // Duplicate detection: check for an existing device with the same PCBA-A S/N
    const existing = await getDeviceByPcbaSn(input.pcba_a_sn)
    if (existing) {
      return {
        error: `A device with PCBA-A S/N "${input.pcba_a_sn}" already exists`,
        existingId: existing.id,
      }
    }

    const device = await createDevice(input, user.id, user.role as Role)
    revalidatePath('/devices')
    return { id: device.id }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Save failed' }
  }
}

// Inline table update — does not redirect, returns ok or error
export async function updateDeviceRowAction(
  id: string, input: Partial<DeviceInput>, version: number
): Promise<{ ok: true } | { error: string }> {
  try {
    const user = await getCurrentUser()
    if (!user || !can(user.role as Role, ACTIONS.EDIT_DEVICE)) return { error: 'Unauthorized' }
    await updateDevice(id, input, version, user.id, user.role as Role)
    revalidatePath('/devices')
    return { ok: true }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Save failed' }
  }
}

export async function bulkChangeStatusAction(
  items: { id: string; version: number }[],
  status: string | null,
  phase: string | null
): Promise<{ ok: true; updated: number; conflicts: string[] } | { error: string }> {
  try {
    const user = await getCurrentUser()
    if (!user || !can(user.role as Role, ACTIONS.CHANGE_STATUS)) return { error: 'Unauthorized' }
    let updated = 0
    const conflicts: string[] = []
    for (const { id, version } of items) {
      try {
        const current = await getDevice(id)
        if (!current) { conflicts.push(id); continue }
        const newStatus = status ?? current.status
        const newPhase = phase ?? current.phase
        await changeStatus(id, newStatus, newPhase, version, user.id, user.role as Role)
        updated++
      } catch {
        conflicts.push(id)
      }
    }
    revalidatePath('/devices')
    return { ok: true, updated, conflicts }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Bulk update failed' }
  }
}

export async function bulkSoftDeleteAction(
  items: { id: string; version: number }[]
): Promise<{ ok: true; deleted: number; conflicts: string[] } | { error: string }> {
  try {
    const user = await getCurrentUser()
    if (!user || !can(user.role as Role, ACTIONS.SOFT_DELETE)) return { error: 'Unauthorized' }
    let deleted = 0
    const conflicts: string[] = []
    for (const { id } of items) {
      try {
        await softDeleteDevice(id, user.id, user.role as Role)
        deleted++
      } catch {
        conflicts.push(id)
      }
    }
    revalidatePath('/devices')
    return { ok: true, deleted, conflicts }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Bulk delete failed' }
  }
}

export async function assignDeviceAction(
  deviceId: string, userId: string
): Promise<{ ok: true } | { error: string }> {
  try {
    const user = await getCurrentUser()
    if (!user || !can(user.role as Role, ACTIONS.ASSIGN_DEVICE)) return { error: 'Unauthorized' }
    await assignDevice(deviceId, userId, user.id, user.role as Role)
    revalidatePath(`/devices/${deviceId}`)
    return { ok: true }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Assign failed' }
  }
}

export async function unassignDeviceAction(
  deviceId: string, userId: string
): Promise<{ ok: true } | { error: string }> {
  try {
    const user = await getCurrentUser()
    if (!user || !can(user.role as Role, ACTIONS.ASSIGN_DEVICE)) return { error: 'Unauthorized' }
    await unassignDevice(deviceId, userId, user.id, user.role as Role)
    revalidatePath(`/devices/${deviceId}`)
    return { ok: true }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Unassign failed' }
  }
}

export async function addServiceEventAction(
  deviceId: string, description: string, occurredOn: string
): Promise<{ ok: true } | { error: string }> {
  try {
    const user = await getCurrentUser()
    if (!user || !can(user.role as Role, ACTIONS.LOG_SERVICE_EVENT)) return { error: 'Unauthorized' }
    await addServiceEvent({ deviceId, description, occurredOn }, user.id, user.role as Role)
    revalidatePath(`/devices/${deviceId}`)
    return { ok: true }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Save failed' }
  }
}
