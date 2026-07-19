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

  it('refuses a rewrite of created_at — a comment\'s creation time is immutable', async () => {
    const taskId = await newTask()
    const { rows } = await db.query(
      `INSERT INTO task_comment (task_id, body, created_by) VALUES ($1, 'hi', $2) RETURNING id`,
      [taskId, userId])
    const commentId = rows[0].id
    await expect(db.query(
      `UPDATE task_comment SET created_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [commentId]))
      .rejects.toThrow(/immutable/)
  })

  it('refuses a task_link to an unknown module', async () => {
    const taskId = await newTask()
    await expect(db.query(
      `INSERT INTO task_link (task_id, entity_type, entity_id, module, created_by)
       VALUES ($1, 'device', gen_random_uuid(), 'accounting', $2)`, [taskId, userId]))
      .rejects.toThrow()
  })
})
