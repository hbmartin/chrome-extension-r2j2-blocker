importScripts('service-worker-utils.js');

let currentSettings = DEFAULT_SETTINGS;

function normalizeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    ...merged,
    blockUrl: (merged.blockUrl || '').trim() || DEFAULT_SETTINGS.blockUrl,
    unlockCooldownMinutes: normalizeCooldownMinutes(merged.unlockCooldownMinutes)
  };
}

const settingsReady = chrome.storage.sync.get({ settings: DEFAULT_SETTINGS })
  .then(({ settings }) => {
    currentSettings = normalizeSettings(settings);
  })
  .catch(err => {
    console.warn('[journal-blocker] Failed to load settings, using defaults:', err);
    currentSettings = DEFAULT_SETTINGS;
  });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.settings) return;
  currentSettings = normalizeSettings(changes.settings.newValue);
});

function urlsAreEqual(firstUrl, secondUrl) {
  try {
    return new URL(firstUrl).href === new URL(secondUrl).href;
  } catch (err) {
    return firstUrl === secondUrl;
  }
}

async function loadBlockedAttempts() {
  const result = await chrome.storage.local.get({ [BLOCKED_ATTEMPTS_STORAGE_KEY]: [] });
  const attempts = result[BLOCKED_ATTEMPTS_STORAGE_KEY];
  return Array.isArray(attempts) ? attempts : [];
}

async function saveBlockedAttempts(attempts) {
  await chrome.storage.local.set({
    [BLOCKED_ATTEMPTS_STORAGE_KEY]: attempts.slice(-MAX_BLOCKED_ATTEMPTS)
  });
}

async function recordBlockedAttempt(url, matchedPattern) {
  try {
    const domain = domainFromUrl(url);
    if (!domain) return;

    const attempts = await loadBlockedAttempts();
    attempts.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      domain,
      matchedPattern,
      timestamp: Math.floor(Date.now() / 1000),
      journaledLater: false,
      journaledAt: null,
      unlockKeyword: null
    });
    await saveBlockedAttempts(attempts);
  } catch (err) {
    console.warn('[journal-blocker] Failed to record blocked attempt:', err);
  }
}

async function markAttemptsJournaledLater(url, match) {
  try {
    if (!match) return;
    const domain = domainFromUrl(url);
    if (!domain) return;

    const attempts = await loadBlockedAttempts();
    let changed = false;

    for (const attempt of attempts) {
      if (attempt.domain !== domain || attempt.journaledLater) continue;
      if (attempt.timestamp > match.entry.timestamp) continue;
      attempt.journaledLater = true;
      attempt.journaledAt = match.entry.timestamp;
      attempt.unlockKeyword = match.keyword;
      changed = true;
    }

    if (changed) await saveBlockedAttempts(attempts);
  } catch (err) {
    console.warn('[journal-blocker] Failed to update blocked attempts:', err);
  }
}

async function loadIntentionalSessions() {
  const result = await chrome.storage.local.get({ [INTENTIONAL_SESSIONS_STORAGE_KEY]: [] });
  const sessions = result[INTENTIONAL_SESSIONS_STORAGE_KEY];
  return Array.isArray(sessions) ? sessions : [];
}

async function saveIntentionalSessions(sessions) {
  await chrome.storage.local.set({
    [INTENTIONAL_SESSIONS_STORAGE_KEY]: sessions.slice(-MAX_INTENTIONAL_SESSIONS)
  });
}

async function recordIntentionalSession(url, match) {
  try {
    if (!match) return;
    const domain = domainFromUrl(url);
    if (!domain) return;

    const sessions = await loadIntentionalSessions();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const existing = findIntentionalSession(sessions, domain, match);

    if (existing) {
      existing.lastSeenAt = nowSeconds;
      existing.visitCount = (existing.visitCount || 1) + 1;
    } else {
      sessions.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        domain,
        keyword: match.keyword,
        timestamp: nowSeconds,
        lastSeenAt: nowSeconds,
        journalTimestamp: match.entry.timestamp,
        expiresAt: match.expiresAt,
        visitCount: 1
      });
    }

    await saveIntentionalSessions(sessions);
  } catch (err) {
    console.warn('[journal-blocker] Failed to record intentional session:', err);
  }
}

async function getUnlockCooldownStatus(url, match, cooldownMinutes) {
  const minutes = normalizeCooldownMinutes(cooldownMinutes);
  if (minutes === 0 || !match) {
    return { enabled: false, blocked: false, expiresAt: null };
  }

  const domain = domainFromUrl(url);
  if (!domain) return { enabled: true, blocked: false, expiresAt: null };

  const sessions = await loadIntentionalSessions();
  const session = findIntentionalSession(sessions, domain, match);
  return evaluateUnlockCooldown(session, minutes);
}

function redirectToBlockUrl(tabId, currentUrl, blockUrl, blockPatterns) {
  let targetUrl = blockUrl;
  if (urlMatchesAnyPattern(targetUrl, blockPatterns)) {
    console.warn('[journal-blocker] blockUrl matches blocklist; using safe fallback');
    targetUrl = DEFAULT_SETTINGS.blockUrl;
  }
  if (urlsAreEqual(currentUrl, targetUrl)) return;
  chrome.tabs.update(tabId, { url: targetUrl }).catch(err => {
    console.warn('[journal-blocker] Redirect failed:', err);
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const url = details.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  await settingsReady;
  const s = currentSettings;

  const blockPatterns = parseLines(s.blocklist);
  if (blockPatterns.length === 0) return;

  const matchedPattern = findMatchingPattern(url, blockPatterns);
  if (!matchedPattern) return;

  try {
    const csvText = await fetchJournalCached(s.journalUrl);
    const evaluation = evaluateJournalAccess(csvText, s.keywords, s.timeframeMinutes);
    const hasMatch = evaluation.keywords.length > 0 && evaluation.allowed;

    if (!hasMatch) {
      await recordBlockedAttempt(url, matchedPattern);
      redirectToBlockUrl(details.tabId, url, s.blockUrl, blockPatterns);
    } else {
      const cooldownStatus = await getUnlockCooldownStatus(url, evaluation.match, s.unlockCooldownMinutes);
      if (cooldownStatus.blocked) {
        await recordBlockedAttempt(url, matchedPattern);
        redirectToBlockUrl(details.tabId, url, s.blockUrl, blockPatterns);
        return;
      }
      await recordIntentionalSession(url, evaluation.match);
      await markAttemptsJournaledLater(url, evaluation.match);
    }
  } catch (err) {
    console.warn('[journal-blocker] Error during check, blocking navigation:', err);
    await recordBlockedAttempt(url, matchedPattern);
    redirectToBlockUrl(details.tabId, url, s.blockUrl, blockPatterns);
  }
}, { url: [{ schemes: ['http', 'https'] }] });
