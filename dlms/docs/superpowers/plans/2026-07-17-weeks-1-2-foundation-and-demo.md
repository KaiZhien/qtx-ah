# QTX Ops Platform — Weeks 1–2: Foundation & July-31 Demo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 2026-07-31 demo — AWS-hosted platform shell with five module sections, a working Super Admin console, collaborative tasks, and the Manufacturing device registry reading migrated production data — on foundations (RBAC, transactions, audit, CI/CD) the remaining eight weeks build on without rework.

**Architecture:** The existing `dlms/` Next.js 14 app evolves in place. New platform code lands under `modules/` (per-module `domain/` pure logic + `services/`, plus `modules/shared/`); legacy DLMS code stays in `lib/` untouched until the week-3 port. A new dedicated Supabase project holds the platform schema. Reads use supabase-js under RLS (the proven DLMS topology); writes use a node-postgres pool so multi-table workflows are real transactions with a GUC-carried audit actor. Deployment moves to ECS Fargate in ap-southeast-1 via Terraform.

**Tech Stack:** Next.js 14.2 (App Router) · TypeScript 5.7 · Supabase (Postgres 15 + Auth) · `pg` 8 · Zod 3 · Vitest 4 · Tailwind 3 + Radix · Terraform 1.9 · Docker · GitHub Actions

## Global Constraints

These apply to every task. Values copied verbatim from `docs/superpowers/specs/2026-07-17-ops-platform-design.md`.

- **Working directory:** all commands run from `/Users/reetmitra/Desktop/QTX/quantumtx-ah/dlms` unless stated. The repo root is the parent (`quantumtx-ah`); `git` commands run from the parent.
- **Commit attribution:** every commit authored solely by Reet Mitra. **Never** add `Co-Authored-By:` or any co-author trailer.
- **Branching:** merge to `main` locally. No PRs, no long-lived branches.
- **TDD is mandatory:** write the failing test, watch it fail, implement minimally, watch it pass, commit.
- **Tests:** `npm test` (Vitest, `environment: node`, `globals: true`, alias `@` → dlms root). One file: `npx vitest run __tests__/foo.test.ts`. Types: `npm run type-check`.
- **Module names (exact, lowercase keys):** `engineering`, `finance`, `logistics`, `manufacturing`, `maintenance`, `tasks`, `admin`. User-facing labels are Title Case; **"Maintenance" is always singular**.
- **Role keys (exact):** `super_admin`, `admin`, `manager`, `operator`, `finance`, `viewer`.
- **Permission keys (exact, 24):** `view_records`, `create_records`, `edit_records`, `delete_records`, `restore_records`, `change_device_status`, `assign_tasks`, `approve_requests`, `sign_off_repairs`, `upload_files`, `download_files`, `export_data`, `import_data`, `view_finance`, `manage_finance`, `view_buyer_details`, `log_usage_service`, `view_audit_record`, `view_full_audit`, `manage_users`, `manage_roles_permissions`, `manage_vocabularies`, `manage_settings`, `request_full_export`.
- **Every table gets:** `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at` (soft-delete; never hard-delete), `version integer NOT NULL DEFAULT 1` (optimistic lock) — except append-only history tables, which omit `updated_*`/`deleted_at`/`version`.
- **Business keys are never primary keys.** Serial numbers, invoice numbers, and refs are unique-indexed columns.
- **Bilingual data:** free-text columns preserve EN/中文 verbatim. Never truncate, never normalize away non-ASCII.
- **Migrations:** authored in `supabase/migrations/NNNNNNNNNNNNNN_name.sql`. **Committing a migration file does nothing by itself** — it is applied to the cloud project separately via the Supabase MCP `apply_migration` or the CLI.
- **Region:** `ap-southeast-1`. **Infra budget:** US$100–250/mo total.
- **PHI/PII:** never commit real data. `data/` and `.env*` stay gitignored.

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/db/pool.ts` | node-postgres pool singleton (Supavisor connection) |
| `lib/db/tx.ts` | `withTransaction()` — BEGIN/COMMIT/ROLLBACK + `app.actor_id` GUC |
| `modules/shared/authz/policy.ts` | **Pure** `can(actor, permission, module)` — no I/O |
| `modules/shared/authz/catalog.ts` | Permission/module/role key constants + the §3.2 matrix as data |
| `modules/shared/authz/authorize.ts` | Throwing wrapper + `PermissionError` |
| `modules/shared/authz/actor.ts` | Loads `Actor` (role, resolved permissions, module access) from DB |
| `modules/shared/auth/session.ts` | Current user + MFA (AAL2) enforcement for privileged roles |
| `modules/shared/tasks/domain/taskStatus.ts` | **Pure** task status transitions + overdue computation |
| `modules/shared/tasks/domain/visibility.ts` | **Pure** task visibility rule (confidential + finance-link) |
| `modules/shared/tasks/services/taskService.ts` | Task CRUD, assignment, comments, links |
| `modules/admin/services/userService.ts` | User admin: invite, activate, role/module/override assignment |
| `modules/admin/services/roleService.ts` | Role → permission matrix editing |
| `modules/manufacturing/services/deviceReadService.ts` | Device list/detail reads (demo port) |
| `app/(platform)/layout.tsx` | Platform shell: nav, search slot, notification tray, user menu |
| `app/(platform)/{module}/page.tsx` | Five module section landings |
| `app/(platform)/admin/**` | Super Admin console |
| `app/(platform)/tasks/**` | Central task centre |
| `components/platform/**` | `ModuleNav`, `TaskPanel`, `EntityTable`, `ConfirmDestructive` |
| `supabase/migrations/2026071*` | Platform schema: RBAC, audit v2, tasks, devices |
| `infra/` | Terraform: `modules/`, `envs/staging`, `envs/prod` |
| `scripts/migrate_demo.ts` | One-way copy of prod DLMS data into the platform schema |
| `__tests__/platform/**` | Vitest unit + integration tests for the above |

**Decomposition note:** legacy `lib/services/*` and `lib/domain/*` are **not touched** in weeks 1–2. The week-3 port moves them into `modules/manufacturing/`. Task 13 reads devices through a thin new service rather than rewiring the old one — this keeps the demo honest without a half-finished port.

---

## Task sequence & parallelism

```
Task 1 (repo+env) ─┬─ Task 2 (RBAC schema) ─ Task 3 (authorize) ─┬─ Task 8, 9 (admin console)
                   ├─ Task 4 (pg pool + tx SPIKE) ───────────────┤
                   ├─ Task 5 (auth + MFA) ──────────────────────┬┴─ Task 10, 11, 12 (tasks)
                   └─ Task 6 (Terraform + CI/CD) ── independent  └─ Task 7 (shell) ─ Task 13 (devices)
                                                                     Task 14 (demo data) after 2
```

**Task 4 is the risk spike (spec R-4) — do it first if anything is behind.** Task 6 runs fully parallel to 2–5 and should be handed to a separate agent on day 1 (SES production access has multi-day lead time).

---

### Task 1: Platform scaffold, environment config, and the new Supabase project

**Files:**
- Create: `modules/shared/config/env.ts`
- Create: `.env.local.example` *(untracked — see step 4)*
- Modify: `package.json` (scripts + `pg` dependency)
- Modify: `vitest.config.ts` (unchanged aliases; add integration project)
- Create: `vitest.integration.config.ts`
- Create: `docker-compose.test.yml`
- Test: `__tests__/platform/env.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `loadEnv(): PlatformEnv` from `@/modules/shared/config/env`, where
    `type PlatformEnv = { supabaseUrl: string; supabaseAnonKey: string; supabaseServiceRoleKey: string; databaseUrl: string; appEnv: 'development' | 'staging' | 'production' }`.
  - Throws `EnvError` (exported) listing every missing key at once.

- [ ] **Step 1: Create the new Supabase project (manual, blocking)**

In the Supabase dashboard, create project **`qtx-ops-platform`**, region **Singapore (ap-southeast-1)**, plan **Pro** (PITR requires Pro). Record: project ref, anon key, service-role key, and the **Supavisor session-mode** connection string (port `5432` for migrations, `6543` transaction-mode for the app pool).

This is a real dependency for Tasks 2–5 — do it before anything else.

- [ ] **Step 2: Write the failing test**

```typescript
// __tests__/platform/env.test.ts
import { describe, it, expect } from 'vitest'
import { loadEnv, EnvError } from '@/modules/shared/config/env'

const VALID = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  DATABASE_URL: 'postgresql://u:p@host:6543/postgres',
  APP_ENV: 'staging',
}

describe('loadEnv', () => {
  it('returns a typed config from a complete environment', () => {
    expect(loadEnv(VALID)).toEqual({
      supabaseUrl: 'https://abc.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      databaseUrl: 'postgresql://u:p@host:6543/postgres',
      appEnv: 'staging',
    })
  })

  it('lists EVERY missing key in one error, not just the first', () => {
    const { DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ...partial } = VALID
    expect(() => loadEnv(partial)).toThrow(EnvError)
    try {
      loadEnv(partial)
    } catch (e) {
      expect((e as EnvError).message).toContain('DATABASE_URL')
      expect((e as EnvError).message).toContain('SUPABASE_SERVICE_ROLE_KEY')
    }
  })

  it('rejects an unknown APP_ENV rather than defaulting silently', () => {
    expect(() => loadEnv({ ...VALID, APP_ENV: 'prod' })).toThrow(EnvError)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/env.test.ts`
Expected: FAIL — `Failed to resolve import "@/modules/shared/config/env"`.

- [ ] **Step 4: Implement `env.ts`**

```typescript
// modules/shared/config/env.ts
import { z } from 'zod'

export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  APP_ENV: z.enum(['development', 'staging', 'production']),
})

export type PlatformEnv = {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  databaseUrl: string
  appEnv: 'development' | 'staging' | 'production'
}

/** Validates the whole environment at once so a misconfigured deploy fails loudly at boot. */
export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): PlatformEnv {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new EnvError(`Invalid environment — ${detail}`)
  }
  const e = parsed.data
  return {
    supabaseUrl: e.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: e.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: e.DATABASE_URL,
    appEnv: e.APP_ENV,
  }
}
```

Then create `.env.local.example` (**gitignored** per the `.env*` hard rule — it exists for your own reference, and its keys are documented in `infra/README.md` for CI):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
APP_ENV=development
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add the `pg` dependency and integration-test harness**

```bash
npm install pg@^8.13.1
npm install -D @types/pg@^8.11.10
```

```yaml
# docker-compose.test.yml — real Postgres for integration tests (spec §14 testing pyramid)
services:
  testdb:
    image: postgres:15-alpine
    environment:
      POSTGRES_PASSWORD: testpw
      POSTGRES_DB: qtx_test
    ports: ['55432:5432']
    tmpfs: ['/var/lib/postgresql/data']   # ephemeral: fast, wiped every run
```

```typescript
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['__tests__/integration/**/*.test.ts'],
    setupFiles: ['__tests__/integration/setup.ts'],
    fileParallelism: false,   // one shared database — serialize to avoid cross-test interference
    testTimeout: 30_000,
  },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
})
```

Add to `package.json` scripts (keep existing entries):

```json
"test:integration": "docker compose -f docker-compose.test.yml up -d --wait && vitest run --config vitest.integration.config.ts; docker compose -f docker-compose.test.yml down",
"db:migrate:staging": "npx supabase db push --db-url \"$DATABASE_URL_MIGRATE\""
```

Also add to `vitest.config.ts` so unit runs never pick up integration files:

```typescript
    exclude: ['**/node_modules/**', '__tests__/integration/**'],
```

- [ ] **Step 7: Verify the unit suite is still green**

Run: `npm test`
Expected: PASS — existing DLMS tests plus the 3 new env tests. No failures.

- [ ] **Step 8: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/shared/config/env.ts dlms/__tests__/platform/env.test.ts \
        dlms/vitest.config.ts dlms/vitest.integration.config.ts \
        dlms/docker-compose.test.yml dlms/package.json dlms/package-lock.json
git commit -m "feat(platform): environment config and integration-test harness

Adds fail-fast env validation for the new platform Supabase project and a
dockerized Postgres harness for transaction-level integration tests."
```

---

### Task 2: RBAC schema — roles, permissions, users, overrides, and GUC-based audit

**Files:**
- Create: `supabase/migrations/20260718000000_platform_rbac.sql`
- Create: `supabase/migrations/20260718000001_platform_audit.sql`
- Create: `supabase/seed/platform_seed.sql`
- Test: `__tests__/integration/setup.ts`, `__tests__/integration/rbacSchema.test.ts`

**Interfaces:**
- Consumes: `loadEnv()` (Task 1).
- Produces:
  - Tables `role`, `permission`, `role_permission`, `app_user`, `user_permission_override`, `audit_log`, `auth_event`.
  - `app_user` columns relied on by Task 3: `id uuid`, `auth_user_id uuid`, `email text`, `full_name text`, `role_id uuid`, `department text`, `module_access text[]`, `user_kind text`, `active boolean`, `mfa_enrolled boolean`.
  - Function `fn_audit()` reading actor from `current_setting('app.actor_id', true)` with column fallback.
  - `__tests__/integration/setup.ts` exports nothing but guarantees a migrated `qtx_test` database and sets `process.env.TEST_DATABASE_URL`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// __tests__/integration/setup.ts
import { execSync } from 'node:child_process'
import { Client } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DB = 'postgresql://postgres:testpw@localhost:55432/qtx_test'
process.env.TEST_DATABASE_URL = TEST_DB

/** Applies every platform migration, in filename order, to the ephemeral test database. */
export async function setup() {
  const client = new Client({ connectionString: TEST_DB })
  await client.connect()
  const dir = join(process.cwd(), 'supabase/migrations')
  const files = readdirSync(dir).filter((f) => f.startsWith('202607') && f.endsWith('.sql')).sort()
  for (const f of files) {
    await client.query(readFileSync(join(dir, f), 'utf8'))
  }
  await client.query(readFileSync(join(process.cwd(), 'supabase/seed/platform_seed.sql'), 'utf8'))
  await client.end()
}
```

```typescript
// __tests__/integration/rbacSchema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end() })

