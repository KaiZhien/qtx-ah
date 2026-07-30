# Status-Driven Cross-Department Handoffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a device status change crosses a departmental boundary, the receiving department gets a task automatically — reliably, without the status change ever failing because of it.

**Architecture:** The transactional-outbox pattern from spec §5.5, verbatim. `changeDeviceStatus` writes an `outbox` row **inside the same transaction** that commits the status change, so the event can never be lost to a crash between commit and dispatch. A drain then claims unprocessed rows with `FOR UPDATE SKIP LOCKED`, turns each into a handoff task through the existing `taskService`, and marks it processed **in the same transaction as the task it created**. Worst case is a delayed task, never a lost one and never a duplicated one.

**Tech Stack:** TypeScript, node-postgres, Next.js 14 route handler, Vitest (unit + dockerized-PG integration).

**What this is not.** No notifications — `spec §6.3`'s `notification` table does not exist yet, so `status_transition.notify_roles` is carried into the outbox payload for that future task and otherwise unused. No pg-boss worker: the drain is a plain service with two triggers (an authenticated route handler for a scheduler, and an npm script for local runs). The worker service, when it lands, replaces the *scheduling*, not the logic. No approval flows — spec §5.5 says they ride the same mechanism, but `approval` does not exist yet either.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Spec §5.5 is the contract.** *"Why outbox instead of firing events after commit: a crash between commit and event send would silently lose a handoff. With the outbox, the event is part of the same transaction; the worker retries until processed."*
- **A handoff must never break a status change.** The outbox INSERT is in the status-change transaction, so it is atomic with it — but nothing downstream of the outbox may ever be called from the request path. If the drain is broken, status changes keep working and events accumulate.
- **Exactly-once task creation.** A drained event creates its task and is marked processed in **one** transaction. Two concurrent drains must not both process a row — `FOR UPDATE SKIP LOCKED` is how, the same primitive `importCommitService` already uses.
- **Never guess a template.** An event whose `task_template_key` has no template is a configuration error: record it on the row as a failure and leave it unprocessed. Do not invent a task, and do not silently drop the event.
- **Service function shape**, in this order: `authorize(actor, '<permission>', '<module>')` first line; then `<zodSchema>.parse(input)`; then `withTransaction`.
- **The drain runs as the system principal, not as a human.** See "The system actor" below — this is the decision the whole feature turns on.
- Pure domain modules (`modules/*/domain/`) do no I/O: no DB, no `fetch`, no file access, no clock. A time an event needs is passed in.
- No imports from `dlms/lib/domain/` or `dlms/lib/services/` — frozen legacy app behind a module boundary.
- TDD: write the failing test, run it, watch it fail, then implement.
- **Migrations:** filename `<14-digit timestamp>_platform_<subject>.sql`; the `platform_` token is load-bearing (`__tests__/integration/setup.ts` selects by `/^\d{14}_platform_.*\.sql$/`). New tables get audit columns + `version`, `SELECT fn_attach_audit(...)` unless explicitly exempted, and `ENABLE ROW LEVEL SECURITY` with no policy. Committing the file deploys nothing — cloud application is a separate manual step.
- **Commit attribution:** every commit is authored solely by Reet Mitra. **Never** add a `Co-Authored-By` or any co-author trailer (CLAUDE.md hard rule).
- **Verification:** `cd dlms && npm test`, `npm run test:integration`, `npx tsc --noEmit`, `npm run build`. Paste real output.
- **Integration-test gotcha:** `npm run test:integration -- <name>` does **not** filter — the argument lands on the trailing `docker compose down`, which errors and leaves the container running, poisoning later runs. Run it bare, or bring the container up and use `npx vitest run --config vitest.integration.config.ts <file>`. Clear a stale container with `cd dlms && docker compose -f docker-compose.test.yml down -v`.

---

## The system actor — the decision this feature turns on

A manufacturing operator moving a device `ready_for_delivery → shipped` spawns a **logistics** task. That operator has no logistics module access, and `taskService.createTask` explicitly refuses to link a task into a module the actor cannot enter — *"that would let an outsider create a visible handle on a record they can't see."* So the drain **cannot** run as the person who caused the event. That is not a limitation to work around; it is the security model working correctly, and it is precisely why the handoff is automated rather than manual.

