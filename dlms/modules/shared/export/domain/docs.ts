import { EXPORT_ENTITIES, DEFERRED_EXPORT_PARTS, type ExportEntity } from './entities'
import type { ExportManifest } from './manifest'

/**
 * `schema.md`, `relationships.md` and `README.md` (spec §12).
 *
 * These three files are why the spec chose CSV+JSON over a SQL dump: a dump is
 * not analyst-readable, and a pile of CSVs with opaque UUID columns is not
 * joinable without being told what joins to what. `relationships.md` is the
 * "stable-UUID join documentation" §12 names explicitly — it is the difference
 * between an export and an archive nobody can use.
 *
 * Pure string builders so they can be unit-tested and diffed.
 */

const EOL = '\n'

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const sep = headers.map(() => '---')
  return [headers, sep, ...rows].map((r) => `| ${r.join(' | ')} |`).join(EOL)
}

/** Escapes the pipe so a column list can never break the markdown table. */
const cell = (s: string) => s.replace(/\|/g, '\\|')

export function buildSchemaMd(entities: readonly ExportEntity[] = EXPORT_ENTITIES): string {
  const rows = entities.map((e) => [
    `\`${e.table}\``,
    e.format,
    String(e.columns.length),
    cell(e.description),
  ])

  return [
    '# Schema',
    '',
    'One file per entity. `csv` files are RFC 4180 with a UTF-8 BOM and CRLF line',
    'endings; `json` files are UTF-8 arrays of objects, used where a set is nested,',
    'holds `jsonb`, or is only meaningful in order.',
    '',
    table(['File', 'Format', 'Columns', 'Notes'], rows),
    '',
    '## Columns, per entity',
    '',
    ...entities.flatMap((e) => [
      `### \`${e.table}\` (${e.format})`,
      '',
      `Ordered by \`${e.orderBy}\`.`,
      '',
      ...e.columns.map((c) => `- \`${c}\``),
      '',
    ]),
  ].join(EOL)
}

/**
 * The join map.
 *
 * Derived from the column names rather than hand-maintained: every `*_id` column
 * is a foreign key in this schema, and the handful whose target is not the
 * obvious singularisation are listed in FK_TARGETS. A hand-written list would be
 * wrong within one migration of being written.
 */
const FK_TARGETS: Record<string, string> = {
  assignee_id: 'app_user',
  created_by: 'app_user',
  updated_by: 'app_user',
  requested_by: 'app_user',
  decided_by: 'app_user',
  approved_by: 'app_user',
  completed_by: 'app_user',
  reported_by: 'app_user',
  assigned_to: 'app_user',
  signed_off_by: 'app_user',
  installed_by: 'app_user',
  removed_by: 'app_user',
  changed_by: 'app_user',
  entered_by: 'app_user',
  actor_id: 'app_user',
  user_id: 'app_user',
  parent_task_id: 'task',
  from_location_id: 'stock_location',
  to_location_id: 'stock_location',
  location_id: 'stock_location',
  variant_id: 'device_variant',
  default_variant_id: 'device_variant',
  invoice_id: 'sales_invoice',
  batch_id: 'import_batch',
  delivery_order_id: 'delivery_order',
}

/**
 * THE EXPLICIT MAP IS CONSULTED FIRST, and the order is load-bearing.
 *
 * An earlier version tested `endsWith('_id')` before the lookup, which silently
 * dropped every person column — `created_by`, `updated_by`, `signed_off_by`,
 * `changed_by`, `assigned_to` — from the join map. Those are the most-joined
 * columns in the whole export ("who did this?"), and their absence is invisible:
 * the document still renders, still looks complete, and simply never mentions
 * them. `hasOwnProperty`-guarded so a column named `constructor` cannot walk the
 * prototype and return a function.
 */
function fkTargetOf(column: string): string | null {
  if (column === 'id') return null
  if (Object.prototype.hasOwnProperty.call(FK_TARGETS, column)) return FK_TARGETS[column]
  if (!column.endsWith('_id')) return null
  return column.slice(0, -3) // device_id → device, repair_id → repair
}

