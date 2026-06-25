'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createDevice, updateDevice, changeStatus, softDeleteDevice, listDevices, getDevice, getDeviceByPcbaSn } from '@/lib/services/deviceService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { FIELD_LABELS } from '@/lib/i18n/fields'
import type { DeviceInput, Role } from '@/lib/types'

export async function createDeviceAction(input: DeviceInput) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.CREATE_DEVICE)) throw new Error('Unauthorized')
  const device = await createDevice(input, user.id, user.role as Role)
  revalidatePath('/devices')
  redirect(`/devices/${device.id}`)
}

export async function updateDeviceAction(id: string, input: Partial<DeviceInput>, version: number) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.EDIT_DEVICE)) throw new Error('Unauthorized')
  const device = await updateDevice(id, input, version, user.id, user.role as Role)
  revalidatePath(`/devices/${id}`)
  return device
}

export async function changeStatusAction(id: string, status: string, phase: string, version: number) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.CHANGE_STATUS)) throw new Error('Unauthorized')
  const device = await changeStatus(id, status, phase, version, user.id, user.role as Role)
  revalidatePath(`/devices/${id}`)
  revalidatePath('/devices')
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

export async function exportDevicesAction(params: {
  q?: string; status?: string; phase?: string; customer?: string
}): Promise<string> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.EXPORT_DATA)) throw new Error('Unauthorized')

  const { rows } = await listDevices({ ...params, pageSize: 10000 })

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
  return [headers, ...csvRows].join('\n')
}
