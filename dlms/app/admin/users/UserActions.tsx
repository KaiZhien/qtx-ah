'use client'
import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { updateRoleAction, deactivateUserAction, reactivateUserAction } from './actions'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { Role } from '@/lib/types'

const ROLES: Role[] = ['viewer', 'engineer', 'admin']

export function UserActions({ userId, currentRole, active }: { userId: string; currentRole: string; active: boolean }) {
  const router = useRouter()
  const [role, setRole] = useState(currentRole)
  const [saving, setSaving] = useState(false)

  async function handleRoleChange(newRole: string) {
    setSaving(true)
    try {
      await updateRoleAction(userId, newRole as Role)
      setRole(newRole)
      router.refresh()
      toast.success('Role updated')
    } catch {
      toast.error('Failed to update role')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeactivate() {
    setSaving(true)
    try {
      await deactivateUserAction(userId)
      router.refresh()
      toast.success('User deactivated')
    } catch {
      toast.error('Failed to deactivate user')
    } finally {
      setSaving(false)
    }
  }

  async function handleReactivate() {
    setSaving(true)
    try {
      await reactivateUserAction(userId)
      router.refresh()
      toast.success('User reactivated')
    } catch {
      toast.error('Failed to reactivate user')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex gap-2 items-center">
      <Select value={role} onValueChange={handleRoleChange} disabled={saving || !active}>
        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
        <SelectContent>
          {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
        </SelectContent>
      </Select>
      {active && (
        <Button variant="ghost" size="sm" onClick={handleDeactivate} disabled={saving}>
          Deactivate
        </Button>
      )}
      {!active && (
        <Button variant="ghost" size="sm" onClick={handleReactivate} disabled={saving}>
          Reactivate
        </Button>
      )}
    </div>
  )
}
