import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getMatrix } from '@/modules/admin/services/roleService'
import { PermissionMatrix } from '@/components/admin/PermissionMatrix'

export default async function AdminRolesPage() {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'manage_roles_permissions', 'admin')) notFound()

  const matrix = await getMatrix(actor)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Roles &amp; permissions</h1>
        <p className="mt-1 text-slate-600">
          Edit which permissions each role grants. Per-user exceptions are managed from that
          person's page under Users.
        </p>
      </div>
      <PermissionMatrix roles={matrix.roles} permissions={matrix.permissions} grants={matrix.grants} />
    </div>
  )
}
