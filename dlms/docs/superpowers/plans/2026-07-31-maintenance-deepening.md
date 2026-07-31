# Maintenance Deepening (MA2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four items MA1 explicitly deferred, so a repair or a modification actually drives the component record — spec §5.4's *"the engineer performs one action; the system fans out. No double entry."*

**Architecture:** Three coupled pieces plus one correctness fix. A new `modification` record (spec §6.3) sits beside `repair` as the second thing that can cause a component change. The §14 atomic replacement primitive — `replaceComponentInstallation`, built in C1 and already accepting `repairId`/`modificationId` it currently only records — gets wired to both, so a swap is attributable. Sign-off then gains a precondition that a repair claiming parts were replaced actually has them recorded. Finally, the device's Under Repair ↔ Active move becomes **atomic** with the repair transition instead of best-effort.

**Tech Stack:** TypeScript, node-postgres, Next.js 14 App Router, Vitest (unit + dockerized-PG integration).

**What this is not.** No files or photos — spec §10's attachment pipeline needs S3 presigned uploads and AWS is deferred (roadmap item 6, ⏸️). No usage records — `usage_record` is independent CRUD, not part of this coupled core; it is a separate slice. No approvals — the `approval` table does not exist and is its own roadmap line.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Spec §5.4 is the contract.** One engineer action fans out to the component record inside one transaction; a device must never show a replacement its history lacks, or vice versa.
- **`component_installation` is append-only**, guarded by `fn_component_installation_guard`, which rejects `DELETE` and any `UPDATE` other than the one-time removal stamp. Everything here only ever `INSERT`s or performs that single stamp.
- **The §14 primitive already exists — use it, do not reimplement it.** `modules/manufacturing/services/componentService.ts`'s `replaceComponentInstallation` closes the old installation, opens the new one in the same slot, flips both units' `disposition`, and bumps `device.version`, all in one transaction. It takes `repairId` and `modificationId` today and merely records them.
- **Cross-module calls go through the other module's service**, never its tables. Maintenance already calls `changeDeviceStatus` this way; keep that.
- **Service function shape**, in this order: `authorize(actor, '<permission>', '<module>')` first line; then `<zodSchema>.parse(input)`; then `withTransaction`. Note the recorded finding from the handoff work: a later refactor once moved `authorize` *inside* the transaction and broke `authorize.ts`'s documented "before touching data" invariant. If you extract a `Tx`-accepting internal, keep the guard ahead of the connection.
- **`withTransaction` acquires a separate pooled connection per call.** Calling one service's public function from inside another's transaction does **not** nest — it commits independently. That is the hazard Task 4 exists to fix; `taskService`'s `createTaskInTx` is the established pattern for resolving it.
- Pure domain modules (`modules/*/domain/`) do no I/O: no DB, no `fetch`, no file access, no clock. A date a rule needs is injected.
- Server actions under `app/(platform)/` use `requireAal2Actor()` inside the `try`, never bare `requireActor`; `__tests__/actionAalPinning.test.ts` enforces it. Pages gate 404-not-403.
- No imports from `dlms/lib/domain/` or `dlms/lib/services/` — frozen legacy app behind a module boundary.
- **Migrations:** `<14-digit timestamp>_platform_<subject>.sql`; the `platform_` token is load-bearing. Audit columns + `version`, `SELECT fn_attach_audit(...)`, `ENABLE ROW LEVEL SECURITY` with no policy. Committing deploys nothing.
- **Two migrations are already unapplied on `main`** (`…_platform_manufacturing_import.sql`, `…_platform_outbox.sql`). Yours will be the third. Do not apply anything to cloud — that is the controller's step.
- **Commit attribution:** every commit is authored solely by Reet Mitra. **Never** add a `Co-Authored-By` or any co-author trailer.
- **Verification:** `cd dlms && npm test`, `npm run test:integration`, `npx tsc --noEmit`, `npm run build`. Paste real output.
- **Integration-test gotcha:** `npm run test:integration -- <name>` does **not** filter — the argument lands on the trailing `docker compose down`, which errors and leaves the container running, poisoning later runs. Run it bare from a `down -v` container, or bring the container up and use `npx vitest run --config vitest.integration.config.ts <file>`.

