'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { setRolePermissionAction } from '@/app/(platform)/admin/roles/actions'
import type { Permission, RoleKey } from '@/modules/shared/authz/catalog'

type RoleRow = { id: string; key: RoleKey; name: string; isSystem: boolean }
type PermRow = { id: string; key: Permission; name: string }

type PermissionMatrixProps = {
  roles: RoleRow[]
  permissions: PermRow[]
  grants: Record<string, string[]>
}

// The one hardcoded cell: super_admin must keep manage_roles_permissions, or
// nobody could ever open this page again to undo the mistake. Mirrors the
// FabricLockoutError guard in roleService.setRolePermission — the disabled
// checkbox here is a UX courtesy, not the enforcement point.
function isFabricLock(roleKey: RoleKey, permissionKey: Permission): boolean {
  return roleKey === 'super_admin' && permissionKey === 'manage_roles_permissions'
}

export function PermissionMatrix({ roles, permissions, grants: initialGrants }: PermissionMatrixProps) {
  const [grants, setGrants] = useState(initialGrants)
  const [pendingCell, setPendingCell] = useState<string | null>(null)

  function isGranted(roleKey: RoleKey, permissionKey: Permission): boolean {
    return (grants[roleKey] ?? []).includes(permissionKey)
  }

  async function toggle(roleKey: RoleKey, permissionKey: Permission, nextChecked: boolean) {
    const cellKey = `${roleKey}:${permissionKey}`
    const previous = grants

    // Optimistic UI: the grid is a checkbox matrix and should feel instant;
    // a failure below reverts to `previous` and surfaces a toast.
    setGrants((current) => {
      const next = new Set(current[roleKey] ?? [])
      if (nextChecked) next.add(permissionKey)
      else next.delete(permissionKey)
      return { ...current, [roleKey]: Array.from(next) }
    })
    setPendingCell(cellKey)

    try {
      const res = await setRolePermissionAction({ roleKey, permissionKey, granted: nextChecked })
      if ('error' in res) {
        setGrants(previous)
        toast.error(res.error)
      }
    } finally {
      setPendingCell(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Changes take effect on each user's next request.
      </div>

      <div className="max-h-[70vh] overflow-auto rounded-md border">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 top-0 z-20 whitespace-nowrap border-b border-r bg-white
                           px-3 py-2 text-left font-medium text-slate-700"
              >
                Permission
              </th>
              {roles.map((role) => (
                <th
                  key={role.id}
                  scope="col"
                  className="sticky top-0 z-10 whitespace-nowrap border-b bg-white px-3 py-2
                             text-center font-medium text-slate-700"
                >
                  {role.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permissions.map((permission) => (
              <tr key={permission.id}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 whitespace-nowrap border-b border-r bg-white
                             px-3 py-2 text-left font-normal text-slate-700"
                >
                  {permission.name}
                </th>
                {roles.map((role) => {
                  const locked = isFabricLock(role.key, permission.key)
                  const checked = locked ? true : isGranted(role.key, permission.key)
                  const cellKey = `${role.key}:${permission.key}`
                  return (
                    <td key={role.id} className="border-b px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${permission.name} for ${role.name}`}
                        className="rounded border-gray-300 disabled:cursor-not-allowed disabled:opacity-60"
                        checked={checked}
                        disabled={locked || pendingCell === cellKey}
                        title={locked
                          ? 'Super Administrators must always be able to manage the permission matrix — removing this would lock everyone out.'
                          : undefined}
                        onChange={(e) => toggle(role.key, permission.key, e.target.checked)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
