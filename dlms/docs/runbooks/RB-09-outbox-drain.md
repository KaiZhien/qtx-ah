# RB-09: Draining the outbox (cross-department handoffs)

Turns unprocessed `outbox` rows — one per boundary-crossing device status change,
written in the same transaction as the status change itself — into cross-department
handoff tasks (spec §5.5). The drain is the *only* thing that creates those tasks.

> **NOTHING SCHEDULES THE DRAIN TODAY.** No cron, no worker, no background job. A
> handoff task appears **only when someone runs a drain**, by the route or by the
> script below. Until a schedule is wired (see "Scheduling it"), the operational
> contract is: the handoff is never *lost*, but it is not *timely* either — it waits
> in the table until a drain runs. If a Logistics user asks why a shipped device
> produced no task, this is the first thing to check, not last.

## What the outbox is, and why an event is never lost

`deviceWriteService.changeDeviceStatus` writes the device row, the
`device_status_history` row, **and** the `outbox` row inside one transaction. Either
all four commit or none do. There is no task-creation call in that transaction and no
scheduling of one — nothing that can fail *after* the status has already committed.

That is the whole point of the pattern. The alternative ("update the status, then
create the task") loses the handoff silently whenever the second step fails: the
device is shipped, nobody in Logistics ever hears about it, and no row anywhere
records that a handoff was owed. Here the *intent* is durable, and the drain's job is
only to discharge it. The worst case is a **late** task, never a missing one.

Only edges that carry a `status_transition.task_template_key` emit. An in-department
move is not a handoff, and an outbox full of no-op rows would bury the real ones.
Today exactly one edge qualifies: `ready_for_delivery → shipped`, carrying
`logistics_prepare_delivery`.

Exactly-once is structural, not best-effort: the task insert and the `processed_at`
stamp happen in the **same** transaction (`createTaskInTx`, deliberately not
`createTask`, which would open its own). A crash between them rolls both back and the
next drain retries. `processed_at` is never reset — a redelivery would duplicate the
task.

## Status of this runbook

Written 2026-07-31 alongside the two triggers it documents (commit under review here),
completing the five-task handoff branch: the outbox migration and automation
principal, the pure handoff templates, the producer inside the status-change
transaction, the drain service, and now the triggers.

**The drain has never been run against the cloud project.** It has been exercised
against the dockerized Postgres `npm run test:integration` uses, which is what the
`__tests__/integration/outboxService.test.ts` suite runs on. Verification behind this
runbook:

- `__tests__/platform/shared/handoffTemplates.test.ts` — the pure template builder
  (unknown key throws rather than inventing a task, three-tier device labelling,
  code-point-safe truncation).
- `__tests__/integration/outboxService.test.ts` — the drain end to end against real
  Postgres: exactly-once under a re-drain, an unknown template key recorded as a
  retryable failure rather than thrown, an unsupported `aggregate_type`/`event_type`
  recorded rather than skipped, the attempts cap parking a row, and the automation
  principal's resolved authority being exactly `create_records` + `view_records`.
- The whole suite green before this commit — see the report for the exact commands
  and counts.

**Fill in when the drain is first run against cloud:**

- Date / environment: `___`
- Trigger used (route / script): `___`
- `claimed` / `processed` / `failed`: `___`
- `parked`: `___`
- Handoff tasks visible in the Logistics queue? `yes / no`: `___`
- Anything in `last_error`: `___`

## Safety

- The drain **only ever inserts and stamps**. It inserts `task`, `task_link` and
  audit rows, and it `UPDATE`s `outbox` on two columns only: `processed_at` on
  success, `attempts` + `last_error` on failure. It never deletes anything, never
  touches `device`, and never re-reads a device row (the payload is self-contained by
  design, so a device that has since moved on to another status cannot change what a
  past handoff says).
- It runs as the **automation principal**, not as the human who caused the event —
  `22222222-2222-2222-2222-222222222222` / `system@qtx.internal`. That principal has
  every module (a handoff crosses departments by definition) narrowed to exactly two
  permissions, `view_records` and `create_records`. It cannot assign tasks, cannot
  delete, cannot approve, and has no login path at all (a CHECK constraint forbids
  linking an `auth.users` row to it).
- The created task is **unassigned**, on purpose. It belongs to the receiving
  department's queue, not to whoever an automation happened to pick — and the
  principal deliberately does not hold `assign_tasks`.
- Two drains may run at once safely. Rows are claimed by `FOR UPDATE ... SKIP
  LOCKED`, so a row another drain holds is skipped, not waited on and not duplicated.
  (This is not a licence to overlap them casually — see "The attempts cap is global".)
- Running the drain with **nothing to do is a no-op**: no candidates, no
  transactions, `claimed: 0`.

## Prerequisites

1. **`20260731000000_platform_outbox.sql` must be applied**, and `platform_seed.sql`
   must have run. Together they create the `outbox` table,
   `fn_resolve_actor_by_user_id`, and the automation principal. If either the function
   or the principal is missing the drain throws before touching a single row — see "When
   the drain throws outright" for the two distinct messages. That is the intended
   failure, not a defect.
2. **`DATABASE_URL` must connect as the owner of `fn_resolve_actor_by_user_id`.**
   This is the prerequisite most likely to be got wrong. That function has
   `EXECUTE` **revoked from `PUBLIC`, `anon` and `authenticated`**, and granted to
   exactly one role: `service_role`. The drain does not authenticate as
   `service_role` — it goes through the `pg` pool, and it works because the pool's
   role *owns* the function (owners hold `EXECUTE` implicitly, regardless of the
   grant). Point `DATABASE_URL` at a narrower role that is neither the owner nor
   `service_role` and the drain fails immediately with Postgres **`42501`
   (`permission denied for function fn_resolve_actor_by_user_id`)** — every event,
   every run, because the principal is resolved once before any row is touched.
   Either connect as the owner or `GRANT EXECUTE ... TO <that role>` deliberately.
3. **`APP_ENV`** decides the pool's TLS posture: any value other than `development`
   sets `ssl: { rejectUnauthorized: true }`. Use `staging`/`production` against cloud;
   `development` only against a local container with no TLS listener.
4. For the route only: **`OUTBOX_DRAIN_SECRET`** must be set on the deployment. If it
   is unset or empty the route refuses **every** request with `401` — a missing
   secret is a misconfiguration, and defaulting to open would leave an
   unauthenticated drain endpoint reachable in production. The refusal is logged
   server-side as `outbox drain endpoint refused a request: OUTBOX_DRAIN_SECRET is not
   set`; the 401 body is identical to a wrong-secret 401 on purpose, so an
   unauthenticated caller cannot tell which it hit.
5. No snapshot is needed before a drain (unlike RB-07/RB-08). It creates tasks; it
   does not rewrite history. See Rollback.

## Running it: the script

```bash
cd dlms
DATABASE_URL="<platform DATABASE_URL>" APP_ENV=staging npm run outbox:drain
```

Output:

```
Draining the outbox...
Claimed:   3
Processed: 3
Failed:    0
Parked:    0
```

- Exits **0** normally, **1** if any event failed this run — so a scheduled
  invocation surfaces the problem instead of logging into the void.
- Deliberately **does not** exit non-zero merely because rows are parked. A standing
  backlog is a human's open item; failing every run on it would make the exit code
  permanently red and therefore ignored. Parked rows are reported on stderr instead.
  (A row that hits the cap on *this* pass also failed on this pass, so that case does
  exit 1.)
- Takes **no arguments** and reads no cursor. Each run drains up to **100** events,
  oldest first; for a larger backlog, run it again.

## Running it: the route

`POST /api/outbox/drain`, authenticated by `OUTBOX_DRAIN_SECRET` as a bearer token:

```bash
curl -sS -X POST https://<deployment>/api/outbox/drain \
  -H "Authorization: Bearer $OUTBOX_DRAIN_SECRET"
```

```json
{"claimed":3,"processed":3,"failed":0,"failures":[],"parked":0}
```

- The secret is compared in **constant time**. Both sides are SHA-256'd first, so the
  comparison is always 32 bytes against 32 bytes: no length is observable and
  `timingSafeEqual`'s differing-length throw is unreachable.
- `401` means *either* a bad/absent secret *or* an unset `OUTBOX_DRAIN_SECRET`.
  Check the deployment logs to tell them apart (see Prerequisites 4).
- `500` is reserved for the drain **throwing**, which it does in exactly one case:
  the automation principal cannot be resolved (missing, inactive, migration not
  applied, or the `42501` above). The message is returned in the body — the caller
  has already presented the secret, and those messages are written for an operator.
- **A poison event is a `200`.** Failed events are reported in the body
  (`failed`, `failures`), not as an error status. Failing the response would make a
  scheduler retry the whole batch over one bad row and would hide however many events
  the same call processed successfully.
- The route is listed in `middleware.ts`'s `PUBLIC_PATHS` so the session gate does
  not answer it with a `307` to `/login` before the handler runs. Its own secret is
  the authentication.

## Scheduling it — neither option is wired

Both of these are **descriptions of what to do, not descriptions of what exists.**

**Option A — Vercel Cron hitting the route.** Add `dlms/vercel.json` (it does not
exist today):

```json
{ "crons": [{ "path": "/api/outbox/drain", "schedule": "*/5 * * * *" }] }
```

Vercel Cron sends `Authorization: Bearer $CRON_SECRET` using the deployment's
`CRON_SECRET` environment variable. This route reads `OUTBOX_DRAIN_SECRET`, so
scheduling it this way means setting **both variables to the same value** — or
renaming the route's variable. Note also that Vercel Cron issues `GET`, not `POST`,
and this route exports only `POST` — a `GET` answers `405` today. Adding a cron entry
therefore also means exporting a `GET` handler (or fronting it with something that
POSTs). Decide that when the schedule is actually built, not by guessing now.

**Option B — the pg-boss worker (spec §7.3).** The intended end state: `outbox` on a
pg-boss queue, drained by a worker service alongside the other scheduled jobs
(backups, digests). The worker replaces **the scheduling, not the logic** — it calls
the same `drainOutbox()`. Nothing about the outbox, the templates, or the drain needs
to change for it.

**Whatever schedules it, keep the interval and the batch size in view together.** One
run drains at most 100 events. A five-minute cron therefore has a ceiling of 1200
events/hour; a backlog larger than that needs a bigger `limit` or a manual catch-up
run, not patience.

## Reading the result

Both triggers report the same `DrainResult`.

| Field | Meaning |
|---|---|
| `claimed` | Rows this drain locked and attempted. Always `processed + failed`. Rows another concurrent drain held are skipped and counted by **neither**. |
| `processed` | Handoff tasks created and `outbox` rows stamped. |
| `failed` | Rows that threw. `attempts` incremented, `last_error` set, `processed_at` left NULL — **still owed**, retried by the next drain until the cap. |
| `failures` | `{ outboxId, error }` per failed row. The error is truncated to 1000 characters — it is for a human to read, not to reconstruct a stack from. |
| `parked` | Unprocessed rows at or beyond the attempts cap, counted **after** this drain. See below. |

**`parked` is `number | null`, and `null` does not mean zero.**

- `parked: 0` — no backlog. Stand down.
- `parked: N > 0` — `N` rows are at the cap and **no future drain will touch them**.
  They are not dropped; they sit unprocessed, waiting for a human. `parked > 0` with
  `claimed: 0` is the signature of a backlog that will never move on its own.
- `parked: null` — **UNKNOWN.** The count query itself failed. Everything else in the
  result is still true (every row was committed before the count ran), but this run
  cannot tell you whether a backlog exists. **Do not read it as "nothing parked"** —
  that is precisely the reading a runbook stands down on, which is why the field is
  `null` rather than defaulting to `0`. Run the query under "Investigating a parked
  event" by hand before concluding anything.

## The attempts cap is global, not a per-drain retry budget

`MAX_ATTEMPTS` is **5**, and `attempts` is a counter **on the row**, accumulated
across every drain that has ever touched it — not a budget each run gets. Three
consequences that matter now that this page describes running the drain on a schedule
*and* by hand:

- A **transient** fault (a dropped connection, a statement timeout, a brief pool
  exhaustion) burns an attempt exactly like a permanent one. Five unlucky minutes can
  park a row that has nothing wrong with it.
- **Overlapping drains make that worse.** Concurrency is safe for correctness —
  `SKIP LOCKED` guarantees no duplicate handoff — but a row that fails, releases its
  lock, and is immediately re-claimed by a second in-flight drain can burn **two**
  attempts on one row inside a single wave. If you run a manual catch-up while a cron
  is also firing, expect the cap to arrive sooner than "five runs".
- Therefore: **a parked row is not proof the event is bad.** Read `last_error` before
  assuming it. If it is a connection or timeout message rather than a template or
  payload complaint, the fix may be nothing more than resetting `attempts`.

## Investigating a parked event

**The most likely cause, by a wide margin:** a `task_template_key` that exists in
`status_transition` but has no entry in `HANDOFF_TEMPLATES`
(`modules/shared/outbox/domain/handoffTemplates.ts`). Adding a handoff is two halves —
an admin `UPDATE` on `status_transition`, and registering the template in code — and
this is what it looks like when the second half is forgotten. `last_error` reads:

```
No handoff template registered for task_template_key "logistics_pack_crate"
```

An **empty-string** `task_template_key` fails the same way for the same underlying
reason (the edge claims a handoff nobody defined) but with a different error: the
producer emits for any non-NULL key, and the payload schema requires a non-empty
string, so `last_error` is a zod issue blob beginning
`[ { "code": "too_small", ... "path": [ "taskTemplateKey" ] ... } ]`. Fix it by
clearing the column to NULL, or by giving the edge a real key.

**1 — list what is parked.**

```sql
SELECT id, occurred_at, attempts, aggregate_id AS device_id,
       payload->>'taskTemplateKey' AS template_key,
       left(last_error, 200) AS last_error
  FROM outbox
 WHERE processed_at IS NULL AND attempts >= 5
 ORDER BY occurred_at;
```

**2 — find the drift.** Every template key the status graph can emit:

```sql
SELECT from_status, to_status, task_template_key
  FROM status_transition
 WHERE task_template_key IS NOT NULL
 ORDER BY from_status, to_status;
```

Compare that list against the keys registered in `HANDOFF_TEMPLATES`. Today the code
side is exactly one key, `logistics_prepare_delivery`. Anything in the SQL result that
is not in that file — including an empty string — will park every event the edge
produces.

**3 — fix the cause.**

- *Missing template*: register it in `handoffTemplates.ts` and **deploy**. This is a
  code change; no amount of database work substitutes for it.
- *Empty or wrong key*: correct `status_transition.task_template_key` (or set it NULL
  if the edge is not really a handoff). Already-emitted rows keep the old key in their
  payload — the payload is a historical fact and is not rewritten — so those rows need
  the template to exist, or need to be abandoned deliberately (see step 5).
- *Unsupported event* (`The outbox drain does not handle X/Y events`): a second
  producer is writing into this table. The outbox is **single-consumer** by contract —
  every row is owed to the one drain, so a second consumer's rows are recorded as this
  drain's failures. Adding one means an explicit ownership split (a dispatch registry
  or a consumer column), not two mutually-ignoring readers.
