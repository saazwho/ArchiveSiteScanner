// Capture the real popup using its built-in localhost demo. No archive requests.
// Optional dependency: playwright. See docs/DEVELOPMENT.md for setup.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs', 'screenshots');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ARCHIVUM_BROWSER_PATH ? { executablePath: process.env.ARCHIVUM_BROWSER_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 460, height: 600 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:\/\//, async route => {
      externalRequests.push(route.request().url());
      await route.abort();
    });
    // Emulate only extension APIs. All UI state and demo records come from popup.js.
    await page.addInitScript(() => {
      const store = {};
      window.chrome = {
        tabs: { query: async () => [{ url: 'http://localhost:8000/' }] },
        storage: { local: {
          get: async () => structuredClone(store),
          set: async data => Object.assign(store, structuredClone(data)),
        } },
      };
    });
    await page.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    await page.waitForFunction(() => !document.getElementById('scanBtn').disabled);
    assert.equal(await page.locator('#currentHost').textContent(), 'localhost');
    const capture = async name => {
      await page.mouse.move(0, 0);
      const footer = await page.locator('.footer').boundingBox();
      assert.ok(footer.y + footer.height <= 600, 'Footer fits the popup');
      assert.match(await page.locator('.footer').textContent(), /Independent · Unaffiliated/);
      await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
      console.log(`Captured docs/screenshots/${name}.png`);
    };
    await capture('01-ready');

    await page.locator('#scanBtn').click();
    await page.waitForFunction(() => document.getElementById('statSource').textContent === 'Local demo');
    await page.waitForFunction(() => document.querySelectorAll('.tree-file').length >= 4);
    assert.equal(await page.locator('#statCount').textContent(), '10');
    await page.locator('.tree-folder').filter({ hasText: 'assets' }).click();
    await page.waitForFunction(() => document.querySelector('a[href="http://localhost:8000/assets/app.js"]'));
    await page.locator('#results').evaluate(element => { element.scrollTop = 35; });
    await page.locator('h1').click();
    await capture('02-explore');

    await page.locator('#searchInput').fill('admin');
    await page.waitForFunction(() => document.querySelectorAll('.tree-file').length === 3);
    assert.equal(await page.locator('mark').count(), 3);
    await capture('03-search');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportJson').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'archivum_records.json');
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(exported.length, 10, 'Exports retain all URLs while search is active');

    await page.locator('#clearSearch').click();
    await page.locator('#optionsToggle').click();
    assert.equal(await page.locator('#optionsToggle').getAttribute('aria-expanded'), 'true');
    await capture('04-options');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    assert.deepEqual(externalRequests, [], 'Screenshots never contact external services');
    console.log('Four screenshots verified. Demo, search, export, layout, and independence notice checks passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
