# RB-09: Draining the outbox (handoffs, approvals, notifications)

Turns unprocessed `outbox` rows — written in the same transaction as the thing that
caused them — into cross-department handoff tasks (spec §5.5), approval tasks
(spec §6.3), and the **notifications** that tell the relevant people about both.
The drain is the *only* thing that creates any of them.

> **THE DRAIN IS NOW SCHEDULED.** `vercel.json` runs it every five minutes via Vercel
> Cron. Earlier revisions of this page said nothing scheduled it and that Vercel Cron
> *could not* drive the route (cron issues `GET` with `Bearer $CRON_SECRET`; the route
> was `POST`-only with its own secret). Both are fixed: the route now exports a `GET`
> that accepts `CRON_SECRET` alongside the unchanged `POST` that accepts
> `OUTBOX_DRAIN_SECRET`. **Both still refuse every request when their own secret is
> unset.**
>
> **`CRON_SECRET` must be set on the deployment or the schedule silently does
> nothing** — every cron invocation gets a `401` and the backlog grows with no task and
> no notification. That is now the first thing to check when a shipped device produces
> no handoff, and it is the only new way this can fail.

## What one drain does

For each claimed event, in **one transaction**:

| Event | Producer | Task | Notifications |
|---|---|---|---|
| `device` / `device_status_changed` | `deviceWriteService.changeDeviceStatus` | the handoff task | everyone holding a role in `status_transition.notify_roles` who can enter the receiving module |
| `approval` / `approval_requested` | `approvalService.requestApprovalInTx` | the approval task | everyone who could actually decide it, minus the requester |
| `approval` / `approval_decided` | `approvalService.decideApproval` | **none** | the requester only |

**All three families now have a producer.** `approval_decided` was consumed-but-unproduced
until 2026-08-04; deciding an approval now tells the requester. See "The decision
notification, and why its emit is where it is" below.

The task insert, the notification inserts and the `processed_at` stamp share that one
transaction, so notifications inherit exactly-once from the drain rather than having a
weaker guarantee of their own. **Emails are the deliberate exception** — a send cannot be
rolled back, so they are queued during the transaction and sent after it commits.

## Deploy order — READ THIS FIRST

**Apply `supabase/migrations/20260731000000_platform_outbox.sql` to the Supabase
project BEFORE deploying the code to Vercel.** Not "at some point around the
deploy" — strictly before.

As of this branch the migration is **committed but not applied to cloud**, so the very
next deploy is the one this applies to.

Why the order is load-bearing: the **producer** depends on the table, not only the
drain. `deviceWriteService.changeDeviceStatus` issues `INSERT INTO outbox …` *inside*
the same transaction as the device update and the `device_status_history` row. Against
a database without the table, that insert raises

```
relation "outbox" does not exist
```

which rolls the **whole transaction** back. The user-visible consequence is not "no
handoff task" — it is:

> **Every `ready_for_delivery → shipped` status change fails.** A manufacturing user
> clicks the status control on a device profile, and the change is refused. The device
> stays in `ready_for_delivery`. Nothing about the error mentions handoffs.

That is a direct violation of the design's Global Constraint that a handoff must never
break a status change, and it lasts until the migration is applied. Applying the
migration first has no such hazard: an `outbox` table with no producer deployed simply
stays empty, and the drain over it returns `claimed: 0`.

```bash
# 1. Apply the migration (Supabase MCP `apply_migration`, or the CLI). Committing the
#    file does nothing by itself.
# 2. Verify the table is really there before deploying:
#    SELECT to_regclass('public.outbox');            -- must not be NULL
#    SELECT id FROM app_user WHERE email = 'system@qtx.internal';   -- must return a row
# 3. Only then:
cd dlms && npx vercel deploy --prod --yes
```

If the order was reversed and status changes are already failing, the fix is to apply
the migration — not to roll back the deploy. No data is lost either way: a rolled-back
status-change transaction wrote nothing.

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

Written 2026-07-31 with the handoff branch. **Substantially revised 2026-08-03** by the
notifications-and-scheduling slice, which changed three things this page previously
asserted:

- *"Nothing schedules the drain"* — it does now (Vercel Cron, `vercel.json`).
- *"Vercel Cron cannot drive the route as written"* — it can now (`GET` + `CRON_SECRET`).
- The drain creates **notifications** as well as tasks, and `status_transition.notify_roles`
  is finally read by something.