---

## Task 1: `modification` schema and the sign-off flag

**Files:** create `supabase/migrations/20260801000000_platform_modifications.sql`; create `__tests__/integration/modificationService.test.ts` (schema assertions only in this task).

Read `20260720110000_platform_maintenance.sql` first and mirror its conventions — the `repair` table's ref-sequence pattern, its audit attachment, its RLS stance.

**`modification`** per spec §6.3: `id`, a human ref `MOD-YYYY-NNNN` minted from a sequence exactly the way `repair`'s is, `device_id` FK, a `modification_type` vocabulary FK (a vocabulary table, not an enum — admins extend it), `status` over a fail-closed state set, `requested_on`/`completed_on` dates, `requested_by`/`approved_by`/`completed_by` FKs to `app_user`, `reason`, `description`, `previous_configuration` and `new_configuration` free text, `eng_change_id` FK (the Engineering `eng_change` table from E1 — read it for the real column name), `repair_id` FK, `cost_sgd numeric(12,2)`, sign-off columns matching `repair`'s, plus audit columns and `version`.

Seed the `modification_type` vocabulary with a small, sensible set and comment that it is admin-extensible.

**`repair.parts_replaced boolean NOT NULL DEFAULT false`** — the technician's assertion that this repair involved a component change. Task 3's sign-off precondition reads it. Comment it as what it is: a claim that must be backed by a recorded replacement before sign-off.

Schema tests: both tables/columns exist; the ref sequence produces the documented format; RLS on with no policy; audit attached; the FKs resolve.

```bash
git commit -m "feat(maintenance): modification records and the parts-replaced claim"
```

---

## Task 2: modification domain and service

