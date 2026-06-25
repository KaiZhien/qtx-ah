import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'sonner'
import { Header } from '@/components/layout/Header'
import { getCurrentUser } from '@/lib/auth/session'
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'DLMS · QuantumTX',
  description: 'Device Lifecycle Management System',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  return (
    <html lang="en">
      <body className={inter.className}>
        <Header user={user} />
        <main className="container mx-auto py-6 px-4">{children}</main>
        <Toaster richColors position="top-right" />
        <KeyboardShortcuts />
      </body>
    </html>
  )
}
