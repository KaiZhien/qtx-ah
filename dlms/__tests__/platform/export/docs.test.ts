import { describe, it, expect } from 'vitest'
import {
  buildSchemaMd, buildRelationshipsMd, buildReadmeMd,
} from '@/modules/shared/export/domain/docs'
import { EXPORT_ENTITIES, DEFERRED_EXPORT_PARTS } from '@/modules/shared/export/domain/entities'
import { buildManifest, describeFile } from '@/modules/shared/export/domain/manifest'
import { assertExportCeremony, ExportMfaRequiredError }
  from '@/modules/shared/export/services/exportService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

describe('EXPORT_ENTITIES registry', () => {
  it('names each table exactly once', () => {
    const t = EXPORT_ENTITIES.map((e) => e.table)
    expect(new Set(t).size).toBe(t.length)
  })

  it('gives every entity columns, an order and a description', () => {
    for (const e of EXPORT_ENTITIES) {
      expect(e.columns.length, `${e.table} has no columns`).toBeGreaterThan(0)
      expect(e.orderBy, `${e.table} has no ordering`).toBeTruthy()
      expect(e.description, `${e.table} has no description`).toBeTruthy()
    }
  })

  it('never uses a wildcard column', () => {
    for (const e of EXPORT_ENTITIES) expect(e.columns).not.toContain('*')
  })

  it('never repeats a column within one entity', () => {
    for (const e of EXPORT_ENTITIES) {
      expect(new Set(e.columns).size, `${e.table} repeats a column`).toBe(e.columns.length)
    }
  })

  it('covers the hub table and the audit extract spec §12 names', () => {
    const tables = EXPORT_ENTITIES.map((e) => e.table)
    expect(tables).toContain('device')
    expect(tables).toContain('audit_log')
    expect(tables).toContain('component_installation')
    expect(tables).toContain('device_status_history')
  })

  it('ships jsonb-bearing sets as JSON, not CSV', () => {
    // A jsonb column flattened into a CSV cell is a quoted blob no spreadsheet
    // can use and nothing can reliably parse back.
    for (const t of ['audit_log', 'approval', 'outbox', 'auth_event']) {
      expect(EXPORT_ENTITIES.find((e) => e.table === t)?.format, `${t} should be JSON`)
        .toBe('json')
    }
  })

  it('omits ip_address and user_agent from the security sets', () => {
    const auth = EXPORT_ENTITIES.find((e) => e.table === 'auth_event')!
    expect(auth.columns).not.toContain('ip_address')
    expect(auth.columns).not.toContain('user_agent')
    expect(EXPORT_ENTITIES.find((e) => e.table === 'audit_log')!.columns)
      .not.toContain('ip_address')
  })

  it('does not claim an `id` on the composite- and code-keyed tables', () => {
    // status_option/phase_option are keyed by `code`; status_transition by a pair;
    // app_setting by `key`. Selecting a non-existent `id` would fail at runtime.
    for (const t of ['status_option', 'phase_option', 'status_transition', 'app_setting']) {
      expect(EXPORT_ENTITIES.find((e) => e.table === t)!.columns, `${t}`).not.toContain('id')
    }
  })
})

describe('buildSchemaMd', () => {
  const md = buildSchemaMd()

  it('lists every exported entity', () => {
    for (const e of EXPORT_ENTITIES) expect(md).toContain(`\`${e.table}\``)
  })

  it('documents the ordering of each entity', () => {
    expect(md).toContain('Ordered by')
  })

  it('states the CSV encoding contract', () => {
    expect(md).toContain('RFC 4180')
    expect(md).toContain('UTF-8 BOM')
  })

  it('renders a valid markdown table header', () => {
    expect(md).toContain('| File | Format | Columns | Notes |')
  })
})

describe('buildRelationshipsMd — the stable-UUID join documentation (spec §12)', () => {
  const md = buildRelationshipsMd()

  it('says the identifiers are stable UUIDs', () => {
    expect(md).toContain('stable UUID')
  })

  it('maps a plain foreign key to its target', () => {
    expect(md).toContain('`repair.device_id`')
    expect(md).toContain('`device.id`')
  })

  it('maps the person columns to app_user, not to a table called "assignee"', () => {
    expect(md).toContain('`task.assignee_id`')
    expect(md).toMatch(/`task\.assignee_id`[^\n]*`app_user\.id`/)
  })

  it('maps created_by/updated_by to app_user', () => {
    expect(md).toMatch(/`device\.created_by`[^\n]*`app_user\.id`/)
  })

  it('resolves the irregular ones rather than naively trimming _id', () => {
    // invoice_id → sales_invoice, not "invoice"; variant_id → device_variant.
    expect(md).toMatch(/`sales_invoice_line\.invoice_id`[^\n]*`sales_invoice\.id`/)
    expect(md).toMatch(/`device\.variant_id`[^\n]*`device_variant\.id`/)
  })

  it('never emits a self-referential id → id row', () => {
    expect(md).not.toMatch(/`device\.id`\s*\|\s*`device\.id`/)
  })

  it('warns that soft-deleted rows are included', () => {
    expect(md).toContain('deleted_at')
    expect(md).toContain('Soft deletes are included')
  })

  it('flags the polymorphic joins, which a naive join map would get wrong', () => {
    expect(md).toContain('polymorphic')
    expect(md).toContain('task_link')
  })

  it('explains that status is keyed by code, not id', () => {
    expect(md).toContain('status_option.code')
  })
})

