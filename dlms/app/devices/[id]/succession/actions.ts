'use server'
import { getCurrentUser } from '@/lib/auth/session'
import { linkReplacement } from '@/lib/services/successionService'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { revalidatePath } from 'next/cache'
import type { Role } from '@/lib/types'

export async function linkReplacementAction(
  oldId: string,
  newId: string,
  version: number,
): Promise<{ ok: true } | { error: string }> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Unauthorized' }
  // Belt-and-suspenders action-layer gate (restores the house convention): the
  // service also enforces this via can() in linkReplacement, but every action
  // re-checks so a viewer never reaches the service in the first place.
  if (!can(user.role as Role, ACTIONS.EDIT_DEVICE)) return { error: 'Unauthorized' }
  try {
    await linkReplacement(oldId, newId, version, user.id, user.role as Role)
    revalidatePath(`/devices/${oldId}`)
    revalidatePath(`/devices/${newId}`)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed' }
  }
}
