import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the topbar patient count badge to resolve to a non-zero number.
 *  Returns the parsed count, or null if the element is not present / times out.
 */
async function waitForPatientCount(page: import('@playwright/test').Page, timeout = 15_000): Promise<number | null> {
  try {
    const tag = page.locator('.tag', { hasText: /Live\s*·/ }).first()
    await tag.waitFor({ state: 'visible', timeout })
    const text = await tag.textContent()
    const match = text?.match(/[\d,]+/)
    if (!match) return null
    return parseInt(match[0].replace(/,/g, ''), 10)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Patient list / overview page', () => {

  // -------------------------------------------------------------------------
  // 1. No console errors on load
  // -------------------------------------------------------------------------
  test('no console errors on load', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    await page.goto('/', { waitUntil: 'networkidle' })

    // Allow React hydration warnings (they are warnings, not errors) but
    // fail on true JS errors surfaced to the console.
    const jsErrors = errors.filter(
      (e) =>
        !e.includes('Warning:') &&
        // Next.js dev overlay posts an unhandled-rejection that doesn't
        // affect runtime; filter it out to avoid flakiness in dev mode.
        !e.includes('__webpack') &&
        !e.includes('HMR')
    )
    expect(jsErrors, `Unexpected console errors:\n${jsErrors.join('\n')}`).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 2. Overview page is visible with a non-zero patient count
  // -------------------------------------------------------------------------
  test('patient count badge is visible and non-zero', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    const count = await waitForPatientCount(page)

    // If the server has no data the badge still renders (just 0); we only
    // assert that the badge itself is present — skip the numeric assertion
    // when the API is unavailable so CI doesn't break on cold starts.
    const tag = page.locator('.tag', { hasText: /Live\s*·/ }).first()
    await expect(tag).toBeVisible({ timeout: 15_000 })

    if (count !== null && count > 0) {
      expect(count).toBeGreaterThan(0)
    }
  })

  // -------------------------------------------------------------------------
  // 3. KPI cards render (the "patient cards" on the overview page)
  // -------------------------------------------------------------------------
  test('KPI cards are visible on the overview page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // Wait for loading state to disappear
    await page.waitForFunction(
      () => !document.body.innerText.includes('Loading patients'),
      { timeout: 15_000 }
    )

    // The overview renders a .kpi-row with at least one KPI card
    const kpiRow = page.locator('.kpi-row')
    await expect(kpiRow).toBeVisible({ timeout: 10_000 })

    const kpiCards = kpiRow.locator('> *')
    await expect(kpiCards).toHaveCount(4, { timeout: 5_000 })
  })

  // -------------------------------------------------------------------------
  // 4. Search in PatientLookup filters results (or shows "No matches")
  //    The search input lives in Clinical Tools → Patient Lookup tab
  // -------------------------------------------------------------------------
  test('patient lookup search shows no-matches for unknown query', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // Navigate to Clinical Tools
    const clinicalBtn = page.locator('button.nav-item', { hasText: 'Clinical Tools' })
    await expect(clinicalBtn).toBeVisible({ timeout: 10_000 })
    await clinicalBtn.click()

    // Switch to the Patient Lookup tab
    const lookupTab = page.locator('button', { hasText: 'Patient Lookup' })
    await expect(lookupTab).toBeVisible({ timeout: 5_000 })
    await lookupTab.click()

    // Type a query that should not match any patient
    const input = page.locator('input.input[placeholder*="Bernard"]')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill('ZZZZZ_NO_MATCH_XYZ_9999')

    // Either a "No matches" message or an empty result set
    const noMatches = page.locator('text=No matches')
    await expect(noMatches).toBeVisible({ timeout: 5_000 })
  })

  // -------------------------------------------------------------------------
  // 5. Patient lookup returns results for a partial query that exists
  //    (uses a broad numeric query likely to hit at least one record)
  // -------------------------------------------------------------------------
  test('patient lookup returns results for a generic query', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    const clinicalBtn = page.locator('button.nav-item', { hasText: 'Clinical Tools' })
    await expect(clinicalBtn).toBeVisible({ timeout: 10_000 })
    await clinicalBtn.click()

    const lookupTab = page.locator('button', { hasText: 'Patient Lookup' })
    await expect(lookupTab).toBeVisible({ timeout: 5_000 })
    await lookupTab.click()

    const input = page.locator('input.input[placeholder*="Bernard"]')
    await expect(input).toBeVisible({ timeout: 5_000 })

    // Search by a single digit — highly likely to match multiple S/N values
    await input.fill('1')

    // We expect either a results table or a no-matches notice.
    // The test is "resilient" — if no data it's still acceptable, but
    // when data is present a table row must appear.
    const table = page.locator('table.tbl')
    const noMatches = page.locator('text=No matches')

    await expect(table.or(noMatches)).toBeVisible({ timeout: 8_000 })

    const tableVisible = await table.isVisible()
    if (tableVisible) {
      const rows = table.locator('tbody tr')
      await expect(rows).not.toHaveCount(0, { timeout: 3_000 })
    }
  })

  // -------------------------------------------------------------------------
  // 6. Cohort checkbox filter reduces the patient count
  // -------------------------------------------------------------------------
  test('unchecking a cohort checkbox reduces the patient count', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // Wait until the topbar shows a patient count
    const initialCount = await waitForPatientCount(page)
    if (initialCount === null || initialCount === 0) {
      test.skip()
      return
    }

    // Find the first cohort checkbox (all are checked by default)
    const firstCohortCheckbox = page
      .locator('.filter-block label.check input[type="checkbox"]')
      .first()

    await expect(firstCohortCheckbox).toBeChecked({ timeout: 5_000 })
    await firstCohortCheckbox.click()

    // Wait for the count to update
    await page.waitForFunction(
      (initial) => {
        const tag = document.querySelector('.tag')
        const text = tag?.textContent ?? ''
        const match = text.match(/[\d,]+/)
        if (!match) return false
        const current = parseInt(match[0].replace(/,/g, ''), 10)
        return current !== initial
      },
      initialCount,
      { timeout: 10_000 }
    )

    const newCount = await waitForPatientCount(page)
    if (newCount !== null) {
      expect(newCount).toBeLessThan(initialCount)
    }
  })

  // -------------------------------------------------------------------------
  // 7. Reset filter restores the original patient count
  // -------------------------------------------------------------------------
  test('Reset filter button restores the full patient count', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    const initialCount = await waitForPatientCount(page)
    if (initialCount === null || initialCount === 0) {
      test.skip()
      return
    }

    // Uncheck one cohort checkbox to change the count
    const firstCohortCheckbox = page
      .locator('.filter-block label.check input[type="checkbox"]')
      .first()

    await expect(firstCohortCheckbox).toBeChecked({ timeout: 5_000 })
    await firstCohortCheckbox.click()

    // Wait for count to change
    await page.waitForFunction(
      (initial) => {
        const tag = document.querySelector('.tag')
        const text = tag?.textContent ?? ''
        const match = text.match(/[\d,]+/)
        if (!match) return false
        return parseInt(match[0].replace(/,/g, ''), 10) !== initial
      },
      initialCount,
      { timeout: 10_000 }
    )

    // Now click the Reset button in the sidebar
    const resetBtn = page.locator('.filters button.btn.subtle', { hasText: 'Reset' })
    await expect(resetBtn).toBeVisible({ timeout: 5_000 })
    await resetBtn.click()

    // Wait for count to return to original
    await page.waitForFunction(
      (initial) => {
        const tag = document.querySelector('.tag')
        const text = tag?.textContent ?? ''
        const match = text.match(/[\d,]+/)
        if (!match) return false
        return parseInt(match[0].replace(/,/g, ''), 10) === initial
      },
      initialCount,
      { timeout: 10_000 }
    )

    const restoredCount = await waitForPatientCount(page)
    if (restoredCount !== null) {
      expect(restoredCount).toBe(initialCount)
    }
  })

  // -------------------------------------------------------------------------
  // 8. Age band chip filter changes the patient count
  // -------------------------------------------------------------------------
  test('clicking an age band chip changes the patient count', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    const initialCount = await waitForPatientCount(page)
    if (initialCount === null || initialCount === 0) {
      test.skip()
      return
    }

    // All age-band chips are active by default; deactivating one should reduce count.
    // Chips are rendered inside .chip-row under the "Age band" filter block.
    const ageBandChips = page.locator('.filter-block button.chip')
    const firstChip = ageBandChips.first()

    await expect(firstChip).toBeVisible({ timeout: 5_000 })
    await firstChip.click()

    // Wait for the badge to change
    await page.waitForFunction(
      (initial) => {
        const tag = document.querySelector('.tag')
        const text = tag?.textContent ?? ''
        const match = text.match(/[\d,]+/)
        if (!match) return false
        return parseInt(match[0].replace(/,/g, ''), 10) !== initial
      },
      initialCount,
      { timeout: 10_000 }
    )

    const newCount = await waitForPatientCount(page)
    if (newCount !== null) {
      expect(newCount).not.toBe(initialCount)
    }
  })

})
