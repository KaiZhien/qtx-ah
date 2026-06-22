# Product Requirements Document — QuantumTX Device Lifecycle Management System (DLMS)

| | |
|---|---|
| **Product** | Internal Device Lifecycle Management System (DLMS) — working codename "Registry" |
| **Owner** | Reet (Engineering) |
| **Audience** | Engineering supervisor (review/demo), implementing engineer, Claude Code |
| **Status** | Draft v2.0 — data model aligned to the real `PCBA_Traceability.xlsx` "Traceability" sheet |
| **Last updated** | June 2026 |

> **Source of truth:** the data model in §6 mirrors the *Traceability* sheet of `PCBA_Traceability.xlsx` exactly — the six column groups and their fields, with their original bilingual (EN | 中文) labels. The system is a structured, auditable, multi-user replacement for that sheet, not a redesign of how the data is organized.

---

## 1. Overview

QuantumTX produces hardware devices, each an assembly of two PCBAs (an Amplifier/power board "PCBA-A" and an Accessory/control board "PCBA-B") plus an HMI touchscreen. Today these are tracked in a shared spreadsheet (`PCBA_Traceability.xlsx`), where each row records a build/shipment with serial numbers, board revisions, screen info, shipment details, and status. This works but has no access control, no audit trail, no validation, weak search, and the usual spreadsheet failure modes (overwrites, inconsistent entry, values stuffed into free-text cells).

DLMS is an internal web dashboard that turns that sheet into a proper system of record: structured device records using the same six field groups the team already uses, role-based access, an immutable change history of who edited what, fast search, and a clean migration path from the existing sheet. A later phase adds an invoice/document extraction pipeline that drafts new records for human review.

### This document's purpose
1. Define the system so it can be built end-to-end as a working prototype with mock data.
2. Serve as the spec a coding agent (Claude Code) implements against.
3. Map 1:1 onto the existing Traceability sheet so the real data imports cleanly.

---

## 2. Goals & non-goals

### Goals
- Replace the manual Traceability sheet with a structured, auditable, multi-user system that uses the **same six field groups**.
- Preserve a full **change history**: every edit captured with who/when/before/after.
- Role-based access so different staff have appropriate read/write power.
- Fast lookup by board serial and customer — the team's main access pattern.
- A credible, demo-ready prototype that runs locally with realistic seed data.
- A clean CSV import that maps directly from the existing sheet.

### Non-goals (for the prototype)
- The invoice extraction pipeline is **specified but stubbed** (Phase 2).
- No production deployment, corporate SSO, or regulatory validation in the prototype.
- No mobile-native app; responsive web is sufficient.
- **No unit-level expansion of serial ranges.** A record mirrors a sheet row; serial fields may contain a range or list as text, with `Qty` holding the count. (Per-unit expansion is a documented future option — see §14.)

### Prototype scope summary (Phase 0)
Authentication with role switching for demo; device list with search/filter; device detail showing the six groups; create/edit device; change-history view; admin audit log; CSV import (the sheet-migration path) and CSV export; an overview dashboard; mock seed data based on the real sheet.

---

## 3. Users & roles

| Role | Description | Core capability |
|---|---|---|
| **Viewer** | Sales/support who look things up | Read-only across all device records and history |
| **Engineer** | Senior engineers (primary users) | Create records, edit fields, change status, confirm extracted drafts |
| **Admin / Quality** | System and data owners | Everything Engineer can do, plus manage users/roles, manage Status/Phase vocabularies, soft-delete, export, view full audit log |
| **System** | Non-human service identity for the extraction worker (Phase 2) | Writes only to the staging/draft table; never to canonical tables |

For the prototype, provide a **dev-only role switcher** in the header so the supervisor can experience each role without separate accounts.

### Permission matrix

| Action | Viewer | Engineer | Admin/Quality |
|---|:---:|:---:|:---:|
| View records & history | ✅ | ✅ | ✅ |
| Create device record | ❌ | ✅ | ✅ |
| Edit fields (most groups) | ❌ | ✅ | ✅ |
| Change Status / Phase | ❌ | ✅ | ✅ |
| Manage Status/Phase vocabularies | ❌ | ❌ | ✅ |
| Soft-delete record | ❌ | ❌ | ✅ |
| Manage users & roles | ❌ | ❌ | ✅ |
| View full audit log | ❌ | partial* | ✅ |
| Export data | ❌ | ✅ | ✅ |
| Confirm extracted draft (Phase 2) | ❌ | ✅ | ✅ |

