# RB-08: Legacy component-data migration

Back-fills the normalized component model — `component_unit` + `component_installation`
— from the legacy DLMS `device` table's ten flattened PCBA-A/PCBA-B/screen columns
onto the platform devices `scripts/migrate_demo.ts` already created. This is the
**second half** of the demo migration (RB-07 is the first) and its sibling, not a
replacement for it: `migrate_demo.ts` decides device identity, this script only hangs
component parts off rows that already exist. Running it does not affect DLMS in any
way (see Safety below).

**Take a full snapshot/backup of the platform database before running this.** There
is no in-app undo for what this script writes — see Rollback near the end of this
document. Take the snapshot before the run, not after something looks wrong.

## Status of this runbook

Written 2026-07-30 alongside the migration code (the mapper, the runner, and the
reconcile additions) — the same day a review/fix pass on the runner found and fixed
two data-integrity defects before commit (commit `32fd36f`):

1. **A re-run could resurrect a removed-and-not-replaced installation.** The
   installation `INSERT` was guarded only by `ON CONFLICT ... WHERE removed_at IS NULL`,
   which sees nothing when a component was removed through the UI and never replaced —
   so a re-run inserted a second installation back-dated to before the removal, and the
   registry then asserted a component was installed that had physically been pulled
   out. Fixed by making the `INSERT` conditional on the slot having **no installation
   history at all** (`NOT EXISTS`), with `ON CONFLICT` kept only as a race backstop.
2. **A shared-serial revision conflict was silently discarded.** When two legacy
   devices carried the same serial with different `hw_rev`/`bom_rev`/`fw_ver`, the
   existing unit was correctly reused but the second device's revisions were written
   nowhere and reported nowhere — a silent drop the Global Constraint forbids. Fixed by
   returning the conflict from `upsertUnit` and printing both sides in the summary
   (`Shared serials with divergent revisions`).

