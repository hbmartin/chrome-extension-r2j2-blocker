function readSettingsFromForm() {
  const blockUrl = document.getElementById('block-url').value.trim() || DEFAULT_SETTINGS.blockUrl;
  return {
    blocklist: document.getElementById('blocklist').value,
    journalUrl: document.getElementById('journal-url').value.trim(),
    keywords: document.getElementById('keywords').value,
    timeframeMinutes: parseInt(document.getElementById('timeframe').value, 10) || 60,
    blockUrl,
    unlockCooldownMinutes: normalizeCooldownMinutes(document.getElementById('unlock-cooldown').value)
  };
}

function formatDateTime(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatPatternList(patterns) {
  if (patterns.length === 1) return `"${patterns[0]}"`;
  if (patterns.length <= 4) return patterns.map(pattern => `"${pattern}"`).join(', ');
  return `${patterns.slice(0, 4).map(pattern => `"${pattern}"`).join(', ')} and ${patterns.length - 4} more`;
}

function showTestResult(kind, title, detail) {
  const result = document.getElementById('test-result');
  result.className = `test-result visible ${kind}`;
  result.innerHTML = `
    <div class="test-result-title"></div>
    <div class="test-result-detail"></div>
  `;
  result.querySelector('.test-result-title').textContent = title;
  result.querySelector('.test-result-detail').textContent = detail;
}

function plural(value, singular, pluralValue = `${singular}s`) {
  return value === 1 ? singular : pluralValue;
}

function missingConfigForTest(settings) {
  const missing = [];
  if (parseLines(settings.blocklist).length === 0) missing.push('blocked URL patterns');
  if (!settings.journalUrl) missing.push('journal CSV URL');
  if (parseLines(settings.keywords).length === 0) missing.push('keywords');
  return missing;
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function topCountEntries(counts, limit = 5) {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function appendMetric(container, label, value) {
  const metric = document.createElement('div');
  metric.className = 'report-metric';

  const metricValue = document.createElement('div');
  metricValue.className = 'report-metric-value';
  metricValue.textContent = value;

  const metricLabel = document.createElement('div');
  metricLabel.className = 'report-metric-label';
  metricLabel.textContent = label;

  metric.append(metricValue, metricLabel);
  container.append(metric);
}

function appendReportList(container, title, items, ordered, emptyText) {
  const section = document.createElement('section');
  section.className = 'report-list';

  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-report-line';
    empty.textContent = emptyText;
    section.append(empty);
  } else {
    const list = document.createElement(ordered ? 'ol' : 'ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.append(li);
    }
    section.append(list);
  }

  container.append(section);
}

function summarizeSessionsByDomain(sessions) {
  const summary = new Map();
  for (const session of sessions) {
    const current = summary.get(session.domain) || { sessions: 0, visits: 0 };
    current.sessions += 1;
    current.visits += session.visitCount || 1;
    summary.set(session.domain, current);
  }
  return Array.from(summary.entries())
    .sort((a, b) => b[1].sessions - a[1].sessions || b[1].visits - a[1].visits || a[0].localeCompare(b[0]))
    .slice(0, 5);
}

function renderWeeklyReport(attempts, sessions) {
  const report = document.getElementById('weekly-report');
  report.textContent = '';

  const convertedAttempts = attempts.filter(attempt => attempt.journaledLater).length;
  const metrics = document.createElement('div');
  metrics.className = 'report-metrics';
  appendMetric(metrics, 'blocked attempts', attempts.length);
  appendMetric(metrics, 'intentional sessions', sessions.length);
  appendMetric(metrics, 'attempts later journaled', convertedAttempts);
  report.append(metrics);

  const attemptedSites = topCountEntries(countBy(attempts, attempt => attempt.domain))
    .map(([domain, count]) => `${domain}: ${count} ${plural(count, 'attempt')}`);

  const sessionSites = summarizeSessionsByDomain(sessions)
    .map(([domain, data]) =>
      `${domain}: ${data.sessions} ${plural(data.sessions, 'session')}, ${data.visits} ${plural(data.visits, 'visit')}`
    );

  const repeatedUnintentional = topCountEntries(
    countBy(attempts.filter(attempt => !attempt.journaledLater), attempt => attempt.domain)
  )
    .filter(([, count]) => count > 1)
    .map(([domain, count]) => `${domain}: ${count} unjournaled ${plural(count, 'attempt')}`);

  appendReportList(report, 'Most Attempted Blocked Sites', attemptedSites, true, 'No blocked attempts recorded this week.');
  appendReportList(report, 'Successful Intentional Sessions', sessionSites, true, 'No journal-backed sessions recorded this week.');
  appendReportList(report, 'Repeated Unintentional Attempts', repeatedUnintentional, false, 'No repeated unintentional attempts recorded this week.');
}

async function loadWeeklyReport() {
  const refreshButton = document.getElementById('refresh-report-btn');
  refreshButton.disabled = true;

  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const result = await chrome.storage.local.get({
      [BLOCKED_ATTEMPTS_STORAGE_KEY]: [],
      [INTENTIONAL_SESSIONS_STORAGE_KEY]: []
    });

    const attemptsRaw = result[BLOCKED_ATTEMPTS_STORAGE_KEY];
    const sessionsRaw = result[INTENTIONAL_SESSIONS_STORAGE_KEY];
    const attempts = (Array.isArray(attemptsRaw) ? attemptsRaw : [])
      .filter(attempt => attempt.timestamp >= weekAgo);
    const sessions = (Array.isArray(sessionsRaw) ? sessionsRaw : [])
      .filter(session => (session.lastSeenAt || session.timestamp) >= weekAgo);

    renderWeeklyReport(attempts, sessions);
  } finally {
    refreshButton.disabled = false;
  }
}

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const s = { ...DEFAULT_SETTINGS, ...settings };
  document.getElementById('blocklist').value = s.blocklist;
  document.getElementById('journal-url').value = s.journalUrl;
  document.getElementById('keywords').value = s.keywords;
  document.getElementById('timeframe').value = s.timeframeMinutes;
  document.getElementById('unlock-cooldown').value = normalizeCooldownMinutes(s.unlockCooldownMinutes);
  document.getElementById('block-url').value = s.blockUrl;
}