The drain therefore runs as a dedicated system principal:

- A seeded `app_user` row with a **fixed UUID**, mirroring the established pattern CLAUDE.md documents for the legacy DLMS system actor (`11111111-1111-1111-1111-111111111111` there). A fixed id means the drain resolves it without a magic email lookup, and audit rows attribute automated writes to a stable identity.
- **`auth_user_id` stays NULL**, so it has no login path. Public signups are disabled on the cloud Auth project, and no `auth.users` row exists for it.
- **Role `operator`, module access to all seven modules**, then reduced by `user_permission_override` **revocations** down to exactly `view_records` + `create_records`. `fn_resolve_actor` already folds overrides in (grants added, revokes subtracted), so this needs no new mechanism and no new role.

**Why not a new `system` role:** `RoleKey` is a typed union in `modules/shared/authz/catalog.ts` consumed by the generated permission-matrix suite, the seed-drift guard, and the Super Admin console's 24×6 editable grid. Adding a seventh role to grant one permission would ripple through all of them. Overrides are the mechanism the platform already has for "this specific principal, narrower than its role," and using it keeps the role fabric untouched.

**What it can do, exhaustively:** create tasks, and read. It cannot edit or delete records, change a device status, approve anything, manage users, or see finance. If the drain is ever compromised, the blast radius is spurious tasks.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260731000000_platform_outbox.sql` | `outbox` table + the system actor seed |
| `modules/shared/outbox/domain/handoffTemplates.ts` | Pure: `task_template_key` → task shape |
| `modules/shared/outbox/services/outboxService.ts` | Drain: claim → create task → mark processed |
| `app/api/outbox/drain/route.ts` | Authenticated trigger for a scheduler |
| `scripts/drain_outbox.ts` | Manual/local trigger |
| `__tests__/platform/shared/handoffTemplates.test.ts` | Unit |
| `__tests__/integration/outboxService.test.ts` | Integration |
| `docs/runbooks/RB-09-outbox-drain.md` | Operator runbook |

**Modify:**

| Path | Change |
|---|---|
| `modules/manufacturing/services/deviceWriteService.ts` | Write the outbox row inside `changeDeviceStatus`'s transaction |
| `modules/shared/authz/actor.ts` | `loadSystemActor()` |
| `supabase/migrations/20260718000002_platform_resolve_actor.sql` | **Do not edit.** Add the by-id resolver in the new migration instead |
| `package.json` | `outbox:drain` script |
| `docs/superpowers/PROGRESS.md` | Flip the handoff row |

---

## Task 1: Outbox schema and the system actor

**Files:**
- Create: `supabase/migrations/20260731000000_platform_outbox.sql`
- Create: `__tests__/integration/outboxService.test.ts` (schema assertions only in this task)

**Interfaces:**
- Consumes: `app_user`, `role`, `permission`, `user_permission_override`, `fn_attach_audit`, `fn_resolve_actor`'s row shape.
- Produces: table `outbox`; the seeded system `app_user`; SQL function `fn_resolve_actor_by_user_id(uuid)`.

**Schema requirements:**

`outbox` — columns: `id uuid PK`, `aggregate_type text NOT NULL` (`'device'` today), `aggregate_id uuid NOT NULL`, `event_type text NOT NULL` (`'device_status_changed'`), `payload jsonb NOT NULL`, `occurred_at timestamptz NOT NULL DEFAULT now()`, `processed_at timestamptz`, `attempts integer NOT NULL DEFAULT 0`, `last_error text`, `created_by uuid NOT NULL REFERENCES app_user(id)` — the human who caused the event, so the trail records cause as well as effect.

- A partial index on unprocessed rows ordered for the drain: `(occurred_at) WHERE processed_at IS NULL`. That is the drain's only query shape, and it keeps the index small as processed rows accumulate.
- `SELECT fn_attach_audit('outbox')` — unlike `import_row`, this table is low-volume (one row per boundary-crossing status change) and its processing history is operationally interesting.
- `ENABLE ROW LEVEL SECURITY` with no policy.

**System actor seed** — an `app_user` with the fixed UUID `22222222-2222-2222-2222-222222222222` (the legacy project already uses the all-ones UUID for its own system actor; using a distinct constant avoids any chance of the two being conflated across databases), `email` a non-routable address such as `system@qtx.internal`, `full_name` naming it as automation, `role_id` = `operator`, `module_access` = all seven modules, `active = true`, `auth_user_id` NULL. Then `user_permission_override` **revocation** rows removing every operator permission except `view_records` and `create_records`.

**Correction found during implementation — the seed cannot live directly in the migration.** `__tests__/integration/setup.ts` applies every migration **first** and only then runs `platform_seed.sql`, which is where `role` is populated. Since `app_user.role_id` is `NOT NULL REFERENCES role(id)`, a migration-embedded `INSERT ... SELECT r.id FROM role r WHERE r.key='operator'` matches nothing and inserts **zero rows, silently** — verified empirically: all three `component_type` rows seeded by `20260720000001_platform_components.sql` carry `created_by = NULL` on a freshly-migrated database for exactly this reason, and that migration escapes it by making the column nullable. `role_id` cannot be nullable, so that escape is unavailable.

The resolution is an idempotent `fn_seed_system_actor()` defined in the migration and called from **both** the migration itself and `platform_seed.sql`. It is a no-op (not an error) when `role` has no `operator` row yet, so it self-heals in either ordering: harmless during the migration pass, correct once the seed has run, and correct immediately on a cloud database where roles already exist. Both call sites are load-bearing — comment the function so the next reader does not delete one.

The alternative — putting the seed only in `platform_seed.sql` — was rejected because it makes cloud application a two-step "apply the migration, then re-run the seed", and forgetting the second step fails *silently*: the drain would resolve no system actor and handoffs would simply never appear, with nothing about the status change itself looking wrong. This project already has one migration stranded in `main` because a manual step could not be completed; a second remembered step is a footgun that will eventually fire.

**`fn_resolve_actor_by_user_id(p_app_user_id uuid)`** — returns the identical row shape as `fn_resolve_actor`, keyed on `app_user.id` instead of `auth_user_id`. Read `20260718000002_platform_resolve_actor.sql` and mirror its body and its `SECURITY DEFINER SET search_path` hardening exactly; the only difference is the lookup column. Revoke EXECUTE from `PUBLIC` and grant only to `service_role` — note the gotcha recorded in this project's history: *revoking from `anon` is a no-op because EXECUTE defaults to `PUBLIC`; revoke from `PUBLIC` and re-grant explicitly.*

- [ ] **Step 1: Write the failing test**

Create `__tests__/integration/outboxService.test.ts` with schema assertions: both the table and the function exist; `attempts` defaults to 0 and `processed_at` to NULL; the partial index exists; the system `app_user` resolves through `fn_resolve_actor_by_user_id` with **exactly** `view_records` and `create_records` and with all seven modules; and its `auth_user_id` is NULL. Model the file's setup on `__tests__/integration/importParseService.test.ts`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd dlms && docker compose -f docker-compose.test.yml down -v && npm run test:integration`
Expected: the new file fails — `relation "outbox" does not exist`.

