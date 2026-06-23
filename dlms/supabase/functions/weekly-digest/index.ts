import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const FROM_EMAIL = Deno.env.get('DIGEST_FROM_EMAIL') ?? 'digest@example.com'

serve(async (req) => {
  // Basic auth check: only allow calls with service role bearer
  const auth = req.headers.get('Authorization') ?? ''
  if (!SUPABASE_SERVICE_ROLE_KEY || auth !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // 1. Get active subscribers
    const { data: subscribers, error: subError } = await supabase
      .from('report_subscriber')
      .select('email')
      .eq('active', true)

    if (subError) throw subError
    if (!subscribers || subscribers.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No active subscribers' }), { status: 200 })
    }

    // 2. Get current device distribution
    const { data: distribution, error: distError } = await supabase
      .from('v_current_distribution')
      .select('status, status_label_en, device_count, unit_count')
      .order('device_count', { ascending: false })

    if (distError) throw distError

    // 3. Get throughput for last 7 days
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const sinceDate = sevenDaysAgo.toISOString().split('T')[0]

    const { data: throughput, error: tpError } = await supabase
      .from('v_daily_throughput')
      .select('day, devices_created, devices_completed')
      .gte('day', sinceDate)
      .order('day', { ascending: false })

    if (tpError) throw tpError

    const totalCreated = (throughput ?? []).reduce((s, r) => s + (r.devices_created ?? 0), 0)
    const totalCompleted = (throughput ?? []).reduce((s, r) => s + (r.devices_completed ?? 0), 0)
    const totalActive = (distribution ?? []).reduce((s, r) => s + (r.device_count ?? 0), 0)

    // 4. Build HTML email
    const html = buildDigestHtml({ distribution: distribution ?? [], totalCreated, totalCompleted, totalActive })

    // 5. Send to each subscriber
    let sent = 0
    for (const { email } of subscribers) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: email,
          subject: `DLMS Weekly Digest — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
          html,
        }),
      })
      if (res.ok) sent++
    }

    return new Response(JSON.stringify({ sent, total: subscribers.length }), { status: 200 })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

function buildDigestHtml({
  distribution,
  totalCreated,
  totalCompleted,
  totalActive,
}: {
  distribution: Array<{ status: string; status_label_en: string; device_count: number; unit_count: number }>
  totalCreated: number
  totalCompleted: number
  totalActive: number
}): string {
  const rows = distribution
    .map(r => `
      <tr>
        <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb;">${r.status_label_en}</td>
        <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${r.device_count}</td>
        <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${r.unit_count}</td>
      </tr>`)
    .join('')

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>DLMS Weekly Digest</title></head>
<body style="font-family: -apple-system, sans-serif; color: #111; background: #f9fafb; padding: 32px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <h1 style="font-size: 20px; margin-bottom: 4px;">DLMS Weekly Digest</h1>
    <p style="color: #6b7280; font-size: 13px; margin-bottom: 24px;">
      Week ending ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
    </p>

    <h2 style="font-size: 15px; margin-bottom: 12px;">7-Day Summary</h2>
    <div style="display: flex; gap: 24px; margin-bottom: 24px;">
      <div style="background: #f0f9ff; padding: 16px; border-radius: 6px; flex: 1; text-align: center;">
        <div style="font-size: 28px; font-weight: bold; color: #0369a1;">${totalCreated}</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Devices Created</div>
      </div>
      <div style="background: #f0fdf4; padding: 16px; border-radius: 6px; flex: 1; text-align: center;">
        <div style="font-size: 28px; font-weight: bold; color: #15803d;">${totalCompleted}</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Devices Completed</div>
      </div>
      <div style="background: #fafafa; padding: 16px; border-radius: 6px; flex: 1; text-align: center;">
        <div style="font-size: 28px; font-weight: bold; color: #374151;">${totalActive}</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Active Devices</div>
      </div>
    </div>

    <h2 style="font-size: 15px; margin-bottom: 12px;">Status Distribution</h2>
    <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px;">
      <thead>
        <tr style="background: #f3f4f6;">
          <th style="padding: 8px 12px; text-align: left; font-weight: 600;">Status</th>
          <th style="padding: 8px 12px; text-align: right; font-weight: 600;">Devices</th>
          <th style="padding: 8px 12px; text-align: right; font-weight: 600;">Units</th>
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
