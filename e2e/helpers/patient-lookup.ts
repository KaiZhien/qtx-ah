import { expect, type Page } from '@playwright/test'

/**
 * Navigate to Clinical Tools → Patient Lookup tab and return the search input.
 * Waits for the input to be ready before returning.
 */
export async function navigateToPatientLookup(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  // Click "Clinical Tools" in the sidebar nav
  const clinicalBtn = page.locator('button.nav-item', { hasText: 'Clinical Tools' })
  await expect(clinicalBtn).toBeVisible({ timeout: 10_000 })
  await clinicalBtn.click()

  // Switch to the "Patient Lookup" sub-tab
  const lookupTab = page.locator('button', { hasText: 'Patient Lookup' })
  await expect(lookupTab).toBeVisible({ timeout: 5_000 })
  await lookupTab.click()

  const input = page.locator('input.input[placeholder*="Bernard"]')
  await expect(input).toBeVisible({ timeout: 5_000 })
  return input
}

/**
 * Open the drawer for the first search result matching the given query.
 * Returns false if no rows appear (data unavailable), true otherwise.
 */
export async function openFirstPatientDrawer(
  page: Page,
  query = '1',
): Promise<boolean> {
  const input = await navigateToPatientLookup(page)
  await input.fill(query)

  const table = page.locator('table.tbl')
  const noMatches = page.getByText(/no matches/i)
  await expect(table.or(noMatches)).toBeVisible({ timeout: 8_000 })

  const tableVisible = await table.isVisible()
  if (!tableVisible) return false

  // Click the first result row
  const firstRow = table.locator('tbody tr').first()
  await expect(firstRow).toBeVisible({ timeout: 5_000 })
  await firstRow.click()

  // Wait for the drawer overlay to appear
  const drawerOverlay = page.locator('.drawer-overlay.open')
  await expect(drawerOverlay).toBeVisible({ timeout: 5_000 })

  return true
}
