'use server'
import { getCurrentUser } from '@/lib/auth/session'
import { linkReplacement } from '@/lib/services/successionService'
import { revalidatePath } from 'next/cache'
import type { Role } from '@/lib/types'

export async function linkReplacementAction(
  oldId: string,
  newId: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Unauthorized' }
  try {
    await linkReplacement(oldId, newId, user.id, user.role as Role)
    revalidatePath(`/devices/${oldId}`)
    revalidatePath(`/devices/${newId}`)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed' }
  }
}
