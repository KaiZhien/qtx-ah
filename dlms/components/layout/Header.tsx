import Link from 'next/link'
import { Cpu } from 'lucide-react'
import { RoleSwitcher } from './RoleSwitcher'
import type { AppUser } from '@/lib/types'
import { can, ACTIONS } from '@/lib/auth/permissions'
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
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">Dashboard</Link>
          <Link href="/devices" className="text-muted-foreground hover:text-foreground transition-colors">Devices</Link>
          {can(role, ACTIONS.VIEW_ANALYTICS) && (
            <Link href="/analytics" className="text-muted-foreground hover:text-foreground transition-colors">Analytics</Link>
          )}
          {can(role, ACTIONS.VIEW_ANALYTICS) && (
            <Link href="/traceability" className="text-muted-foreground hover:text-foreground transition-colors">Traceability</Link>
          )}
          {can(role, ACTIONS.IMPORT_DATA) && (
            <Link href="/import" className="text-muted-foreground hover:text-foreground transition-colors">Import</Link>
          )}
          {can(role, ACTIONS.CONFIRM_DRAFT) && (
            <Link href="/drafts" className="text-muted-foreground hover:text-foreground transition-colors">Drafts</Link>
          )}
          {can(role, ACTIONS.MANAGE_USERS) && (
            <Link href="/admin/audit" className="text-muted-foreground hover:text-foreground transition-colors">Admin</Link>
          )}
          {can(role, ACTIONS.MANAGE_USERS) && (
            <Link href="/admin/subscribers" className="text-muted-foreground hover:text-foreground transition-colors">Subscribers</Link>
          )}
          {can(role, ACTIONS.MANAGE_USERS) && (
            <Link href="/admin/users" className="text-muted-foreground hover:text-foreground transition-colors">Users</Link>
          )}
          {can(role, ACTIONS.MANAGE_VOCABULARIES) && (
            <Link href="/admin/vocabularies" className="text-muted-foreground hover:text-foreground transition-colors">Vocabularies</Link>
          )}
        </nav>
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
