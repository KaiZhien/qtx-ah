import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize, PermissionError } from '@/modules/shared/authz/authorize'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { Actor, ModuleKey } from '@/modules/shared/authz/catalog'
import { isValidTaskTransition, isOverdue, TASK_STATUSES, type TaskStatus }
  from '@/modules/shared/tasks/domain/taskStatus'
import { canSeeTask } from '@/modules/shared/tasks/domain/visibility'
import { normalizeDueDate } from '@/modules/shared/tasks/domain/dueDate'

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

function moduleAllowed(actor: Actor, module: ModuleKey): boolean {
  return actor.roleKey === 'super_admin' || actor.moduleAccess.has(module)
}

/**
 * Everything that must be true BEFORE a task is created — authorization, validation and
 * the link rules — and nothing that touches the database.
 *
 * Kept out of the transaction on purpose. authorize.ts calls itself "the choke point.
 * Every service entry point calls this before touching data", and `before touching data`
 * is the load-bearing half: withTransaction acquires a pooled connection and issues BEGIN
 * before its callback ever runs, so running these checks inside it would make every denied
 * or malformed call burn a connection plus a BEGIN/ROLLBACK round trip, and would turn a
 * denial that happened to coincide with a database blip into a 500 instead of a 403.
 *
 * Both entry points below call it FIRST — createTask before it opens a transaction,
 * createTaskInTx at the top of the caller's. That is a repeated parse, not a repeated
 * round trip, and each is an entry point in its own right: the outbox drain reaches
 * createTaskInTx directly, so it must be guarded by these rules rather than by its
 * caller's diligence.
 */
function prepare(actor: Actor, input: CreateTaskInput) {
  authorize(actor, 'create_records', 'tasks')
  const data = createSchema.parse(input)

  // You cannot link a task into a module you cannot enter — that would let an
  // outsider create a visible handle on a record they can't see.
  for (const link of data.links) {
    if (!moduleAllowed(actor, link.module)) throw new PermissionError('view_records', link.module)
  }
  return data
}

/**
 * Everything "creating a task" means — authorization, validation, the row, and its
 * links — inside a transaction the CALLER owns.
 *
 * This exists for the outbox drain (spec §5.5), and the reason is worth stating
 * precisely: withTransaction acquires a SEPARATE pooled connection every time it is
 * called, so transactions do not nest. A drain that called createTask() from inside its
 * own transaction would commit the task on one connection while stamping the event
 * processed on another, and a crash between the two would leave a task whose event is
 * still unprocessed — which the next drain would hand off a second time. Exactly-once
 * requires both writes in ONE transaction, so the drain passes its own `tx` in here.
 *
 * The alternative — re-implementing the two INSERTs inside the drain — was rejected:
 * it would fork the definition of what creating a task means, and the authorization and
 * link rules in prepare() are exactly the part that must not be forked. Callers who do
 * not already own a transaction want createTask() below instead.
 */
export async function createTaskInTx(
  tx: Tx, actor: Actor, input: CreateTaskInput,
): Promise<{ taskId: string }> {
  const data = prepare(actor, input)
  const dueDate = normalizeDueDate(data.dueDate)

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO task (title, description, status, priority, due_date, assignee_id,
                       department, confidential, parent_task_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
    [data.title, data.description ?? null, data.status, data.priority, dueDate ?? null,
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
}

/**
 * Creates a task and its record links in ONE transaction.
 *
 * The links are the reason this is transactional: a task that exists without the
 * link that gives it context is worse than no task, because it appears in the
 * central list with nothing to act on and appears on no record panel at all.
 */
export async function createTask(actor: Actor, input: CreateTaskInput): Promise<{ taskId: string }> {
  // Guard BEFORE the connection, not inside it — see prepare()'s header. createTaskInTx
  // re-runs the same pure checks for callers that arrive there directly.
  prepare(actor, input)
  return withTransaction(actor.id, (tx) => createTaskInTx(tx, actor, input))
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
 * task centre, and record panels.
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

type TaskDetailRow = {
  id: string; title: string; description: string | null; status: TaskStatus; priority: string
  due_date: Date | null; assignee_id: string | null; assignee_name: string | null
  department: string | null; confidential: boolean; blocked_reason: string | null
  version: number; created_by: string; linked_modules: ModuleKey[]
  links: TaskListItem['links'] | null
}

/** Returns null (→ 404) rather than throwing when the actor may not see the task. */
export async function getTask(actor: Actor, taskId: string): Promise<TaskDetail | null> {
  authorize(actor, 'view_records', 'tasks')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<TaskDetailRow>(
      `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.assignee_id,
              a.full_name AS assignee_name, t.department, t.confidential, t.blocked_reason,
              t.version, t.created_by,
              COALESCE((SELECT array_agg(DISTINCT l.module) FROM task_link l WHERE l.task_id = t.id),
                       '{}') AS linked_modules,
              (SELECT json_agg(json_build_object('entityType', l.entity_type,
                                                 'entityId', l.entity_id, 'module', l.module))
                 FROM task_link l WHERE l.task_id = t.id) AS links
         FROM task t LEFT JOIN app_user a ON a.id = t.assignee_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`, [taskId])
    const t = rows[0]
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
