'use server'
import { redirect } from 'next/navigation'
import { createClient, createAdminClient } from '@/lib/supabase/server'

const ALLOWED_DOMAIN = 'quantumtx.com'

export async function signUpAction(formData: FormData) {
  const email = (formData.get('email') as string).trim().toLowerCase()
  const password = formData.get('password') as string

  // Domain allowlist — only company email addresses may register
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    return { error: `Sign-up is restricted to @${ALLOWED_DOMAIN} email addresses.` }
  }

  const supabase = createClient()
  const { data, error } = await supabase.auth.signUp({ email, password })

  if (error) {
    return { error: error.message }
  }

  // Insert app_user row via service role (RLS blocks user-level inserts).
  // active: false — an admin must activate the account before the user can log in.
  // role: 'engineer' is the lowest privileged role; admin promotes as needed.
  if (data.user) {
    const admin = createAdminClient()
    const { error: userError } = await admin
      .from('app_user')
      .insert({ id: data.user.id, email, role: 'engineer', active: false })

    if (userError) {
      return { error: 'Account created but profile setup failed. Contact an admin.' }
    }
  }

  // Always show confirmation screen — user must confirm email AND be activated by admin
  return { success: true, needsConfirmation: true }
}
