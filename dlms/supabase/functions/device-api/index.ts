import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const DEVICE_API_KEY = Deno.env.get('DEVICE_API_KEY') ?? ''

// System actor for audit attribution. Every write is attributed to this app_user
// (role 'system', seeded by migration 20260710120200_device_api_system_actor).
// Overridable per-deployment via the DEVICE_API_ACTOR_ID secret.
const DEVICE_API_ACTOR_ID =
  Deno.env.get('DEVICE_API_ACTOR_ID') ?? '11111111-1111-1111-1111-111111111111'

// CORS: default remains '*' because the API's callers are unknown (external
// integrations authenticate with a static X-API-Key, not cookies, so '*' does not
// enable credentialed cross-origin abuse). Set the DEVICE_API_ALLOWED_ORIGIN
// secret to lock the API down to a single origin once the callers are identified.
const ALLOWED_ORIGIN = Deno.env.get('DEVICE_API_ALLOWED_ORIGIN') ?? '*'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
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

// ---------------------------------------------------------------------------
// Request-body validation — mirrors lib/domain/validation.ts deviceSchema:
// pcba_a_sn / pcba_a_hw_rev / pcba_a_bom_rev / pcba_a_fw_ver / status / phase are
// required non-empty strings; the remaining fields are optional strings; qty is a
// non-negative integer; dates must be ISO YYYY-MM-DD.
// ---------------------------------------------------------------------------
const REQUIRED_FIELDS = [
  'pcba_a_sn', 'pcba_a_hw_rev', 'pcba_a_bom_rev', 'pcba_a_fw_ver', 'status', 'phase',
] as const

const OPTIONAL_STRING_FIELDS = [
  'device_sn', 'product_name', 'model_no',
  'pcba_b_sn', 'pcba_b_hw_rev', 'pcba_b_bom_rev', 'pcba_b_fw_ver',
  'screen_model', 'hmi_ver', 'destination', 'customer', 'remarks',
] as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

type Validated = { input: Record<string, unknown>; errors: Record<string, string> }

function validateDeviceBody(body: Record<string, unknown>): Validated {
  const errors: Record<string, string> = {}
  const input: Record<string, unknown> = {}

  for (const f of REQUIRED_FIELDS) {
    const v = body[f]
    if (typeof v !== 'string' || v.trim() === '') {
      errors[f] = `${f} is required`
    } else {
      input[f] = v.trim()
    }
  }

  for (const f of OPTIONAL_STRING_FIELDS) {
    const v = body[f]
    if (v == null) {
      input[f] = null
    } else if (typeof v !== 'string') {
      errors[f] = `${f} must be a string`
    } else {
      // remarks preserved verbatim (multiline/Chinese); other fields trimmed
      const s = f === 'remarks' ? v : v.trim()
      input[f] = s === '' ? null : s
    }
  }

  for (const f of ['build_date', 'ship_date'] as const) {
    const v = body[f]
    if (v == null || v === '') {
      input[f] = null
    } else if (typeof v !== 'string' || !ISO_DATE.test(v) || isNaN(Date.parse(v))) {
      errors[f] = `${f} must be an ISO date (YYYY-MM-DD)`
    } else {
      input[f] = v
    }
  }

  const qty = body.qty
  if (qty == null || qty === '') {
    input.qty = null
  } else if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0) {
    errors.qty = 'qty must be a non-negative integer'
  } else {
    input.qty = qty
  }

  return { input, errors }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // API key auth (static X-API-Key — auth model unchanged pending product decision)
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
        const term = normalizeSerial(q) // already [A-Z0-9]-safe
        // Strip PostgREST filter-syntax chars from q before embedding in the or() string
        const safeQ = q.replace(/[,.()"'\\{}\[\]]/g, ' ').trim()
        if (safeQ) {
          query = query.or(
            `pcba_a_sn_normalized.ilike.%${term}%,device_sn_normalized.ilike.%${term}%,customer.ilike.%${safeQ}%,model_no.ilike.%${safeQ}%`
          )
        } else if (term) {
          query = query.or(
            `pcba_a_sn_normalized.ilike.%${term}%,device_sn_normalized.ilike.%${term}%`
          )
        }
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

      // 1. Field validation mirroring deviceSchema
      const { input, errors } = validateDeviceBody(body)
      if (Object.keys(errors).length > 0) {
        return json({ error: 'Validation failed', errors }, 400)
      }

      // 2. Vocabulary validation against the LIVE status/phase tables (clear 400
      //    instead of an opaque foreign-key violation; admin-added codes pass).
      const [{ data: statusOpts, error: sErr }, { data: phaseOpts, error: pErr }] =
        await Promise.all([
          supabase.from('status_option').select('code, active'),
          supabase.from('phase_option').select('code, active'),
        ])
      if (sErr || pErr) throw (sErr ?? pErr)

      const vocabErrors: Record<string, string> = {}
      if (statusOpts?.length && !statusOpts.some((s) => s.code === input.status)) {
        const active = statusOpts.filter((s) => s.active).map((s) => s.code)
        vocabErrors.status = `"${input.status}" is not a valid status. Valid options: ${active.join(', ')}`
      }
      if (phaseOpts?.length && !phaseOpts.some((p) => p.code === input.phase)) {
        const active = phaseOpts.filter((p) => p.active).map((p) => p.code)
        vocabErrors.phase = `"${input.phase}" is not a valid phase. Valid options: ${active.join(', ')}`
      }
      if (Object.keys(vocabErrors).length > 0) {
        return json({ error: 'Validation failed', errors: vocabErrors }, 400)
      }

      // 3. System actor must exist (device.created_by is NOT NULL → the previous
      //    created_by: null insert could never succeed; fn_audit reads the actor
      //    from created_by/updated_by, so this also fixes actor-less audit rows).
      const { data: actor } = await supabase
        .from('app_user')
        .select('id')
        .eq('id', DEVICE_API_ACTOR_ID)
        .maybeSingle()
      if (!actor) {
        console.error(`device-api: system actor ${DEVICE_API_ACTOR_ID} not found in app_user`)
        return json({ error: 'API misconfigured: system actor missing. Contact an administrator.' }, 500)
      }

      // 4. Duplicate check
      const normalized = normalizeSerial(input.pcba_a_sn as string)
      const { data: existing } = await supabase
        .from('device')
        .select('id')
        .eq('pcba_a_sn_normalized', normalized)
        .is('deleted_at', null)
        .maybeSingle()

      if (existing) {
        return json({ error: 'Device with this PCBA-A S/N already exists', existingId: existing.id }, 409)
      }

      // 5. Insert, attributed to the system actor. Normalized columns and version
      //    are maintained by the fn_device_touch trigger — not set here.
      const { data: created, error: insertError } = await supabase
        .from('device')
        .insert({
          ...input,
          created_by: DEVICE_API_ACTOR_ID,
          updated_by: DEVICE_API_ACTOR_ID,
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

// Secrets (Supabase dashboard → Project Settings → Edge Functions → Secrets):
//   DEVICE_API_KEY            — static API key (required)
//                               npx supabase secrets set DEVICE_API_KEY=<strong random key>
//   DEVICE_API_ACTOR_ID       — app_user uuid for audit attribution
//                               (default: 11111111-1111-1111-1111-111111111111,
//                                seeded by migration 20260710120200)
//   DEVICE_API_ALLOWED_ORIGIN — CORS origin lock-down (default: '*')
