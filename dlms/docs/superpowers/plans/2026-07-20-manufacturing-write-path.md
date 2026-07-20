# Manufacturing Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only Manufacturing device registry into a live system of record — operators can create devices, edit their fields, and move them through the fail-closed status lifecycle, with every change audited and optimistic-locked.

**Architecture:** A new `deviceWriteService.ts` owns all mutations through the platform's `withTransaction(actorId, fn)` owner-pool write path (carries the audit actor in a transaction-local GUC; RLS is bypassed by the owner connection). Status changes are validated against the **`status_transition` table** — the fail-closed graph where *no row = forbidden move* — not a computed flag rule. A tiny pure domain module (`deviceStatus.ts`) holds the decision logic (forbidden / reason-required / terminal-needs-delete-permission) so it is unit-testable with zero I/O. Server actions wrap the service with the established `toMessage` sanitization contract so a raw Postgres error never reaches the browser. UI adds a create route, an edit dialog, and a status-change control on the existing device profile — all permission-gated.

**Tech Stack:** Next.js 14 App Router (server actions), TypeScript, Zod, node-postgres (`pg`) via `lib/db/tx`, Vitest (unit + dockerized-Postgres integration), Tailwind + the existing shadcn/ui component set.

## Global Constraints

Copied from the platform conventions (CLAUDE.md, spec §5.2/§6.2/§6.4) — every task's requirements implicitly include these:

- **Write path:** all mutations go through `withTransaction(actor.id, async (tx) => …)` from `@/lib/db/tx`. Never use a Supabase client for platform-table writes. The owner pool bypasses RLS by design; `fn_audit` trails every statement via the `app.actor_id` GUC that `withTransaction` sets.
- **Authorization:** every service entry point calls `authorize(actor, permission, module)` from `@/modules/shared/authz/authorize` as its first line, before any I/O. It throws `PermissionError`; never return a boolean gate.
- **Permissions used here** (from `@/modules/shared/authz/catalog`): `create_records`, `edit_records`, `change_device_status`, and `delete_records` (the last ONLY as the extra gate on terminal transitions — spec §5.2). Module is always `'manufacturing'`.
- **Optimistic concurrency (spec §6.4):** every device UPDATE checks `version` and sets `version = version + 1, updated_at = now(), updated_by = $actor`. A stale version throws `OptimisticLockError` from `@/lib/db/tx`.
- **Fail-closed transitions (spec §5.2):** a status move is allowed **iff** a row `(from_status, to_status)` exists in `status_transition`. Unknown/missing = rejected. `requires_reason` on that row makes `reason` mandatory. Terminal target (`status_option.is_terminal = true`, i.e. `retired`/`scrapped`) additionally requires `delete_records`.
- **Status history:** every status change (including device creation → initial status) inserts a `device_status_history` row (`from_status`, `to_status`, `reason`, `changed_by`). The device row carries only the current status.
- **Status is edited ONLY through `changeDeviceStatus`.** `updateDevice` must never touch `device.status` — that would bypass the transition graph and the history log.
- **Server actions** return a discriminated `{ ok: true; … } | { ok: false; error: string }` and route every caught error through a `toMessage(err)` helper (pattern: `app/(platform)/manufacturing/devices/[id]/componentActions.ts`). A raw exception must never reach the browser; unknown errors are logged server-side as `console.error(JSON.stringify({ level: 'error', … }))` and replaced with a generic message.
- **404-not-403 for id-addressed reads (spec §7.3):** pages call `can(...)` and `notFound()`; a denial must not confirm a record exists. (Write actions surface a permission error as text — the record is already on screen.)
- **Integration tests** live in `__tests__/integration/*.test.ts`, run against the dockerized Postgres via `TEST_DATABASE_URL`, set `process.env.DATABASE_URL = process.env.TEST_DATABASE_URL` in `beforeAll`, `vi.mock('@/lib/supabase/server', …)`, and `await getPool().end()` in `afterAll`. Use a `runTag = ${Date.now()}-${Math.floor(Math.random()*1e6)}` for any unique column (e.g. `device_sn`) so the file is re-runnable against a persisted container. Clean up rows you create in `afterAll` where practical.
- **Commit attribution:** commits are authored solely by Reet Mitra. **Never** add a `Co-Authored-By` (or any co-author) trailer.
- **No new tables/migrations.** The schema (`20260719000001_platform_devices.sql`) already has `device`, `device_status_history`, `status_transition`, `status_option`, `phase_option`, `device_variant` — all applied to cloud. This plan is code-only.

**Out of scope (deliberately deferred — do NOT build here):**
- Bulk Excel/draft import (its own follow-up plan; pairs with the legacy component-data migration).
- Auto-spawning handoff tasks from `status_transition.task_template_key` (PROGRESS.md tracks this separately — it depends on the transactional-outbox worker).
- Soft-delete / restore of devices (the terminal `retired`/`scrapped` statuses are the lifecycle end; record deletion is a later admin concern).

---

## File Structure

- **Create** `modules/manufacturing/domain/deviceStatus.ts` — pure decision logic for a status change. No I/O. Mirrors `modules/manufacturing/domain/componentInstallation.ts`.
- **Create** `modules/manufacturing/services/deviceWriteService.ts` — `createDevice`, `updateDevice`, `changeDeviceStatus`, `listAllowedTransitions`. All go through `withTransaction`.
- **Modify** `modules/manufacturing/services/deviceReadService.ts` — add `listPhaseOptions` (mirrors `listVariantOptions`) for the create/edit forms.
- **Create** `app/(platform)/manufacturing/devices/deviceWriteActions.ts` — server actions: `createDeviceAction`, `updateDeviceAction`, `changeDeviceStatusAction`, plus the shared `toMessage`.
- **Create** `app/(platform)/manufacturing/devices/new/page.tsx` — the "New device" route (server component; permission-gated).
- **Create** `components/manufacturing/NewDeviceForm.tsx` — client create form.
- **Create** `components/manufacturing/DeviceEditDialog.tsx` — client edit dialog.
- **Create** `components/manufacturing/StatusChangeControl.tsx` — client status-change control (dropdown of allowed next statuses + reason field when required + terminal confirm).
- **Modify** `app/(platform)/manufacturing/devices/page.tsx` — add a permission-gated "New device" button.
- **Modify** `app/(platform)/manufacturing/devices/[id]/page.tsx` — mount the edit dialog + status-change control, gated by `edit_records` / `change_device_status`.
- **Tests:** `__tests__/deviceStatus.test.ts` (unit), `__tests__/integration/deviceWriteService.test.ts` (integration), `__tests__/deviceWriteActions.test.ts` (unit, error mapping).

---

## Task 1: Pure status-change decision domain

**Files:**
- Create: `modules/manufacturing/domain/deviceStatus.ts`
- Test: `__tests__/deviceStatus.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type StatusChangeFacts = { transitionExists: boolean; requiresReason: boolean; toIsTerminal: boolean }`
  - `type StatusChangeDecision = { ok: false; error: 'transition_forbidden' | 'reason_required' } | { ok: true; requiresDeletePermission: boolean }`
  - `function evaluateStatusChange(facts: StatusChangeFacts, input: { reason: string | null }): StatusChangeDecision`
  - `class InvalidStatusChangeError extends Error { readonly code: 'transition_forbidden' | 'reason_required' }`
  - `function messageForStatusChangeError(code, fromLabel, toLabel): string`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/deviceStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  evaluateStatusChange, InvalidStatusChangeError, messageForStatusChangeError,
} from '@/modules/manufacturing/domain/deviceStatus'

