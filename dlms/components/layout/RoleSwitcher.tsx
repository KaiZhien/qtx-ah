'use client'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'
import type { Role } from '@/lib/types'
import { cn } from '@/lib/utils'

const DEMO_USERS: Record<string, { email: string; label: string }> = {
  viewer:   { email: 'viewer@demo.quantumtx.com',   label: 'Viewer' },
  engineer: { email: 'engineer@demo.quantumtx.com', label: 'Engineer' },
  admin:    { email: 'admin@demo.quantumtx.com',    label: 'Admin' },
}

interface RoleSwitcherProps {
  currentUserId?: string
  currentRole?: Role
}

export function RoleSwitcher({ currentRole }: RoleSwitcherProps) {
  const router = useRouter()
  const supabase = createBrowserClient()

  async function switchRole(role: string) {
    const user = DEMO_USERS[role]
    if (!user) return
    await supabase.auth.signInWithPassword({ email: user.email, password: 'demo1234' })
    router.refresh()
  }

  return (
    <div className="flex items-center gap-1 rounded-full border bg-muted px-1 py-1">
      <span className="text-xs text-muted-foreground px-1 hidden md:inline">Role:</span>
      {Object.entries(DEMO_USERS).map(([role, { label }]) => (
        <button
          key={role}
          onClick={() => switchRole(role)}
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
            currentRole === role
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-background'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
