-- ===========================================================================
-- Finance module, post-sales completion (spec §6.3 Post-sales row):
--
--   1. `warranty`             — the warranty registry the spec calls for and
--                                20260720120000_platform_finance.sql did not build.
--   2. `document_access_log`  — an append-only record of WHO pulled WHICH
--                                generated finance document and WHEN.
--
-- Belongs to the `qtx-ops-platform` project (see 20260718000000_platform_rbac.sql
-- for why this directory holds both the platform schema and the pre-existing
-- DLMS migrations side by side). Carries the `platform_` token so
-- __tests__/integration/setup.ts picks it up. Committing this file does nothing
-- by itself until it is applied via the Supabase MCP/CLI. `device`, `app_user`,
-- `sales_invoice` and `fn_attach_audit` all already exist.
--
-- House DDL conventions (matching 20260720120000_platform_finance.sql): id uuid
-- PK default gen_random_uuid(), created_at/created_by NOT NULL, updated_at NOT
-- NULL / updated_by nullable, deleted_at nullable (soft delete only), version
-- int default 1 (optimistic lock). RLS: ENABLE ROW LEVEL SECURITY with NO
-- policies and NEVER FORCE (deny-via-REST — see 20260720000000_platform_rls.sql).
-- ===========================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. warranty
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ┌───────────────────────────────────────────────────────────────────────┐
-- │ READ THIS BEFORE ADDING A `status` COLUMN. Someone will try. Don't.    │
-- └───────────────────────────────────────────────────────────────────────┘
--
-- Spec §6.3: "warranty (device FK unique, start/end dates, terms; STATUS
-- DERIVED FROM DATES — NEVER STORED STALE)".
--
-- There is no status column here, and adding one is a correctness regression,
-- not an optimization. The reason is specific, not stylistic:
--
--   A warranty expiring is NOT AN EVENT. Nothing happens. No user acts, no
--   service runs, no row is touched. The clock passes midnight and a warranty
--   that was live yesterday is expired today — with no UPDATE, therefore no
--   fn_audit row, therefore no trigger anyone could hang a status write on.
--
-- A stored `status` would therefore be wrong for up to a full day after every
-- boundary (or permanently, the first time a nightly sweep fails silently).
-- "Wrong" here means: a technician opens a repair against a device the system
-- says is under warranty when it is not, and QTX eats the cost — or the
-- reverse, and a customer is refused a claim they are entitled to. There is no
-- benign staleness window for this field.
--
-- The derived status lives in modules/finance/domain/warrantyStatus.ts (pure,
-- injectable `today`, unit-tested including both sides of every boundary) and
-- is computed at read time by modules/finance/services/warrantyService.ts. The
-- indexes below exist precisely so deriving it stays cheap; if the radar query
-- ever gets slow the answer is a better index or a materialized view with an
-- explicit refresh contract, NEVER a column that lies between refreshes.
--
-- (The legacy DLMS did the tempting thing — 20250104000000_warranty.sql added
-- `device.warranty_expiry` as a GENERATED column of `ship_date + 2 years`. That
-- is stale-proof because it is derived, but it is also a FABRICATION: every
-- shipped device got an implied 2-year commitment nobody recorded. This table
-- replaces that inference with a real record. A device with no row here has NO
-- warranty — services must not fall back to a 2-year guess.)
CREATE TABLE warranty (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES device(id),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  terms       text,                      -- free-text terms/coverage description
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES app_user(id),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  -- Both bounds inclusive; a single-day warranty (start = end) is legal.
  CONSTRAINT warranty_period_ordered CHECK (end_date >= start_date)
);

COMMENT ON TABLE warranty IS
  'Warranty registry (spec §6.3 post-sales). One LIVE warranty per device, enforced by the partial unique index warranty_device_live_unique. There is deliberately NO status column: status is derived from (start_date, end_date, today) at read time by modules/finance/domain/warrantyStatus.ts. See this migration''s header for why a stored status is a correctness bug rather than a cache.';
COMMENT ON COLUMN warranty.start_date IS
  'First day of cover, INCLUSIVE. May be in the future (a warranty registered ahead of shipment is a live commitment that has not begun); domain isInForce() distinguishes that from cover running today.';
COMMENT ON COLUMN warranty.end_date IS
  'Last day of cover, INCLUSIVE — a claim opened ON this date is covered. The off-by-one matters commercially; warrantyStatus() pins both sides of the boundary in tests.';
COMMENT ON COLUMN warranty.terms IS
  'Free text: what is covered, exclusions, the contract reference. Not a vocabulary — terms are negotiated per deal and this build has no reason to constrain them.';
COMMENT ON COLUMN warranty.deleted_at IS
  'Soft delete. ALSO the renewal mechanism: renewing supersedes the current row (sets deleted_at) and inserts a new one in the same transaction, so warranty HISTORY is preserved and the unique index below still sees exactly one live row. Editing in place is for correcting a typo, not for extending cover — an extension that overwrites the old dates destroys the evidence of what was actually promised at sale time.';
COMMENT ON COLUMN warranty.version IS
  'Optimistic-lock counter. Not incremented by any trigger — the service layer sets version = version + 1 explicitly on UPDATE (platform convention, see modules/manufacturing/services/deviceWriteService.ts).';

