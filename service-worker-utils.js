const DEFAULT_SETTINGS = {
  blocklist: "",
  journalUrl: "",
  keywords: "",
  timeframeMinutes: 60,
  blockUrl: "about:blank",
  unlockCooldownMinutes: 0
};

const BLOCKED_ATTEMPTS_STORAGE_KEY = 'blockedAttempts';
const INTENTIONAL_SESSIONS_STORAGE_KEY = 'intentionalSessions';
const MAX_BLOCKED_ATTEMPTS = 500;
const MAX_INTENTIONAL_SESSIONS = 500;

let journalCache = null;
const CACHE_TTL_MS = 60 * 1000;

async function fetchJournal(journalUrl) {
  if (!journalUrl) {
    return {
      ok: false,
      status: null,
      text: null,
      error: 'Journal URL is not configured'
    };
  }

  try {
    const response = await fetch(journalUrl, { cache: 'no-store' });
    if (!response.ok) {
      console.warn('[journal-blocker] Journal fetch returned', response.status);
      return {
        ok: false,
        status: response.status,
        text: null,
        error: `Journal fetch returned HTTP ${response.status}`
      };
    }
    const text = await response.text();
    return {
      ok: true,
      status: response.status,
      text,
      error: null
    };
  } catch (err) {
    console.warn('[journal-blocker] Journal fetch failed:', err);
    return {
      ok: false,
      status: null,
      text: null,
      error: err?.message || String(err)
    };
  }
}

async function fetchJournalCachedResult(journalUrl) {
  if (!journalUrl) return fetchJournal(journalUrl);

  const now = Date.now();
  if (
    journalCache &&
    journalCache.url === journalUrl &&
    (now - journalCache.fetchedAt) < CACHE_TTL_MS
  ) {
    return {
      ok: true,
      status: journalCache.status,
      text: journalCache.text,
      error: null,
      fromCache: true
    };
  }

  const result = await fetchJournal(journalUrl);
  if (result.ok) {
    journalCache = {
      url: journalUrl,
      status: result.status,
      text: result.text,
      fetchedAt: now
    };
  }
  return { ...result, fromCache: false };
}

async function fetchJournalCached(journalUrl) {
  const result = await fetchJournalCachedResult(journalUrl);
  return result.ok ? result.text : null;
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
    const rawText = trimmed.slice(commaIdx + 1).trim();
    const text = rawText.toLowerCase();
    entries.push({ timestamp, text, rawText });
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

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    return '';
  }
}

function findMatchingPattern(url, patterns) {
  const lowerUrl = url.toLowerCase();
  return patterns.find(pattern => lowerUrl.includes(pattern)) || null;
}

function findRecentKeywordMatch(entries, keywords, timeframeMinutes, nowSeconds = Math.floor(Date.now() / 1000)) {
  const timeframeSeconds = timeframeMinutes * 60;
  const cutoff = nowSeconds - timeframeSeconds;
  let latestMatch = null;

  for (const entry of entries) {
    if (entry.timestamp < cutoff) continue;
    const keyword = keywords.find(kw => entry.text.includes(kw));
    if (!keyword) continue;
    if (!latestMatch || entry.timestamp > latestMatch.entry.timestamp) {
      latestMatch = {
        keyword,
        entry,
        expiresAt: entry.timestamp + timeframeSeconds
      };
    }
  }

  return latestMatch;
}

function evaluateJournalAccess(csvText, keywordsRaw, timeframeMinutes, nowSeconds = Math.floor(Date.now() / 1000)) {
  const keywords = Array.isArray(keywordsRaw) ? keywordsRaw : parseLines(keywordsRaw);
  const entries = csvText ? parseCSV(csvText) : [];
  const match = findRecentKeywordMatch(entries, keywords, timeframeMinutes, nowSeconds);
  return {
    allowed: Boolean(match),
    entries,
    keywords,
    match,
    cutoff: nowSeconds - timeframeMinutes * 60
  };
}

function normalizeCooldownMinutes(value) {
  const minutes = parseInt(value, 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function findIntentionalSession(sessions, domain, match) {
  if (!domain || !match) return null;
  return sessions.find(session =>
    session.domain === domain &&
    session.keyword === match.keyword &&
    session.journalTimestamp === match.entry.timestamp
  ) || null;
}

function evaluateUnlockCooldown(session, cooldownMinutes, nowSeconds = Math.floor(Date.now() / 1000)) {
  const minutes = normalizeCooldownMinutes(cooldownMinutes);
  if (minutes === 0 || !session) {
    return {
      enabled: minutes > 0,
      blocked: false,
      expiresAt: null
    };
  }

  const startedAt = session.timestamp || session.journalTimestamp;
  const expiresAt = startedAt + minutes * 60;
  return {
    enabled: true,
    blocked: nowSeconds >= expiresAt,
    startedAt,
    expiresAt
  };
}
