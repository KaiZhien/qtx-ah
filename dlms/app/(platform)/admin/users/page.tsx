import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listUsers } from '@/modules/admin/services/userService'
import { UserTable } from '@/components/admin/UserTable'

export default async function AdminUsersPage() {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'manage_users', 'admin')) notFound()

  const users = await listUsers(actor)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Users</h1>
        <p className="mt-1 text-slate-600">
          Invite employees, change role and module access, and activate or deactivate accounts.
        </p>
      </div>
      <UserTable users={users} currentUserId={actor.id} />
    </div>
  )
}
