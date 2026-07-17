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
