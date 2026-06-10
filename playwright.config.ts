import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:3000',
    extraHTTPHeaders: { 'X-Api-Key': process.env.NEXT_PUBLIC_API_KEY ?? '' },
  },
  webServer: {
    command: 'cd web && npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
