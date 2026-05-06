importScripts('service-worker-utils.js');

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const url = details.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const s = { ...DEFAULT_SETTINGS, ...settings };

  const blockPatterns = parseLines(s.blocklist);
  if (blockPatterns.length === 0) return;

  if (!urlMatchesAnyPattern(url, blockPatterns)) return;

  try {
    const csvText = await fetchJournalCached(s.journalUrl);
    if (csvText === null) return;

    const keywords = parseLines(s.keywords);
    if (keywords.length === 0) return;

    const cutoff = Math.floor(Date.now() / 1000) - s.timeframeMinutes * 60;
    const entries = parseCSV(csvText);
    const hasMatch = entries.some(e =>
      e.timestamp >= cutoff && keywords.some(kw => e.text.includes(kw))
    );

    if (!hasMatch) {
      chrome.tabs.update(details.tabId, { url: s.blockUrl });
    }
  } catch (err) {
    console.warn('[journal-blocker] Error during check, allowing navigation:', err);
  }
}, { url: [{ schemes: ['http', 'https'] }] });
