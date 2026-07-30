/**
 * The bulk-import path's one user-facing error type. No I/O.
 *
 * Lives in the domain rather than in importParseService so the pure readers
 * (csvGrid.ts) can throw it without importing a service — which would be a
 * cycle, since the service imports them. The service re-exports it, so callers
 * that already import it from there keep working.
 *
 * It means "the file cannot be staged, and the uploader can act on why".
 * Anything else escaping the parse path is a server bug and must stay
 * distinguishable from this.
 */
export class ImportParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ImportParseError'
  }
}
