function readSettingsFromForm() {
  const blockUrl = document.getElementById('block-url').value.trim() || DEFAULT_SETTINGS.blockUrl;
  return {
    blocklist: document.getElementById('blocklist').value,
    journalUrl: document.getElementById('journal-url').value.trim(),
    keywords: document.getElementById('keywords').value,
    timeframeMinutes: parseInt(document.getElementById('timeframe').value, 10) || 60,
    blockUrl
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

function missingConfigForTest(settings) {
  const missing = [];
  if (parseLines(settings.blocklist).length === 0) missing.push('blocked URL patterns');
  if (!settings.journalUrl) missing.push('journal CSV URL');
  if (parseLines(settings.keywords).length === 0) missing.push('keywords');
  return missing;
}

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const s = { ...DEFAULT_SETTINGS, ...settings };
  document.getElementById('blocklist').value = s.blocklist;
  document.getElementById('journal-url').value = s.journalUrl;
  document.getElementById('keywords').value = s.keywords;
  document.getElementById('timeframe').value = s.timeframeMinutes;
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

    showTestResult(
      'success',
      'Configured sites would unlock now',
      `"${evaluation.match.keyword}" from ${formatDateTime(evaluation.match.entry.timestamp)} unlocks ${formatPatternList(patterns)} until ${formatDateTime(evaluation.match.expiresAt)}. ${evaluation.entries.length} journal rows parsed.`
    );
  } finally {
    button.disabled = false;
    button.textContent = 'Test Settings';
  }
}

document.getElementById('settings-form').addEventListener('submit', saveSettings);
document.getElementById('test-btn').addEventListener('click', testSettings);
loadSettings();
