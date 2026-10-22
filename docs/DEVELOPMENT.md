# Development

[← Back to the README](../README.md)

Archivum is an unpacked Manifest V3 extension with no build step or runtime dependency. Load the repository directory in a Chromium-based browser and reload the extension after changing files.

## File layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension metadata and permissions |
| `popup.html` | Popup structure, labels, and independence notice |
| `styles.css` | Layout, colors, typography, focus states, and reduced motion |
| `popup.js` | CDX requests, caching, tree rendering, search, and exports |
| `tests/popup.test.cjs` | Dependency-free Node regression tests |
| `scripts/capture-screenshots.cjs` | Optional Chromium screenshot workflow with demo interaction checks |
| `docs/screenshots/` | Screenshots displayed in the README and usage guide |
| `.github/workflows/checks.yml` | Syntax and regression checks for pushes and pull requests |

## Run checks

Use Node.js 24 or newer from the repository root:

```sh
node --check popup.js
node --check scripts/capture-screenshots.cjs
node --test tests/popup.test.cjs
```

Tests cover URL preservation, reserved path names, filter-specific cache keys and expiration, safe result links, search escaping, supported tabs, and CDX request/response handling. They use mocks and do not make live archive requests. No `npm install` is needed for these checks.

The GitHub workflow runs the same checks with read-only repository permissions. It does not deploy, publish, or contact Internet Archive.

## Regenerate screenshots

The optional screenshot script uses the [Playwright library](https://playwright.dev/docs/library). Install its local development dependency and Chromium:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node scripts/capture-screenshots.cjs
```

These dependencies are only for screenshot generation, not for loading or using the extension. `node_modules/` is ignored by Git.

The script loads the real popup, emulates the active-tab and local-storage APIs, and selects `http://localhost:8000/` as the active tab. The popup’s own built-in demo produces the records. No local server is required for this script, and outbound HTTP requests are blocked. The script checks that no external request occurred.

It saves four 2× PNGs in `docs/screenshots/`: the ready screen, expanded results, a search, and query options. It also checks the sample result count, search highlighting, full JSON export during search, popup bounds, and the visible independence notice. Review the images before committing them.

If Chromium is installed at a custom location, set `ARCHIVUM_BROWSER_PATH` to its executable path when running the script. Screenshot fonts can vary slightly by operating system.

## Manual verification

Before submitting a functional change, check the affected flows in the actual extension:

- Load the popup on a normal website and on an unsupported browser-internal page.
- Query once, reuse the cache, change filters, and force a refresh.
- Expand folders, search URL text, clear search, and use the keyboard shortcuts.
- Export each format and verify that search has not reduced the exported records.
- Check empty and error states, long hostnames, and the reduced-motion setting.

Keep any live API checks small and deliberate. Prefer mocked responses and the local demo for repeated development work. Preserve the minimum permissions and clear, independent-project wording.

## Contributing

Open an issue with the browser version, reproduction steps, expected behavior, and observed behavior. Pull requests should explain the change and checks performed. Include screenshots for UI changes, using demo data where possible. Remove private hostnames, tokens, personal data, and sensitive URL text from reports and attachments.