A pre-merge review pass then found a third (commit under review here): the unit
`INSERT`'s `ON CONFLICT (component_type_id, serial_no) WHERE deleted_at IS NULL` did
not cover a **soft-deleted** unit, so a re-run inserted a second live unit while the
installation guard correctly suppressed the installation — leaving a live
`component_unit` with `disposition = 'installed'` and zero installations pointing at
it. Fixed by deciding the whole component group once, before either write (see "Design
notes").

**The actual run against real legacy data has NOT happened yet** — there is no
`LEGACY_DATABASE_URL` in this environment, the same blocker RB-07 records. The mapper,
runner, and reconciliation are verified by:

- **60 automated tests** across three files: 28 in
  `__tests__/platform/manufacturing/legacyComponents.test.ts` (the pure mapper —
  clean-serial vs ranged/listed/prose-serial flagging via the allowlist in
  `needsSplitSerial`, the screen's batch-vs-unit branch, a legacy row with nothing
  populated producing no drafts at all); 21 in
  `__tests__/integration/migrateComponents.test.ts` (the runner end to end against a
  dockerized-Postgres legacy stand-in — including a fault-injected mid-run failure
  that proves the partial-result summary and progress marker, keyset pagination across
  multiple pages with rows sharing a `created_at`, a re-run that does *not* resurrect
  a removed-and-not-replaced installation, a re-run over a **soft-deleted** unit that
  does not insert a second live one, and the shared-serial divergent-revision case);
  11 in `__tests__/integration/reconcileComponents.test.ts` (the reconcile
  additions, run against their own private throwaway database —
  `qtx_test_reconcile` — specifically because the platform-side component counts
  reconcile compares are global totals, not scoped to one test's rows, so isolation
  from the rest of the suite has to be a real separate database, not a row filter;
  two of the eleven pin the legacy-side trim to `String.prototype.trim()` using a
  tab-only column, a U+3000-only column, and a serial that differs from another only
  by a leading U+3000).
- Mutation-testing on the reconcile additions, committed as
  `__tests__/integration/reconcileComponents.test.ts` in commit `58addb2`. Four
  mutations were each applied to `scripts/reconcile.ts`, the suite run, and the
  mutation reverted; every one was caught by a failing assertion, which is what makes
  the transcription meaningful rather than decorative:
  - replacing the three-filter installation total with the `count(*) * 3` shortcut
    (caught: the fixture's 6 devices produce 9 installations, not 18);
  - dropping the `DISTINCT` from the unit count (caught: two devices share one serial,
    so the count became 7 against 6 real units);
  - removing the revision null-collapse `btrim(coalesce(x,''))` (caught: the NULL/blank
    pair started reporting as a divergence invented out of empty strings);
  - replacing the orphan query with a constant `0` (caught: the re-pointed installation
    no longer failed reconcile).

  The pre-merge pass added a fifth, which the original four had not covered and which
  the code was **failing**: restoring the one-argument `btrim(x)` on the legacy side.
  Caught, now that the fixture contains non-ASCII whitespace — `source=14 target=11`
  on the installation line and `source=9 target=7` on the unit line. Two further
  mutations pin the runner: removing the hoisted group check strands a second live
  unit (`unitsCreated` 1 instead of 0), and removing `getPool().end()` from
  `migrate_demo.ts` leaves the write pool open.
- No real database has been touched by any of this — there is no
  `LEGACY_DATABASE_URL` and no cloud-reachable legacy project in this environment.
  Unlike RB-07, there was no separate manual local end-to-end walkthrough on top of
  the committed suite: the fault-injection, keyset-continuation, and
  divergent-revision proofs above are the committed tests themselves, run against the
  same dockerized Postgres `npm run test:integration` uses.

**Fill in when the real run happens** (at demo-env standup, after RB-07's run and
reconcile are both clean):

- Legacy devices seen: `___`
- Component units created: `___`
- Installations created: `___`
- Serials flagged for review (`needs_split`): `___`
- Shared serials with divergent revisions: `___`
- Wall-clock runtime: `___`
- `reconcile` exit code and any residual mismatches (component lines): `___`
- Did the run complete in one attempt? `yes / no` — if **no**, one line per attempt:
  - Attempt `___`: failed during batch `___`, on device `___`, error `___`
  - Progress reached (last committed legacy row): `created_at=___ id=___`
  - Cause found and fixed: `___`
  - Final attempt that completed: `___` (counts above are from this attempt)

## Safety

- `migrate_components.ts` connects to `LEGACY_DATABASE_URL` **read-only** — the only
  two queries it issues against that pool are the paginated `SELECT`s of the ten
  component columns. It never writes to the DLMS project.
- It refuses to run when `APP_ENV=production` — the same guard `migrate_demo.ts`
  uses, for the same reason: this is the demo/rehearsal script, not the cutover
  itself. The two scripts are a mandatory-ordered pair in one runbook, and there is
  no world in which the second half should run against production while the first
  half refuses.
- Writes go only to `DATABASE_URL` (the platform project), and only `INSERT` — never
  `UPDATE`, never `DELETE`. `component_installation` is guarded by
  `fn_component_installation_guard`, which would reject an `UPDATE`/`DELETE` anyway
  (see Rollback).
- **Unlike `migrate_demo.ts`, this script does NOT suppress the platform's audit
  triggers.** `migrate_demo.ts` runs each batch under
  `SET LOCAL session_replication_role = 'replica'` because it copies the legacy
  `audit_log` verbatim and must not double-write. Components never existed as rows in
  DLMS — they were columns — so there is no legacy component audit trail to copy, and
  letting `trg_audit_component_unit` / `trg_audit_component_installation` fire is the
  *only* record of where these rows came from. Do not "fix" this into symmetry with
  the sibling script.
- Re-runnable, **unconditionally** — stronger than RB-07's "safe because
  `ON CONFLICT (id) DO NOTHING`" claim. See "Re-running is safe" below.

## Prerequisites

1. **`scripts/migrate_demo.ts` must already have been run against this exact legacy
   data, and reconciled clean (RB-07).** This script only back-fills components onto
   devices `migrate_demo.ts` created; it never creates a device itself. If a legacy
   device has no platform counterpart, `migrate_components.ts` collects its id into
   `missingDevices`, prints every one on stderr, and `main()` exits 1 — **that exit
   code is the signal** that `migrate_demo.ts` was not run against this data (or was
   run against different data), not a defect in this script.
2. The platform's component catalogue must be seeded: `component_type` needs exactly
   the three rows `pcba_a`, `pcba_b`, `hmi_screen`
   (`20260720000001_platform_components.sql`). A missing code throws before any
   legacy row is processed, naming the migration to apply — the alternative
   (silently migrating two of the three families) would look like a successful run.
3. At least one `super_admin` `app_user` row on the platform project — the migration
   attributes `created_by`/`updated_by` on every unit and installation to the
   earliest such user, the same convention `migrate_demo.ts` uses for devices.
4. A read-only Postgres connection string for `LEGACY_DATABASE_URL` (the old DLMS
   project) and the platform's `DATABASE_URL` — same two variables, same values, as
   RB-07. Unlike `migrate_demo.ts`, this script needs **no elevated GUC permission**
   (no `SET session_replication_role`): plain `INSERT`/`SELECT` privilege on the
   platform connection is enough.
5. A pre-migration snapshot of the platform database, taken now, before the run —
   see Rollback.

## Run procedure

```bash
cd dlms
LEGACY_DATABASE_URL="postgresql://<readonly-user>@<old-project-host>:5432/postgres" \
DATABASE_URL="<platform staging DATABASE_URL>" \
APP_ENV=staging \
npm run migrate:components
```

Read the output:
- `Legacy devices seen: N` — legacy rows *read* this run, including ones that write
  nothing (a re-run recounts every row it reads, even fully-covered ones).
- `Component units: N` — new `component_unit` rows actually inserted (sums
  `rowCount`, never rows attempted — a re-run over the same data reports `0` here
  even though it reads the same N devices).
- `Installations: N` — new `component_installation` rows actually inserted, same
  convention.
- `Serials flagged for review (N) — needs_split is set on each:` (stderr) — printed
  on **every** run, not only the run that created the unit; this list *is* the admin
  cleanup queue (see below), and a re-run must still show what nobody has cleaned up
  yet.
- `Shared serials with divergent revisions (N)` (stderr) — see "Divergent revisions"
  below. Never fails the run. Unlike the `needs_split` list, this one appears only on
  the run that actually migrates a group; a pure re-run prints nothing here, and
  `reconcile`'s `INFO ... DIVERGENT revisions` count is the surface that persists.
- `Legacy devices with no platform counterpart (N)` (stderr, `console.error`) — this
  is what makes `main()` exit 1. Run `migrate_demo.ts` (and its own reconcile)
  against this same data first, then re-run this script — safe.

And, **only if the run died part-way**, five more lines printed *before* the counts —
see "If the run fails partway" below for what to do about them:
- `=== PARTIAL RESULT — RUN FAILED during batch N ===` — the banner. Its presence is
  the signal that every number underneath it is partial. It is on stdout, deliberately,
  so it sits with the counts it qualifies.
- `Batch N rolled back entirely; batches 1-(N-1) committed; any later batch never ran.`
  — the transaction boundary, stated for this specific run.
- `Failed while processing device: <uuid>` — the legacy device id being processed when
  it died. This is the one to look at first.
- `Progress reached: last legacy row COMMITTED was created_at=... id=...` — **a
  diagnostic, not an instruction.** There is no `--after` flag; the script parses no
  arguments. It tells you how far the run got, nothing more.
- `TO RECOVER: fix the cause, then re-run this script from the start. ...` — the actual
  instruction, and the only supported recovery.

Then reconcile:

```bash
LEGACY_DATABASE_URL="..." DATABASE_URL="..." npm run reconcile
```

`reconcile.ts` checks both halves of the migration in one run — `migrate_demo.ts`'s
device/status/serial/audit-log lines first, this script's five component lines last
(see "What reconcile checks about components" below), then one verdict line.
Expected: every line `OK`, exit 0.

## What it writes

Per populated legacy component group, per device:

- **PCBA-A / PCBA-B**: one `component_unit` row (keyed by
  `(component_type_id, serial_no)`, live rows only — reused across every device that
  carries the same serial for that type) if one doesn't already exist, plus one open
  `component_installation` in slot 1. `installed_at` is always the device's legacy
  `created_at`, never `now()` — these parts went in when the device was built.
  Revisions (`hw_rev`, `bom_rev`, `fw_ver`) are carried verbatim, only surrounding
  whitespace trimmed.
- **HMI screen**: one open `component_installation` in slot 1 with
  `component_unit_id = NULL` and `batch_no` set — no unit row at all. See "The screen
  is batch-tracked" below.
- A legacy group with nothing populated (blank or whitespace-only) produces
  **nothing** — a device genuinely without an accessory board does not gain an empty
  one.

Nothing else. It never writes to legacy, and it never creates a `device` row — a
legacy device missing on the platform is reported, never invented.

## Re-running is safe — unconditionally

The installation `INSERT` is conditional on the slot having **no installation
history at all**, not merely no *open* installation:

```sql
INSERT INTO component_installation (...)
SELECT ...
 WHERE NOT EXISTS (
   SELECT 1 FROM component_installation
    WHERE device_id = $1 AND component_type_id = $2 AND slot_no = 1)
ON CONFLICT (device_id, component_type_id, slot_no)
  WHERE removed_at IS NULL DO NOTHING
```

A slot the platform has since taken over is left alone entirely — **including a
component that was removed through the UI and never replaced**, which leaves no
*open* row for the usual `ON CONFLICT` to catch. Without the `NOT EXISTS` guard, a
re-run would insert a second installation back-dated to before the removal, and the
registry would assert a component is currently installed that was physically pulled
out. `fn_component_installation_guard` cannot help here — it blocks `UPDATE` and
`DELETE`, and this is an `INSERT`. The `ON CONFLICT` clause remains only as a race
backstop, since the `NOT EXISTS` check and the `INSERT` are not atomic against a
concurrent writer.

This means the run/re-run window has **no** limitation worth documenting: re-run at
any point in the migrated fleet's life, including after it is in service, and the
script will never resurrect or duplicate anything — it only ever fills a gap.

The unit `INSERT` is guarded by the *same* decision, not by a second independent one.
Before either write, the runner asks whether this `(device_id, component_type_id,
slot_no)` already has installation history, and skips the **whole component group** —
unit and installation both — when it does. That matters because the unit's own
`ON CONFLICT (component_type_id, serial_no) WHERE deleted_at IS NULL` cannot see a
**soft-deleted** unit (the index is partial), so on its own it would insert a second
live unit while the installation guard correctly suppressed the installation — leaving
a live `component_unit` with `disposition = 'installed'` and no installation pointing
at it, and reporting a non-zero `Component units:` on a re-run this runbook promises
will report `0`. Both `ON CONFLICT` clauses remain, as race backstops only.

One consequence worth knowing: because an already-migrated group is skipped before the
stored unit is read, the runner's `Shared serials with divergent revisions` list is
produced only on the run that actually migrates a group — a pure re-run prints nothing
there. That queue is not lost; `reconcile.ts` derives the same population from the
legacy side alone and prints its count on **every** run. The `needs_split` cleanup
queue is unaffected and still prints on every run, because it is derived from the
legacy row with no database read at all.

## If the run fails partway

The script dies on the first error it cannot handle (a constraint violation, a dropped
connection, a killed session). It is designed to be legible when that happens, and the
recovery is always the same: **re-run it from the start.**

**What committed and what did not.** Work is committed one batch at a time — 500 legacy
devices per `withTransaction`. So on a failure during batch `N`:

- batches `1 … N-1` are **committed** and durable;
- batch `N` is **rolled back in its entirety** — every unit and installation it wrote
  is gone, including the rows it had already written before the failing one;
- batch `N+1` and later **never ran**.

Nothing is left half-written inside a batch, and nothing needs unwinding by hand.

**How to read the output.** The four partial-failure lines are listed under "Read the
output" above. In short: the `=== PARTIAL RESULT — RUN FAILED during batch N ===`
banner means every count below it is partial; `Batch N rolled back entirely; ...` spells
out the boundary for that specific run; `Failed while processing device: <uuid>` names
the legacy device to investigate; and `Progress reached: last legacy row COMMITTED was
created_at=... id=...` says how far it got. The counts underneath follow a deliberate
split, restated in the output itself: **`Legacy devices seen` is rows READ** (it
includes the rolled-back batch), while **`Component units` and `Installations` are rows
COMMITTED** (per-batch counters are folded in only after that batch commits, so a
rolled-back batch never contributes).

**There is no resume flag.** `Progress reached: ...` is a progress marker, not an
instruction — the script parses no arguments and reads no cursor environment variable,
so there is nothing to feed it to. Do not go looking for `--after`.

**The recovery.**

1. Read `Failed while processing device: <uuid>` and the error itself (stderr) and fix
   the cause. Common ones: a legacy device with no platform counterpart (run RB-07
   first), a missing `component_type` row (apply
   `20260720000001_platform_components.sql`), or a platform-side constraint the legacy
   data violates.
2. Re-run the exact same command from the start. This is safe and is the *only*
   supported recovery — see "Re-running is safe — unconditionally". Committed batches
   are skipped group by group, so the re-run picks up where the last one stopped
   without depending on any cursor.
3. Confirm: the second run's `Component units` / `Installations` counts should cover
   only the devices the failed run never reached. Then run `reconcile` — a clean
   reconcile, not a clean exit code from the runner, is what says the back-fill landed.

**What to record** in "Fill in when the real run happens" above: the batch number it
died on, the device id, the error, the `Progress reached` line, what you changed, and
which attempt finally completed. The final attempt's counts are the ones that belong in
the count fields — an earlier attempt's partial numbers are not a smaller version of the
same thing.

**If it keeps failing on the same device**, stop re-running and look at that legacy row.
`component_installation` is append-only and there is no in-app undo (see Rollback), so a
loop of failed attempts is cheap only as long as it stays a loop of *rolled-back*
batches.

## The screen is batch-tracked — this is intentional

If you query `component_installation` and find an `hmi_screen` row with
`component_unit_id IS NULL` and `batch_no` set, that is not a bug or an incomplete
migration. It is the correct, complete representation of what legacy data actually
knows.

Legacy identifies a screen only by `screen_model` and `hmi_ver` — neither identifies
an *individual* screen, and there is no screen serial column in the legacy schema at
all. `component_unit.serial_no` is `NOT NULL`, so giving the screen a unit would mean
inventing a serial the business never assigned; using the model as a stand-in serial
would collide across every device sharing that model. So the screen migrates as what
it actually is — a batch part, which `component_installation` already supports
(`component_unit_id` NULL with `batch_no` set, permitted by the `unit_or_batch` CHECK
constraint). `notes` carries both `screen_model` and `hmi_ver` verbatim so nothing
the legacy row said is lost to the choice.

`component_type.tracking_mode` stays `'serialized'` for `hmi_screen` deliberately —
it is not a leftover to clean up. It describes what a screen *should* be once screens
carry real serials, and it keeps `assertReplacementShape` demanding a real serialized
unit for any future swap. The batch-form installation this script writes describes
what the legacy data actually knew at migration time; the seeded `tracking_mode`
describes the target state. The replacement path is ready — the data is not.

## The cleanup queue (`component_unit.needs_split = true`)

`needs_split` is decided by an **allowlist**, not a denylist: a serial is trusted
clean only if it is ASCII letters/digits plus `.` `_` `-` `/`, starting with a letter
or digit, with no doubled hyphen (`--`, which in this fleet's data is range notation,
not punctuation — e.g. `"EE-0001--0015"`). Everything else is flagged: a ranged
serial (`"EE-02A-2603-0001 to 0015"`), a comma-separated list, prose
(`"No wifi version"`), a space, CJK text, full-width or ideographic punctuation, or
any other character outside the allowed set.

All of it — ranges, lists, prose, anything not matching a clean part-number shape —
is carried **verbatim** into `component_unit.serial_no` and flagged, never split and
never dropped. Splitting would invent component identities the business never
assigned; dropping would silently lose a value spec §15 requires to survive. Working
this queue — an admin screen that lets someone split a ranged unit into N units and
reassign installations — is a **separate manual task the migration deliberately does
not block on**. `reconcile.ts` prints the queue in full (`ACTION component_unit
needs_split queue: N`, on stderr) every time it runs, and it never fails the run.

**A prose firmware value is carried with no flag, and the queue should eyeball it
too.** The legacy schema comment on `pcba_b_fw_ver` warns it "may contain notes e.g.
`'No wifi version'`" — that column, not the serial. A value like that lands verbatim
in `component_unit.fw_ver`, but `needs_split` is computed **only** from the serial
(`needsSplitSerial(serialNo)`), never from `hw_rev`/`bom_rev`/`fw_ver`. So a unit with
a perfectly clean serial can still carry a prose firmware string that the
`needs_split` queue will never surface on its own — an operator working the queue
needs to also scan `fw_ver` values directly, not rely on `needs_split = true` to find
every piece of prose the migration carried through.

## Divergent revisions

When two legacy devices carry the same serial for the same component type, exactly
**one** `component_unit` row is created (or reused, on a re-run), and both devices'
installations point at it — spec §15 forbids inventing a second identity for one
physical part. If the second device's row disagrees with the first on `hw_rev`,
`bom_rev`, or `fw_ver`, **the second device's values are not written anywhere.**
That is not a silent drop: it is reported in the runner's own summary (`Shared
serials with divergent revisions (N)` — stderr, with both sides' values and the
device ids) and, independently, by `reconcile.ts` (`INFO ... DIVERGENT revisions: N`
— a count only; read the runner's own output for the actual values). Neither report
ever fails the run — like the cleanup queue, this is a human's judgement call about
which revision is real, not a migration defect.

The runner's list is produced **on the run that migrates the group**, not on every run:
an already-migrated slot is skipped before its stored unit is read (see "Re-running is
safe"), so a pure re-run prints nothing there. `reconcile.ts`'s count is the one that
keeps appearing — it is derived from the legacy side alone — so capture the runner's
output from the migrating run, and use `reconcile` afterwards to confirm the population
has not changed.

Worth knowing: such a serial is also left **open-installed in two devices at once**,
which is physically impossible. `one_open_install` cannot catch this because it is
scoped per-device, not per-unit — resolving that is part of the same human review.

## Reconciliation is a cutover-time check

`reconcile.ts`'s two component assertion lines
(`open component_installation rows vs populated legacy groups` and
`component_unit rows (pcba_a+pcba_b) vs distinct legacy serials`) compare the legacy
side (scoped to the platform's device ids) against the platform side counted
**globally** — not scoped to those devices. `component_unit` has no device column at
all, so it cannot be scoped; the installation count is left global for symmetry with
it.

That comparison is correct and meaningful **the first time you run it**, right after
`migrate_demo.ts` + `migrate_components.ts`, on a platform that starts with no
devices and no components of its own. It stops being meaningful the moment the
platform goes into service: any component fitted through the UI after go-live —
or any component removed and not yet replaced — changes the global platform total
without changing what the legacy data can explain, and reads as a mismatch that has
nothing to do with the migration. **Run `reconcile` at cutover, before the platform
takes real traffic**, and treat a component-line mismatch found afterward as expected
drift rather than a migration failure — unless you are specifically trying to
confirm the back-fill itself landed completely, in which case scope your own ad hoc
query to the migrated device ids the same way the legacy side already is.

## What reconcile checks about components

| Check | Compared how |
|---|---|
| Open `component_installation` rows vs populated legacy groups | Legacy: sum of three `count(*) FILTER (...)` over `device` (pcba_a serial present, pcba_b serial present, screen_model OR hmi_ver present), scoped to the platform's device ids. Platform: `count(*) WHERE removed_at IS NULL`, global (see "cutover-time check" above) |
| `component_unit` rows (pcba_a+pcba_b) vs distinct legacy serials | Legacy: `count(DISTINCT (type_code, trimmed serial))` across the two serialized groups, scoped to platform device ids. Platform: `count(*)` joined to `component_type` on `code IN ('pcba_a','pcba_b')`, `deleted_at IS NULL`, global |
| `component_installation` rows whose `device_id` has no `device` | Literal `0` vs `count(*) WHERE NOT EXISTS (...)` — defense in depth; the `NOT NULL REFERENCES device(id)` FK makes an orphan structurally impossible while intact, which is exactly why this one query is worth it |
| `component_unit` needs_split queue (informational — never fails) | Every live row with `needs_split = true`, listed in full (`code: "serial"`), not just counted — this listing is the queue's only surface today |
| Serials shared by devices with divergent revisions (informational — never fails) | Legacy count of `(type_code, serial_no)` shared by ≥2 devices with more than one distinct `(hw_rev, bom_rev, fw_ver)` tuple among them |

A shortfall on either assertion line (`target < source`) most often means the
back-fill did not fully land — re-running `migrate_components.ts` is safe and the
first thing to try, with one exception: a slot the runner deliberately left alone
(see "Re-running is safe") stays a shortfall until a human resolves it, not until a
re-run does.

## Design notes (why the code does what it does)

- **Keyset pagination on `(created_at, id)`**, not `created_at` alone — the same
  idiom `migrate_demo.ts` and `deviceReadService.ts` use, because several legacy rows
  can share a timestamp and a plain `> cursor` comparison risks skipping or repeating
  rows across a batch boundary. Verified by a dedicated test with a page size smaller
  than the fixture and rows deliberately sharing timestamps.
- **One group check decides both writes.** The "does this slot already have
  installation history" question is asked once, per `(device_id, component_type_id,
  slot_no)`, before the unit is touched — not once for the unit (`ON CONFLICT`) and
  again for the installation (`NOT EXISTS`). Two independent guards could disagree, and
  on a soft-deleted unit they did: see "Re-running is safe — unconditionally" for the
  orphan-live-unit case this removes.
- **Both `ON CONFLICT` clauses restate their partial index predicate**
  (`WHERE deleted_at IS NULL` / `WHERE removed_at IS NULL`) because
  `component_unit_sn` and `one_open_install` are both partial unique indexes —
  without the predicate, Postgres cannot infer which index the clause means and
  rejects the statement outright.
- **Counts sum `rowCount`, never rows attempted**, at both the unit and installation
  level and at the batch level (per-batch counters are only folded into the running
  total *after* that batch's transaction commits). A re-run's `0` is the operator's
  evidence the back-fill is already complete for that data; overstating it would hide
  a real gap. This also means a batch that rolls back never leaves its counts in a
  summary the operator reads as committed — see the fault-injection test and the
  `PARTIAL RESULT` banner it produces.
- **`reconcile.ts`'s legacy-side `btrim()` takes an explicit character set**
  (`TRIM_CHARS`) that matches `String.prototype.trim()` exactly. It has to: the other
  half of every component comparison is the mapper's `text()` helper, which *is*
  `.trim()`. One-argument `btrim(x)` strips the ASCII space and nothing else, so a
  column holding only a tab or a U+3000 IDEOGRAPHIC SPACE would be "no component" to
  the mapper and "a populated group" to reconcile — a mismatch no re-run could ever
  clear, in a fleet whose data already contains 至, U+FF0C, U+3001 and U+FF5E. Do not
  simplify it back to the one-argument form.
- **`existingDeviceIds` is not filtered by `deleted_at`.** `migrate_demo.ts` carries a
  legacy row's soft-delete state verbatim, and a soft-deleted device still has the
  components it was built with. Filtering here would report a correctly-migrated
  device as `missing` and fail the run on data that is actually correct.
- **`component_type` ids are resolved once, before the row loop**, not per device —
  the catalogue is a fixed, admin-managed set of three rows that cannot change
  mid-run, so re-resolving per row would turn one query into one-per-device for no
  benefit.

## Rollback

`component_installation` is append-only. `trg_component_installation_guard`
(`BEFORE UPDATE OR DELETE`) rejects every `DELETE` outright, and rejects every
`UPDATE` other than the one-time removal stamp (`removed_at`/`removed_by`/
`removal_reason`/`repair_id`/`modification_id`, set once on a still-open row) —
device, type, unit, `batch_no`, slot, and every install fact are frozen from the
moment of `INSERT`, and an already-removed row is frozen too. **There is no SQL
statement, and no in-app control, that undoes what this script wrote** — unlike
RB-07's demo migration, which can be reversed with targeted `DELETE`s because
`device` and `audit_log` support real deletes.

**The only rollback path is restoring the platform database from the pre-migration
snapshot** taken under Prerequisites, above — which is why that snapshot has to exist
*before* the run, not be improvised after something looks wrong. If the snapshot was
skipped, there is nothing this runbook or the schema can do to undo a run.

(`component_unit` rows are ordinary soft-deletable rows and could in principle be
deleted or soft-deleted directly, but doing so would not undo the append-only
installation history that still points at them, and would leave a dangling reference
the schema does not otherwise produce. Do not attempt a partial manual rollback by
touching `component_unit` alone.)
