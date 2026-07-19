import { requirePermission } from '@/lib/auth/session'
import { listUsers } from '@/lib/services/userService'
import { ACTIONS } from '@/lib/auth/permissions'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { UserActions } from './UserActions'

export default async function UsersPage() {
  await requirePermission(ACTIONS.MANAGE_USERS)
  const users = await listUsers()

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">User Management</h1>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell>{user.email}</TableCell>
                <TableCell><Badge variant="outline">{user.role}</Badge></TableCell>
                <TableCell>
                  <Badge variant={user.active ? 'success' : 'gray'}>{user.active ? 'Active' : 'Inactive'}</Badge>
                </TableCell>
                <TableCell className="text-xs tabular-nums">{new Date(user.created_at).toLocaleDateString()}</TableCell>
                <TableCell><UserActions userId={user.id} currentRole={user.role} active={user.active} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
