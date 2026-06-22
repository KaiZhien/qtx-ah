-- Device table — six column groups mirroring the PCBA_Traceability.xlsx "Traceability" sheet
-- Serial fields are TEXT and may hold ranges/lists verbatim. qty holds the count.
CREATE TABLE device (
  -- System columns
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES app_user(id),
  deleted_at  timestamptz,        -- soft-delete: set to now(), never hard-delete
  version     integer NOT NULL DEFAULT 1,  -- optimistic concurrency

  -- Group 1: Device Info · 设备信息
  device_sn     text,              -- may be blank; unique when present (partial index below)
  product_name  text,
  model_no      text,

  -- Group 2: PCBA-A · 电源板 Amplifier Board
  pcba_a_sn      text NOT NULL,   -- de-facto identity; may hold range/list as text
  pcba_a_hw_rev  text NOT NULL,
  pcba_a_bom_rev text NOT NULL,
  pcba_a_fw_ver  text NOT NULL,

  -- Group 3: PCBA-B · 控制板 Accessory Board
  pcba_b_sn      text,
  pcba_b_hw_rev  text,
  pcba_b_bom_rev text,
  pcba_b_fw_ver  text,            -- may contain notes e.g. "No wifi version"

  -- Group 4: HMI Screen · 触摸屏
  screen_model text,
  hmi_ver      text,              -- free text; may mix version + config description

  -- Group 5: Shipment Info · 出货信息
  build_date  date,
  ship_date   date,
  qty         integer,
  destination text,
  customer    text,

  -- Group 6: Status & Notes · 状态
  status  text NOT NULL REFERENCES status_option(code),
  phase   text NOT NULL REFERENCES phase_option(code),
  remarks text,                   -- free text; preserves multiline notes/Chinese verbatim

  -- Normalized search columns (maintained by fn_device_touch trigger)
  device_sn_normalized  text,
  pcba_a_sn_normalized  text NOT NULL DEFAULT '',
  pcba_b_sn_normalized  text
);

COMMENT ON TABLE device IS
  'System of record for hardware device builds. Mirrors the six column groups of PCBA_Traceability.xlsx. Never hard-deleted (use deleted_at).';
COMMENT ON COLUMN device.pcba_a_sn IS
  'De-facto device identity today. May hold a range or list as text (e.g. "EE-02A-2603-0001 to 0015"). Normalized copy in pcba_a_sn_normalized.';
COMMENT ON COLUMN device.device_sn IS
  'Intended primary key; currently often blank. Unique when present (partial index). Normalized copy in device_sn_normalized.';
COMMENT ON COLUMN device.version IS
  'Optimistic concurrency counter. Incremented by fn_device_touch on every UPDATE.';
COMMENT ON COLUMN device.deleted_at IS
  'Soft-delete timestamp. NULL = active. Set to now() to soft-delete; never hard-delete.';
COMMENT ON COLUMN device.remarks IS
  'Free text. Multiline notes and Chinese characters preserved verbatim. Never truncated.';

-- Partial unique index: device_sn is unique only when present and not soft-deleted
CREATE UNIQUE INDEX device_device_sn_unique
  ON device(device_sn)
  WHERE device_sn IS NOT NULL AND deleted_at IS NULL;

-- Search indexes
CREATE INDEX device_pcba_a_sn_normalized_idx ON device(pcba_a_sn_normalized);
CREATE INDEX device_pcba_b_sn_normalized_idx ON device(pcba_b_sn_normalized);
CREATE INDEX device_device_sn_normalized_idx ON device(device_sn_normalized);
CREATE INDEX device_customer_idx ON device(customer);
CREATE INDEX device_status_idx ON device(status);
CREATE INDEX device_phase_idx ON device(phase);
CREATE INDEX device_deleted_at_idx ON device(deleted_at);
CREATE INDEX device_created_at_idx ON device(created_at DESC);