describe('evaluateStatusChange', () => {
  it('rejects a move with no status_transition row (fail-closed)', () => {
    const d = evaluateStatusChange(
      { transitionExists: false, requiresReason: false, toIsTerminal: false },
      { reason: null })
    expect(d).toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('rejects when the transition requires a reason and none is given', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: true, toIsTerminal: false },
      { reason: '   ' })).toEqual({ ok: false, error: 'reason_required' })
  })

  it('allows a normal transition, no delete permission needed', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: false, toIsTerminal: false },
      { reason: null })).toEqual({ ok: true, requiresDeletePermission: false })
  })

  it('allows a reason-carrying transition when a reason is present', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: true, toIsTerminal: false },
      { reason: 'customer returned unit' })).toEqual({ ok: true, requiresDeletePermission: false })
  })

  it('flags a terminal target as needing delete permission', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: true, toIsTerminal: true },
      { reason: 'beyond economic repair' })).toEqual({ ok: true, requiresDeletePermission: true })
  })

  it('checks transitionExists before requiresReason (forbidden wins over reason)', () => {
    expect(evaluateStatusChange(
      { transitionExists: false, requiresReason: true, toIsTerminal: false },
      { reason: null })).toEqual({ ok: false, error: 'transition_forbidden' })
  })
})

describe('messageForStatusChangeError', () => {
  it('names both statuses for a forbidden move', () => {
    expect(messageForStatusChangeError('transition_forbidden', 'Retired', 'Active'))
      .toBe('Cannot move a device from "Retired" to "Active".')
  })
  it('asks for a reason', () => {
    expect(messageForStatusChangeError('reason_required', 'Active', 'Returned'))
      .toBe('Moving from "Active" to "Returned" requires a reason.')
  })
})