- [ ] **Step 3: Write the migration**

Follow the header-comment convention of the sibling platform migrations: purpose, spec §refs, the note that it belongs to the `qtx-ops-platform` project and that committing does nothing until applied via the Supabase MCP/CLI.

- [ ] **Step 4: Confirm it passes**

Run the integration suite bare and confirm green.

- [ ] **Step 5: Commit** (do **not** apply to cloud — that is the controller's step at merge)

```bash
git add dlms/supabase/migrations/20260731000000_platform_outbox.sql dlms/__tests__/integration/outboxService.test.ts
git commit -m "feat(platform): outbox table and the automation system actor"
```

---

## Task 2: Pure handoff templates

**Files:**
- Create: `modules/shared/outbox/domain/handoffTemplates.ts`
- Test: `__tests__/platform/shared/handoffTemplates.test.ts`

**Interfaces:**
- Consumes: `ModuleKey` from `@/modules/shared/authz/catalog`.
- Produces:
  - `type HandoffTask = { title: string; description: string; module: ModuleKey; department: string; priority: 'low'|'normal'|'high'|'urgent' }`
  - `type HandoffContext = { deviceSn: string | null; fromStatus: string; toStatus: string; reason: string | null; changedByName: string }`
  - `class UnknownTemplateError extends Error`
  - `HANDOFF_TEMPLATES: Record<string, (ctx: HandoffContext) => HandoffTask>`
  - `buildHandoffTask(templateKey: string, ctx: HandoffContext): HandoffTask` — throws `UnknownTemplateError` for an unregistered key

**Requirements:**
- Register `logistics_prepare_delivery`, the only key seeded in `status_transition` today: module `logistics`, a title naming the device, and a description that states what happened, who did it, and what the receiving department is being asked to do. Include the reason when one was given.
- A device with no `device_sn` must still produce a usable title — legacy rows often have none, and `pcba_a_sn_legacy` is their de-facto identity. Fall back to something that identifies the device rather than rendering "null".
- `buildHandoffTask` throws for an unknown key. It must not fall back to a generic task: a template key that nobody registered means the graph and the code disagree, and inventing a task hides that.
- Pure: no I/O, no clock. Everything it needs is in `ctx`.

Write the tests first, covering: the registered template's shape; the reason appearing when present and the description remaining coherent when absent; the missing-`device_sn` fallback; and `UnknownTemplateError` for an unregistered key.

```bash
git commit -m "feat(platform): pure handoff task templates"
```

---

## Task 3: Write the outbox row inside the status-change transaction

**Files:**
- Modify: `modules/manufacturing/services/deviceWriteService.ts`
- Test: `__tests__/integration/deviceWriteService.test.ts` (extend; do not weaken existing tests)

**Interfaces:**
- Consumes: the `outbox` table (Task 1).
- Produces: no new exports — `changeDeviceStatus`'s observable behaviour gains the outbox row.

**Read `changeDeviceStatus` first.** It already runs one transaction that locks the device, loads the transition facts, evaluates the pure decision, updates the device, and inserts the history row. Two changes:

1. Its existing facts query must additionally select `st.task_template_key` and `st.notify_roles`.
2. After the history INSERT, **when `task_template_key` is not null**, insert an `outbox` row with `aggregate_type = 'device'`, `aggregate_id` = the device id, `event_type = 'device_status_changed'`, `created_by` = the acting actor, and a payload carrying everything the drain needs without re-reading the device: the template key, from/to status, the reason, and `notify_roles` (unused today, carried for the future notifications task).

**Do not** insert an outbox row when the transition has no template key — an in-department move is not a handoff, and an outbox full of no-op events makes the real ones harder to see.

**Constraints:** the insert is inside the existing `withTransaction`, so a rejected status change writes no event. Do not add a second transaction, do not call the drain, and do not let anything about the outbox be able to fail a legal status change other than a genuine database error.

Tests to add: a transition carrying a template key writes exactly one outbox row with the right payload; a transition without one writes none; a status change rejected by the graph or by permissions writes none (assert the outbox is empty after the failed attempt).

```bash
git commit -m "feat(manufacturing): emit a handoff event in the status-change transaction"
```

---

## Task 4: The drain

**Files:**
- Create: `modules/shared/outbox/services/outboxService.ts`
- Modify: `modules/shared/authz/actor.ts` (add `loadSystemActor`)
- Test: `__tests__/integration/outboxService.test.ts` (extend Task 1's file)

**Interfaces:**
- Consumes: `buildHandoffTask` (Task 2), `createTask` from `@/modules/shared/tasks/services/taskService`, `withTransaction`, `fn_resolve_actor_by_user_id` (Task 1).
- Produces:
  - `SYSTEM_ACTOR_ID` — the fixed UUID constant, exported from `actor.ts`
  - `loadSystemActor(): Promise<Actor>` in `actor.ts` — resolves the system principal through `fn_resolve_actor_by_user_id`; throws if it is missing or inactive rather than falling back to anything
  - `type DrainResult = { claimed: number; processed: number; failed: number; failures: Array<{ outboxId: string; error: string }> }`
  - `drainOutbox(input?: { limit?: number }): Promise<DrainResult>`

**Behaviour:**
- Resolve the system actor **once** per drain, not per row.
- Claim up to `limit` (default 100) unprocessed rows ordered by `occurred_at`, using `FOR UPDATE SKIP LOCKED`, so two concurrent drains never contend for the same row.
- Process **one row per transaction**: build the handoff task from the template, `createTask` as the system actor with a `task_link` to the device (`entityType: 'device'`, the aggregate id, and the template's module), then stamp `processed_at` — all in that same transaction, so a task without its processed marker is impossible and vice versa.
- On failure: increment `attempts`, record `last_error`, leave `processed_at` NULL so it retries. A row-level failure must never abort the drain.
- Rows whose `attempts` have reached a cap (use 5) are **not** claimed again, and the drain reports how many are parked — a poison event must not consume every drain forever, and it must be visible rather than silently skipped.
- The drain never throws for a bad event; it throws only if it cannot resolve the system actor, which is a deployment fault.

**A note the implementer must get right:** `createTask` opens its own `withTransaction`. Calling it from inside another transaction would nest, and `withTransaction` acquires a **separate pooled connection** — so the task insert would not be in the same transaction as the processed stamp, breaking exactly-once. Read `lib/db/tx.ts` and decide deliberately: either write the task rows directly inside the drain's transaction (duplicating a little of `createTask`), or give `taskService` a variant that accepts an existing `Tx`. **Prefer extending `taskService` with a `Tx`-accepting internal** so there remains one definition of what creating a task means — but whichever you choose, say why in a comment, and prove exactly-once with a test.

Tests: an event becomes a task linked to the device, with the system actor as creator; the row is marked processed; a second drain does nothing; a broken template key increments `attempts`, records `last_error`, creates no task, and does not stop other rows in the same drain from succeeding; a row at the attempts cap is not claimed; and `loadSystemActor` yields exactly `view_records` + `create_records`.

```bash
git commit -m "feat(platform): drain the outbox into cross-department handoff tasks"
```

---

## Task 5: Triggers, runbook, status board

**Files:**
- Create: `app/api/outbox/drain/route.ts`
- Create: `scripts/drain_outbox.ts`
- Create: `docs/runbooks/RB-09-outbox-drain.md`
- Modify: `package.json`, `docs/superpowers/PROGRESS.md`

**The route handler:** `POST`, authenticated by a shared secret compared with `crypto.timingSafeEqual` (the codebase already has a note about `!=` versus constant-time comparison being a real finding). The secret comes from an env var; **if it is unset, the route must refuse every request** rather than allowing unauthenticated drains. It returns the `DrainResult` as JSON, and it must never return a 500 for a poison event — that is a normal, reported outcome. Read an existing route handler under `app/` for the house response shape before writing it.

**The script:** `scripts/drain_outbox.ts`, wired as `npm run outbox:drain`, mirroring `scripts/migrate_components.ts`'s structure — env-var handling with clear errors, a printed summary, a non-zero exit if any event failed, the `fileURLToPath` main-module guard, and closing `getPool()` so the process exits promptly.

**The runbook (RB-09):** match `RB-08`'s structure. Cover: what the outbox is and why events are never lost; how to run the drain both ways; how to schedule it (Vercel Cron hitting the route, or the future pg-boss worker — state plainly that **nothing schedules it today**, so handoff tasks appear only when a drain runs); how to read the result; what a parked event at the attempts cap means and how to investigate one; and that a template key present in `status_transition` but absent from `HANDOFF_TEMPLATES` is the most likely cause of a parked event.

**PROGRESS.md:** flip the handoff row to ✅ with a factual note — outbox written in the status-change transaction, drained exactly-once into handoff tasks by the system actor, triggered by route or script. Record honestly that **no scheduler is wired yet** and that notifications and approvals are still deferred. Update the "Last updated" date. Do not add a carried-findings list; the controller appends that.

Verify all four gates, then:

```bash
git commit -m "feat(platform): outbox drain triggers, runbook, and status board"
```

---

## Deferred, and deliberately so

- **Notifications.** `status_transition.notify_roles` is carried in the payload and read by nothing. The `notification` / `notification_pref` tables of spec §6.3 do not exist.
- **The pg-boss worker.** Spec §7.3 puts `outbox` on a pg-boss queue; this ships the drain and two manual triggers instead. The worker replaces the scheduling, not the logic.
- **Approvals.** Spec §5.5 says ECO/invoice/repair-sign-off approvals ride the same mechanism. `approval` does not exist yet; when it does, it emits into the same outbox.
- **More templates.** Only `ready_for_delivery → shipped` carries a `task_template_key` today. Adding a handoff is an admin UPDATE on `status_transition` plus a template registration — and the drain parking an event is exactly what tells you the second half was forgotten.