**Revised again 2026-08-04** by the cross-branch wire-ups, which closed two things this
page previously described as open:

- *"`approval_decided` is consumed but not produced"* — `approvalService.decideApproval`
  emits it now, in the decision's own transaction.
- A **fourth** scheduled job exists, `warranty-expiry` — the second poll on this page, and
  the first notification family with no originating event at all.

**The drain has never been run against the cloud project, and the schedule has never
fired there** — no deploy has happened since the crons were added, and the five
migrations it depends on are still unapplied. Everything below is verified against the
dockerized Postgres `npm run test:integration` uses. Verification behind this runbook:

- `__tests__/platform/shared/handoffTemplates.test.ts` — the pure template builder
  (unknown key throws rather than inventing a task, three-tier device labelling,
  code-point-safe truncation).
- `__tests__/integration/outboxService.test.ts` — the drain end to end against real
  Postgres: exactly-once under a re-drain, an unknown template key recorded as a
  retryable failure rather than thrown, an unsupported `aggregate_type`/`event_type`
  recorded rather than skipped, the attempts cap parking a row, the automation
  principal's resolved authority being exactly `create_records` + `view_records`, and
  all four enforcement points that hold it there — including the console path
  (`updateUserAccess` re-roling the principal to `super_admin`) being refused.
- `__tests__/platform/shared/outboxDrainRoute.test.ts` — the HTTP trigger's gate: an
  unset `OUTBOX_DRAIN_SECRET` refuses without draining, a wrong secret refuses, the
  correct secret drains, a poison batch is still a `200`, and a convention pin that
  `/api/outbox/drain` stays in `middleware.ts`'s `PUBLIC_PATHS` (without which every
  request `307`s to `/login` before the handler runs, with the whole suite still green).
- `__tests__/platform/shared/cronRoutes.test.ts` — the scheduling surface: the `GET`
  path drains on `CRON_SECRET` and **refuses when it is unset**; the two secrets are
  **not** interchangeable in either direction; the `POST` path's fail-closed behaviour is
  unchanged; `?limit=` is honoured and junk values are ignored rather than refused; the
  job runner checks the secret **before** the job lookup so jobs cannot be enumerated;
  and `vercel.json` is pinned against the job registry path-for-path and
  schedule-for-schedule.
- `__tests__/platform/shared/healthRoute.test.ts` — `/api/health`: 503 when the database
  is unreachable, the database error never returned to an unauthenticated caller, and a
  missing `outbox` table reported as `queue: null` (**unknown**) rather than zero.
- `__tests__/integration/notificationService.test.ts` — notifications end to end: the
  fan-out's exactly-once under a re-drain, **no** notification when the event fails, the
  module gate, the causer and the automation principal excluded, muted categories
  honoured, `emailed_at` staying NULL when email is unconfigured, `approval_decided`
  notifying the requester and creating no task, the **reminder sweep producing nothing on
  a second run the same day** (and on a fifth), an overdue task re-notifying the next day,
  the override-expiry job soft-deleting only what has actually lapsed, and — added
  2026-08-04 — the **warranty sweep firing once EVER rather than once a day**, firing again
  on a bucket crossing and after a renewal, addressing only `manage_finance` holders, and
  leaving the automation principal's authority untouched.
- `__tests__/integration/approvalService.test.ts` — added 2026-08-04, the decision's
  producer: the payload's shape, the event rolling back when it cannot be written, and
  **no event surviving a failure at COMMIT** (the direction that actually proves one
  transaction — see "The decision notification" above).
- `__tests__/platform/finance/warrantyExpiry.test.ts` — the milestone domain: cumulative
  buckets, a key with **nothing date-shaped in it**, a new key per bucket crossing, and a
  malformed date refused rather than silently landing in a bucket.
- `__tests__/platform/shared/{notificationPreferences,taskReminders,notificationTemplates,emailDelivery,notificationAge}.test.ts`
  — the pure halves, including the no-op mailer reporting `delivered: false` rather than
  claiming a send, and every shipped category having a label (both notification pages index
  `CATEGORY_LABELS` by the stored string, so a missing one is a runtime crash on the bell).
- The whole unit suite green: **2211 tests**; integration **1079**. (The 1528 figure this
  line carried on 2026-08-03 was the unit count at that merge, before five further slices.)

