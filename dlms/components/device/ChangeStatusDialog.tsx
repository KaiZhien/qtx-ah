'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusBadge, PhaseBadge } from './DeviceStatusBadge'
import type { DeviceRow, StatusOption, PhaseOption } from '@/lib/types'

interface ChangeStatusDialogProps {
  device: DeviceRow
  statuses: StatusOption[]
  phases: PhaseOption[]
  onClose: () => void
  onSave: (status: string, phase: string) => Promise<void>
}

export function ChangeStatusDialog({ device, statuses, phases, onClose, onSave }: ChangeStatusDialogProps) {
  const [status, setStatus] = useState(device.status)
  const [phase, setPhase] = useState(device.phase)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(status, phase)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Status / Phase</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="text-sm text-muted-foreground">
            Current: <StatusBadge status={device.status} /> <PhaseBadge phase={device.phase} />
          </div>
          <div className="space-y-2">
            <Label>Status · 状态</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s.code} value={s.code}>{s.label_en} · {s.label_zh}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Phase · 阶段</Label>
            <Select value={phase} onValueChange={setPhase}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {phases.map((p) => (
                  <SelectItem key={p.code} value={p.code}>{p.label_en} · {p.label_zh}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
