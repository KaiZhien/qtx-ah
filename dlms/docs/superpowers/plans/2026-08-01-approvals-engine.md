# Approvals Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One approval mechanism, used by every module that needs a second pair of eyes — starting with the Finance threshold approval, which is the consumer that is genuinely blocked without it.

**Architecture:** A polymorphic `approval` record (spec §6.3) attaching to any entity by `entity_type + entity_id`, exactly as `task_link` and `audit_log` do. A request captures an **immutable snapshot** of what is being approved; the consumer re-checks that snapshot at the moment it acts, so an entity edited after approval cannot quietly ride an approval that was granted for different numbers. Requesting an approval emits an outbox event (spec §5.5: *"approval flows ride the same mechanism"*), and a pending-approvals queue reads the `approval` table directly so the feature works today, before any scheduler exists.

**Tech Stack:** TypeScript, node-postgres, Next.js 14 App Router, Vitest (unit + dockerized-PG integration).

**What this is not.** Not a migration of the two approval-shaped flows that already work — Engineering's `approve_requests`-gated ECO step and Maintenance's repair sign-off both function today, and moving them onto the engine is a refactor with regression risk and no new capability. They become follow-ups once the engine has one real consumer. No notifications: the `notification` table still does not exist.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Spec §6.3's `approval` row is the contract:** `entity_type`, `entity_id`, `kind` (`eco` / `invoice` / `repair_signoff`), `requested_by`, `status` (`pending`/`approved`/`rejected`), `decided_by`/`decided_at`, `decision_note`, and `snapshot jsonb` — *"what was approved, immutable."*
- **The snapshot is the point.** An approval authorises a *specific state*, not an entity id. If the entity changes after approval, the approval no longer applies. Every consumer must re-check the snapshot against current state before acting, and refuse when they diverge. Getting this wrong turns the engine into theatre.
- **Nobody decides their own request.** A requester may not approve or reject their own approval, regardless of permission. Enforce it in the pure domain so it cannot be forgotten at a call site.
- **Deciding requires `approve_requests`.** That permission already exists in `modules/shared/authz/catalog.ts` and is granted to `super_admin`, `admin`, `manager`. Do not add a permission.
- **`approved` and `rejected` are terminal.** A rejected request is re-requested as a *new row*, never reopened — the decision trail must stay readable.
- **At most one pending approval per (entity_type, entity_id, kind)**, enforced by a partial unique index, so a double-click cannot create two live requests.
- **Service function shape**, in this order: `authorize(actor, '<permission>', '<module>')` first line; then `<zodSchema>.parse(input)`; then `withTransaction`. Keep the guard **ahead of** the connection — a `prepare()` split if a `Tx`-accepting internal is needed. This project has shipped the inverse regression twice; `taskService.ts` and `deviceWriteService.ts` both show the corrected pattern.
- **`withTransaction` acquires a separate pooled connection per call.** Calling another service's public function from inside a transaction does not nest — it commits independently. Use the `…InTx` internals (`createTaskInTx`, `changeDeviceStatusInTx`) when atomicity matters.
- Pure domain modules do no I/O: no DB, no `fetch`, no file access, no clock. Times are injected.
- Server actions under `app/(platform)/` use `requireAal2Actor()` **inside** the `try`; `__tests__/actionAalPinning.test.ts` enforces the identifier, not the placement. Pages gate 404-not-403.
- No imports from `dlms/lib/domain/` or `dlms/lib/services/` — frozen legacy app behind a module boundary.
- **Migrations:** `<14-digit timestamp>_platform_<subject>.sql`; the `platform_` token is load-bearing. Audit columns + `version`, `SELECT fn_attach_audit(...)`, `ENABLE ROW LEVEL SECURITY` with no policy. Committing deploys nothing.
- **Three migrations are already unapplied on `main`** and all are ordering-critical. Yours is the fourth. Do not apply anything to cloud — that is the controller's step.
- **Commit attribution:** every commit is authored solely by Reet Mitra. **Never** add a `Co-Authored-By` or any co-author trailer.
- **Verification:** `cd dlms && npm test`, `npm run test:integration`, `npx tsc --noEmit`, `npm run build`. Paste **real** output — a report in an earlier plan carried stale numbers from a previous run.
- **Integration-test gotcha:** `npm run test:integration -- <name>` does **not** filter — the argument lands on the trailing `docker compose down`, which errors and leaves the container running, poisoning later runs. Run it bare from a `down -v` container, or bring the container up and use `npx vitest run --config vitest.integration.config.ts <file>`.

