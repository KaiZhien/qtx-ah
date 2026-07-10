import { chromium, type FullConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Signs in a test clinician through the real login page once, then persists the
 * resulting session as storageState for every project to reuse.
 *
 * Credentials come from E2E_CLINICIAN_EMAIL / E2E_CLINICIAN_PASSWORD (a user
 * created manually in the Supabase dashboard, and present in
 * CLINICIAN_EMAIL_ALLOWLIST). If either is unset we skip gracefully — writing an
 * empty storage state so Playwright can still load — and print a clear message.
 */
async function globalSetup(config: FullConfig) {
  const { baseURL, storageState } = config.projects[0].use
  const storagePath = (storageState as string) ?? 'e2e/.auth/clinician.json'
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })

  const email = process.env.E2E_CLINICIAN_EMAIL
  const password = process.env.E2E_CLINICIAN_PASSWORD

  if (!email || !password) {
    console.warn(
      '\n[e2e globalSetup] E2E_CLINICIAN_EMAIL / E2E_CLINICIAN_PASSWORD are not set — ' +
        'skipping authenticated sign-in.\n' +
        'Auth-gated specs will be redirected to /login and fail until you set these\n' +
        'env vars (matching a user created in the Supabase dashboard and listed in\n' +
        'CLINICIAN_EMAIL_ALLOWLIST).\n'
    )
    fs.writeFileSync(storagePath, JSON.stringify({ cookies: [], origins: [] }))
    return
  }

  const browser = await chromium.launch()
  const page = await browser.newPage({ baseURL })
  try {
    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: /sign in/i }).click()

    // Successful auth redirects away from /login via window.location.assign('/').
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
      timeout: 15_000,
    })

    await page.context().storageState({ path: storagePath })
  } finally {
    await browser.close()
  }
}

export default globalSetup