**Fill in when the drain is first run against cloud:**

- Date / environment: `___`
- Trigger used (route / script / cron): `___`
- `claimed` / `processed` / `failed`: `___`
- `parked`: `___`
- `notified` / `emailed`: `___`
- Did the **cron** fire on its own (rather than a hand-run curl)? `yes / no`: `___`
  (No, with a hand-run working, almost always means `CRON_SECRET` is unset or the plan
  does not allow the cadence.)
- Notification visible in the bell for a Logistics manager? `yes / no`: `___`
- Handoff task visible on **`/tasks?scope=all`**? `yes / no`: `___`
  (`scope=all`, not the default tab — see "Where the handoff task shows up". The
  default is `scope=mine`, which filters on `assignee_id` and can never show an
  unassigned handoff.)
- Handoff task visible to a **Logistics user on `/tasks?scope=department`**? `yes / no`: `___`
  (No, with `all` showing it, means the user's free-text `app_user.department` does not
  equal the template's `'Logistics'` — a data mismatch, not a drain failure.)
- Anything in `last_error`: `___`

## Safety

- The drain **only ever inserts and stamps**. It inserts `task`, `task_link`,
  `notification` and audit rows, and it `UPDATE`s `outbox` on two columns only:
  `processed_at` on success, `attempts` + `last_error` on failure — plus
  `notification.emailed_at`, and only on a confirmed send. It never deletes anything,
  never touches `device`, and never re-reads a device row (the payload is self-contained
  by design, so a device that has since moved on to another status cannot change what a
  past handoff says).
- **The notification fan-out added NO authority to the automation principal.** It writes
  on `create_records`, which the principal already holds in every module; the keep-list in
  `fn_seed_system_actor()` is untouched and its resolved authority is still exactly
  `create_records` + `view_records`. This matters because widening it is the one change
  the four enforcement points in `20260731000000_platform_outbox.sql` cannot defend
  against — they guard the ceiling, and raising the ceiling is a migration.
- **Neither did the warranty sweep**, and it was checked rather than assumed. It spends
  `view_records` in finance (`getExpiringWarranties`' gate — deliberately the record gate,
  not the `view_finance` money gate) and `create_records` in finance (the fan-out's). Both
  were already held, so the keep-list is again untouched;
  `__tests__/integration/notificationService.test.ts` asserts the principal's resolved
  authority is still exactly those two **after** a sweep runs. A future field on that
  notification needing a third permission is a security decision and a migration, not a
  wiring change.
- It runs as the **automation principal**, not as the human who caused the event —
  `22222222-2222-2222-2222-222222222222` / `system@qtx.internal`. That principal has
  every module (a handoff crosses departments by definition) narrowed to exactly two
  permissions, `view_records` and `create_records`. It cannot assign tasks, cannot
  delete, cannot approve, and has no login path at all (a CHECK constraint forbids
  linking an `auth.users` row to it). Its `role_id` and `module_access` are pinned by a
  trigger, so the admin console cannot re-role it either. Those guards defend its
  **ceiling**; its floor is a different matter — see "Investigating a parked event".
- The created task is **unassigned**, on purpose. It belongs to the receiving
  department's queue, not to whoever an automation happened to pick — and the
  principal deliberately does not hold `assign_tasks`.
- Two drains may run at once safely. Rows are claimed by `FOR UPDATE ... SKIP
  LOCKED`, so a row another drain holds is skipped, not waited on and not duplicated.
  (This is not a licence to overlap them casually — see "The attempts cap is global".)
- Running the drain with **nothing to do is a no-op**: no candidates, no
  transactions, `claimed: 0`.

## Where the handoff task shows up — and where it does not

**A handoff task is NOT on the Tasks page's default tab.** This is the single most
likely way to conclude "the drain didn't work" when it worked perfectly.

`/tasks` defaults to `scope=mine`, which filters on `t.assignee_id = <you>`. Handoff
tasks are created **unassigned**, on purpose (they belong to the receiving department's
queue, not to whoever an automation happened to pick — and the principal deliberately
does not hold `assign_tasks`). So `mine` will never show one, for anybody, until a human
claims it.

Look on:

- **`/tasks?scope=department`** — the intended queue. Matches `task.department` against
  the viewer's own `app_user.department`.
- **`/tasks?scope=all`** — the fallback that always shows it (subject to the ordinary
  visibility filter). Use this to answer "did the drain create anything?" before
  debugging anyone's department string.

**The department match is free text on both sides.** The template hardcodes
`department: 'Logistics'` (`modules/shared/outbox/domain/handoffTemplates.ts`), and
`app_user.department` has no vocabulary table, no CHECK and no normalization — it is
whatever was typed when the user was invited. A Logistics user recorded as
`logistics`, `Logistics Dept`, `LOGISTICS` or `NULL` will **not** see the task on the
department tab, and nothing anywhere reports the mismatch. If `scope=all` shows the task
and `scope=department` does not, this is why:

```sql
-- What the task says vs. what the people say.
SELECT DISTINCT department FROM app_user WHERE deleted_at IS NULL ORDER BY 1;
SELECT id, title, department FROM task WHERE department = 'Logistics';
```

Fix it on the user record (Admin → Users → the user's Department field), not on the
template — the template's spelling is the one the code commits to.

## Prerequisites

1. **`20260731000000_platform_outbox.sql` must be applied**, and `platform_seed.sql`
   must have run. Together they create the `outbox` table,
   `fn_resolve_actor_by_user_id`, and the automation principal. If either the function
   or the principal is missing the drain throws before touching a single row — see "When
   the drain throws outright" for the two distinct messages. That is the intended
   failure, not a defect. **The migration is also a prerequisite of the *producer*, and
   that one is not a graceful failure — see "Deploy order" at the top of this page.**
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
4. For the route only: **`OUTBOX_DRAIN_SECRET`** (POST) and **`CRON_SECRET`** (GET, and
   every `/api/cron/*` job) must be set on the deployment. If either is unset or empty,
   its method refuses **every** request with `401` — a missing secret is a
   misconfiguration, and defaulting to open would leave an unauthenticated drain endpoint
   reachable in production. The refusal is logged server-side as
   `a scheduled endpoint refused a request: <VAR> is not set`; the 401 body is identical
   to a wrong-secret 401 on purpose, so an unauthenticated caller cannot tell which it
   hit. **`CRON_SECRET` unset is a silently dead schedule** — the crons fire, get 401,
   and nothing accumulates but the backlog.
6. **`20260803150000_platform_notifications.sql` must be applied** before the drain runs
   against this code. Unlike the outbox migration, the failure here is *graceful*: the
   notification insert throws inside the claim transaction, the whole event rolls back and
   is recorded as a retryable failure (`relation "notification" does not exist`), so no
   task appears either and nothing is lost — but **every event fails and parks after five
   attempts**. The status change itself still commits; only the drain is affected.
7. **`RESEND_API_KEY` is optional.** Unset is a supported, expected state — see "Email is
   not configured" below.
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

Two methods, two secrets, one drain. **They are deliberately not interchangeable** — an
operator's drain secret and the platform's cron secret have different blast radii and
different rotation stories, so neither is accepted on the other's path.

```bash
# The operator trigger.
curl -sS -X POST https://<deployment>/api/outbox/drain \
  -H "Authorization: Bearer $OUTBOX_DRAIN_SECRET"

# What Vercel Cron does, reproduced by hand.
curl -sS https://<deployment>/api/outbox/drain \
  -H "Authorization: Bearer $CRON_SECRET"

# A catch-up run over a large backlog (1..1000; anything else is IGNORED, not refused).
curl -sS -X POST "https://<deployment>/api/outbox/drain?limit=1000" \
  -H "Authorization: Bearer $OUTBOX_DRAIN_SECRET"
```

```json
{"claimed":3,"processed":3,"failed":0,"failures":[],"parked":0,"emailed":0,"notified":5}
```

- The secret is compared in **constant time**. Both sides are SHA-256'd first, so the
  comparison is always 32 bytes against 32 bytes: no length is observable and
  `timingSafeEqual`'s differing-length throw is unreachable.
- `401` means *either* a bad/absent secret *or* an unset secret for **that method**.
  Check the deployment logs to tell them apart (see Prerequisites 4). A `GET` returning
  401 while `POST` works means `CRON_SECRET` is missing — which is exactly what a
  silently-dead schedule looks like.
- **`maxDuration` is 300s.** Without it the route inherited the platform default (10–15s)
  and a full 100-event batch could be killed mid-drain, returning a `504` with **no
  `DrainResult` at all** — the events were safe either way, but the operator could not
  tell how many had been processed. If you raise `limit` far above 100, keep this ceiling
  in mind: the drain is not resumable mid-batch, it is merely re-runnable.
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

## Scheduling — what actually runs

**Vercel Cron is the live path.** `dlms/vercel.json`:

```json
{ "crons": [
  { "path": "/api/outbox/drain",           "schedule": "*/5 * * * *" },
  { "path": "/api/cron/task-reminders",    "schedule": "0 8 * * *" },
  { "path": "/api/cron/warranty-expiry",   "schedule": "30 8 * * *" },
  { "path": "/api/cron/expire-overrides",  "schedule": "0 * * * *" }
] }
```

Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on a `GET`. All four paths
accept exactly that, through one shared constant-time comparison
(`modules/shared/outbox/services/cronAuth.ts`), and all four refuse everything when
`CRON_SECRET` is unset.

The four jobs are defined **once**, as data, in
`modules/shared/outbox/jobs/registry.ts`. `vercel.json` duplicates their schedules
because Vercel can only read its own file; the two are pinned against each other by
`__tests__/platform/shared/cronRoutes.test.ts`, which fails if a path or a cadence
drifts. **Add a job by adding a registry entry AND a `vercel.json` entry** — the test
tells you if you did only one.

> **Vercel plan limits.** Hobby allows **2 cron jobs, daily only**; the four entries
> above and the `*/5` cadence need **Pro**. On Hobby the extra crons are silently
> dropped at deploy — check the project's Cron tab after the first deploy rather than
> assuming. **The count went from three to four on 2026-08-04**, so a deployment that was
> already at a plan ceiling is now further past it.

**pg-boss (spec §7.3) is scaffolded, NOT running.** `scripts/worker.ts` reads the same
registry and schedules the same jobs, so moving to it changes the scheduling and
nothing about the work. It is **not the live path and cannot be on Vercel**: pg-boss
needs a long-running process holding a connection and waking on a timer, and Vercel
freezes functions between requests. It is for the eventual AWS/Fargate (or any
container) deployment. Two further honesty notes:

- **`pg-boss` is not in `package.json`.** The worker imports it through a non-literal
  specifier so the absent package neither breaks `tsc` nor ships in every Vercel build.
  Running it means `npm install pg-boss` first; it exits with that instruction rather
  than a stack trace.
- **Do not run both.** Adopting the worker means **removing the `crons` from
  `vercel.json`**, or every job runs twice.

**Keep the interval and the batch size in view together.** One run drains at most
`limit` events (100 by default). A five-minute cron therefore has a ceiling of 1200
events/hour; a backlog larger than that needs a bigger `limit` — which is now an
operator control, `?limit=`, not a code constant — or a manual catch-up run.

## Reading the result

Both triggers report the same `DrainResult`.

| Field | Meaning |
|---|---|
| `claimed` | Rows this drain locked and attempted. Always `processed + failed`. Rows another concurrent drain held are skipped and counted by **neither**. |
| `processed` | Handoff tasks created and `outbox` rows stamped. |
| `failed` | Rows that threw. `attempts` incremented, `last_error` set, `processed_at` left NULL — **still owed**, retried by the next drain until the cap. |
| `failures` | `{ outboxId, error }` per failed row. The error is truncated to 1000 characters — it is for a human to read, not to reconstruct a stack from. |
| `parked` | Unprocessed rows at or beyond the attempts cap, counted **after** this drain. See below. |
| `notified` | In-app notification **rows written**. Not the number of people the events concerned: a recipient who muted the category gets no row. |
| `emailed` | Emails that **actually went out**. `0` is the expected value on this deployment — see "Email is not configured". |

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

## Notifications: who gets told, and why somebody didn't

This section is about the **drain's** fan-out. The warranty sweep selects its audience
differently — by `manage_finance` rather than by a role list — and has no causer to
exclude; see "The other three scheduled jobs".

A notification is created **only** if all of these hold. Walk them in order — the first
three account for nearly every "why was I not told?".

1. **The event named a role.** For handoffs the audience comes from
   `status_transition.notify_roles`, which is admin-editable and **NULL on most edges**.
   A NULL means nobody is notified, and the drain reports `notified: 0` while still
   creating the task — which is a legitimate configuration, not a fault.
   ```sql
   SELECT from_status, to_status, task_template_key, notify_roles
     FROM status_transition WHERE task_template_key IS NOT NULL;
   ```
2. **The person holds that role**, is active, and is not soft-deleted.
3. **The person can enter the receiving module.** Gated on the *handoff's* module
   (`logistics` for the one edge that exists), **not** on `manufacturing` — deliberately,
   because that is the module the drain also links the task into, and a notification about
   a record someone cannot open is a disclosure rather than a courtesy. A manager without
   `logistics` in `module_access` is correctly silent.
4. **They did not cause the event.** Nobody is told what they themselves just did.
5. **They have not muted the category.** `notification_pref` — absent row means the
   defaults (in-app on, email off).

Roles are resolved to people **at drain time**, not when the event was produced: somebody
who joined Logistics yesterday hears about today's handoff, and somebody who left does
not.

The **automation principal is never a recipient**, even though it holds the `operator`
role and every module. It has no login path, so a bell it could never open would only
accumulate.

```sql
-- What did the last drain actually deliver, and to whom?
SELECT n.category, u.full_name, n.title, n.read_at, n.emailed_at, n.created_at
  FROM notification n JOIN app_user u ON u.id = n.user_id
 ORDER BY n.created_at DESC LIMIT 20;
```

### Email is not configured

`RESEND_API_KEY` is **unset on this deployment**, and that is a supported state rather
than a fault. The sender falls back to a no-op that logs what it would have sent and
**truthfully reports the send as undelivered**, so:

- `emailed` is `0` on every drain,
- `notification.emailed_at` stays `NULL`,
- the in-app notification is delivered normally and is the record of the event.

**`emailed_at IS NULL` means "not emailed", for every reason** — not wanted, not
configured, failed, or still queued. It is never stamped on intent, so the mail history
is empty rather than fictional. Setting `RESEND_API_KEY` (and `NOTIFICATION_EMAIL_FROM`
to a verified sender, plus `NEXT_PUBLIC_SITE_URL` so links in mail are absolute) is all
that is needed to turn it on; a non-zero `emailed` is the only thing that proves it works.

A bounced or refused email **never fails the drain**. The notification is already written
and visible; email is the courtesy on top of it.

### The decision notification, and why its emit is where it is

**WIRED 2026-08-04.** `approval` / `approval_decided` is now produced as well as consumed:
`approvalService.decideApproval` writes the event **inside the same transaction as the
decision**, and the drain turns it into one notification for the requester and no task.
Its `SELECT ... FOR UPDATE` reads `kind`, `entity_type` and `entity_id` alongside `status`,
`requested_by` and `module` purely so the payload can be self-contained.

`requestedBy` is in the payload because, unlike the other two families, the recipient is
*not* `created_by`: for a decision the causer and the audience are different people.
`label` is `null` — the `FOR UPDATE` deliberately does not read `snapshot`, and the
consumer's `recordLabel` falls back to `"<entity type> <short id>"` rather than rendering
"null".

**The emit must never be moved out of that transaction**, and the trap is specific:
`withTransaction` takes a fresh pooled connection per call, so wrapping the INSERT in one
"to keep notification problems out of the decision path" makes it commit independently.
That reintroduces exactly the bug the outbox exists to prevent, in whichever direction
loses the race — a decision nobody is told about, or a notification announcing a decision
that then rolled back. Two integration tests hold the line and they are **not**
interchangeable:

- *rolls the DECISION back when the event cannot be written* — a `BEFORE INSERT` trigger on
  `outbox`. Catches a swallowed emit (`try { … } catch {}`), but a
  separately-committing emit **passes it**, because the inner transaction's exception still
  propagates out of the outer one.
- *leaves NO event behind when the decision's own transaction fails at COMMIT* — a
  `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `approval`. This is the one that
  proves shared atomicity: it fires after both writes have been issued, so an independently
  committed event survives the rollback and is still there to be found. `decideApproval` has
  no `…InTx` variant a caller could abort from outside, so this is the only reachable
  expression of that failure.

Two behaviours on the consumer side look like omissions and are not: the decision creates
**no task** (it is the end of the work, not the start of some), and a requester who has
since been deactivated is **not an error** — there is nobody left to tell, and stamping the
event processed is correct.

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

**The second cause, and the one nobody guesses: somebody narrowed the `operator`
role.** `last_error` reads exactly:

```
Permission denied: create_records in tasks
```

Nothing about that message mentions roles, the console, or the automation principal —
so read it as what it is: *the drain lost a permission it used to have.* (`create_records`
is the one the drain actually spends — `prepare()` in `taskService.ts` calls
`authorize(actor, 'create_records', 'tasks')`. Un-ticking `view_records` strips it from
the principal by the same coupling but breaks nothing today; restore it anyway, because
the principal's asserted authority is exactly those two.)

The cause is the reconciliation coupling, and it runs **both ways**.
`fn_seed_system_actor()` derives the principal's authority from the `operator` role's
*current* `role_permission` rows — the principal is "operator minus revocations", and it
is revoked from everything except `view_records` and `create_records`. So a Super Admin
un-ticking `create_records` for `operator` in the console's 24×6 role grid does not just
narrow operators: `trg_reconcile_system_actor` fires on that same write and narrows the
automation principal with it, in the same transaction. **Every handoff then fails**, and
after five attempts the rows park.

The obvious repair is unavailable **by design**: `trg_forbid_system_actor_grant` refuses
any additive override on this principal, so you cannot grant the permission back to it
directly. The guards defend the principal's *ceiling*; its *floor* is undefended and
cannot be defended without breaking the derivation that keeps it narrow.

*The fix is to restore the permission on the `operator` role* — Admin → Roles, re-tick
the box (or `INSERT INTO role_permission` for `operator` × that permission). The
reconciliation runs on that write too and the principal recovers immediately. Then
un-park the affected rows (step 4) and drain.

```sql
-- Is the principal actually short a permission? Expect exactly two rows:
-- create_records and view_records.
SELECT unnest(role_permissions) AS perm FROM fn_resolve_actor_by_user_id(
         '22222222-2222-2222-2222-222222222222')
EXCEPT
SELECT unnest(revoked_overrides) FROM fn_resolve_actor_by_user_id(
         '22222222-2222-2222-2222-222222222222');
```

If that returns fewer than two rows, this is your cause. Do **not** try to fix it by
granting the principal an override; the trigger will refuse you, and correctly.

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

## Checking the backlog without a drain: `/api/health`

```bash
curl -sS https://<deployment>/api/health
# {"status":"ok","app":"ok","database":"ok",
#  "queue":{"unprocessed":3,"parked":0,"oldestUnprocessedAt":"2026-08-03T11:04:12.000Z"},
#  "checkedAt":"2026-08-03T11:05:00.000Z"}
```

Unauthenticated on purpose — a health check that needs a credential cannot be used by an
uptime monitor. It discloses liveness and a queue depth, nothing else; a database error is
logged server-side and never returned.

- **`503`, not `200`, when the database is unreachable.** A monitor that has to parse the
  body would eventually be pointed at the status code and find a green one.
- **`parked` is a SUBSET of `unprocessed`**, not a second bucket — parked rows are still
  unprocessed, they are simply no longer retried. The backlog is `unprocessed`, not the sum.
- **`queue: null` means UNKNOWN**, and on this project the live cause is the outbox
  migration being committed but unapplied. It is never reported as zeros — same discipline
  as `DrainResult.parked`.
- **`oldestUnprocessedAt` is the field that tells you whether the SCHEDULE is alive**, which
  neither count does. A steady `unprocessed: 3` is healthy at 30 seconds old and means the
  drain has stopped running at 30 hours old. **This is the fastest check for a missing
  `CRON_SECRET`.**

The numbers come from `getQueueHealth()` in `modules/shared/outbox/services/queueHealth.ts`,
which the Admin dashboard's job-queue widget (spec §8.5) also calls **directly** — one
definition, so the dashboard and the health check cannot disagree. The dashboard does not
fetch this endpoint.

## The other three scheduled jobs

They ride the same registry, the same secret and the same route shape, so they are
documented here rather than in pages of their own.

**Two of them are POLLS, and that is not a design slip.** The drain discharges intents
somebody's write created; `task-reminders` and `warranty-expiry` answer questions about the
calendar, and **time passing is not a write**. Nothing can emit an event nobody caused, so
there is no outbox row to drain and the only mechanism available is to look. If a future
job is tempted to poll for something a user action *does* record, it should ride the outbox
instead.

**`/api/cron/task-reminders` — daily at 08:00 UTC** (spec §8.3). Notifies the assignee of
every task due tomorrow or already overdue.

```bash
curl -sS https://<deployment>/api/cron/task-reminders -H "Authorization: Bearer $CRON_SECRET"
# {"job":"task-reminders","ms":412,"result":{"scanned":37,"due":4,"created":4,"emailed":0}}
```

**Running it twice is safe, by design and by construction.** Each reminder carries a
deterministic `dedupe_key` — `task_reminder:<kind>:<taskId>:<UTC day>` — and
`notification_dedupe_idx` makes the repeat a no-op. So a crashed half-run can simply be
re-run: it finishes the remainder and re-notifies nobody. `due` stays the same on a
re-run while `created` drops to `0`; **that is the success signal, not a fault.** The
idempotency is a property of the data rather than of the job's memory, which is why it
also survives two runs racing each other.

The day component is what makes an overdue task nag **daily** rather than once forever.
Unassigned tasks are skipped — a reminder needs somebody to remind, and handoff tasks are
created unassigned on purpose.

**`/api/cron/warranty-expiry` — daily at 08:30 UTC** (spec §8.5, "warranties expiring
30/60/90 d"). Tells everyone who can renew a warranty that one is running out.

```bash
curl -sS https://<deployment>/api/cron/warranty-expiry -H "Authorization: Bearer $CRON_SECRET"
# {"job":"warranty-expiry","ms":205,
#  "result":{"scanned":37,"due":4,"created":8,"recipients":2,"emailed":0,"truncated":false}}
```

**Its dedupe key deliberately has NO day component**, and that is the single most likely
thing to be "fixed" into a bug by somebody copying the reminder sweep sitting right above
it. `warranty_expiring:<warrantyId>:<milestone>` — a task reminder *should* nag daily, a
warranty milestone must fire **once ever**. Three notifications per warranty over its whole
life: one as it crosses 90 days, one at 60, one at 30. Re-running the job today, tomorrow
and every day for a month adds nothing, so a crashed run is free to re-run.

Three more things worth knowing before triaging it:

- **Keyed on the WARRANTY, never the device.** A renewal mints a new `warranty` row and
  soft-deletes the old one (`warranty_device_live_unique` is partial on
  `deleted_at IS NULL`). Keyed on the device, the successor would inherit the
  predecessor's used keys and never notify again — silently, for that device's life.
- **The audience is `manage_finance`, not `view_records`.** Warranty *reads* are
  deliberately open to anyone with Finance module access, but this message is a call to
  action, and `manager` does not hold `manage_finance` (spec §3.2) — so a Finance-capable
  manager correctly hears nothing. `finance`, `admin` and `super_admin` do.
- **`truncated: true` means the run did not see the whole horizon.** The scan is capped at
  `getExpiringWarranties`' own limit of **200**, ordered by `end_date` ascending, so a
  saturated run keeps the nearest expiries and loses the far end of the 90-day window.
  Unlike a missed task reminder this does **not** self-heal tomorrow — the key has no day,
  so nothing retries it — although a warranty that later moves into a tighter bucket does
  get a fresh key and a fresh chance. It is logged server-side as
  `the warranty expiry sweep hit its scan ceiling`. At ~1700 devices on two-year cover the
  steady-state 90-day population is around 210, so this is reachable rather than
  theoretical; the fix is to raise that ceiling in `warrantyService`.

**`/api/cron/expire-overrides` — hourly** (spec §6.3, "Worker expires hourly").
Soft-deletes `user_permission_override` rows whose `expires_at` has passed.

**It changes nobody's authority, and that is why it needs no permission.** Both
`fn_resolve_actor` and `fn_resolve_actor_by_user_id` already filter on
`expires_at IS NULL OR expires_at > now()`, so a lapsed grant confers nothing and a
lapsed revoke subtracts nothing, before and after this runs. All it does is stop the
admin console showing rows that no longer do anything. If the resolver ever stops
filtering on expiry, this job becomes a privilege change and needs a real gate.

The automation principal's own overrides are unreachable from it: `trg_forbid_system_actor_grant`
refuses a non-NULL `expires_at` on them, so none can ever match the predicate.

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