---

## Task 1: `approval` and `app_setting` schema

**Files:** create `supabase/migrations/20260802000000_platform_approvals.sql`; create `__tests__/integration/approvalService.test.ts` (schema assertions only).

**`app_setting` does not exist yet** — grep confirms no table, no seed, no reader — so this migration creates it. Spec §6.3: `key` PK, `value jsonb`, holding `finance_approval_threshold_sgd`, `export_retention_days`, and whatever later needs a runtime knob. Seed `finance_approval_threshold_sgd` with a sensible SGD figure and comment that it is admin-tunable. Give it audit columns; a settings change is exactly the kind of thing an auditor asks about.

**`approval`** per spec §6.3, plus the conventions every platform table carries. Note specifically:
- `entity_type` + `entity_id` are the polymorphic pair; do **not** add an FK — the whole point is that it attaches to any module's record. Follow `task_link`'s precedent, including its denormalised `module` column if that proves useful for queue filtering.
- `kind` over a CHECK set of `eco` / `invoice` / `repair_signoff`.
- `snapshot jsonb NOT NULL` — the immutable record of what was approved.
- The partial unique index enforcing one pending request per (entity_type, entity_id, kind).
- An index serving the queue's query shape: pending approvals, newest first.

Read `20260801000000_platform_modifications.sql` for current header/comment conventions and `20260719000000_platform_tasks.sql` for the polymorphic-link precedent.

Schema tests: both tables; the partial unique index actually refuses a second pending row and permits a second row once the first is decided; `snapshot` is NOT NULL; the CHECK sets; RLS on with no policy; audit attached (assert the trigger by name or that an `audit_log` row appears — not merely that some trigger exists); the seeded setting.

```bash
git commit -m "feat(platform): approval records and the app_setting store"
```

---

## Task 2: the pure approval domain

**Files:** create `modules/shared/approvals/domain/approvalDecision.ts` + its unit test.

Pure, no I/O. Produces:
- `type ApprovalStatus = 'pending' | 'approved' | 'rejected'`, `type ApprovalKind = 'eco' | 'invoice' | 'repair_signoff'`
- `type DecisionFacts = { status: ApprovalStatus; requestedBy: string; deciderId: string; deciderCanApprove: boolean }`
- `evaluateDecision(facts): { ok: true } | { ok: false; error: DecisionErrorCode }` with codes for: already decided, self-approval, and missing permission
- `messageForDecisionError(code)` and a typed error class, in the shape `repairStatus.ts` and `deviceStatus.ts` use
- `snapshotsAgree(approved: unknown, current: unknown): boolean` — a deep, order-insensitive comparison of the two snapshot objects, plus `describeSnapshotDrift(approved, current): string[]` naming the fields that differ so a refusal can tell the user *what* changed rather than only that something did

The drift description matters more than it looks: "this invoice changed since it was approved" is unactionable; "total changed from 12,000.00 to 18,500.00" is not.

Write the tests first. Cover the decision matrix exhaustively — including that a decider **with** `approve_requests` still cannot decide their own request, and that an already-decided approval refuses a second decision in both directions.

```bash
git commit -m "feat(platform): pure approval decision and snapshot-drift domain"
```

---

## Task 3: the approval service

**Files:** create `modules/shared/approvals/services/approvalService.ts`; extend `__tests__/integration/approvalService.test.ts`.

Produces `requestApproval`, `decideApproval`, `listApprovals` (the queue), `getApprovalFor(entityType, entityId, kind)` returning the current pending or latest decided row, and a `Tx`-accepting internal for whichever of those a consumer must call inside its own transaction.

