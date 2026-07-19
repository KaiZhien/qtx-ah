import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'sonner'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'QuantumTX Operations',
  description: 'QuantumTX Operations Platform',
}

// Shared shell only — no DLMS chrome here. DLMS's Header/MainNav lives in
// app/legacy/layout.tsx; the platform's ModuleNav lives in
// app/(platform)/layout.tsx. Keeping this neutral is what stops platform
// routes from rendering double navigation.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  )
}
