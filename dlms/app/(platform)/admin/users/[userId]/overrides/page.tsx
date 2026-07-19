import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getUserSummary, listOverrides, getMatrix } from '@/modules/admin/services/roleService'
import { UserOverrides } from '@/components/admin/UserOverrides'

type PageProps = { params: { userId: string } }

export default async function UserOverridesPage({ params }: PageProps) {
  const actor = await requireActor()
  // Gated on the SAME permission-fabric permission as roleService itself
  // (not manage_users): overrides are part of the matrix, and this page's own
  // authority to exist rests on that gate. 404 rather than 403 — a denial
  // must not confirm the section exists (spec §7.3).
  if (!can(actor, 'manage_roles_permissions', 'admin')) notFound()

  const user = await getUserSummary(actor, params.userId)
  if (!user) notFound()

  const [overrides, matrix] = await Promise.all([
    listOverrides(actor, params.userId),
    getMatrix(actor),
  ])

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/users" className="text-sm text-slate-500 hover:underline">
          ← Back to users
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Exceptions — {user.fullName}
        </h1>
        <p className="mt-1 text-slate-600">
          Per-user overrides to the {user.roleKey.replace('_', ' ')} role's permissions for{' '}
          {user.email}. Changes take effect on this user's next request.
        </p>
      </div>
      <UserOverrides userId={user.id} overrides={overrides} permissions={matrix.permissions} />
    </div>
  )
}
