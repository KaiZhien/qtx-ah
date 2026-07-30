# QTX Operations Platform — Progress Checklist

**Living status board.** Last updated: 2026-07-30.
Spec: [2026-07-17-ops-platform-design.md](specs/2026-07-17-ops-platform-design.md) · Weeks 1–2 plan: [2026-07-17-weeks-1-2-foundation-and-demo.md](plans/2026-07-17-weeks-1-2-foundation-and-demo.md)

Legend: ✅ done & merged · 🔄 in progress · ⏳ planned · ⏸️ deferred (blocked on external input)

---

## Phase 1 — Foundation & July-31 demo (weeks 1–2)

Every item below is implemented, individually code-reviewed (7 with the strongest model), fixed where review found defects, and merged to `main`. Verified together on `main`: **853 unit + 116 integration tests pass, type-check clean, production build succeeds.**

| # | Deliverable | Status | Notes |
|---|---|---|---|
| 1 | Env config + integration-test harness (dockerized Postgres) | ✅ | Fail-fast env validation; `pg` write path |
| 2 | RBAC schema + GUC-based immutable audit trail + seed | ✅ | 6 roles, 24 permissions, 83 grants; `audit_log` tamper-resistant (service_role locked out) |
| 3 | `authorize()` choke point + generated permission-matrix suite | ✅ | Pure `can()` rule; 144 role×permission cases + seed-drift guard |
| 4 | Transactional write path (**risk R-4 spike — PASSED**) | ✅ | `withTransaction` carries audit actor via transaction-local GUC, proven leak-free |
| 4.5 | Legacy DLMS routes relocated under `/legacy/*` | ✅ | Platform claims clean URLs; `legacy-dlms` tag preserves the old app |
| 5 | Auth: request-scoped actor, MFA policy, security-event trail | ✅ | Deactivation kills live sessions next request; middleware gate |
| 6 | **AWS / Terraform / CI-CD** | ⏸️ | Deferred — needs an AWS account + a domain name |
| 7 | Five-module platform shell + permission-aware navigation | ✅ | Engineering · Finance · Logistics · Manufacturing · Maintenance · Tasks · Admin; server-side gated |
| 8 | Super Admin console — users | ✅ | Invite / activate / deactivate / access; last-admin + self-escalation guards (concurrency-safe via advisory lock) |
| 9 | Super Admin console — roles, permissions, overrides | ✅ | Editable 24×6 matrix; per-user overrides; fabric-lockout guard |
| 10 | Task schema + pure domain (status, overdue, visibility) | ✅ | Append-only comments; two-gate visibility rule |
| 11 | Task service (create / assign / transition / comment / link) | ✅ | Atomic create; uniform visibility across list/detail; 404-not-403 |
| 12 | Task UI — My Tasks, central centre, detail, record panel | ✅ | Errors never leak internals; graceful hide vs strict 404 |
| 13 | Manufacturing device registry (read-only port) | ✅ | 10-status lifecycle; partial-serial search; keyset pagination |
| 14 | Demo data migration + reconciliation | ✅ | Preserves device UUIDs + audit history verbatim; ranged serials flagged not split |

### Your three explicit July-31 requirements
- ✅ **Collaborative todo lists** — full task system on four surfaces
- ✅ **Super Admin permissions** — complete console, audit-attributed, lockout-safe
- ✅ **Separate module sections** — five-module shell, permission-gated

---

## Cloud & deployment standup (needed before the demo actually *runs*)

| Step | Status | Owner / blocker |
|---|---|---|
| Apply platform migrations + seed to cloud `qtx-ops-platform` | ✅ | Done 2026-07-20 (Singapore region) |
| **Enable RLS on platform tables (close anon-key exposure)** | ✅ | Done 2026-07-20 — advisor `rls_disabled` ERROR cleared; deny-via-REST verified |
| Configure cloud Auth: enable TOTP MFA, disable public signups, password min-12, redirect URLs | ⏳ | In-app enforcement (gate/step logic, layout AAL2 gate, `/mfa` enroll+challenge, admin factor-reset) now exists and is merged — only the dashboard TOTP toggle + Super Admin bootstrap + one manual end-to-end pass remain |
| Bootstrap Super Admin sets password / accepts invite | ⏳ | You (`reetmitra8@gmail.com` app_user row exists, awaits first login) |
| Run demo migration against real DLMS data | ⏳ | Needs read-only `LEGACY_DATABASE_URL` + this cloud schema (now ready) |
| Deploy the app | ⏸️ | AWS deferred; Vercel or localhost for the demo |

---

## Phase 2 — Post-demo feature build (weeks 3+)

Ordered by dependency and priority. **RLS hardening is first** because the schema is now live on a cloud project reachable with the public anon key.