describe('InvalidStatusChangeError', () => {
  it('carries the code', () => {
    const e = new InvalidStatusChangeError('reason_required', 'nope')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('reason_required')
    expect(e.name).toBe('InvalidStatusChangeError')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npx vitest run __tests__/deviceStatus.test.ts`
Expected: FAIL — module `@/modules/manufacturing/domain/deviceStatus` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// modules/manufacturing/domain/deviceStatus.ts
/**
 * Pure decision logic for a device status change (spec §5.2). No I/O — the
 * service loads the three facts from status_transition / status_option and
 * hands them here. Mirrors componentInstallation.assertReplacementShape:
 * impossible/forbidden moves are decided before any DB write.
 *
 * The graph itself is the status_transition TABLE (fail-closed: no row =
 * forbidden). This function does NOT know the graph; it only interprets the
 * facts a single candidate move produced.
 */
export type StatusChangeErrorCode = 'transition_forbidden' | 'reason_required'

export type StatusChangeFacts = {
  /** A row (from_status, to_status) exists in status_transition. */
  transitionExists: boolean
  /** That row's requires_reason flag. */
  requiresReason: boolean
  /** The target status_option.is_terminal (retired/scrapped). */
  toIsTerminal: boolean
}

export type StatusChangeDecision =
  | { ok: false; error: StatusChangeErrorCode }
  | { ok: true; requiresDeletePermission: boolean }

export function evaluateStatusChange(
  facts: StatusChangeFacts,
  input: { reason: string | null },
): StatusChangeDecision {
  if (!facts.transitionExists) return { ok: false, error: 'transition_forbidden' }
  if (facts.requiresReason && !input.reason?.trim()) return { ok: false, error: 'reason_required' }
  return { ok: true, requiresDeletePermission: facts.toIsTerminal }
}

export class InvalidStatusChangeError extends Error {
  readonly code: StatusChangeErrorCode
  constructor(code: StatusChangeErrorCode, message: string) {
    super(message)
    this.name = 'InvalidStatusChangeError'
    this.code = code
  }
}

export function messageForStatusChangeError(
  code: StatusChangeErrorCode, fromLabel: string, toLabel: string,
): string {
  return code === 'transition_forbidden'
    ? `Cannot move a device from "${fromLabel}" to "${toLabel}".`
    : `Moving from "${fromLabel}" to "${toLabel}" requires a reason.`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npx vitest run __tests__/deviceStatus.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add dlms/modules/manufacturing/domain/deviceStatus.ts dlms/__tests__/deviceStatus.test.ts
git commit -m "feat(manufacturing): pure status-change decision domain"
```

---

## Task 2: `changeDeviceStatus` service (the fail-closed graph)

**Files:**
- Create: `modules/manufacturing/services/deviceWriteService.ts`
- Test: `__tests__/integration/deviceWriteService.test.ts`

**Interfaces:**
- Consumes: `evaluateStatusChange`, `InvalidStatusChangeError`, `messageForStatusChangeError` (Task 1); `withTransaction`, `OptimisticLockError`, `Tx` (`@/lib/db/tx`); `authorize` (`@/modules/shared/authz/authorize`); `Actor` (`@/modules/shared/authz/catalog`).
- Produces:
  - `class DeviceNotFoundError extends Error`
  - `async function changeDeviceStatus(actor: Actor, input: { deviceId: string; toStatus: string; reason?: string; version: number }): Promise<{ status: string; version: number }>`

- [ ] **Step 1: Write the failing integration test**

```ts
// __tests__/integration/deviceWriteService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { changeDeviceStatus, DeviceNotFoundError } from '@/modules/manufacturing/services/deviceWriteService'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdDeviceIds: string[] = []

// operator: view/create/edit/change_device_status, NOT delete_records
const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'change_device_status']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
// manager: adds delete_records (can retire/scrap)
const mgr = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'change_device_status', 'delete_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

async function makeDevice(status: string): Promise<{ id: string; version: number }> {
  const { rows } = await db.query<{ id: string; version: number }>(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), $1, $2, $2)
     RETURNING id, version`, [status, userId])
  createdDeviceIds.push(rows[0].id)
  return rows[0]
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => {
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device_status_history WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end(); await getPool().end()
})

describe('changeDeviceStatus', () => {
  it('refuses a viewer (no change_device_status)', async () => {
    const d = await makeDevice('in_production')
    await expect(changeDeviceStatus(viewer(), { deviceId: d.id, toStatus: 'quality_check', version: d.version }))
      .rejects.toThrow(PermissionError)
  })

  it('performs an allowed move: updates status, bumps version, writes history', async () => {
    const d = await makeDevice('in_production')
    const res = await changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'quality_check', version: d.version })
    expect(res.status).toBe('quality_check')
    expect(res.version).toBe(d.version + 1)
    const dev = await db.query(`SELECT status, version FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0]).toMatchObject({ status: 'quality_check', version: d.version + 1 })
    const hist = await db.query(
      `SELECT from_status, to_status, changed_by FROM device_status_history WHERE device_id=$1`, [d.id])
    expect(hist.rows).toEqual([{ from_status: 'in_production', to_status: 'quality_check', changed_by: userId }])
  })

  it('rejects a move with no status_transition row (fail-closed)', async () => {
    const d = await makeDevice('in_production')
    // in_production -> shipped is not an edge
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'shipped', version: d.version }))
      .rejects.toThrow(InvalidStatusChangeError)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0].status).toBe('in_production') // unchanged
  })

  it('requires a reason on a requires_reason transition (quality_check -> in_production is rework)', async () => {
    const d = await makeDevice('quality_check')
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'in_production', version: d.version }))
      .rejects.toThrow(InvalidStatusChangeError)
    // with a reason it succeeds and stores the reason
    const ok = await changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'in_production', version: d.version, reason: 'solder rework' })
    expect(ok.status).toBe('in_production')
    const hist = await db.query(
      `SELECT reason FROM device_status_history WHERE device_id=$1 ORDER BY changed_at DESC LIMIT 1`, [d.id])
    expect(hist.rows[0].reason).toBe('solder rework')
  })

  it('blocks an operator from a terminal transition (needs delete_records)', async () => {
    // active -> retired is terminal. Seed device at 'active'.
    const d = await makeDevice('active')
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'retired', version: d.version }))
      .rejects.toThrow(PermissionError)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0].status).toBe('active') // rolled back
  })

  it('lets a manager perform the terminal transition', async () => {
    const d = await makeDevice('active')
    const res = await changeDeviceStatus(mgr(), { deviceId: d.id, toStatus: 'retired', version: d.version })
    expect(res.status).toBe('retired')
  })

  it('rejects a stale version with OptimisticLockError', async () => {
    const d = await makeDevice('in_production')
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'quality_check', version: d.version + 99 }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('throws DeviceNotFoundError for an unknown id', async () => {
    await expect(changeDeviceStatus(op(), {
      deviceId: '00000000-0000-0000-0000-000000000000', toStatus: 'quality_check', version: 1,
    })).rejects.toThrow(DeviceNotFoundError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npx vitest run __tests__/integration/deviceWriteService.test.ts`
Expected: FAIL — `deviceWriteService` has no `changeDeviceStatus` export.

- [ ] **Step 3: Write the service**

```ts
// modules/manufacturing/services/deviceWriteService.ts
import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  evaluateStatusChange, InvalidStatusChangeError, messageForStatusChangeError,
} from '@/modules/manufacturing/domain/deviceStatus'

export class DeviceNotFoundError extends Error {
  constructor(deviceId: string) {
    super(`Device ${deviceId} not found`)
    this.name = 'DeviceNotFoundError'
  }
}

const changeStatusSchema = z.object({
  deviceId: z.string().uuid(),
  toStatus: z.string().min(1).max(50),
  reason: z.string().max(2000).optional(),
  version: z.number().int().nonnegative(),
})
export type ChangeStatusInput = z.input<typeof changeStatusSchema>

/**
 * Move a device to a new status through the fail-closed status_transition graph
 * (spec §5.2). One transaction: lock the device row, validate the edge exists,
 * enforce requires_reason and the terminal-needs-delete_records rule, then
 * UPDATE the device (version bump) and INSERT the history row — atomically.
 * A rejected move writes nothing.
 */
export async function changeDeviceStatus(
  actor: Actor, input: ChangeStatusInput,
): Promise<{ status: string; version: number }> {
  authorize(actor, 'change_device_status', 'manufacturing')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    // Lock the target device; read the true current status + version.
    const { rows: devRows } = await tx.query<{ status: string; version: number }>(
      `SELECT status, version FROM device
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.deviceId])
    if (devRows.length === 0) throw new DeviceNotFoundError(data.deviceId)
    const current = devRows[0]
    if (current.version !== data.version) throw new OptimisticLockError('device', data.deviceId)

    // Load the three decision facts in one round trip: does the edge exist +
    // its requires_reason, and is the target terminal + its label (for errors).
    const { rows: factRows } = await tx.query<{
      transition_exists: boolean; requires_reason: boolean
      to_is_terminal: boolean; to_label: string | null; from_label: string
    }>(
      `SELECT (st.from_status IS NOT NULL)                       AS transition_exists,
              COALESCE(st.requires_reason, false)                AS requires_reason,
              so_to.is_terminal                                  AS to_is_terminal,
              so_to.label_en                                     AS to_label,
              so_from.label_en                                   AS from_label
         FROM status_option so_from
         JOIN status_option so_to ON so_to.code = $2
         LEFT JOIN status_transition st
           ON st.from_status = so_from.code AND st.to_status = $2
        WHERE so_from.code = $1`, [current.status, data.toStatus])
    // so_to unknown → no row at all → treat as forbidden with the raw code label.
    const facts = factRows[0]
    const toLabel = facts?.to_label ?? data.toStatus
    const fromLabel = facts?.from_label ?? current.status
    if (!facts) {
      throw new InvalidStatusChangeError(
        'transition_forbidden',
        messageForStatusChangeError('transition_forbidden', fromLabel, toLabel))
    }

    const decision = evaluateStatusChange(
      { transitionExists: facts.transition_exists, requiresReason: facts.requires_reason,
        toIsTerminal: facts.to_is_terminal },
      { reason: data.reason ?? null })
    if (!decision.ok) {
      throw new InvalidStatusChangeError(
        decision.error, messageForStatusChangeError(decision.error, fromLabel, toLabel))
    }
    // Terminal moves (retired/scrapped) need delete_records on top of
    // change_device_status (spec §5.2). Thrown inside the tx → full rollback.
    if (decision.requiresDeletePermission) authorize(actor, 'delete_records', 'manufacturing')

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE device
          SET status = $1, version = version + 1, updated_at = now(), updated_by = $2
        WHERE id = $3 AND version = $4
        RETURNING version`,
      [data.toStatus, actor.id, data.deviceId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('device', data.deviceId)

    await tx.query(
      `INSERT INTO device_status_history (device_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [data.deviceId, current.status, data.toStatus, data.reason ?? null, actor.id])

    return { status: data.toStatus, version: updated[0].version }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npx vitest run __tests__/integration/deviceWriteService.test.ts`
Expected: PASS (8 cases). If the integration DB is not up, start it per the repo's integration-test harness first.

- [ ] **Step 5: Commit**

```bash
git add dlms/modules/manufacturing/services/deviceWriteService.ts dlms/__tests__/integration/deviceWriteService.test.ts
git commit -m "feat(manufacturing): changeDeviceStatus through the fail-closed status_transition graph"
```

---

## Task 3: `createDevice` + `updateDevice` + `listAllowedTransitions`

**Files:**
- Modify: `modules/manufacturing/services/deviceWriteService.ts`
- Modify: `modules/manufacturing/services/deviceReadService.ts` (add `listPhaseOptions`)
- Test: `__tests__/integration/deviceWriteService.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: everything from Task 2 plus `VocabOption` (`deviceReadService`).
- Produces:
  - `class DuplicateSerialError extends Error`
  - `type CreateDeviceInput` (Zod input) and `async function createDevice(actor, input): Promise<{ deviceId: string; status: string }>`
  - `type UpdateDeviceInput` (Zod input) and `async function updateDevice(actor, input): Promise<{ version: number }>`
  - `type AllowedTransition = { toStatus: string; toLabel: string; requiresReason: boolean; isTerminal: boolean }` and `async function listAllowedTransitions(actor, fromStatus: string): Promise<AllowedTransition[]>`
  - `deviceReadService.listPhaseOptions(actor): Promise<VocabOption[]>`

- [ ] **Step 1: Add `listPhaseOptions` to the read service**

Append to `modules/manufacturing/services/deviceReadService.ts` (after `listVariantOptions`):

```ts
/** Active phase codes for the create/edit forms (legacy manufacturing phase). */
export async function listPhaseOptions(actor: Actor): Promise<VocabOption[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ code: string; label_en: string }>(
      `SELECT code, label_en FROM phase_option WHERE active ORDER BY sort_order`)
    return rows.map((r) => ({ code: r.code, label: r.label_en }))
  })
}
```

- [ ] **Step 2: Write the failing tests (append to the integration file)**

```ts
// append to __tests__/integration/deviceWriteService.test.ts
import { createDevice, updateDevice, listAllowedTransitions, DuplicateSerialError } from '@/modules/manufacturing/services/deviceWriteService'

describe('createDevice', () => {
  it('refuses an actor without create_records', async () => {
    await expect(createDevice(viewer(), { variantCode: 'pro' })).rejects.toThrow(PermissionError)
  })

  it('creates a device at the initial status with a "Created" history row', async () => {
    const res = await createDevice(op(), {
      variantCode: 'pro', deviceSn: `QTX-W-${runTag}`, productName: 'Widget', customer: 'ACME',
    })
    createdDeviceIds.push(res.deviceId)
    expect(res.status).toBe('in_production') // the seeded is_initial status
    const dev = await db.query(`SELECT status, device_sn, product_name, created_by, version FROM device WHERE id=$1`, [res.deviceId])
    expect(dev.rows[0]).toMatchObject({
      status: 'in_production', device_sn: `QTX-W-${runTag}`, product_name: 'Widget', created_by: userId, version: 1,
    })
    const hist = await db.query(`SELECT from_status, to_status FROM device_status_history WHERE device_id=$1`, [res.deviceId])
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'in_production' }])
  })

  it('rejects an unknown variant', async () => {
    await expect(createDevice(op(), { variantCode: 'nope' })).rejects.toThrow(/variant/i)
  })

  it('rejects a duplicate serial with DuplicateSerialError', async () => {
    const sn = `QTX-DUP-${runTag}`
    const a = await createDevice(op(), { variantCode: 'pro', deviceSn: sn })
    createdDeviceIds.push(a.deviceId)
    await expect(createDevice(op(), { variantCode: 'pro', deviceSn: sn })).rejects.toThrow(DuplicateSerialError)
  })
})

describe('updateDevice', () => {
  it('edits non-status fields, bumps version, leaves status untouched', async () => {
    const c = await createDevice(op(), { variantCode: 'pro', productName: 'Before' })
    createdDeviceIds.push(c.deviceId)
    const dev0 = await db.query(`SELECT version, status FROM device WHERE id=$1`, [c.deviceId])
    const res = await updateDevice(op(), {
      deviceId: c.deviceId, version: dev0.rows[0].version, productName: 'After', remarks: 'note',
    })
    expect(res.version).toBe(dev0.rows[0].version + 1)
    const dev1 = await db.query(`SELECT product_name, remarks, status, updated_by FROM device WHERE id=$1`, [c.deviceId])
    expect(dev1.rows[0]).toMatchObject({
      product_name: 'After', remarks: 'note', status: dev0.rows[0].status, updated_by: userId,
    })
  })

  it('rejects a stale version', async () => {
    const c = await createDevice(op(), { variantCode: 'pro' })
    createdDeviceIds.push(c.deviceId)
    await expect(updateDevice(op(), { deviceId: c.deviceId, version: 999, productName: 'x' }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('rejects renaming to an existing serial (DuplicateSerialError)', async () => {
    const taken = `QTX-TAKEN-${runTag}`
    const a = await createDevice(op(), { variantCode: 'pro', deviceSn: taken })
    const b = await createDevice(op(), { variantCode: 'pro' })
    createdDeviceIds.push(a.deviceId, b.deviceId)
    const bv = (await db.query(`SELECT version FROM device WHERE id=$1`, [b.deviceId])).rows[0].version
    await expect(updateDevice(op(), { deviceId: b.deviceId, version: bv, deviceSn: taken }))
      .rejects.toThrow(DuplicateSerialError)
  })

  it('does NOT expose a status field (status is change-only)', async () => {
    const c = await createDevice(op(), { variantCode: 'pro' })
    createdDeviceIds.push(c.deviceId)
    const bv = (await db.query(`SELECT version FROM device WHERE id=$1`, [c.deviceId])).rows[0].version
    // @ts-expect-error status is intentionally not part of UpdateDeviceInput
    await updateDevice(op(), { deviceId: c.deviceId, version: bv, status: 'shipped' })
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [c.deviceId])
    expect(dev.rows[0].status).toBe('in_production') // ignored
  })
})

describe('listAllowedTransitions', () => {
  it('returns only the edges out of the given status, with metadata', async () => {
    const rows = await listAllowedTransitions(op(), 'quality_check')
    const codes = rows.map((r) => r.toStatus).sort()
    expect(codes).toEqual(['in_production', 'in_stock']) // the two edges from quality_check
    const rework = rows.find((r) => r.toStatus === 'in_production')!
    expect(rework.requiresReason).toBe(true)
    expect(rework.isTerminal).toBe(false)
  })

  it('returns [] for a terminal status', async () => {
    expect(await listAllowedTransitions(op(), 'retired')).toEqual([])
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd dlms && npx vitest run __tests__/integration/deviceWriteService.test.ts`
Expected: FAIL — `createDevice`/`updateDevice`/`listAllowedTransitions`/`DuplicateSerialError` not exported.

- [ ] **Step 4: Implement (append to `deviceWriteService.ts`)**

```ts
// append to modules/manufacturing/services/deviceWriteService.ts

export class DuplicateSerialError extends Error {
  constructor(sn: string) {
    super(`A device with serial "${sn}" already exists`)
    this.name = 'DuplicateSerialError'
  }
}

// device_sn_unique is a partial unique index (device_sn IS NOT NULL AND
// deleted_at IS NULL) → Postgres error 23505. Map it to the friendly error;
// re-throw anything else.
function rethrowDbError(err: unknown, deviceSn: string | null | undefined): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505'
      && deviceSn) throw new DuplicateSerialError(deviceSn)
  throw err
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const createSchema = z.object({
  variantCode: z.string().min(1),
  deviceSn: z.string().max(100).optional(),
  phase: z.string().max(50).optional(),
  productName: z.string().max(200).optional(),
  modelNo: z.string().max(100).optional(),
  customer: z.string().max(200).optional(),
  destination: z.string().max(200).optional(),
  remarks: z.string().max(5000).optional(),
  buildDate: DATE.optional(),
  shipDate: DATE.optional(),
  deliveredDate: DATE.optional(),
})
export type CreateDeviceInput = z.input<typeof createSchema>

/**
 * Create a device at the vocabulary's initial status (spec §5.2: is_initial =
 * creation-only). One transaction: resolve the variant, insert the device at
 * the initial status, and write the "Created → initial" history row so the
 * profile's Status-history tab reads correctly from the first moment.
 */
export async function createDevice(
  actor: Actor, input: CreateDeviceInput,
): Promise<{ deviceId: string; status: string }> {
  authorize(actor, 'create_records', 'manufacturing')
  const data = createSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: vRows } = await tx.query<{ id: string }>(
      `SELECT id FROM device_variant WHERE code = $1 AND active`, [data.variantCode])
    if (vRows.length === 0) throw new Error(`Unknown or inactive variant: ${data.variantCode}`)

    const { rows: sRows } = await tx.query<{ code: string }>(
      `SELECT code FROM status_option WHERE is_initial AND active ORDER BY sort_order LIMIT 1`)
    if (sRows.length === 0) throw new Error('No initial device status is configured')
    const initialStatus = sRows[0].code

    let deviceId: string
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO device
           (device_sn, variant_id, status, phase, product_name, model_no, customer,
            destination, remarks, build_date, ship_date, delivered_date, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         RETURNING id`,
        [data.deviceSn ?? null, vRows[0].id, initialStatus, data.phase ?? null,
         data.productName ?? null, data.modelNo ?? null, data.customer ?? null,
         data.destination ?? null, data.remarks ?? null, data.buildDate ?? null,
         data.shipDate ?? null, data.deliveredDate ?? null, actor.id])
      deviceId = rows[0].id
    } catch (err) {
      rethrowDbError(err, data.deviceSn)
    }

    await tx.query(
      `INSERT INTO device_status_history (device_id, from_status, to_status, changed_by)
       VALUES ($1, NULL, $2, $3)`, [deviceId!, initialStatus, actor.id])

    return { deviceId: deviceId!, status: initialStatus }
  })
}

