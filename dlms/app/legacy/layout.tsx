import { Header } from '@/components/layout/Header'
import { getCurrentUser } from '@/lib/auth/session'
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts'

// DLMS chrome, scoped to /legacy/* so the platform shell above it stays clean.
// Moved here from the root layout when the platform claimed the top-level routes.
export default async function LegacyLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  return (
    <>
      <Header user={user} />
      <main className="container mx-auto py-6 px-4">{children}</main>
      <KeyboardShortcuts />
    </>
  )
}
