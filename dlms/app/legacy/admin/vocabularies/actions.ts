'use server'
import { addStatusOption, addPhaseOption, toggleOptionActive } from '@/lib/services/vocabularyService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'
import { revalidatePath } from 'next/cache'

async function adminCheck() {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.MANAGE_VOCABULARIES)) throw new Error('Unauthorized')
  return user
}

export async function addStatusAction(
  code: string,
  labelEn: string,
  labelZh: string,
  flags?: { isTerminal?: boolean; isInitial?: boolean }
) {
  const user = await adminCheck()
  await addStatusOption(code, labelEn, labelZh, user.id, user.role as Role, flags)
  revalidatePath('/legacy/admin/vocabularies')
}

export async function addPhaseAction(code: string, labelEn: string, labelZh: string) {
  const user = await adminCheck()
  await addPhaseOption(code, labelEn, labelZh, user.id, user.role as Role)
  revalidatePath('/legacy/admin/vocabularies')
}

export async function toggleStatusActiveAction(code: string, active: boolean) {
  const user = await adminCheck()
  await toggleOptionActive('status_option', code, active, user.id, user.role as Role)
  revalidatePath('/legacy/admin/vocabularies')
}

export async function togglePhaseActiveAction(code: string, active: boolean) {
  const user = await adminCheck()
  await toggleOptionActive('phase_option', code, active, user.id, user.role as Role)
  revalidatePath('/legacy/admin/vocabularies')
}
