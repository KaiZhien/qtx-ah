import Link from 'next/link'
import { Cpu } from 'lucide-react'
import { RoleSwitcher } from './RoleSwitcher'
import { MainNav } from './MainNav'
import type { AppUser } from '@/lib/types'
import type { Role } from '@/lib/types'

interface HeaderProps { user: AppUser | null }

export function Header({ user }: HeaderProps) {
  const role = (user?.role ?? 'viewer') as Role
  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
      <div className="container mx-auto flex h-14 items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Cpu className="h-5 w-5" />
          <span>DLMS</span>
          <span className="text-muted-foreground text-sm font-normal">· QuantumTX</span>
        </Link>
        <MainNav role={role} />
        <div className="ml-auto flex items-center gap-3">
          {user && (
            <span className="text-xs text-muted-foreground hidden sm:inline">{user.email} · {user.role}</span>
          )}
          {process.env.NEXT_PUBLIC_DEV_MODE === 'true' && (
            <RoleSwitcher currentUserId={user?.id} currentRole={user?.role as Role | undefined} />
          )}
        </div>
      </div>
    </header>
  )
}
