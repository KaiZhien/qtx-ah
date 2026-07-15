import {
  esc,
  buildWarrantyHtml,
  filterFreshDevices,
  toDateStamp,
} from '../supabase/functions/warranty-alerts/logic'

// Behavior-preservation tests for the warranty-alerts pure logic that was
// lifted verbatim out of the Deno handler (index.ts) into logic.ts.

describe('esc', () => {
  it('escapes ampersand first so nothing double-escapes', () => {
    expect(esc('&')).toBe('&amp;')
    // Ampersand must be replaced before the entity ampersands are introduced.
    expect(esc('<')).toBe('&lt;')
    expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('escapes each HTML special character', () => {
    expect(esc('<')).toBe('&lt;')
    expect(esc('>')).toBe('&gt;')
    expect(esc('"')).toBe('&quot;')
    expect(esc("'")).toBe('&#39;')
  })

  it('neutralizes a hostile script payload', () => {
    expect(esc('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    )
  })

  it('returns an em dash for null', () => {
    expect(esc(null)).toBe('—')
  })

  it('leaves ordinary text untouched', () => {
    expect(esc('EE-02A-2603-0001')).toBe('EE-02A-2603-0001')
  })
})

describe('buildWarrantyHtml', () => {
  const device = {
    device_sn: 'EE-02A-2603-0001',
    model_no: 'M-100',
    ship_date: '2024-01-15',
    warranty_expiry: '2026-07-20',
  }

  it('renders each device field into the row', () => {
    const html = buildWarrantyHtml([device])
    expect(html).toContain('EE-02A-2603-0001')
    expect(html).toContain('M-100')
    expect(html).toContain('2024-01-15')
    expect(html).toContain('2026-07-20')
  })

  it('escapes a hostile device name so no live markup reaches the email', () => {
    const html = buildWarrantyHtml([
      { ...device, device_sn: '<script>alert(1)</script>' },
    ])
    // The raw payload must NOT survive; the escaped form must be present.
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes quotes that could break out of an attribute', () => {
    const html = buildWarrantyHtml([
      { ...device, model_no: 'x" onmouseover="evil()' },
    ])
    expect(html).not.toContain('x" onmouseover="evil()')
    expect(html).toContain('x&quot; onmouseover=&quot;evil()')
  })

  it('renders null fields as an em dash', () => {
    const html = buildWarrantyHtml([
      { device_sn: null, model_no: null, ship_date: null, warranty_expiry: null },
    ])
    expect(html).toContain('—')
  })

  it('uses singular phrasing for exactly one device', () => {
    const html = buildWarrantyHtml([device])
    expect(html).toContain('1 device has warranty expiring within the next 7 days.')
  })

  it('uses plural phrasing for multiple devices', () => {
    const html = buildWarrantyHtml([device, device])
    expect(html).toContain('2 devices have warranty expiring within the next 7 days.')
  })

  it('produces an empty table body for an empty device list', () => {
    // The handler never calls this with an empty list (it suppresses upstream via
    // filterFreshDevices), but pin the output shape all the same.
    const html = buildWarrantyHtml([])
    expect(html).toContain('<tbody></tbody>')
    expect(html).toContain('0 devices have warranty expiring within the next 7 days.')
  })
})

describe('filterFreshDevices', () => {
  const a = { id: 'a', device_sn: 'SN-A' }
  const b = { id: 'b', device_sn: 'SN-B' }
  const c = { id: 'c', device_sn: 'SN-C' }

  it('keeps every device when none were previously notified', () => {
    expect(filterFreshDevices([a, b, c], [])).toEqual([a, b, c])
  })

  it('drops every device when all were already notified (drives suppression)', () => {
    const result = filterFreshDevices(
      [a, b, c],
      [{ device_id: 'a' }, { device_id: 'b' }, { device_id: 'c' }]
    )
    expect(result).toEqual([])
  })

  it('keeps only the devices not yet notified', () => {
    const result = filterFreshDevices([a, b, c], [{ device_id: 'b' }])
    expect(result).toEqual([a, c])
  })

  it('treats null alreadyNotified as none notified', () => {
    expect(filterFreshDevices([a, b], null)).toEqual([a, b])
  })

  it('treats undefined alreadyNotified as none notified', () => {
    expect(filterFreshDevices([a, b], undefined)).toEqual([a, b])
  })

  it('preserves the original device objects (full shape) in the result', () => {
    const result = filterFreshDevices([a, b], [{ device_id: 'a' }])
    expect(result[0]).toBe(b)
  })
})

describe('toDateStamp', () => {
  it('formats a Date to a YYYY-MM-DD UTC stamp', () => {
    expect(toDateStamp(new Date('2026-07-15T00:00:00.000Z'))).toBe('2026-07-15')
  })

  it('uses the UTC calendar date regardless of the time of day', () => {
    expect(toDateStamp(new Date('2026-07-15T23:59:59.999Z'))).toBe('2026-07-15')
  })

  it('lands 7 calendar days ahead when the handler adds the 7-day offset', () => {
    // The +7*86_400_000 arithmetic itself stays in the handler (it reads the clock
    // twice); this pins the composed window bound the handler builds from it.
    const baseMs = Date.parse('2026-07-15T00:00:00.000Z')
    expect(toDateStamp(new Date(baseMs + 7 * 86_400_000))).toBe('2026-07-22')
  })
})
