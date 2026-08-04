/**
 * WHAT THE FULL-SYSTEM EXPORT CONTAINS (spec §12, D36).
 *
 * "One CSV per major entity … + JSON for nested/history sets". The split is not
 * arbitrary: CSV is what an analyst opens, and JSON is what survives a `jsonb`
 * column or a set whose rows are only meaningful in order. `audit_log.old_values`
 * / `new_values` and `import_row.raw` / `parsed` are jsonb; flattening them into a
 * CSV cell would produce a quoted blob that no spreadsheet can use and that
 * cannot be parsed back reliably. So those sets ship as JSON.
 *
 * SENSITIVE FIELDS ARE INCLUDED. Spec §12 is explicit and CONFIRMED: "sensitive
 * fields included, because the requester ceremony is the control, not field
 * redaction". Buyer contacts, invoice totals and user emails are all here. The
 * gate is `request_full_export` + Super Admin + fresh MFA, not a redaction list.
 *
 * COLUMNS ARE ENUMERATED, NEVER `SELECT *`. Three reasons, and the third is the
 * one that matters: a `SELECT *` export silently changes shape when any module
 * adds a column, so the manifest's schema contract drifts without anybody
 * deciding to change it; column order becomes whatever the catalog says; and a
 * future column holding something genuinely unexportable would ship by default
 * rather than by choice.
 *
 * `id` FIRST, EVERYWHERE. The UUIDs are the join keys relationships.md documents,
 * and spec §12 chose CSV+JSON over a SQL dump precisely so those joins stay
 * usable — a dump is not analyst-readable, and a single flat CSV loses the
 * relations entirely.
 */

export type ExportEntity = {
  /** Table name; also the file stem. */
  table: string
  format: 'csv' | 'json'
  columns: readonly string[]
  /** Stable ordering, so two exports of unchanged data are byte-identical. */
  orderBy: string
  /** Excludes soft-deleted rows unless the set IS the historical record. */
  liveOnly: boolean
  description: string
  /**
   * A schema change landing on another branch that this entry must be updated for
   * BEFORE the export is trusted. Surfaced by a unit test so it cannot be merged
   * unnoticed — a silently-wrong export is the worst kind, because manifest.json
   * makes its row count look deliberate.
   */
  pendingSchemaChange?: string
}

