-- Warranty expiry: 2 years from ship_date, auto-computed, read-only
-- NULL when ship_date IS NULL (device not yet shipped)
ALTER TABLE device
  ADD COLUMN warranty_expiry date
  GENERATED ALWAYS AS ((ship_date + interval '2 years')::date) STORED;

-- Index for the daily expiry-window query
CREATE INDEX device_warranty_expiry_idx ON device (warranty_expiry);

-- Notification dedup table: records which devices have already had an email sent.
-- Lives SEPARATELY from device to avoid triggering fn_audit / fn_device_touch on every email run.
CREATE TABLE warranty_notification (
  device_id   uuid        PRIMARY KEY REFERENCES device (id),
  notified_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE warranty_notification ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (Edge Function uses service role)
CREATE POLICY warranty_notification_service_all ON warranty_notification
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT ON warranty_notification TO service_role;
