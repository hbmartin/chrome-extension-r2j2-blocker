importScripts('service-worker-utils.js');

let currentSettings = DEFAULT_SETTINGS;

function normalizeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    ...merged,
    blockUrl: (merged.blockUrl || '').trim() || DEFAULT_SETTINGS.blockUrl
  };
}

const settingsReady = chrome.storage.sync.get({ settings: DEFAULT_SETTINGS }).then(({ settings }) => {
  currentSettings = normalizeSettings(settings);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.settings) return;
  currentSettings = normalizeSettings(changes.settings.newValue);
});

function redirectToBlockUrl(tabId, currentUrl, blockUrl, blockPatterns) {
  if (currentUrl === blockUrl) return;
  if (urlMatchesAnyPattern(blockUrl, blockPatterns)) {
    console.warn('[journal-blocker] blockUrl matches blocklist; refusing to redirect');
    return;
  }
  chrome.tabs.update(tabId, { url: blockUrl });
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const url = details.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  await settingsReady;
  const s = currentSettings;

  const blockPatterns = parseLines(s.blocklist);
  if (blockPatterns.length === 0) return;

  if (!urlMatchesAnyPattern(url, blockPatterns)) return;

  try {
    const csvText = await fetchJournalCached(s.journalUrl);
    const keywords = parseLines(s.keywords);
    const cutoff = Math.floor(Date.now() / 1000) - s.timeframeMinutes * 60;
    const entries = csvText === null ? [] : parseCSV(csvText);
    const hasMatch = keywords.length > 0 && entries.some(e =>
      e.timestamp >= cutoff && keywords.some(kw => e.text.includes(kw))
    );

    if (!hasMatch) {
      redirectToBlockUrl(details.tabId, url, s.blockUrl, blockPatterns);
    }
  } catch (err) {
    console.warn('[journal-blocker] Error during check, blocking navigation:', err);
    redirectToBlockUrl(details.tabId, url, s.blockUrl, blockPatterns);
  }
}, { url: [{ schemes: ['http', 'https'] }] });
