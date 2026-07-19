'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { ROLES } from '@/modules/shared/authz/catalog'
import type { ModuleKey, RoleKey } from '@/modules/shared/authz/catalog'
import { AlertCircle } from 'lucide-react'

// The six roles are seeded, is_system rows (spec §3.1) — undeletable and, for
// Task 8, not yet renamable from the UI. Task 9 replaces this static map with
// live role.name reads once role management lands.
const ROLE_LABELS: Record<RoleKey, string> = {
  super_admin: 'Super Administrator',
  admin: 'Administrator',
  manager: 'Manager',
  operator: 'Operator',
  finance: 'Finance',
  viewer: 'Viewer',
}

export type UserFormValues = {
  email: string
  fullName: string
  roleKey: RoleKey
  department: string
  moduleAccess: ModuleKey[]
}

type UserFormProps = {
  mode: 'invite' | 'edit'
  initial: UserFormValues
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (values: UserFormValues) => void
}

/** Shared form for inviting a user and for editing an existing user's role,
 * department, and module access. In edit mode, email and name are read-only —
 * updateUserAccess only ever touches roleKey/department/moduleAccess. */
export function UserForm({ mode, initial, submitting, error, onCancel, onSubmit }: UserFormProps) {
  const [email, setEmail] = useState(initial.email)
  const [fullName, setFullName] = useState(initial.fullName)
  const [roleKey, setRoleKey] = useState<RoleKey>(initial.roleKey)
  const [department, setDepartment] = useState(initial.department)
  const [moduleAccess, setModuleAccess] = useState<Set<ModuleKey>>(new Set(initial.moduleAccess))

  function toggleModule(key: ModuleKey) {
    setModuleAccess((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSubmit({ email, fullName, roleKey, department, moduleAccess: Array.from(moduleAccess) })
  }

  const canSubmit = mode === 'edit'
    ? true
    : email.trim().length > 0 && fullName.trim().length > 0

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="email" className="mb-1.5 block">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            disabled={mode === 'edit'}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@quantumtx.example"
          />
        </div>
        <div>
          <Label htmlFor="fullName" className="mb-1.5 block">Full name</Label>
          <Input
            id="fullName"
            value={fullName}
            disabled={mode === 'edit'}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>
        <div>
          <Label className="mb-1.5 block">Role</Label>
          <Select value={roleKey} onValueChange={(v) => setRoleKey(v as RoleKey)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ROLES.map((key) => (
                <SelectItem key={key} value={key}>{ROLE_LABELS[key]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="department" className="mb-1.5 block">Department</Label>
          <Input
            id="department"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="Optional — for routing and dashboards only"
          />
        </div>
      </div>

      <div>
        <Label className="mb-2 block">Module access</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MODULE_REGISTRY.map((m) => (
            <label key={m.key} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="rounded border-gray-300"
                checked={moduleAccess.has(m.key)}
                onChange={() => toggleModule(m.key)}
              />
              {m.label}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Super Administrators bypass this gate regardless of the boxes checked here.
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? 'Saving…' : mode === 'invite' ? 'Send invite' : 'Save access'}
        </Button>
      </div>
    </form>
  )
}
