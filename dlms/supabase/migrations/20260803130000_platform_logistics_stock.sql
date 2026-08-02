-- ===========================================================================
-- Logistics stock-level accounting (spec §6.3 "Logistics stock").
--
-- Builds the accounting layer on top of stock_location / delivery_order from
-- 20260720130000_platform_logistics.sql:
--   * stock_level          — qty of a BATCH-tracked component type at a location
--   * stock_transfer       — a move between two locations, own status lifecycle
--   * stock_transfer_line  — either a qty of a batch type OR one serialized unit
--
-- Belongs to the qtx-ops-platform project (see 20260718000000_platform_rbac.sql
-- header). Committing this file does nothing by itself until applied via the
-- Supabase MCP/CLI to the cloud project.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE ONE INVARIANT THIS WHOLE MIGRATION EXISTS TO PROTECT
-- ═══════════════════════════════════════════════════════════════════════════
-- A component type is EITHER serialized OR batch (component_type.tracking_mode,
-- immutable once set), and its whereabouts is recorded in exactly one place:
--
--   batch-tracked      -> stock_level(location_id, component_type_id, qty)
--   serialized         -> component_unit.location_id
--
-- A serialized unit is NEVER also counted in stock_level. If it were, the two
-- would drift apart within a week and there would be no way to tell which one
-- was lying. fn_stock_level_batch_only below makes that structural rather than
-- a convention someone can forget — the service layer rejects the wrong kind of
-- line first, with a readable error, and this trigger is the backstop that
-- catches anything reaching the table by another route.
-- ===========================================================================

