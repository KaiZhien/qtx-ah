'use server'
import { promoteDraft } from '@/lib/services/draftService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'
import { revalidatePath } from 'next/cache'

export async function promoteDraftAction(id: string): Promise<string> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.CONFIRM_DRAFT)) throw new Error('Unauthorized')
  const device = await promoteDraft(id, user.id, user.role as Role)
  revalidatePath('/drafts')
  revalidatePath('/devices')
  return device.id
}
