-- ============================================================
-- DLMS Seed Data
-- Run via: npx supabase db seed  (or psql on supabase start)
-- Idempotent: safe to run multiple times
-- ============================================================

-- -----------------------------------------------
-- 1. Auth users (Supabase auth schema)
-- -----------------------------------------------
DO $$
BEGIN
  -- GoTrue requires empty string (not NULL) for token columns.
  -- Admin
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'admin@demo.quantumtx.com') THEN
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) VALUES (
      'aaaaaaaa-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      'admin@demo.quantumtx.com',
      crypt('demo1234', gen_salt('bf')),
      NOW(), NOW(), NOW(),
      '{"provider":"email","providers":["email"]}',
      '{}', false,
      '', '', '', ''
    );
  END IF;

  -- Engineer
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'engineer@demo.quantumtx.com') THEN
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) VALUES (
      'bbbbbbbb-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      'engineer@demo.quantumtx.com',
      crypt('demo1234', gen_salt('bf')),
      NOW(), NOW(), NOW(),
      '{"provider":"email","providers":["email"]}',
      '{}', false,
      '', '', '', ''
    );
  END IF;

  -- Viewer
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'viewer@demo.quantumtx.com') THEN
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) VALUES (
      'cccccccc-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      'viewer@demo.quantumtx.com',
      crypt('demo1234', gen_salt('bf')),
      NOW(), NOW(), NOW(),
      '{"provider":"email","providers":["email"]}',
      '{}', false,
      '', '', '', ''
    );
  END IF;
END $$;

-- -----------------------------------------------
-- 2. App users
-- -----------------------------------------------
INSERT INTO app_user (id, email, role, active) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@demo.quantumtx.com',    'admin',    true),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'engineer@demo.quantumtx.com', 'engineer', true),
  ('cccccccc-0000-0000-0000-000000000003', 'viewer@demo.quantumtx.com',   'viewer',   true)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------
