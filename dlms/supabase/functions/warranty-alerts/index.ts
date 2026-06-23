import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
    const today = new Date().toISOString().split('T')[0]
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0]

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
    const { data: alreadyNotified, error: notifError } = await supabase
      .from('warranty_notification')
      .select('device_id')

    if (notifError) throw notifError
    const notifiedIds = new Set((alreadyNotified ?? []).map((r: { device_id: string }) => r.device_id))
    const fresh = expiring.filter((d: { id: string }) => !notifiedIds.has(d.id))

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

/** Escape HTML special characters to prevent XSS in email body */
function esc(s: string | null): string {
  if (s == null) return '—'
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildWarrantyHtml(
  devices: Array<{ device_sn: string | null; model_no: string | null; ship_date: string | null; warranty_expiry: string | null }>
): string {
  const rows = devices
    .map(d => `
      <tr>
        <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb; font-family: monospace;">${esc(d.device_sn)}</td>
        <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb;">${esc(d.model_no)}</td>
        <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb;">${esc(d.ship_date)}</td>
        <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600; color: #b45309;">${esc(d.warranty_expiry)}</td>
      </tr>`)
    .join('')

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>DLMS Warranty Alert</title></head>
<body style="font-family: -apple-system, sans-serif; color: #111; background: #f9fafb; padding: 32px;">
  <div style="max-width: 640px; margin: 0 auto; background: white; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
      <span style="font-size: 24px;">⚠️</span>
      <h1 style="font-size: 20px; margin: 0;">Warranty Expiry Alert</h1>
    </div>
    <p style="color: #6b7280; font-size: 13px; margin-bottom: 24px;">
      ${devices.length} device${devices.length !== 1 ? 's have' : ' has'} warranty expiring within the next 7 days.
    </p>

    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
      <thead>
        <tr style="background: #fef3c7;">
          <th style="padding: 8px 12px; text-align: left; font-weight: 600;">Device S/N</th>
          <th style="padding: 8px 12px; text-align: left; font-weight: 600;">Model</th>
          <th style="padding: 8px 12px; text-align: left; font-weight: 600;">Ship Date</th>
          <th style="padding: 8px 12px; text-align: left; font-weight: 600;">Warranty Expiry</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="font-size: 12px; color: #9ca3af; text-align: center; margin-top: 24px;">
      DLMS · Device Lifecycle Management System
    </p>
  </div>
</body>
</html>`
}
