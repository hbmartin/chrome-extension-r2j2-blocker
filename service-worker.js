importScripts('service-worker-utils.js');

let currentSettings = DEFAULT_SETTINGS;

function normalizeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    ...merged,
    blockUrl: (merged.blockUrl || '').trim() || DEFAULT_SETTINGS.blockUrl,
    timeframeMinutes: normalizeTimeframeMinutes(merged.timeframeMinutes),
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
  } catch {
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
    [BLOCKED_ATTEMPTS_STORAGE_KEY]: pruneOldRecords(attempts).slice(-MAX_BLOCKED_ATTEMPTS)
  });
}

let blockedAttemptsWrite = Promise.resolve();
let intentionalSessionsWrite = Promise.resolve();

function updateBlockedAttempts(mutator) {
  const operation = blockedAttemptsWrite.catch(() => {}).then(async () => {
    const attempts = await loadBlockedAttempts();
    const shouldSave = mutator(attempts) !== false;
    if (shouldSave) await saveBlockedAttempts(attempts);
  });
  blockedAttemptsWrite = operation.catch(() => {});
  return operation;
}

async function recordBlockedAttempt(url, matchedPattern) {
  try {
    const domain = domainFromUrl(url);
    if (!domain) return;

    await updateBlockedAttempts(attempts => {
      attempts.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        domain,
        matchedPattern,
        timestamp: Math.floor(Date.now() / 1000),
        journaledLater: false,
        journaledAt: null,
        unlockKeyword: null
      });
    });
  } catch (err) {
    console.warn('[journal-blocker] Failed to record blocked attempt:', err);
  }
}

async function markAttemptsJournaledLater(url, match) {
  try {
    if (!match) return;
    const domain = domainFromUrl(url);
    if (!domain) return;

    await updateBlockedAttempts(attempts => {
      let changed = false;

      for (const attempt of attempts) {
        if (attempt.domain !== domain || attempt.journaledLater) continue;
        if (attempt.timestamp > match.entry.timestamp) continue;
        attempt.journaledLater = true;
        attempt.journaledAt = match.entry.timestamp;
        attempt.unlockKeyword = match.keyword;
        changed = true;
      }

      return changed;
    });
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
    [INTENTIONAL_SESSIONS_STORAGE_KEY]: pruneOldRecords(sessions).slice(-MAX_INTENTIONAL_SESSIONS)
  });
}

function updateIntentionalSessions(mutator) {
  const operation = intentionalSessionsWrite.catch(() => {}).then(async () => {
    const sessions = await loadIntentionalSessions();
    const shouldSave = mutator(sessions) !== false;
    if (shouldSave) await saveIntentionalSessions(sessions);
  });
  intentionalSessionsWrite = operation.catch(() => {});
  return operation;
}

// countVisit is false for SPA history updates so client-side route changes
// refresh lastSeenAt without inflating the visit count.
async function recordIntentionalSession(url, match, { countVisit = true } = {}) {
  try {
    if (!match) return;
    const domain = domainFromUrl(url);
    if (!domain) return;

    await updateIntentionalSessions(sessions => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const existing = findIntentionalSession(sessions, domain, match);

      if (existing) {
        existing.lastSeenAt = nowSeconds;
        if (countVisit) existing.visitCount = (existing.visitCount || 1) + 1;
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
    });
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

const BADGE_COLORS = {
  allowed: '#1e8e3e',
  blocked: '#d93025'
};

function formatBadgeMinutes(expiresAt, nowSeconds = Math.floor(Date.now() / 1000)) {
  const minutes = Math.max(0, Math.ceil((expiresAt - nowSeconds) / 60));
  return minutes > 99 ? '99+' : `${minutes}m`;
}

async function setTabBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // The tab may already be gone; badge updates are best-effort.
  }
}

// Shows at a glance whether the current site is journal-gated: green with
// minutes remaining when unlocked, red ✕ when blocked, empty otherwise.
async function updateBadgeForTab(tabId, url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return setTabBadge(tabId, '');
  }

  await settingsReady;
  const s = currentSettings;
  const blockPatterns = parseLines(s.blocklist);
  const matchedPattern = findMatchingPattern(url, blockPatterns);
  if (!matchedPattern) return setTabBadge(tabId, '');

  try {
    const csvText = await fetchJournalCached(s.journalUrl);
    const evaluation = evaluateJournalAccess(csvText, s.keywords, s.timeframeMinutes);
    if (!(evaluation.keywords.length > 0 && evaluation.allowed)) {
      return setTabBadge(tabId, '✕', BADGE_COLORS.blocked);
    }

    const cooldownStatus = await getUnlockCooldownStatus(url, evaluation.match, s.unlockCooldownMinutes);
    if (cooldownStatus.blocked) {
      return setTabBadge(tabId, '✕', BADGE_COLORS.blocked);
    }

    const expiresAt = cooldownStatus.expiresAt
      ? Math.min(evaluation.match.expiresAt, cooldownStatus.expiresAt)
      : evaluation.match.expiresAt;
    return setTabBadge(tabId, formatBadgeMinutes(expiresAt), BADGE_COLORS.allowed);
  } catch {
    return setTabBadge(tabId, '✕', BADGE_COLORS.blocked);
  }
}

// Shared by real navigations (onBeforeNavigate) and SPA route changes
// (onHistoryStateUpdated) so client-side navigation cannot bypass the gate.
async function handleNavigation(details, { isHistoryUpdate = false } = {}) {
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
      await recordIntentionalSession(url, evaluation.match, { countVisit: !isHistoryUpdate });
      await markAttemptsJournaledLater(url, evaluation.match);
      await updateBadgeForTab(details.tabId, url);
    }
  } catch (err) {
    console.warn('[journal-blocker] Error during check, blocking navigation:', err);
    await recordBlockedAttempt(url, matchedPattern);
    redirectToBlockUrl(details.tabId, url, s.blockUrl, blockPatterns);
  }
}

const NAVIGATION_FILTER = { url: [{ schemes: ['http', 'https'] }] };

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  handleNavigation(details);
}, NAVIGATION_FILTER);

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  handleNavigation(details, { isHistoryUpdate: true });
}, NAVIGATION_FILTER);

chrome.webNavigation.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  updateBadgeForTab(details.tabId, details.url);
}, NAVIGATION_FILTER);

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadgeForTab(tabId, tab?.url || '');
  } catch {
    // The tab may already be gone.
  }
});