- *Connection / timeout `last_error`*: nothing is wrong with the event. Go to step 4.

**4 — un-park it.** Resetting `attempts` is what makes the row claimable again:

```sql
UPDATE outbox SET attempts = 0, last_error = NULL
 WHERE id = '<outbox id>' AND processed_at IS NULL;
```

Then run a drain. Note the audit consequence of doing this by hand: `outbox` has no
`updated_by`, and a `psql` session sets no `app.actor_id` GUC, so `fn_audit` falls
back to `created_by` and attributes your manual reset to **the human who caused the
original status change**. That is a known wrinkle of manual intervention on this
table, not a sign something else went wrong. (The drain's own writes go through
`withTransaction(systemActorId)` precisely to avoid it.)

**5 — or abandon it deliberately.** If the handoff genuinely should not happen, stamp
it processed rather than deleting the row — the row is the record that an event
occurred, and deleting it erases that:

```sql
UPDATE outbox SET processed_at = now(), last_error = 'abandoned: <why>'
 WHERE id = '<outbox id>' AND processed_at IS NULL;
```

This creates no task. Say why in `last_error`; someone will read it.

## When the drain throws outright

The drain treats a bad event as **data** and carries on. Exactly one thing is fatal to
a whole run: it cannot resolve the automation principal. Script → the error on stderr
and exit 1 with nothing drained; route → `500` with the message.

