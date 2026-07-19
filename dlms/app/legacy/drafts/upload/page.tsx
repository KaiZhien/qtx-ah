import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import { getStatuses, getPhases } from '@/lib/services/vocabularyService'
import { UploadClient } from './UploadClient'

export default async function DraftUploadPage() {
  await requirePermission(ACTIONS.CREATE_DEVICE)
  const [statuses, phases] = await Promise.all([getStatuses(), getPhases()])
  return <UploadClient statuses={statuses} phases={phases} />
}
