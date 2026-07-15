import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { aggregateDigest, buildDigestHtml, digestSinceDate } from './logic.ts'

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

  // Validate RESEND_API_KEY before any DB queries
  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY is not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
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
    const sinceDate = digestSinceDate(new Date())

    const { data: throughput, error: tpError } = await supabase
      .from('v_daily_throughput')
      .select('day, devices_created, devices_completed')
      .gte('day', sinceDate)
      .order('day', { ascending: false })

    if (tpError) throw tpError

    const { totalCreated, totalCompleted, totalActive } = aggregateDigest(distribution ?? [], throughput ?? [])

    // 4. Build HTML email
    const html = buildDigestHtml({ distribution: distribution ?? [], totalCreated, totalCompleted, totalActive })

    // 5. Send to each subscriber
    let sent = 0
    const failures: string[] = []
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
      if (res.ok) {
        sent++
      } else {
        const body = await res.text()
        console.error(`Failed to send digest to ${email}: ${res.status} ${body}`)
        failures.push(email)
      }
    }

    return new Response(
      JSON.stringify({ sent, total: subscribers.length, failures }),
      { status: failures.length > 0 ? 207 : 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
