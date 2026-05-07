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
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return `${formatDateTime(expiresAt)} (less than 1 minute left)`;
  return `${formatDateTime(expiresAt)} (${minutes} minutes left)`;
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
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const patterns = parseLines(s.blocklist);
  const keywords = parseLines(s.keywords);
  const cooldownMinutes = normalizeCooldownMinutes(s.unlockCooldownMinutes);
  const missingConfig = describeMissingConfig(patterns, s, keywords);
  const matchedPattern = isWebPage ? findMatchingPattern(url, patterns) : null;

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
    setSummary('neutral', 'Not a web page', 'This extension only checks http and https pages.');
    return;
  }

  if (missingConfig.length > 0) {
    setSummary('warning', 'Not configured', `Add ${missingConfig.join(', ')} in settings.`);
    return;
  }

  const journalResult = await fetchJournalCachedResult(s.journalUrl);
  setDiagnostic('journalStatus', formatJournalStatus(journalResult));

  if (!journalResult.ok) {
    setSummary('blocked', 'Journal fetch failing', 'Blocked URLs will be denied until the journal can be read.');
    setDiagnostic('accessStatus', matchedPattern ? 'Denied' : 'Allowed because URL is not blocked');
    return;
  }

  const evaluation = evaluateJournalAccess(journalResult.text, keywords, s.timeframeMinutes);
  let cooldownStatus = { enabled: cooldownMinutes > 0, blocked: false, expiresAt: null };

  if (evaluation.match) {
    const sessions = await loadIntentionalSessionsForPopup();
    const session = findIntentionalSession(sessions, domainFromUrl(url), evaluation.match);
    cooldownStatus = evaluateUnlockCooldown(session, cooldownMinutes);
    const effectiveExpiresAt = cooldownStatus.expiresAt
      ? Math.min(evaluation.match.expiresAt, cooldownStatus.expiresAt)
      : evaluation.match.expiresAt;

    setDiagnostic('matchStatus', `"${evaluation.match.keyword}" at ${formatDateTime(evaluation.match.entry.timestamp)}`);
    setDiagnostic(
      'expiryStatus',
      cooldownStatus.blocked ? `Access limit ended at ${formatDateTime(cooldownStatus.expiresAt)}` : formatExpiry(effectiveExpiresAt)
    );
  }

  if (!matchedPattern) {
    setSummary('allowed', 'URL is not blocked', 'The current page does not match your blocked URL patterns.');
    setDiagnostic('accessStatus', 'Allowed');
    return;
  }

  if (evaluation.allowed && cooldownStatus.blocked) {
    setSummary('blocked', 'Access limit reached', `This journal-backed unlock is limited to ${cooldownMinutes} minutes.`);
    setDiagnostic('accessStatus', 'Denied by access limit');
  } else if (evaluation.allowed) {
    setSummary('allowed', 'Access allowed', `Recent journal keyword: "${evaluation.match.keyword}".`);
    setDiagnostic('accessStatus', 'Allowed');
  } else {
    setSummary('blocked', 'Access blocked', `No matching journal entry in the last ${s.timeframeMinutes} minutes.`);
    setDiagnostic('accessStatus', 'Denied');
  }
}

init().catch(err => {
  console.warn('[journal-blocker] Popup failed:', err);
  setSummary('blocked', 'Popup check failed', err?.message || String(err));
});
