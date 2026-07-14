'use client'
import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Cpu } from 'lucide-react'
import { loginAction } from './actions'

function ConfirmBanner() {
  const query = useSearchParams().get('confirm')
  const [hashStatus, setHashStatus] = useState<string | null>(null)

  // Supabase's default confirmation email verifies on their domain and redirects
  // here with the outcome in the URL fragment (e.g. #error_code=otp_expired, or
  // tokens on success). Read it once, then scrub it from the address bar.
  useEffect(() => {
    const hash = window.location.hash
    if (!hash) return
    const params = new URLSearchParams(hash.slice(1))
    if (params.get('error_code') === 'otp_expired') setHashStatus('used')
    else if (params.get('access_token')) setHashStatus('success')
    else if (params.get('error')) setHashStatus('invalid')
    else return
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [])

  const confirm = query ?? hashStatus
  if (!confirm) return null

  if (confirm === 'success') {
    return (
      <div className="mb-4 rounded-md border border-green-600/40 bg-green-600/10 p-3 text-sm text-green-700 dark:text-green-400">
        Email confirmed. An admin now needs to activate your account before you can sign in.
      </div>
    )
  }
  if (confirm === 'used') {
    return (
      <div className="mb-4 rounded-md border border-amber-600/40 bg-amber-600/10 p-3 text-sm text-amber-700 dark:text-amber-400">
        This confirmation link has already been used — your email is most likely already
        confirmed. Once an admin activates your account you can sign in.
      </div>
    )
  }
  if (confirm === 'invalid') {
    return (
      <p className="mb-4 text-sm text-destructive">
        That confirmation link is invalid. Try signing up again or contact an admin.
      </p>
    )
  }
  return null
}

export default function LoginPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const result = await loginAction(new FormData(e.currentTarget))
    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
    // On success, loginAction calls redirect('/') server-side — no client code needed
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Cpu className="h-8 w-8 mx-auto mb-2" />
          <CardTitle>DLMS · QuantumTX</CardTitle>
          <p className="text-sm text-muted-foreground">Device Lifecycle Management</p>
        </CardHeader>
        <CardContent>
          <Suspense fallback={null}>
            <ConfirmBanner />
          </Suspense>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign In'}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="underline">Sign up</Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
