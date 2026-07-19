# RB-07: Demo data migration (Task 14)

Copies devices + their audit history from the old DLMS project into the
`qtx-ops-platform` project so the July-31 demo shows a real fleet instead of
synthetic rows. This is the **ancestor** of the week-10 rehearsed production
cutover script — not the cutover itself. Running it does not affect DLMS in
any way (see Safety below).

## Status of this runbook

Written 2026-07-20 alongside the migration code (Task 14). **The actual run
against real staging/demo data has NOT happened yet** — the platform schema
is not yet applied to any cloud project, and this environment has no real
DLMS credentials. The mapping functions and the runner/reconcile scripts are
verified by:

- 11 automated tests (`__tests__/integration/migrateDemo.test.ts`) covering
  `mapStatus` (live codes, drifted seed codes, throws on unknown) and
  `mapDeviceRow` (UUID preservation, bilingual verbatim text, variant
  derivation, ranged-serial flagging, no-serial flagging, clean-row
  non-flagging, normalized search column).
- A manual local end-to-end run against a seeded stand-in "legacy" schema in
  the same Docker Postgres container the integration suite uses (see
  "What was actually verified locally" below) — **not a run against any real
  database or real DLMS data.**

**Fill in when the real run happens** (at demo-env standup, after platform
migrations are applied to cloud):

- Device count migrated: `___`
- `needs_data_review` count: `___`
- Statuses that needed adding to `STATUS_MAP` beyond `In Stock` / `Stock` /
  `Under Repair` / `Repair` / `Shipped` / `Delivered` / `Retired` / `Lost`: `___`