- `function fn_resolve_actor_by_user_id(unknown) does not exist` —
  `20260731000000_platform_outbox.sql` has not been applied to **this** database at all.
  The most common cause is a `DATABASE_URL` pointing somewhere other than you think.
- `The outbox automation principal ... does not exist` — the migration is applied but the
  principal row is not there: `platform_seed.sql` has not run on a from-scratch database,
  or somebody deleted the row.
- `The outbox automation principal ... is inactive or soft-deleted` — somebody
  deactivated it through the admin console, most likely without realising what it was.
  Reactivate it. Do **not** work around it by draining as a human: `createTask`
  refuses to link a task into a module the actor cannot enter, which is the security
  model working correctly.
- `permission denied for function fn_resolve_actor_by_user_id` (`42501`) — see
  Prerequisites 2.

Nothing is half-written when this happens. The principal is resolved once, before any
row is touched, precisely so a drain cannot fail halfway through a backlog.

## Rollback

**There is no un-drain, and none is needed.** The drain inserts tasks and stamps
outbox rows; it rewrites nothing and deletes nothing. Rolling a drain "back" would
mean deleting tasks a department may already be working and un-stamping rows whose
tasks exist — which is how you get a duplicate handoff on the next run, since
`processed_at` is the only thing that stops one.

- **A handoff task created wrongly is cancelled through the normal task workflow** —
  transition it to `cancelled` in the Tasks UI, the same as any other task. Handoff
  tasks are created in `open` status, so `open → cancelled` is a legal move. Leave the
  `outbox` row stamped: the event *did* happen, and a task that was cancelled with a
  comment explaining why is a better record than one that silently vanishes.
