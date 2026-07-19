'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function loginAction(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  const supabase = createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    return { error: error.message }
  }

  // Signup creates app_user with active: false; an admin must activate it before
  // login. getCurrentUser() filters eq('active', true), so without this check an
  // unactivated user would authenticate then be silently bounced back to /login.
  const { data: appUser } = await supabase
    .from('app_user')
    .select('*')
    .eq('id', data.user?.id ?? '')
    .eq('active', true)
    .single()

  if (!appUser) {
    await supabase.auth.signOut()
    return {
      error:
        'Your email is confirmed, but your account is awaiting admin activation. Please try again once an admin has activated your account.',
    }
  }

  redirect('/legacy')
}
