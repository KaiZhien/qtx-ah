'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { assignDeviceAction, unassignDeviceAction } from '@/app/devices/actions'
import type { AppUser } from '@/lib/types'

interface AssignmentCardProps {
  deviceId: string
  initialAssignees: AppUser[]
  allUsers: AppUser[]
  canAssign: boolean
}

export function AssignmentCard({
  deviceId,
  initialAssignees,
  allUsers,
  canAssign,
}: AssignmentCardProps) {
  const router = useRouter()
  const [pendingUserId, setPendingUserId] = useState<string | null>(null)

  const assignedIds = new Set(initialAssignees.map((u) => u.id))
  const availableUsers = allUsers.filter((u) => !assignedIds.has(u.id))

  async function handleAssign(userId: string) {
    setPendingUserId(userId)
    try {
      const result = await assignDeviceAction(deviceId, userId)
      if ('error' in result) {
        toast.error(result.error)
      } else {
        router.refresh()
      }
    } catch {
      toast.error('Failed to assign engineer')
    } finally {
      setPendingUserId(null)
    }
  }

  async function handleUnassign(userId: string) {
    setPendingUserId(userId)
    try {
      const result = await unassignDeviceAction(deviceId, userId)
      if ('error' in result) {
        toast.error(result.error)
      } else {
        router.refresh()
      }
    } catch {
      toast.error('Failed to unassign engineer')
    } finally {
      setPendingUserId(null)
    }
  }

  return (
    <div className="border rounded-md p-4 space-y-3">
      <h3 className="text-sm font-semibold">Assigned Engineers</h3>

      {initialAssignees.length === 0 && !canAssign && (
        <p className="text-sm text-muted-foreground">No engineers assigned</p>
      )}

      {initialAssignees.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {initialAssignees.map((user) => (
            <div
              key={user.id}
              className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs"
            >
              <span>{user.email}</span>
              {canAssign && (
                <button
                  type="button"
                  className="ml-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  disabled={pendingUserId === user.id}
                  onClick={() => handleUnassign(user.id)}
                  aria-label={`Remove ${user.email}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canAssign && availableUsers.length > 0 && (
        <Select
          value=""
          onValueChange={(userId) => handleAssign(userId)}
          disabled={pendingUserId !== null}
        >
          <SelectTrigger className="w-64 h-8 text-xs">
            <SelectValue placeholder="Add engineer…" />
          </SelectTrigger>
          <SelectContent>
            {availableUsers.map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