-- ── stock_level ────────────────────────────────────────────────────────────
CREATE TABLE stock_level (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES stock_location(id),
  component_type_id  uuid NOT NULL REFERENCES component_type(id),
  qty                numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES app_user(id),
  version            integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE stock_level IS
  'Quantity of a BATCH-tracked component type at a stock location (spec §6.3). One row per (location, component_type) — see stock_level_unique. Serialized units are NOT counted here; their location is component_unit.location_id. Mutated only through modules/logistics/services/stockTransferService.ts, always under FOR UPDATE inside withTransaction.';
COMMENT ON COLUMN stock_level.qty IS
  'CHECK (qty >= 0) is the BACKSTOP, not the user-facing guard: the service tests the floor in SQL (UPDATE ... WHERE qty >= $1) and raises InsufficientStockError naming the component and location before this constraint can fire. If a user ever sees a raw 23514 from this column, a write path skipped the service.';
COMMENT ON COLUMN stock_level.version IS
  'Optimistic-concurrency counter, kept for consistency with the other platform tables. Note that the posting path does NOT rely on it: concurrent transfers touching the same balance are serialized by FOR UPDATE row locks taken in a deterministic order, not by version comparison — two transfers legitimately both change the same row and neither should lose.';

-- No deleted_at: a balance is never soft-deleted. Zero IS the empty state, and
-- the row is kept so history/audit of that (location, type) pair stays intact.
-- Plain (not partial) unique index so ON CONFLICT can name it.
CREATE UNIQUE INDEX stock_level_unique ON stock_level(location_id, component_type_id);
CREATE INDEX stock_level_type_idx ON stock_level(component_type_id);

-- Structural enforcement of the batch-only invariant documented in the header.
CREATE OR REPLACE FUNCTION fn_stock_level_batch_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mode text;
BEGIN
  SELECT tracking_mode INTO mode FROM component_type WHERE id = NEW.component_type_id;
  IF mode IS DISTINCT FROM 'batch' THEN
    RAISE EXCEPTION
      'stock_level only accounts for batch-tracked component types (% is %); a serialized unit''s location is component_unit.location_id',
      NEW.component_type_id, coalesce(mode, 'unknown')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_level_batch_only BEFORE INSERT OR UPDATE ON stock_level
  FOR EACH ROW EXECUTE FUNCTION fn_stock_level_batch_only();

-- ── stock_transfer ─────────────────────────────────────────────────────────
CREATE TABLE stock_transfer (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no        text NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','dispatched','received','cancelled')),
  from_location_id   uuid NOT NULL REFERENCES stock_location(id),
  to_location_id     uuid NOT NULL REFERENCES stock_location(id),
  initiated_by       uuid NOT NULL REFERENCES app_user(id),
  dispatched_at      timestamptz,
  received_at        timestamptz,
  received_by        uuid REFERENCES app_user(id),
  carrier            text,
  reference          text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES app_user(id),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT stock_transfer_distinct_locations CHECK (from_location_id <> to_location_id)
);
COMMENT ON TABLE stock_transfer IS
  'A movement of stock between two stock_locations (spec §6.3). Status lifecycle draft -> dispatched -> received (+ cancelled from draft/dispatched), evaluated by the fail-closed pure function modules/logistics/domain/transferStatus.ts. ALL stock movement is posted at RECEIVE, in one transaction; dispatch posts nothing, which is why cancelling a dispatched transfer needs no compensating entry.';
COMMENT ON COLUMN stock_transfer.status IS
  '`received` is a SINK on purpose. Its lack of an outgoing edge is what makes receiveStockTransfer idempotent — a duplicate receive re-reads this column under the row lock and fails closed before posting again. Adding an "un-receive" edge without a compensating reversal posting would allow double-movement of stock.';
COMMENT ON COLUMN stock_transfer.initiated_by IS
  'Who raised the transfer (spec §6.3 names this field explicitly). Distinct from created_by, which is the audit-trail author: they coincide today but the spec treats initiator as business data, not provenance.';

CREATE UNIQUE INDEX stock_transfer_no_unique ON stock_transfer(transfer_no)
  WHERE deleted_at IS NULL;
CREATE INDEX stock_transfer_status_idx ON stock_transfer(status) WHERE deleted_at IS NULL;
CREATE INDEX stock_transfer_from_idx ON stock_transfer(from_location_id) WHERE deleted_at IS NULL;
CREATE INDEX stock_transfer_to_idx ON stock_transfer(to_location_id) WHERE deleted_at IS NULL;

-- ── stock_transfer_line ────────────────────────────────────────────────────
CREATE TABLE stock_transfer_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_transfer_id  uuid NOT NULL REFERENCES stock_transfer(id),
  line_no            integer NOT NULL,
  component_type_id  uuid REFERENCES component_type(id),  -- batch line: the type moved
  qty                numeric(14,3),                        -- batch line: how much
  component_unit_id  uuid REFERENCES component_unit(id),   -- serialized line: which unit
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES app_user(id),
  -- The either/or is a CONSTRAINT, not a convention: a line is EITHER a
  -- quantity of a batch component type OR one specific serialized unit, never
  -- both and never neither. A half-populated line would post silently wrong.
  CONSTRAINT stock_transfer_line_batch_or_unit CHECK (
    (component_unit_id IS NOT NULL AND component_type_id IS NULL AND qty IS NULL)
    OR
    (component_unit_id IS NULL AND component_type_id IS NOT NULL AND qty IS NOT NULL AND qty > 0)
  )
);
COMMENT ON TABLE stock_transfer_line IS
  'Transfer line items, written once as part of the transfer-create transaction and never edited afterward (mirrors delivery_order_line) — hence created_at/created_by only. A line is EITHER (component_type_id + qty) for a batch part OR component_unit_id for a serialized part; stock_transfer_line_batch_or_unit enforces it.';
CREATE UNIQUE INDEX stock_transfer_line_no_unique
  ON stock_transfer_line(stock_transfer_id, line_no);
CREATE INDEX stock_transfer_line_transfer_idx ON stock_transfer_line(stock_transfer_id);
CREATE INDEX stock_transfer_line_unit_idx ON stock_transfer_line(component_unit_id)
  WHERE component_unit_id IS NOT NULL;

-- ── Carried finding from the L1 slice: delivery_order_line had no (do, line_no)
--    uniqueness, so a retried create could interleave duplicate line numbers.
--    Cheap to close here while we are in the module. ────────────────────────
CREATE UNIQUE INDEX delivery_order_line_no_unique
  ON delivery_order_line(delivery_order_id, line_no);

-- Audit on the mutable tables. stock_transfer_line is excluded for the same
-- reason delivery_order_line is: insert-once, no update path.
-- stock_level IS audited — a balance change is exactly the event worth trailing.
SELECT fn_attach_audit(t) FROM unnest(ARRAY['stock_level','stock_transfer']) AS t;

-- RLS deny-via-REST (R1 pattern, 20260720000000_platform_rls.sql): app reaches
-- these only via the owner pool / service_role; no anon/authenticated policy =
-- PostgREST denies all. NOT FORCE (would also gate the owner connection and
-- fn_audit's SECURITY DEFINER writes).
ALTER TABLE stock_level          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_line  ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION fn_stock_level_batch_only() FROM PUBLIC, anon, authenticated;
