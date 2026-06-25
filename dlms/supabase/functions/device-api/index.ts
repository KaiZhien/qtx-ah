import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const DEVICE_API_KEY = Deno.env.get('DEVICE_API_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function normalizeSerial(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // API key auth
  const apiKey = req.headers.get('X-API-Key') ?? ''
  if (!DEVICE_API_KEY || apiKey !== DEVICE_API_KEY) {
    return json({ error: 'Unauthorized — provide a valid X-API-Key header' }, 401)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const url = new URL(req.url)

  try {
    // GET — list devices
    if (req.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const status = url.searchParams.get('status') ?? ''
      const phase = url.searchParams.get('phase') ?? ''
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10))
      const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20', 10)))
      const from = (page - 1) * pageSize
      const to = from + pageSize - 1

      let query = supabase
        .from('device')
        .select('*', { count: 'exact' })
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(from, to)

      if (q) {
        const term = normalizeSerial(q)
        query = query.or(
          `pcba_a_sn_normalized.ilike.%${term}%,device_sn_normalized.ilike.%${term}%,customer.ilike.%${q}%,model_no.ilike.%${q}%`
        )
      }
      if (status) query = query.eq('status', status)
      if (phase) query = query.eq('phase', phase)

      const { data, error, count } = await query
      if (error) throw error

      return json({ data, total: count ?? 0, page, pageSize })
    }

    // POST — create device
    if (req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return json({ error: 'Invalid JSON body' }, 400)
      }

      const pcbaASn = typeof body.pcba_a_sn === 'string' ? body.pcba_a_sn.trim() : ''
      if (!pcbaASn) {
        return json({ error: 'pcba_a_sn is required' }, 400)
      }
      if (!body.status || !body.phase) {
        return json({ error: 'status and phase are required' }, 400)
      }

      // Duplicate check
      const normalized = normalizeSerial(pcbaASn)
      const { data: existing } = await supabase
        .from('device')
        .select('id')
        .eq('pcba_a_sn_normalized', normalized)
        .is('deleted_at', null)
        .maybeSingle()

      if (existing) {
        return json({ error: 'Device with this PCBA-A S/N already exists', existingId: existing.id }, 409)
      }

      // Insert
      const { data: created, error: insertError } = await supabase
        .from('device')
        .insert({
          pcba_a_sn: pcbaASn,
          pcba_a_sn_normalized: normalized,
          status: body.status,
          phase: body.phase,
          device_sn: body.device_sn ?? null,
          device_sn_normalized: typeof body.device_sn === 'string'
            ? normalizeSerial(body.device_sn)
            : null,
          model_no: body.model_no ?? null,
          product_name: body.product_name ?? null,
          customer: body.customer ?? null,
          destination: body.destination ?? null,
          qty: typeof body.qty === 'number' ? body.qty : null,
          remarks: body.remarks ?? null,
          version: 1,
          created_by: null,
          updated_by: null,
        })
        .select('id, pcba_a_sn, status, phase')
        .single()

      if (insertError) throw insertError

      return json(created, 201)
    }

    return json({ error: 'Method not allowed' }, 405)
  } catch (err) {
    console.error('device-api error:', err)
    return json({ error: String(err) }, 500)
  }
})

// To set the API key secret:
// npx supabase secrets set DEVICE_API_KEY=<generate a strong random key>
// Or via Supabase dashboard → Project Settings → Edge Functions → Secrets
