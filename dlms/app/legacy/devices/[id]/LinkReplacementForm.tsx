'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { linkReplacementAction } from './succession/actions'

export function LinkReplacementForm({ deviceId, version }: { deviceId: string; version: number }) {
  const [newId, setNewId] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleLink() {
    if (!newId.trim()) return
    setSaving(true)
    const result = await linkReplacementAction(deviceId, newId.trim(), version)
    setSaving(false)
    if ('error' in result) {
      toast.error(result.error)
    } else {
      toast.success('Replacement linked')
    }
  }

  return (
    <div className="flex gap-2 items-center">
      <Input
        placeholder="Replacement device ID…"
        value={newId}
        onChange={(e) => setNewId(e.target.value)}
        className="h-8 text-xs w-64"
      />
      <Button size="sm" className="h-8" onClick={handleLink} disabled={saving || !newId.trim()}>
        {saving ? 'Linking…' : 'Link replacement'}
      </Button>
    </div>
  )
}
