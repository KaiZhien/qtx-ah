'use client'

import { useEffect, useState, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Keyboard } from 'lucide-react'

const SHORTCUTS = [
  { key: '/', description: 'Focus search' },
  { key: '?', description: 'Show this help dialog' },
  { key: 'Esc', description: 'Close dialogs' },
]

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  )
}

export function KeyboardShortcuts() {
  const [helpOpen, setHelpOpen] = useState(false)

  const handleKey = useCallback((e: KeyboardEvent) => {
    // Never fire when typing inside a form element
    if (isTypingTarget(e)) return
    // Also ignore if modifier keys are held (Ctrl+/, Cmd+/ etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return

    if (e.key === '/') {
      e.preventDefault()
      const input = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]')
      input?.focus()
      input?.select()
    } else if (e.key === '?') {
      e.preventDefault()
      setHelpOpen(v => !v)
    } else if (e.key === 'Escape') {
      setHelpOpen(false)
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard Shortcuts
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          {SHORTCUTS.map(({ key, description }) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{description}</span>
              <kbd className="px-2 py-0.5 rounded border bg-muted font-mono text-xs">{key}</kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
