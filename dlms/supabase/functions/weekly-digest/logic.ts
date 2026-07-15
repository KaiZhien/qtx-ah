// Pure logic for the weekly-digest edge function.
// No Deno globals, no URL imports, no network/env — plain data-in/data-out TS
// so it is importable by both Deno (index.ts) and vitest (Node).

/**
 * Sum the digest totals over the last-7-days throughput rows and the current
 * distribution rows. Lifted verbatim from the handler's step 3 reduces; the
 * `?? []` null-guards stay at the call site so behavior is identical.
 */
export function aggregateDigest(
  distribution: Array<{ device_count: number | null }>,
  throughput: Array<{ devices_created: number | null; devices_completed: number | null }>
): { totalCreated: number; totalCompleted: number; totalActive: number } {
  const totalCreated = throughput.reduce((s, r) => s + (r.devices_created ?? 0), 0)
  const totalCompleted = throughput.reduce((s, r) => s + (r.devices_completed ?? 0), 0)
  const totalActive = distribution.reduce((s, r) => s + (r.device_count ?? 0), 0)
  return { totalCreated, totalCompleted, totalActive }
}

/**
 * Compute the `YYYY-MM-DD` lower bound (now minus 7 days, UTC) used for the
 * throughput window `.gte('day', ...)`. The clock read stays in the handler and
 * is passed in; the copy-and-`setDate` matches the original mutation exactly.
 */
export function digestSinceDate(now: Date): string {
  const d = new Date(now.getTime())
  d.setDate(d.getDate() - 7)
  return d.toISOString().split('T')[0]
}

export function buildDigestHtml({
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
