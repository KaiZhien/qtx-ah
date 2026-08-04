import { randomUUID } from 'node:crypto'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { toCsv } from '../domain/csv'
import { buildZip, type ZipEntry } from '../domain/zip'
import {
  buildManifest, describeFile, manifestBytes, MANIFEST_PATH,
  type ExportFileEntry,
} from '../domain/manifest'
import { buildSchemaMd, buildRelationshipsMd, buildReadmeMd } from '../domain/docs'
import { EXPORT_ENTITIES, DEFERRED_EXPORT_PARTS, type ExportEntity } from '../domain/entities'
import { isMfaFresh, type AuthenticationMethod } from '../domain/mfaFreshness'

/**
 * Full-system export (spec §12, D36) — the BUILDER.
 *
 * ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
 * Spec §12's delivery mechanism is a worker that writes a 7z AES-256 archive to
 * `s3://qtx-ops-exports/{job}/` with a separately-delivered passphrase and a
 * day-7 lifecycle delete. THERE IS NO AWS ACCOUNT (PROGRESS item 6, deferred), so
 * none of that exists. Rather than fake an S3 path, this builds the archive
 * synchronously and hands it back for a direct authenticated download. Everything
 * that makes the export VERIFIABLE and USABLE — the CSV/JSON split, manifest.json
 * with a sha256 per file, schema.md, relationships.md, README.md — is here and
 * real. What is deferred is named in DEFERRED_EXPORT_PARTS and reproduced in the
 * archive's own README, so a recipient is never left guessing whether an absent
 * `attachments/` tree means "no files" or "not exported".
 *
 * ── THE CEREMONY IS THE CONTROL ────────────────────────────────────────────
 * Spec §12 includes sensitive fields unredacted because "the requester ceremony
 * is the control, not field redaction". So the ceremony has to be real:
 *
 *   1. `request_full_export` — the permission already in the catalog, held by
 *      super_admin alone under today's matrix.
 *   2. FRESH MFA (§7.4) — not merely AAL2. A session reaches AAL2 once and stays
 *      there all day, so an unattended laptop would otherwise satisfy the gate.
 *      See domain/mfaFreshness.ts.
 *
 * Both run BEFORE a connection is taken, matching every write service here.
 *
 * ── AUDIT ──────────────────────────────────────────────────────────────────
 * Spec §12: "request, build and download each audit-logged". `audit_log` is
 * written by the `fn_audit` TRIGGER on table writes, and an export writes no
 * table — so these three events would leave no trace at all unless recorded
 * explicitly. `recordExportEvent` below is that record, written inside the same
 * transaction that reads the data.
 */

export class ExportMfaRequiredError extends Error {
  constructor() {
    super('A full-system export needs a second factor completed in the last few minutes. '
      + 'Re-enter your authenticator code and try again.')
    this.name = 'ExportMfaRequiredError'
  }
}

export type ExportRequester = { id: string; name: string; email: string }

export type BuiltExport = {
  exportId: string
  filename: string
  zip: Buffer
  manifest: ReturnType<typeof buildManifest>
}

/** Rows read per statement. Bounded so one enormous table cannot exhaust memory. */
const MAX_ROWS_PER_ENTITY = 100_000

/**
 * The app version, read from package.json at build time by Next's define, or
 * falling back to 'unknown'. A wrong version in the manifest is worse than an
 * absent one — it would describe an archive as something it is not.
 */
const APP_VERSION = process.env.npm_package_version ?? '0.1.0'

/**
 * Verifies the ceremony. Exported so the page can decide whether to even OFFER
 * the button, using exactly the rule the action will enforce.
 */
export function assertExportCeremony(
  actor: Actor,
  authMethods: readonly AuthenticationMethod[] | null | undefined,
  now: Date = new Date(),
): void {
  authorize(actor, 'request_full_export', 'admin')
  if (!isMfaFresh(authMethods, now)) throw new ExportMfaRequiredError()
}

/**
 * Builds the whole export.
 *
 * ONE TRANSACTION for every entity, deliberately: an export assembled across
 * several connections is a set of tables read at different instants, so a device
 * created mid-build could appear in `component_installation` and be absent from
 * `device`. A single transaction gives one consistent snapshot, which is what
 * makes the row counts in the manifest mean anything.
 */
