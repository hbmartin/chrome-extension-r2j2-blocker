const DEFAULT_SETTINGS = {
  blocklist: "",
  journalUrl: "",
  keywords: "",
  timeframeMinutes: 60,
  blockUrl: "about:blank"
};

let journalCache = null;
const CACHE_TTL_MS = 60 * 1000;

async function fetchJournalCached(journalUrl) {
  if (!journalUrl) return null;

  const now = Date.now();
  if (
    journalCache &&
    journalCache.url === journalUrl &&
    (now - journalCache.fetchedAt) < CACHE_TTL_MS
  ) {
    return journalCache.text;
  }

  try {
    const response = await fetch(journalUrl, { cache: 'no-store' });
    if (!response.ok) {
      console.warn('[journal-blocker] Journal fetch returned', response.status);
      return null;
    }
    const text = await response.text();
    journalCache = { url: journalUrl, text, fetchedAt: now };
    return text;
  } catch (err) {
    console.warn('[journal-blocker] Journal fetch failed:', err);
    return null;
  }
}

// Parses "unix_timestamp,text" CSV. Uses indexOf(',') so commas in text work.
// Lowercases text at parse time for case-insensitive keyword matching.
function parseCSV(csvText) {
  const entries = [];
  for (const line of csvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx === -1) continue;
    const timestamp = parseInt(trimmed.slice(0, commaIdx).trim(), 10);
    if (isNaN(timestamp)) continue;
    const text = trimmed.slice(commaIdx + 1).trim().toLowerCase();
    entries.push({ timestamp, text });
  }
  return entries;
}

// Splits a newline-separated settings value into a cleaned, lowercased array.
function parseLines(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(line => line.length > 0);
}

// Case-insensitive substring match of url against each pattern.
function urlMatchesAnyPattern(url, patterns) {
  const lowerUrl = url.toLowerCase();
  return patterns.some(pattern => lowerUrl.includes(pattern));
}
