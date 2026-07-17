import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    exclude: ['**/node_modules/**', '__tests__/integration/**'],
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
