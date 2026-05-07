const DEFAULT_SETTINGS = {
  blocklist: "",
  journalUrl: "",
  keywords: "",
  timeframeMinutes: 60,
  blockUrl: "about:blank"
};

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
  const blockUrl = document.getElementById('block-url').value.trim() || DEFAULT_SETTINGS.blockUrl;
  const settings = {
    blocklist: document.getElementById('blocklist').value,
    journalUrl: document.getElementById('journal-url').value.trim(),
    keywords: document.getElementById('keywords').value,
    timeframeMinutes: parseInt(document.getElementById('timeframe').value, 10) || 60,
    blockUrl
  };
  await chrome.storage.sync.set({ settings });
  const status = document.getElementById('save-status');
  status.textContent = 'Saved!';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

document.getElementById('settings-form').addEventListener('submit', saveSettings);
loadSettings();
