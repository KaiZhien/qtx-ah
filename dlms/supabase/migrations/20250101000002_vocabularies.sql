-- Controlled vocabulary for device Status (§6.5)
-- Adding a value is a row INSERT — no migration needed.
CREATE TABLE status_option (
  code       text PRIMARY KEY,
  label_en   text NOT NULL,
  label_zh   text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);

-- Controlled vocabulary for device Phase (§6.5)
CREATE TABLE phase_option (
  code       text PRIMARY KEY,
  label_en   text NOT NULL,
  label_zh   text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE status_option IS
  'Controlled vocabulary for device Status. Admin-managed; adding a value requires no migration (§5.1.4).';
COMMENT ON TABLE phase_option IS
  'Controlled vocabulary for device Phase. Admin-managed; adding a value requires no migration (§5.1.4).';