const updateSchema = z.object({
  deviceId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  deviceSn: z.string().max(100).nullish(),
  variantCode: z.string().min(1).optional(),
  phase: z.string().max(50).nullish(),
  productName: z.string().max(200).nullish(),
  modelNo: z.string().max(100).nullish(),
  customer: z.string().max(200).nullish(),
  destination: z.string().max(200).nullish(),
  remarks: z.string().max(5000).nullish(),
  buildDate: DATE.nullish(),
  shipDate: DATE.nullish(),
  deliveredDate: DATE.nullish(),
})
export type UpdateDeviceInput = z.input<typeof updateSchema>

// The editable columns, mapping camelCase input keys → device columns. status is
// deliberately absent: it is changed ONLY through changeDeviceStatus so the
// transition graph and history log can never be bypassed (Global Constraints).
const UPDATE_COLUMNS: Record<string, string> = {
  deviceSn: 'device_sn', phase: 'phase', productName: 'product_name', modelNo: 'model_no',
  customer: 'customer', destination: 'destination', remarks: 'remarks',
  buildDate: 'build_date', shipDate: 'ship_date', deliveredDate: 'delivered_date',
}

/**
 * Edit a device's non-status fields under optimistic concurrency. Only the keys
 * actually present in the input are written (a partial update), so omitting a
 * field leaves it untouched while explicitly passing null clears it. Status is
 * not editable here by construction.
 */
