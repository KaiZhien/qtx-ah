# QTX Operations Platform — Progress Checklist

**Living status board.** Last updated: 2026-07-20.
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
| Configure cloud Auth: enable TOTP MFA, disable public signups, password min-12, redirect URLs | ⏳ | Dashboard config — I can guide or do via API |
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
| — | Manufacturing **write path** (create/edit devices, status changes with the fail-closed transition graph, imports) | 🔄 **NEXT candidate** | Completes the Manufacturing module beyond read-only |
| — | Legacy component-data migration (DLMS PCBA/screen columns → component_unit/installation rows) | ⏳ | Follow-up now that the component schema is live |
| — | Status-driven cross-department handoffs (transactional outbox → auto-tasks) | ⏳ | Depends on device write path + a worker |
| — | Component catalogue + append-only installation history (§11) | ⏳ | Precedes Engineering + Maintenance per critical path |
| — | Engineering module (ECR/ECO + approvals, failure/RCA, doc library, firmware, BOM) | ⏳ | The chosen first cross-dept module (interview) |
| — | Maintenance module (6-state repairs + files, §14 component-replacement workflow, usage, modifications) | ⏳ | Depends on component model |
| — | Finance (sales invoices + threshold approval) · Logistics (DOs + POD + stock) | ⏳ | Thinner CRUD + approval reuse |
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