export function buildRelationshipsMd(
  entities: readonly ExportEntity[] = EXPORT_ENTITIES,
): string {
  const known = new Set(entities.map((e) => e.table))
  const rows: string[][] = []

  for (const e of entities) {
    for (const c of e.columns) {
      const target = fkTargetOf(c)
      if (!target) continue
      rows.push([
        `\`${e.table}.${c}\``,
        known.has(target) ? `\`${target}.id\`` : `\`${target}.id\` (not exported)`,
        known.has(target) ? 'yes' : 'no',
      ])
    }
  }

  return [
    '# Relationships',
    '',
    'Every identifier in this export is a **stable UUID**. The same `id` refers to',
    'the same record in every file it appears in, and across exports taken at',
    'different times — so these files can be loaded into any tool and joined',
    'directly, without a translation step.',
    '',
    '`device.id` is the hub: manufacturing, maintenance, finance and logistics all',
    'reference it and never copy device data.',
    '',
    '## Join map',
    '',
    table(['Column', 'References', 'Target in this export'], rows),
    '',
    '## Notes that affect joins',
    '',
    '- **Soft deletes are included.** Rows with a non-null `deleted_at` are present',
    '  on purpose: audit rows still attribute to them, so dropping them would orphan',
    '  the trail. Filter on `deleted_at IS NULL` for a live-only view.',
    '- **`status_option` and `phase_option` are keyed by `code`, not `id`.**',
    '  `device.status` joins to `status_option.code`. The live codes have drifted',
    '  from the original seed, which is exactly why the vocabulary is exported',
    '  rather than assumed.',
    '- **`status_transition` has a composite key** (`from_status`, `to_status`) and',
    '  no `id` column.',
    '- **`task_link` and `approval` are polymorphic:** `entity_id` points at',
    '  whichever table `entity_type` names, so those two join on a pair of columns.',
    '- **`component_installation` is append-only history.** The current components of',
    '  a device are the rows with `removed_at IS NULL`.',
    '- **`audit_log.row_id` is nullable** — `fn_audit` is shape-agnostic and some',
    '  tables have composite keys.',
    '',
  ].join(EOL)
}

export function buildReadmeMd(manifest: ExportManifest): string {
  return [
    '# QTX Operations Platform — full-system export',
    '',
    `Export id: \`${manifest.exportId}\``,
    `Requested: ${manifest.requestedAt} by ${manifest.requestedBy.name} `
      + `(${manifest.requestedBy.email})`,
    `Built: ${manifest.builtAt}`,
    `App version: ${manifest.appVersion} · Schema version: ${manifest.schemaVersion}`,
    '',
    `${manifest.totals.files} files · ${manifest.totals.rows} rows · `
      + `${manifest.totals.bytes} bytes (uncompressed)`,
    '',
    '## What is in here',
    '',
    '- `csv/` — one file per major entity, RFC 4180, UTF-8 **with BOM**, CRLF.',
    '- `json/` — nested and history sets (installations, status history, the audit',
    '  extract) and anything holding `jsonb`.',
    '- `manifest.json` — row counts and a **sha256 per file**. This is how you verify',
    '  the export arrived intact; see below.',
    '- `schema.md` — every file and its columns.',
    '- `relationships.md` — the stable-UUID join map. Read this before loading.',
    '',
    '## Verifying',
    '',
    'Each entry in `manifest.json` carries the sha256 of that file\'s exact bytes.',
    '',
    '```sh',
    'shasum -a 256 csv/device.csv     # compare against manifest.json',
    '```',
    '',
    '`manifest.json` does not list itself — a file cannot contain its own digest.',
    '',
    '## Opening the CSVs',
    '',
    'The BOM is there so Excel reads the bilingual (English/Chinese) content',
    'correctly. **Import the CSVs as text/data rather than double-clicking them.**',
    'Values are exported **verbatim**, including any that begin with `=`, `+`, `-`',
    'or `@`; a spreadsheet may try to evaluate those as formulas. Nothing has been',
    'altered to prevent that, because an export whose values had been quietly',
    'rewritten would no longer be the record the manifest certifies.',
    '',
    '## Sensitive data',
    '',
    'This export contains **unredacted** operational data: buyer contact details,',
    'invoice amounts, user email addresses, confidential tasks and the full audit',
    'trail. That is deliberate (spec §12) — the control on this data is the',
    'ceremony required to request it (Super Admin, plus a freshly-completed second',
    'factor), not field-level redaction. Handle the archive accordingly.',
    '',
    '## Not included in this build',
    '',
    ...DEFERRED_EXPORT_PARTS.map((d) => `- ${d}`),
    '',
  ].join(EOL)
}
