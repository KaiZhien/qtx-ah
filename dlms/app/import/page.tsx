import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import { ImportClient } from './ImportClient'

export default async function ImportPage() {
  await requirePermission(ACTIONS.IMPORT_DATA)
  return <ImportClient />
}
