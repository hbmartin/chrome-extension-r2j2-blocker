# Journal-Gated URL Blocker

A Chrome extension that blocks distracting URLs unless you have recently journaled a matching keyword.

The extension is designed to work with the [R2J2 backend](https://github.com/hbmartin/r2j2), a Cloudflare Worker that writes timestamped journal entries to Cloudflare R2 and exposes them as CSV.

## How It Works

1. You configure URL patterns to block, such as `reddit.com` or `youtube.com`.
2. You configure a journal CSV URL from the R2J2 backend.
3. You configure keywords that represent intentional use, such as `research`, `work`, or a project name.
4. When you navigate to a matching URL, the extension fetches recent journal entries.
5. Access is allowed only if a configured keyword appears in a journal entry inside the configured timeframe.
6. If no recent match is found, the tab is redirected to the configured block URL.

Both full page loads and single-page-app route changes (history.pushState) are checked, so client-side navigation inside a site cannot bypass the gate.

The toolbar icon shows a per-tab badge for journal-gated sites: green with the minutes remaining while unlocked, or a red ✕ while blocked. The badge is empty on pages that do not match your blocklist.

Matching is intentionally simple:

- Blocked URLs use case-insensitive substring matching against the full URL.
- Keywords use case-insensitive substring matching against journal entry text.
- Journal CSV rows must be in the format `unix_timestamp,entry text`.

## Backend

This extension expects a journal API compatible with [hbmartin/r2j2](https://github.com/hbmartin/r2j2).

R2J2 provides:

- `GET /?password=...&text=...` to add a journal entry.
- `GET /csv?password=...` to retrieve all entries as CSV.
- Cloudflare R2 storage for the journal data.
- Cloudflare Worker deployment through Wrangler.

Use the R2J2 `/csv` URL as the extension's **Journal CSV URL**. For example:

```text
https://your-worker.your-subdomain.workers.dev/csv?password=your-secret
```

Do not publish an extension build with a personal journal URL or password already configured.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome or another Chromium-based browser.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Open the extension options page and configure your settings.

## Settings

### Blocked URL Patterns

One pattern per line. Any page URL containing one of these values is journal-gated.

```text
reddit.com
twitter.com
news.ycombinator.com
```

### Journal CSV URL

The R2J2 CSV endpoint, including its password query parameter.

```text
https://your-worker.your-subdomain.workers.dev/csv?password=your-secret
```

The service worker caches this response for 60 seconds to avoid fetching the backend on every navigation. The cache lives in `chrome.storage.session`, so it survives Manifest V3 service worker restarts but is cleared when the browser closes.

### Keywords

One keyword per line. If any keyword appears in a recent journal entry, navigation is allowed.

```text
research
writing
project-name
```

### Timeframe

The number of minutes a journal entry remains valid for allowing access. The default is `60`.

### Access Limit After Unlock

Optional. Set this to `0` to disable it. When enabled, a valid journal entry can unlock each blocked domain only for the configured number of minutes after the first successful access for that journal entry.

### Block Redirect URL

Where blocked tabs should be redirected when no recent journal match exists. The default is `about:blank`.

If the redirect URL itself matches the blocklist, the extension falls back to `about:blank` to avoid redirect loops.

### Import and Export

The settings page can export the current form values as a JSON file and import JSON settings back into Chrome sync storage.

Exports use this shape:

```json
{
  "version": 1,
  "exportedAt": "2026-05-11T00:00:00.000Z",
  "settings": {
    "blocklist": "reddit.com",
    "journalUrl": "https://example.com/journal.csv",
    "keywords": "research",
    "timeframeMinutes": 60,
    "blockUrl": "about:blank",
    "unlockCooldownMinutes": 0
  }
}
```

Import also accepts a raw settings object with the same fields as `settings`.

## Logo Assets

The source logo is `logo/logo.png`. Regenerate the Chrome icon sizes with:

```bash
./scripts/regenerate-logos.sh
```

This writes:

- `logo/logo-16.png`
- `logo/logo-48.png`
- `logo/logo-128.png`

The script uses macOS `sips`.

## Development Notes

This is a Manifest V3 extension. The background logic lives in `service-worker.js`, shared parsing helpers live in `service-worker-utils.js`, the popup lives in `popup/`, and the options page lives in `settings/`.

There is no build step. After changing source files, reload the extension from `chrome://extensions`.

### Tests and Linting

The pure helpers in `service-worker-utils.js` are covered by unit tests that run on Node's built-in test runner (no test framework dependency):

```bash
npm install
npm test
npm run lint
```

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs the linter and tests on every push to `main` and on every pull request.

## Security Notes

- The extension stores settings in Chrome sync storage.
- Blocked-attempt and intentional-session summaries are stored locally in Chrome local storage, and records older than 30 days are pruned automatically.
- The journal URL may include a backend password, so treat extension configuration as sensitive.
- Error messages and logs redact the journal URL's query string, so the password does not appear in the console or the popup diagnostics.
- The backend should be deployed and secured separately through the R2J2 repository instructions.
- Fetch failures are treated as blocked navigation.

## Roadmap

Ideas that are noted but not implemented yet:

- **declarativeNetRequest-based blocking.** Blocking currently happens by redirecting the tab after `webNavigation.onBeforeNavigate`, so a blocked page can briefly start loading while the journal check runs. Dynamic `declarativeNetRequest` rules would block instantly at the network layer and swap out when a journal match unlocks a domain.
- **Last-known-good grace period.** Fetch failures fail closed, so a backend outage or captive-portal Wi-Fi blocks every configured site. A short window that honors the most recent successful journal match during fetch failures (with a clear popup indicator) would soften total lockouts.
- **Narrower host permissions.** The extension currently requests `*://*/*`. It only needs to fetch the journal URL, so `optional_host_permissions` scoped to the journal's origin at configuration time would reduce the permission footprint.
- **Journal password out of the synced URL.** Store the password separately in `chrome.storage.local` (never synced), have the backend accept it as a header, and exclude it from JSON settings exports.
- **Packaged releases.** A CI step that zips the extension and attaches it to GitHub releases, so installs do not require "load unpacked" from a cloned repo.
- **Hostname-based pattern matching.** Substring matching over the full URL means `reddit.com` also matches unrelated URLs that merely contain that string. Matching against the hostname with wildcard subdomain support (`*.reddit.com`) would be more predictable.
- **Custom block page.** Replace `about:blank` with a bundled page that explains why the navigation was blocked, shows which keywords would unlock it, and offers a "journal right now" box that posts to the R2J2 write endpoint and retries the original URL.
- **Per-pattern keywords or profiles.** Let each blocked pattern require its own keywords (for example `youtube.com` requires `video-research` while `twitter.com` requires `outreach`) instead of any keyword unlocking every site.
