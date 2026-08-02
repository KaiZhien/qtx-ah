import { createHash } from 'node:crypto'

/**
 * `manifest.json` (spec §12) — the thing that makes the export VERIFIABLE rather
 * than merely present.
 *
 * Without it a recipient holds a ZIP of CSVs and no way to answer the two
 * questions that matter: is this file the one that was built, and is this table
 * complete? The sha256 per file answers the first; the row count per entity
 * answers the second. Both are cheap and neither can be reconstructed after the
 * fact, which is why this is not an optional nicety.
 */

export const MANIFEST_PATH = 'manifest.json'

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export type ExportFileFormat = 'csv' | 'json' | 'markdown' | 'other'

export type ExportFileEntry = {
  path: string
  format: ExportFileFormat
  bytes: number
  sha256: string
  /** The table this file holds, or null for docs. */
  entity: string | null
  /**
   * Rows in this file, or null when the concept does not apply (README, schema).
   * `0` is a real answer and must survive: "this table is empty" and "row counts
   * do not apply here" are different facts about an export.
   */
  rowCount: number | null
}

function formatOf(path: string): ExportFileFormat {
  if (path.endsWith('.csv')) return 'csv'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.md')) return 'markdown'
  return 'other'
}

/**
 * Describes one file for the manifest.
 *
 * Takes the EXACT bytes that will be placed in the archive, so the digest
 * certifies the shipped file rather than a re-encoding of the same data.
 */
export function describeFile(
  path: string,
  data: Buffer,
  meta: { entity?: string; rowCount?: number } = {},
): ExportFileEntry {
  return {
    path,
    format: formatOf(path),
    bytes: data.length,
    sha256: sha256Hex(data),
    entity: meta.entity ?? null,
    rowCount: meta.rowCount ?? null,
  }
}

export type ExportManifest = {
  exportId: string
  requestedAt: string
  builtAt: string
  requestedBy: { id: string; name: string; email: string }
  appVersion: string
  schemaVersion: string
  files: ExportFileEntry[]
  totals: { files: number; bytes: number; rows: number }
  /** Parts of the spec §12 export tree deliberately absent from THIS build. */
  deferred: string[]
}

export type BuildManifestInput = Omit<ExportManifest, 'totals'>

/**
 * Assembles the manifest and computes its totals.
 *
 * THE MANIFEST NEVER LISTS ITSELF. A file cannot carry its own digest — adding
 * the entry changes the bytes, which changes the digest. The archive's own
 * sha256, if one is wanted, belongs outside the archive.
 *
 * Files are sorted by path so two builds of the same export produce a
 * byte-identical manifest and can be diffed directly.
 *
 * The sort is CODEPOINT-WISE, deliberately not `localeCompare`. Locale collation
 * goes through ICU, which ignores case and punctuation differently depending on
 * the host's locale data — so `localeCompare` would order this list differently
 * on two machines and destroy the reproducibility the sort exists to provide.
 */
export function buildManifest(input: BuildManifestInput): ExportManifest {
  const files = [...input.files]
    .filter((f) => f.path !== MANIFEST_PATH)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    ...input,
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      rows: files.reduce((n, f) => n + (f.rowCount ?? 0), 0),
    },
  }
}

/** Pretty-printed and newline-terminated: a human reads this file first. */
export function manifestBytes(manifest: ExportManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}
