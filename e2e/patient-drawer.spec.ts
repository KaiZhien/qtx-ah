import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to Clinical Tools → Patient Lookup tab and return the search input.
 * Waits for data to be ready before returning.
 */
async function navigateToPatientLookup(page: import('@playwright/test').Page) {
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
 * Returns without clicking if no rows appear (data unavailable).
 */
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

  // Click the first result row
  const firstRow = table.locator('tbody tr').first()
  await expect(firstRow).toBeVisible({ timeout: 5_000 })
  await firstRow.click()

  // Wait for the drawer overlay to appear
  const drawerOverlay = page.locator('.drawer-overlay.open')
  await expect(drawerOverlay).toBeVisible({ timeout: 5_000 })

  return true
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Patient drawer', () => {

  // -------------------------------------------------------------------------
  // 1. Clicking a patient row opens the drawer panel
  // -------------------------------------------------------------------------
  test('clicking patient row opens the drawer', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      // No data available — skip rather than fail
      test.skip()
      return
    }

    // The drawer itself should be visible
    const drawer = page.locator('aside.drawer.open')
    await expect(drawer).toBeVisible({ timeout: 5_000 })
  })

  // -------------------------------------------------------------------------
  // 2. Drawer header contains patient info (subtitle "Patient record" + title)
  // -------------------------------------------------------------------------
  test('drawer header shows patient record subtitle and patient title', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')

    // Subtitle is always "Patient record"
    const subtitle = drawer.locator('.drawer-h').getByText('Patient record', { exact: false })
    await expect(subtitle).toBeVisible({ timeout: 5_000 })

    // Title is either the patient's name or "Patient <sn>" — just assert it's non-empty
    const drawerH = drawer.locator('.drawer-h')
    const titleText = await drawerH.locator('div').filter({ hasText: /Patient|[A-Z]/ }).first().textContent()
    expect(titleText).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // 3. Default tab is Clinical — Pre vs Post outcomes table is visible
  // -------------------------------------------------------------------------
  test('default tab is Clinical with Pre vs Post outcomes table', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    // The "Clinical" tab button should be active by default
    const clinicalTabBtn = drawerBody.locator('button', { hasText: 'Clinical' })
    await expect(clinicalTabBtn).toBeVisible({ timeout: 5_000 })

    // The Pre vs Post outcomes table header row should be visible
    const prevspostLabel = drawerBody.getByText('Pre vs Post outcomes', { exact: false })
    await expect(prevspostLabel).toBeVisible({ timeout: 5_000 })

    // The table with Pre / Post / Delta columns
    const outcomesTable = drawerBody.locator('table.tbl')
    await expect(outcomesTable).toBeVisible({ timeout: 5_000 })

    const preHeader = outcomesTable.locator('th', { hasText: 'Pre' })
    const postHeader = outcomesTable.locator('th', { hasText: 'Post' })
    const deltaHeader = outcomesTable.locator('th', { hasText: 'Delta' })
    await expect(preHeader).toBeVisible()
    await expect(postHeader).toBeVisible()
    await expect(deltaHeader).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // 4. Clicking the Wearable tab renders the wearable section
  // -------------------------------------------------------------------------
  test('Wearable tab renders wearable section (enroll UI or metrics)', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    // Click the Wearable tab
    const wearableTab = drawerBody.locator('button', { hasText: 'Wearable' })
    await expect(wearableTab).toBeVisible({ timeout: 5_000 })
    await wearableTab.click()

    // Either loading state, error, enroll UI, or wearable metrics should appear.
    // We check for any of: "Loading wearable data", "Connect a wearable device",
    // "Wearable metrics", or an error banner — all live inside the wearable tab.
    const loadingMsg = drawerBody.getByText('Loading wearable data', { exact: false })
    const connectMsg = drawerBody.getByText('Connect a wearable device', { exact: false })
    const metricsMsg = drawerBody.getByText('Wearable metrics', { exact: false })
    const errorMsg  = drawerBody.getByText('Could not load wearable data', { exact: false })

    await expect(
      loadingMsg.or(connectMsg).or(metricsMsg).or(errorMsg)
    ).toBeVisible({ timeout: 8_000 })
  })

  // -------------------------------------------------------------------------
  // 5. Clicking the Timeline tab renders without crashing
  // -------------------------------------------------------------------------
  test('Timeline tab renders session rows or empty state without crashing', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    // Click the Timeline tab
    const timelineTab = drawerBody.locator('button', { hasText: 'Timeline' })
    await expect(timelineTab).toBeVisible({ timeout: 5_000 })
    await timelineTab.click()

    // Wait for the Timeline content area to settle (500ms grace)
    await page.waitForTimeout(500)

    // The drawer body should still be present (no crash / unmount)
    await expect(drawerBody).toBeVisible()

    // Filter out known-safe noise from console errors
    const jsErrors = errors.filter(
      (e) => !e.includes('Warning:') && !e.includes('__webpack') && !e.includes('HMR')
    )
    expect(jsErrors, `Unexpected errors on Timeline tab:\n${jsErrors.join('\n')}`).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 6. Clicking the AI tab shows the question textarea
  // -------------------------------------------------------------------------
  test('AI tab shows ask input field', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    const drawerBody = drawer.locator('.drawer-body')

    // Click the AI tab
    const aiTab = drawerBody.locator('button', { hasText: 'AI' })
    await expect(aiTab).toBeVisible({ timeout: 5_000 })
    await aiTab.click()

    // The QAPanel textarea for asking questions should be visible
    const askTextarea = drawerBody.locator(
      'textarea[placeholder*="clinical question"]'
    )
    await expect(askTextarea).toBeVisible({ timeout: 6_000 })

    // "Ask a Question" label should also appear
    const askLabel = drawerBody.getByText('Ask a Question', { exact: false })
    await expect(askLabel).toBeVisible({ timeout: 5_000 })
  })

  // -------------------------------------------------------------------------
  // 7. Clicking the close button dismisses the drawer
  // -------------------------------------------------------------------------
  test('clicking the close button dismisses the drawer', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawer = page.locator('aside.drawer.open')
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    // Click the X / close button inside the drawer header
    const closeBtn = drawer.locator('.drawer-h button[aria-label="Close"]')
    await expect(closeBtn).toBeVisible({ timeout: 5_000 })
    await closeBtn.click()

    // Drawer should no longer have the "open" class / be visible
    await expect(drawer).not.toBeVisible({ timeout: 5_000 })
  })

  // -------------------------------------------------------------------------
  // 8. Clicking the overlay (outside the drawer) dismisses it
  // -------------------------------------------------------------------------
  test('clicking outside the drawer (overlay) dismisses it', async ({ page }) => {
    const opened = await openFirstPatientDrawer(page)
    if (!opened) {
      test.skip()
      return
    }

    const drawerOverlay = page.locator('.drawer-overlay.open')
    await expect(drawerOverlay).toBeVisible({ timeout: 5_000 })

    // Click the overlay area (top-left corner is safely outside the drawer panel)
    await drawerOverlay.click({ position: { x: 20, y: 20 } })

    // Overlay should disappear
    await expect(drawerOverlay).not.toBeVisible({ timeout: 5_000 })
  })

})
