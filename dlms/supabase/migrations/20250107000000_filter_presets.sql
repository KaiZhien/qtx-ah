CREATE TABLE device_filter_preset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  query_string text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON device_filter_preset(owner_id, created_at DESC);

ALTER TABLE device_filter_preset ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all" ON device_filter_preset
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
