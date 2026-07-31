import { requireActor } from '@/modules/shared/auth/session'
import { getDeviceComponents } from '@/modules/manufacturing/services/componentService'
import { listComponentTypes } from '@/modules/manufacturing/services/componentCatalogueService'
import { DeviceComponentsPanel, type ReplacementAttribution } from './DeviceComponentsPanel'

type DeviceComponentsTabProps = {
  deviceId: string
  canEdit: boolean
  /**
   * Set when this tab is rendered from a repair (or, later, a modification) so
   * every replacement made here carries that record. Absent on the device
   * profile. The CALLER must have already checked view_records on
   * manufacturing — the services below throw rather than degrade.
   */
  attribution?: ReplacementAttribution
}

/**
 * Device profile Components tab (Task 5). Reads go through the same services
 * every other manufacturing surface uses — getDeviceComponents for current +
 * history, listComponentTypes for the tracking-mode lookup the Replace/Add
 * dialogs need. includeInactive: true because a device can carry an
 * installation of a type an admin has since deactivated; the lookup still
 * needs its tracking mode to render the right replacement field. canEdit only
 * gates the mutating controls — this still renders read-only for a viewer,
 * matching the page's existing view_records gate (Task 13 checks that before
 * this component is reached).
 */
export async function DeviceComponentsTab({
  deviceId, canEdit, attribution,
}: DeviceComponentsTabProps) {
  const actor = await requireActor()
  const [{ current, history }, types] = await Promise.all([
    getDeviceComponents(actor, deviceId),
    listComponentTypes(actor, { includeInactive: true }),
  ])

  return (
    <DeviceComponentsPanel
      deviceId={deviceId}
      canEdit={canEdit}
      current={current}
      history={history}
      types={types}
      attribution={attribution}
    />
  )
}
