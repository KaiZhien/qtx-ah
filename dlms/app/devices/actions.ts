'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createDevice, updateDevice, changeStatus, softDeleteDevice, listDevices } from '@/lib/services/deviceService'
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
