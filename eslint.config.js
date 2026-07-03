const js = require('@eslint/js');
const globals = require('globals');

// Helpers defined in service-worker-utils.js and loaded into other contexts
// via importScripts() (service worker) or <script> tags (popup, settings).
const sharedUtilsGlobals = {
  DEFAULT_SETTINGS: 'readonly',
  BLOCKED_ATTEMPTS_STORAGE_KEY: 'readonly',
  INTENTIONAL_SESSIONS_STORAGE_KEY: 'readonly',
  JOURNAL_CACHE_STORAGE_KEY: 'readonly',
  MAX_BLOCKED_ATTEMPTS: 'readonly',
  MAX_INTENTIONAL_SESSIONS: 'readonly',
  MAX_RECORD_AGE_SECONDS: 'readonly',
  CACHE_TTL_MS: 'readonly',
  redactUrl: 'readonly',
  sanitizeSecretText: 'readonly',
  fetchJournal: 'readonly',
  fetchJournalCachedResult: 'readonly',
  fetchJournalCached: 'readonly',
  parseCSV: 'readonly',
  parseLines: 'readonly',
  urlMatchesAnyPattern: 'readonly',
  domainFromUrl: 'readonly',
  findMatchingPattern: 'readonly',
  findRecentKeywordMatch: 'readonly',
  evaluateJournalAccess: 'readonly',
  normalizeCooldownMinutes: 'readonly',
  normalizeTimeframeMinutes: 'readonly',
  pruneOldRecords: 'readonly',
  findIntentionalSession: 'readonly',
  evaluateUnlockCooldown: 'readonly'
};

module.exports = [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    files: ['service-worker.js', 'service-worker-utils.js', 'popup/**/*.js', 'settings/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.worker,
        module: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }]
    }
  },
  {
    // Files that consume the helpers defined by service-worker-utils.js.
    files: ['service-worker.js', 'popup/**/*.js', 'settings/**/*.js'],
    languageOptions: {
      globals: sharedUtilsGlobals
    }
  },
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  }
];
