'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addStatusAction, addPhaseAction } from './actions'
import { useRouter } from 'next/navigation'

interface AddVocabFormProps { table: 'status_option' | 'phase_option' }

export function AddVocabForm({ table }: AddVocabFormProps) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [en, setEn] = useState('')
  const [zh, setZh] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      if (table === 'status_option') await addStatusAction(code, en, zh)
      else await addPhaseAction(code, en, zh)
      setCode(''); setEn(''); setZh('')
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 items-end flex-wrap">
      <div className="space-y-1">
        <Label className="text-xs">Code</Label>
        <Input className="w-28 h-8" value={code} onChange={(e) => setCode(e.target.value)} required placeholder="e.g. Rework" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Label EN</Label>
        <Input className="w-36 h-8" value={en} onChange={(e) => setEn(e.target.value)} required />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Label 中文</Label>
        <Input className="w-28 h-8" value={zh} onChange={(e) => setZh(e.target.value)} required />
      </div>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? 'Adding...' : '+ Add'}
      </Button>
    </form>
  )
}