export async function updateDevice(
  actor: Actor, input: UpdateDeviceInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'manufacturing')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: devRows } = await tx.query<{ version: number }>(
      `SELECT version FROM device WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.deviceId])
    if (devRows.length === 0) throw new DeviceNotFoundError(data.deviceId)
    if (devRows[0].version !== data.version) throw new OptimisticLockError('device', data.deviceId)

    const sets: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (data.variantCode !== undefined) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM device_variant WHERE code = $1 AND active`, [data.variantCode])
      if (rows.length === 0) throw new Error(`Unknown or inactive variant: ${data.variantCode}`)
      sets.push(`variant_id = ${p(rows[0].id)}`)
    }
    for (const [key, col] of Object.entries(UPDATE_COLUMNS)) {
      if (key in data && (data as Record<string, unknown>)[key] !== undefined) {
        sets.push(`${col} = ${p((data as Record<string, unknown>)[key])}`)
      }
    }

    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    try {
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE device SET ${setSql} WHERE id = ${p(data.deviceId)} AND version = ${p(data.version)}
          RETURNING version`, params)
      if (rows.length === 0) throw new OptimisticLockError('device', data.deviceId)
      return { version: rows[0].version }
    } catch (err) {
      rethrowDbError(err, data.deviceSn)
    }
  })
}

export type AllowedTransition = {
  toStatus: string; toLabel: string; requiresReason: boolean; isTerminal: boolean
}

/**
 * The edges out of `fromStatus`, for the status-change UI. Ordered by the
 * target's sort_order so the dropdown reads in lifecycle order. Returns [] for
 * a terminal or unknown status (the graph simply has no rows). Read-only.
 */
export async function listAllowedTransitions(
  actor: Actor, fromStatus: string,
): Promise<AllowedTransition[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      to_status: string; to_label: string; requires_reason: boolean; is_terminal: boolean
    }>(
      `SELECT st.to_status, so.label_en AS to_label, st.requires_reason, so.is_terminal
         FROM status_transition st
         JOIN status_option so ON so.code = st.to_status
        WHERE st.from_status = $1 AND so.active
        ORDER BY so.sort_order`, [fromStatus])
    return rows.map((r) => ({
      toStatus: r.to_status, toLabel: r.to_label,
      requiresReason: r.requires_reason, isTerminal: r.is_terminal,
    }))
  })
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd dlms && npx vitest run __tests__/integration/deviceWriteService.test.ts`
Expected: PASS (all Task 2 + Task 3 cases).

- [ ] **Step 6: Commit**

```bash
git add dlms/modules/manufacturing/services/deviceWriteService.ts dlms/modules/manufacturing/services/deviceReadService.ts dlms/__tests__/integration/deviceWriteService.test.ts
git commit -m "feat(manufacturing): createDevice/updateDevice/listAllowedTransitions write service"
```

---

## Task 4: Server actions + error sanitization

**Files:**
- Create: `app/(platform)/manufacturing/devices/deviceWriteActions.ts`
- Test: `__tests__/deviceWriteActions.test.ts`

**Interfaces:**
- Consumes: the Task 2/3 service exports; `requireActor` (`@/modules/shared/auth/session`); `InvalidStatusChangeError` (Task 1); `DeviceNotFoundError`, `DuplicateSerialError` (Task 3); `OptimisticLockError` (`@/lib/db/tx`); `PermissionError` (`@/modules/shared/authz/authorize`); `revalidatePath` (`next/cache`).
- Produces:
  - `type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }`
  - `async function createDeviceAction(input: CreateDeviceInput): Promise<ActionResult<{ deviceId: string }>>`
  - `async function updateDeviceAction(input: UpdateDeviceInput): Promise<ActionResult<{ version: number }>>`
  - `async function changeDeviceStatusAction(input: ChangeStatusInput): Promise<ActionResult<{ status: string; version: number }>>`

- [ ] **Step 1: Write the failing unit test (mock the service)**

```ts
// __tests__/deviceWriteActions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/modules/shared/auth/session', () => ({
  requireActor: vi.fn(async () => ({
    id: 'u1', roleKey: 'operator',
    permissions: new Set(['create_records', 'edit_records', 'change_device_status']),
    moduleAccess: new Set(['manufacturing']), active: true,
  })),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/modules/manufacturing/services/deviceWriteService', () => ({
  createDevice: vi.fn(),
  updateDevice: vi.fn(),
  changeDeviceStatus: vi.fn(),
  DeviceNotFoundError: class DeviceNotFoundError extends Error {},
  DuplicateSerialError: class DuplicateSerialError extends Error {},
}))

import { createDeviceAction, updateDeviceAction, changeDeviceStatusAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import * as svc from '@/modules/manufacturing/services/deviceWriteService'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

beforeEach(() => vi.clearAllMocks())

describe('createDeviceAction', () => {
  it('returns ok with the new id on success', async () => {
    vi.mocked(svc.createDevice).mockResolvedValue({ deviceId: 'd1', status: 'in_production' })
    expect(await createDeviceAction({ variantCode: 'pro' })).toEqual({ ok: true, data: { deviceId: 'd1' } })
  })
  it('maps DuplicateSerialError to its own message', async () => {
    vi.mocked(svc.createDevice).mockRejectedValue(new svc.DuplicateSerialError('dup'))
    const res = await createDeviceAction({ variantCode: 'pro', deviceSn: 'dup' })
    expect(res).toEqual({ ok: false, error: expect.stringContaining('dup') })
  })
  it('maps PermissionError to a generic denial (no internals)', async () => {
    vi.mocked(svc.createDevice).mockRejectedValue(new PermissionError('create_records', 'manufacturing'))
    const res = await createDeviceAction({ variantCode: 'pro' })
    expect(res).toEqual({ ok: false, error: "You don't have permission to do that." })
  })
  it('never leaks an unknown error', async () => {
    vi.mocked(svc.createDevice).mockRejectedValue(new Error('column "secret" does not exist'))
    const res = await createDeviceAction({ variantCode: 'pro' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).not.toContain('secret')
  })
})

describe('changeDeviceStatusAction', () => {
  it('surfaces InvalidStatusChangeError.message (safe, user-facing)', async () => {
    vi.mocked(svc.changeDeviceStatus).mockRejectedValue(
      new InvalidStatusChangeError('reason_required', 'Moving from "Active" to "Returned" requires a reason.'))
    const res = await changeDeviceStatusAction({ deviceId: 'd1', toStatus: 'returned', version: 1 })
    expect(res).toEqual({ ok: false, error: 'Moving from "Active" to "Returned" requires a reason.' })
  })
  it('maps OptimisticLockError to the reload message', async () => {
    vi.mocked(svc.changeDeviceStatus).mockRejectedValue(new OptimisticLockError('device', 'd1'))
    const res = await changeDeviceStatusAction({ deviceId: 'd1', toStatus: 'quality_check', version: 1 })
    expect(res).toEqual({ ok: false, error: 'Someone else changed this device. Reload and try again.' })
  })
  it('returns ok with the new status/version', async () => {
    vi.mocked(svc.changeDeviceStatus).mockResolvedValue({ status: 'quality_check', version: 2 })
    expect(await changeDeviceStatusAction({ deviceId: 'd1', toStatus: 'quality_check', version: 1 }))
      .toEqual({ ok: true, data: { status: 'quality_check', version: 2 } })
  })
})

describe('updateDeviceAction', () => {
  it('returns ok with the new version', async () => {
    vi.mocked(svc.updateDevice).mockResolvedValue({ version: 3 })
    expect(await updateDeviceAction({ deviceId: 'd1', version: 2, productName: 'x' }))
      .toEqual({ ok: true, data: { version: 3 } })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dlms && npx vitest run __tests__/deviceWriteActions.test.ts`
Expected: FAIL — action module not found.

- [ ] **Step 3: Implement the actions**

```ts
// app/(platform)/manufacturing/devices/deviceWriteActions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/shared/auth/session'
import {
  createDevice, updateDevice, changeDeviceStatus,
  DeviceNotFoundError, DuplicateSerialError,
  type CreateDeviceInput, type UpdateDeviceInput, type ChangeStatusInput,
} from '@/modules/manufacturing/services/deviceWriteService'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every device write action (mirrors
 * componentActions.toMessage). Known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a
 * raw Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof DuplicateSerialError) return err.message
  if (err instanceof InvalidStatusChangeError) return err.message
  if (err instanceof DeviceNotFoundError) return 'That device no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this device. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'device write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createDeviceAction(
  input: CreateDeviceInput,
): Promise<ActionResult<{ deviceId: string }>> {
  try {
    const actor = await requireActor()
    const { deviceId } = await createDevice(actor, input)
    revalidatePath('/manufacturing/devices')
    return { ok: true, data: { deviceId } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateDeviceAction(
  input: UpdateDeviceInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireActor()
    const res = await updateDevice(actor, input)
    revalidatePath(`/manufacturing/devices/${input.deviceId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeDeviceStatusAction(
  input: ChangeStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireActor()
    const res = await changeDeviceStatus(actor, input)
    revalidatePath(`/manufacturing/devices/${input.deviceId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dlms && npx vitest run __tests__/deviceWriteActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "dlms/app/(platform)/manufacturing/devices/deviceWriteActions.ts" dlms/__tests__/deviceWriteActions.test.ts
git commit -m "feat(manufacturing): device write server actions with error sanitization"
```

---

## Task 5: Create-device flow (route + form + list button)

**Files:**
- Create: `app/(platform)/manufacturing/devices/new/page.tsx`
- Create: `components/manufacturing/NewDeviceForm.tsx`
- Modify: `app/(platform)/manufacturing/devices/page.tsx` (add the gated "New device" button)

**Interfaces:**
- Consumes: `createDeviceAction` (Task 4); `listVariantOptions`, `listPhaseOptions` (read service); `requireActor`, `can`.
- Produces: the `/manufacturing/devices/new` route and a "New device" entry point on the list.

- [ ] **Step 1: Build the client form**

```tsx
// components/manufacturing/NewDeviceForm.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createDeviceAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import type { VocabOption } from '@/modules/manufacturing/services/deviceReadService'

type Props = { variantOptions: VocabOption[]; phaseOptions: VocabOption[] }

const NONE = '__none__' // Radix Select cannot hold an empty-string value

export function NewDeviceForm({ variantOptions, phaseOptions }: Props) {
  const router = useRouter()
  const [variantCode, setVariantCode] = useState(variantOptions[0]?.code ?? '')
  const [deviceSn, setDeviceSn] = useState('')
  const [productName, setProductName] = useState('')
  const [modelNo, setModelNo] = useState('')
  const [customer, setCustomer] = useState('')
  const [destination, setDestination] = useState('')
  const [phase, setPhase] = useState(NONE)
  const [buildDate, setBuildDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createDeviceAction({
        variantCode,
        deviceSn: deviceSn.trim() || undefined,
        productName: productName.trim() || undefined,
        modelNo: modelNo.trim() || undefined,
        customer: customer.trim() || undefined,
        destination: destination.trim() || undefined,
        phase: phase === NONE ? undefined : phase,
        buildDate: buildDate || undefined,
        remarks: remarks.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Device created')
      router.push(`/manufacturing/devices/${res.data.deviceId}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="variant" className="mb-1.5 block">Variant (required)</Label>
          <Select value={variantCode} onValueChange={setVariantCode}>
            <SelectTrigger id="variant"><SelectValue /></SelectTrigger>
            <SelectContent>
              {variantOptions.map((v) => <SelectItem key={v.code} value={v.code}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="deviceSn" className="mb-1.5 block">Serial number</Label>
          <Input id="deviceSn" value={deviceSn} onChange={(e) => setDeviceSn(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="productName" className="mb-1.5 block">Product name</Label>
          <Input id="productName" value={productName} onChange={(e) => setProductName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="modelNo" className="mb-1.5 block">Model no.</Label>
          <Input id="modelNo" value={modelNo} onChange={(e) => setModelNo(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="customer" className="mb-1.5 block">Customer</Label>
          <Input id="customer" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="destination" className="mb-1.5 block">Destination</Label>
          <Input id="destination" value={destination} onChange={(e) => setDestination(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="phase" className="mb-1.5 block">Phase</Label>
          <Select value={phase} onValueChange={setPhase}>
            <SelectTrigger id="phase"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {phaseOptions.map((p) => <SelectItem key={p.code} value={p.code}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="buildDate" className="mb-1.5 block">Build date</Label>
          <Input id="buildDate" type="date" value={buildDate} onChange={(e) => setBuildDate(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="remarks" className="mb-1.5 block">Remarks</Label>
        <Textarea id="remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">
        New devices start at the initial lifecycle status. Move them onward from the device page.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/manufacturing/devices')} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !variantCode}>
          {submitting ? 'Creating…' : 'Create device'}
        </Button>
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Build the route (server component, permission-gated)**

```tsx
// app/(platform)/manufacturing/devices/new/page.tsx
import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listVariantOptions, listPhaseOptions } from '@/modules/manufacturing/services/deviceReadService'
import { NewDeviceForm } from '@/components/manufacturing/NewDeviceForm'

/** Create a device (spec §5.2). 404-not-403 so a denial doesn't confirm the route. */
export default async function NewDevicePage() {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'manufacturing')) notFound()

  const [variantOptions, phaseOptions] = await Promise.all([
    listVariantOptions(actor), listPhaseOptions(actor),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New device</h1>
        <p className="mt-1 text-slate-600">Register a device in the manufacturing registry.</p>
      </div>
      <NewDeviceForm variantOptions={variantOptions} phaseOptions={phaseOptions} />
    </div>
  )
}
```

- [ ] **Step 3: Add the gated "New device" button to the list page**

In `app/(platform)/manufacturing/devices/page.tsx`, add the import and render a button in the header. Replace the header `<div>` block:

```tsx
// add near the top imports
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'
```

Replace:

```tsx
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Devices</h1>
        <p className="mt-1 text-slate-600">
          The full device registry — search by serial, filter, and open a record.
        </p>
      </div>
```

with:

```tsx
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Devices</h1>
          <p className="mt-1 text-slate-600">
            The full device registry — search by serial, filter, and open a record.
          </p>
        </div>
        {can(actor, 'create_records', 'manufacturing') && (
          <Button asChild>
            <Link href="/manufacturing/devices/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New device
            </Link>
          </Button>
        )}
      </div>
```

- [ ] **Step 4: Verify types + build**

Run: `cd dlms && npx tsc --noEmit && npm run build`
Expected: no type errors; the new route compiles.

- [ ] **Step 5: Commit**

```bash
git add "dlms/app/(platform)/manufacturing/devices/new/page.tsx" dlms/components/manufacturing/NewDeviceForm.tsx "dlms/app/(platform)/manufacturing/devices/page.tsx"
git commit -m "feat(manufacturing): create-device route, form, and gated New device button"
```

---

## Task 6: Edit dialog + status-change control on the device profile

**Files:**
- Create: `components/manufacturing/DeviceEditDialog.tsx`
- Create: `components/manufacturing/StatusChangeControl.tsx`
- Modify: `app/(platform)/manufacturing/devices/[id]/page.tsx` (mount both, gated; load allowed transitions + vocab)

**Interfaces:**
- Consumes: `updateDeviceAction`, `changeDeviceStatusAction` (Task 4); `listAllowedTransitions`, `AllowedTransition` (Task 3); `listVariantOptions`, `listPhaseOptions`, `getDevice`, `DeviceDetail` (read service); `can`.
- Produces: interactive edit + status-change on the profile.

- [ ] **Step 1: Build the status-change control**

```tsx
// components/manufacturing/StatusChangeControl.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { changeDeviceStatusAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import type { AllowedTransition } from '@/modules/manufacturing/services/deviceWriteService'

type Props = {
  deviceId: string
  version: number
  currentLabel: string
  transitions: AllowedTransition[]
}

/**
 * Renders the allowed next-status moves for a device (empty for a terminal
 * status). Picking a move opens a confirm dialog; the reason field appears and
 * is required only when the chosen transition's requiresReason is set, matching
 * the server's fail-closed enforcement so the UI never offers an illegal move.
 */
export function StatusChangeControl({ deviceId, version, currentLabel, transitions }: Props) {
  const router = useRouter()
  const [target, setTarget] = useState<AllowedTransition | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (transitions.length === 0) {
    return <p className="text-sm text-muted-foreground">No further status changes from “{currentLabel}”.</p>
  }

  function choose(code: string) {
    const t = transitions.find((x) => x.toStatus === code) ?? null
    setReason('')
    setError(null)
    setTarget(t)
  }

  const reasonRequired = target?.requiresReason ?? false
  const canSubmit = !reasonRequired || reason.trim().length > 0

  async function handleConfirm() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await changeDeviceStatusAction({
        deviceId, version, toStatus: target.toStatus,
        reason: reason.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Moved to ${target.toLabel}`)
      setTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="status-move" className="text-sm text-muted-foreground">Change status</Label>
      <Select value="" onValueChange={choose}>
        <SelectTrigger id="status-move" className="w-56"><SelectValue placeholder="Move to…" /></SelectTrigger>
        <SelectContent>
          {transitions.map((t) => (
            <SelectItem key={t.toStatus} value={t.toStatus}>
              {t.toLabel}{t.isTerminal ? ' (final)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {target && (
        <Dialog open onOpenChange={(open) => { if (!open) setTarget(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Move to {target.toLabel}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {currentLabel} → {target.toLabel}
                {target.isTerminal && ' · this is a final status'}
              </p>
              <div>
                <Label htmlFor="move-reason" className="mb-1.5 block">
                  Reason {reasonRequired ? '(required)' : '(optional)'}
                </Label>
                <Textarea
                  id="move-reason" value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is the status changing?"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setTarget(null)} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleConfirm} disabled={submitting || !canSubmit}>
                  {submitting ? 'Moving…' : 'Confirm'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build the edit dialog**

```tsx
// components/manufacturing/DeviceEditDialog.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateDeviceAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import type { DeviceDetail, VocabOption } from '@/modules/manufacturing/services/deviceReadService'

type Props = { device: DeviceDetail; variantOptions: VocabOption[]; phaseOptions: VocabOption[] }

const NONE = '__none__'
function dateInput(d: Date | string | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : ''
}

/**
 * Edit a device's non-status fields (status has its own control). Sends the
 * loaded version for optimistic concurrency; a conflict surfaces the reload
 * message from the action's toMessage. Only edits fields this form exposes.
 */
export function DeviceEditDialog({ device, variantOptions, phaseOptions }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [variantCode, setVariantCode] = useState(device.variantCode)
  const [deviceSn, setDeviceSn] = useState(device.deviceSn ?? '')
  const [productName, setProductName] = useState(device.productName ?? '')
  const [modelNo, setModelNo] = useState(device.modelNo ?? '')
  const [customer, setCustomer] = useState(device.customer ?? '')
  const [destination, setDestination] = useState(device.destination ?? '')
  const [phase, setPhase] = useState(device.phase ?? NONE)
  const [buildDate, setBuildDate] = useState(dateInput(device.buildDate))
  const [shipDate, setShipDate] = useState(dateInput(device.shipDate))
  const [deliveredDate, setDeliveredDate] = useState(dateInput(device.deliveredDate))
  const [remarks, setRemarks] = useState(device.remarks ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await updateDeviceAction({
        deviceId: device.id,
        version: device.version,
        variantCode,
        deviceSn: deviceSn.trim() || null,
        productName: productName.trim() || null,
        modelNo: modelNo.trim() || null,
        customer: customer.trim() || null,
        destination: destination.trim() || null,
        phase: phase === NONE ? null : phase,
        buildDate: buildDate || null,
        shipDate: shipDate || null,
        deliveredDate: deliveredDate || null,
        remarks: remarks.trim() || null,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Device updated')
      setOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Edit device</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-variant" className="mb-1.5 block">Variant</Label>
              <Select value={variantCode} onValueChange={setVariantCode}>
                <SelectTrigger id="e-variant"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {variantOptions.map((v) => <SelectItem key={v.code} value={v.code}>{v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="e-sn" className="mb-1.5 block">Serial number</Label>
              <Input id="e-sn" value={deviceSn} onChange={(e) => setDeviceSn(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-product" className="mb-1.5 block">Product name</Label>
              <Input id="e-product" value={productName} onChange={(e) => setProductName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-model" className="mb-1.5 block">Model no.</Label>
              <Input id="e-model" value={modelNo} onChange={(e) => setModelNo(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-customer" className="mb-1.5 block">Customer</Label>
              <Input id="e-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-dest" className="mb-1.5 block">Destination</Label>
              <Input id="e-dest" value={destination} onChange={(e) => setDestination(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-phase" className="mb-1.5 block">Phase</Label>
              <Select value={phase} onValueChange={setPhase}>
                <SelectTrigger id="e-phase"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {phaseOptions.map((p) => <SelectItem key={p.code} value={p.code}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="e-build" className="mb-1.5 block">Build date</Label>
              <Input id="e-build" type="date" value={buildDate} onChange={(e) => setBuildDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-ship" className="mb-1.5 block">Ship date</Label>
              <Input id="e-ship" type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-delivered" className="mb-1.5 block">Delivered date</Label>
              <Input id="e-delivered" type="date" value={deliveredDate} onChange={(e) => setDeliveredDate(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="e-remarks" className="mb-1.5 block">Remarks</Label>
            <Textarea id="e-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Mount both controls on the profile page**

In `app/(platform)/manufacturing/devices/[id]/page.tsx`:

Add imports:

```tsx
import { listAllowedTransitions } from '@/modules/manufacturing/services/deviceWriteService'
import { listVariantOptions, listPhaseOptions } from '@/modules/manufacturing/services/deviceReadService'
import { DeviceEditDialog } from '@/components/manufacturing/DeviceEditDialog'
import { StatusChangeControl } from '@/components/manufacturing/StatusChangeControl'
```

After `const device = await getDevice(actor, params.id); if (!device) notFound()`, resolve the extra data and permission flags:

```tsx
  const canEditDevice = can(actor, 'edit_records', 'manufacturing')
  const canChangeStatus = can(actor, 'change_device_status', 'manufacturing')
  const [transitions, variantOptions, phaseOptions] = await Promise.all([
    canChangeStatus ? listAllowedTransitions(actor, device.status) : Promise.resolve([]),
    canEditDevice ? listVariantOptions(actor) : Promise.resolve([]),
    canEditDevice ? listPhaseOptions(actor) : Promise.resolve([]),
  ])
```

In the header block, add the Edit button beside the title row. Replace:

```tsx
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">
            {device.deviceSn ?? device.legacySn ?? 'No serial'}
          </h1>
          <Badge variant="outline">{device.variantName}</Badge>
          <DeviceStatusPill status={device.status} label={device.statusLabel} />
          {device.needsDataReview && <Badge variant="warning">Needs review</Badge>}
        </div>
```

with:

```tsx
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">
            {device.deviceSn ?? device.legacySn ?? 'No serial'}
          </h1>
          <Badge variant="outline">{device.variantName}</Badge>
          <DeviceStatusPill status={device.status} label={device.statusLabel} />
          {device.needsDataReview && <Badge variant="warning">Needs review</Badge>}
          {canEditDevice && (
            <div className="ml-auto">
              <DeviceEditDialog device={device} variantOptions={variantOptions} phaseOptions={phaseOptions} />
            </div>
          )}
        </div>
        {canChangeStatus && (
          <div className="mt-3">
            <StatusChangeControl
              deviceId={device.id}
              version={device.version}
              currentLabel={device.statusLabel}
              transitions={transitions}
            />
          </div>
        )}
```

- [ ] **Step 4: Verify types + build + full unit suite**

Run: `cd dlms && npx tsc --noEmit && npm test && npm run build`
Expected: type-check clean; all Jest/Vitest unit tests pass; build compiles.

- [ ] **Step 5: Commit**

```bash
git add dlms/components/manufacturing/DeviceEditDialog.tsx dlms/components/manufacturing/StatusChangeControl.tsx "dlms/app/(platform)/manufacturing/devices/[id]/page.tsx"
git commit -m "feat(manufacturing): device edit dialog and status-change control on the profile"
```

---

## Task 7: Full-suite verification + PROGRESS update

**Files:**
- Modify: `dlms/docs/superpowers/PROGRESS.md`

- [ ] **Step 1: Run the whole platform suite**

Run:
```bash
cd dlms && npx tsc --noEmit && npm test && npm run test:integration && npm run build
```
Expected: type-check clean; unit + integration green; build succeeds. Record the counts.

- [ ] **Step 2: Update PROGRESS.md**

Move the "Manufacturing write path" row from 🔄 to ✅ with a one-line note (create/edit/status-change through the fail-closed graph; N unit + M integration tests; import + soft-delete + handoff-auto-spawn explicitly deferred). Add the new deferred follow-ups (bulk import; handoff-task auto-spawn) if not already listed.

- [ ] **Step 3: Commit**

```bash
git add dlms/docs/superpowers/PROGRESS.md
git commit -m "docs: mark manufacturing write path complete"
```

---

## Self-Review

**Spec coverage (§5.2 device lifecycle):**
- Fail-closed graph via `status_transition` → Task 2 (`changeDeviceStatus`), enforced; Task 1 pure decision.
- `requires_reason` → Task 1 + Task 2 tests (quality_check→in_production rework).
- Terminal transitions need `delete_records`, no approval → Task 2 (operator blocked, manager allowed).
- Full history in `device_status_history`, device carries current status → Task 2 (history row) + Task 3 (creation row).
- Create/edit (the "full CRUD lands Week 3" promise in the migration comments) → Task 3 + UI Tasks 5–6.
- `task_template` auto-spawn, `notify_roles` → **deferred by design** (needs the outbox worker; noted in Out of scope + PROGRESS).

**Placeholder scan:** every code step contains complete, runnable code; no TBD/TODO/"add validation"/"similar to". ✔

**Type consistency:**
- `ChangeStatusInput`, `CreateDeviceInput`, `UpdateDeviceInput` are the Zod `z.input` types exported from `deviceWriteService` and consumed by the actions (Task 4) and UI — names match.
- `AllowedTransition` defined in Task 3, consumed in Task 6 `StatusChangeControl`.
- `VocabOption`, `DeviceDetail` imported from `deviceReadService` in Tasks 5–6 — both already exist there (`DeviceDetail` in the read service, `VocabOption` too).
- `evaluateStatusChange` / `InvalidStatusChangeError` / `messageForStatusChangeError` from Task 1 used consistently in Task 2 and Task 4.
- Actions return `ActionResult<T>` = `{ ok: true; data } | { ok: false; error }` — consumed by every client form via `if (!res.ok)`.

**Risk notes for the implementer:**
- The `@ts-expect-error status` test in Task 3 asserts `UpdateDeviceInput` has no `status` key; keep it out of `updateSchema`.
- `revalidatePath` is mocked in the action unit test; don't import server-only modules at top level that break the mock.
- Radix `Select` cannot hold `value=""` for a real option — the `__none__` sentinel handles "no phase". Keep the sentinel → `undefined`/`null` mapping in the forms.
