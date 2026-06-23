-- Subscribers who receive the weekly analytics digest
CREATE TABLE IF NOT EXISTS report_subscriber (
  id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email      text        NOT NULL UNIQUE,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only admins can manage subscribers
ALTER TABLE report_subscriber ENABLE ROW LEVEL SECURITY;

CREATE POLICY "report_subscriber_admin_all"
  ON report_subscriber
  FOR ALL
  TO authenticated
  USING (auth_user_role() = 'admin')
  WITH CHECK (auth_user_role() = 'admin');

-- Service role can read (for Edge Function)
CREATE POLICY "report_subscriber_service_read"
  ON report_subscriber
  FOR SELECT
  TO service_role
  USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON report_subscriber TO authenticated;
GRANT SELECT ON report_subscriber TO service_role;
