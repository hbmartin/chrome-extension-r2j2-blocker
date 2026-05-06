const DEFAULT_SETTINGS = {
  blocklist: "",
  journalUrl: "",
  keywords: "",
  timeframeMinutes: 60,
  blockUrl: "about:blank"
};

// Duplicated from service-worker-utils.js — popup pages cannot use importScripts()
function parseLines(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(line => line.length > 0);
}

function urlMatchesAnyPattern(url, patterns) {
  const lowerUrl = url.toLowerCase();
  return patterns.some(pattern => lowerUrl.includes(pattern));
}

async function init() {
  document.getElementById('settings-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';

  const statusIcon = document.getElementById('status-icon');
  const statusText = document.getElementById('status-text');

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    statusIcon.className = 'status-icon neutral';
    statusText.textContent = 'Not a web page';
    return;
  }

  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const patterns = parseLines(s.blocklist);

  if (patterns.length === 0) {
    statusIcon.className = 'status-icon neutral';
    statusText.textContent = 'No blocklist configured';
    return;
  }

  if (urlMatchesAnyPattern(url, patterns)) {
    statusIcon.className = 'status-icon blocked';
    statusText.textContent = 'This URL is on the blocklist';
  } else {
    statusIcon.className = 'status-icon allowed';
    statusText.textContent = 'This URL is not blocked';
  }
}

init();