const AUDIT_COLS = ['created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'version']

export const EXPORT_ENTITIES: readonly ExportEntity[] = [
  // ── Identity & access ─────────────────────────────────────────────────────
  {
    table: 'app_user', format: 'csv',
    columns: ['id', 'email', 'full_name', 'role_id', 'department', 'module_access',
      'user_kind', 'active', 'mfa_enrolled', 'invited_at', 'last_login_at', ...AUDIT_COLS],
    orderBy: 'email', liveOnly: false,
    description: 'People. Soft-deleted rows are INCLUDED because audit rows still '
      + 'attribute to them — dropping them would orphan the trail.',
  },
  {
    table: 'role', format: 'csv',
    columns: ['id', 'key', 'name', 'description', 'is_system', 'sort', ...AUDIT_COLS],
    orderBy: 'sort, key', liveOnly: false,
    description: 'The six roles.',
  },
  {
    table: 'permission', format: 'csv',
    columns: ['id', 'key', 'name', 'description', 'sort'],
    orderBy: 'sort, key', liveOnly: false,
    description: 'The permission vocabulary. Reference data — deliberately has no '
      + 'created_*/updated_*/deleted_at/version columns (see its table comment).',
  },
  {
    table: 'role_permission', format: 'csv',
    columns: ['id', 'role_id', 'permission_id', ...AUDIT_COLS],
    orderBy: 'role_id, permission_id', liveOnly: false,
    description: 'The role×permission grant matrix — the most security-sensitive '
      + 'table in the system, and the one an auditor reads first.',
  },
  {
    table: 'user_permission_override', format: 'csv',
    columns: ['id', 'user_id', 'permission_id', 'granted', 'reason', 'expires_at',
      ...AUDIT_COLS],
    orderBy: 'user_id', liveOnly: false,
    description: 'Per-user exceptions to the matrix. `granted` true = an extra '
      + 'grant, false = a revoke of a role permission.',
  },

  // ── Manufacturing ─────────────────────────────────────────────────────────
  {
    table: 'device', format: 'csv',
    columns: ['id', 'device_sn', 'pcba_a_sn_legacy', 'variant_id', 'status', 'phase',
      'product_name', 'model_no', 'customer', 'buyer_id', 'destination', 'remarks',
      'build_date', 'ship_date', 'delivered_date', 'needs_data_review', ...AUDIT_COLS],
    orderBy: 'device_sn NULLS LAST, id', liveOnly: false,
    description: 'The device registry — the hub every other module references.',
  },
  {
    table: 'device_variant', format: 'csv',
    columns: ['id', 'code', 'name', 'active', 'created_at'],
    orderBy: 'code', liveOnly: false, description: 'Device variants.',
  },
  {
    table: 'status_option', format: 'csv',
    columns: ['code', 'label_en', 'label_zh', 'is_initial', 'is_terminal', 'sort_order',
      'active', 'updated_by'],
    orderBy: 'sort_order', liveOnly: false,
    description: 'The admin-editable device status vocabulary. Exported because '
      + 'device.status is a CODE — without this table the codes are unreadable, and '
      + 'the live codes have drifted from the seed (In Stock / Under Repair / Shipped). '
      + '`code` is the primary key; this table has no `id`.',
  },
  {
    table: 'phase_option', format: 'csv',
    columns: ['code', 'label_en', 'label_zh', 'is_initial', 'is_terminal', 'sort_order',
      'active', 'updated_by'],
    orderBy: 'sort_order', liveOnly: false,
    description: 'Legacy manufacturing phase vocabulary — device.phase references it.',
  },
  {
    table: 'status_transition', format: 'csv',
    columns: ['from_status', 'to_status', 'requires_reason', 'task_template_key',
      'notify_roles'],
    orderBy: 'from_status, to_status', liveOnly: false,
    description: 'The fail-closed status graph: no row = forbidden move. Composite '
      + 'primary key (from_status, to_status) — this table has no `id`.',
  },
  {
    table: 'device_status_history', format: 'json',
    columns: ['id', 'device_id', 'from_status', 'to_status', 'reason', 'changed_by', 'changed_at'],
    orderBy: 'device_id, changed_at', liveOnly: false,
    description: 'Append-only device status log. JSON: a history set (spec §12).',
  },
  {
    table: 'component_type', format: 'csv',
    columns: ['id', 'code', 'name', 'tracking_mode', 'requires_firmware', 'active', 'sort',
      ...AUDIT_COLS],
    orderBy: 'sort, code', liveOnly: false,
    description: 'Component catalogue. `tracking_mode` splits serialized parts (one '
      + 'component_unit per physical unit) from batch parts (no unit row).',
  },
  {
    table: 'component_unit', format: 'csv',
    columns: ['id', 'component_type_id', 'serial_no', 'hw_rev', 'bom_rev', 'fw_ver',
      'firmware_release_id', 'supplier', 'manufacturer', 'manufactured_on', 'batch_no',
      'cost_sgd', 'condition', 'location_id', 'disposition', 'needs_split', ...AUDIT_COLS],
    orderBy: 'serial_no', liveOnly: false, description: 'Serialized component units.',
  },
  {
    table: 'component_installation', format: 'json',
    columns: ['id', 'device_id', 'component_type_id', 'component_unit_id', 'batch_no',
      'slot_no', 'installed_at', 'installed_by', 'removed_at', 'removed_by',
      'removal_reason', 'repair_id', 'modification_id', 'notes',
      'created_at', 'created_by'],
    orderBy: 'device_id, installed_at', liveOnly: false,
    description: 'Append-only installation history — spec §12 names installations as '
      + 'a JSON set explicitly. Current components are the rows with removed_at NULL; '
      + 'repair_id/modification_id attribute each swap to what caused it.',
  },
  {
    table: 'variant_bom_line', format: 'csv',
    columns: ['id', 'variant_id', 'component_type_id', 'quantity', 'notes', ...AUDIT_COLS],
    orderBy: 'variant_id, component_type_id', liveOnly: false,
    description: 'Flat per-variant bill of materials — one line per component type, '
      + 'with quantity. No nested sub-assemblies (spec D17).',
    pendingSchemaChange:
      'agent ENGINEERING adds BOM EFFECTIVITY to this table: effective_from_date, '
      + 'effective_to_date, effective_from_serial, effective_to_serial, '
      + 'created_by_eco_id, superseded_by_eco_id — and DROPS '
      + 'UNIQUE(variant_id, component_type_id) for a PARTIAL unique index over only '
      + 'the still-open line. '
      + 'CONSEQUENCE FOR THIS EXPORT: the table stops holding one row per '
      + '(variant, component type) and starts holding SUPERSEDED HISTORY TOO, so this '
      + 'CSV silently grows without anything looking wrong — and manifest.json will '
      + 'report the inflated count as though it were intended, which is precisely what '
      + 'makes it hard to catch. '
      + 'ACTION AT INTEGRATION, pick one deliberately: (a) keep exporting every row '
      + 'and add the six columns above so the history is READABLE rather than merely '
      + 'present — the honest choice for a full-system export, whose job is fidelity; '
      + 'or (b) restrict to the open line with '
      + '`WHERE effective_to_date IS NULL AND effective_to_serial IS NULL`. '
      + 'Do NOT leave it as-is: today\'s column list would export history rows while '
      + 'omitting the very columns that say they are history.',
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    table: 'task', format: 'csv',
    columns: ['id', 'title', 'description', 'status', 'priority', 'due_date', 'assignee_id',
      'department', 'confidential', 'blocked_reason', 'parent_task_id', 'completed_at',
      ...AUDIT_COLS],
    orderBy: 'created_at', liveOnly: false,
    description: 'Tasks. CONFIDENTIAL TASKS ARE INCLUDED — see this module header '
      + 'and spec §12: the requester ceremony is the control, not redaction.',
  },
  {
    table: 'task_link', format: 'csv',
    columns: ['id', 'task_id', 'entity_type', 'entity_id', 'module'],
    orderBy: 'task_id', liveOnly: false, description: 'Task → record links.',
  },
  {
    table: 'task_comment', format: 'json',
    columns: ['id', 'task_id', 'body', 'created_at', 'created_by', 'edited_at'],
    orderBy: 'task_id, created_at', liveOnly: false,
    description: 'Append-only task discussion. JSON: order is meaning.',
  },

  // ── Engineering ───────────────────────────────────────────────────────────
  {
    table: 'ecr', format: 'csv',
    columns: ['id', 'ecr_no', 'title', 'description', 'reason', 'priority', 'status',
      'device_id', 'variant_id', ...AUDIT_COLS],
    orderBy: 'ecr_no', liveOnly: false, description: 'Engineering change requests.',
  },
  {
    table: 'eco', format: 'csv',
    columns: ['id', 'eco_no', 'title', 'description', 'ecr_id', 'status',
      'effectivity_date', 'effectivity_serial', 'effectivity_notes', ...AUDIT_COLS],
    orderBy: 'eco_no', liveOnly: false, description: 'Engineering change orders.',
  },
  {
    table: 'firmware_release', format: 'csv',
    columns: ['id', 'component_type_id', 'fw_version', 'release_date', 'changelog',
      'status', ...AUDIT_COLS],
    orderBy: 'component_type_id, fw_version', liveOnly: false,
    description: 'Firmware releases. fw_version is the firmware string; `version` '
      + 'is the optimistic-lock counter.',
  },

  // ── Maintenance ───────────────────────────────────────────────────────────
  {
    table: 'repair', format: 'csv',
    columns: ['id', 'repair_no', 'device_id', 'status', 'fault_description', 'diagnosis',
      'corrective_action', 'testing_notes', 'parts_replaced', 'warranty_flag',
      'warranty_justification', 'cost_sgd', 'reported_by', 'assigned_to', 'signed_off_by',
      'signed_off_at', 'opened_at', 'closed_at', ...AUDIT_COLS],
    orderBy: 'repair_no', liveOnly: false, description: 'Repairs.',
  },
  {
    table: 'repair_status_history', format: 'json',
    columns: ['id', 'repair_id', 'from_status', 'to_status', 'note', 'changed_by', 'changed_at'],
    orderBy: 'repair_id, changed_at', liveOnly: false,
    description: 'Append-only repair status log.',
  },
  {
    table: 'modification_type', format: 'csv',
    columns: ['id', 'code', 'name', 'active', 'sort', ...AUDIT_COLS],
    orderBy: 'sort, code', liveOnly: false,
    description: 'Admin-extensible modification type vocabulary.',
  },
  {
    table: 'modification', format: 'csv',
    columns: ['id', 'modification_no', 'device_id', 'modification_type_id', 'status',
      'requested_on', 'completed_on', 'requested_by', 'approved_by', 'completed_by',
      'reason', 'description', 'previous_configuration', 'new_configuration',
      'eco_id', 'repair_id', 'cost_sgd', 'signed_off_by', 'signed_off_at', 'closed_at',
      ...AUDIT_COLS],
    orderBy: 'modification_no', liveOnly: false, description: 'Device modifications.',
  },
  {
    table: 'modification_status_history', format: 'json',
    columns: ['id', 'modification_id', 'from_status', 'to_status', 'note',
      'changed_by', 'changed_at'],
    orderBy: 'modification_id, changed_at', liveOnly: false,
    description: 'Append-only modification status log.',
  },

  // ── Finance ───────────────────────────────────────────────────────────────
  {
    table: 'buyer', format: 'csv',
    columns: ['id', 'name', 'country', 'contact_name', 'contact_email', 'contact_phone',
      'billing_address', 'notes', ...AUDIT_COLS],
    orderBy: 'name', liveOnly: false, description: 'Buyers. Contact details included.',
  },
  {
    table: 'sales_invoice', format: 'csv',
    columns: ['id', 'invoice_no', 'buyer_id', 'status', 'issue_date', 'due_date', 'currency',
      'subtotal_sgd', 'tax_sgd', 'total_sgd', 'notes', ...AUDIT_COLS],
    orderBy: 'invoice_no', liveOnly: false, description: 'Sales invoices.',
  },
  {
    table: 'sales_invoice_line', format: 'csv',
    columns: ['id', 'invoice_id', 'line_no', 'description', 'quantity', 'unit_price_sgd',
      'amount_sgd', 'device_id', 'created_at', 'created_by'],
    orderBy: 'invoice_id, line_no', liveOnly: false, description: 'Invoice lines.',
  },

  // ── Logistics ─────────────────────────────────────────────────────────────
  {
    table: 'stock_location', format: 'csv',
    columns: ['id', 'code', 'name', 'country', 'address', 'notes', 'active', ...AUDIT_COLS],
    orderBy: 'code', liveOnly: false, description: 'Stock locations.',
  },
  {
    table: 'delivery_order', format: 'csv',
    columns: ['id', 'do_no', 'status', 'customer', 'destination', 'ship_date',
      'delivered_date', 'pod_reference', 'pod_received_at', 'import_export_ref',
      'carrier', 'notes', ...AUDIT_COLS],
    orderBy: 'do_no', liveOnly: false, description: 'Delivery orders.',
  },
  {
    table: 'delivery_order_line', format: 'csv',
    columns: ['id', 'delivery_order_id', 'line_no', 'device_id', 'description', 'quantity',
      'created_at', 'created_by'],
    orderBy: 'delivery_order_id, line_no', liveOnly: false, description: 'DO lines.',
  },

  // ── Cross-module ──────────────────────────────────────────────────────────
  {
    table: 'approval', format: 'json',
    columns: ['id', 'entity_type', 'entity_id', 'module', 'kind', 'status', 'snapshot',
      'requested_by', 'decided_by', 'decided_at', 'decision_note', ...AUDIT_COLS],
    orderBy: 'created_at', liveOnly: false,
    description: 'Approval requests. JSON because `snapshot` is jsonb and IS the '
      + 'record — an approval authorises a specific state, not an entity id.',
  },
  {
    table: 'app_setting', format: 'csv',
    columns: ['key', 'value', 'created_at', 'created_by', 'updated_at', 'updated_by',
      'version'],
    orderBy: 'key', liveOnly: false,
    description: 'Runtime knobs (finance_approval_threshold_sgd, export_retention_days). '
      + '`key` is the primary key; the table has no `id` and no `deleted_at` by design.',
  },
  {
    table: 'import_batch', format: 'csv',
    columns: ['id', 'source_filename', 'source_sha256', 'source_kind', 'default_variant_id',
      'status', 'row_count', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'],
    orderBy: 'created_at', liveOnly: false, description: 'Bulk import batches.',
  },
  {
    table: 'outbox', format: 'json',
    columns: ['id', 'aggregate_type', 'aggregate_id', 'event_type', 'payload', 'occurred_at',
      'processed_at', 'attempts', 'last_error', 'created_by'],
    orderBy: 'occurred_at', liveOnly: false,
    description: 'Transactional outbox. JSON: `payload` is jsonb.',
  },
  {
    table: 'audit_log', format: 'json',
    columns: ['id', 'table_name', 'row_id', 'action', 'actor_id', 'old_values', 'new_values',
      'changed_columns', 'reason', 'session_id', 'occurred_at'],
    orderBy: 'occurred_at', liveOnly: false,
    description: 'The audit extract — spec §12 names it as a JSON set. `old_values`/'
      + '`new_values` are jsonb. `ip_address` is omitted: it is an inet and adds '
      + 'personal data the export does not need to be useful.',
  },
  {
    table: 'auth_event', format: 'json',
    columns: ['id', 'user_id', 'email', 'event_type', 'detail', 'occurred_at'],
    orderBy: 'occurred_at', liveOnly: false,
    description: 'Security events. `ip_address`/`user_agent` omitted for the same '
      + 'reason as audit_log.ip_address.',
  },
]

/** Parts of the spec §12 export tree this build deliberately does not produce. */
export const DEFERRED_EXPORT_PARTS: readonly string[] = [
  'attachments/ — blocked on file storage. Spec §10 wants S3 presigned uploads and '
    + 'there is no AWS account (PROGRESS item 6), so no attachment exists to export. '
    + 'The tree is absent rather than empty so it cannot be mistaken for "no files".',
  '7z AES-256 encryption with a separately-delivered passphrase — deferred with the '
    + 'S3 delivery path. This build ships a plain ZIP over an authenticated download.',
  's3://qtx-ops-exports/{job}/ with a day-7 lifecycle delete — deferred (no AWS). '
    + 'The export is built synchronously and streamed to the requester instead.',
  'Resumable per-entity builds and the "all Super Admins notified" fan-out — both '
    + 'belong to the worker/notification path that does not exist yet.',
]
