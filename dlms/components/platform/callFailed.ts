/**
 * The generic line a user sees when the CALL ITSELF failed — not when the action
 * ran and refused. It matches the fallback every action's own `toMessage` ends
 * with, so the two failure paths are indistinguishable to the reader, which is
 * correct: both mean "the system, not you".
 */
export const CALL_FAILED_MESSAGE =
  'Something went wrong. Try again, and tell Reet if it keeps happening.'

/**
 * One handler for a rejected server-action *invocation*, shared by every client
 * component that calls an action from inside an async `startTransition`.
 *
 * Platform server actions never throw — they return `{ ok: false, error }`, which
 * the caller renders. The INVOCATION is the separate failure: a body-size
 * rejection from the framework, a dropped connection, a stale action id after a
 * redeploy, an expired session on a tab left open overnight. Left uncaught inside
 * an async transition callback, that rejection is rethrown when the transition
 * unwraps and escalates to the error boundary, replacing the whole page —
 * mid-commit, in the import panel's case, and silently reverting nothing in the
 * two components that update optimistically.
 *
 * WAS THREE COPIES BEFORE IT WAS A HELPER, and module-local to the import UI even
 * then. Eight components share the shape; that is the point at which the log
 * format, the wording and the disclosure rule stop being worth restating.
 *
 * `context` names the call site in the log line — the only thing the copies ever
 * differed by. Nothing about the underlying error reaches the returned string:
 * it can name a table, a connection or an action id, so it goes to the server
 * log and nowhere else. Takes `unknown` rather than `Error`, because a rejection
 * carries whatever was thrown — and a handler that throws while handling a
 * rejection re-creates the failure it exists to prevent.
 */
export function callFailed(context: string, err: unknown): string {
  console.error(JSON.stringify({
    level: 'error', msg: `${context} call failed`, err: String(err),
  }))
  return CALL_FAILED_MESSAGE
}