-- 3. Vocabularies
-- -----------------------------------------------
INSERT INTO status_option (code, label_en, label_zh, sort_order, active) VALUES
  ('Stock',   'In Stock',     '库存',   1, true),
  ('In Use',  'In Use',       '使用中', 2, true),
  ('Repair',  'Under Repair', '维修中', 3, true),
  ('Retired', 'Retired',      '退役',  4, true),
  ('Lost',    'Lost',         '丢失',  5, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO phase_option (code, label_en, label_zh, sort_order, active) VALUES
  ('Production', 'Production', '量产',   1, true),
  ('Validation', 'Validation', '验证',   2, true),
  ('Rework',     'Rework',     '返工',   3, true),
  ('Pilot',      'Pilot',      '试点',   4, true),
  ('EOL',        'End of Life','停产',   5, true)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------
-- 4. Devices — 6 real rows from PRD §11
-- -----------------------------------------------
-- NOTE: The DB trigger fn_device_touch() runs on INSERT and will:
--   - Normalize serials (uppercase/trim)
--   - Set version = 1
--   - Set updated_at
-- The trigger reads app.actor_id for audit, which won't be set from seed.
-- Audit log rows will be created with null actor (acceptable for seed data).

-- Disable trigger temporarily for seed? No — let it run. version starts at 0, trigger increments to 1.

-- Set actor for audit trail
SET LOCAL app.actor_id = 'aaaaaaaa-0000-0000-0000-000000000001';

INSERT INTO device (
  id, device_sn, product_name, model_no,
  pcba_a_sn, pcba_a_hw_rev, pcba_a_bom_rev, pcba_a_fw_ver,
  pcba_b_sn, pcba_b_hw_rev, pcba_b_bom_rev, pcba_b_fw_ver,
  screen_model, hmi_ver,
  build_date, ship_date, qty, destination, customer,
  status, phase, remarks,
  created_by, updated_by
) VALUES
-- Row 1: QTX-A001
(
  gen_random_uuid(), 'QTX-A001', 'QuantumTX Pro', 'QTX-PRO-V1',
  'PA-2024-001', 'v2.1', 'B-2024-003', '2.1.4',
  'PB-2024-001', 'v1.3', 'B-2024-002', '1.3.0',
  'SH-7INCH-V2', 'HMI-3.1.2',
  '2024-03-15', '2024-03-28', 1, 'Singapore', 'Hospital A',
  'Stock', 'Production', NULL,
  'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001'
),
-- Row 2: QTX-A002
(
  gen_random_uuid(), 'QTX-A002', 'QuantumTX Pro', 'QTX-PRO-V1',
  'PA-2024-002', 'v2.1', 'B-2024-003', '2.1.4',
  'PB-2024-002', 'v1.3', 'B-2024-002', '1.3.0',
  'SH-7INCH-V2', 'HMI-3.1.2',
  '2024-03-15', '2024-04-01', 1, 'Malaysia', 'Clinic B',
  'In Use', 'Production', '已部署到诊所B',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001'
),
-- Row 3: QTX-A003 (range)
(
  gen_random_uuid(), 'QTX-A003~QTX-A012', 'QuantumTX Lite', 'QTX-LITE-V1',
  'PA-2024-003~PA-2024-012', 'v2.0', 'B-2024-001', '2.0.8',
  NULL, NULL, NULL, NULL,
  'SH-5INCH-V1', 'HMI-2.8.0',
  '2024-01-20', '2024-02-10', 10, 'China', 'Hospital C',
  'In Use', 'Pilot', 'Batch pilot deployment — 10 units',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001'
),
-- Row 4: Under Repair
(
  gen_random_uuid(), 'QTX-B001', 'QuantumTX Pro', 'QTX-PRO-V2',
  'PA-2024-020', 'v2.2', 'B-2024-004', '2.2.1',
  'PB-2024-015', 'v1.4', 'B-2024-003', '1.4.2',
  'SH-7INCH-V3', 'HMI-3.2.0',
  '2024-05-10', '2024-05-25', 1, 'Japan', 'Medical Center D',
  'Repair', 'Validation', 'PCBA-B故障，等待更换',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000002'
),
-- Row 5: Validation batch
(
  gen_random_uuid(), NULL, 'QuantumTX Dev Kit', 'QTX-DEV-V1',
  'PA-DEV-001', 'v1.0-dev', 'B-DEV-001', '2.3.0-beta',
  'PB-DEV-001', 'v1.0-dev', 'B-DEV-001', '1.5.0-beta',
  NULL, NULL,
  '2024-06-01', NULL, 3, 'Internal', 'QuantumTX R&D',
  'In Use', 'Validation', 'Internal validation — 3 dev kits',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001'
),
-- Row 6: Retired
(
  gen_random_uuid(), 'QTX-A000', 'QuantumTX V1 (Legacy)', 'QTX-V1',
  'PA-2023-001', 'v1.0', 'B-2023-001', '1.0.0',
  NULL, NULL, NULL, NULL,
  NULL, NULL,
  '2023-06-15', '2023-07-01', 1, 'Taiwan', 'Demo Site',
  'Retired', 'EOL', 'First production unit — now retired',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001'
)
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- 5. Additional mock devices (~44 more rows)
-- -----------------------------------------------
DO $$
DECLARE
  customers TEXT[] := ARRAY['Hospital A', 'Hospital C', 'Clinic B', 'Medical Center D', 'QuantumTX R&D', 'Distributor SG', 'NUH', 'SGH', 'KKH', 'TTSH'];
  destinations TEXT[] := ARRAY['Singapore', 'Malaysia', 'Japan', 'China', 'Taiwan', 'South Korea', 'Internal', 'Germany', 'USA'];
  statuses TEXT[] := ARRAY['Stock', 'In Use', 'Repair', 'Retired'];
  phases TEXT[] := ARRAY['Production', 'Validation', 'Pilot', 'Rework'];
  models TEXT[] := ARRAY['QTX-PRO-V1', 'QTX-PRO-V2', 'QTX-LITE-V1', 'QTX-DEV-V1'];
  i INTEGER;
  seq TEXT;
  build_d DATE;
  ship_d DATE;
BEGIN
  FOR i IN 1..44 LOOP
    seq := LPAD(i::TEXT, 3, '0');
    build_d := ('2024-01-01'::DATE + (i * 5 || ' days')::INTERVAL)::DATE;
    ship_d := build_d + ((i % 14 + 7) || ' days')::INTERVAL;
    INSERT INTO device (
      id, device_sn, product_name, model_no,
      pcba_a_sn, pcba_a_hw_rev, pcba_a_bom_rev, pcba_a_fw_ver,
      pcba_b_sn, pcba_b_hw_rev, pcba_b_bom_rev, pcba_b_fw_ver,
      screen_model, hmi_ver,
      build_date, ship_date, qty, destination, customer,
      status, phase, remarks,
      created_by, updated_by
    ) VALUES (
      gen_random_uuid(),
      'QTX-M' || seq,
      'QuantumTX ' || models[1 + (i % array_length(models, 1))],
      models[1 + (i % array_length(models, 1))],
      'PA-M' || seq,
      'v' || (1 + i % 3)::TEXT || '.' || (i % 4)::TEXT,
      'B-M' || seq,
      (2 + i % 2)::TEXT || '.' || (i % 5)::TEXT || '.' || (i % 10)::TEXT,
      CASE WHEN i % 4 != 0 THEN 'PB-M' || seq ELSE NULL END,
      CASE WHEN i % 4 != 0 THEN 'v1.' || (i % 5)::TEXT ELSE NULL END,
      CASE WHEN i % 4 != 0 THEN 'B-PB-M' || seq ELSE NULL END,
      CASE WHEN i % 4 != 0 THEN '1.' || (i % 5)::TEXT || '.0' ELSE NULL END,
      CASE WHEN i % 3 != 0 THEN 'SH-7INCH-V' || (1 + i % 2)::TEXT ELSE NULL END,
      CASE WHEN i % 3 != 0 THEN 'HMI-3.' || (i % 3)::TEXT || '.0' ELSE NULL END,
      build_d,
      CASE WHEN i % 7 != 0 THEN ship_d ELSE NULL END,
      1 + (i % 5),
      destinations[1 + (i % array_length(destinations, 1))],
      customers[1 + (i % array_length(customers, 1))],
      statuses[1 + (i % array_length(statuses, 1))],
      phases[1 + (i % array_length(phases, 1))],
      CASE WHEN i % 8 = 0 THEN 'Mock device ' || i || ' — automated seed' ELSE NULL END,
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000001'
    ) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- -----------------------------------------------
-- 6. Extraction drafts (Phase 2 stubs)
-- -----------------------------------------------
INSERT INTO extracted_device_draft (
  id, source_file_path, source_file_hash, status, extracted_payload, extraction_model_version
) VALUES
(
  gen_random_uuid(),
  'uploads/invoices/INV-2024-0512.pdf',
  'sha256_mock_001',
  'pending_review',
  '{
    "schema_version": 1,
    "fields": {
      "pcba_a_sn": {"value": "PA-INV-001", "confidence": 0.95, "source_quote": "PCBA Board SN: PA-INV-001"},
      "pcba_a_hw_rev": {"value": "v2.1", "confidence": 0.88},
      "build_date": {"value": "2024-05-12", "confidence": 0.92, "source_quote": "Build Date: 12/05/2024"},
      "customer": {"value": "Hospital A", "confidence": 0.78, "source_quote": "Bill To: Hospital A"},
      "status": {"value": "Stock", "confidence": 0.70},
      "phase": {"value": "Production", "confidence": 0.85}
    }
  }'::jsonb,
  'gpt-4o-2024-08'
),
(
  gen_random_uuid(),
  'uploads/invoices/INV-2024-0601.pdf',
  'sha256_mock_002',
  'pending_review',
  '{
    "schema_version": 1,
    "fields": {
      "pcba_a_sn": {"value": "PA-INV-002", "confidence": 0.91},
      "pcba_a_hw_rev": {"value": "v2.2", "confidence": 0.80},
      "customer": {"value": "Clinic B", "confidence": 0.72, "source_quote": "Customer: Clinic B"},
      "qty": {"value": "2", "confidence": 0.99, "source_quote": "Quantity: 2"},
      "status": {"value": "Stock", "confidence": 0.65},
      "phase": {"value": "Validation", "confidence": 0.77}
    }
  }'::jsonb,
  'gpt-4o-2024-08'
),
(
  gen_random_uuid(),
  'uploads/shipping/SHP-2024-0815.pdf',
  'sha256_mock_003',
  'pending_review',
  '{
    "schema_version": 1,
    "fields": {
      "pcba_a_sn": {"value": "PA-SHP-010", "confidence": 0.97, "source_quote": "S/N: PA-SHP-010"},
      "device_sn": {"value": "QTX-SHP-010", "confidence": 0.93, "source_quote": "Device: QTX-SHP-010"},
      "customer": {"value": "Medical Center D", "confidence": 0.88},
      "destination": {"value": "Japan", "confidence": 0.95, "source_quote": "Ship To: Tokyo, Japan"},
      "ship_date": {"value": "2024-08-15", "confidence": 0.98},
      "status": {"value": "In Use", "confidence": 0.60},
      "phase": {"value": "Production", "confidence": 0.82}
    }
  }'::jsonb,
  'gpt-4o-2024-08'
),
(
  gen_random_uuid(),
  'uploads/invoices/INV-2024-0920.pdf',
  'sha256_mock_004',
  'pending_review',
  '{
    "schema_version": 1,
    "fields": {
      "pcba_a_sn": {"value": "PA-INV-030", "confidence": 0.88},
      "pcba_b_sn": {"value": "PB-INV-030", "confidence": 0.85},
      "model_no": {"value": "QTX-PRO-V2", "confidence": 0.91, "source_quote": "Model: QTX-PRO-V2"},
      "qty": {"value": "5", "confidence": 0.99},
      "destination": {"value": "Germany", "confidence": 0.87, "source_quote": "Destination: Hamburg, DE"},
      "status": {"value": "Stock", "confidence": 0.73},
      "phase": {"value": "Production", "confidence": 0.89}
    }
  }'::jsonb,
  'gpt-4o-2024-08'
)
ON CONFLICT (source_file_hash) DO NOTHING;
