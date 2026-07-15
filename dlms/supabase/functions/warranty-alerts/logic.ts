// Pure logic for the warranty-alerts edge function.
// No Deno globals, no URL imports, no network/env — plain data-in/data-out TS
// so it is importable by both Deno (index.ts) and vitest (Node).

/** Escape HTML special characters to prevent XSS in email body */
export function esc(s: string | null): string {
  if (s == null) return '—'
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildWarrantyHtml(
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

/**
 * De-duplicate expiring devices against those already notified.
 * Lifted verbatim from the handler's step 3 (Set-build + filter); the
 * `alreadyNotified ?? []` null-guard is preserved so behavior is identical.
 */
export function filterFreshDevices<T extends { id: string }>(
  expiring: T[],
  alreadyNotified: Array<{ device_id: string }> | null | undefined
): T[] {
  const notifiedIds = new Set((alreadyNotified ?? []).map((r: { device_id: string }) => r.device_id))
  return expiring.filter((d: { id: string }) => !notifiedIds.has(d.id))
}

/**
 * Format a Date to a `YYYY-MM-DD` UTC date stamp (the `toISOString().split('T')[0]`
 * transform used for the warranty window bounds). The clock reads themselves stay
 * in the handler so the double-`new Date()` timing is preserved byte-for-byte.
 */
export function toDateStamp(d: Date): string {
  return d.toISOString().split('T')[0]
}
