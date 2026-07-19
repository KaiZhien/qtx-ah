'use server'
import { addSubscriber, setSubscriberActive, deleteSubscriber } from '@/lib/services/reportSubscriberService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'
import { revalidatePath } from 'next/cache'

async function adminCheck() {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.MANAGE_USERS)) throw new Error('Unauthorized')
  return user
}

export async function addSubscriberAction(email: string) {
  const user = await adminCheck()
  await addSubscriber(email, user.role as Role)
  revalidatePath('/legacy/admin/subscribers')
}

export async function toggleSubscriberAction(id: string, active: boolean) {
  const user = await adminCheck()
  await setSubscriberActive(id, active, user.role as Role)
  revalidatePath('/legacy/admin/subscribers')
}

export async function deleteSubscriberAction(id: string) {
  const user = await adminCheck()
  await deleteSubscriber(id, user.role as Role)
  revalidatePath('/legacy/admin/subscribers')
}