async function saveSettings(e) {
  e.preventDefault();
  const settings = readSettingsFromForm();
  await chrome.storage.sync.set({ settings });
  const status = document.getElementById('save-status');
  status.textContent = 'Saved!';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

async function testSettings() {
  const button = document.getElementById('test-btn');
  const settings = readSettingsFromForm();
  const missing = missingConfigForTest(settings);

  if (missing.length > 0) {
    showTestResult('warning', 'Settings are incomplete', `Add ${missing.join(', ')} before testing unlock behavior.`);
    return;
  }

  button.disabled = true;
  button.textContent = 'Testing...';

  try {
    const journalResult = await fetchJournal(settings.journalUrl);
    if (!journalResult.ok) {
      showTestResult('error', 'Journal fetch failed', journalResult.error);
      return;
    }

    const patterns = parseLines(settings.blocklist);
    const evaluation = evaluateJournalAccess(journalResult.text, settings.keywords, settings.timeframeMinutes);

    if (!evaluation.match) {
      showTestResult(
        'warning',
        'Nothing would unlock right now',
        `${evaluation.entries.length} journal rows parsed, but none contain your keywords within the last ${settings.timeframeMinutes} minutes.`
      );
      return;
    }

    const cooldownText = settings.unlockCooldownMinutes > 0
      ? ` Access limit is ${settings.unlockCooldownMinutes} ${plural(settings.unlockCooldownMinutes, 'minute')} per domain after first unlock.`
      : '';

    showTestResult(
      'success',
      'Configured sites would unlock now',
      `"${evaluation.match.keyword}" from ${formatDateTime(evaluation.match.entry.timestamp)} unlocks ${formatPatternList(patterns)} until ${formatDateTime(evaluation.match.expiresAt)}.${cooldownText} ${evaluation.entries.length} journal rows parsed.`
    );
  } finally {
    button.disabled = false;
    button.textContent = 'Test Settings';
  }
}

document.getElementById('settings-form').addEventListener('submit', saveSettings);
document.getElementById('test-btn').addEventListener('click', testSettings);
document.getElementById('refresh-report-btn').addEventListener('click', loadWeeklyReport);
loadSettings();
loadWeeklyReport();
