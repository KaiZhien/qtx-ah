import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listUsers } from '@/modules/admin/services/userService'
import { UserTable } from '@/components/admin/UserTable'

export default async function AdminUsersPage() {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'manage_users', 'admin')) notFound()

  // The per-row "Permission exceptions" link goes to /admin/users/[id]/overrides,
  // which is gated on the permission-fabric permission — NARROWER than the
  // manage_users gate above. Every admin page 404s rather than 403s, so offering
  // that link to a user admin who is not a fabric admin dead-ends with no
  // explanation. Same rule the /admin landing cards adopted: the offer carries the
  // permission its destination enforces.
  const canManageOverrides = can(actor, 'manage_roles_permissions', 'admin')

  const users = await listUsers(actor)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Users</h1>
        <p className="mt-1 text-slate-600">
          Invite employees, change role and module access, and activate or deactivate accounts.
        </p>
      </div>
      <UserTable
        users={users}
        currentUserId={actor.id}
        canManageOverrides={canManageOverrides}
      />
    </div>
  )
}
