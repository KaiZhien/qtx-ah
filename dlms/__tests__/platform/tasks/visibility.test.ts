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