\* Engineers see the change history of a record; the cross-system raw audit log is Admin/Quality only.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Next.js (App Router, TypeScript)  — UI + server actions  │
│  Tailwind + shadcn/ui                                     │
└───────────────┬───────────────────────────────────────────┘
                │ typed queries (via service layer)
┌───────────────▼───────────────────────────────────────────┐
│  Supabase                                                  │
│   • Postgres (device records + append-only audit log)      │
│   • Auth (email/domain-restricted; role claims)            │
│   • Row Level Security (authorization backstop)            │
│   • Storage (uploaded documents — Phase 2)                 │
└───────────────┬───────────────────────────────────────────┘
                │ (Phase 2 only)
┌───────────────▼───────────────────────────────────────────┐
│  Python extraction worker (FastAPI + queue)                │
│   doc parse → OCR fallback → LLM structured extraction      │
│   writes to staging table only                             │
└────────────────────────────────────────────────────────────┘
```

**Key principles**
- Authorization enforced in **two layers**: RLS in Postgres (hard backstop) + app layer (UX).
- The `device` table is the system of record; the extraction worker can only write to staging.
- Every mutation is recorded in an append-only audit log (this *is* the change history).
- Soft delete only — no hard deletes anywhere.
- Optimistic concurrency via a `version` column on the device record.

---

## 5. Tech stack & conventions

- **Frontend / app:** Next.js (App Router), TypeScript, React Server Components + Server Actions for CRUD.
- **Styling/UI:** Tailwind CSS + shadcn/ui. Dense, sortable data tables; grouped detail/edit sections; clear status badges. Bilingual (EN | 中文) field labels.
- **Database / auth / storage:** Supabase (Postgres). RLS policies for every table. Generated TypeScript types from the schema.
- **Migrations:** all schema changes via versioned migration files committed to the repo. Never hand-edit the DB.
- **Extraction worker (Phase 2):** Python, FastAPI, a job queue, an LLM for structured extraction, PDF text parsing + OCR fallback.
- **Validation:** shared schema validation (e.g. Zod) on inputs; DB-level constraints as the final guard.
- **Testing:** unit tests for validation rules, permission checks, import parsing, and date/serial normalization at minimum.

---

## 5.1 Architecture principles & extensibility guidelines

These principles are **mandatory and apply from the first commit**. They are the difference between a system that absorbs new features cheaply and one that becomes risky to change.

### 5.1.1 A service/domain layer sits between UI and database
Do **not** let UI components or Server Actions write to the database directly. Every state-changing operation goes through named service functions that own the business rules — e.g. `createDevice`, `updateDevice`, `changeStatus`, `softDeleteDevice`, `importRows`, `promoteDraft`. UI calls the service; the service validates, enforces permissions, performs the write, and returns a typed result.
- **Why:** a new developer learns the system by reading the service layer, not by archaeology across mutation handlers. Rules live in one place and cannot drift between screens.
- **Rule:** if a business rule (validation, permission, status logic) appears in a React component, it is in the wrong place.

### 5.1.2 New behaviors are added without touching the core record shape
The append-only audit log and lookup-table vocabularies (§6.5) are the primary extension points. Adding a new Status or Phase value is a row insert, not a migration. Tracking a new kind of change requires no schema change to `device`.

### 5.1.3 The jsonb-vs-column rule (avoid both rigidity and EAV)
The six groups are fixed typed columns. Should new "many more data points" appear later, classify each: **searched/filtered/reported/validated → a real typed column**; **genuinely rare/variable long-tail → `jsonb`**. Never model the core domain as pure key-value/EAV. Never dump high-value fields into `jsonb` to skip a migration. Document why any jsonb field is jsonb.

### 5.1.4 Single source of truth for controlled vocabularies
`Status` and `Phase` are controlled vocabularies stored in lookup tables, read by the code from one place. Adding/retiring a value is a data change, admin-managed, with no code edit.

### 5.1.5 Single source of truth for derived/normalized values
Serial normalization (uppercase, trim) and date parsing live in one shared utility used by both the form path and the import path. A rule changes once, everywhere.

### 5.1.6 Auditing is unforgettable by construction
Implement the `audit_log` via **database triggers**, not app-layer middleware. A developer must be physically unable to forget to log a mutation because they do not write the logging code at all.

### 5.1.7 Validation has one source of truth
Define input validation schemas (Zod) and mirror DB constraints from the same intent; keep them adjacent and tested so they cannot silently drift.

### 5.1.8 Stable contracts at service seams
The boundary between the app and the Phase 2 extraction worker is the `extracted_device_draft` schema and nothing else. The worker may change its internals freely as long as it honors that contract. Version the `extracted_payload` shape explicitly.

### 5.1.9 Readability & conventions for future developers
- Intention-revealing names; domain terms (PCBA-A, HMI, Phase) used consistently.
- Co-locate code by feature (device, import, audit, extraction), not by technical type.
- Tests state each business rule in plain terms and double as documentation.
- The schema is the contract: keep generated TypeScript types in sync.
- Every migration is small, reversible where possible, descriptively committed.

### 5.1.10 Extensibility acceptance bar
Each of the following must be possible with **additive code only — no change to the `device` table's existing columns and no rewrite of existing services**:
- adding a new Status or Phase value,
- adding a new role (matrix + RLS policy + UI gate),
- adding a new field group or column for a future data point,
- adding a new document type to the Phase 2 pipeline,
- (future) introducing per-unit serial expansion behind the existing record.

---

## 6. Data model

The device record reproduces the Traceability sheet's six groups exactly. Standard system columns are added to the `device` table: `id` (uuid pk), `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at` (nullable, soft delete), `version` (int, optimistic concurrency). Plus normalized search columns: `device_sn_normalized`, `pcba_a_sn_normalized`, `pcba_b_sn_normalized` (uppercased, trimmed copies for matching).

### 6.1 `device` — fields by group (bilingual labels preserved in UI)

**Group: Device Info · 设备信息**
| Column | Label (EN \| 中文) | Type | Notes |
|---|---|---|---|
| `device_sn` | Device S/N \| 设备序列号 | text, nullable | Intended primary key; currently often blank. Unique when present. |
| `product_name` | Product Name \| 产品名称 | text, nullable | |
| `model_no` | Model No. \| 产品型号 | text, nullable | |

**Group: PCBA-A · 电源板 Amplifier Board**
| Column | Label | Type | Notes |
|---|---|---|---|
| `pcba_a_sn` | PCBA-A S/N \| 电源板序列号 | text | De facto record identity today; may hold a **range or list** as text (e.g. `EE-02A-2603-0001 to 0015`). |
| `pcba_a_hw_rev` | HW Rev \| 硬件版本 | text | e.g. `V1P03` |
| `pcba_a_bom_rev` | BOM Rev \| BOM版本 | text | e.g. `Rev01` |
| `pcba_a_fw_ver` | FW Ver \| 固件版本 | text | e.g. `V1.0.0` |

**Group: PCBA-B · 控制板 Accessory Board**
| Column | Label | Type | Notes |
|---|---|---|---|
| `pcba_b_sn` | PCBA-B S/N \| 控制板序列号 | text, nullable | May hold a range/list. |
| `pcba_b_hw_rev` | HW Rev \| 硬件版本 | text, nullable | |
| `pcba_b_bom_rev` | BOM Rev \| BOM版本 | text, nullable | |
| `pcba_b_fw_ver` | FW Ver \| 固件版本 | text, nullable | Sometimes carries notes (e.g. `No wifi version`) in current data — accepted as-is. |

**Group: HMI Screen · 触摸屏**
| Column | Label | Type | Notes |
|---|---|---|---|
| `screen_model` | Screen Model \| 屏幕型号 | text, nullable | e.g. `NX8048P070-011R` |
| `hmi_ver` | HMI Ver \| HMI软件版本 | text, nullable | Currently mixes version + config (`Basic`, `one pro and one basic`) — accepted as free text. |

**Group: Shipment Info · 出货信息**
| Column | Label | Type | Notes |
|---|---|---|---|
| `build_date` | Build Date \| 生产日期 | date, nullable | Source format `DD/MM/YYYY`; parsed/normalized on import. |
| `ship_date` | Ship Date \| 出货日期 | date, nullable | |
| `qty` | Qty \| 数量 | integer, nullable | Count for the record (esp. when S/N is a range). |
| `destination` | Destination \| 目的地 | text, nullable | |
| `customer` | Customer \| 客户 | text, nullable | Text with autocomplete from existing values (data hygiene); optional lookup table is a future step. |

**Group: Status & Notes · 状态**
| Column | Label | Type | Notes |
|---|---|---|---|
| `status` | Status \| 状态 | fk → `status_option` | Controlled vocabulary. Observed: `Shipped`. |
| `phase` | Phase \| 阶段 | fk → `phase_option` | Controlled vocabulary. Observed: `MP`. |
| `remarks` | Remarks \| 备注 | text, nullable | Free text; preserves multiline notes/exceptions verbatim. |

### 6.2 `audit_log` (append-only — the change history)
- `actor_id`, `action` (insert/update/soft_delete), `table_name`, `row_id`
- `old_values` (jsonb), `new_values` (jsonb), `changed_columns` (text[])
- `request_id` (text), `occurred_at` (timestamptz)
- Written automatically by DB trigger on every mutation. Read-only in the UI. Powers both the per-record change history and the admin audit view.

### 6.3 `extracted_device_draft` (Phase 2 staging)
- `source_file_path`, `source_file_hash` (text, **unique** — idempotency key)
- `status` (enum: pending_review, confirmed, rejected)
- `extracted_payload` (jsonb — the six-group fields + per-field confidence + source quote)
- `extraction_model_version` (text)
- `reviewed_by` (fk, nullable), `promoted_device_id` (fk, nullable)
- The worker writes only here; promotion to `device` happens on human confirm and is attributed to the reviewing engineer.

### 6.4 `app_user` / roles
- Backed by Supabase auth users; store `role` (enum: viewer, engineer, admin, system) and `active` (bool). Deactivated users are never deleted (preserve audit attribution).

### 6.5 `status_option` / `phase_option` (controlled vocabularies)
- `code` (text, unique), `label_en`, `label_zh`, `sort_order`, `active` (bool).
- Seed `status_option` with `Shipped` (+ sensible additions: `In Production`, `In Stock`, `Returned`, `Retired`).
- Seed `phase_option` with `MP` (+ common hardware phases as inactive-by-default suggestions: `EVT`, `DVT`, `PVT`).
- Admin-managed; adding a value never requires a migration (§5.1.4).

---

## 7. Status & Phase model

`Status` and `Phase` are **controlled vocabularies** (lookup tables, §6.5), not free text — this prevents the `Shipped`/`shipped`/`SHIPPED` drift typical of spreadsheets while staying fully extensible.

- Any status/phase value is selected from the active vocabulary; the UI shows bilingual labels.
- Status changes are ordinary edits captured by the audit log (no rigid state machine is imposed, since the current process is linear and lightly used). If formal transition rules are wanted later, add an optional `allowed_transitions` table read by `changeStatus` — an additive change per §5.1.2. **Not in prototype scope.**
- On CSV import, an incoming Status/Phase not in the vocabulary is **flagged for review**, not silently created.

---

## 8. Functional requirements (screens & behaviors)

### 8.1 Authentication & user management
- Email sign-in via Supabase Auth, restricted to company domain (configurable). Role stored as a claim; RLS keys off it.
- Admin screen to invite users, set/change roles, deactivate users.
- **Prototype:** dev-only role switcher in the header.

### 8.2 Overview dashboard (home)
- Metric tiles: total active records, total units (sum of `qty`), records by Status, records by Phase, records by Customer.
- Recent activity feed (latest changes from the audit log) and recent builds/shipments.
- Tiles deep-link to filtered lists.

### 8.3 Device list
- Sortable, filterable, paginated table. Suggested columns: Device S/N (or PCBA-A S/N if blank), Product Name, Model No., Customer, Status (badge), Phase (badge), Build Date, Ship Date, Qty.
- **Search:** by PCBA-A S/N, PCBA-B S/N, Device S/N, and Customer (text-contains on normalized serials). *Known limitation:* because serials may be stored as ranges, searching a single unit within a range will not match unless that exact text appears — see §14 (range expansion) for the future fix.
- Filters: Status, Phase, Customer, Model, Build/Ship date ranges.
- Bulk-select for export.

### 8.4 Device detail
- Header: Device S/N (or PCBA-A S/N), Product Name, Status + Phase badges, quick actions (edit, change status, soft-delete [admin]).
- Body laid out as the **six labeled groups** (bilingual headings), read-only view.
- Tabs: **Details** (the six groups), **Change history** (per-record audit log: who/when/before→after), **Documents** (Phase 2).

### 8.5 Create / edit device
- Form organized into the six group sections with bilingual labels, matching the sheet's mental model.
- Validation: serial normalization + uniqueness check on `device_sn` when present; integer `qty`; date parsing for build/ship dates; Status/Phase chosen from vocabulary.
- Optimistic concurrency: stale writes rejected with a "record changed, reload" conflict message.

### 8.6 Change status
- Lightweight action to set Status (and Phase) from the vocabulary; recorded by the audit log like any edit.

### 8.7 Audit log viewer (admin)
- Filterable, read-only view of all mutations: actor, action, table, record, changed columns, before/after, timestamp.

### 8.8 CSV import (the sheet-migration path — first-class feature)
- Upload a CSV exported from the Traceability sheet; map the sheet columns to the six-group fields (sensible auto-mapping by header).
- Per-row validation preview: parse `DD/MM/YYYY` dates, normalize serials, coerce `qty`, validate Status/Phase against the vocabulary; show valid vs rejected rows **with reasons**.
- Import valid rows; never partial-write a bad row silently. Serial ranges/lists are imported **as text** (no expansion); multiline Remarks preserved.
- Handle the header structure of the real file (title rows + grouped header rows + the field-name row) gracefully, or document the expected CSV shape.

### 8.9 CSV export
- Export the current filtered list (optionally with change history) to CSV, with the same column layout for round-tripping.

### 8.10 Invoice/document extraction (Phase 2 — stubbed in prototype)
- Upload screen (placeholder) and a staging review screen reading `extracted_device_draft`: extracted six-group values with per-field confidence on one side, source snippet on the other, editable, with **Confirm** → promotes to a real `device` attributed to the reviewer. Dedupe by file hash. Build the data path and screens; leave actual extraction as a stub returning mock drafts.

---

## 9. Non-functional requirements

- **Auditability:** every mutation logged with actor, changed columns, before/after, timestamp. Append-only; no hard deletes.
- **Security:** RLS on every table; least privilege; no sensitive data in URLs; domain-restricted auth.
- **Concurrency:** optimistic locking on the device record.
- **Data integrity:** unique on `device_sn` when present; normalized-serial columns for search; integer/date typing enforced; Status/Phase FK to vocabulary.
- **Performance:** indexed search on normalized serials and customer; paginated lists.
- **Internationalization:** bilingual (EN | 中文) field and group labels throughout; data values stored verbatim (Chinese text in Remarks etc. preserved).
- **Observability:** structured logs; the audit_log doubles as a forensic trail.
- **Maintainability:** migrations in version control; generated DB types; tests for validation, permissions, import parsing, normalization.

---

## 10. Edge cases & validation rules

- **Serial as range/list:** `pcba_a_sn`/`pcba_b_sn` may contain `... to ...`, `... and ...`, or `&`-joined values. Stored as text; `qty` carries the count. No reconciliation between PCBA-A and PCBA-B counts is enforced (real data shows mismatches — accepted).
- **Blank Device S/N:** allowed; fall back to PCBA-A S/N for display/identity. Uniqueness enforced only when `device_sn` is present.
- **Serial hygiene:** trim trailing/leading whitespace into the normalized columns (real data has e.g. a trailing space); keep the original verbatim in the display column.
- **Dates:** parse `DD/MM/YYYY`; reject ambiguous/invalid dates on import with a clear reason; allow blank.
- **Status/Phase not in vocabulary (import):** flag the row for review; do not auto-create vocabulary values.
- **Multiline / mixed-language Remarks:** preserved verbatim; never truncated.
- **Config/variant in `hmi_ver` or Remarks** (`Basic`, `one pro and one basic`, `KNM version`): accepted as free text for now (promoting variant to its own field is a documented future step, §14).
- **Concurrent edits:** version mismatch → reject with reload prompt.
- **Offboarding a user:** deactivate, never delete; audit attribution preserved.
- **Phase 2 extraction:** duplicate file upload (hash dedupe); multiple records per document (N drafts); low-confidence fields (require human confirm); ungrounded values (must have a source quote or be null); wrong document type (reject).

---

## 11. Mock / seed data (prototype)

Seed realistic data so the dashboard demos well, based directly on the real sheet:
- Include the **six real rows** from the Traceability sheet verbatim as the basis.
- Expand to ~40–50 records in the same shape:
  - PCBA-A serials like `EE-02A-YYMM-####` (singles and ranges, e.g. `EE-02A-2604-0001 to 0054`).
  - PCBA-B serials like `EE-01-B2020-002-A####` (singles and ranges).
  - HW Rev `V1P03`, BOM Rev `Rev01`, FW Ver values `V1.0.0` / `V0.0.12` / `V0.0.13`.
  - Screen Model `NX8048P070-011R`; HMI Ver values `Basic` / `Pro` / `No wifi version` / `one pro and one basic`.
  - Build/Ship dates spread across 2025–2026 (some blank, matching reality).
  - Customers/Destinations: `Computime`, `KL`, `KNM`, `BIXPES`, plus a couple more.
  - Status mostly `Shipped` with a few `In Production` / `In Stock` for variety; Phase mostly `MP` with a couple of earlier phases.
  - Remarks with real-style exceptions (`... to Computime trial`, `... as replacement`, variant notes).
  - A handful of records with `device_sn` populated (the future state) and most with it blank (today's state).
- Seed `status_option` and `phase_option` per §6.5; a few users, one per role; and 3–5 `extracted_device_draft` rows in `pending_review` so the Phase 2 screen has content.
- Seed audit_log entries reflecting the above.
- *Note:* Product Name / Model No. are blank in the real sheet; use clearly-mock placeholders so the UI looks alive, and treat the real values as TBD (§14).

---

## 12. Delivery plan

- **Phase 0 (prototype — this build):** schema (the six-group `device` table) + RLS + trigger-based audit log + vocabularies; full CRUD UI; all screens in §8 except live extraction; CSV import/export; mock seed data; role switcher. Runnable locally.
- **Phase 1 (production):** import the real sheet via the CSV flow; real auth/SSO; deploy; resolve the §14 open questions and add any agreed fields (e.g. variant, warranty).
- **Phase 2:** the extraction worker (Python/FastAPI + OCR + LLM) writing to the staging table, behind the already-built review flow.

---

## 13. Acceptance criteria (prototype)

1. App runs locally with a single setup command and seeded data (incl. the six real rows).
2. Can sign in / switch roles; permissions enforced per the matrix (UI + RLS).
3. Can create, view, edit, and soft-delete a device record; deletes never remove rows.
4. Device detail shows all six groups with bilingual labels, plus a change-history tab.
5. Editing a record records who/when/before→after in the audit log; status changes appear in history.
6. Search by PCBA-A/PCBA-B/Device serial and customer works; filters by Status/Phase/Customer/Model/date work.
7. Concurrent-edit conflict is detected and surfaced.
8. CSV import maps the sheet's columns, validates per row (dates parsed, serials normalized, qty coerced, Status/Phase checked), and reports valid vs rejected rows with reasons; CSV export round-trips.
9. Overview dashboard shows live metrics (totals, units, by Status/Phase/Customer) and a recent-activity feed.
10. Status/Phase are controlled vocabularies; an admin can add a value with no code change.
11. Phase 2 review screen lists mock drafts and can "promote" one into a real device attributed to the reviewer.
12. **Architecture conformance (§5.1):** all mutations go through the service layer (no direct DB writes from UI); vocabularies and audit are single-sourced; auditing is trigger-based; normalization/date-parsing live in one shared utility; code is organized by feature. Verified by spot-check: adding a new Status value and a new role must each be possible without altering the `device` table or rewriting existing services.

---

## 14. Open questions / assumptions

1. **Identity:** Is the **PCBA-A S/N** the device's identity for now, with a separate **Device S/N** to be assigned at final assembly later? (Current data uses PCBA-A S/N; Device S/N is blank.) The model supports both.
2. **Customer/Destination values:** What exactly are `Computime`, `KL`, `KNM`, `BIXPES` — customers, destinations, or product variants? They appear to do double duty. Resolving this decides whether Customer should become a lookup table and whether a Variant field is needed.
3. **Product Name / Model No.:** blank in the sheet — what are the real values? Needed to replace mock placeholders in Phase 1.
4. **Deferred fields (consciously parked, recoverable via §5.1):**
   - **Variant/configuration** (Pro/Basic, wifi/no-wifi, KNM/BIXPES builds), currently in `hmi_ver`/`remarks`.
   - **Warranty** (mentioned in early scoping but not present in the sheet's groups).
   - **Per-unit serial expansion** (turning a range into individual unit records for true unit-level traceability).
   These are intentionally out of scope now; the architecture is built to add them additively when needed.

---

*End of PRD v2.0.*
