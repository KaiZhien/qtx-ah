'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addSubscriberAction } from './actions'
import { useRouter } from 'next/navigation'

export function AddSubscriberForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await addSubscriberAction(email)
      setEmail('')
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 items-end flex-wrap">
      <div className="space-y-1">
        <Label className="text-xs">Email</Label>
        <Input
          className="w-64 h-8"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="e.g. user@example.com"
        />
      </div>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? 'Adding...' : '+ Add Subscriber'}
      </Button>
    </form>
  )
}
