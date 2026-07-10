'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Surface the middleware's not-authorized bounce (?error=not-authorized).
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get('error')
    if (param === 'not-authorized') {
      setError('This account is not authorized. Contact your administrator.')
    }
  }, [])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }

    // Full navigation so the middleware sees the freshly-set session cookies.
    window.location.assign('/')
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        padding: 24,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 360,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-2)',
          padding: 'var(--pad-card)',
        }}
      >
        <div style={{ marginBottom: 20 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            QuantumTX AH
          </div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--ink)' }}>
            Clinician sign in
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--ink-3)' }}>
            Sign in to access the clinical analytics dashboard.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--danger)' }} role="alert">
              {error}
            </p>
          )}

          <button
            className="btn primary"
            type="submit"
            disabled={loading}
            style={{ width: '100%', marginTop: 4 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
