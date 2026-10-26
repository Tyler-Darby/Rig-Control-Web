import fs from 'fs';
import { test, expect, USER_PREFS_PATH } from '../fixtures/test.ts';
import { BASE_URL } from '../../playwright.config.ts';
import { DEFAULT_COMPACT_LAYOUT, DEFAULT_PHONE_LAYOUT } from '../../src/hooks/useLayoutConfig.ts';

// Per-user UI prefs are mirrored server-side (server/userPrefs.ts,
// src/utils/userPrefsSync.ts) so a user's layout follows them to any
// device/browser/origin. These drive the real app end to end: a layout edit
// in one browser context must reach the server and then be restored in a
// second, completely fresh context (no localStorage at all — a different
// device) after a real login, and again after that context reloads (the
// token-refresh path a server restart or reconnect goes through).

const SOLAR_TITLE = 'Solar Conditions';

function serverLayout(): { compact: { items: Array<{ panelType?: string }> } } | null {
  try {
    const file = JSON.parse(fs.readFileSync(USER_PREFS_PATH, 'utf-8'));
    const raw = file.users?.ADMIN?.prefs?.['grid-layout-v1'];
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function serverHasSolar(): boolean | null {
  const layout = serverLayout();
  return layout ? layout.compact.items.some(i => i.panelType === 'solar') : null;
}

test.describe('Per-user preference sync', () => {
  test('a layout edit follows the user to a fresh browser and survives its reload', async ({ page, browser }) => {
    await page.goto('/');
    await expect(page.getByText(SOLAR_TITLE, { exact: true })).toBeVisible();

    await page.getByTitle('Edit layout').click();
    await page.getByTitle(`Remove ${SOLAR_TITLE}`).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(SOLAR_TITLE, { exact: true })).toHaveCount(0);

    await expect.poll(serverHasSolar, { timeout: 5_000 }).toBe(false);

    // A different device: empty storage, real login.
    const other = await browser.newContext({ ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
    try {
      const otherPage = await other.newPage();
      await otherPage.goto(BASE_URL);
      await otherPage.getByPlaceholder('W1ABC').fill('ADMIN');
      await otherPage.locator('input[type="password"]').fill('TestHarness123!');
      await otherPage.getByRole('button', { name: /sign in/i }).click();

      await expect(otherPage.getByTitle('Edit layout')).toBeVisible();
      await expect(otherPage.getByText(SOLAR_TITLE, { exact: true })).toHaveCount(0);

      await otherPage.reload();
      await expect(otherPage.getByTitle('Edit layout')).toBeVisible();
      await expect(otherPage.getByText(SOLAR_TITLE, { exact: true })).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test('the first browser to log in seeds the server from its existing local layout', async ({ page }) => {
    const cfg = {
      compact: { ...DEFAULT_COMPACT_LAYOUT, items: DEFAULT_COMPACT_LAYOUT.items.filter(i => i.panelType !== 'solar') },
      phone: DEFAULT_PHONE_LAYOUT,
    };
    await page.addInitScript((c) => {
      localStorage.setItem('ADMIN:grid-layout-v1', JSON.stringify(c));
    }, cfg);

    expect(serverLayout()).toBeNull();
    await page.goto('/');
    await expect(page.getByTitle('Edit layout')).toBeVisible();
    await expect(page.getByText(SOLAR_TITLE, { exact: true })).toHaveCount(0);

    await expect.poll(serverHasSolar, { timeout: 5_000 }).toBe(false);
  });
});
