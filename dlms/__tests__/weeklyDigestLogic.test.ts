import {
  aggregateDigest,
  buildDigestHtml,
  digestSinceDate,
} from '../supabase/functions/weekly-digest/logic'

// Behavior-preservation tests for the weekly-digest pure logic that was lifted
// verbatim out of the Deno handler (index.ts) into logic.ts.

describe('aggregateDigest', () => {
  it('sums created/completed from throughput and device_count from distribution', () => {
    const distribution = [
      { status: 'active', status_label_en: 'Active', device_count: 10, unit_count: 40 },
      { status: 'repair', status_label_en: 'Repair', device_count: 5, unit_count: 12 },
    ]
    const throughput = [
      { day: '2026-07-14', devices_created: 3, devices_completed: 2 },
      { day: '2026-07-13', devices_created: 4, devices_completed: 1 },
    ]
    expect(aggregateDigest(distribution, throughput)).toEqual({
      totalCreated: 7,
      totalCompleted: 3,
      totalActive: 15,
    })
  })

  it('returns all zeros for empty inputs (the "no activity" contract)', () => {
    expect(aggregateDigest([], [])).toEqual({
      totalCreated: 0,
      totalCompleted: 0,
      totalActive: 0,
    })
  })

  it('coalesces null numeric fields to zero', () => {
    const distribution = [{ device_count: null }]
    const throughput = [
      { devices_created: null, devices_completed: 5 },
      { devices_created: 2, devices_completed: null },
    ]
    expect(aggregateDigest(distribution, throughput)).toEqual({
      totalCreated: 2,
      totalCompleted: 5,
      totalActive: 0,
    })
  })
})

describe('buildDigestHtml', () => {
  const base = {
    distribution: [
      { status: 'active', status_label_en: 'Active', device_count: 10, unit_count: 40 },
      { status: 'repair', status_label_en: 'In Repair', device_count: 5, unit_count: 12 },
    ],
    totalCreated: 7,
    totalCompleted: 3,
    totalActive: 15,
  }

  it('renders the three summary totals', () => {
    const html = buildDigestHtml(base)
    expect(html).toContain('>7</div>')
    expect(html).toContain('>3</div>')
    expect(html).toContain('>15</div>')
    expect(html).toContain('Devices Created')
    expect(html).toContain('Devices Completed')
    expect(html).toContain('Active Devices')
  })

  it('renders one row per distribution entry with its label and counts', () => {
    const html = buildDigestHtml(base)
    expect(html).toContain('Active')
    expect(html).toContain('In Repair')
    expect(html).toContain('>40</td>')
    expect(html).toContain('>12</td>')
  })

  it('includes the digest heading and "Week ending" line', () => {
    const html = buildDigestHtml(base)
    expect(html).toContain('DLMS Weekly Digest')
    expect(html).toContain('Week ending')
  })

  it('still produces valid HTML with zero totals and an empty distribution', () => {
    const html = buildDigestHtml({
      distribution: [],
      totalCreated: 0,
      totalCompleted: 0,
      totalActive: 0,
    })
    expect(html).toContain('<tbody></tbody>')
    expect(html).toContain('>0</div>')
  })

  it('escapes status_label_en so a hostile label cannot inject markup', () => {
    // Matches the warranty builder: every interpolated value is HTML-escaped even
    // though status labels come from the controlled v_current_distribution view.
    // Belt-and-suspenders against a future data-source change opening an injection
    // hole in the email body.
    const html = buildDigestHtml({
      distribution: [
        { status: 'x', status_label_en: '<script>alert(1)</script>', device_count: 1, unit_count: 1 },
      ],
      totalCreated: 0,
      totalCompleted: 0,
      totalActive: 0,
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

describe('digestSinceDate', () => {
  it('returns a YYYY-MM-DD stamp', () => {
    expect(digestSinceDate(new Date('2026-07-15T12:00:00.000Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    )
  })

  it('returns the date 7 days earlier, preserving the original setDate math', () => {
    // Anchored to the exact inline computation the handler used before extraction
    // (local-time getDate/setDate then toISOString), so the assertion is stable
    // across timezones and guards against any change to the offset semantics.
    const now = new Date('2026-07-15T12:00:00.000Z')
    const anchor = new Date(now.getTime())
    anchor.setDate(anchor.getDate() - 7)
    expect(digestSinceDate(now)).toBe(anchor.toISOString().split('T')[0])
  })

  it('crosses a month boundary correctly', () => {
    const now = new Date('2026-07-03T12:00:00.000Z')
    const anchor = new Date(now.getTime())
    anchor.setDate(anchor.getDate() - 7)
    expect(digestSinceDate(now)).toBe(anchor.toISOString().split('T')[0])
  })

  it('does not mutate the Date passed in', () => {
    const now = new Date('2026-07-15T12:00:00.000Z')
    const before = now.getTime()
    digestSinceDate(now)
    expect(now.getTime()).toBe(before)
  })
})
