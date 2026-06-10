import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Helpers (shared with patient-drawer.spec.ts pattern)
// ---------------------------------------------------------------------------

async function navigateToPatientLookup(page: import('@playwright/test').Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const clinicalBtn = page.locator('button.nav-item', { hasText: 'Clinical Tools' })
  await expect(clinicalBtn).toBeVisible({ timeout: 10_000 })
  await clinicalBtn.click()

  const lookupTab = page.locator('button', { hasText: 'Patient Lookup' })
  await expect(lookupTab).toBeVisible({ timeout: 5_000 })
  await lookupTab.click()

  const input = page.locator('input.input[placeholder*="Bernard"]')
  await expect(input).toBeVisible({ timeout: 5_000 })
  return input
}

async function openFirstPatientDrawer(
  page: import('@playwright/test').Page,
  query = '1',
): Promise<boolean> {
  const input = await navigateToPatientLookup(page)
  await input.fill(query)

  const table = page.locator('table.tbl')
  const noMatches = page.locator('text=No matches')
  await expect(table.or(noMatches)).toBeVisible({ timeout: 8_000 })

  const tableVisible = await table.isVisible()
  if (!tableVisible) return false

  const firstRow = table.locator('tbody tr').first()
  await expect(firstRow).toBeVisible({ timeout: 5_000 })
  await firstRow.click()

  const drawerOverlay = page.locator('.drawer-overlay.open')
  await expect(drawerOverlay).toBeVisible({ timeout: 5_000 })

  return true
}

/**
 * Opens a drawer AND navigates to the "Patient View" tab.
 * Returns false if the drawer could not be opened.
 */
