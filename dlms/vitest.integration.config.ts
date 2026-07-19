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
    // getPool()'s ssl branch is APP_ENV-gated (undefined only in development) so a real
    // staging/production DATABASE_URL never loses SSL by accident. This harness IS the
    // development case — an ephemeral local Docker Postgres with no TLS listener — so it
    // must self-identify as such; nothing here weakens the branch for any other environment.
    env: { APP_ENV: 'development' },
  },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
})