- **Never `UPDATE outbox SET processed_at = NULL`.** That is a redelivery, and it
  duplicates the task. The column's own COMMENT says so.
- **Never delete an `outbox` row.** Processed rows are the audit trail of what was
  handed off, and they are why the partial index `outbox_unprocessed` exists (so the
  drain's cost stays proportional to the backlog, not to history).
- If a *template* produced bad task text, fix `handoffTemplates.ts` and deploy.
  Already-created tasks are ordinary tasks — edit or cancel them. Re-draining will not
  regenerate them.

## Design notes (why the code does what it does)

- **The task insert and the `processed_at` stamp share one transaction.**
  `withTransaction` takes a fresh pooled connection per call, so calling the
  transaction-owning `createTask()` from inside the drain's transaction would **not**
  nest — it would commit the task independently, and a crash before the stamp would
  leave a task whose event is still unprocessed for the next drain to hand off again.
  `createTaskInTx` exists for exactly this.
- **A bad event is data, not an exception.** An unknown template key, a malformed
  payload, an unhandled event shape: each is recorded on its row and the drain carries
  on with the batch. Only an unresolvable principal is fatal.
- **An unhandled `aggregate_type`/`event_type` is recorded, never skipped.** Skipping
  would leave the row unprocessed, invisible, and re-claimed by every drain forever,
  with `attempts` never rising to park it. Recording makes the disagreement legible
  *and* self-limiting.
- **The candidate scan is unlocked; the claim is not.** The scan picks ids; the real
  claim is a per-row `FOR UPDATE ... SKIP LOCKED` inside each row's transaction, with
  the predicate re-checked under the lock. That is what lets two drains run without
  contending for — or duplicating — the same event.
- **Ordering is `(occurred_at, id)`, not `occurred_at` alone.** `now()` is
  transaction-scoped, so rows written in one transaction share a timestamp; ordering
  on the timestamp alone leaves the `LIMIT` cut between them arbitrary, and under
  sustained load one row could lose the coin-flip on every pass forever.
- **`recordFailure` runs in its own transaction, guarded on `processed_at IS NULL`.**
  The row's own transaction has rolled back by then, so anything written there is
  gone; and another drain may have claimed and processed the row in between, in which
  case the guard stops the increment from landing on an already-processed row and
  leaving a successful handoff carrying a permanent false alarm.
- **`parked` is reporting, not work**, and runs after every row is already committed —
  so a broken count must not turn a completed drain into a throw. Hence `null` rather
  than `0`. See "Reading the result".
- **`outbox` has no `version` and needs none.** Rows are claimed by lock, not
  arbitrated by optimistic concurrency, because there is no competing human writer to
  arbitrate with.
