'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addStatusAction, addPhaseAction } from './actions'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

interface AddVocabFormProps { table: 'status_option' | 'phase_option' }

export function AddVocabForm({ table }: AddVocabFormProps) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [en, setEn] = useState('')
  const [zh, setZh] = useState('')
  // Transition flags — status vocabulary only, and set at creation time only
  // (there is no flag-edit UI; SQL is the deliberate escape hatch to change them).
  const [isTerminal, setIsTerminal] = useState(false)
  const [isInitial, setIsInitial] = useState(false)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      if (table === 'status_option') await addStatusAction(code, en, zh, { isTerminal, isInitial })
      else await addPhaseAction(code, en, zh)
      setCode(''); setEn(''); setZh(''); setIsTerminal(false); setIsInitial(false)
      router.refresh()
      toast.success('Entry added')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add entry')
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
      {table === 'status_option' && (
        <div className="flex gap-3 items-center h-8">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" title="No onward transitions (transition sink)">
            <input type="checkbox" className="rounded border-gray-300" checked={isTerminal} onChange={(e) => setIsTerminal(e.target.checked)} />
            Terminal
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" title="Creation-only — nothing transitions into it">
            <input type="checkbox" className="rounded border-gray-300" checked={isInitial} onChange={(e) => setIsInitial(e.target.checked)} />
            Initial
          </label>
        </div>
      )}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? 'Adding...' : '+ Add'}
      </Button>
    </form>
  )
}