- Wall-clock runtime: `___` (first real data point for the week-10 cutover
  window's time budget)
- `reconcile` exit code and any residual mismatches: `___`

## Safety

- `migrate_demo.ts` connects to `LEGACY_DATABASE_URL` **read-only** — every
  query issued against it is a `SELECT`. It never writes to the DLMS project.
- It refuses to run when `APP_ENV=production` (confirmed by manual local run,
  see below) — this is the demo script, not the rehearsed cutover.
- Writes go only to `DATABASE_URL` (the platform project).
- Re-runnable: every INSERT uses `ON CONFLICT (id) DO NOTHING`, so re-running
  after fixing a mapping failure only inserts what's still missing.

## Prerequisites (NOT done yet — blocking the real run)

1. Apply the platform migrations to the `qtx-ops-platform` cloud project
   (via Supabase MCP `apply_migration` or CLI) — committing the migration
   files does nothing by itself.
2. Obtain a **read-only** Postgres connection string to the old DLMS project
   (`bkvbqopcebfjfiemqdvk`) for `LEGACY_DATABASE_URL`. Provision a read-only
   role if one doesn't already exist — do not use an admin/owner credential
   here even though the script only issues SELECTs; defense in depth.
3. Obtain the platform staging project's `DATABASE_URL`.
4. Confirm the platform project has at least one `super_admin` `app_user` row
   — the migration attributes `created_by`/`updated_by` on migrated devices to
   the earliest such user. (`supabase/seed/platform_seed.sql` seeds one.)

## Run procedure

```bash
cd dlms
LEGACY_DATABASE_URL="postgresql://<readonly-user>@<old-project-host>:5432/postgres" \
DATABASE_URL="<platform staging DATABASE_URL>" \
APP_ENV=staging \
npm run migrate:demo
```

Read the output:
- `Devices migrated: N` — count of devices actually newly inserted this run
  (rows already present via a prior run don't recount — see "Design notes").
- `Mapping failures (N)` — legacy `status` values `mapStatus` doesn't
  recognize, each with the device id and error. **Resolve every one before
  the demo**: add the value to `STATUS_MAP` in `scripts/migrate_demo.ts` and
  re-run (safe — `ON CONFLICT DO NOTHING`). The script exits 1 whenever any
  failures remain, so CI/a script runner cannot silently treat a partial
  migration as success.
- `Audit log rows copied: N` — legacy `audit_log` rows with
  `table_name = 'device'`, copied verbatim (same id, same `occurred_at`).

Then reconcile:

```bash
LEGACY_DATABASE_URL="..." DATABASE_URL="..." npm run reconcile
```

Expected: exits 0 with every line marked `OK`. Any `MISMATCH` line means
something needs attention before the demo — most commonly outstanding
mapping failures (fix `STATUS_MAP`, re-run `migrate:demo`, re-run
`reconcile` until clean).

## What `reconcile` checks

| Check | Compared how |
|---|---|
| `device` row count | Exact match expected once all mapping failures are resolved |
| Device count by mapped status | Legacy rows grouped by `mapStatus(status)` vs platform rows grouped by `status` |
| `sha256(device_sn \|\| pcba_a_sn)`, sorted | Catches silent corruption/truncation even when counts match |
| `needs_data_review` count | Informational only — no legacy-side equivalent to compare against |
| `audit_log` row count + `max(occurred_at)`, scoped to `table_name = 'device'` | Scoped deliberately — legacy `audit_log` also covers tables this task never migrates, and the platform `audit_log` already carries its own seed-time entries for role/permission/app_user rows; an unscoped comparison would never match for reasons unrelated to this migration |

## Design notes (why the code does what it does)

- **`mapStatus` throws on unknown, never guesses** (spec §15) — the runner
  collects these as failures rather than aborting the whole batch, so one bad
  legacy status doesn't block every other device in that batch.
- **Device UUIDs are preserved verbatim** (spec D21) — `audit_log.row_id`
  references `device.id`, and the trail must read continuously across the
  cutover.
- **Ranged/listed legacy serials are never split.** A value like
  `"EE-02A-2603-0001 to 0015"` becomes one device row, carried verbatim into
  `pcba_a_sn_legacy`, flagged `needs_data_review = true`. Splitting would
  invent device identities the business never assigned; the cutover must not
  block on data cleansing.
- **`trg_audit_device` is disabled for the duration of the device-migration
  batch loop, then re-enabled.** Without this, every migrated INSERT would
  also fire the platform's own `fn_audit` trigger and manufacture a brand-new
  "insert" audit_log row (dated at migration time, not the device's real
  history) *alongside* the real history `migrateAuditLog` copies verbatim —
  double-counting every device's trail and permanently breaking reconcile's
  audit_log count check. This was caught by the local end-to-end run, not by
  a written test (see below).
- **Legacy `phase` values are proper-case English** (`Production`,
  `Validation`, `Rework`, `Pilot`, `EOL` — `dlms/supabase/seed.sql`); **the
  platform's ported vocabulary is snake_case** (`production`, ...,
  `end_of_life` — `20260719000001_platform_devices.sql`). `mapDeviceRow`
  applies an internal `mapPhase` alongside `mapStatus`. Legacy `device.phase`
  is `NOT NULL`, so without this fix every device insert failed its
  `device_phase_fkey` — also caught only by the local end-to-end run, since
  the brief's provided test cases don't assert on `phase`. Unlike
  `mapStatus`, `mapPhase` never throws: phase is ported for legacy fidelity
  only and has no UI consumer until week 3 (CLAUDE.md), so an unrecognized
  value degrades to `NULL` rather than blocking migration of the row's
  serial/status/audit history over non-load-bearing metadata.
- **`migrateAuditLog` copies only `table_name = 'device'` rows.** Legacy
  `audit_log` also covers tables Task 14 never migrates (`warranty`,
  `extracted_device_draft`, `filter_presets`, ...); their `row_id` values
  reference legacy rows with no platform counterpart, so copying them would
  be noise at best.
- **`actor_id` is remapped by email, left `NULL` when no match.** Legacy and
  platform `app_user` rows have different ids (different projects); email is
  the only stable join key. An actor with no platform counterpart (including
  the historical `device-api` system actor
  `11111111-1111-1111-1111-111111111111`, retired 2026-07-13, whose email
  likely doesn't match any real platform user) is left `NULL` rather than
  guessed — same philosophy as `mapStatus`.
- **Keyset pagination on `(created_at, id)` / `(occurred_at, id)`**, not the
  timestamp alone — several legacy rows can share a timestamp, and a plain
  `> cursor` comparison on the timestamp alone would risk skipping or
  repeating rows across a batch boundary (same idiom as
  `modules/manufacturing/services/deviceReadService.ts`'s existing keyset
  cursor).

## What was actually verified locally (2026-07-20)

No real database was touched — there is no real `LEGACY_DATABASE_URL` and no
platform cloud project in this environment. What follows is a local proof
that the runner and reconcile scripts work end-to-end against real Postgres,
not just that the pure functions pass unit tests:

1. Started the same `docker-compose.test.yml` Postgres the integration suite
   uses (`localhost:55432`), applied the platform migrations + seed to it
   (identical to `__tests__/integration/setup.ts`).
2. Created a throwaway `legacy_source` schema in the **same** container,
   with `device`/`app_user`/`audit_log` tables shaped like the real legacy
   DLMS schema, and seeded 5 devices (one clean single-serial Pro device with
   bilingual multiline remarks, one ranged-serial device, one no-serial
   device, one using the drifted `"Stock"` seed code, one with an unknown
   `"Teleported"` status) plus 6 `audit_log` rows (5 for `table_name='device'`
   matching each device, 1 for `table_name='warranty'` to prove the scope
   filter excludes it).
3. Pointed `LEGACY_DATABASE_URL` at that same container with
   `?options=-c search_path=legacy_source` (so unqualified `device`/
   `audit_log`/`app_user` in the runner's queries resolve to the legacy-shaped
   tables) and `DATABASE_URL` at the same container's `public` schema (the
   already-migrated platform schema) — the two connection strings stand in
   for "two different projects" the way `search_path` scoping does within one
   physical Postgres instance. `APP_ENV=development` (the harness's actual
   nature — an untrusted-TLS local container, same reasoning
   `vitest.integration.config.ts` already documents) so `getPool()`'s SSL
   branch doesn't reject the connection.
4. Ran `npx tsx scripts/migrate_demo.ts` directly (not the npm script wrapper,
   same command). Result: `Devices migrated: 4`, one mapping failure reported
   by name and id for the unknown status (never aborted the batch),
   `Audit log rows copied: 5`.
5. Queried the platform tables directly and confirmed: the migrated device's
   `id` equals the legacy id verbatim; bilingual `customer`/multiline
   `remarks` round-tripped byte-for-byte; the ranged serial landed in
   `pcba_a_sn_legacy` verbatim with `device_sn` NULL and
   `needs_data_review = true`; the no-serial device was flagged; the clean
   device was not flagged; `device_sn_normalized` was computed correctly; the
   drifted `"Stock"` code mapped to `in_stock`; the unknown-status device was
   correctly absent from the platform `device` table;
   `audit_log` had **exactly** 5 `table_name='device'` rows (proving
   `trg_audit_device` was actually suppressed — no synthetic extra "insert"
   rows from the migration's own INSERTs); the `warranty` audit row was
   correctly excluded; every copied row's `id`/`row_id`/`occurred_at` matched
   the legacy source verbatim; `actor_id` was remapped to the platform
   `super_admin` by email match.
6. Re-ran the exact same command: `Devices migrated: 0`, `Audit log rows
   copied: 0`, confirmed via direct query that row counts were unchanged —
   proving `ON CONFLICT (id) DO NOTHING` re-runnability.
7. Ran `npx tsx scripts/reconcile.ts` against that state (one device still
   unmigrated): it correctly reported `MISMATCH` on the device row count and
   the serial sha256, listed the unmapped status, and **exited 1**.
8. Updated the one remaining legacy row's status to a value already in
   `STATUS_MAP` (simulating the operator's fix), re-ran `migrate:demo`
   (`Devices migrated: 1`), then re-ran `reconcile`: every line reported
   `OK` and it **exited 0** — proving the fix → re-run → reconcile loop this
   runbook describes actually works end-to-end.
9. Confirmed the production guard: running with `APP_ENV=production` throws
   immediately (`migrate_demo.ts refuses to run with APP_ENV=production...`)
   before opening any connection, exit code 1.
10. Confirmed `legacyPool` (the `LEGACY_DATABASE_URL` connection) issues only
    `SELECT` statements — grepped every call site in both scripts.
11. Deleted the throwaway seeding script and schema; nothing from this local
    proof is part of the committed deliverable.

This local run is what caught two real bugs before they could reach a real
migration: the `trg_audit_device` double-counting issue and the legacy
`phase` vocabulary drift (§ Design notes above) — neither is exercised by the
brief's 11 provided test cases, which only cover `mapStatus`/`mapDeviceRow`
in isolation from the schema's triggers and constraints.

## Rollback

Nothing to roll back on the DLMS side (read-only). On the platform side, the
migration only inserts (`ON CONFLICT DO NOTHING`) — to undo a demo migration
run against staging:

```sql
DELETE FROM audit_log WHERE table_name = 'device' AND row_id IN (
  SELECT id FROM device WHERE created_by = '<the actorId the run used>'
);
DELETE FROM device WHERE created_by = '<the actorId the run used>';
```

(Scope any DELETE narrowly — `created_by` is not unique to this migration if
the platform project has other real activity by the same super_admin.)