| # | Feature | Status | Priority rationale |
|---|---|---|---|
| R1 | **RLS defense-in-depth** on all platform tables | ✅ | Spec §11.1. Applied to cloud + verified (advisor ERROR cleared). 130 integration tests; deny-via-REST, app paths unaffected |
| C1 | **Component model** — catalogue, serialized units, append-only installation history, per-variant BOM, the §14 atomic replacement primitive, admin catalogue screen, device-profile Components tab | ✅ | 5 tasks merged; migration applied to cloud (RLS verified, advisor clean). 866 unit + 155 integration tests. Critical-path prerequisite for Engineering + Maintenance — now unblocked |
| W1 | Manufacturing **write path** — create/edit devices, status changes through the fail-closed `status_transition` graph (create/edit dialog + status-change control on the profile, gated create route) | ✅ | 6 tasks merged (code-only, **no migration** — tables already on cloud). 883 unit + 173 integration; per-task reviews (3 opus) + opus whole-branch review. Fail-closed graph, terminal-needs-`delete_records`, optimistic-locked, audited, no error leak. Completes Manufacturing beyond read-only |
| M1 | **Mandatory MFA enforcement** — pure gate/step logic, layout AAL2 gate, `/mfa` enroll+challenge flow, admin "Reset MFA" console control | ✅ | 5 tasks merged (code-only, no schema/cloud change). 891 unit + 176 integration tests. Fail-closed on unresolved AAL (routes to `/mfa` rather than admitting); admin reset deletes the user's TOTP factors and forces re-enrollment on next login. Remaining before it's live: enable the cloud TOTP factor, bootstrap the Super Admin auth identity, one manual end-to-end pass (checklist in the task brief) |
| A1 | **Action-layer AAL2 enforcement** — `requireAal2Actor` gates every platform server action; convention pinned by `actionAalPinning.test.ts` | ✅ | Closes the MFA design's documented capability-layer gap: an AAL1 session can no longer invoke privileged mutations, not just pages. Fail-closed; non-MFA roles pay no AAL read. Code-only |
| E1 | **Engineering module (basic)** — ECR/ECO change management + firmware release registry (CRUD, fail-closed status flows, `approve_requests`-gated ECO approval, TaskPanel on detail) | ✅ | Migration applied to cloud (RLS deny-via-REST, advisor clean); lands the deferred `component_unit.firmware_release_id` FK. Deferred: approvals engine, failure/RCA, doc library, BOM effectivity automation |
| MA1 | **Maintenance module (basic)** — 6-state repair workflow (spec §5.3), sign-off (`sign_off_repairs` + testing-notes precondition), repair history, best-effort device Under Repair ↔ Active moves via the manufacturing service | ✅ | Migration applied to cloud; lands the deferred `component_installation.repair_id` FK. Deferred: files/photos, usage logs, modifications, "replacements committed" sign-off precondition (needs §14 wiring), atomic device move |
| F1 | **Finance module (basic)** — buyers + SGD sales invoices with lines (`view_finance`/`manage_finance` gated; server-side money math; 4-state flow) | ✅ | Migration applied to cloud; lands the deferred `device.buyer_id` FK. Deferred: threshold-approval engine, PDF generation |
| L1 | **Logistics module (basic)** — stock locations + delivery orders with POD reference fields (5-state DO flow) | ✅ | Migration applied to cloud; lands the deferred `component_unit.location_id` FK. Deferred: file uploads, stock-level accounting |
| I1 | Manufacturing **bulk import** — server-side parse → `import_batch`/`import_row` staging → review queue → per-row resumable commit into devices + component units + installations | ✅ | 7 tasks merged + 8 fix passes. Migration committed, awaiting cloud apply (not yet applied — RLS/advisor status TBD at apply time). Bilingual column mapping, ranged-serial expansion with a needs-review queue for ambiguous notation, within-batch and DB dedupe. Parsed drafts live server-side, closing the legacy importer's client-tamper path. 1177 unit + 351 integration tests; `tsc` clean; `next build` green (52/52 pages). Deferred: fix-in-place editing of `needs_review` rows (a reviewer skips the row and corrects the source sheet), PDF/draft extraction port, import of components onto existing devices, batch-listing page (a batch is reachable only via the post-upload redirect or a saved URL) |
| — | Legacy component-data migration (DLMS PCBA/screen columns → component_unit/installation rows) | ⏳ | Follow-up now that the component schema is live |
| — | Status-driven cross-department handoffs (transactional outbox → auto-tasks; reads `status_transition.task_template_key`) | ⏳ | Depends on the write path (now done) + a worker |
| — | Module deepening: Engineering (approvals, failure/RCA, doc library, BOM) · Maintenance (files, usage, modifications, §14 wiring) · Finance (threshold approval, PDF) · Logistics (uploads, stock levels) | ⏳ | The basic portions of all five modules now exist; this is the fill-out work |
| — | Approvals engine · tiered notifications (SES) · dashboards · global search · full-system export | ⏳ | Collaboration + reporting layer |
| — | Worker service (pg-boss): jobs, schedules, backups, digests | ⏳ | Pairs with notifications/outbox |

---

## Carried review findings (Minor — triaged, none blocking)

Tracked for cleanup during the relevant Phase-2 task:
- Middleware `PUBLIC_PATHS` uses `startsWith` (harden to exact/segment match) — no exploit today
- `authEvents` catch assumes `Error` shape (add `instanceof` guard)
- Task list `LIMIT 200` precedes the visibility filter — revisit when pagination lands
- `normalizeDueDate` bumps a literal UTC-midnight instant to end-of-day
- Subtasks section is a stub (Task 11 `TaskDetail` doesn't yet expose `parentTaskId`)
- `UserTable` "Permission exceptions" link shows for non-fabric admins (dead-ends at 404)
- CI (when Task 6 lands) **must** run `npm run test:integration` — the permission-matrix drift guard lives there
- Advisor hygiene: revoke `fn_audit` EXECUTE from anon/authenticated (folded into R1); `pg_trgm` in `public` schema (accepted)
- (Write path W1) `DeviceEditDialog.dateInput` renders the seeded date via `toISOString().slice(0,10)` — correct under a UTC deployment (prod is UTC); latent one-day shift on a non-UTC host
- (Write path W1) `changeDeviceStatus` history reason is now trimmed; `listAllowedTransitions` filters targets by `active` while the service doesn't (theoretical — no inactive status seeded)
- (Write path W1) action `toMessage` duplicates `componentActions.toMessage` — candidate for a shared helper as known-error types grow; `DeviceNotFoundError`/exact-`DuplicateSerialError` action-unit assertions added in the final fix
