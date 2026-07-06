import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import { NewDeviceClient } from './NewDeviceClient'

export default async function NewDevicePage() {
  await requirePermission(ACTIONS.CREATE_DEVICE)
  return <NewDeviceClient />
}