describe('buildReadmeMd', () => {
  const manifest = buildManifest({
    exportId: 'abc-123', requestedAt: '2026-08-03T10:00:00.000Z',
    builtAt: '2026-08-03T10:00:05.000Z',
    requestedBy: { id: 'u1', name: 'Reet Mitra', email: 'reet@example.com' },
    appVersion: '0.1.0', schemaVersion: '20260803160000',
    files: [describeFile('csv/device.csv', Buffer.from('x'), { entity: 'device', rowCount: 7 })],
    deferred: [...DEFERRED_EXPORT_PARTS],
  })
  const md = buildReadmeMd(manifest)

  it('identifies the export and who asked for it', () => {
    expect(md).toContain('abc-123')
    expect(md).toContain('Reet Mitra')
    expect(md).toContain('reet@example.com')
  })

  it('states both versions', () => {
    expect(md).toContain('0.1.0')
    expect(md).toContain('20260803160000')
  })

  it('quotes the totals from the manifest', () => {
    expect(md).toContain('7 rows')
  })

  it('tells the recipient how to verify a file', () => {
    expect(md).toContain('sha256')
    expect(md).toContain('shasum -a 256')
  })

  it('warns about the spreadsheet-formula values it deliberately did not alter', () => {
    expect(md).toContain('verbatim')
    expect(md).toMatch(/formula/i)
  })

  it('says the data is unredacted and why', () => {
    expect(md).toMatch(/unredacted/i)
    expect(md).toMatch(/ceremony/i)
  })

  it('lists every deferred part, so an absent attachments/ is not read as "no files"', () => {
    expect(md).toMatch(/attachments/)
    for (const d of DEFERRED_EXPORT_PARTS) {
      expect(md).toContain(d.split(' — ')[0])
    }
  })

  it('does not promise an S3 link or a passphrase this build cannot deliver', () => {
    expect(md).not.toMatch(/s3:\/\/qtx-ops-exports\/\{job\}\/ *$/m)
    expect(md).not.toMatch(/your passphrase is/i)
  })
})

describe('assertExportCeremony — Super Admin + fresh MFA (spec §12)', () => {
  const now = new Date('2026-08-03T10:00:00Z')
  const freshTotp = [{ method: 'totp', timestamp: new Date(now.getTime() - 30_000).toISOString() }]
  const staleTotp = [{ method: 'totp', timestamp: new Date(now.getTime() - 9_000_000).toISOString() }]

  const actor = (over: Partial<Actor> = {}): Actor => ({
    id: 'u1', roleKey: 'super_admin',
    permissions: new Set<Permission>(['request_full_export']),
    moduleAccess: new Set<ModuleKey>(['admin']),
    active: true,
    ...over,
  })

  it('admits a Super Admin with a freshly-completed second factor', () => {
    expect(() => assertExportCeremony(actor(), freshTotp, now)).not.toThrow()
  })

  it('refuses an actor without request_full_export', () => {
    const noPerm = actor({ permissions: new Set<Permission>(['view_records']) })
    expect(() => assertExportCeremony(noPerm, freshTotp, now)).toThrow(PermissionError)
  })

  it('checks the PERMISSION BEFORE the MFA freshness', () => {
    // An actor who may not export at all must not be told "your MFA is stale",
    // which would confirm the capability exists and is merely out of reach.
    const noPerm = actor({ permissions: new Set<Permission>(['view_records']) })
    expect(() => assertExportCeremony(noPerm, staleTotp, now)).toThrow(PermissionError)
  })

  it('refuses a permitted actor whose second factor is stale', () => {
    expect(() => assertExportCeremony(actor(), staleTotp, now)).toThrow(ExportMfaRequiredError)
  })

  it('refuses a permitted actor with no second factor at all', () => {
    const passwordOnly = [{ method: 'password', timestamp: now.toISOString() }]
    expect(() => assertExportCeremony(actor(), passwordOnly, now)).toThrow(ExportMfaRequiredError)
  })

  it('FAILS CLOSED when the auth methods cannot be read', () => {
    expect(() => assertExportCeremony(actor(), null, now)).toThrow(ExportMfaRequiredError)
    expect(() => assertExportCeremony(actor(), undefined, now)).toThrow(ExportMfaRequiredError)
  })

  it('refuses a DEACTIVATED super admin, whatever their grants', () => {
    expect(() => assertExportCeremony(actor({ active: false }), freshTotp, now))
      .toThrow(PermissionError)
  })

  it('tells the user what to do rather than what broke', () => {
    expect(() => assertExportCeremony(actor(), staleTotp, now))
      .toThrow(/authenticator code/i)
  })
})
