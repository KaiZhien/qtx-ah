import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// The subtasks section is a stub, and this pin is what keeps it honest.
//
// `task.parent_task_id` exists in the schema and `createTask`'s schema accepts a
// `parentTaskId`. NOTHING IN THE APP EVER SETS IT — not the new-task form, not
// the dialog, not the outbox handoff templates. So the column is write-only and
// every row that will ever exist has it NULL.
//
// That is why the section is a stub rather than a wired list. Listing children is
// small (listTasks already applies canSeeTask, so a parentTaskId filter would
// inherit the visibility rule for free) — but with no creation path the list
// would render "No subtasks" on every task in the system, forever. A section that
// silently reports an empty truth is worse than one that says it is unbuilt; the
// device profile's STUB_TABS is the house convention for exactly this.
//
// THE GUARD THAT MATTERS is the second test: the day someone adds a creation
// path, this fails and points them at the stub. Without it the app would quietly
// gain subtasks nobody could see.
// ---------------------------------------------------------------------------

const dlmsRoot = join(__dirname, '..', '..', '..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

describe('subtasks stub', () => {
  const detail = readFileSync(join(dlmsRoot, 'components', 'tasks', 'TaskDetail.tsx'), 'utf8')

  it('says it is unbuilt and names why, in the STUB_TABS voice', () => {
    // Not "coming soon" and not an internal excuse about the service layer: the
    // reader is told there is nothing to see and that nothing can create one yet.
    expect(detail).toMatch(/Subtasks/)
    expect(detail).toMatch(/nothing in the app creates one/i)
    // §17 schedules no week for subtasks, so the copy must not imply one. The
    // device profile's stubs name a real week because theirs are in the roadmap.
    expect(detail).toMatch(/No scheduled week/i)
  })

  it('nothing writes parentTaskId — the fact the stub rests on', () => {
    const writers = [...walk(join(dlmsRoot, 'app')), ...walk(join(dlmsRoot, 'components'))]
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /\bparentTaskId\b/.test(readFileSync(f, 'utf8')))
      // TaskDetail names it only in the stub's explanation.
      .filter((f) => !f.endsWith(join('components', 'tasks', 'TaskDetail.tsx')))

    // If this fails, a creation path now exists: wire the listing (a parentTaskId
    // filter on listTasks inherits canSeeTask) and delete the stub.
    expect(writers).toEqual([])
  })

  it('the column and the service surface are still there to wire', () => {
    const service = readFileSync(
      join(dlmsRoot, 'modules', 'shared', 'tasks', 'services', 'taskService.ts'), 'utf8')
    expect(service).toMatch(/parentTaskId: z\.string\(\)\.uuid\(\)\.optional\(\)/)
    expect(service).toMatch(/parent_task_id/)
  })
})