async function openPatientViewTab(
  page: import('@playwright/test').Page,
): Promise<boolean> {
  const opened = await openFirstPatientDrawer(page)
  if (!opened) return false

  const drawer = page.locator('aside.drawer.open')
  const drawerBody = drawer.locator('.drawer-body')

  const patientViewTab = drawerBody.locator('button', { hasText: 'Patient View' })
  await expect(patientViewTab).toBeVisible({ timeout: 5_000 })
  await patientViewTab.click()

  // Wait for the progress view to settle — heading or loading indicator appears
  const heading = drawerBody.getByText('Your progress so far', { exact: false })
  const loadingProgress = drawerBody.getByText('Loading your data', { exact: false })
  await expect(heading.or(loadingProgress)).toBeVisible({ timeout: 8_000 })

  return true
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Patient View tab', () => {

  // -------------------------------------------------------------------------
  // 1. "Patient View" tab visible in drawer tab bar
  // -------------------------------------------------------------------------
  test('"Patient View" tab button is visible in drawer tab bar', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    const patientViewTab = drawerBody.locator('button', { hasText: 'Patient View' })
    await expect(patientViewTab).toBeVisible({ timeout: 5_000 })
  })

  // -------------------------------------------------------------------------
  // 2. Clicking "Patient View" tab shows progress heading
  // -------------------------------------------------------------------------
  test('clicking "Patient View" tab shows "Your progress so far" heading', async ({ page }) => {
    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    const heading = drawerBody.getByText('Your progress so far', { exact: false })
    await expect(heading).toBeVisible({ timeout: 8_000 })
  })

  // -------------------------------------------------------------------------
  // 3. "Reduce my pain" and "Move better" buttons visible
  // -------------------------------------------------------------------------
  test('"Reduce my pain" and "Move better" goal buttons are visible', async ({ page }) => {
    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    const painBtn = drawerBody.locator('button', { hasText: 'Reduce my pain' })
    const moveBtn = drawerBody.locator('button', { hasText: 'Move better' })

    await expect(painBtn).toBeVisible({ timeout: 5_000 })
    await expect(moveBtn).toBeVisible({ timeout: 5_000 })
  })

  // -------------------------------------------------------------------------
  // 4. Clicking "Move better" gives it active state
  // -------------------------------------------------------------------------
  test('clicking "Move better" gives it active/accent visual state', async ({ page }) => {
    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    const moveBtn = drawerBody.locator('button', { hasText: 'Move better' })
    await expect(moveBtn).toBeVisible({ timeout: 5_000 })
    await moveBtn.click()

    // Active state: border changes to var(--accent) which renders as a non-transparent blue border.
    // We check the inline style — GoalPicker sets border with var(--accent) when active.
    // Playwright can evaluate computed styles, so verify the border-color is not the default line color.
    const borderColor = await moveBtn.evaluate((el) =>
      window.getComputedStyle(el).borderColor
    )
    // The inactive border uses var(--line), active uses var(--accent).
    // We assert the color is truthy and capture it — in most themes accent is a blue tone.
    // A lightweight check: the element's style attribute should reference "accent" (set inline).
    const style = await moveBtn.getAttribute('style')
    expect(style).toContain('accent')
  })

  // -------------------------------------------------------------------------
  // 5. Clicking "Reduce my pain" switches back to that goal
  // -------------------------------------------------------------------------
  test('clicking "Reduce my pain" after "Move better" switches back', async ({ page }) => {
    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    // First select "Move better"
    const moveBtn = drawerBody.locator('button', { hasText: 'Move better' })
    await expect(moveBtn).toBeVisible({ timeout: 5_000 })
    await moveBtn.click()

    // Then switch back to pain
    const painBtn = drawerBody.locator('button', { hasText: 'Reduce my pain' })
    await painBtn.click()

    // "Reduce my pain" should now have the accent border in its style
    const painStyle = await painBtn.getAttribute('style')
    expect(painStyle).toContain('accent')

    // "Move better" should no longer have accent in border
    const moveStyle = await moveBtn.getAttribute('style')
    // The inactive style uses var(--line) for the border
    expect(moveStyle).not.toContain('var(--accent)')
  })

  // -------------------------------------------------------------------------
  // 6. Session slider present with min=1 and max=12
  // -------------------------------------------------------------------------
  test('session slider is present with min=1 and max=12', async ({ page }) => {
    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    const slider = drawerBody.locator('input[type="range"]')
    await expect(slider).toBeVisible({ timeout: 8_000 })

    const min = await slider.getAttribute('min')
    const max = await slider.getAttribute('max')
    expect(min).toBe('1')
    expect(max).toBe('12')
  })

  // -------------------------------------------------------------------------
  // 7. Moving slider changes "X more sessions" label
  // -------------------------------------------------------------------------
  test('moving slider updates "X more sessions" label', async ({ page }) => {
    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    const slider = drawerBody.locator('input[type="range"]')
    await expect(slider).toBeVisible({ timeout: 8_000 })

    // Move slider to value 8 via evaluate + input event dispatch
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '8'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Label should now read "8 more sessions"
    const label = drawerBody.locator('span', { hasText: '8 more sessions' })
    await expect(label).toBeVisible({ timeout: 3_000 })
  })

  // -------------------------------------------------------------------------
  // 8. After slider change, no new API requests to metric_series
  // -------------------------------------------------------------------------
  test('moving slider does not trigger new metric_series API requests', async ({ page }) => {
    let metricSeriesCallCount = 0

    // Intercept before navigation so we capture ALL requests
    await page.route('**/api/patient/*/metric_series**', (route) => {
      metricSeriesCallCount++
      route.continue()
    })

    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    const slider = drawerBody.locator('input[type="range"]')
    await expect(slider).toBeVisible({ timeout: 8_000 })

    // Wait for initial data load to complete (count stabilises)
    await page.waitForTimeout(1_000)
    const countBeforeSlider = metricSeriesCallCount

    // Move slider several times
    for (const val of ['3', '6', '9', '12']) {
      await slider.evaluate((el: HTMLInputElement, v) => {
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }, val)
      await page.waitForTimeout(150)
    }

    // No new metric_series calls should have fired
    expect(metricSeriesCallCount).toBe(countBeforeSlider)
  })

  // -------------------------------------------------------------------------
  // 9. Chart or empty state is visible (not blank white space)
  // -------------------------------------------------------------------------
  test('chart SVG or "No data yet" empty state is visible', async ({ page }) => {
    const opened = await openPatientViewTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    // Wait for loading to finish
    const loadingMsg = drawerBody.getByText('Loading your data', { exact: false })
    await loadingMsg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {
      // If it never appeared, that's fine — data may have loaded instantly
    })

    // Either the SVG chart or the "No data yet" empty state must be visible
    const chart = drawerBody.locator('svg').first()
    const emptyState = drawerBody.getByText('No data yet', { exact: false })

    await expect(chart.or(emptyState)).toBeVisible({ timeout: 8_000 })
  })

})
