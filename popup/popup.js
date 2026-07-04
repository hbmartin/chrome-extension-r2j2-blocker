const els = {
  statusIcon: document.getElementById('status-icon'),
  statusText: document.getElementById('status-text'),
  statusSubtext: document.getElementById('status-subtext'),
  configStatus: document.getElementById('config-status'),
  urlStatus: document.getElementById('url-status'),
  journalStatus: document.getElementById('journal-status'),
  accessStatus: document.getElementById('access-status'),
  matchStatus: document.getElementById('match-status'),
  expiryStatus: document.getElementById('expiry-status')
};

function debugPopup(message, details = {}) {
  console.debug('[journal-blocker:popup]', message, details);
}

function setSummary(kind, text, subtext = '') {
  els.statusIcon.className = `status-icon ${kind}`;
  els.statusText.textContent = text;
  els.statusSubtext.textContent = subtext;
}

function setDiagnostic(id, text) {
  els[id].textContent = text;
}

function formatDateTime(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatExpiry(expiresAt) {
  const seconds = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  if (seconds < 60) return `${formatDateTime(expiresAt)} (less than 1 minute left)`;
  const minutes = Math.floor(seconds / 60);
  const label = minutes === 1 ? 'minute' : 'minutes';
  return `${formatDateTime(expiresAt)} (${minutes} ${label} left)`;
}

function formatJournalStatus(result) {
  if (!result.ok) return `Failing: ${result.error}`;
  const cacheText = result.fromCache ? 'cached' : 'fresh';
  return `OK (${cacheText}, HTTP ${result.status})`;
}

async function loadIntentionalSessionsForPopup() {
  const result = await chrome.storage.local.get({ [INTENTIONAL_SESSIONS_STORAGE_KEY]: [] });
  const sessions = result[INTENTIONAL_SESSIONS_STORAGE_KEY];
  return Array.isArray(sessions) ? sessions : [];
}

function describeMissingConfig(patterns, settings, keywords) {
  const missing = [];
  if (patterns.length === 0) missing.push('blocked URL patterns');
  if (!settings.journalUrl) missing.push('journal CSV URL');
  if (keywords.length === 0) missing.push('keywords');
  return missing;
}

async function init() {
  document.getElementById('settings-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isWebPage = url.startsWith('http://') || url.startsWith('https://');

  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const s = {
    ...DEFAULT_SETTINGS,
    ...settings,
    timeframeMinutes: normalizeTimeframeMinutes(settings?.timeframeMinutes)
  };
  const patterns = parseLines(s.blocklist);
  const keywords = parseLines(s.keywords);
  const cooldownMinutes = normalizeCooldownMinutes(s.unlockCooldownMinutes);
  const missingConfig = describeMissingConfig(patterns, s, keywords);
  const matchedPattern = isWebPage ? findMatchingPattern(url, patterns) : null;

  debugPopup('initialized popup state', {
    url,
    isWebPage,
    blockPatternCount: patterns.length,
    keywordCount: keywords.length,
    hasJournalUrl: Boolean(s.journalUrl),
    timeframeMinutes: s.timeframeMinutes,
    cooldownMinutes,
    missingConfig,
    matchedPattern
  });

  setDiagnostic(
    'configStatus',
    missingConfig.length === 0 ? 'Configured' : `Missing ${missingConfig.join(', ')}`
  );
  setDiagnostic(
    'urlStatus',
    !isWebPage ? 'Not a web page' : matchedPattern ? `Blocked by "${matchedPattern}"` : 'Not blocked'
  );
  setDiagnostic('journalStatus', s.journalUrl ? 'Checking...' : 'Not configured');
  setDiagnostic('accessStatus', 'Not checked');
  setDiagnostic('matchStatus', 'None');
  setDiagnostic('expiryStatus', 'None');

  if (!isWebPage) {
    debugPopup('skipping access check because active tab is not a web page', { url });
    setSummary('neutral', 'Not a web page', 'This extension only checks http and https pages.');
    return;
  }

  if (missingConfig.length > 0) {
    debugPopup('skipping journal fetch because configuration is incomplete', { missingConfig });
    setSummary('warning', 'Not configured', `Add ${missingConfig.join(', ')} in settings.`);
    return;
  }

  if (!matchedPattern) {
    debugPopup('skipping journal fetch because current URL does not match blocklist', {
      url,
      patterns
    });
    setSummary('allowed', 'URL is not blocked', 'The current page does not match your blocked URL patterns.');
    setDiagnostic('accessStatus', 'Allowed');
    setDiagnostic('journalStatus', 'Not checked');
    return;
  }

  debugPopup('fetching journal for blocked URL', {
    url,
    matchedPattern,
    journalUrl: s.journalUrl
  });
  const journalResult = await fetchJournalCachedResult(s.journalUrl);
  debugPopup('journal fetch completed', {
    ok: journalResult.ok,
    status: journalResult.status,
    error: journalResult.error,
    fromCache: journalResult.fromCache,
    textLength: journalResult.text?.length || 0
  });
  setDiagnostic('journalStatus', formatJournalStatus(journalResult));

  if (!journalResult.ok) {
    debugPopup('denying access because journal fetch failed', {
      matchedPattern,
      status: journalResult.status,
      error: journalResult.error
    });
    setSummary('blocked', 'Journal fetch failing', 'Blocked URLs will be denied until the journal can be read.');
    setDiagnostic('accessStatus', 'Denied');
    return;
  }

  const evaluation = evaluateJournalAccess(journalResult.text, keywords, s.timeframeMinutes);
  let cooldownStatus = { enabled: cooldownMinutes > 0, blocked: false, expiresAt: null };
  debugPopup('journal evaluation completed', {
    allowed: evaluation.allowed,
    entryCount: evaluation.entries.length,
    keywordCount: evaluation.keywords.length,
    cutoff: evaluation.cutoff,
    matchedKeyword: evaluation.match?.keyword || null,
    matchedTimestamp: evaluation.match?.entry?.timestamp || null
  });

  if (evaluation.match) {
    debugPopup('loading intentional sessions for cooldown evaluation', {
      domain: domainFromUrl(url),
      cooldownMinutes
    });
    const sessions = await loadIntentionalSessionsForPopup();
    const session = findIntentionalSession(sessions, domainFromUrl(url), evaluation.match);
    cooldownStatus = evaluateUnlockCooldown(session, cooldownMinutes);
    debugPopup('cooldown evaluation completed', {
      sessionFound: Boolean(session),
      cooldownStatus
    });
    const effectiveExpiresAt = cooldownStatus.expiresAt
      ? Math.min(evaluation.match.expiresAt, cooldownStatus.expiresAt)
      : evaluation.match.expiresAt;

    setDiagnostic('matchStatus', `"${evaluation.match.keyword}" at ${formatDateTime(evaluation.match.entry.timestamp)}`);
    setDiagnostic(
      'expiryStatus',
      cooldownStatus.blocked ? `Access limit ended at ${formatDateTime(cooldownStatus.expiresAt)}` : formatExpiry(effectiveExpiresAt)
    );
  }

  if (evaluation.allowed && cooldownStatus.blocked) {
    debugPopup('final access decision: denied by access limit', { cooldownStatus });
    setSummary('blocked', 'Access limit reached', `This journal-backed unlock is limited to ${cooldownMinutes} minutes.`);
    setDiagnostic('accessStatus', 'Denied by access limit');
  } else if (evaluation.allowed) {
    debugPopup('final access decision: allowed', {
      keyword: evaluation.match.keyword,
      expiresAt: evaluation.match.expiresAt
    });
    setSummary('allowed', 'Access allowed', `Recent journal keyword: "${evaluation.match.keyword}".`);
    setDiagnostic('accessStatus', 'Allowed');
  } else {
    debugPopup('final access decision: denied without journal match', {
      timeframeMinutes: s.timeframeMinutes,
      entryCount: evaluation.entries.length
    });
    setSummary('blocked', 'Access blocked', `No matching journal entry in the last ${s.timeframeMinutes} minutes.`);
    setDiagnostic('accessStatus', 'Denied');
  }
}

init().catch(err => {
  console.warn('[journal-blocker] Popup failed:', err);
  setSummary('blocked', 'Popup check failed', err?.message || String(err));
});