-- "device FK unique" (spec §6.3) implemented as a PARTIAL unique index rather
-- than a plain UNIQUE constraint. This is the deliberate consequence of keeping
-- renewal history: superseded warranties stay in the table with deleted_at set,
-- so a full UNIQUE(device_id) would make the second renewal impossible. The
-- invariant that actually matters — at most ONE live warranty per device — is
-- exactly what this expresses. Same pattern as sales_invoice_invoice_no_unique
-- and device_sn_unique.
CREATE UNIQUE INDEX warranty_device_live_unique ON warranty(device_id) WHERE deleted_at IS NULL;

-- The expiry radar (spec §8.5 "warranties expiring 30/60/90 d"). end_date first:
-- every radar query is a range scan on it, and getWarrantyExpiryCounts groups by
-- nothing else.
CREATE INDEX warranty_end_date_idx ON warranty(end_date) WHERE deleted_at IS NULL;
CREATE INDEX warranty_device_idx ON warranty(device_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. document_access_log
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec §10 audits every file grant. The `file` table and its S3 presigned-upload
-- pipeline are deferred (no AWS account — PROGRESS.md item 6), so the invoice
-- PDF is GENERATED ON DEMAND and streamed straight from
-- app/(platform)/finance/invoices/[id]/pdf/route.ts instead of being stored.
-- Nothing is uploaded, so there is no "grant" to audit — but a finance document
-- leaving the building is exactly the event §10 cares about, so it is recorded
-- here.
--
-- WHY NOT audit_log: audit_log is a CHANGE log. Its `action` CHECK is
-- ('insert','update','soft_delete','delete'), its old_values/new_values columns
-- are meaningless for a read, and — importantly — the ONLY writer is fn_audit()'s
-- SECURITY DEFINER path (20260718000001_platform_audit.sql revokes INSERT from
-- every application role, including service_role, and the comment there is
-- explicit that this is what makes the trail tamper-resistant). Teaching
-- application code to INSERT into audit_log directly would open a forge path
-- through ordinary app code to buy a column that reads "download". Not worth it.
--
-- Instead this table gets fn_audit attached like any other mutable table, so
-- every access ALSO lands in audit_log as a normal `insert` row against
-- table_name='document_access_log' with the actor resolved from the app.actor_id
-- GUC. The central trail keeps the full story; this table just makes
-- "who pulled invoice X" a fast, indexed question.
--
-- Generic on purpose (entity_type / entity_id / document_kind) rather than
-- invoice_id: the POD and customs documents in §6.3's delivery_order row, and
-- every future `file` download once S3 lands, want the same trail. Today the
-- only writer is the invoice PDF route.
CREATE TABLE document_access_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('sales_invoice')),
  entity_id    uuid NOT NULL,
  document_kind text NOT NULL CHECK (document_kind IN ('invoice_pdf')),
  -- Denormalized on purpose: the status the document was generated UNDER. A
  -- draft PDF is watermarked DRAFT and a void one VOID, so "what did the copy
  -- this person walked away with actually say" is not answerable from
  -- sales_invoice.status later — that column moves on.
  entity_status text,
  actor_id     uuid NOT NULL REFERENCES app_user(id),
  accessed_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE document_access_log IS
  'Append-only record of generated-document downloads (spec §10 audit spirit). Written by modules/finance/services/invoicePdfService.ts inside the same transaction that reads the invoice. No updated_at/deleted_at/version columns by design: an access event is a fact about the past and is never edited or retracted — same shape as audit_log and auth_event.';
COMMENT ON COLUMN document_access_log.entity_type IS
  'CHECK-fenced to the entity kinds that actually have a document path today. Widen the CHECK when delivery-order PODs or the deferred `file` table land — never store an unfenced free-text discriminator.';
COMMENT ON COLUMN document_access_log.entity_status IS
  'The entity''s status at generation time, denormalized. Answers "was the copy they took a DRAFT?" after the invoice has moved on.';

CREATE INDEX document_access_log_entity_idx
  ON document_access_log(entity_type, entity_id, accessed_at DESC);
CREATE INDEX document_access_log_actor_idx ON document_access_log(actor_id, accessed_at DESC);

-- Append-only at the grant level too, mirroring auth_event's lockdown: no
-- application role may UPDATE or DELETE an access record. The app's own write
-- path connects as the postgres OWNER (lib/db/tx.ts) and is not constrained by
-- these grants — that caveat is already documented in
-- 20260718000001_platform_audit.sql's header and is a total-database-compromise
-- concern, not something a GRANT can fix.
REVOKE ALL ON document_access_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON document_access_log TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- Audit triggers + RLS
-- ═══════════════════════════════════════════════════════════════════════════
-- fn_audit is shape-agnostic; attach it to every new mutable table (house rule).
-- On document_access_log this deliberately duplicates each access row into
-- audit_log — that is the point: the central trail is where an auditor looks.
SELECT fn_attach_audit(t) FROM unnest(ARRAY['warranty','document_access_log']) AS t;

-- RLS deny-via-REST (R1 pattern, 20260720000000_platform_rls.sql): ENABLE with
-- NO anon/authenticated policy = PostgREST denies everything; the app never
-- reaches these tables as those roles. NOT FORCE — the owner (withTransaction)
-- and service_role paths must keep working, and FORCE would break both.
-- Skipping this re-trips the cloud `rls_disabled` advisor.
ALTER TABLE warranty            ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_access_log ENABLE ROW LEVEL SECURITY;
