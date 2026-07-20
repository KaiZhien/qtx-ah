'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { UserForm, type UserFormValues } from '@/components/admin/UserForm'
import {
  inviteUserAction, setUserActiveAction, updateUserAccessAction, resendInviteAction,
  resetUserMfaAction,
} from '@/app/(platform)/admin/users/actions'
import type { UserListRow } from '@/modules/admin/services/userService'
import { KeyRound, Mail, Pencil, Power, PowerOff, ShieldCheck, UserPlus } from 'lucide-react'

type UserTableProps = {
  users: UserListRow[]
  currentUserId: string
}

const EMPTY_INVITE: UserFormValues = {
  email: '', fullName: '', roleKey: 'viewer', department: '', moduleAccess: [],
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function statusBadge(user: UserListRow) {
  if (!user.active) return <Badge variant="gray">Deactivated</Badge>
  if (!user.authUserId) return <Badge variant="info">Pending invite</Badge>
  return <Badge variant="success">Active</Badge>
}

export function UserTable({ users, currentUserId }: UserTableProps) {
  const router = useRouter()

  const [inviteOpen, setInviteOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<UserListRow | null>(null)
  const [toggleTarget, setToggleTarget] = useState<UserListRow | null>(null)
  const [mfaResetTarget, setMfaResetTarget] = useState<UserListRow | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [resendingId, setResendingId] = useState<string | null>(null)

  async function handleInvite(values: UserFormValues) {
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await inviteUserAction({
        email: values.email,
        fullName: values.fullName,
        roleKey: values.roleKey,
        department: values.department || undefined,
        moduleAccess: values.moduleAccess,
      })
      if ('error' in res) {
        setFormError(res.error)
        toast.error(res.error)
        return
      }
      toast.success(`Invited ${values.email}`)
      setInviteOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleEditAccess(values: UserFormValues) {
    if (!editingUser) return
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await updateUserAccessAction(
        editingUser.id,
        { roleKey: values.roleKey, department: values.department || undefined, moduleAccess: values.moduleAccess },
        editingUser.version,
      )
      if ('error' in res) {
        setFormError(res.error)
        toast.error(res.error)
        return
      }
      toast.success('Access updated')
      setEditingUser(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirmToggle() {
    if (!toggleTarget) return
    setSubmitting(true)
    try {
      const nextActive = !toggleTarget.active
      const res = await setUserActiveAction(
        toggleTarget.id, nextActive, toggleTarget.version,
      )
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      toast.success(nextActive ? 'User activated' : 'User deactivated')
      setToggleTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirmResetMfa() {
    if (!mfaResetTarget) return
    setSubmitting(true)
    try {
      const res = await resetUserMfaAction(mfaResetTarget.id)
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      toast.success(`MFA reset for ${mfaResetTarget.fullName}`)
      setMfaResetTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResendInvite(user: UserListRow) {
    setResendingId(user.id)
    try {
      const res = await resendInviteAction(user.email)
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      toast.success(`Invite re-sent to ${user.email}`)
    } finally {
      setResendingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => { setFormError(null); setInviteOpen(true) }}>
          <UserPlus className="mr-1.5 h-4 w-4" />
          Invite user
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Modules</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>MFA</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No users yet.
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => {
                const isSelf = user.id === currentUserId
                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="font-medium text-slate-900">{user.fullName}</div>
                      <div className="text-xs text-muted-foreground">{user.email}</div>
                    </TableCell>
                    <TableCell className="capitalize">{user.roleKey.replace('_', ' ')}</TableCell>
                    <TableCell>{user.department ?? '—'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {user.moduleAccess.length === 0
                          ? <span className="text-xs text-muted-foreground">None</span>
                          : user.moduleAccess.map((m) => (
                              <Badge key={m} variant="outline" className="text-[10px]">{m}</Badge>
                            ))}
                      </div>
                    </TableCell>
                    <TableCell>{statusBadge(user)}</TableCell>
                    <TableCell>
                      {user.mfaEnrolled
                        ? <Badge variant="success">Enrolled</Badge>
                        : <Badge variant="gray">Not enrolled</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(user.lastLoginAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {!user.authUserId && (
                          <Button
                            size="sm" variant="ghost"
                            title="Resend invite"
                            disabled={resendingId === user.id}
                            onClick={() => handleResendInvite(user)}
                          >
                            <Mail className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="sm" variant="ghost" asChild
                          title="Permission exceptions"
                        >
                          <Link href={`/admin/users/${user.id}/overrides`}>
                            <ShieldCheck className="h-4 w-4" />
                          </Link>
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          title={isSelf ? 'You cannot change your own access' : 'Edit access'}
                          disabled={isSelf}
                          onClick={() => { setFormError(null); setEditingUser(user) }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          title="Reset MFA"
                          onClick={() => setMfaResetTarget(user)}
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          title={user.active ? 'Deactivate' : 'Activate'}
                          onClick={() => setToggleTarget(user)}
                        >
                          {user.active
                            ? <PowerOff className="h-4 w-4 text-destructive" />
                            : <Power className="h-4 w-4 text-green-600" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={(open) => { if (!open) setInviteOpen(false) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Invite a user</DialogTitle>
          </DialogHeader>
          <UserForm
            mode="invite"
            initial={EMPTY_INVITE}
            submitting={submitting}
            error={formError}
            onCancel={() => setInviteOpen(false)}
            onSubmit={handleInvite}
          />
        </DialogContent>
      </Dialog>

      {/* Edit access dialog */}
      <Dialog open={editingUser !== null} onOpenChange={(open) => { if (!open) setEditingUser(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit access — {editingUser?.fullName}</DialogTitle>
          </DialogHeader>
          {editingUser && (
            <UserForm
              mode="edit"
              initial={{
                email: editingUser.email,
                fullName: editingUser.fullName,
                roleKey: editingUser.roleKey,
                department: editingUser.department ?? '',
                moduleAccess: editingUser.moduleAccess,
              }}
              submitting={submitting}
              error={formError}
              onCancel={() => setEditingUser(null)}
              onSubmit={handleEditAccess}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Activate/deactivate confirm */}
      <AlertDialog open={toggleTarget !== null} onOpenChange={(open) => { if (!open) setToggleTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggleTarget?.active ? 'Deactivate user?' : 'Activate user?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {toggleTarget?.active
                ? `${toggleTarget?.fullName} will be signed out of every active session immediately and lose access until reactivated.`
                : `${toggleTarget?.fullName} will regain access with their existing role and module assignments.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(e) => { e.preventDefault(); handleConfirmToggle() }}
            >
              {submitting ? 'Working…' : toggleTarget?.active ? 'Deactivate' : 'Activate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset MFA confirm */}
      <AlertDialog open={mfaResetTarget !== null} onOpenChange={(open) => { if (!open) setMfaResetTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset MFA?</AlertDialogTitle>
            <AlertDialogDescription>
              This signs them out of MFA — they&apos;ll set it up again on next login.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(e) => { e.preventDefault(); handleConfirmResetMfa() }}
            >
              {submitting ? 'Working…' : 'Reset MFA'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
