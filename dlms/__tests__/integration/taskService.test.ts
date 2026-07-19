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