describe('platform RBAC schema', () => {
  it('seeds exactly the six roles from spec §3.1', async () => {
    const { rows } = await db.query('SELECT key FROM role ORDER BY key')
    expect(rows.map((r) => r.key)).toEqual([
      'admin', 'finance', 'manager', 'operator', 'super_admin', 'viewer',
    ])
  })

  it('seeds exactly the 24 permissions from spec §3.2', async () => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM permission')
    expect(rows[0].n).toBe(24)
  })

  it('grants super_admin every permission', async () => {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM role_permission rp
      JOIN role r ON r.id = rp.role_id WHERE r.key = 'super_admin'`)
    expect(rows[0].n).toBe(24)
  })

  it('refuses to delete a system role', async () => {
    await expect(db.query(`DELETE FROM role WHERE key = 'super_admin'`))
      .rejects.toThrow(/system role/i)
  })

  it('requires a reason on every permission override', async () => {
    await expect(db.query(`
      INSERT INTO user_permission_override (user_id, permission_id, granted, reason)
      SELECT u.id, p.id, true, NULL FROM app_user u, permission p LIMIT 1`))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — setup throws `relation "role" does not exist` (the migration file doesn't exist yet).

- [ ] **Step 3: Write the RBAC migration**

```sql
-- supabase/migrations/20260718000000_platform_rbac.sql
-- Platform RBAC (spec §3). Roles and permissions are DATA, not code: the Super
-- Admin edits the matrix at runtime. Enforcement lives at one authorize() choke
-- point in the service layer; RLS mirrors the read rules as defense-in-depth.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE role (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  description text,
  is_system  boolean NOT NULL DEFAULT false,   -- seeded roles: undeletable
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
COMMENT ON TABLE role IS 'Six seeded roles (spec §3.1). is_system rows cannot be deleted; their permission grants remain editable by a Super Admin.';

CREATE TABLE permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  sort        integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE permission IS 'The 24 permissions of spec §3.2. Reference data — rows are added only by migration.';

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  uuid UNIQUE,                    -- Supabase auth.users.id; NULL until invite accepted
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  role_id       uuid NOT NULL REFERENCES role(id),
  department    text,                            -- organizational attribute, NOT an access boundary
  module_access text[] NOT NULL DEFAULT '{}',
  user_kind     text NOT NULL DEFAULT 'employee'
                CHECK (user_kind IN ('employee', 'external')),  -- 'external' reserved for the future portal
  active        boolean NOT NULL DEFAULT true,
  mfa_enrolled  boolean NOT NULL DEFAULT false,
  invited_at    timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT module_access_known CHECK (
    module_access <@ ARRAY['engineering','finance','logistics','manufacturing','maintenance','tasks','admin']::text[]
  )
);
COMMENT ON COLUMN app_user.module_access IS
  'Modules this user may enter. Checked BEFORE permissions by authorize(). super_admin bypasses this gate in policy code.';
COMMENT ON COLUMN app_user.department IS
  'Organizational attribute used for task routing and dashboards. Never an access control input (spec BR-3).';
CREATE INDEX app_user_role_idx ON app_user(role_id);
CREATE INDEX app_user_active_idx ON app_user(active) WHERE deleted_at IS NULL;

CREATE TABLE role_permission (
  role_id       uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_permission_override (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  permission_id uuid NOT NULL REFERENCES permission(id),
  granted       boolean NOT NULL,               -- true = extra grant; false = revoke from role
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  expires_at    timestamptz,                    -- NULL = permanent; worker sweeps expiries hourly
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(id),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (user_id, permission_id)
);
COMMENT ON TABLE user_permission_override IS
  'Rare per-user exceptions to the role matrix. reason is mandatory so the audit trail explains itself.';

-- System roles are undeletable (guards the last-Super-Admin invariant at the DB floor)
CREATE OR REPLACE FUNCTION fn_protect_system_role()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'Cannot delete a system role (%)', OLD.key USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_protect_system_role BEFORE DELETE ON role
  FOR EACH ROW EXECUTE FUNCTION fn_protect_system_role();
```

- [ ] **Step 4: Write the audit migration**

```sql
-- supabase/migrations/20260718000001_platform_audit.sql
-- Audit trail (spec §6.3/§11). Two changes vs the DLMS original:
--   1. Actor comes from the app.actor_id GUC set by withTransaction(), with the
--      legacy column-sniffing kept as fallback for triggers fired outside a tx.
--   2. audit_log is INSERT-only at the grant level — no role may UPDATE/DELETE it.
--      That, not a trigger, is what makes the trail tamper-resistant.
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name  text NOT NULL,
  row_id      uuid,                     -- NULL for text-keyed tables
  action      text NOT NULL CHECK (action IN ('insert','update','soft_delete','delete')),
  actor_id    uuid REFERENCES app_user(id),
  old_values  jsonb,
  new_values  jsonb,
  changed_columns text[],
  reason      text,                     -- populated where the workflow demands one
  ip_address  inet,
  session_id  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_row_idx ON audit_log(table_name, row_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, occurred_at DESC);
CREATE INDEX audit_log_time_brin ON audit_log USING brin (occurred_at);

CREATE TABLE auth_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES app_user(id),
  email       text,                     -- recorded even when the user is unknown (failed login)
  event_type  text NOT NULL CHECK (event_type IN
                ('login_success','login_failure','lockout','logout',
                 'mfa_enrolled','mfa_reset','password_reset','permission_denied','session_revoked')),
  detail      jsonb,
  ip_address  inet,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_event_user_idx ON auth_event(user_id, occurred_at DESC);
CREATE INDEX auth_event_type_idx ON auth_event(event_type, occurred_at DESC);

CREATE OR REPLACE FUNCTION fn_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_old jsonb; v_new jsonb; v_rec jsonb;
  v_action text; v_changed text[]; v_actor uuid; v_row uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD); v_new := NULL; v_rec := v_old;
    v_action := 'delete'; v_changed := '{}';
  ELSIF TG_OP = 'INSERT' THEN
    v_old := NULL; v_new := to_jsonb(NEW); v_rec := v_new;
    v_action := 'insert'; v_changed := '{}';
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_rec := v_new;
    SELECT coalesce(array_agg(key), '{}') INTO v_changed
      FROM jsonb_each(v_new) WHERE v_old -> key IS DISTINCT FROM value;
    IF v_changed = '{}' THEN RETURN NEW; END IF;   -- no-op update: don't pollute the trail
    v_action := CASE
      WHEN v_old->>'deleted_at' IS NULL AND v_new->>'deleted_at' IS NOT NULL THEN 'soft_delete'
      ELSE 'update' END;
  END IF;

  -- Actor: GUC first (set by withTransaction), then row columns (legacy path).
  BEGIN
    v_actor := nullif(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN others THEN v_actor := NULL;
  END;
  IF v_actor IS NULL THEN
    v_actor := coalesce(
      (v_rec->>'updated_by')::uuid,
      (v_rec->>'created_by')::uuid
    );
  END IF;

  BEGIN v_row := (v_rec->>'id')::uuid; EXCEPTION WHEN others THEN v_row := NULL; END;

  INSERT INTO audit_log (table_name, row_id, action, actor_id, old_values, new_values,
                         changed_columns, session_id)
  VALUES (TG_TABLE_NAME, v_row, v_action, v_actor, v_old, v_new, v_changed,
          nullif(current_setting('app.session_id', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION fn_attach_audit(p_table text)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I
     FOR EACH ROW EXECUTE FUNCTION fn_audit()', p_table);
END $$;

SELECT fn_attach_audit(t) FROM unnest(ARRAY[
  'role','role_permission','app_user','user_permission_override'
]) AS t;
```

- [ ] **Step 5: Write the seed**

```sql
-- supabase/seed/platform_seed.sql — deterministic: same data for dev, staging, and tests.
INSERT INTO role (key, name, description, is_system, sort) VALUES
  ('super_admin','Super Administrator','Full control including users, roles, settings, and full export.',true,1),
  ('admin','Administrator','All operational abilities; cannot alter the permission fabric.',true,2),
  ('manager','Manager','Operate and approve within accessible modules.',true,3),
  ('operator','Operator','Create and edit records within accessible modules.',true,4),
  ('finance','Finance','Operate within Finance and Logistics; manages financial records.',true,5),
  ('viewer','Viewer','Read-only across accessible modules.',true,6);

INSERT INTO permission (key, name, sort) VALUES
  ('view_records','View records',1),
  ('create_records','Create records',2),
  ('edit_records','Edit records',3),
  ('delete_records','Delete (archive) records',4),
  ('restore_records','Restore archived records',5),
  ('change_device_status','Change device status',6),
  ('assign_tasks','Assign tasks',7),
  ('approve_requests','Approve requests',8),
  ('sign_off_repairs','Sign off repairs',9),
  ('upload_files','Upload files',10),
  ('download_files','Download files',11),
  ('export_data','Export data',12),
  ('import_data','Import data',13),
  ('view_finance','View financial information',14),
  ('manage_finance','Manage financial records',15),
  ('view_buyer_details','View buyer details',16),
  ('log_usage_service','Log usage and service events',17),
  ('view_audit_record','View record history',18),
  ('view_full_audit','View full audit log',19),
  ('manage_users','Manage users',20),
  ('manage_roles_permissions','Manage roles and permissions',21),
  ('manage_vocabularies','Manage vocabularies',22),
  ('manage_settings','Manage system settings',23),
  ('request_full_export','Request full system export',24);

-- The §3.2 matrix, as data. Read down each role's column in the spec table.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p WHERE r.key = 'super_admin';

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'admin' AND p.key IN (
  'view_records','create_records','edit_records','delete_records','restore_records',
  'change_device_status','assign_tasks','approve_requests','sign_off_repairs',
  'upload_files','download_files','export_data','import_data','view_finance',
  'manage_finance','view_buyer_details','log_usage_service','view_audit_record',
  'view_full_audit','manage_vocabularies');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'manager' AND p.key IN (
  'view_records','create_records','edit_records','delete_records','change_device_status',
  'assign_tasks','approve_requests','sign_off_repairs','upload_files','download_files',
  'export_data','import_data','view_finance','view_buyer_details','log_usage_service',
  'view_audit_record');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'operator' AND p.key IN (
  'view_records','create_records','edit_records','change_device_status','assign_tasks',
  'upload_files','download_files','view_buyer_details','log_usage_service','view_audit_record');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'finance' AND p.key IN (
  'view_records','create_records','edit_records','assign_tasks','upload_files',
  'download_files','export_data','view_finance','manage_finance','view_buyer_details',
  'view_audit_record');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'viewer' AND p.key IN ('view_records','download_files');

-- Bootstrap Super Admin. auth_user_id is linked on first login (Task 5).
INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
SELECT 'reetmitra8@gmail.com', 'Reet Mitra', r.id, 'Engineering',
       ARRAY['engineering','finance','logistics','manufacturing','maintenance','tasks','admin'],
       true
FROM role r WHERE r.key = 'super_admin';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (5 tests). If `role_permission` counts disagree with the §3.2 table, fix the **seed**, not the test.

- [ ] **Step 7: Apply to the cloud staging project**

Use the Supabase MCP `apply_migration` (or `npx supabase db push`) against `qtx-ops-platform` for both migration files, then run the seed once. Committing the files does **not** apply them.

Verify: `SELECT count(*) FROM role_permission;` → **95** (24 + 20 + 16 + 10 + 11 + 2 + super_admin's 24 = 24+20+16+10+11+2 = 83… run the query and record the real number in the test).

> **Implementer note:** Step 6's test asserts super_admin = 24. Add one more assertion here fixing the **total** to whatever the seed produces, so future matrix edits are caught: `SELECT count(*)::int FROM role_permission` → assert the exact integer.

- [ ] **Step 8: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/supabase/migrations/20260718000000_platform_rbac.sql \
        dlms/supabase/migrations/20260718000001_platform_audit.sql \
        dlms/supabase/seed/platform_seed.sql \
        dlms/__tests__/integration/setup.ts dlms/__tests__/integration/rbacSchema.test.ts
git commit -m "feat(platform): RBAC schema, GUC-based audit trail, and deterministic seed

Roles and permissions are DB data editable by a Super Admin. fn_audit now reads
the acting user from the app.actor_id GUC with column-sniffing fallback, and
audit_log is INSERT-only at the grant level."
```

---

### Task 3: The `authorize()` choke point and the generated permission-matrix suite

This is the single most security-critical task in the plan. Everything else trusts it.

**Files:**
- Create: `modules/shared/authz/catalog.ts`, `modules/shared/authz/policy.ts`, `modules/shared/authz/authorize.ts`, `modules/shared/authz/actor.ts`
- Test: `__tests__/platform/authz/policy.test.ts`, `__tests__/platform/authz/matrix.test.ts`, `__tests__/integration/seedMatrix.test.ts`

**Interfaces:**
- Consumes: `app_user` / `role` / `permission` / `role_permission` / `user_permission_override` tables (Task 2).
- Produces:
  - `type Permission` (union of the 24 keys), `type ModuleKey` (union of the 7), `type RoleKey` (union of the 6) from `@/modules/shared/authz/catalog`.
  - `PERMISSION_MATRIX: Record<RoleKey, readonly Permission[]>` — the §3.2 table as executable data.
  - `type Actor = { id: string; roleKey: RoleKey; permissions: ReadonlySet<Permission>; moduleAccess: ReadonlySet<ModuleKey>; active: boolean }`.
  - `can(actor: Actor, permission: Permission, module?: ModuleKey): boolean` — **pure**.
  - `authorize(actor: Actor, permission: Permission, module?: ModuleKey): void` — throws `PermissionError`.
  - `class PermissionError extends Error { readonly permission: Permission; readonly module?: ModuleKey }`.
  - `loadActor(authUserId: string): Promise<Actor | null>` from `@/modules/shared/authz/actor`.

- [ ] **Step 1: Write the failing pure-policy test**

```typescript
// __tests__/platform/authz/policy.test.ts
import { describe, it, expect } from 'vitest'
import { can } from '@/modules/shared/authz/policy'
import type { Actor } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u1',
  roleKey: 'operator',
  permissions: new Set(['view_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

describe('can — the pure authorization rule (spec §3.2)', () => {
  it('allows a held permission inside an accessible module', () => {
    expect(can(actor(), 'edit_records', 'manufacturing')).toBe(true)
  })

  it('denies a permission the role does not hold', () => {
    expect(can(actor(), 'approve_requests', 'manufacturing')).toBe(false)
  })

  it('denies an inaccessible module even when the permission is held', () => {
    expect(can(actor(), 'view_records', 'finance')).toBe(false)
  })

  it('denies EVERYTHING to an inactive user, including a super admin', () => {
    const dead = actor({ roleKey: 'super_admin', active: false })
    expect(can(dead, 'view_records', 'manufacturing')).toBe(false)
    expect(can(dead, 'manage_users', 'admin')).toBe(false)
  })

  it('lets super_admin bypass the module gate (implicit access to all modules)', () => {
    const sa = actor({
      roleKey: 'super_admin',
      permissions: new Set(['manage_users']),
      moduleAccess: new Set(),   // deliberately empty
    })
    expect(can(sa, 'manage_users', 'admin')).toBe(true)
  })

  it('does NOT let a non-super_admin bypass the module gate', () => {
    const ad = actor({ roleKey: 'admin', permissions: new Set(['view_records']), moduleAccess: new Set() })
    expect(can(ad, 'view_records', 'finance')).toBe(false)
  })

  it('checks the permission with no module gate when module is omitted', () => {
    expect(can(actor(), 'view_records')).toBe(true)
    expect(can(actor(), 'manage_users')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/authz/policy.test.ts`
Expected: FAIL — cannot resolve `@/modules/shared/authz/policy`.

- [ ] **Step 3: Implement the catalog and the pure policy**

```typescript
// modules/shared/authz/catalog.ts
/**
 * The authorization vocabulary and the spec §3.2 matrix, as executable data.
 *
 * PERMISSION_MATRIX is the source of truth the seed is CHECKED AGAINST — it does
 * not grant anything at runtime (the DB does). Keeping the spec table here in
 * code is what lets __tests__/integration/seedMatrix.test.ts fail loudly when
 * the live seed drifts from the design document.
 */
export const PERMISSIONS = [
  'view_records', 'create_records', 'edit_records', 'delete_records', 'restore_records',
  'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
  'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
  'manage_finance', 'view_buyer_details', 'log_usage_service', 'view_audit_record',
  'view_full_audit', 'manage_users', 'manage_roles_permissions', 'manage_vocabularies',
  'manage_settings', 'request_full_export',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const MODULES = [
  'engineering', 'finance', 'logistics', 'manufacturing', 'maintenance', 'tasks', 'admin',
] as const
export type ModuleKey = (typeof MODULES)[number]

export const ROLES = ['super_admin', 'admin', 'manager', 'operator', 'finance', 'viewer'] as const
export type RoleKey = (typeof ROLES)[number]

export type Actor = {
  id: string
  roleKey: RoleKey
  /** Role grants + overrides, already resolved. */
  permissions: ReadonlySet<Permission>
  moduleAccess: ReadonlySet<ModuleKey>
  active: boolean
}

export const PERMISSION_MATRIX: Record<RoleKey, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  admin: [
    'view_records', 'create_records', 'edit_records', 'delete_records', 'restore_records',
    'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
    'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
    'manage_finance', 'view_buyer_details', 'log_usage_service', 'view_audit_record',
    'view_full_audit', 'manage_vocabularies',
  ],
  manager: [
    'view_records', 'create_records', 'edit_records', 'delete_records',
    'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
    'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
    'view_buyer_details', 'log_usage_service', 'view_audit_record',
  ],
  operator: [
    'view_records', 'create_records', 'edit_records', 'change_device_status',
    'assign_tasks', 'upload_files', 'download_files', 'view_buyer_details',
    'log_usage_service', 'view_audit_record',
  ],
  finance: [
    'view_records', 'create_records', 'edit_records', 'assign_tasks', 'upload_files',
    'download_files', 'export_data', 'view_finance', 'manage_finance',
    'view_buyer_details', 'view_audit_record',
  ],
  viewer: ['view_records', 'download_files'],
}
```

```typescript
// modules/shared/authz/policy.ts
import type { Actor, ModuleKey, Permission } from './catalog'

/**
 * THE authorization rule (spec §3.2): module access ∧ permission, gated on active.
 *
 * Pure by design — no I/O, no DB, no session. The Actor arrives with its
 * permissions already resolved (role grants ± overrides) so this function stays
 * trivially testable and every caller gets identical semantics.
 *
 * Order matters: the active check precedes everything so a deactivated account
 * can never act, whatever its role. super_admin bypasses the MODULE gate only —
 * it never bypasses the permission set, because a Super Admin whose grants were
 * edited away should genuinely lose the ability.
 */
export function can(actor: Actor, permission: Permission, module?: ModuleKey): boolean {
  if (!actor.active) return false
  if (module && actor.roleKey !== 'super_admin' && !actor.moduleAccess.has(module)) return false
  return actor.permissions.has(permission)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/authz/policy.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing matrix test — every role × every permission**

```typescript
// __tests__/platform/authz/matrix.test.ts
import { describe, it, expect } from 'vitest'
import { can } from '@/modules/shared/authz/policy'
import { PERMISSIONS, ROLES, PERMISSION_MATRIX, MODULES } from '@/modules/shared/authz/catalog'
import type { Actor, Permission, RoleKey } from '@/modules/shared/authz/catalog'

/** An actor holding exactly what the §3.2 matrix says its role holds, with every module open. */
const actorFor = (roleKey: RoleKey): Actor => ({
  id: `u-${roleKey}`,
  roleKey,
  permissions: new Set<Permission>(PERMISSION_MATRIX[roleKey]),
  moduleAccess: new Set(MODULES),
  active: true,
})

describe('permission matrix — generated across all 6 roles × 24 permissions', () => {
  for (const roleKey of ROLES) {
    for (const permission of PERMISSIONS) {
      const expected = PERMISSION_MATRIX[roleKey].includes(permission)
      it(`${roleKey} ${expected ? 'CAN' : 'CANNOT'} ${permission}`, () => {
        expect(can(actorFor(roleKey), permission)).toBe(expected)
      })
    }
  }

  it('gives exactly one role the power to manage the permission fabric', () => {
    const holders = ROLES.filter((r) => PERMISSION_MATRIX[r].includes('manage_roles_permissions'))
    expect(holders).toEqual(['super_admin'])
  })

  it('gives exactly one role the power to request a full system export', () => {
    const holders = ROLES.filter((r) => PERMISSION_MATRIX[r].includes('request_full_export'))
    expect(holders).toEqual(['super_admin'])
  })

  it('never grants a Viewer any mutating permission', () => {
    const mutating: Permission[] = [
      'create_records', 'edit_records', 'delete_records', 'restore_records',
      'change_device_status', 'approve_requests', 'sign_off_repairs', 'upload_files',
      'import_data', 'manage_finance', 'manage_users', 'manage_roles_permissions',
      'manage_vocabularies', 'manage_settings',
    ]
    for (const p of mutating) expect(can(actorFor('viewer'), p)).toBe(false)
  })

  it('withholds manage_finance from Manager (view only — spec §3.2 row 15)', () => {
    expect(can(actorFor('manager'), 'view_finance')).toBe(true)
    expect(can(actorFor('manager'), 'manage_finance')).toBe(false)
  })
})
```

- [ ] **Step 6: Run the matrix test**

Run: `npx vitest run __tests__/platform/authz/matrix.test.ts`
Expected: PASS — 144 generated cases + 5 invariants. If any generated case surprises you, the **spec table** and `PERMISSION_MATRIX` disagree; reconcile them before continuing.

- [ ] **Step 7: Write the failing seed-drift test**

```typescript
// __tests__/integration/seedMatrix.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { ROLES, PERMISSION_MATRIX } from '@/modules/shared/authz/catalog'

let db: Client
beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end() })

describe('seeded role_permission matches the spec §3.2 matrix in code', () => {
  for (const roleKey of ROLES) {
    it(`${roleKey} grants match exactly`, async () => {
      const { rows } = await db.query(
        `SELECT p.key FROM role_permission rp
           JOIN role r ON r.id = rp.role_id
           JOIN permission p ON p.id = rp.permission_id
          WHERE r.key = $1 ORDER BY p.key`,
        [roleKey],
      )
      expect(rows.map((r) => r.key)).toEqual([...PERMISSION_MATRIX[roleKey]].sort())
    })
  }
})
```

- [ ] **Step 8: Run it**

Run: `npm run test:integration`
Expected: PASS (6 role comparisons). A failure means the SQL seed and the code matrix drifted — fix whichever contradicts `docs/superpowers/specs/2026-07-17-ops-platform-design.md` §3.2.

- [ ] **Step 9: Implement `authorize()` and `loadActor()`**

```typescript
// modules/shared/authz/authorize.ts
import { can } from './policy'
import type { Actor, ModuleKey, Permission } from './catalog'

export class PermissionError extends Error {
  readonly permission: Permission
  readonly module?: ModuleKey
  constructor(permission: Permission, module?: ModuleKey) {
    super(`Permission denied: ${permission}${module ? ` in ${module}` : ''}`)
    this.name = 'PermissionError'
    this.permission = permission
    this.module = module
  }
}

/**
 * The choke point. Every service entry point calls this before touching data.
 *
 * Throws rather than returning false so a forgotten `if` cannot silently permit
 * an action; route handlers translate PermissionError into 403 (or 404 for
 * id-addressed reads, so a denial never confirms a record exists — spec §7.3).
 */
export function authorize(actor: Actor, permission: Permission, module?: ModuleKey): void {
  if (!can(actor, permission, module)) throw new PermissionError(permission, module)
}
```

```typescript
// modules/shared/authz/actor.ts
import { createAdminClient } from '@/lib/supabase/server'
import type { Actor, ModuleKey, Permission, RoleKey } from './catalog'

type Row = {
  id: string
  role_key: RoleKey
  module_access: string[]
  active: boolean
  role_permissions: string[]
  granted_overrides: string[]
  revoked_overrides: string[]
}

/**
 * Resolves the acting user's full authorization state in ONE query.
 *
 * Overrides are folded in here (grants added, revokes subtracted, expired ones
 * ignored) so the pure policy never has to know they exist. Uses the admin
 * client deliberately: this is a read that FEEDS authorization decisions, and
 * must not itself be subject to the RLS policies it is about to justify.
 */
export async function loadActor(authUserId: string): Promise<Actor | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('fn_resolve_actor', { p_auth_user_id: authUserId })
  if (error) throw new Error(`loadActor failed: ${error.message}`)
  const row = (data as Row[] | null)?.[0]
  if (!row) return null

  const permissions = new Set<Permission>(row.role_permissions as Permission[])
  for (const p of row.granted_overrides) permissions.add(p as Permission)
  for (const p of row.revoked_overrides) permissions.delete(p as Permission)

  return {
    id: row.id,
    roleKey: row.role_key,
    permissions,
    moduleAccess: new Set(row.module_access as ModuleKey[]),
    active: row.active,
  }
}
```

- [ ] **Step 10: Add the resolver function migration**

```sql
-- supabase/migrations/20260718000002_platform_resolve_actor.sql
-- One round trip for the full authorization state. Expired overrides are filtered
-- here so a lapsed grant stops working the moment it expires, without waiting for
-- the hourly sweep job.
CREATE OR REPLACE FUNCTION fn_resolve_actor(p_auth_user_id uuid)
RETURNS TABLE (
  id uuid, role_key text, module_access text[], active boolean,
  role_permissions text[], granted_overrides text[], revoked_overrides text[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    u.id,
    r.key,
    u.module_access,
    u.active AND u.deleted_at IS NULL,
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM role_permission rp
                JOIN permission p ON p.id = rp.permission_id
               WHERE rp.role_id = u.role_id), '{}'),
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM user_permission_override o
                JOIN permission p ON p.id = o.permission_id
               WHERE o.user_id = u.id AND o.granted AND o.deleted_at IS NULL
                 AND (o.expires_at IS NULL OR o.expires_at > now())), '{}'),
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM user_permission_override o
                JOIN permission p ON p.id = o.permission_id
               WHERE o.user_id = u.id AND NOT o.granted AND o.deleted_at IS NULL
                 AND (o.expires_at IS NULL OR o.expires_at > now())), '{}')
  FROM app_user u
  JOIN role r ON r.id = u.role_id
  WHERE u.auth_user_id = p_auth_user_id;
$$;
REVOKE EXECUTE ON FUNCTION fn_resolve_actor(uuid) FROM public, anon, authenticated;
```

- [ ] **Step 11: Write and run the override-resolution integration test**

```typescript
// __tests__/integration/resolveActor.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let userId: string

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  const { rows } = await db.query(`
    INSERT INTO app_user (auth_user_id, email, full_name, role_id, module_access, active)
    SELECT gen_random_uuid(), 'ov@test.local', 'Override Test', r.id,
           ARRAY['manufacturing']::text[], true
      FROM role r WHERE r.key = 'viewer' RETURNING id, auth_user_id`)
  userId = rows[0].id
})
afterAll(async () => { await db.end() })

const resolve = async () => {
  const { rows } = await db.query(
    `SELECT * FROM fn_resolve_actor((SELECT auth_user_id FROM app_user WHERE id = $1))`, [userId])
  return rows[0]
}

describe('fn_resolve_actor', () => {
  it('returns the role grants for a user with no overrides', async () => {
    const a = await resolve()
    expect(a.role_permissions.sort()).toEqual(['download_files', 'view_records'])
    expect(a.granted_overrides).toEqual([])
  })

  it('reports an active grant override', async () => {
    await db.query(`
      INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
      SELECT $1, p.id, true, 'covering for the manager this week', $1
        FROM permission p WHERE p.key = 'export_data'`, [userId])
    expect((await resolve()).granted_overrides).toEqual(['export_data'])
  })

  it('ignores an EXPIRED override — a lapsed grant stops working immediately', async () => {
    await db.query(`UPDATE user_permission_override SET expires_at = now() - interval '1 minute'
                     WHERE user_id = $1`, [userId])
    expect((await resolve()).granted_overrides).toEqual([])
  })
})
```

Run: `npm run test:integration`
Expected: PASS (3 new tests).

- [ ] **Step 12: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/shared/authz dlms/__tests__/platform/authz \
        dlms/__tests__/integration/seedMatrix.test.ts dlms/__tests__/integration/resolveActor.test.ts \
        dlms/supabase/migrations/20260718000002_platform_resolve_actor.sql
git commit -m "feat(authz): single authorize() choke point with generated matrix suite

Pure can() rule (active → module → permission), a throwing authorize() wrapper,
and one-query actor resolution folding in time-boxed overrides. 144 generated
role × permission cases plus a seed-drift test pin the spec §3.2 matrix."
```

---

### Task 4: The transaction layer — RISK SPIKE (spec R-4)

**Do this before the UI tasks.** If `withTransaction` can't carry the audit actor and roll back cleanly, the fallback (Postgres RPC functions for the six §7.5 workflows) must be chosen now, not in week 7.

**Files:**
- Create: `lib/db/pool.ts`, `lib/db/tx.ts`
- Test: `__tests__/integration/transaction.test.ts`

**Interfaces:**
- Consumes: `loadEnv()` (Task 1); `app_user`, `audit_log`, `fn_audit` (Task 2).
- Produces:
  - `getPool(): Pool` from `@/lib/db/pool`.
  - `withTransaction<T>(actorId: string, fn: (tx: Tx) => Promise<T>, opts?: { sessionId?: string }): Promise<T>` from `@/lib/db/tx`.
  - `type Tx = { query: <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>> }`.
  - `class OptimisticLockError extends Error { readonly table: string; readonly id: string }`.

- [ ] **Step 1: Write the failing test — rollback is the point**

```typescript
// __tests__/integration/transaction.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { withTransaction } from '@/lib/db/tx'
import { getPool } from '@/lib/db/pool'

let db: Client
let actorId: string

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  const { rows } = await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)
  actorId = rows[0].id
  await db.query(`CREATE TABLE IF NOT EXISTS tx_probe (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label text NOT NULL UNIQUE,
    created_by uuid REFERENCES app_user(id),
    updated_by uuid REFERENCES app_user(id))`)
  await db.query(`SELECT fn_attach_audit('tx_probe')`)
})
afterAll(async () => {
  await db.query('DROP TABLE IF EXISTS tx_probe')
  await db.end()
  await getPool().end()
})

describe('withTransaction', () => {
  it('commits every statement together', async () => {
    await withTransaction(actorId, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('commit-a')`)
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('commit-b')`)
    })
    const { rows } = await db.query(`SELECT label FROM tx_probe WHERE label LIKE 'commit-%' ORDER BY label`)
    expect(rows.map((r) => r.label)).toEqual(['commit-a', 'commit-b'])
  })

  it('ROLLS BACK every statement when any one throws — the §14 guarantee', async () => {
    await expect(
      withTransaction(actorId, async (tx) => {
        await tx.query(`INSERT INTO tx_probe (label) VALUES ('rollback-a')`)
        await tx.query(`INSERT INTO tx_probe (label) VALUES ('rollback-a')`)  // unique violation
      }),
    ).rejects.toThrow()

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tx_probe WHERE label = 'rollback-a'`)
    expect(rows[0].n).toBe(0)   // the FIRST insert must be gone too
  })

  it('rolls back when application code throws after successful statements', async () => {
    await expect(
      withTransaction(actorId, async (tx) => {
        await tx.query(`INSERT INTO tx_probe (label) VALUES ('app-throw')`)
        throw new Error('business rule violated')
      }),
    ).rejects.toThrow('business rule violated')
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tx_probe WHERE label = 'app-throw'`)
    expect(rows[0].n).toBe(0)
  })

  it('attributes audit rows to the actor via the GUC, with no updated_by column set', async () => {
    await withTransaction(actorId, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('guc-actor')`)
    })
    const { rows } = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name = 'tx_probe'
        AND new_values->>'label' = 'guc-actor'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(actorId)
  })

  it('does not leak the GUC into the next transaction on the same pooled connection', async () => {
    await withTransaction(actorId, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('leak-1')`)
    })
    const other = (await db.query(
      `INSERT INTO app_user (email, full_name, role_id, active)
       SELECT 'leak@test.local', 'Leak Probe', r.id, true FROM role r WHERE r.key = 'viewer'
       RETURNING id`)).rows[0].id
    await withTransaction(other, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('leak-2')`)
    })
    const { rows } = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name = 'tx_probe'
        AND new_values->>'label' = 'leak-2'`)
    expect(rows[0].actor_id).toBe(other)   // NOT the previous actor
  })

  it('returns the callback value', async () => {
    const out = await withTransaction(actorId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT 42::int AS n`)
      return rows[0].n
    })
    expect(out).toBe(42)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `@/lib/db/tx`.

- [ ] **Step 3: Implement the pool and the transaction helper**

```typescript
// lib/db/pool.ts
import { Pool } from 'pg'

let pool: Pool | undefined

/**
 * Singleton node-postgres pool over Supavisor's transaction-mode port (6543).
 *
 * Why direct pg rather than supabase-js for writes: supabase-js issues one HTTP
 * request per statement and cannot span a transaction, which the component
 * replacement workflow (spec §5.4) structurally requires. Reads stay on
 * supabase-js so RLS remains live enforcement (spec §7.2).
 *
 * max is small on purpose: Fargate runs 2–4 tasks, and Supabase's pooler is the
 * real connection budget. Statement timeout keeps a runaway query from pinning a
 * connection for the whole request budget.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      ssl: process.env.APP_ENV === 'development' ? undefined : { rejectUnauthorized: true },
    })
    pool.on('error', (err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', err: err.message }))
    })
  }
  return pool
}
```

```typescript
// lib/db/tx.ts
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { getPool } from './pool'

export type Tx = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<QueryResult<R>>
}

export class OptimisticLockError extends Error {
  readonly table: string
  readonly id: string
  constructor(table: string, id: string) {
    super(`${table} ${id} was modified by someone else — reload and try again`)
    this.name = 'OptimisticLockError'
    this.table = table
    this.id = id
  }
}

/**
 * Runs `fn` inside one database transaction with the acting user carried in a
 * transaction-local GUC that fn_audit reads.
 *
 * SET LOCAL (not SET) is essential: the value dies with the transaction, so a
 * pooled connection handed to the next request cannot attribute that request's
 * writes to the previous actor. set_config's third argument `true` is what makes
 * it LOCAL.
 *
 * Any throw — from Postgres or from application code — rolls back everything.
 * The client is always released, and a rollback failure is logged rather than
 * masking the original error the caller needs to see.
 */
export async function withTransaction<T>(
  actorId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: { sessionId?: string } = {},
): Promise<T> {
  const client: PoolClient = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actorId])
    if (opts.sessionId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.session_id', opts.sessionId])
    }
    const result = await fn({ query: (text, values) => client.query(text, values) as never })
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      console.error(JSON.stringify({
        level: 'error', msg: 'ROLLBACK failed', err: (rollbackErr as Error).message,
      }))
    }
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (6 transaction tests). **The rollback and GUC-leak tests are the spike's verdict** — if either fails, stop and escalate: the fallback is moving the §7.5 workflows into `SECURITY DEFINER` Postgres functions called via a single `rpc()`.

- [ ] **Step 5: Record the spike outcome**

Append to `docs/superpowers/specs/2026-07-17-ops-platform-design.md` §19 (decision log):

```markdown
- **D39 (2026-07-__): pg transaction write-path VALIDATED.** withTransaction proves
  atomic rollback across statements and GUC-based audit attribution with no actor
  leakage across pooled connections (`__tests__/integration/transaction.test.ts`).
  Risk R-4 closed; the RPC fallback is not needed.
```

- [ ] **Step 6: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/lib/db dlms/__tests__/integration/transaction.test.ts \
        dlms/docs/superpowers/specs/2026-07-17-ops-platform-design.md
git commit -m "feat(db): transactional write path with GUC-carried audit actor

Closes risk R-4. withTransaction wraps multi-statement workflows in one
transaction and carries the acting user in a transaction-local GUC that fn_audit
reads, so audit attribution cannot leak across pooled connections."
```

---

### Task 5: Authentication, MFA enforcement, and the request-scoped actor

**Files:**
- Create: `modules/shared/auth/session.ts`, `modules/shared/auth/authEvents.ts`
- Create: `middleware.ts` *(repo root — replaces any existing DLMS middleware only if absent; if one exists, extend it)*
- Create: `app/(platform)/unauthorized/page.tsx`
- Test: `__tests__/platform/auth/mfaPolicy.test.ts`, `__tests__/platform/auth/session.test.ts`

**Interfaces:**
- Consumes: `loadActor()`, `Actor`, `RoleKey` (Task 3); `createClient()` from `@/lib/supabase/server` (existing).
- Produces:
  - `requiresMfa(roleKey: RoleKey): boolean` — **pure**, from `@/modules/shared/auth/mfaPolicy`.
  - `getCurrentActor(): Promise<Actor | null>` from `@/modules/shared/auth/session` — cached per request via React `cache()`.
  - `requireActor(): Promise<Actor>` — throws `UnauthenticatedError` (exported).
  - `recordAuthEvent(input: AuthEventInput): Promise<void>` from `@/modules/shared/auth/authEvents`, where
    `type AuthEventInput = { userId?: string; email?: string; eventType: 'login_success' | 'login_failure' | 'lockout' | 'logout' | 'mfa_enrolled' | 'mfa_reset' | 'password_reset' | 'permission_denied' | 'session_revoked'; detail?: Record<string, unknown>; ipAddress?: string; userAgent?: string }`.

- [ ] **Step 1: Write the failing MFA-policy test**

```typescript
// __tests__/platform/auth/mfaPolicy.test.ts
import { describe, it, expect } from 'vitest'
import { requiresMfa } from '@/modules/shared/auth/mfaPolicy'
import { ROLES } from '@/modules/shared/authz/catalog'

describe('requiresMfa (spec D35 — mandatory for privileged roles, optional otherwise)', () => {
  it('requires MFA for the three privileged roles', () => {
    expect(requiresMfa('super_admin')).toBe(true)
    expect(requiresMfa('admin')).toBe(true)
    expect(requiresMfa('finance')).toBe(true)
  })

  it('does not require MFA for floor roles', () => {
    expect(requiresMfa('manager')).toBe(false)
    expect(requiresMfa('operator')).toBe(false)
    expect(requiresMfa('viewer')).toBe(false)
  })

  it('covers every role — no role is unclassified', () => {
    for (const r of ROLES) expect(typeof requiresMfa(r)).toBe('boolean')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/auth/mfaPolicy.test.ts`
Expected: FAIL — cannot resolve `@/modules/shared/auth/mfaPolicy`.

- [ ] **Step 3: Implement the MFA policy**

```typescript
// modules/shared/auth/mfaPolicy.ts
import type { RoleKey } from '@/modules/shared/authz/catalog'

/**
 * Which roles must complete a TOTP challenge to hold a session (spec D35).
 *
 * The list is the set of roles that can approve, export, or reshape the system —
 * the powers whose misuse a stolen password would enable. Kept as an explicit
 * Set rather than derived from permissions so that adding a permission to a role
 * can never silently relax its login requirement.
 */
const MFA_REQUIRED: ReadonlySet<RoleKey> = new Set<RoleKey>(['super_admin', 'admin', 'finance'])

export function requiresMfa(roleKey: RoleKey): boolean {
  return MFA_REQUIRED.has(roleKey)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/auth/mfaPolicy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing session test**

```typescript
// __tests__/platform/auth/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockLoadActor = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: mockGetUser } }),
  createAdminClient: () => ({}),
}))
vi.mock('@/modules/shared/authz/actor', () => ({ loadActor: mockLoadActor }))

const { getCurrentActor, requireActor, UnauthenticatedError } = await import(
  '@/modules/shared/auth/session'
)

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['view_records' as const]),
  moduleAccess: new Set(['manufacturing' as const]), active: true,
}

beforeEach(() => {
  mockGetUser.mockReset()
  mockLoadActor.mockReset()
})

describe('getCurrentActor', () => {
  it('returns null when there is no Supabase session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await getCurrentActor()).toBeNull()
    expect(mockLoadActor).not.toHaveBeenCalled()
  })

  it('returns the resolved actor for an authenticated user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
    mockLoadActor.mockResolvedValue(ACTOR)
    expect(await getCurrentActor()).toEqual(ACTOR)
    expect(mockLoadActor).toHaveBeenCalledWith('auth-1')
  })

  it('returns null when the auth user has no app_user row (invited, never provisioned)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-ghost' } }, error: null })
    mockLoadActor.mockResolvedValue(null)
    expect(await getCurrentActor()).toBeNull()
  })

  it('treats a DEACTIVATED user as unauthenticated — sessions die with the account', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-2' } }, error: null })
    mockLoadActor.mockResolvedValue({ ...ACTOR, active: false })
    expect(await getCurrentActor()).toBeNull()
  })
})

describe('requireActor', () => {
  it('throws UnauthenticatedError when there is no actor', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    await expect(requireActor()).rejects.toThrow(UnauthenticatedError)
  })

  it('returns the actor when present', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
    mockLoadActor.mockResolvedValue(ACTOR)
    expect(await requireActor()).toEqual(ACTOR)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/auth/session.test.ts`
Expected: FAIL — cannot resolve `@/modules/shared/auth/session`.

- [ ] **Step 7: Implement the session module**

```typescript
// modules/shared/auth/session.ts
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { loadActor } from '@/modules/shared/authz/actor'
import type { Actor } from '@/modules/shared/authz/catalog'

export class UnauthenticatedError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'UnauthenticatedError'
  }
}

/**
 * The acting user for this request, or null.
 *
 * Deactivation is enforced HERE rather than only at login: an admin who
 * deactivates an account expects existing sessions to stop working immediately,
 * and Supabase's own token stays valid until it expires. Returning null for an
 * inactive user makes the next request from that session behave as signed-out.
 *
 * React's cache() dedupes this within a request, so a page rendering ten
 * permission-gated components resolves the actor once.
 */
export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const supabase = createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null

  const actor = await loadActor(data.user.id)
  if (!actor || !actor.active) return null
  return actor
})

export async function requireActor(): Promise<Actor> {
  const actor = await getCurrentActor()
  if (!actor) throw new UnauthenticatedError()
  return actor
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/auth/session.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Implement auth-event recording**

```typescript
// modules/shared/auth/authEvents.ts
import { createAdminClient } from '@/lib/supabase/server'

export type AuthEventInput = {
  userId?: string
  email?: string
  eventType:
    | 'login_success' | 'login_failure' | 'lockout' | 'logout'
    | 'mfa_enrolled' | 'mfa_reset' | 'password_reset'
    | 'permission_denied' | 'session_revoked'
  detail?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

/**
 * Writes the security trail the Admin console reads (spec §11.1).
 *
 * Never throws: a failure to record a login must not prevent the login itself,
 * and a failure to record a denial must not turn a 403 into a 500. Losses are
 * logged for the operator instead.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  try {
    const supabase = createAdminClient()
    const { error } = await supabase.from('auth_event').insert({
      user_id: input.userId ?? null,
      email: input.email ?? null,
      event_type: input.eventType,
      detail: input.detail ?? null,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'auth_event write failed',
      eventType: input.eventType, err: (err as Error).message,
    }))
  }
}
```

- [ ] **Step 10: Add the route guard middleware**

```typescript
// middleware.ts  (repo root)
import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PUBLIC_PATHS = ['/login', '/auth', '/unauthorized', '/api/health']

/**
 * Coarse gate only: proves a Supabase session exists and refreshes its cookies.
 *
 * It deliberately does NOT check permissions. Middleware runs on the edge
 * without database access, and a permission decision made here would be a second
 * source of truth competing with authorize(). Pages and services do the real
 * check; this just keeps anonymous traffic off authenticated routes.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next()

  let response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  const { data } = await supabase.auth.getUser()
  if (!data.user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)'],
}
```

- [ ] **Step 11: Verify the full unit suite and types**

Run: `npm test && npm run type-check`
Expected: PASS, no type errors.

- [ ] **Step 12: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/shared/auth dlms/middleware.ts dlms/__tests__/platform/auth
git commit -m "feat(auth): request-scoped actor, MFA policy, and security event trail

Deactivation is enforced per-request so an admin revoking an account kills live
sessions immediately. Middleware gates anonymous traffic only; permission
decisions stay at the authorize() choke point."
```

> **Step 13 (manual, same task): enable MFA in Supabase.** In the `qtx-ops-platform` dashboard → Authentication → set TOTP factors enabled, disable public signups (invite-only, spec BR-6), set password minimum length 12, and configure the site URL + redirect allow-list for the staging domain. MFA *enrollment* UI lands in Task 8 with the user console; this task establishes the policy the console enforces.

---

### Task 6: Terraform foundation, container build, and CI/CD

**Runs fully parallel to Tasks 2–5 — start it on day 1.** SES production access has a multi-day approval lead time and blocks nothing else, so request it first.

**Files:**
- Create: `infra/README.md`, `infra/envs/staging/{main.tf,variables.tf,terraform.tfvars}`, `infra/modules/{network,ecs,cdn}/main.tf`
- Create: `Dockerfile`, `.dockerignore`
- Create: `app/api/health/route.ts`
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`
- Modify: `next.config.js` (standalone output)
- Test: `__tests__/platform/health.test.ts`

**Interfaces:**
- Consumes: `loadEnv()` (Task 1); `getPool()` (Task 4 — health check pings the DB).
- Produces: a deployed staging URL; `GET /api/health` → `200 {"status":"ok","db":"ok","version":"<sha>"}` or `503 {"status":"degraded","db":"error"}`.

- [ ] **Step 1: Request SES production access (do this first, it blocks nothing)**

AWS Console → SES (ap-southeast-1) → verify the sending domain, then request production access with the use case: *"Internal operations platform for a 100-employee hardware manufacturer. Transactional only: task assignments, approval requests, security alerts to verified employee addresses. No marketing, no external recipients."* Expect 1–3 business days.

- [ ] **Step 2: Write the failing health test**

```typescript
// __tests__/platform/health.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('@/lib/db/pool', () => ({ getPool: () => ({ query: mockQuery }) }))

const { GET } = await import('@/app/api/health/route')

beforeEach(() => mockQuery.mockReset())

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ok: 1 }] })
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok', db: 'ok' })
  })

  it('reports 503 degraded when the database is unreachable — ALB must pull the task', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'))
    const res = await GET()
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ status: 'degraded', db: 'error' })
  })

  it('never leaks the database error text to the caller', async () => {
    mockQuery.mockRejectedValue(new Error('password authentication failed for user "postgres"'))
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toContain('password')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/health.test.ts`
Expected: FAIL — cannot resolve `@/app/api/health/route`.

- [ ] **Step 4: Implement the health endpoint**

```typescript
// app/api/health/route.ts
import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db/pool'

export const dynamic = 'force-dynamic'

/**
 * ALB target-group health check and CloudWatch Synthetics target.
 *
 * Pings the database because a task that cannot reach Postgres serves errors to
 * every request and should be pulled from the load balancer, not left in
 * rotation. Error detail is logged, never returned: this endpoint is
 * unauthenticated by necessity.
 */
export async function GET() {
  const version = process.env.GIT_SHA ?? 'dev'
  try {
    await getPool().query('SELECT 1 AS ok')
    return NextResponse.json({ status: 'ok', db: 'ok', version })
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'health check db ping failed', err: (err as Error).message,
    }))
    return NextResponse.json({ status: 'degraded', db: 'error', version }, { status: 503 })
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/health.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Containerize**

```javascript
// next.config.js — add to the existing config object
  output: 'standalone',
```

```dockerfile
# Dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA NEXT_TELEMETRY_DISABLED=1
# Build-time public vars must be present for the client bundle
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

```
# .dockerignore
node_modules
.next
.git
.env*
__tests__
docs
infra
data
```

Verify locally: `docker build -t qtx-ops:local --build-arg GIT_SHA=local .` → build succeeds.

- [ ] **Step 7: Write the Terraform staging environment**

Create `infra/envs/staging/main.tf` provisioning, in this order: VPC (10.20.0.0/16, 2 AZ, public + private subnets, single NAT gateway), ECR repository (`qtx-ops`, scan-on-push), ECS cluster + Fargate service (`web`, 1 task at 0.25 vCPU / 512 MB for staging, private subnets), ALB (public subnets, target group health check `/api/health`, interval 30 s, healthy threshold 2), ACM certificate (DNS-validated), CloudFront distribution (ALB origin, `AllViewerExceptHostHeader` origin request policy, caching disabled for `/api/*`), WAF web ACL (`AWSManagedRulesCommonRuleSet` + `AWSManagedRulesKnownBadInputsRuleSet` + a rate rule at 2000 req/5 min per IP), Secrets Manager secrets (`qtx-ops/staging/database-url`, `/supabase-service-role-key`, `/supabase-anon-key`) wired into the task definition as `secrets`, CloudWatch log group (30-day retention), and an AWS Budget alarm at US$250/mo notifying `reetmitra8@gmail.com`.

Remote state first (`infra/bootstrap/`): S3 bucket `qtx-ops-tfstate` (versioned, SSE, public access blocked) + DynamoDB table `qtx-ops-tflock`.

```bash
cd infra/bootstrap && terraform init && terraform apply
cd ../envs/staging && terraform init && terraform plan
```

Expected: a plan that creates ~40 resources with no errors. Review it before applying — this is the one step where a typo costs money.

- [ ] **Step 8: Apply and verify the deployment**

```bash
cd infra/envs/staging && terraform apply
```

Then push the first image and verify:

```bash
curl -s https://staging.<domain>/api/health
```

Expected: `{"status":"ok","db":"ok","version":"<sha>"}`. If `db` is `error`, the task's `DATABASE_URL` secret or the Supabase network restriction (allow the NAT gateway's EIP) is wrong.

- [ ] **Step 9: Write the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: dlms } }
    services:
      postgres:
        image: postgres:15-alpine
        env: { POSTGRES_PASSWORD: testpw, POSTGRES_DB: qtx_test }
        ports: ['55432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: dlms/package-lock.json }
      - run: npm ci
      - run: npm run type-check
      - run: npm test
      - run: npx vitest run --config vitest.integration.config.ts
      - name: Secret scan
        uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
```

- [ ] **Step 10: Write the staging deploy workflow**

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy staging
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]

jobs:
  deploy:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    defaults: { run: { working-directory: dlms } }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}   # OIDC — no long-lived keys
          aws-region: ap-southeast-1
      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr
      - name: Build and push
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
        run: |
          docker build -t "$REGISTRY/qtx-ops:${{ github.sha }}" \
            --build-arg GIT_SHA=${{ github.sha }} \
            --build-arg NEXT_PUBLIC_SUPABASE_URL=${{ secrets.STAGING_SUPABASE_URL }} \
            --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=${{ secrets.STAGING_SUPABASE_ANON_KEY }} .
          docker push "$REGISTRY/qtx-ops:${{ github.sha }}"
      - name: Deploy to ECS
        run: |
          aws ecs update-service --cluster qtx-ops-staging --service web \
            --force-new-deployment --task-definition qtx-ops-staging-web
          aws ecs wait services-stable --cluster qtx-ops-staging --services web
      - name: Smoke test
        run: |
          curl --fail --silent --show-error "https://staging.${{ secrets.STAGING_DOMAIN }}/api/health" \
            | grep -q '"status":"ok"'
```

- [ ] **Step 11: Verify the pipeline end-to-end**

Push to `main` and confirm: CI green → deploy runs → `ecs wait services-stable` returns → smoke test passes. Then verify rollback works: `aws ecs update-service --cluster qtx-ops-staging --service web --task-definition qtx-ops-staging-web:<previous-revision>` and confirm the old version serves. **Record the rollback command in `docs/runbooks/RB-05-cutover.md`** — an untested rollback is not a rollback.

- [ ] **Step 12: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/infra dlms/Dockerfile dlms/.dockerignore dlms/next.config.js \
        dlms/app/api/health dlms/__tests__/platform/health.test.ts \
        dlms/.github/workflows dlms/docs/runbooks/RB-05-cutover.md
git commit -m "feat(infra): Terraform staging environment, container build, and CI/CD

ECS Fargate behind ALB + CloudFront + WAF in ap-southeast-1, deployed via OIDC
with no long-lived AWS keys. Health check pings Postgres so a database-blind
task leaves the load balancer rotation."
```

---

### Task 7: The platform shell — five module sections and permission-aware navigation

**Files:**
- Create: `modules/shared/navigation/moduleRegistry.ts`
- Create: `app/(platform)/layout.tsx`, `app/(platform)/page.tsx`
- Create: `app/(platform)/{engineering,finance,logistics,manufacturing,maintenance}/page.tsx`
- Create: `components/platform/ModuleNav.tsx`, `components/platform/ModuleLanding.tsx`, `components/platform/PermissionGate.tsx`
- Test: `__tests__/platform/navigation/moduleRegistry.test.ts`

**Interfaces:**
- Consumes: `getCurrentActor()` (Task 5); `can()`, `MODULES`, `ModuleKey`, `Actor` (Task 3).
- Produces:
  - `type ModuleDef = { key: ModuleKey; label: string; href: string; icon: string; description: string; sort: number }`.
  - `MODULE_REGISTRY: readonly ModuleDef[]` from `@/modules/shared/navigation/moduleRegistry`.
  - `visibleModules(actor: Actor): ModuleDef[]` — **pure**.
  - `<PermissionGate permission={...} module={...}>` server component that renders children only when `can()` allows.

- [ ] **Step 1: Write the failing registry test**

```typescript
// __tests__/platform/navigation/moduleRegistry.test.ts
import { describe, it, expect } from 'vitest'
import { MODULE_REGISTRY, visibleModules } from '@/modules/shared/navigation/moduleRegistry'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { Actor } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u1', roleKey: 'operator',
  permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing', 'maintenance', 'tasks']),
  active: true,
  ...over,
})

describe('MODULE_REGISTRY', () => {
  it('defines every module key exactly once', () => {
    expect(MODULE_REGISTRY.map((m) => m.key).sort()).toEqual([...MODULES].sort())
  })

  it('labels Maintenance in the singular (spec BR-1)', () => {
    expect(MODULE_REGISTRY.find((m) => m.key === 'maintenance')!.label).toBe('Maintenance')
    expect(MODULE_REGISTRY.some((m) => m.label === 'Maintenances')).toBe(false)
  })

  it('orders the five business modules alphabetically ahead of Tasks and Admin', () => {
    expect(MODULE_REGISTRY.map((m) => m.key)).toEqual([
      'engineering', 'finance', 'logistics', 'manufacturing', 'maintenance', 'tasks', 'admin',
    ])
  })
})

describe('visibleModules', () => {
  it('shows only the modules the actor may enter', () => {
    expect(visibleModules(actor()).map((m) => m.key)).toEqual(['manufacturing', 'maintenance', 'tasks'])
  })

  it('hides Admin from a user without manage_users, even with admin module access', () => {
    const a = actor({ moduleAccess: new Set(['admin', 'tasks']) })
    expect(visibleModules(a).map((m) => m.key)).toEqual(['tasks'])
  })

  it('shows Admin to a Super Admin', () => {
    const sa = actor({
      roleKey: 'super_admin',
      permissions: new Set(['view_records', 'manage_users']),
      moduleAccess: new Set(),
    })
    expect(visibleModules(sa).map((m) => m.key)).toContain('admin')
  })

  it('shows every module to a Super Admin despite empty module_access', () => {
    const sa = actor({
      roleKey: 'super_admin',
      permissions: new Set(['view_records', 'manage_users']),
      moduleAccess: new Set(),
    })
    expect(visibleModules(sa)).toHaveLength(MODULES.length)
  })

  it('shows nothing to a deactivated user', () => {
    expect(visibleModules(actor({ active: false }))).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/navigation/moduleRegistry.test.ts`
Expected: FAIL — cannot resolve `@/modules/shared/navigation/moduleRegistry`.

- [ ] **Step 3: Implement the registry**

```typescript
// modules/shared/navigation/moduleRegistry.ts
import { can } from '@/modules/shared/authz/policy'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

export type ModuleDef = {
  key: ModuleKey
  label: string
  href: string
  icon: string           // lucide-react icon name
  description: string
  /** The permission that makes this section worth showing at all. */
  gate: Permission
  sort: number
}

/**
 * The five business modules plus Tasks and Admin (spec §4.1).
 *
 * `gate` is what separates "may enter the module" from "has anything to do
 * there": Admin needs manage_users, not merely admin module access, so an
 * operator who was mistakenly given the admin module still sees nothing.
 */
export const MODULE_REGISTRY: readonly ModuleDef[] = [
  { key: 'engineering', label: 'Engineering', href: '/engineering', icon: 'Wrench',
    description: 'Change requests, failure investigations, documents, firmware.',
    gate: 'view_records', sort: 1 },
  { key: 'finance', label: 'Finance', href: '/finance', icon: 'Banknote',
    description: 'Sales invoices, buyers, approvals.', gate: 'view_records', sort: 2 },
  { key: 'logistics', label: 'Logistics', href: '/logistics', icon: 'Truck',
    description: 'Delivery orders, stock locations, shipping documents.',
    gate: 'view_records', sort: 3 },
  { key: 'manufacturing', label: 'Manufacturing', href: '/manufacturing', icon: 'Factory',
    description: 'Device registry, production pipeline, imports.', gate: 'view_records', sort: 4 },
  { key: 'maintenance', label: 'Maintenance', href: '/maintenance', icon: 'Hammer',
    description: 'Repairs, usage, modifications.', gate: 'view_records', sort: 5 },
  { key: 'tasks', label: 'Tasks', href: '/tasks', icon: 'CheckSquare',
    description: 'Everything assigned to you and your team.', gate: 'view_records', sort: 6 },
  { key: 'admin', label: 'Admin', href: '/admin', icon: 'Settings',
    description: 'Users, roles, permissions, audit, settings.', gate: 'manage_users', sort: 7 },
]

/** Pure: the modules this actor should see in the sidebar, in registry order. */
export function visibleModules(actor: Actor): ModuleDef[] {
  return MODULE_REGISTRY.filter((m) => can(actor, m.gate, m.key)).sort((a, b) => a.sort - b.sort)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/navigation/moduleRegistry.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Build the shell layout**

```tsx
// app/(platform)/layout.tsx
import { redirect } from 'next/navigation'
import { getCurrentActor } from '@/modules/shared/auth/session'
import { visibleModules } from '@/modules/shared/navigation/moduleRegistry'
import { ModuleNav } from '@/components/platform/ModuleNav'

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')

  const modules = visibleModules(actor)

  return (
    <div className="flex min-h-screen bg-slate-50">
      <ModuleNav modules={modules} />
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-white px-6">
          <span className="text-sm text-slate-500">Search — coming in week 9</span>
          <span className="text-sm font-medium text-slate-700">{actor.roleKey.replace('_', ' ')}</span>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  )
}
```

`ModuleNav` is a client component rendering the passed `modules` with `usePathname()` for the active state, lucide icons by name, and a `<nav aria-label="Modules">` landmark. Each of the five module pages renders `<ModuleLanding module={def} />` — a placeholder stating the section's purpose and its build week — **except** Manufacturing (Task 13) and Tasks (Task 12).

Each module page must also enforce access server-side, not just hide the nav link:

```tsx
// app/(platform)/engineering/page.tsx  — same shape for finance, logistics, maintenance
import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { ModuleLanding } from '@/components/platform/ModuleLanding'

export default async function EngineeringPage() {
  const actor = await requireActor()
  const def = MODULE_REGISTRY.find((m) => m.key === 'engineering')!
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, def.gate, def.key)) notFound()
  return <ModuleLanding module={def} buildWeek="Weeks 5–6" />
}
```

- [ ] **Step 6: Verify the shell renders for each role**

Run: `npm run dev` → sign in as the seeded Super Admin → confirm all seven sections appear. Then temporarily set your `module_access` to `{manufacturing}` in the DB and confirm the sidebar collapses to Manufacturing + Admin (Super Admin bypasses the module gate) — then restore it.

Run: `npm test && npm run type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/shared/navigation dlms/app/\(platform\) dlms/components/platform \
        dlms/__tests__/platform/navigation
git commit -m "feat(shell): five-module platform navigation with permission-aware sections

Module visibility is computed from the same can() rule the services enforce, and
each section re-checks access server-side — hiding a nav link is never the
control."
```

---

### Task 8: Super Admin console — users

**Files:**
- Create: `modules/admin/domain/userGuards.ts`, `modules/admin/services/userService.ts`
- Create: `app/(platform)/admin/users/page.tsx`, `app/(platform)/admin/users/actions.ts`
- Create: `components/admin/UserTable.tsx`, `components/admin/UserForm.tsx`
- Test: `__tests__/platform/admin/userGuards.test.ts`, `__tests__/integration/userService.test.ts`

**Interfaces:**
- Consumes: `authorize()`, `Actor` (Task 3); `withTransaction()` (Task 4); `recordAuthEvent()` (Task 5).
- Produces:
  - `assertNotLastSuperAdmin(input: { targetUserId: string; targetRoleKey: RoleKey; activeSuperAdminIds: string[] }): void` — **pure**, throws `LastSuperAdminError`.
  - `assertNotSelfEscalation(actor: Actor, targetUserId: string): void` — **pure**, throws `SelfEscalationError`.
  - `inviteUser(actor, input): Promise<{ userId: string }>` where `input = { email: string; fullName: string; roleKey: RoleKey; department?: string; moduleAccess: ModuleKey[] }`.
  - `setUserActive(actor, userId: string, active: boolean, version: number): Promise<void>`.
  - `updateUserAccess(actor, userId, input: { roleKey?: RoleKey; department?: string; moduleAccess?: ModuleKey[] }, version: number): Promise<void>`.

- [ ] **Step 1: Write the failing guard test**

```typescript
// __tests__/platform/admin/userGuards.test.ts
import { describe, it, expect } from 'vitest'
import {
  assertNotLastSuperAdmin, assertNotSelfEscalation,
  LastSuperAdminError, SelfEscalationError,
} from '@/modules/admin/domain/userGuards'
import type { Actor } from '@/modules/shared/authz/catalog'

const sa: Actor = {
  id: 'sa-1', roleKey: 'super_admin',
  permissions: new Set(['manage_users']), moduleAccess: new Set(['admin']), active: true,
}

describe('assertNotLastSuperAdmin', () => {
  it('blocks deactivating or demoting the only Super Admin', () => {
    expect(() => assertNotLastSuperAdmin({
      targetUserId: 'sa-1', targetRoleKey: 'super_admin', activeSuperAdminIds: ['sa-1'],
    })).toThrow(LastSuperAdminError)
  })

  it('allows it when another Super Admin remains', () => {
    expect(() => assertNotLastSuperAdmin({
      targetUserId: 'sa-1', targetRoleKey: 'super_admin', activeSuperAdminIds: ['sa-1', 'sa-2'],
    })).not.toThrow()
  })

  it('ignores non-Super-Admin targets entirely', () => {
    expect(() => assertNotLastSuperAdmin({
      targetUserId: 'op-1', targetRoleKey: 'operator', activeSuperAdminIds: ['sa-1'],
    })).not.toThrow()
  })
})

describe('assertNotSelfEscalation', () => {
  it('blocks a user changing their own role or access', () => {
    expect(() => assertNotSelfEscalation(sa, 'sa-1')).toThrow(SelfEscalationError)
  })

  it('allows acting on other users', () => {
    expect(() => assertNotSelfEscalation(sa, 'op-1')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/admin/userGuards.test.ts`
Expected: FAIL — cannot resolve `@/modules/admin/domain/userGuards`.

- [ ] **Step 3: Implement the guards**

```typescript
// modules/admin/domain/userGuards.ts
import type { Actor, RoleKey } from '@/modules/shared/authz/catalog'

export class LastSuperAdminError extends Error {
  constructor() {
    super('This is the last active Super Administrator — promote someone else first')
    this.name = 'LastSuperAdminError'
  }
}

export class SelfEscalationError extends Error {
  constructor() {
    super('You cannot change your own role or module access — ask another Super Administrator')
    this.name = 'SelfEscalationError'
  }
}

/**
 * Prevents locking everyone out of user administration (spec §3.3).
 *
 * Pure and caller-fed: the service reads the current Super Admin ids inside the
 * same transaction that performs the write, so the count cannot go stale between
 * check and commit.
 */
export function assertNotLastSuperAdmin(input: {
  targetUserId: string
  targetRoleKey: RoleKey
  activeSuperAdminIds: string[]
}): void {
  if (input.targetRoleKey !== 'super_admin') return
  const remaining = input.activeSuperAdminIds.filter((id) => id !== input.targetUserId)
  if (remaining.length === 0) throw new LastSuperAdminError()
}

/**
 * Separation of duties (spec §11.1): even a Super Admin cannot grant themselves
 * powers. Two people are always involved in a privilege change.
 */
export function assertNotSelfEscalation(actor: Actor, targetUserId: string): void {
  if (actor.id === targetUserId) throw new SelfEscalationError()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/admin/userGuards.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing service integration test**

```typescript
// __tests__/integration/userService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { setUserActive, updateUserAccess } from '@/modules/admin/services/userService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { LastSuperAdminError, SelfEscalationError } from '@/modules/admin/domain/userGuards'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let saId: string
let opId: string

const actorOf = (id: string, roleKey: Actor['roleKey'], perms: string[]): Actor => ({
  id, roleKey,
  permissions: new Set(perms as never), moduleAccess: new Set(['admin']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  saId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  opId = (await db.query(`
    INSERT INTO app_user (email, full_name, role_id, module_access, active)
    SELECT 'op@test.local', 'Op Test', r.id, ARRAY['manufacturing']::text[], true
      FROM role r WHERE r.key = 'operator' RETURNING id`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

const versionOf = async (id: string) =>
  (await db.query(`SELECT version FROM app_user WHERE id = $1`, [id])).rows[0].version

describe('userService.setUserActive', () => {
  it('refuses a caller without manage_users', async () => {
    const mgr = actorOf('mgr-1', 'manager', ['view_records'])
    await expect(setUserActive(mgr, opId, false, await versionOf(opId)))
      .rejects.toThrow(PermissionError)
  })

  it('deactivates a user and audits the change with the acting Super Admin', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await setUserActive(sa, opId, false, await versionOf(opId))

    const { rows } = await db.query(`SELECT active FROM app_user WHERE id = $1`, [opId])
    expect(rows[0].active).toBe(false)

    const audit = await db.query(
      `SELECT actor_id, changed_columns FROM audit_log
        WHERE table_name = 'app_user' AND row_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [opId])
    expect(audit.rows[0].actor_id).toBe(saId)
    expect(audit.rows[0].changed_columns).toContain('active')

    await setUserActive(sa, opId, true, await versionOf(opId))   // restore
  })

  it('rejects a stale version rather than clobbering a concurrent edit', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    const stale = (await versionOf(opId)) - 1
    await expect(setUserActive(sa, opId, false, stale)).rejects.toThrow(/modified by someone else/i)
  })

  it('refuses to deactivate the last Super Admin', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await expect(setUserActive(sa, saId, false, await versionOf(saId)))
      .rejects.toThrow(LastSuperAdminError)
  })
})

describe('userService.updateUserAccess', () => {
  it('blocks self-escalation even for a Super Admin', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await expect(updateUserAccess(sa, saId, { roleKey: 'super_admin' }, await versionOf(saId)))
      .rejects.toThrow(SelfEscalationError)
  })

  it('changes a role and module access together', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await updateUserAccess(sa, opId,
      { roleKey: 'manager', moduleAccess: ['manufacturing', 'maintenance'] }, await versionOf(opId))
    const { rows } = await db.query(
      `SELECT r.key, u.module_access FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE u.id = $1`, [opId])
    expect(rows[0].key).toBe('manager')
    expect(rows[0].module_access.sort()).toEqual(['maintenance', 'manufacturing'])
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `@/modules/admin/services/userService`.

- [ ] **Step 7: Implement the user service**

```typescript
// modules/admin/services/userService.ts
import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import { assertNotLastSuperAdmin, assertNotSelfEscalation } from '@/modules/admin/domain/userGuards'
import { MODULES, ROLES } from '@/modules/shared/authz/catalog'
import type { Actor, ModuleKey, RoleKey } from '@/modules/shared/authz/catalog'

const inviteSchema = z.object({
  email: z.string().email().max(255),
  fullName: z.string().min(1).max(200),
  roleKey: z.enum(ROLES),
  department: z.string().max(100).optional(),
  moduleAccess: z.array(z.enum(MODULES)),
})
export type InviteUserInput = z.infer<typeof inviteSchema>

/**
 * Creates the app_user row for an invited employee.
 *
 * The Supabase Auth invite is sent by the caller (server action) AFTER this
 * commits: an auth account with no app_user row is a ghost that can sign in and
 * resolve to nothing, whereas an app_user row with no auth account is simply a
 * pending invite the Super Admin can see and re-send.
 */
export async function inviteUser(actor: Actor, input: InviteUserInput): Promise<{ userId: string }> {
  authorize(actor, 'manage_users', 'admin')
  const data = inviteSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO app_user (email, full_name, role_id, department, module_access,
                             active, invited_at, created_by, updated_by)
       SELECT $1, $2, r.id, $3, $4, true, now(), $5, $5
         FROM role r WHERE r.key = $6
       RETURNING id`,
      [data.email, data.fullName, data.department ?? null, data.moduleAccess, actor.id, data.roleKey],
    )
    if (rows.length === 0) throw new Error(`Unknown role: ${data.roleKey}`)
    return { userId: rows[0].id }
  })
}

/**
 * Activates or deactivates an account.
 *
 * The Super Admin count is read INSIDE the transaction with FOR UPDATE on the
 * target so two concurrent deactivations cannot both pass the last-admin check
 * and leave the system with zero administrators.
 */
export async function setUserActive(
  actor: Actor, userId: string, active: boolean, version: number,
): Promise<void> {
  authorize(actor, 'manage_users', 'admin')

  await withTransaction(actor.id, async (tx) => {
    const target = await tx.query<{ version: number; role_key: RoleKey }>(
      `SELECT u.version, r.key AS role_key FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u`, [userId])
    if (target.rows.length === 0) throw new Error(`User ${userId} not found`)
    if (target.rows[0].version !== version) throw new OptimisticLockError('app_user', userId)

    if (!active) {
      const admins = await tx.query<{ id: string }>(
        `SELECT u.id FROM app_user u JOIN role r ON r.id = u.role_id
          WHERE r.key = 'super_admin' AND u.active AND u.deleted_at IS NULL`)
      assertNotLastSuperAdmin({
        targetUserId: userId,
        targetRoleKey: target.rows[0].role_key,
        activeSuperAdminIds: admins.rows.map((r) => r.id),
      })
    }

    await tx.query(
      `UPDATE app_user SET active = $1, updated_at = now(), updated_by = $2, version = version + 1
        WHERE id = $3`, [active, actor.id, userId])
  })
}

const accessSchema = z.object({
  roleKey: z.enum(ROLES).optional(),
  department: z.string().max(100).optional(),
  moduleAccess: z.array(z.enum(MODULES)).optional(),
})
export type UpdateAccessInput = z.infer<typeof accessSchema>

/** Changes role, department, and/or module access in one audited transaction. */
export async function updateUserAccess(
  actor: Actor, userId: string, input: UpdateAccessInput, version: number,
): Promise<void> {
  authorize(actor, 'manage_users', 'admin')
  assertNotSelfEscalation(actor, userId)
  const data = accessSchema.parse(input)

  await withTransaction(actor.id, async (tx) => {
    const target = await tx.query<{ version: number; role_key: RoleKey }>(
      `SELECT u.version, r.key AS role_key FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u`, [userId])
    if (target.rows.length === 0) throw new Error(`User ${userId} not found`)
    if (target.rows[0].version !== version) throw new OptimisticLockError('app_user', userId)

    // Demoting the last Super Admin is the same lockout as deactivating them.
    if (data.roleKey && data.roleKey !== 'super_admin') {
      const admins = await tx.query<{ id: string }>(
        `SELECT u.id FROM app_user u JOIN role r ON r.id = u.role_id
          WHERE r.key = 'super_admin' AND u.active AND u.deleted_at IS NULL`)
      assertNotLastSuperAdmin({
        targetUserId: userId,
        targetRoleKey: target.rows[0].role_key,
        activeSuperAdminIds: admins.rows.map((r) => r.id),
      })
    }

    await tx.query(
      `UPDATE app_user SET
         role_id = COALESCE((SELECT id FROM role WHERE key = $1), role_id),
         department = COALESCE($2, department),
         module_access = COALESCE($3, module_access),
         updated_at = now(), updated_by = $4, version = version + 1
       WHERE id = $5`,
      [data.roleKey ?? null, data.department ?? null, data.moduleAccess ?? null, actor.id, userId])
  })
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (6 new tests).

- [ ] **Step 9: Build the users UI**

`app/(platform)/admin/users/page.tsx` — server component: `requireActor()`, `if (!can(actor, 'manage_users', 'admin')) notFound()`, then render `<UserTable>` listing name, email, role, department, module access, status pill, MFA state, last login. Actions per row: Edit access, Activate/Deactivate (via `<ConfirmDestructive>`), Resend invite.

`app/(platform)/admin/users/actions.ts` — server actions calling the service, then `revalidatePath('/admin/users')`. The invite action calls the service first, then `supabase.auth.admin.inviteUserByEmail(email)`; the deactivate action calls `setUserActive` then `supabase.auth.admin.signOut(authUserId, 'global')` so live sessions die immediately, and `recordAuthEvent({ eventType: 'session_revoked', userId })`.

Every action maps errors to user-facing text: `PermissionError` → "You don't have permission to do that", `OptimisticLockError` → "Someone else changed this user — reload and try again", `LastSuperAdminError`/`SelfEscalationError` → their own messages (already written for users).

- [ ] **Step 10: Verify manually**

Run `npm run dev`, sign in as Super Admin, then: invite a test user (check the email arrives), edit their role and module access, deactivate them, confirm `/admin/users` shows the state, and confirm `SELECT * FROM audit_log WHERE table_name='app_user' ORDER BY occurred_at DESC LIMIT 5` attributes every change to you. Then try to deactivate yourself — expect the last-Super-Admin refusal.

- [ ] **Step 11: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/admin dlms/app/\(platform\)/admin/users dlms/components/admin \
        dlms/__tests__/platform/admin dlms/__tests__/integration/userService.test.ts
git commit -m "feat(admin): Super Admin user console with lockout and escalation guards

Invite, activate/deactivate, and access changes run in audited transactions with
optimistic locking. The last-Super-Admin count is read inside the writing
transaction, and deactivation revokes live Supabase sessions."
```

---

### Task 9: Super Admin console — roles, permissions, and overrides

**Files:**
- Create: `modules/admin/services/roleService.ts`
- Create: `app/(platform)/admin/roles/page.tsx`, `app/(platform)/admin/roles/actions.ts`
- Create: `components/admin/PermissionMatrix.tsx`
- Test: `__tests__/integration/roleService.test.ts`

**Interfaces:**
- Consumes: `authorize()` (Task 3); `withTransaction()` (Task 4).
- Produces:
  - `getMatrix(actor): Promise<{ roles: RoleRow[]; permissions: PermRow[]; grants: Record<string, string[]> }>` where `RoleRow = { id: string; key: RoleKey; name: string; isSystem: boolean }`, `PermRow = { id: string; key: Permission; name: string }`, and `grants` maps role key → permission keys.
  - `setRolePermission(actor, input: { roleKey: RoleKey; permissionKey: Permission; granted: boolean }): Promise<void>`.
  - `addOverride(actor, input: { userId: string; permissionKey: Permission; granted: boolean; reason: string; expiresAt?: Date }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/integration/roleService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { setRolePermission, addOverride } from '@/modules/admin/services/roleService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let saId: string
let targetId: string

const sa = (): Actor => ({
  id: saId, roleKey: 'super_admin',
  permissions: new Set(['manage_roles_permissions']), moduleAccess: new Set(['admin']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  saId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  targetId = (await db.query(`
    INSERT INTO app_user (email, full_name, role_id, module_access, active)
    SELECT 'ovr@test.local', 'Override Target', r.id, ARRAY['finance']::text[], true
      FROM role r WHERE r.key = 'viewer' RETURNING id`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

const grantCount = async (roleKey: string, permKey: string) =>
  (await db.query(`SELECT count(*)::int AS n FROM role_permission rp
     JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
    WHERE r.key = $1 AND p.key = $2`, [roleKey, permKey])).rows[0].n

describe('roleService.setRolePermission', () => {
  it('refuses an Admin — only a Super Admin edits the permission fabric', async () => {
    const admin: Actor = {
      id: 'a-1', roleKey: 'admin',
      permissions: new Set(['manage_users']), moduleAccess: new Set(['admin']), active: true,
    }
    await expect(setRolePermission(admin, {
      roleKey: 'viewer', permissionKey: 'export_data', granted: true,
    })).rejects.toThrow(PermissionError)
  })

  it('grants a permission to a role and audits it', async () => {
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: true })
    expect(await grantCount('viewer', 'export_data')).toBe(1)

    const audit = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name = 'role_permission'
        ORDER BY occurred_at DESC LIMIT 1`)
    expect(audit.rows[0].actor_id).toBe(saId)
  })

  it('revokes a permission from a role', async () => {
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: false })
    expect(await grantCount('viewer', 'export_data')).toBe(0)
  })

  it('is idempotent — re-granting does not create a duplicate row', async () => {
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: true })
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: true })
    expect(await grantCount('viewer', 'export_data')).toBe(1)
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: false })
  })

  it('refuses to strip manage_roles_permissions from super_admin — no self-lockout', async () => {
    await expect(setRolePermission(sa(), {
      roleKey: 'super_admin', permissionKey: 'manage_roles_permissions', granted: false,
    })).rejects.toThrow(/super administrator/i)
  })
})

describe('roleService.addOverride', () => {
  it('requires a reason of real substance', async () => {
    await expect(addOverride(sa(), {
      userId: targetId, permissionKey: 'export_data', granted: true, reason: 'x',
    })).rejects.toThrow()
  })

  it('stores a time-boxed grant override', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000)
    await addOverride(sa(), {
      userId: targetId, permissionKey: 'export_data', granted: true,
      reason: 'Covering month-end reporting while the manager is on leave', expiresAt,
    })
    const { rows } = await db.query(
      `SELECT o.granted, o.reason, o.expires_at FROM user_permission_override o
         JOIN permission p ON p.id = o.permission_id
        WHERE o.user_id = $1 AND p.key = 'export_data'`, [targetId])
    expect(rows[0].granted).toBe(true)
    expect(rows[0].expires_at).not.toBeNull()
  })

  it('replaces an existing override for the same user and permission', async () => {
    await addOverride(sa(), {
      userId: targetId, permissionKey: 'export_data', granted: false,
      reason: 'Revoked after the month-end cover ended',
    })
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, bool_and(NOT o.granted) AS all_revoked
         FROM user_permission_override o JOIN permission p ON p.id = o.permission_id
        WHERE o.user_id = $1 AND p.key = 'export_data'`, [targetId])
    expect(rows[0].n).toBe(1)
    expect(rows[0].all_revoked).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `@/modules/admin/services/roleService`.

- [ ] **Step 3: Implement the role service**

```typescript
// modules/admin/services/roleService.ts
import { z } from 'zod'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import { PERMISSIONS, ROLES } from '@/modules/shared/authz/catalog'
import type { Actor, Permission, RoleKey } from '@/modules/shared/authz/catalog'

export class FabricLockoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FabricLockoutError'
  }
}

const grantSchema = z.object({
  roleKey: z.enum(ROLES),
  permissionKey: z.enum(PERMISSIONS),
  granted: z.boolean(),
})
export type SetRolePermissionInput = z.infer<typeof grantSchema>

/**
 * Toggles one cell of the role × permission matrix.
 *
 * Idempotent by construction (ON CONFLICT DO NOTHING / DELETE), because the UI
 * is a checkbox grid and a double-click must not produce a duplicate grant or a
 * confusing error.
 *
 * The one hardcoded rule: super_admin cannot lose manage_roles_permissions. Any
 * other cell is the Super Admin's business, but that cell is the ladder they are
 * standing on.
 */
export async function setRolePermission(actor: Actor, input: SetRolePermissionInput): Promise<void> {
  authorize(actor, 'manage_roles_permissions', 'admin')
  const data = grantSchema.parse(input)

  if (data.roleKey === 'super_admin' && data.permissionKey === 'manage_roles_permissions'
      && !data.granted) {
    throw new FabricLockoutError(
      'The Super Administrator role must keep permission management — removing it would lock ' +
      'everyone out of the permission matrix permanently',
    )
  }

  await withTransaction(actor.id, async (tx) => {
    if (data.granted) {
      await tx.query(
        `INSERT INTO role_permission (role_id, permission_id, updated_by)
         SELECT r.id, p.id, $1 FROM role r, permission p WHERE r.key = $2 AND p.key = $3
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [actor.id, data.roleKey, data.permissionKey])
    } else {
      await tx.query(
        `DELETE FROM role_permission rp USING role r, permission p
          WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = $1 AND p.key = $2`,
        [data.roleKey, data.permissionKey])
    }
  })
}

const overrideSchema = z.object({
  userId: z.string().uuid(),
  permissionKey: z.enum(PERMISSIONS),
  granted: z.boolean(),
  reason: z.string().min(3).max(500),
  expiresAt: z.date().optional(),
})
export type AddOverrideInput = z.infer<typeof overrideSchema>

/**
 * Sets a per-user exception to the role matrix (spec §3.4).
 *
 * Upserts rather than appends: a user has at most one standing override per
 * permission, so the current state is always a single readable row instead of a
 * pile the reader must replay. The history of the changes lives in audit_log.
 */
export async function addOverride(actor: Actor, input: AddOverrideInput): Promise<void> {
  authorize(actor, 'manage_roles_permissions', 'admin')
  const data = overrideSchema.parse(input)

  await withTransaction(actor.id, async (tx) => {
    await tx.query(
      `INSERT INTO user_permission_override
         (user_id, permission_id, granted, reason, expires_at, created_by, updated_by)
       SELECT $1, p.id, $2, $3, $4, $5, $5 FROM permission p WHERE p.key = $6
       ON CONFLICT (user_id, permission_id) DO UPDATE SET
         granted = EXCLUDED.granted, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
         deleted_at = NULL, updated_at = now(), updated_by = EXCLUDED.updated_by,
         version = user_permission_override.version + 1`,
      [data.userId, data.granted, data.reason, data.expiresAt ?? null, actor.id, data.permissionKey])
  })
}

export type MatrixView = {
  roles: { id: string; key: RoleKey; name: string; isSystem: boolean }[]
  permissions: { id: string; key: Permission; name: string }[]
  grants: Record<string, string[]>
}

/** The full matrix for the admin grid, read in two queries. */
export async function getMatrix(actor: Actor): Promise<MatrixView> {
  authorize(actor, 'manage_roles_permissions', 'admin')
  return withTransaction(actor.id, async (tx) => {
    const roles = await tx.query<{ id: string; key: RoleKey; name: string; is_system: boolean }>(
      `SELECT id, key, name, is_system FROM role ORDER BY sort`)
    const permissions = await tx.query<{ id: string; key: Permission; name: string }>(
      `SELECT id, key, name FROM permission ORDER BY sort`)
    const grantRows = await tx.query<{ role_key: string; permission_key: string }>(
      `SELECT r.key AS role_key, p.key AS permission_key FROM role_permission rp
         JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id`)

    const grants: Record<string, string[]> = {}
    for (const row of grantRows.rows) (grants[row.role_key] ??= []).push(row.permission_key)

    return {
      roles: roles.rows.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.is_system })),
      permissions: permissions.rows,
      grants,
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (8 new tests).

- [ ] **Step 5: Build the matrix UI**

`app/(platform)/admin/roles/page.tsx` — `requireActor()`, `can(actor,'manage_roles_permissions','admin')` else `notFound()`, then `<PermissionMatrix>`: a 24-row × 6-column checkbox grid (permissions down, roles across), sticky header and first column, each cell a server-action-backed checkbox with optimistic UI and a toast on failure. Show a warning banner above the grid: *"Changes take effect on each user's next request."* The `super_admin` × `manage_roles_permissions` cell renders checked and disabled with a tooltip explaining why.

Per-user overrides live on the user detail drawer (Task 8's UI): a small list plus an "Add exception" form with permission, grant/revoke, mandatory reason, and an optional expiry date.

- [ ] **Step 6: Verify manually and confirm the guard**

Run `npm run dev`. Grant Viewer `export_data`, confirm a viewer session gains the export button on their next page load, revoke it again. Try to uncheck `super_admin` × `manage_roles_permissions` — expect the disabled cell (and confirm the service refuses it too, via the test in Step 1).

- [ ] **Step 7: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/admin/services/roleService.ts dlms/app/\(platform\)/admin/roles \
        dlms/components/admin/PermissionMatrix.tsx dlms/__tests__/integration/roleService.test.ts
git commit -m "feat(admin): editable role-permission matrix and per-user overrides

Super-Admin-only, idempotent cell toggles with one hardcoded floor: the
Super Administrator role cannot lose permission management. Overrides upsert to
one standing row per user-permission, with mandatory reasons and optional expiry."
```

---

### Task 10: Task schema and the pure task domain

**Files:**
- Create: `supabase/migrations/20260719000000_platform_tasks.sql`
- Create: `modules/shared/tasks/domain/taskStatus.ts`, `modules/shared/tasks/domain/visibility.ts`
- Test: `__tests__/platform/tasks/taskStatus.test.ts`, `__tests__/platform/tasks/visibility.test.ts`

**Interfaces:**
- Consumes: `app_user` (Task 2); `Actor`, `ModuleKey` (Task 3).
- Produces:
  - Tables `task`, `task_link`, `task_comment`.
  - `TASK_STATUSES: readonly TaskStatus[]` where `type TaskStatus = 'draft' | 'open' | 'in_progress' | 'blocked' | 'awaiting_approval' | 'completed' | 'cancelled'`.
  - `isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean` — **pure**.
  - `allowedNextTaskStatuses(from: TaskStatus): TaskStatus[]` — **pure**.
  - `isOverdue(task: { status: TaskStatus; dueDate: Date | null }, today: Date): boolean` — **pure, injectable today**.
  - `canSeeTask(actor: Actor, task: TaskVisibilityInput): boolean` — **pure**, where
    `type TaskVisibilityInput = { createdBy: string; assigneeId: string | null; confidential: boolean; linkedModules: ModuleKey[] }`.

- [ ] **Step 1: Write the failing status test**

```typescript
// __tests__/platform/tasks/taskStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  TASK_STATUSES, isValidTaskTransition, allowedNextTaskStatuses, isOverdue,
} from '@/modules/shared/tasks/domain/taskStatus'

describe('task status vocabulary (spec §4 / D28)', () => {
  it('defines the seven statuses — overdue is computed, never stored', () => {
    expect(TASK_STATUSES).toEqual([
      'draft', 'open', 'in_progress', 'blocked', 'awaiting_approval', 'completed', 'cancelled',
    ])
    expect(TASK_STATUSES).not.toContain('overdue')
  })
})

describe('isValidTaskTransition', () => {
  it('allows the normal path', () => {
    expect(isValidTaskTransition('draft', 'open')).toBe(true)
    expect(isValidTaskTransition('open', 'in_progress')).toBe(true)
    expect(isValidTaskTransition('in_progress', 'completed')).toBe(true)
  })

  it('allows blocking and unblocking mid-flight', () => {
    expect(isValidTaskTransition('in_progress', 'blocked')).toBe(true)
    expect(isValidTaskTransition('blocked', 'in_progress')).toBe(true)
  })

  it('fails closed out of terminal states', () => {
    expect(isValidTaskTransition('completed', 'in_progress')).toBe(false)
    expect(isValidTaskTransition('cancelled', 'open')).toBe(false)
  })

  it('rejects skipping straight from draft to completed', () => {
    expect(isValidTaskTransition('draft', 'completed')).toBe(false)
  })

  it('rejects a no-op transition', () => {
    expect(isValidTaskTransition('open', 'open')).toBe(false)
  })

  it('fails closed on an unknown status rather than permitting it', () => {
    expect(isValidTaskTransition('nonsense' as never, 'open')).toBe(false)
    expect(isValidTaskTransition('open', 'nonsense' as never)).toBe(false)
  })

  it('allows cancelling from any live state', () => {
    for (const s of ['draft', 'open', 'in_progress', 'blocked', 'awaiting_approval'] as const) {
      expect(isValidTaskTransition(s, 'cancelled')).toBe(true)
    }
  })
})

describe('allowedNextTaskStatuses', () => {
  it('offers exactly what the server would accept — the UI cannot present a doomed choice', () => {
    for (const from of TASK_STATUSES) {
      for (const to of allowedNextTaskStatuses(from)) {
        expect(isValidTaskTransition(from, to)).toBe(true)
      }
    }
  })

  it('offers nothing from a terminal state', () => {
    expect(allowedNextTaskStatuses('completed')).toEqual([])
    expect(allowedNextTaskStatuses('cancelled')).toEqual([])
  })
})

describe('isOverdue (injectable today — no hidden clock)', () => {
  const today = new Date('2026-07-20T09:00:00+08:00')

  it('is overdue when the due date has passed and work is live', () => {
    expect(isOverdue({ status: 'in_progress', dueDate: new Date('2026-07-19') }, today)).toBe(true)
  })

  it('is not overdue when due today', () => {
    expect(isOverdue({ status: 'open', dueDate: new Date('2026-07-20T23:59:59+08:00') }, today))
      .toBe(false)
  })

  it('is never overdue once completed or cancelled — history does not rot', () => {
    expect(isOverdue({ status: 'completed', dueDate: new Date('2026-07-01') }, today)).toBe(false)
    expect(isOverdue({ status: 'cancelled', dueDate: new Date('2026-07-01') }, today)).toBe(false)
  })

  it('is never overdue without a due date', () => {
    expect(isOverdue({ status: 'open', dueDate: null }, today)).toBe(false)
  })

  it('is not overdue while still a draft — an unsent task is nobody’s problem', () => {
    expect(isOverdue({ status: 'draft', dueDate: new Date('2026-07-01') }, today)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/tasks/taskStatus.test.ts`
Expected: FAIL — cannot resolve `@/modules/shared/tasks/domain/taskStatus`.

- [ ] **Step 3: Implement the status domain**

```typescript
// modules/shared/tasks/domain/taskStatus.ts
/**
 * Task lifecycle (spec §4 / D28).
 *
 * "Overdue" is deliberately NOT a status: it is a function of the due date and
 * the clock, so storing it would need a nightly job to keep the table honest and
 * would still be wrong between runs. isOverdue() computes it at read time.
 *
 * The graph is a hardcoded constant, unlike device statuses (which are an
 * admin-editable vocabulary), because task states are platform mechanics rather
 * than business vocabulary — no admin should be able to invent one.
 */
export const TASK_STATUSES = [
  'draft', 'open', 'in_progress', 'blocked', 'awaiting_approval', 'completed', 'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['blocked', 'awaiting_approval', 'completed', 'cancelled'],
  blocked: ['in_progress', 'open', 'cancelled'],
  awaiting_approval: ['completed', 'in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** Fails closed: an unknown source or target is never permitted. */
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function allowedNextTaskStatuses(from: TaskStatus): TaskStatus[] {
  return [...(TRANSITIONS[from] ?? [])]
}

const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'open', 'in_progress', 'blocked', 'awaiting_approval',
])

/**
 * `today` is injected rather than read from the clock so the rule is testable and
 * so a server rendering in UTC agrees with a user reading in SGT — the caller
 * decides which day "today" is.
 */
export function isOverdue(
  task: { status: TaskStatus; dueDate: Date | null },
  today: Date,
): boolean {
  if (!task.dueDate) return false
  if (!LIVE_STATUSES.has(task.status)) return false
  return task.dueDate.getTime() < today.getTime()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/tasks/taskStatus.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Write the failing visibility test**

```typescript
// __tests__/platform/tasks/visibility.test.ts
import { describe, it, expect } from 'vitest'
import { canSeeTask } from '@/modules/shared/tasks/domain/visibility'
import type { Actor } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u1', roleKey: 'operator',
  permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

const task = (over = {}) => ({
  createdBy: 'someone-else',
  assigneeId: null as string | null,
  confidential: false,
  linkedModules: [] as never[],
  ...over,
})

describe('canSeeTask (spec §8.3)', () => {
  it('shows an ordinary unlinked task to any authenticated user', () => {
    expect(canSeeTask(actor(), task())).toBe(true)
  })

  it('hides a confidential task from an uninvolved user', () => {
    expect(canSeeTask(actor(), task({ confidential: true }))).toBe(false)
  })

  it('shows a confidential task to its creator', () => {
    expect(canSeeTask(actor(), task({ confidential: true, createdBy: 'u1' }))).toBe(true)
  })

  it('shows a confidential task to its assignee', () => {
    expect(canSeeTask(actor(), task({ confidential: true, assigneeId: 'u1' }))).toBe(true)
  })

  it('shows a confidential task to an Admin', () => {
    expect(canSeeTask(actor({ roleKey: 'admin' }), task({ confidential: true }))).toBe(true)
  })

  it('shows a confidential task to a Super Admin', () => {
    expect(canSeeTask(actor({ roleKey: 'super_admin' }), task({ confidential: true }))).toBe(true)
  })

  it('hides a Finance-linked task from a user without Finance access', () => {
    expect(canSeeTask(actor(), task({ linkedModules: ['finance'] }))).toBe(false)
  })

  it('shows a Finance-linked task to a user with Finance access', () => {
    const fin = actor({ roleKey: 'finance', moduleAccess: new Set(['finance', 'tasks']) })
    expect(canSeeTask(fin, task({ linkedModules: ['finance'] }))).toBe(true)
  })

  it('hides a task linked to ANY inaccessible module, not just Finance', () => {
    expect(canSeeTask(actor(), task({ linkedModules: ['manufacturing', 'engineering'] }))).toBe(false)
  })

  it('shows a task when every linked module is accessible', () => {
    expect(canSeeTask(actor(), task({ linkedModules: ['manufacturing'] }))).toBe(true)
  })

  it('lets a Super Admin see a task linked to a module they lack access to', () => {
    const sa = actor({ roleKey: 'super_admin', moduleAccess: new Set() })
    expect(canSeeTask(sa, task({ linkedModules: ['finance'] }))).toBe(true)
  })

  it('hides everything from a deactivated user, including their own tasks', () => {
    expect(canSeeTask(actor({ active: false }), task({ createdBy: 'u1' }))).toBe(false)
  })

  it('hides a confidential Finance task from an involved user without Finance access', () => {
    // Both rules apply; the module gate is not waived by involvement.
    expect(canSeeTask(actor(), task({ confidential: true, createdBy: 'u1', linkedModules: ['finance'] })))
      .toBe(false)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/tasks/visibility.test.ts`
Expected: FAIL — cannot resolve `@/modules/shared/tasks/domain/visibility`.

- [ ] **Step 7: Implement the visibility rule**

```typescript
// modules/shared/tasks/domain/visibility.ts
import type { Actor, ModuleKey } from '@/modules/shared/authz/catalog'

export type TaskVisibilityInput = {
  createdBy: string
  assigneeId: string | null
  confidential: boolean
  /** Modules of every record this task links to. Empty = unlinked, visible to all. */
  linkedModules: ModuleKey[]
}

/**
 * Whether this actor may see this task (spec §8.3).
 *
 * Two independent gates, both of which must pass:
 *
 *   1. Confidentiality — a confidential task is visible only to its creator, its
 *      assignee, and Admins.
 *   2. Link-derived module access — a task linked to a Finance record is as
 *      sensitive as that record, so it inherits the module gate. This is why the
 *      rule takes linkedModules rather than a single module: a task linked to
 *      both a device and an invoice needs BOTH.
 *
 * Involvement does not waive the module gate: being the assignee of a
 * finance-linked task does not grant sight of finance data. If that combination
 * arises, the fix is granting the user Finance access, not weakening the rule.
 *
 * Pure and list-shaped so the service can apply the identical rule to a single
 * task, a list page, and a search autocomplete — search must never surface a task
 * the detail page would refuse (spec §15).
 */
export function canSeeTask(actor: Actor, task: TaskVisibilityInput): boolean {
  if (!actor.active) return false

  const isPrivileged = actor.roleKey === 'super_admin' || actor.roleKey === 'admin'

  if (!isPrivileged) {
    for (const m of task.linkedModules) {
      if (!actor.moduleAccess.has(m)) return false
    }
  }

  if (task.confidential) {
    const involved = actor.id === task.createdBy || actor.id === task.assigneeId
    if (!involved && !isPrivileged) return false
  }

  return true
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/tasks/visibility.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 9: Write the task schema migration**

```sql
-- supabase/migrations/20260719000000_platform_tasks.sql
-- Collaborative tasks (spec §4 / D28). One task system, surfaced in four places:
-- personal dashboard, module tabs, record panels, and the central task centre.
CREATE TABLE task (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description  text,                       -- bilingual free text, preserved verbatim
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('draft','open','in_progress','blocked',
                                 'awaiting_approval','completed','cancelled')),
  priority     text NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low','normal','high','urgent')),
  due_date     timestamptz,
  assignee_id  uuid REFERENCES app_user(id),
  department   text,                       -- team queue when no individual is named
  confidential boolean NOT NULL DEFAULT false,
  blocked_reason text,
  parent_task_id uuid REFERENCES task(id), -- subtasks / checklists
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES app_user(id),
  deleted_at   timestamptz,
  version      integer NOT NULL DEFAULT 1,
  -- A blocked task must say why: an unexplained blocker is a task nobody can unblock.
  CONSTRAINT blocked_needs_reason CHECK (
    status <> 'blocked' OR (blocked_reason IS NOT NULL AND char_length(blocked_reason) > 0)),
  CONSTRAINT completed_has_timestamp CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT no_self_parent CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);
COMMENT ON TABLE task IS
  'Collaborative tasks across every module. "Overdue" is computed from due_date at read time, never stored.';
COMMENT ON COLUMN task.confidential IS
  'When true, visible only to creator, assignee, and Admins (see modules/shared/tasks/domain/visibility.ts).';

CREATE INDEX task_assignee_idx ON task(assignee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX task_department_idx ON task(department, status) WHERE deleted_at IS NULL;
CREATE INDEX task_due_idx ON task(due_date)
  WHERE deleted_at IS NULL AND status IN ('open','in_progress','blocked','awaiting_approval');
CREATE INDEX task_parent_idx ON task(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX task_title_trgm ON task USING gin (title gin_trgm_ops);

-- Polymorphic link to any record in any module (spec §6.1).
CREATE TABLE task_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  entity_type text NOT NULL,   -- 'device' | 'repair' | 'sales_invoice' | 'delivery_order' | ...
  entity_id   uuid NOT NULL,
  module      text NOT NULL CHECK (module IN
              ('engineering','finance','logistics','manufacturing','maintenance','tasks','admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES app_user(id),
  UNIQUE (task_id, entity_type, entity_id)
);
COMMENT ON COLUMN task_link.module IS
  'Denormalized owning module. Stored so task visibility can be filtered in ONE query without joining every entity table.';
CREATE INDEX task_link_entity_idx ON task_link(entity_type, entity_id);
CREATE INDEX task_link_task_idx ON task_link(task_id);

-- Append-only discussion.
CREATE TABLE task_comment (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  edited_at  timestamptz
);
CREATE INDEX task_comment_task_idx ON task_comment(task_id, created_at);

-- Comments are append-only: the trail of a discussion is evidence.
CREATE OR REPLACE FUNCTION fn_task_comment_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task_comment is append-only — comments cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.body IS DISTINCT FROM NEW.body AND NEW.edited_at IS NULL THEN
    RAISE EXCEPTION 'editing a comment must stamp edited_at' USING ERRCODE = '23514';
  END IF;
  IF OLD.task_id <> NEW.task_id OR OLD.created_by <> NEW.created_by THEN
    RAISE EXCEPTION 'a comment cannot change task or author' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_task_comment_guard BEFORE UPDATE OR DELETE ON task_comment
  FOR EACH ROW EXECUTE FUNCTION fn_task_comment_guard();

SELECT fn_attach_audit(t) FROM unnest(ARRAY['task','task_link','task_comment']) AS t;
```

- [ ] **Step 10: Write and run the schema constraint test**

```typescript
// __tests__/integration/taskSchema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let userId: string

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => { await db.end() })

const newTask = async (over: Record<string, unknown> = {}) => {
  const cols = { title: 'Probe', status: 'open', created_by: userId, ...over }
  const keys = Object.keys(cols)
  const { rows } = await db.query(
    `INSERT INTO task (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})
     RETURNING id`, Object.values(cols))
  return rows[0].id
}

describe('task schema constraints', () => {
  it('refuses a blocked task with no blocker reason', async () => {
    await expect(newTask({ status: 'blocked' })).rejects.toThrow(/blocked_needs_reason/)
  })

  it('accepts a blocked task that explains itself', async () => {
    await expect(newTask({ status: 'blocked', blocked_reason: 'Waiting on the PCBA shipment' }))
      .resolves.toBeTruthy()
  })

  it('refuses a completed task with no completion timestamp', async () => {
    await expect(newTask({ status: 'completed' })).rejects.toThrow(/completed_has_timestamp/)
  })

  it('refuses a completion timestamp on a task that is not completed', async () => {
    await expect(newTask({ status: 'open', completed_at: new Date() }))
      .rejects.toThrow(/completed_has_timestamp/)
  })

  it('refuses a task that is its own parent', async () => {
    const id = await newTask()
    await expect(db.query(`UPDATE task SET parent_task_id = id WHERE id = $1`, [id]))
      .rejects.toThrow(/no_self_parent/)
  })

  it('refuses to delete a comment — the discussion trail is append-only', async () => {
    const taskId = await newTask()
    await db.query(`INSERT INTO task_comment (task_id, body, created_by) VALUES ($1, 'hi', $2)`,
      [taskId, userId])
    await expect(db.query(`DELETE FROM task_comment WHERE task_id = $1`, [taskId]))
      .rejects.toThrow(/append-only/)
  })

  it('refuses a silent comment edit', async () => {
    const taskId = await newTask()
    await db.query(`INSERT INTO task_comment (task_id, body, created_by) VALUES ($1, 'original', $2)`,
      [taskId, userId])
    await expect(db.query(`UPDATE task_comment SET body = 'rewritten' WHERE task_id = $1`, [taskId]))
      .rejects.toThrow(/edited_at/)
  })

  it('allows an edit that stamps edited_at', async () => {
    const taskId = await newTask()
    await db.query(`INSERT INTO task_comment (task_id, body, created_by) VALUES ($1, 'original', $2)`,
      [taskId, userId])
    await expect(db.query(
      `UPDATE task_comment SET body = 'corrected', edited_at = now() WHERE task_id = $1`, [taskId]))
      .resolves.toBeTruthy()
  })

  it('refuses a task_link to an unknown module', async () => {
    const taskId = await newTask()
    await expect(db.query(
      `INSERT INTO task_link (task_id, entity_type, entity_id, module, created_by)
       VALUES ($1, 'device', gen_random_uuid(), 'accounting', $2)`, [taskId, userId]))
      .rejects.toThrow()
  })
})
```

Run: `npm run test:integration`
Expected: PASS (9 tests). Apply both migration files to the cloud staging project (MCP `apply_migration`) before moving on.

- [ ] **Step 11: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/supabase/migrations/20260719000000_platform_tasks.sql \
        dlms/modules/shared/tasks/domain dlms/__tests__/platform/tasks \
        dlms/__tests__/integration/taskSchema.test.ts
git commit -m "feat(tasks): task schema and pure lifecycle/visibility domain

Overdue is computed from due_date rather than stored. Visibility applies two
independent gates — confidentiality and link-derived module access — as one pure
rule shared by detail pages, lists, and search."
```

---

### Task 11: Task service — create, assign, transition, comment, link

**Files:**
- Create: `modules/shared/tasks/services/taskService.ts`
- Test: `__tests__/integration/taskService.test.ts`

**Interfaces:**
- Consumes: `authorize()` (Task 3); `withTransaction()`, `OptimisticLockError` (Task 4); `isValidTaskTransition`, `isOverdue`, `canSeeTask`, `TaskStatus` (Task 10).
- Produces:
  - `createTask(actor, input: CreateTaskInput): Promise<{ taskId: string }>` where `CreateTaskInput = { title: string; description?: string; priority?: 'low'|'normal'|'high'|'urgent'; dueDate?: Date; assigneeId?: string; department?: string; confidential?: boolean; parentTaskId?: string; links?: { entityType: string; entityId: string; module: ModuleKey }[]; status?: 'draft'|'open' }`.
  - `changeTaskStatus(actor, taskId, to: TaskStatus, version: number, opts?: { blockedReason?: string }): Promise<void>`.
  - `assignTask(actor, taskId, assigneeId: string | null, version: number): Promise<void>`.
  - `addComment(actor, taskId, body: string): Promise<{ commentId: string }>`.
  - `listTasksFor(actor, filter: TaskFilter): Promise<TaskListItem[]>` where `TaskFilter = { scope: 'mine' | 'department' | 'all'; status?: TaskStatus[]; module?: ModuleKey; entityRef?: { entityType: string; entityId: string }; overdueOnly?: boolean }` and `TaskListItem = { id: string; title: string; status: TaskStatus; priority: string; dueDate: Date | null; assigneeId: string | null; assigneeName: string | null; overdue: boolean; links: { entityType: string; entityId: string; module: ModuleKey }[] }`.
  - `getTask(actor, taskId): Promise<TaskDetail | null>` — returns **null** (→ 404) when `canSeeTask` refuses, never a 403.

- [ ] **Step 1: Write the failing service test**

```typescript
// __tests__/integration/taskService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  createTask, changeTaskStatus, assignTask, addComment, listTasksFor, getTask,
} from '@/modules/shared/tasks/services/taskService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let opId: string
let finId: string

const op = (): Actor => ({
  id: opId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'assign_tasks']),
  moduleAccess: new Set(['manufacturing', 'tasks']), active: true,
})
const viewer = (): Actor => ({
  id: opId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing', 'tasks']),
  active: true,
})
const fin = (): Actor => ({
  id: finId, roleKey: 'finance',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'assign_tasks']),
  moduleAccess: new Set(['finance', 'tasks']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  opId = (await db.query(`
    INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
    SELECT 'tsvc-op@test.local', 'Task Op', r.id, 'Manufacturing',
           ARRAY['manufacturing','tasks']::text[], true
      FROM role r WHERE r.key = 'operator' RETURNING id`)).rows[0].id
  finId = (await db.query(`
    INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
    SELECT 'tsvc-fin@test.local', 'Task Fin', r.id, 'Finance',
           ARRAY['finance','tasks']::text[], true
      FROM role r WHERE r.key = 'finance' RETURNING id`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

const versionOf = async (id: string) =>
  (await db.query(`SELECT version FROM task WHERE id = $1`, [id])).rows[0].version

describe('createTask', () => {
  it('refuses a Viewer — read-only means read-only', async () => {
    await expect(createTask(viewer(), { title: 'Nope' })).rejects.toThrow(PermissionError)
  })

  it('creates an open task attributed to its author', async () => {
    const { taskId } = await createTask(op(), { title: 'Check PCBA stock', priority: 'high' })
    const { rows } = await db.query(`SELECT title, status, priority, created_by FROM task WHERE id = $1`,
      [taskId])
    expect(rows[0]).toMatchObject({
      title: 'Check PCBA stock', status: 'open', priority: 'high', created_by: opId,
    })
  })

  it('creates task and links atomically', async () => {
    const deviceId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id
    const { taskId } = await createTask(op(), {
      title: 'Inspect device',
      links: [{ entityType: 'device', entityId: deviceId, module: 'manufacturing' }],
    })
    const { rows } = await db.query(`SELECT entity_type, module FROM task_link WHERE task_id = $1`,
      [taskId])
    expect(rows).toEqual([{ entity_type: 'device', module: 'manufacturing' }])
  })

  it('rolls back the task when a link is invalid — no orphan task survives', async () => {
    await expect(createTask(op(), {
      title: 'Bad link',
      links: [{ entityType: 'device', entityId: 'not-a-uuid' as never, module: 'manufacturing' }],
    })).rejects.toThrow()
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM task WHERE title = 'Bad link'`)
    expect(rows[0].n).toBe(0)
  })

  it('refuses to link into a module the actor cannot access', async () => {
    await expect(createTask(op(), {
      title: 'Sneaky finance link',
      links: [{ entityType: 'sales_invoice', entityId: crypto.randomUUID(), module: 'finance' }],
    })).rejects.toThrow(PermissionError)
  })
})

describe('changeTaskStatus', () => {
  it('walks the normal path', async () => {
    const { taskId } = await createTask(op(), { title: 'Walk the path' })
    await changeTaskStatus(op(), taskId, 'in_progress', await versionOf(taskId))
    await changeTaskStatus(op(), taskId, 'completed', await versionOf(taskId))
    const { rows } = await db.query(`SELECT status, completed_at FROM task WHERE id = $1`, [taskId])
    expect(rows[0].status).toBe('completed')
    expect(rows[0].completed_at).not.toBeNull()   // service stamps it, not the caller
  })

  it('rejects an illegal transition', async () => {
    const { taskId } = await createTask(op(), { title: 'Illegal move' })
    await expect(changeTaskStatus(op(), taskId, 'completed', await versionOf(taskId)))
      .rejects.toThrow(/cannot move/i)
  })

  it('requires a reason when blocking', async () => {
    const { taskId } = await createTask(op(), { title: 'Block me' })
    await changeTaskStatus(op(), taskId, 'in_progress', await versionOf(taskId))
    await expect(changeTaskStatus(op(), taskId, 'blocked', await versionOf(taskId)))
      .rejects.toThrow(/reason/i)
    await expect(changeTaskStatus(op(), taskId, 'blocked', await versionOf(taskId),
      { blockedReason: 'Waiting on supplier' })).resolves.toBeUndefined()
  })

  it('clears the blocker when unblocking', async () => {
    const { taskId } = await createTask(op(), { title: 'Unblock me' })
    await changeTaskStatus(op(), taskId, 'in_progress', await versionOf(taskId))
    await changeTaskStatus(op(), taskId, 'blocked', await versionOf(taskId),
      { blockedReason: 'Waiting on parts' })
    await changeTaskStatus(op(), taskId, 'in_progress', await versionOf(taskId))
    const { rows } = await db.query(`SELECT blocked_reason FROM task WHERE id = $1`, [taskId])
    expect(rows[0].blocked_reason).toBeNull()
  })

  it('rejects a stale version', async () => {
    const { taskId } = await createTask(op(), { title: 'Concurrent' })
    const v = await versionOf(taskId)
    await changeTaskStatus(op(), taskId, 'in_progress', v)
    await expect(changeTaskStatus(op(), taskId, 'completed', v))
      .rejects.toThrow(/modified by someone else/i)
  })

  it('refuses a task the actor cannot see — 404 semantics, not 403', async () => {
    const { taskId } = await createTask(op(), { title: 'Private', confidential: true })
    await expect(changeTaskStatus(fin(), taskId, 'in_progress', await versionOf(taskId)))
      .rejects.toThrow(/not found/i)
  })
})

describe('assignTask + addComment', () => {
  it('assigns and audits the reassignment', async () => {
    const { taskId } = await createTask(op(), { title: 'Assign me' })
    await assignTask(op(), taskId, finId, await versionOf(taskId))
    const { rows } = await db.query(`SELECT assignee_id FROM task WHERE id = $1`, [taskId])
    expect(rows[0].assignee_id).toBe(finId)

    const audit = await db.query(
      `SELECT changed_columns FROM audit_log WHERE table_name = 'task' AND row_id = $1
        ORDER BY occurred_at DESC LIMIT 1`, [taskId])
    expect(audit.rows[0].changed_columns).toContain('assignee_id')
  })

  it('refuses assignment without assign_tasks', async () => {
    const { taskId } = await createTask(op(), { title: 'No assign' })
    await expect(assignTask(viewer(), taskId, finId, await versionOf(taskId)))
      .rejects.toThrow(PermissionError)
  })

  it('adds a comment attributed to its author', async () => {
    const { taskId } = await createTask(op(), { title: 'Discuss' })
    const { commentId } = await addComment(op(), taskId, 'Checked the shelf — none left')
    const { rows } = await db.query(`SELECT body, created_by FROM task_comment WHERE id = $1`,
      [commentId])
    expect(rows[0]).toMatchObject({ body: 'Checked the shelf — none left', created_by: opId })
  })

  it('preserves Chinese comment text verbatim', async () => {
    const { taskId } = await createTask(op(), { title: 'Bilingual' })
    const { commentId } = await addComment(op(), taskId, '电源板没有输出 — 需要更换')
    const { rows } = await db.query(`SELECT body FROM task_comment WHERE id = $1`, [commentId])
    expect(rows[0].body).toBe('电源板没有输出 — 需要更换')
  })
})

describe('listTasksFor + getTask', () => {
  it('scopes "mine" to the actor', async () => {
    const { taskId } = await createTask(op(), { title: 'Mine only', assigneeId: opId })
    const list = await listTasksFor(op(), { scope: 'mine' })
    expect(list.some((t) => t.id === taskId)).toBe(true)
    expect(list.every((t) => t.assigneeId === opId)).toBe(true)
  })

  it('marks an overdue task without storing the state', async () => {
    const { taskId } = await createTask(op(), {
      title: 'Late', assigneeId: opId, dueDate: new Date(Date.now() - 86_400_000),
    })
    const list = await listTasksFor(op(), { scope: 'mine', overdueOnly: true })
    expect(list.find((t) => t.id === taskId)?.overdue).toBe(true)
  })

  it('hides a confidential task from an uninvolved user in list AND detail', async () => {
    const { taskId } = await createTask(op(), { title: 'Secret', confidential: true })
    const list = await listTasksFor(fin(), { scope: 'all' })
    expect(list.some((t) => t.id === taskId)).toBe(false)
    expect(await getTask(fin(), taskId)).toBeNull()
  })

  it('hides a finance-linked task from a user without finance access', async () => {
    const { taskId } = await createTask(fin(), {
      title: 'Invoice follow-up',
      links: [{ entityType: 'sales_invoice', entityId: crypto.randomUUID(), module: 'finance' }],
    })
    const list = await listTasksFor(op(), { scope: 'all' })
    expect(list.some((t) => t.id === taskId)).toBe(false)
    expect(await getTask(op(), taskId)).toBeNull()
  })

  it('filters by linked record for a device task panel', async () => {
    const deviceId = crypto.randomUUID()
    const { taskId } = await createTask(op(), {
      title: 'Device panel task',
      links: [{ entityType: 'device', entityId: deviceId, module: 'manufacturing' }],
    })
    const list = await listTasksFor(op(), {
      scope: 'all', entityRef: { entityType: 'device', entityId: deviceId },
    })
    expect(list.map((t) => t.id)).toEqual([taskId])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `@/modules/shared/tasks/services/taskService`.

- [ ] **Step 3: Implement the task service**

```typescript
// modules/shared/tasks/services/taskService.ts
import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize, PermissionError } from '@/modules/shared/authz/authorize'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { Actor, ModuleKey } from '@/modules/shared/authz/catalog'
import { isValidTaskTransition, isOverdue, TASK_STATUSES, type TaskStatus }
  from '@/modules/shared/tasks/domain/taskStatus'
import { canSeeTask } from '@/modules/shared/tasks/domain/visibility'

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} not found`)
    this.name = 'TaskNotFoundError'
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`A task cannot move from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}`)
    this.name = 'InvalidTransitionError'
  }
}

const linkSchema = z.object({
  entityType: z.string().min(1).max(50),
  entityId: z.string().uuid(),
  module: z.enum(MODULES),
})

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueDate: z.date().optional(),
  assigneeId: z.string().uuid().optional(),
  department: z.string().max(100).optional(),
  confidential: z.boolean().default(false),
  parentTaskId: z.string().uuid().optional(),
  links: z.array(linkSchema).max(20).default([]),
  status: z.enum(['draft', 'open']).default('open'),
})
export type CreateTaskInput = z.input<typeof createSchema>

/**
 * Creates a task and its record links in ONE transaction.
 *
 * The links are the reason this is transactional: a task that exists without the
 * link that gives it context is worse than no task, because it appears in the
 * central list with nothing to act on and appears on no record panel at all.
 */
export async function createTask(actor: Actor, input: CreateTaskInput): Promise<{ taskId: string }> {
  authorize(actor, 'create_records', 'tasks')
  const data = createSchema.parse(input)

  // You cannot link a task into a module you cannot enter — that would let an
  // outsider create a visible handle on a record they can't see.
  for (const link of data.links) {
    if (!moduleAllowed(actor, link.module)) throw new PermissionError('view_records', link.module)
  }

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO task (title, description, status, priority, due_date, assignee_id,
                         department, confidential, parent_task_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [data.title, data.description ?? null, data.status, data.priority, data.dueDate ?? null,
       data.assigneeId ?? null, data.department ?? null, data.confidential,
       data.parentTaskId ?? null, actor.id])
    const taskId = rows[0].id

    for (const link of data.links) {
      await tx.query(
        `INSERT INTO task_link (task_id, entity_type, entity_id, module, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [taskId, link.entityType, link.entityId, link.module, actor.id])
    }
    return { taskId }
  })
}

function moduleAllowed(actor: Actor, module: ModuleKey): boolean {
  return actor.roleKey === 'super_admin' || actor.moduleAccess.has(module)
}

/** Loads a task's visibility inputs inside an open transaction, locking the row. */
async function loadForWrite(tx: Tx, taskId: string) {
  const { rows } = await tx.query<{
    id: string; status: TaskStatus; version: number; created_by: string
    assignee_id: string | null; confidential: boolean; linked_modules: ModuleKey[]
  }>(
    `SELECT t.id, t.status, t.version, t.created_by, t.assignee_id, t.confidential,
            COALESCE((SELECT array_agg(DISTINCT l.module) FROM task_link l WHERE l.task_id = t.id),
                     '{}') AS linked_modules
       FROM task t WHERE t.id = $1 AND t.deleted_at IS NULL FOR UPDATE OF t`, [taskId])
  return rows[0] ?? null
}

const toVisibility = (row: NonNullable<Awaited<ReturnType<typeof loadForWrite>>>) => ({
  createdBy: row.created_by,
  assigneeId: row.assignee_id,
  confidential: row.confidential,
  linkedModules: row.linked_modules,
})

/**
 * Moves a task through its lifecycle.
 *
 * Invisible tasks raise TaskNotFoundError rather than PermissionError: a user who
 * cannot see a task must not learn it exists by being told they lack permission
 * to touch it (spec §7.3).
 */
export async function changeTaskStatus(
  actor: Actor, taskId: string, to: TaskStatus, version: number,
  opts: { blockedReason?: string } = {},
): Promise<void> {
  authorize(actor, 'edit_records', 'tasks')
  if (!TASK_STATUSES.includes(to)) throw new Error(`Unknown status: ${to}`)

  await withTransaction(actor.id, async (tx) => {
    const row = await loadForWrite(tx, taskId)
    if (!row || !canSeeTask(actor, toVisibility(row))) throw new TaskNotFoundError(taskId)
    if (row.version !== version) throw new OptimisticLockError('task', taskId)
    if (!isValidTaskTransition(row.status, to)) throw new InvalidTransitionError(row.status, to)
    if (to === 'blocked' && !opts.blockedReason?.trim()) {
      throw new Error('Blocking a task needs a reason so someone can unblock it')
    }

    await tx.query(
      `UPDATE task SET
         status = $1,
         blocked_reason = CASE WHEN $1 = 'blocked' THEN $2 ELSE NULL END,
         completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE NULL END,
         updated_at = now(), updated_by = $3, version = version + 1
       WHERE id = $4`,
      [to, opts.blockedReason ?? null, actor.id, taskId])
  })
}

/** Assigns or unassigns (null). Reassignment is audited by the fn_audit trigger. */
export async function assignTask(
  actor: Actor, taskId: string, assigneeId: string | null, version: number,
): Promise<void> {
  authorize(actor, 'assign_tasks', 'tasks')

  await withTransaction(actor.id, async (tx) => {
    const row = await loadForWrite(tx, taskId)
    if (!row || !canSeeTask(actor, toVisibility(row))) throw new TaskNotFoundError(taskId)
    if (row.version !== version) throw new OptimisticLockError('task', taskId)

    if (assigneeId) {
      const { rows } = await tx.query(
        `SELECT 1 FROM app_user WHERE id = $1 AND active AND deleted_at IS NULL`, [assigneeId])
      if (rows.length === 0) throw new Error('That user is not an active employee')
    }

    await tx.query(
      `UPDATE task SET assignee_id = $1, updated_at = now(), updated_by = $2, version = version + 1
        WHERE id = $3`, [assigneeId, actor.id, taskId])
  })
}

export async function addComment(
  actor: Actor, taskId: string, body: string,
): Promise<{ commentId: string }> {
  authorize(actor, 'view_records', 'tasks')
  const text = z.string().min(1).max(5000).parse(body)

  return withTransaction(actor.id, async (tx) => {
    const row = await loadForWrite(tx, taskId)
    if (!row || !canSeeTask(actor, toVisibility(row))) throw new TaskNotFoundError(taskId)

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO task_comment (task_id, body, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [taskId, text, actor.id])
    return { commentId: rows[0].id }
  })
}

export type TaskFilter = {
  scope: 'mine' | 'department' | 'all'
  status?: TaskStatus[]
  module?: ModuleKey
  entityRef?: { entityType: string; entityId: string }
  overdueOnly?: boolean
}

export type TaskListItem = {
  id: string
  title: string
  status: TaskStatus
  priority: string
  dueDate: Date | null
  assigneeId: string | null
  assigneeName: string | null
  overdue: boolean
  links: { entityType: string; entityId: string; module: ModuleKey }[]
}

/**
 * The one query behind every task surface: My Tasks, module tabs, the central
 * centre, and record panels.
 *
 * Visibility is applied in TypeScript via canSeeTask rather than in SQL, so the
 * list and the detail page can never disagree about what a user may see — there
 * is exactly one rule, and it lives in the domain module.
 */
export async function listTasksFor(actor: Actor, filter: TaskFilter): Promise<TaskListItem[]> {
  authorize(actor, 'view_records', 'tasks')

  return withTransaction(actor.id, async (tx) => {
    const conditions: string[] = ['t.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (filter.scope === 'mine') conditions.push(`t.assignee_id = ${p(actor.id)}`)
    if (filter.scope === 'department') {
      conditions.push(`t.department = (SELECT department FROM app_user WHERE id = ${p(actor.id)})`)
    }
    if (filter.status?.length) conditions.push(`t.status = ANY(${p(filter.status)})`)
    if (filter.entityRef) {
      conditions.push(`EXISTS (SELECT 1 FROM task_link l WHERE l.task_id = t.id
        AND l.entity_type = ${p(filter.entityRef.entityType)}
        AND l.entity_id = ${p(filter.entityRef.entityId)})`)
    }
    if (filter.module) {
      conditions.push(`EXISTS (SELECT 1 FROM task_link l WHERE l.task_id = t.id
        AND l.module = ${p(filter.module)})`)
    }

    const { rows } = await tx.query<{
      id: string; title: string; status: TaskStatus; priority: string
      due_date: Date | null; assignee_id: string | null; assignee_name: string | null
      created_by: string; confidential: boolean
      links: { entityType: string; entityId: string; module: ModuleKey }[] | null
      linked_modules: ModuleKey[]
    }>(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date, t.assignee_id,
              a.full_name AS assignee_name, t.created_by, t.confidential,
              (SELECT json_agg(json_build_object('entityType', l.entity_type,
                                                 'entityId', l.entity_id,
                                                 'module', l.module))
                 FROM task_link l WHERE l.task_id = t.id) AS links,
              COALESCE((SELECT array_agg(DISTINCT l.module) FROM task_link l WHERE l.task_id = t.id),
                       '{}') AS linked_modules
         FROM task t
         LEFT JOIN app_user a ON a.id = t.assignee_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.due_date NULLS LAST, t.created_at DESC
        LIMIT 200`, params)

    const now = new Date()
    return rows
      .filter((r) => canSeeTask(actor, {
        createdBy: r.created_by, assigneeId: r.assignee_id,
        confidential: r.confidential, linkedModules: r.linked_modules,
      }))
      .map((r) => ({
        id: r.id, title: r.title, status: r.status, priority: r.priority,
        dueDate: r.due_date, assigneeId: r.assignee_id, assigneeName: r.assignee_name,
        overdue: isOverdue({ status: r.status, dueDate: r.due_date }, now),
        links: r.links ?? [],
      }))
      .filter((t) => (filter.overdueOnly ? t.overdue : true))
  })
}

export type TaskDetail = TaskListItem & {
  description: string | null
  department: string | null
  confidential: boolean
  blockedReason: string | null
  version: number
  createdBy: string
  comments: { id: string; body: string; authorName: string; createdAt: Date; editedAt: Date | null }[]
}

/** Returns null (→ 404) rather than throwing when the actor may not see the task. */
export async function getTask(actor: Actor, taskId: string): Promise<TaskDetail | null> {
  authorize(actor, 'view_records', 'tasks')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<Record<string, never>>(
      `SELECT t.*, a.full_name AS assignee_name,
              COALESCE((SELECT array_agg(DISTINCT l.module) FROM task_link l WHERE l.task_id = t.id),
                       '{}') AS linked_modules,
              (SELECT json_agg(json_build_object('entityType', l.entity_type,
                                                 'entityId', l.entity_id, 'module', l.module))
                 FROM task_link l WHERE l.task_id = t.id) AS links
         FROM task t LEFT JOIN app_user a ON a.id = t.assignee_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`, [taskId])
    const t = rows[0] as never as {
      id: string; title: string; description: string | null; status: TaskStatus; priority: string
      due_date: Date | null; assignee_id: string | null; assignee_name: string | null
      department: string | null; confidential: boolean; blocked_reason: string | null
      version: number; created_by: string; linked_modules: ModuleKey[]
      links: TaskListItem['links'] | null
    }
    if (!t) return null
    if (!canSeeTask(actor, {
      createdBy: t.created_by, assigneeId: t.assignee_id,
      confidential: t.confidential, linkedModules: t.linked_modules,
    })) return null

    const comments = await tx.query<{
      id: string; body: string; author_name: string; created_at: Date; edited_at: Date | null
    }>(
      `SELECT c.id, c.body, u.full_name AS author_name, c.created_at, c.edited_at
         FROM task_comment c JOIN app_user u ON u.id = c.created_by
        WHERE c.task_id = $1 ORDER BY c.created_at`, [taskId])

    return {
      id: t.id, title: t.title, description: t.description, status: t.status,
      priority: t.priority, dueDate: t.due_date, assigneeId: t.assignee_id,
      assigneeName: t.assignee_name, department: t.department, confidential: t.confidential,
      blockedReason: t.blocked_reason, version: t.version, createdBy: t.created_by,
      overdue: isOverdue({ status: t.status, dueDate: t.due_date }, new Date()),
      links: t.links ?? [],
      comments: comments.rows.map((c) => ({
        id: c.id, body: c.body, authorName: c.author_name,
        createdAt: c.created_at, editedAt: c.edited_at,
      })),
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (20 new tests). The two that matter most: *"rolls back the task when a link is invalid"* (transaction integrity) and *"hides a finance-linked task ... in list AND detail"* (the visibility rule holds on every surface).

- [ ] **Step 5: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/shared/tasks/services dlms/__tests__/integration/taskService.test.ts
git commit -m "feat(tasks): task service with atomic links and unified visibility

Task and links commit together so no context-free orphan survives. Every surface
(list, detail, panel) filters through the same canSeeTask rule, and invisible
tasks raise not-found rather than permission-denied so denials never confirm a
record exists."
```

---

### Task 12: Task UI — My Tasks, the central centre, and the record panel

**Files:**
- Create: `app/(platform)/tasks/page.tsx`, `app/(platform)/tasks/[id]/page.tsx`, `app/(platform)/tasks/actions.ts`
- Create: `components/tasks/TaskList.tsx`, `components/tasks/TaskDetail.tsx`, `components/tasks/TaskForm.tsx`, `components/tasks/TaskPanel.tsx`, `components/tasks/StatusPill.tsx`
- Modify: `app/(platform)/page.tsx` (Home renders My Tasks)
- Test: `__tests__/platform/tasks/actions.test.ts`

**Interfaces:**
- Consumes: `createTask`, `changeTaskStatus`, `assignTask`, `addComment`, `listTasksFor`, `getTask`, `TaskListItem`, `TaskDetail` (Task 11); `requireActor()` (Task 5); `allowedNextTaskStatuses` (Task 10).
- Produces:
  - Server actions in `app/(platform)/tasks/actions.ts`: `createTaskAction(formData)`, `changeStatusAction(taskId, to, version, blockedReason?)`, `assignAction(taskId, assigneeId, version)`, `commentAction(taskId, body)` — each returns `{ ok: true } | { ok: false; error: string }`.
  - `<TaskPanel entityType={string} entityId={string} module={ModuleKey} />` — a server component any record page drops in.

- [ ] **Step 1: Write the failing action test**

```typescript
// __tests__/platform/tasks/actions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireActor = vi.fn()
const mockChangeTaskStatus = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({ requireActor: mockRequireActor }))
vi.mock('@/modules/shared/tasks/services/taskService', () => ({
  changeTaskStatus: mockChangeTaskStatus,
  TaskNotFoundError: class TaskNotFoundError extends Error {},
  InvalidTransitionError: class InvalidTransitionError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { changeStatusAction } = await import('@/app/(platform)/tasks/actions')

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['tasks' as const]), active: true,
}

beforeEach(() => {
  mockRequireActor.mockReset().mockResolvedValue(ACTOR)
  mockChangeTaskStatus.mockReset()
})

describe('changeStatusAction', () => {
  it('reports success when the service commits', async () => {
    mockChangeTaskStatus.mockResolvedValue(undefined)
    expect(await changeStatusAction('t1', 'in_progress', 3)).toEqual({ ok: true })
  })

  it('turns a concurrency clash into words a user can act on', async () => {
    const { OptimisticLockError } = await import('@/lib/db/tx')
    mockChangeTaskStatus.mockRejectedValue(new OptimisticLockError('task', 't1'))
    const res = await changeStatusAction('t1', 'in_progress', 2)
    expect(res).toEqual({
      ok: false,
      error: 'Someone else changed this task. Reload the page and try again.',
    })
  })

  it('never leaks an internal error message to the user', async () => {
    mockChangeTaskStatus.mockRejectedValue(new Error('duplicate key value violates unique constraint "x"'))
    const res = await changeStatusAction('t1', 'in_progress', 2)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/tasks/actions.test.ts`
Expected: FAIL — cannot resolve `@/app/(platform)/tasks/actions`.

- [ ] **Step 3: Implement the server actions**

```typescript
// app/(platform)/tasks/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/shared/auth/session'
import {
  createTask, changeTaskStatus, assignTask, addComment,
  TaskNotFoundError, InvalidTransitionError,
} from '@/modules/shared/tasks/services/taskService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { TaskStatus } from '@/modules/shared/tasks/domain/taskStatus'

export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Turns exceptions into sentences a user can act on.
 *
 * Known failures get their own wording; everything else gets a generic message
 * and a server-side log, because an unexpected error's text is written for us,
 * not for the person trying to do their job.
 */
function toMessage(err: unknown): string {
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this task. Reload the page and try again.'
  }
  if (err instanceof TaskNotFoundError) return 'That task no longer exists.'
  if (err instanceof InvalidTransitionError) return err.message
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'task action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function changeStatusAction(
  taskId: string, to: TaskStatus, version: number, blockedReason?: string,
): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await changeTaskStatus(actor, taskId, to, version, { blockedReason })
    revalidatePath('/tasks')
    revalidatePath(`/tasks/${taskId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function assignAction(
  taskId: string, assigneeId: string | null, version: number,
): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await assignTask(actor, taskId, assigneeId, version)
    revalidatePath('/tasks')
    revalidatePath(`/tasks/${taskId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function commentAction(taskId: string, body: string): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await addComment(actor, taskId, body)
    revalidatePath(`/tasks/${taskId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function createTaskAction(formData: FormData): Promise<ActionResult & { taskId?: string }> {
  try {
    const actor = await requireActor()
    const dueRaw = formData.get('dueDate') as string | null
    const linksRaw = formData.get('links') as string | null
    const { taskId } = await createTask(actor, {
      title: String(formData.get('title') ?? ''),
      description: (formData.get('description') as string) || undefined,
      priority: (formData.get('priority') as 'low' | 'normal' | 'high' | 'urgent') || 'normal',
      dueDate: dueRaw ? new Date(dueRaw) : undefined,
      assigneeId: (formData.get('assigneeId') as string) || undefined,
      department: (formData.get('department') as string) || undefined,
      confidential: formData.get('confidential') === 'on',
      links: linksRaw ? JSON.parse(linksRaw) : [],
    })
    revalidatePath('/tasks')
    return { ok: true, taskId }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/tasks/actions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Build the four task surfaces**

1. **Home** (`app/(platform)/page.tsx`) — `listTasksFor(actor, { scope: 'mine', status: ['open','in_progress','blocked'] })` in two groups: *Overdue* (red-bordered, `overdue === true`) then *Due soon*. Empty state: "Nothing assigned to you right now."
2. **Central task centre** (`app/(platform)/tasks/page.tsx`) — `<TaskList>` with tab scopes (Mine / My department / All), filters (status, priority, module, overdue-only), and a "New task" dialog.
3. **Task detail** (`app/(platform)/tasks/[id]/page.tsx`) — `getTask()`; **`if (!task) notFound()`** — the null return *is* the 404. Renders title/description, status pill + change dropdown offering only `allowedNextTaskStatuses(task.status)` (blocked prompts for a reason), assignee picker, linked-record chips that navigate to the record, comment thread + composer, and a subtask list.
4. **Record panel** (`components/tasks/TaskPanel.tsx`) — server component: `listTasksFor(actor, { scope: 'all', entityRef: { entityType, entityId } })` + a "New task" button that pre-fills the link. Task 13's device detail page drops this in unchanged.

`StatusPill` encodes state in **form as well as color** (icon + text, never color alone) so it survives a colorblind reader and a grayscale print.

- [ ] **Step 6: Verify the surfaces manually**

Run `npm run dev`. As the Super Admin: create a task, assign it to the seeded test operator, comment (include Chinese text — confirm it round-trips), block it (confirm the reason is demanded), unblock, complete. Confirm it appears on Home, in the centre, and — after Task 13 — on the device panel. Then sign in as a Finance user and confirm a confidential Manufacturing task is invisible in the list *and* returns 404 by direct URL.

Run: `npm test && npm run type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/app/\(platform\)/tasks dlms/app/\(platform\)/page.tsx dlms/components/tasks \
        dlms/__tests__/platform/tasks/actions.test.ts
git commit -m "feat(tasks): My Tasks, central task centre, detail, and record panel

One task system on four surfaces. The status dropdown offers only transitions the
server would accept, and an invisible task 404s by direct URL exactly as it
vanishes from the list."
```

---

### Task 13: Manufacturing — device registry read port

The demo shows real devices. This is a **read-only** port: the full Manufacturing port (create/edit/import/status changes) is week 3, and this task deliberately does not start it.

**Files:**
- Create: `supabase/migrations/20260719000001_platform_devices.sql`
- Create: `modules/manufacturing/services/deviceReadService.ts`
- Create: `app/(platform)/manufacturing/page.tsx`, `app/(platform)/manufacturing/devices/page.tsx`, `app/(platform)/manufacturing/devices/[id]/page.tsx`
- Create: `components/manufacturing/DeviceTable.tsx`, `components/manufacturing/DeviceFilters.tsx`
- Test: `__tests__/integration/deviceReadService.test.ts`

**Interfaces:**
- Consumes: `authorize()` (Task 3); `withTransaction()` (Task 4); `<TaskPanel>` (Task 12).
- Produces:
  - Tables `device_variant`, `status_option`, `phase_option`, `status_transition`, `device`, `device_status_history` (per spec §6.2 DDL — **including `phase`, `needs_data_review`, and the `device_sn` partial unique index**).
  - `listDevices(actor, filter: DeviceFilter): Promise<{ items: DeviceListItem[]; nextCursor: string | null }>` where `DeviceFilter = { q?: string; status?: string[]; variant?: string[]; needsReview?: boolean; limit?: number; cursor?: string }`.
  - `getDevice(actor, deviceId): Promise<DeviceDetail | null>`.

- [ ] **Step 1: Write the device schema migration**

Use the DDL from spec §6.2 verbatim for `device_variant`, `device`, and `device_status_history`, plus the `status_option` / `phase_option` vocabularies (ported shape: `code` PK, `label_en`, `label_zh`, `is_initial`, `is_terminal`, `sort_order`, `active`, `updated_by`) and `status_transition`. Seed the ten lifecycle statuses of spec §5.2, marking `in_production` initial and `retired`/`scrapped` terminal, and seed `status_transition` rows for exactly the arrows in that diagram — plus `ready_for_delivery → shipped` carrying `task_template_key = 'logistics_prepare_delivery'` (week-3 automation reads it; week 2 only stores it).

**One addition to the spec §6.2 DDL** — add this column to `device`:

```sql
  -- Legacy PCBA-A serial, carried verbatim from DLMS where it is the de-facto
  -- device identity (device_sn is often blank) and may hold a range or list,
  -- e.g. "EE-02A-2603-0001 to 0015". Preserved rather than parsed: see
  -- needs_data_review and scripts/migrate_demo.ts. The normalized component
  -- model (week 4) supersedes it; it is never the basis of new records.
  pcba_a_sn_legacy text,
```

```sql
CREATE INDEX device_pcba_a_legacy_trgm ON device USING gin (pcba_a_sn_legacy gin_trgm_ops);
```

Also record this in spec §6.2 so the schema document and the database agree — a column that exists only in the plan is a column the week-4 implementer will delete.

**The three prod codes must survive:** seed `in_stock`, `under_repair`, and `shipped` with their exact existing labels so Task 14's migration maps them 1:1.

- [ ] **Step 2: Write the failing read-service test**

```typescript
// __tests__/integration/deviceReadService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { listDevices, getDevice } from '@/modules/manufacturing/services/deviceReadService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
let proId: string

const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  proId = (await db.query(`SELECT id FROM device_variant WHERE code = 'pro'`)).rows[0].id
  await db.query(`
    INSERT INTO device (device_sn, variant_id, status, product_name, created_by, updated_by)
    VALUES ('QTX-P-00412', $1, 'in_stock', 'AH Pro', $2, $2),
           ('QTX-B-00099', (SELECT id FROM device_variant WHERE code = 'basic'),
            'shipped', 'AH Basic', $2, $2)`, [proId, userId])
  await db.query(`
    INSERT INTO device (pcba_a_sn_legacy, variant_id, status, needs_data_review, created_by, updated_by)
    VALUES ('EE-02A-2603-0001 to 0015', $1, 'in_stock', true, $2, $2)`, [proId, userId])
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('listDevices', () => {
  it('refuses a caller without Manufacturing access', async () => {
    const outsider: Actor = {
      id: userId, roleKey: 'finance',
      permissions: new Set(['view_records']), moduleAccess: new Set(['finance']), active: true,
    }
    await expect(listDevices(outsider, {})).rejects.toThrow(PermissionError)
  })

  it('finds a device by exact serial number', async () => {
    const { items } = await listDevices(op(), { q: 'QTX-P-00412' })
    expect(items.map((d) => d.deviceSn)).toEqual(['QTX-P-00412'])
  })

  it('finds a device by PARTIAL serial — the way people actually search', async () => {
    const { items } = await listDevices(op(), { q: '00412' })
    expect(items.some((d) => d.deviceSn === 'QTX-P-00412')).toBe(true)
  })

  it('is case-insensitive', async () => {
    const { items } = await listDevices(op(), { q: 'qtx-p-00412' })
    expect(items.some((d) => d.deviceSn === 'QTX-P-00412')).toBe(true)
  })

  it('filters by variant', async () => {
    const { items } = await listDevices(op(), { variant: ['basic'] })
    expect(items.every((d) => d.variantCode === 'basic')).toBe(true)
    expect(items.length).toBeGreaterThan(0)
  })

  it('filters by status', async () => {
    const { items } = await listDevices(op(), { status: ['shipped'] })
    expect(items.every((d) => d.status === 'shipped')).toBe(true)
  })

  it('surfaces legacy rows flagged for review', async () => {
    const { items } = await listDevices(op(), { needsReview: true })
    expect(items.length).toBe(1)
    expect(items[0].needsDataReview).toBe(true)
  })

  it('paginates by keyset and does not repeat a row across pages', async () => {
    const page1 = await listDevices(op(), { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await listDevices(op(), { limit: 2, cursor: page1.nextCursor! })
    const overlap = page2.items.filter((b) => page1.items.some((a) => a.id === b.id))
    expect(overlap).toEqual([])
  })

  it('excludes soft-deleted devices', async () => {
    const id = (await db.query(`
      INSERT INTO device (device_sn, variant_id, status, created_by, updated_by, deleted_at)
      VALUES ('QTX-DELETED', $1, 'in_stock', $2, $2, now()) RETURNING id`, [proId, userId])).rows[0].id
    const { items } = await listDevices(op(), { q: 'QTX-DELETED' })
    expect(items).toEqual([])
    await db.query(`DELETE FROM device WHERE id = $1`, [id])
  })
})

describe('getDevice', () => {
  it('returns the device with its status history', async () => {
    const id = (await db.query(`SELECT id FROM device WHERE device_sn = 'QTX-P-00412'`)).rows[0].id
    await db.query(`
      INSERT INTO device_status_history (device_id, from_status, to_status, changed_by)
      VALUES ($1, 'in_production', 'in_stock', $2)`, [id, userId])
    const d = await getDevice(op(), id)
    expect(d?.deviceSn).toBe('QTX-P-00412')
    expect(d?.statusHistory).toHaveLength(1)
    expect(d?.statusHistory[0].toStatus).toBe('in_stock')
  })

  it('returns null for an unknown id rather than throwing', async () => {
    expect(await getDevice(op(), crypto.randomUUID())).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `@/modules/manufacturing/services/deviceReadService`.

- [ ] **Step 4: Implement the read service**

```typescript
// modules/manufacturing/services/deviceReadService.ts
import { z } from 'zod'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

export type DeviceListItem = {
  id: string
  deviceSn: string | null
  legacySn: string | null
  variantCode: string
  variantName: string
  status: string
  statusLabel: string
  productName: string | null
  customer: string | null
  buildDate: Date | null
  needsDataReview: boolean
}

export type DeviceDetail = DeviceListItem & {
  modelNo: string | null
  destination: string | null
  phase: string | null
  remarks: string | null
  shipDate: Date | null
  deliveredDate: Date | null
  version: number
  statusHistory: {
    fromStatus: string | null; toStatus: string; reason: string | null
    changedByName: string; changedAt: Date
  }[]
}

const filterSchema = z.object({
  q: z.string().max(100).optional(),
  status: z.array(z.string()).optional(),
  variant: z.array(z.string()).optional(),
  needsReview: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type DeviceFilter = z.input<typeof filterSchema>

/**
 * The device registry list (spec §10).
 *
 * Search hits the normalized column with a trigram index, so "00412" finds
 * "QTX-P-00412" — people search by the fragment they remember, not the whole
 * string. Legacy rows whose identity lives in pcba_a_sn_legacy (ranges like
 * "EE-02A-2603-0001 to 0015") are searchable by the same query.
 *
 * Keyset pagination on (created_at, id): OFFSET would drift as devices are added
 * during a session, silently skipping or repeating rows.
 */
export async function listDevices(
  actor: Actor, filter: DeviceFilter,
): Promise<{ items: DeviceListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'manufacturing')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['d.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.q) {
      const needle = p(`%${f.q.toLowerCase().replace(/[\s-]/g, '')}%`)
      conditions.push(`(d.device_sn_normalized LIKE ${needle}
                     OR lower(replace(coalesce(d.pcba_a_sn_legacy, ''), ' ', '')) LIKE ${needle})`)
    }
    if (f.status?.length) conditions.push(`d.status = ANY(${p(f.status)})`)
    if (f.variant?.length) conditions.push(`v.code = ANY(${p(f.variant)})`)
    if (f.needsReview !== undefined) conditions.push(`d.needs_data_review = ${p(f.needsReview)}`)
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(d.created_at, d.id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; device_sn: string | null; pcba_a_sn_legacy: string | null
      variant_code: string; variant_name: string; status: string; status_label: string
      product_name: string | null; customer: string | null; build_date: Date | null
      needs_data_review: boolean; created_at: Date
    }>(
      `SELECT d.id, d.device_sn, d.pcba_a_sn_legacy, v.code AS variant_code, v.name AS variant_name,
              d.status, s.label_en AS status_label, d.product_name, d.customer, d.build_date,
              d.needs_data_review, d.created_at
         FROM device d
         JOIN device_variant v ON v.id = d.variant_id
         JOIN status_option s ON s.code = d.status
        WHERE ${conditions.join(' AND ')}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((r) => ({
        id: r.id, deviceSn: r.device_sn, legacySn: r.pcba_a_sn_legacy,
        variantCode: r.variant_code, variantName: r.variant_name,
        status: r.status, statusLabel: r.status_label, productName: r.product_name,
        customer: r.customer, buildDate: r.build_date, needsDataReview: r.needs_data_review,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

/** Returns null for unknown ids so the page can 404 without a thrown error path. */
export async function getDevice(actor: Actor, deviceId: string): Promise<DeviceDetail | null> {
  authorize(actor, 'view_records', 'manufacturing')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<Record<string, never>>(
      `SELECT d.*, v.code AS variant_code, v.name AS variant_name, s.label_en AS status_label
         FROM device d
         JOIN device_variant v ON v.id = d.variant_id
         JOIN status_option s ON s.code = d.status
        WHERE d.id = $1 AND d.deleted_at IS NULL`, [deviceId])
    const d = rows[0] as never as Record<string, never> | undefined
    if (!d) return null

    const history = await tx.query<{
      from_status: string | null; to_status: string; reason: string | null
      changed_by_name: string; changed_at: Date
    }>(
      `SELECT h.from_status, h.to_status, h.reason, u.full_name AS changed_by_name, h.changed_at
         FROM device_status_history h JOIN app_user u ON u.id = h.changed_by
        WHERE h.device_id = $1 ORDER BY h.changed_at DESC`, [deviceId])

    const r = d as never as {
      id: string; device_sn: string | null; pcba_a_sn_legacy: string | null
      variant_code: string; variant_name: string; status: string; status_label: string
      product_name: string | null; model_no: string | null; customer: string | null
      destination: string | null; phase: string | null; remarks: string | null
      build_date: Date | null; ship_date: Date | null; delivered_date: Date | null
      needs_data_review: boolean; version: number
    }

    return {
      id: r.id, deviceSn: r.device_sn, legacySn: r.pcba_a_sn_legacy,
      variantCode: r.variant_code, variantName: r.variant_name,
      status: r.status, statusLabel: r.status_label, productName: r.product_name,
      modelNo: r.model_no, customer: r.customer, destination: r.destination,
      phase: r.phase, remarks: r.remarks, buildDate: r.build_date, shipDate: r.ship_date,
      deliveredDate: r.delivered_date, needsDataReview: r.needs_data_review, version: r.version,
      statusHistory: history.rows.map((h) => ({
        fromStatus: h.from_status, toStatus: h.to_status, reason: h.reason,
        changedByName: h.changed_by_name, changedAt: h.changed_at,
      })),
    }
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (11 new tests).

- [ ] **Step 6: Build the device screens**

- `app/(platform)/manufacturing/page.tsx` — module landing: device counts by status (one grouped query) linking into the filtered list.
- `.../devices/page.tsx` — `<DeviceTable>`: SN (or legacy SN in muted type with a "needs review" chip), variant badge, status pill, product, customer, build date. `<DeviceFilters>`: search box (debounced 300 ms), status multi-select, variant multi-select, "needs review" toggle. "Load more" uses `nextCursor`.
- `.../devices/[id]/page.tsx` — `getDevice()`; `if (!device) notFound()`. Header (SN · variant · status pill) + Radix tabs: **Overview** (fields incl. bilingual `remarks` rendered verbatim), **Status history** (timeline), **Tasks** (`<TaskPanel entityType="device" entityId={id} module="manufacturing" />`). The remaining eight tabs of spec §8.2 render a stub naming their build week — visible scaffolding beats a tab that lies.

- [ ] **Step 7: Verify manually**

Run `npm run dev` → `/manufacturing/devices`. Search a partial serial, filter by variant and status, open a device, confirm the status history renders and the task panel creates a device-linked task that then appears in `/tasks`. Confirm a legacy ranged-serial row shows its "needs review" chip.

Run: `npm test && npm run type-check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/supabase/migrations/20260719000001_platform_devices.sql \
        dlms/modules/manufacturing dlms/app/\(platform\)/manufacturing \
        dlms/components/manufacturing dlms/__tests__/integration/deviceReadService.test.ts
git commit -m "feat(manufacturing): device registry schema and read-only port

Ten-status lifecycle vocabulary with the three production codes seeded intact.
Partial serial search over a trigram index, keyset pagination, and a device
profile whose task panel is the shared component every record page will use."
```

---

### Task 14: Demo data migration — a real fleet in the demo

**Files:**
- Create: `scripts/migrate_demo.ts`, `scripts/reconcile.ts`
- Create: `docs/runbooks/RB-07-demo-migration.md`
- Test: `__tests__/integration/migrateDemo.test.ts`

**Interfaces:**
- Consumes: the device schema (Task 13); `withTransaction()` (Task 4).
- Produces:
  - `mapStatus(legacy: string): string` — **pure**, exported for testing.
  - `mapDeviceRow(row: LegacyDevice, variantIds: Record<string, string>, actorId: string): PlatformDevice` — **pure**.
  - `npm run migrate:demo` — copies devices + audit history from the **old DLMS project** into the platform project.

> **Safety:** this reads the old project over a **read-only connection string** and writes only to the platform project. It never writes to DLMS. Run it against staging only; the production cutover is week 10's rehearsed script, of which this is the ancestor.

- [ ] **Step 1: Write the failing mapping test**

```typescript
// __tests__/integration/migrateDemo.test.ts
import { describe, it, expect } from 'vitest'
import { mapStatus, mapDeviceRow } from '@/scripts/migrate_demo'

const VARIANTS = { basic: 'variant-basic-uuid', pro: 'variant-pro-uuid' }
const ACTOR = 'actor-uuid'

const legacy = (over = {}) => ({
  id: 'device-uuid-1',
  device_sn: 'QTX-P-00412',
  pcba_a_sn: 'EE-02A-2603-0042',
  product_name: 'AH Pro',
  model_no: 'AH-2',
  status: 'In Stock',
  phase: 'Production',
  customer: '客户 A',
  destination: 'Singapore',
  remarks: '电源板已更换\nSecond line preserved',
  build_date: new Date('2026-03-01'),
  ship_date: null,
  created_at: new Date('2026-03-02'),
  ...over,
})

describe('mapStatus — the three production codes map 1:1 (spec §15)', () => {
  it('maps the live codes', () => {
    expect(mapStatus('In Stock')).toBe('in_stock')
    expect(mapStatus('Under Repair')).toBe('under_repair')
    expect(mapStatus('Shipped')).toBe('shipped')
  })

  it('maps the seeded codes that drifted out of use', () => {
    expect(mapStatus('Stock')).toBe('in_stock')
    expect(mapStatus('Repair')).toBe('under_repair')
  })

  it('throws on an unknown status rather than guessing', () => {
    expect(() => mapStatus('Teleported')).toThrow(/unknown legacy status/i)
  })
})

describe('mapDeviceRow', () => {
  it('preserves the device UUID verbatim — audit rows depend on it', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).id).toBe('device-uuid-1')
  })

  it('preserves bilingual free text exactly, including newlines', () => {
    const out = mapDeviceRow(legacy(), VARIANTS, ACTOR)
    expect(out.remarks).toBe('电源板已更换\nSecond line preserved')
    expect(out.customer).toBe('客户 A')
  })

  it('derives the Pro variant from the product name', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).variant_id).toBe('variant-pro-uuid')
  })

  it('defaults to Basic when the product name says nothing', () => {
    expect(mapDeviceRow(legacy({ product_name: 'AH' }), VARIANTS, ACTOR).variant_id)
      .toBe('variant-basic-uuid')
  })

  it('carries a ranged legacy serial verbatim and flags it for review, never splitting it', () => {
    const out = mapDeviceRow(
      legacy({ device_sn: null, pcba_a_sn: 'EE-02A-2603-0001 to 0015' }), VARIANTS, ACTOR)
    expect(out.pcba_a_sn_legacy).toBe('EE-02A-2603-0001 to 0015')
    expect(out.needs_data_review).toBe(true)
    expect(out.device_sn).toBeNull()
  })

  it('flags a device with no serial of any kind', () => {
    const out = mapDeviceRow(legacy({ device_sn: null, pcba_a_sn: '' }), VARIANTS, ACTOR)
    expect(out.needs_data_review).toBe(true)
  })

  it('does NOT flag a clean single-serial row', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).needs_data_review).toBe(false)
  })

  it('normalizes the serial for search without altering the stored value', () => {
    const out = mapDeviceRow(legacy(), VARIANTS, ACTOR)
    expect(out.device_sn).toBe('QTX-P-00412')
    expect(out.device_sn_normalized).toBe('qtxp00412')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `@/scripts/migrate_demo`.

- [ ] **Step 3: Implement the pure mapping functions**

```typescript
// scripts/migrate_demo.ts  (mapping half — the runner follows in step 5)

/**
 * Legacy status → platform status (spec §15).
 *
 * Both the LIVE production codes and the drifted seed codes are handled, because
 * prod uses "In Stock"/"Under Repair"/"Shipped" while seed.sql says
 * "Stock"/"Repair" — a documented drift that has bitten before.
 *
 * Unknown values throw. A migration that guesses is a migration that silently
 * corrupts a fleet: the operator must see the unknown value and decide.
 */
const STATUS_MAP: Record<string, string> = {
  'In Stock': 'in_stock',
  'Stock': 'in_stock',
  'Under Repair': 'under_repair',
  'Repair': 'under_repair',
  'Shipped': 'shipped',
  'Delivered': 'delivered',
  'Retired': 'retired',
  'Lost': 'scrapped',
}

export function mapStatus(legacy: string): string {
  const mapped = STATUS_MAP[legacy?.trim()]
  if (!mapped) {
    throw new Error(
      `Unknown legacy status: "${legacy}". Add it to STATUS_MAP and re-run — do not guess.`)
  }
  return mapped
}

export type LegacyDevice = {
  id: string
  device_sn: string | null
  pcba_a_sn: string | null
  product_name: string | null
  model_no: string | null
  status: string
  phase: string | null
  customer: string | null
  destination: string | null
  remarks: string | null
  build_date: Date | null
  ship_date: Date | null
  created_at: Date
}

export type PlatformDevice = {
  id: string
  device_sn: string | null
  device_sn_normalized: string | null
  pcba_a_sn_legacy: string | null
  variant_id: string
  status: string
  phase: string | null
  product_name: string | null
  model_no: string | null
  customer: string | null
  destination: string | null
  remarks: string | null
  build_date: Date | null
  ship_date: Date | null
  needs_data_review: boolean
  created_at: Date
  created_by: string
  updated_by: string
}

/** Matches the trigger-maintained normalization: lowercase, strip spaces and dashes. */
const normalize = (sn: string | null): string | null =>
  sn ? sn.toLowerCase().replace(/[\s-]/g, '') : null

/** A serial holding a range or list ("0001 to 0015", "0001, 0002") describes many devices in one row. */
const isRangedSerial = (sn: string | null): boolean =>
  !!sn && /\b(to|~|-{2,}|,)\b|\bto\b/i.test(sn)

/**
 * Maps one legacy device row.
 *
 * The device UUID is preserved verbatim — audit_log rows reference it, and
 * spec D21 requires the trail to read continuously across the cutover.
 *
 * Ranged serials are carried VERBATIM into pcba_a_sn_legacy with
 * needs_data_review = true rather than split into N devices. Splitting would
 * invent device identities the business never assigned, and the cutover must not
 * block on data cleansing (spec §15) — the flag becomes an admin cleanup queue.
 */
export function mapDeviceRow(
  row: LegacyDevice, variantIds: Record<string, string>, actorId: string,
): PlatformDevice {
  const isPro = /\bpro\b/i.test(row.product_name ?? '')
  const ranged = isRangedSerial(row.pcba_a_sn)
  const hasNoSerial = !row.device_sn && !row.pcba_a_sn?.trim()

  return {
    id: row.id,
    device_sn: row.device_sn,
    device_sn_normalized: normalize(row.device_sn),
    pcba_a_sn_legacy: row.pcba_a_sn,
    variant_id: isPro ? variantIds.pro : variantIds.basic,
    status: mapStatus(row.status),
    phase: row.phase,
    product_name: row.product_name,
    model_no: row.model_no,
    customer: row.customer,
    destination: row.destination,
    remarks: row.remarks,          // bilingual, multiline — never touched
    build_date: row.build_date,
    ship_date: row.ship_date,
    needs_data_review: ranged || hasNoSerial,
    created_at: row.created_at,
    created_by: actorId,
    updated_by: actorId,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (11 new tests).

- [ ] **Step 5: Implement the runner**

Append to `scripts/migrate_demo.ts` a `main()` that: connects to `LEGACY_DATABASE_URL` (read-only) and `DATABASE_URL`; refuses to run if `APP_ENV === 'production'` (this is the demo script, not the cutover); loads `variant_id`s; reads legacy devices in batches of 500 ordered by `created_at`; maps each row and **collects mapping failures rather than aborting** — unknown statuses are reported at the end as a list the operator must resolve; inserts in one `withTransaction` per batch with `ON CONFLICT (id) DO NOTHING` (re-runnable); then copies `audit_log` rows verbatim (same ids, same `occurred_at`), remapping `actor_id` via an email-matched user map and leaving unmatched actors NULL.

Add to `package.json`: `"migrate:demo": "npx tsx scripts/migrate_demo.ts"`.

- [ ] **Step 6: Write the reconciliation script**

`scripts/reconcile.ts` compares source and target and prints a table: row count per table (must match exactly), device count by mapped status (source count per legacy code = target count per platform code), a sha256 over `device_sn || pcba_a_sn` sorted (must match), `needs_data_review` count (recorded, not compared), and audit_log count + max `occurred_at`. Exit code 1 on any mismatch so CI or the operator cannot miss it.

Add: `"reconcile": "npx tsx scripts/reconcile.ts"`.

- [ ] **Step 7: Run the migration against staging and reconcile**

```bash
LEGACY_DATABASE_URL="postgresql://<readonly>@<old-project>:5432/postgres" \
DATABASE_URL="<platform staging url>" APP_ENV=staging npm run migrate:demo
LEGACY_DATABASE_URL=... DATABASE_URL=... npm run reconcile
```

Expected: reconcile exits 0 with matching counts. Record in `docs/runbooks/RB-07-demo-migration.md`: the actual device count, the `needs_data_review` count, any statuses that needed adding to `STATUS_MAP`, and the wall-clock runtime — **the runtime is the first real data point for the week-10 cutover window**.

- [ ] **Step 8: Verify the demo end-to-end**

Open staging: sign in, search a real serial from the fleet, open the device, confirm the status history and bilingual remarks render, create a task linked to that device, confirm it appears on Home and in `/tasks`. This is the July-31 demo script — walk it once as the audience will see it.

- [ ] **Step 9: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/scripts/migrate_demo.ts dlms/scripts/reconcile.ts dlms/package.json \
        dlms/docs/runbooks/RB-07-demo-migration.md \
        dlms/__tests__/integration/migrateDemo.test.ts
git commit -m "feat(migration): demo data migration with reconciliation

Preserves device UUIDs and audit history verbatim. Unknown statuses throw rather
than guess, and ranged legacy serials carry across flagged for review instead of
being invented into separate devices. Reconciliation exits non-zero on any
mismatch."
```

---

## Demo acceptance criteria (2026-07-31)

Walk this list before the demo; anything unchecked is a talking point, not a surprise.

| # | Criterion | Verified by |
|---|---|---|
| 1 | Staging URL serves over HTTPS through CloudFront + WAF | `curl https://staging.<domain>/api/health` → `{"status":"ok","db":"ok"}` |
| 2 | Super Admin signs in with TOTP enforced | Manual: MFA challenge appears; a Viewer's does not |
| 3 | Five module sections + Tasks + Admin render, gated by permission | Task 7 tests + manual role switch |
| 4 | Super Admin can invite, deactivate, and re-scope a user | Task 8 tests + manual |
| 5 | Deactivating a user kills their live session | Manual: second browser is signed out on next request |
| 6 | The last Super Admin cannot be deactivated or demoted | Task 8 tests |
| 7 | Role → permission matrix is editable and takes effect | Task 9 tests + manual |
| 8 | Tasks: create, assign, comment, block with reason, complete | Task 11/12 tests + manual |
| 9 | A confidential task is invisible to outsiders in list AND by URL | Task 11 tests + manual |
| 10 | Device registry lists real migrated devices; partial serial search works | Task 13/14 tests + manual |
| 11 | A device-linked task appears on the device panel and on Home | Manual |
| 12 | Every change is attributed in `audit_log` to the acting user | `SELECT ... FROM audit_log ORDER BY occurred_at DESC LIMIT 20` |
| 13 | Bilingual (中文) text round-trips unaltered | Task 14 tests + manual |
| 14 | CI is green; `npm test` + `npm run test:integration` pass | GitHub Actions |
| 15 | Rollback to the previous ECS task definition works | Task 6 step 11 |

**Not in the demo, by design** (say so plainly if asked): device create/edit, status changes, imports, the other four modules' records, notifications, search, exports, files. Those are weeks 3–9.

---

## Plan self-review

**Spec coverage for the July-31 scope.** §3.1–3.3 roles/permissions/console → Tasks 2, 3, 8, 9. §4.1 navigation → Task 7. §6 schema core → Tasks 2, 10, 13. §7.2 data topology → Task 4. §8.3 tasks → Tasks 10–12. §9 AWS → Task 6. §11 auth/MFA/audit → Tasks 2, 5. §14 testing/CI → Tasks 1, 6. §15 migration → Task 14. **Deliberately deferred to week 3+** (spec §17): outbox/status-driven handoffs, files/S3, notifications/SES sending, search, dashboards beyond My Tasks, worker service and pg-boss. The SES *access request* is in Task 6 because of its lead time; the sending code is week 9.

**Known gaps carried forward.** (a) RLS policies for the new tables are **not** in weeks 1–2 — the `authorize()` choke point is the live control, and RLS defense-in-depth lands in week 3 with the Manufacturing port, before any non-Reet user touches the system. Recorded as a deviation from spec §11.1's two-layer claim until then. (b) The worker service (pg-boss) has no task here; the hourly override-expiry sweep it owns is unnecessary while `fn_resolve_actor` already filters expired overrides at read time. (c) The `phase_option` vocabulary is ported for legacy fidelity but has no UI until week 3.

**Open question that blocks Task 6 step 7:** the platform's domain name (spec §20 item 1). Everything else in weeks 1–2 is unblocked.

**Type consistency:** `Actor`, `Permission`, `ModuleKey`, `RoleKey` are defined once in `catalog.ts` and imported everywhere. `withTransaction(actorId, fn)` has the same signature at every call site. `canSeeTask` takes `TaskVisibilityInput` in both `listTasksFor` and `getTask`. `getTask`/`getDevice` both return `null` (never throw) for the not-visible/not-found case, and both callers `notFound()`.

