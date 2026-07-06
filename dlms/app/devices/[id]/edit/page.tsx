import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import { EditDeviceClient } from './EditDeviceClient'

export default async function EditDevicePage() {
  await requirePermission(ACTIONS.EDIT_DEVICE)
  return <EditDeviceClient />
}
