import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildWarrantyHtml, filterFreshDevices, toDateStamp } from './logic.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const FROM_EMAIL = Deno.env.get('WARRANTY_FROM_EMAIL') ?? 'alerts@example.com'

serve(async (req) => {
  // Basic auth check: only allow calls with service role bearer
  const auth = req.headers.get('Authorization') ?? ''
  if (!SUPABASE_SERVICE_ROLE_KEY || auth !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  // Validate RESEND_API_KEY before any DB queries
  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY is not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // 1. Get recipients: all active engineers + admins
    const { data: recipients, error: recipError } = await supabase
      .from('app_user')
      .select('email')
      .in('role', ['engineer', 'admin'])
      .eq('active', true)

    if (recipError) throw recipError
    if (!recipients || recipients.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No active recipients' }), { status: 200 })
    }

    // 2. Get devices expiring within 7 days
    const today = toDateStamp(new Date())
    const future = toDateStamp(new Date(Date.now() + 7 * 86_400_000))

    const { data: expiring, error: expiryError } = await supabase
      .from('device')
      .select('id, device_sn, model_no, ship_date, warranty_expiry')
      .is('deleted_at', null)
      .gte('warranty_expiry', today)
      .lte('warranty_expiry', future)

    if (expiryError) throw expiryError
    if (!expiring || expiring.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No devices expiring within 7 days' }), { status: 200 })
    }

    // 3. De-duplicate: filter out devices already notified
    const expiringIds = expiring.map((d: { id: string }) => d.id)
    const { data: alreadyNotified, error: notifError } = await supabase
      .from('warranty_notification')
      .select('device_id')
      .in('device_id', expiringIds)

    if (notifError) throw notifError
    const fresh = filterFreshDevices(expiring, alreadyNotified)

    if (fresh.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'All expiring devices already notified' }), { status: 200 })
    }

    // 4. Build HTML email
    const html = buildWarrantyHtml(fresh)

    // 5. Send to each recipient
    let sent = 0
    const failures: string[] = []
    for (const { email } of recipients) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: email,
          subject: `DLMS Warranty Alert — ${fresh.length} device${fresh.length !== 1 ? 's' : ''} expiring within 7 days`,
          html,
        }),
      })
      if (res.ok) {
        sent++
      } else {
        const body = await res.text()
        console.error(`Failed to send warranty alert to ${email}: ${res.status} ${body}`)
        failures.push(email)
      }
    }

    // 6. Record notified devices (only if at least one email succeeded)
    if (sent > 0) {
      const rows = fresh.map((d: { id: string }) => ({ device_id: d.id }))
      const { error: insertError } = await supabase
        .from('warranty_notification')
        .upsert(rows, { onConflict: 'device_id' })
      if (insertError) {
        console.error('Failed to record warranty_notification rows:', insertError.message)
        // Non-fatal: emails already sent; next run will re-notify but that is preferable to silent failure
      }
    }

    return new Response(
      JSON.stringify({ sent, total: recipients.length, devices: fresh.length, failures }),
      { status: failures.length > 0 ? 207 : 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
