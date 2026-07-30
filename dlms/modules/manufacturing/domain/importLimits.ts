/**
 * How big an import may be. The one place each of these numbers is decided.
 *
 * Pure by contract — no database, no fetch, no file system, no clock. Imported
 * by a server action, a server-side service AND a client component, so (like
 * importUi.ts) it must stay free of anything that would drag the service layer
 * — and `pg` — into the browser bundle: this module depends on nothing.
 */

/**
 * The upload size cap the action enforces.
 *
 * Deliberately the same 4 MB as `experimental.serverActions.bodySizeLimit` in
 * next.config.mjs: Next 14's own default is 1 MB — below this — so a file
 * between the two would be rejected by the framework before the action could
 * report anything useful, and Vercel's platform request limit is around 4.5 MB,
 * so anything larger here would advertise a cap the request could never reach.
 * A few thousand traceability rows is well under it.
 *
 * next.config.mjs cannot import from app code, so that one value is a literal
 * with a comment pointing here; everything else reads these constants.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

/** How the cap above is written for a human — the action's error and the form's helper text. */
export const MAX_UPLOAD_LABEL = '4 MB'

/**
 * How many staged rows one import batch may hold.
 *
 * One sheet row can carry a serial range, so rows-in-the-file is not a bound on
 * rows-in-the-batch: a 4 MB CSV of `A0001 to 5000` lines expands past a billion
 * drafts, and even an innocent 500-row sheet of 500-unit ranges is 250,000
 * drafts — roughly 175 MB of live objects, then one transaction inserting all
 * of them, which on a serverless host is a function timeout mid-commit rather
 * than an error anyone can act on. Enforced while the drafts are being
 * accumulated, so the memory is never spent.
 *
 * 50,000 is far past any real traceability file (the largest to date is in the
 * low thousands) while staying inside one batch's insert and review budget.
 */
export const MAX_STAGED_ROWS = 50_000
