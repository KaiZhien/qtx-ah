import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { DeviceGroupSection } from '@/components/device/DeviceGroupSection'
import { StatusBadge, PhaseBadge } from '@/components/device/DeviceStatusBadge'
import { getDevice } from '@/lib/services/deviceService'
import { getDeviceHistory } from '@/lib/services/auditService'
import { requireAuth } from '@/lib/auth/session'

import { can, ACTIONS } from '@/lib/auth/permissions'
import { GROUP_LABELS } from '@/lib/i18n/fields'
import type { Role } from '@/lib/types'
import { Edit } from 'lucide-react'
import { DeleteDeviceButton } from './DeleteDeviceButton'
import { getPredecessor, getSuccessor } from '@/lib/services/successionService'
import { LinkReplacementForm } from './LinkReplacementForm'
import { ComponentsTab } from '@/components/device/ComponentsTab'
import { ChangeHistoryTab } from '@/components/device/ChangeHistoryTab'
import { AssignmentCard } from '@/components/device/AssignmentCard'
import { ServiceLogTab } from '@/components/device/ServiceLogTab'
import { listAssignees } from '@/lib/services/assignmentService'
import { listServiceEvents } from '@/lib/services/serviceEventService'
import { listUsers } from '@/lib/services/userService'

interface PageProps { params: { id: string } }

export default async function DeviceDetailPage({ params }: PageProps) {
  const user = await requireAuth()
  const [device, history, assignees, serviceEvents, users] = await Promise.all([
    getDevice(params.id),
    getDeviceHistory(params.id),
    listAssignees(params.id),
    listServiceEvents(params.id),
    listUsers(),
  ])

  if (!device || device.deleted_at) notFound()

  const replacedById = (device as any).replaced_by as string | null
  const [predecessor, successor] = await Promise.all([
    getPredecessor(params.id),
    replacedById ? getSuccessor(replacedById) : Promise.resolve(null),
  ])

  const role = (user?.role ?? 'viewer') as Role
  const canAssign = can(role, ACTIONS.ASSIGN_DEVICE)
  const canLog = can(role, ACTIONS.LOG_SERVICE_EVENT)
  const primaryId = device.device_sn || device.pcba_a_sn

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold font-mono">{primaryId}</h1>
            <StatusBadge status={device.status} />
            <PhaseBadge phase={device.phase} />
          </div>
          {device.customer && (
            <p className="text-sm text-muted-foreground mt-1">{device.customer}</p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {can(role, ACTIONS.EDIT_DEVICE) && (
            <Link href={`/devices/${device.id}/edit`}>
              <Button variant="outline" size="sm"><Edit className="h-4 w-4 mr-1" />Edit</Button>
            </Link>
          )}
          {can(role, ACTIONS.SOFT_DELETE) && (
            <DeleteDeviceButton deviceId={device.id} />
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="components">Components</TabsTrigger>
          <TabsTrigger value="history">Change History ({history.length})</TabsTrigger>
          <TabsTrigger value="service">Service Log ({serviceEvents.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-6 mt-4">
          {GROUP_LABELS.map((group) => (
            <DeviceGroupSection key={group.key} groupKey={group.key} device={device} />
          ))}

          {/* Succession */}
          {(predecessor || successor || can(role, ACTIONS.EDIT_DEVICE)) && (
            <div className="border rounded-md p-4 space-y-3">
              <h3 className="text-sm font-semibold">Device Succession</h3>
              {successor && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Replaced by</span>
                  <Link href={`/devices/${successor.id}`} className="font-mono underline hover:no-underline">
                    {successor.device_sn || successor.pcba_a_sn}
                  </Link>
                  <span className="text-muted-foreground">→</span>
                </div>
              )}
              {predecessor && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">← Replaces</span>
                  <Link href={`/devices/${predecessor.id}`} className="font-mono underline hover:no-underline">
                    {predecessor.device_sn || predecessor.pcba_a_sn}
                  </Link>
                </div>
              )}
              {!successor && can(role, ACTIONS.EDIT_DEVICE) && (
                <LinkReplacementForm deviceId={device.id} />
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Created {new Date(device.created_at).toLocaleString()} · Version {device.version}
          </p>

          <AssignmentCard
            deviceId={device.id}
            initialAssignees={assignees}
            allUsers={users}
            canAssign={canAssign}
          />
        </TabsContent>

        <TabsContent value="components">
          <ComponentsTab device={device} history={history} />
        </TabsContent>

        <TabsContent value="history">
          <ChangeHistoryTab history={history} />
        </TabsContent>

        <TabsContent value="service">
          <ServiceLogTab
            deviceId={device.id}
            initialEvents={serviceEvents}
            canLog={canLog}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