**Files:** create `modules/maintenance/domain/modificationStatus.ts` + its unit test; create `modules/maintenance/services/modificationService.ts` + integration tests (extend Task 1's file).

**Domain (pure).** A fail-closed status graph in the shape of `modules/maintenance/domain/repairStatus.ts` — read it and match its structure: an ordered status list, labels, `isValidModificationTransition`, `allowedNextModificationStatuses`, an `evaluate…` returning a discriminated decision, `messageFor…`, and a typed error class. No row means forbidden. Decide the states from spec §6.3's description of the lifecycle (requested → approved → completed, with a cancelled sink) and justify them in a comment rather than inventing extras.

**Service.** `listModifications`, `getModification`, `createModification`, `updateModification`, `changeModificationStatus`, following `repairService.ts`'s shape function-for-function — same permissions (`view_records`/`create_records`/`edit_records` in `maintenance`), same optimistic-lock discipline, same error types, same 404-not-403 read behaviour.

A modification may reference an **`eco`** (a retrofit spawned by an engineering change order) and/or a `repair`. Both are optional; validate that a referenced row exists rather than trusting the id.

> **Correction found during implementation:** there is no `eng_change` table. `20260720100000_platform_engineering.sql` deliberately split spec §6.3's staged `eng_change` into `ecr` (the request) and `eco` (the order), and says so in its header. The FK is `eco_id REFERENCES eco(id)` — the ERD's "spawns retrofit" edge hangs off the *order*, not the request. Every later task uses `eco_id`.

```bash
git commit -m "feat(maintenance): modification lifecycle domain and service"
```

---

## Task 3: wire §14 replacement to repairs and modifications, and gate sign-off

**Files:** modify `modules/manufacturing/services/componentService.ts` (only if a `Tx`-accepting internal is needed), `modules/maintenance/services/repairService.ts`, `modules/maintenance/domain/repairStatus.ts`; create the server action + UI control on the repair detail page; extend the integration tests.

**Three things:**

1. **A replacement performed from a repair or modification must carry its attribution.** `replaceComponentInstallation` already accepts `repairId`/`modificationId`. Surface it: a control on the repair detail page that lets a technician swap a component *from within the repair*, so the resulting `component_installation` rows reference that repair. Reuse the existing device-profile replacement UI rather than building a second one if that is practical; if not, say why in the report.

2. **Validate the attribution.** A `repairId` passed to `replaceComponentInstallation` must reference a real repair, and that repair must be for the **same device** as the installation being replaced. A swap attributed to another device's repair is a traceability lie, and nothing currently prevents it. Same rule for `modificationId`. Enforce it inside the primitive's transaction so no caller can bypass it.

3. **Sign-off gains a precondition.** `evaluateSignOff` in `repairStatus.ts` currently requires the repair be `awaiting_sign_off` with testing notes. Add: when `parts_replaced` is true, at least one `component_installation` must reference this repair. The rule itself is pure — extend `evaluateSignOff`'s facts with `partsReplaced` and `recordedReplacementCount` and add the error code, message, and tests. The service supplies the count from inside its existing transaction.

This closes the gap where a technician asserts a board was swapped and signs off without the component record ever changing — in a device registry, that is the failure mode that matters.

```bash
git commit -m "feat(maintenance): attribute component replacements to repairs and gate sign-off"
```

---

## Task 4: make the device move atomic, then docs

**Files:** modify `modules/manufacturing/services/deviceWriteService.ts` and `modules/maintenance/services/repairService.ts`; modify `docs/superpowers/PROGRESS.md`.

MA1 shipped the device's Under Repair ↔ Active move as **best-effort**: `repairService` calls `changeDeviceStatus`, which opens its own `withTransaction` on a **separate pooled connection**. So the repair transition and the device move commit independently, and a crash between them leaves a repair that says the device is back in service beside a device still reading Under Repair.

This is the same hazard the outbox drain hit with `createTask`, and it has the same resolution. Extract a `Tx`-accepting internal — `changeDeviceStatusInTx(tx, actor, input)` — leaving the public `changeDeviceStatus` as a thin wrapper, and have the repair transition call the internal inside its own transaction so both commit or neither does.

**Two things to get right, both learned the hard way on the outbox work:**
- Keep `authorize` and the Zod parse **ahead of** the connection for the public entry point. Extract a `prepare()` if that is what it takes — `taskService.ts` shows the shape.
- `changeDeviceStatus` writes an `outbox` row for a handoff transition. Inside a repair's transaction that still holds, and it should: the event stays atomic with everything else. Confirm no handoff edge is affected today and say so in the report.

**Prove atomicity with a test** that would fail if the two were split across transactions — the outbox work's method was a trigger that blocks one of the two writes and an assertion that the other did not survive.

**PROGRESS.md:** add an MA2 row marked ✅ describing what landed, and update the module-deepening row to reflect what remains after this slice — Engineering (failure/RCA, BOM effectivity; doc library blocked on file storage), Maintenance (usage records; files blocked), Finance (invoice PDF; threshold approval blocked on the approvals engine), Logistics (stock levels; uploads blocked). Be explicit about which items are **blocked** versus merely **not started**, since that distinction is what makes the remaining plan readable. Update the "Last updated" date. No carried-findings list — the controller appends that.

```bash
git commit -m "feat(maintenance): commit the device move in the repair's transaction"
```

---

## Deferred, and deliberately so

- **Usage records** (`usage_record`) — independent CRUD, its own slice.
- **Files and photos** — spec §10 needs S3 presigned uploads; AWS is deferred.
- **Approvals** — the `approval` table does not exist; ECO/invoice/repair-sign-off approvals all wait on that engine.
- **ECO-spawned retrofit automation** — the ERD has `eng_change ||--o{ modification`, and this plan lands the FK, but automatic spawning belongs with the approvals engine that triggers it.
