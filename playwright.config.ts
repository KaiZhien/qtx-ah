import { defineConfig } from '@playwright/test'

// Auth is now session-based (Supabase). A global setup signs in a test
// clinician via the login page once and saves the storage state that every
// test reuses — no API key header is attached to requests anymore.
export default defineConfig({
  testDir: './e2e',
  globalSetup: require.resolve('./e2e/global-setup'),
  use: {
    baseURL: 'http://localhost:3000',
    storageState: 'e2e/.auth/clinician.json',
  },
  webServer: {
    command: 'cd web && npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