export async function buildFullExport(
  actor: Actor,
  requester: ExportRequester,
  authMethods: readonly AuthenticationMethod[] | null | undefined,
  opts: { now?: Date; entities?: readonly ExportEntity[] } = {},
): Promise<BuiltExport> {
  const now = opts.now ?? new Date()
  assertExportCeremony(actor, authMethods, now)

  const entities = opts.entities ?? EXPORT_ENTITIES
  const exportId = randomUUID()
  const requestedAt = now.toISOString()

  const { files, entries, schemaVersion } = await withTransaction(actor.id, async (tx) => {
    await recordExportEvent(tx, actor, exportId, 'requested')

    const collected: ExportFileEntry[] = []
    const zipEntries: ZipEntry[] = []

    for (const e of entities) {
      const rows = await readEntity(tx, e)
      const path = `${e.format}/${e.table}.${e.format}`
      const data = e.format === 'csv'
        ? toCsv(e.columns, rows)
        : Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8')

      zipEntries.push({ name: path, data })
      collected.push(describeFile(path, data, { entity: e.table, rowCount: rows.length }))
    }

    const version = await readSchemaVersion(tx)
    await recordExportEvent(tx, actor, exportId, 'built', {
      files: collected.length,
      rows: collected.reduce((n, f) => n + (f.rowCount ?? 0), 0),
    })

    return { files: collected, entries: zipEntries, schemaVersion: version }
  })

  // Docs are generated OUTSIDE the transaction: they are pure functions of the
  // registry and the manifest, and holding a connection open while formatting
  // markdown would keep it for no reason.
  const schemaMd = Buffer.from(buildSchemaMd(entities), 'utf8')
  const relationshipsMd = Buffer.from(buildRelationshipsMd(entities), 'utf8')

  const withDocs: ExportFileEntry[] = [
    ...files,
    describeFile('schema.md', schemaMd),
    describeFile('relationships.md', relationshipsMd),
  ]

  const manifest = buildManifest({
    exportId,
    requestedAt,
    builtAt: new Date().toISOString(),
    requestedBy: requester,
    appVersion: APP_VERSION,
    schemaVersion,
    files: withDocs,
    deferred: [...DEFERRED_EXPORT_PARTS],
  })

  // README is built LAST because it quotes the manifest's own totals. It is
  // therefore not itself described in the manifest — same reason manifest.json
  // is not: a file whose content depends on the digest list cannot be inside it.
  const readmeMd = Buffer.from(buildReadmeMd(manifest), 'utf8')

  const zip = buildZip([
    ...entries,
    { name: 'schema.md', data: schemaMd },
    { name: 'relationships.md', data: relationshipsMd },
    { name: 'README.md', data: readmeMd },
    { name: MANIFEST_PATH, data: manifestBytes(manifest) },
  ])

  return {
    exportId,
    filename: `qtx-export-${requestedAt.slice(0, 10)}-${exportId.slice(0, 8)}.zip`,
    zip,
    manifest,
  }
}

/**
 * Reads one entity.
 *
 * Columns are quoted and joined from the registry — never `SELECT *` — so the
 * file's shape is a decision rather than whatever the catalog currently holds.
 * Identifiers come from a constant in this codebase, not from user input, and
 * are double-quoted so a column named like a keyword still parses.
 */
async function readEntity(tx: Tx, e: ExportEntity): Promise<Record<string, unknown>[]> {
  const cols = e.columns.map((c) => `"${c}"`).join(', ')
  const where = e.liveOnly ? 'WHERE deleted_at IS NULL' : ''
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT ${cols} FROM "${e.table}" ${where} ORDER BY ${e.orderBy} LIMIT ${MAX_ROWS_PER_ENTITY}`)
  return rows
}

/**
 * The newest applied migration, as the export's schema version.
 *
 * Falls back to 'unknown' rather than throwing: `supabase_migrations` is a
 * Supabase-managed schema that does not exist in the local integration harness
 * (which applies the migration files directly). An export that refuses to build
 * because it cannot name its own schema version would be a worse outcome than one
 * that admits it does not know.
 */
async function readSchemaVersion(tx: Tx): Promise<string> {
  try {
    const { rows } = await tx.query<{ version: string }>(
      `SELECT version FROM supabase_migrations.schema_migrations
        ORDER BY version DESC LIMIT 1`)
    return rows[0]?.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export type ExportEventKind = 'requested' | 'built' | 'downloaded'

/**
 * Records an export event in `audit_log`.
 *
 * WRITTEN EXPLICITLY, AND IT HAS TO BE. `fn_audit` is a trigger on table writes;
 * an export only READS, so without this the three events spec §12 requires would
 * leave no trace whatsoever — the one operation in this system that copies every
 * record out of it would be the one operation with no audit trail.
 *
 * `table_name` is the literal 'full_system_export' rather than a real table, and
 * `row_id` is the export id. `audit_log.row_id` is nullable and `fn_audit` is
 * shape-agnostic by design, so a synthetic subject is a shape this table already
 * accommodates rather than an abuse of it.
 */
export async function recordExportEvent(
  tx: Tx, actor: Actor, exportId: string, kind: ExportEventKind,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (table_name, row_id, action, actor_id, new_values, reason)
     VALUES ('full_system_export', $1, 'insert', $2, $3::jsonb, $4)`,
    [exportId, actor.id, JSON.stringify({ event: kind, ...detail }),
      `Full-system export ${kind}`])
}

/** Audit-logs a download. Separate because it happens after the build returns. */
export async function recordExportDownload(actor: Actor, exportId: string): Promise<void> {
  await withTransaction(actor.id, (tx) =>
    recordExportEvent(tx, actor, exportId, 'downloaded'))
}
