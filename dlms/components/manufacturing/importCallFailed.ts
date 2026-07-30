/**
 * One handler for a rejected server-action *invocation*, shared by the three
 * import client components.
 *
 * The import actions never throw — they return `{ ok: false, error }` — but the
 * call itself can fail: a body-size rejection from the framework, a dropped
 * connection, a stale action id after a redeploy. Left uncaught, a rejection
 * inside a startTransition async callback is rethrown when the transition unwraps
 * it and escalates to the error boundary, replacing the whole page (mid-commit,
 * in the panel's case). Logged structured and once, the way the actions log.
 *
 * `context` names the call site in the log line, which is the only thing the
 * three copies of this helper ever differed by. Nothing about the underlying
 * error reaches the returned string: it is the same generic line the actions'
 * own toMessage falls back to.
 */
export function callFailed(context: string, err: unknown): string {
  console.error(JSON.stringify({
    level: 'error', msg: `import ${context} call failed`, err: String(err),
  }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}
