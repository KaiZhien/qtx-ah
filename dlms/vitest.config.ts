import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // `.claude/**` keeps agent git worktrees out of the run. Without it, every
    // worktree under `.claude/worktrees/` is a full second copy of the repo, so
    // `npm test` globs stale snapshots of these same files and reports ~145
    // failures that belong to no branch anyone is working on — making the house
    // verification command untrustworthy exactly when it matters most, at the end
    // of a parallel wave. The worktrees are gitignored; the test glob did not know that.
    exclude: ['**/node_modules/**', '__tests__/integration/**', '**/.claude/**'],
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
