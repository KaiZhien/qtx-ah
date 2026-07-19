'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { addOverrideAction } from '@/app/(platform)/admin/roles/actions'
import type { Permission } from '@/modules/shared/authz/catalog'
import type { OverrideRow } from '@/modules/admin/services/roleService'

type PermRow = { id: string; key: Permission; name: string }

type UserOverridesProps = {
  userId: string
  overrides: OverrideRow[]
  permissions: PermRow[]
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const MIN_REASON = 3

/**
 * "Add exception" upserts: submitting for a permission that already has a
 * standing override REPLACES it (roleService.addOverride's ON CONFLICT), so
 * this form doubles as both create and edit — there is no separate edit path.
 */
export function UserOverrides({ userId, overrides, permissions }: UserOverridesProps) {
  const router = useRouter()
  const [permissionKey, setPermissionKey] = useState<Permission | ''>('')
  const [mode, setMode] = useState<'grant' | 'revoke'>('grant')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = permissionKey !== '' && reason.trim().length >= MIN_REASON

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await addOverrideAction({
        userId,
        permissionKey,
        granted: mode === 'grant',
        reason,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      })
      if ('error' in res) {
        setError(res.error)
        toast.error(res.error)
        return
      }
      toast.success('Exception saved')
      setPermissionKey('')
      setReason('')
      setExpiresAt('')
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Permission</TableHead>
              <TableHead>Exception</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overrides.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  No exceptions for this user.
                </TableCell>
              </TableRow>
            ) : (
              overrides.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>{o.permissionName}</TableCell>
                  <TableCell>
                    {o.granted
                      ? <Badge variant="success">Extra grant</Badge>
                      : <Badge variant="destructive">Revoked</Badge>}
                  </TableCell>
                  <TableCell className="max-w-xs text-sm text-slate-600">{o.reason}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDate(o.expiresAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDate(o.createdAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <form onSubmit={handleSubmit} className="max-w-lg space-y-4 rounded-md border p-4">
        <h2 className="font-medium text-slate-900">Add exception</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div>
          <Label className="mb-1.5 block">Permission</Label>
          <Select value={permissionKey} onValueChange={(v) => setPermissionKey(v as Permission)}>
            <SelectTrigger><SelectValue placeholder="Choose a permission" /></SelectTrigger>
            <SelectContent>
              {permissions.map((p) => (
                <SelectItem key={p.id} value={p.key}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="mb-1.5 block">Action</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as 'grant' | 'revoke')}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="grant">Grant extra permission</SelectItem>
              <SelectItem value="revoke">Revoke role permission</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="reason" className="mb-1.5 block">Reason</Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this exception needed? (3–500 characters)"
          />
        </div>

        <div>
          <Label htmlFor="expiresAt" className="mb-1.5 block">Expires (optional)</Label>
          <Input
            id="expiresAt"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={submitting || !canSubmit}>
            {submitting ? 'Saving…' : 'Add exception'}
          </Button>
        </div>
      </form>
    </div>
  )
}