**Behaviour:**
- `requestApproval` records the snapshot the caller supplies, sets `pending`, and **emits an outbox event** so a task lands in the approver queue when the drain runs. Reuse the existing outbox — read `deviceWriteService.changeDeviceStatus` for how an event is written inside a transaction, and `modules/shared/outbox/domain/handoffTemplates.ts` for how a template turns an event into a task. Register an approval template; an unregistered `kind` must park the event rather than invent a task, which is the behaviour that registry already has.
- `decideApproval` runs the pure `evaluateDecision`, then stamps `decided_by`/`decided_at`/`decision_note`. Approving without a note is fine; **rejecting requires one** — a rejection nobody can act on is worse than none.
- The queue is permission-scoped: an actor without `approve_requests` sees nothing. It reads the `approval` table directly, which is what makes this feature work before any scheduler exists.

**Authorisation:** requesting needs the requester's own module permission — pass it in rather than hardcoding, since the engine is shared. Deciding needs `approve_requests`.

Integration tests: the full decision matrix against a real database; the partial unique index refusing a concurrent second request; the outbox row appearing in the same transaction as the request and **not** appearing when the request rolls back.

```bash
git commit -m "feat(platform): approval request and decision service"
```

---

## Task 4: wire Finance — invoices above the threshold need approval

**Files:** modify `modules/finance/services/invoiceService.ts`; extend the finance integration tests; add the request/decide controls to the invoice UI.

Invoices move `draft → issued → paid`, with `void` as the sink. The gate goes on **`draft → issued`**: an invoice whose total is at or above `finance_approval_threshold_sgd` may not be issued without an approved, non-drifted approval.

**Three rules to get right:**
1. **Read the threshold from `app_setting`**, never a constant — it is admin-tunable and that is the whole reason the table exists.
2. **The snapshot must capture what an approver actually agreed to** — at minimum the invoice total and the buyer, since those are what a reviewer is signing off on. Decide the exact shape and justify it; a snapshot of only the id authorises nothing.
3. **Re-check the snapshot at issue time.** An invoice approved at one total and then edited must refuse to issue, naming the drift via `describeSnapshotDrift`. This is the rule that makes the engine real rather than decorative, so test it directly: approve, edit the total, attempt to issue, assert the refusal and the message.

Below the threshold, nothing changes — no approval required, no behaviour difference.

```bash
git commit -m "feat(finance): require approval to issue invoices above the threshold"
```

---

## Task 5: the approvals queue, and the status board

**Files:** create the approvals queue page and its server actions under `app/(platform)/`; modify `docs/superpowers/PROGRESS.md`.

A queue page listing pending approvals with their kind, requester, age, and a link to the underlying record, plus approve and reject controls. Gate the page on `approve_requests` with 404-not-403. Rejection must collect its required note in the UI, not fail server-side after the click.

Read an existing list page for the house shape rather than inventing one, and follow the action conventions: `requireAal2Actor()` inside the `try`, a discriminated result, a local `toMessage` that maps known errors and leaks nothing.

**PROGRESS.md:** add an approvals-engine row marked ✅ describing what landed and, honestly, what did not — that ECO approval and repair sign-off still use their own direct gates and have not been migrated onto the engine, and that approval tasks reach the approver queue only when the outbox drain runs, while the approvals page itself works immediately. Update the module-deepening row: **Finance threshold approval is now unblocked and done**; Engineering ECO approvals remain a follow-up refactor rather than a blocked item. Update the "Last updated" date. No carried-findings list — the controller appends that.

```bash
git commit -m "feat(platform): approvals queue and status board"
```

---

## Deferred, and deliberately so

- **Migrating ECO approval and repair sign-off onto the engine** — both work today via direct permission gates. Moving them is a refactor; do it once the engine has proven itself on Finance.
- **Notifications** — the `notification` table does not exist. The outbox event is emitted and carries what a notifier would need.
- **Multi-step or quorum approvals** — spec §6.3 describes a single decider. Nothing here forecloses a chain later; nothing here builds one.
- **Approval delegation and out-of-office** — not in the spec.
