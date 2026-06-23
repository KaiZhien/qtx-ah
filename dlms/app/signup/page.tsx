'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Cpu, MailCheck } from 'lucide-react'
import { signUpAction } from './actions'

export default function SignUpPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const formData = new FormData(e.currentTarget)
    const password = formData.get('password') as string
    const confirm = formData.get('confirm') as string

    if (password !== confirm) {
      setError('Passwords do not match')
      setLoading(false)
      return
    }

    const result = await signUpAction(formData)
    if (result?.error) {
      setError(result.error)
      setLoading(false)
    } else if (result?.needsConfirmation) {
      setDone(true)
    }
    // On success with session, signUpAction redirects server-side
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <MailCheck className="h-8 w-8 mx-auto mb-2 text-green-600" />
            <CardTitle>Almost there</CardTitle>
            <p className="text-sm text-muted-foreground">
              Check your email for a confirmation link. Once confirmed, an admin will activate
              your account before you can sign in.
            </p>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button variant="outline" className="w-full">Back to Sign In</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Cpu className="h-8 w-8 mx-auto mb-2" />
          <CardTitle>Create Account</CardTitle>
          <p className="text-sm text-muted-foreground">DLMS · QuantumTX</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required autoComplete="new-password" minLength={8} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="confirm">Confirm Password</Label>
              <Input id="confirm" name="confirm" type="password" required autoComplete="new-password" minLength={8} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Creating account…' : 'Create Account'}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              New accounts are created with Engineer access.
              <br />An admin can adjust your role after sign-in.
            </p>
          </form>
          <div className="mt-4 text-center text-sm">
            Already have an account?{' '}
            <Link href="/login" className="underline">Sign in</Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
