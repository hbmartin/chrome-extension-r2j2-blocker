const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS,
  MAX_RECORD_AGE_SECONDS,
  redactUrl,
  sanitizeSecretText,
  parseCSV,
  parseLines,
  urlMatchesAnyPattern,
  domainFromUrl,
  findMatchingPattern,
  findRecentKeywordMatch,
  evaluateJournalAccess,
  normalizeCooldownMinutes,
  normalizeTimeframeMinutes,
  pruneOldRecords,
  findIntentionalSession,
  evaluateUnlockCooldown
} = require('../service-worker-utils.js');

const NOW = 1_750_000_000;

test('parseCSV parses timestamp,text rows', () => {
  const entries = parseCSV('100,hello world\n200,Research Time');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { timestamp: 100, text: 'hello world', rawText: 'hello world' });
  assert.equal(entries[1].text, 'research time');
  assert.equal(entries[1].rawText, 'Research Time');
});

test('parseCSV keeps commas inside entry text', () => {
  const entries = parseCSV('100,working on a, b, and c');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'working on a, b, and c');
});

test('parseCSV skips blank lines, missing commas, and bad timestamps', () => {
  const entries = parseCSV('\n\nno comma here\nabc,not a timestamp\n300,valid\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].timestamp, 300);
});

test('parseLines trims, lowercases, and drops empty lines', () => {
  assert.deepEqual(parseLines('  Reddit.com \n\n YOUTUBE.com\n'), ['reddit.com', 'youtube.com']);
  assert.deepEqual(parseLines(''), []);
  assert.deepEqual(parseLines(null), []);
});

test('urlMatchesAnyPattern is a case-insensitive substring match', () => {
  assert.equal(urlMatchesAnyPattern('https://www.Reddit.com/r/all', ['reddit.com']), true);
  assert.equal(urlMatchesAnyPattern('https://example.com', ['reddit.com']), false);
});

test('findMatchingPattern returns the matched pattern or null', () => {
  assert.equal(findMatchingPattern('https://news.ycombinator.com/item', ['reddit.com', 'ycombinator.com']), 'ycombinator.com');
  assert.equal(findMatchingPattern('https://example.com', ['reddit.com']), null);
});

test('domainFromUrl strips www and handles invalid URLs', () => {
  assert.equal(domainFromUrl('https://www.reddit.com/r/all'), 'reddit.com');
  assert.equal(domainFromUrl('https://old.reddit.com/'), 'old.reddit.com');
  assert.equal(domainFromUrl('not a url'), '');
});

test('findRecentKeywordMatch returns the latest match inside the timeframe', () => {
  const entries = parseCSV([
    `${NOW - 3600},old research entry`,
    `${NOW - 120},research again`,
    `${NOW - 600},research earlier`
  ].join('\n'));

  const match = findRecentKeywordMatch(entries, ['research'], 30, NOW);
  assert.ok(match);
  assert.equal(match.keyword, 'research');
  assert.equal(match.entry.timestamp, NOW - 120);
  assert.equal(match.expiresAt, NOW - 120 + 30 * 60);
});

test('findRecentKeywordMatch ignores entries outside the timeframe', () => {
  const entries = parseCSV(`${NOW - 3600},research entry`);
  assert.equal(findRecentKeywordMatch(entries, ['research'], 30, NOW), null);
});

test('evaluateJournalAccess allows only when a keyword matches recently', () => {
  const csv = `${NOW - 60},did some research today`;
  const allowed = evaluateJournalAccess(csv, 'research', 60, NOW);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.match.keyword, 'research');

  const denied = evaluateJournalAccess(csv, 'writing', 60, NOW);
  assert.equal(denied.allowed, false);
  assert.equal(denied.match, null);
});

test('evaluateJournalAccess handles missing CSV text and empty keywords', () => {
  const noText = evaluateJournalAccess(null, 'research', 60, NOW);
  assert.equal(noText.allowed, false);
  assert.deepEqual(noText.entries, []);

  const noKeywords = evaluateJournalAccess(`${NOW},research`, '', 60, NOW);
  assert.equal(noKeywords.allowed, false);
  assert.deepEqual(noKeywords.keywords, []);
});

test('normalizeCooldownMinutes clamps invalid values to 0', () => {
  assert.equal(normalizeCooldownMinutes(15), 15);
  assert.equal(normalizeCooldownMinutes('30'), 30);
  assert.equal(normalizeCooldownMinutes(0), 0);
  assert.equal(normalizeCooldownMinutes(-5), 0);
  assert.equal(normalizeCooldownMinutes('abc'), 0);
  assert.equal(normalizeCooldownMinutes(undefined), 0);
});

test('normalizeTimeframeMinutes falls back to the default', () => {
  assert.equal(normalizeTimeframeMinutes(45), 45);
  assert.equal(normalizeTimeframeMinutes('90'), 90);
  assert.equal(normalizeTimeframeMinutes(0), DEFAULT_SETTINGS.timeframeMinutes);
  assert.equal(normalizeTimeframeMinutes(-1), DEFAULT_SETTINGS.timeframeMinutes);
  assert.equal(normalizeTimeframeMinutes('abc'), DEFAULT_SETTINGS.timeframeMinutes);
  assert.equal(normalizeTimeframeMinutes(undefined), DEFAULT_SETTINGS.timeframeMinutes);
});

test('findIntentionalSession matches domain, keyword, and journal timestamp', () => {
  const match = { keyword: 'research', entry: { timestamp: 123 } };
  const sessions = [
    { domain: 'reddit.com', keyword: 'research', journalTimestamp: 123 },
    { domain: 'reddit.com', keyword: 'research', journalTimestamp: 456 }
  ];

  assert.equal(findIntentionalSession(sessions, 'reddit.com', match), sessions[0]);
  assert.equal(findIntentionalSession(sessions, 'youtube.com', match), null);
  assert.equal(findIntentionalSession(sessions, '', match), null);
  assert.equal(findIntentionalSession(sessions, 'reddit.com', null), null);
});

test('evaluateUnlockCooldown blocks once the cooldown has elapsed', () => {
  const session = { timestamp: NOW - 20 * 60, journalTimestamp: NOW - 25 * 60 };

  const active = evaluateUnlockCooldown(session, 30, NOW);
  assert.equal(active.enabled, true);
  assert.equal(active.blocked, false);
  assert.equal(active.expiresAt, NOW - 20 * 60 + 30 * 60);

  const expired = evaluateUnlockCooldown(session, 15, NOW);
  assert.equal(expired.blocked, true);
});

test('evaluateUnlockCooldown is disabled with 0 minutes or no session', () => {
  assert.deepEqual(evaluateUnlockCooldown({ timestamp: NOW }, 0, NOW), {
    enabled: false,
    blocked: false,
    expiresAt: null
  });
  assert.deepEqual(evaluateUnlockCooldown(null, 30, NOW), {
    enabled: true,
    blocked: false,
    expiresAt: null
  });
});

test('pruneOldRecords drops records older than the max age', () => {
  const fresh = { timestamp: NOW - 60 };
  const stale = { timestamp: NOW - MAX_RECORD_AGE_SECONDS - 1 };
  const staleButSeenRecently = { timestamp: NOW - MAX_RECORD_AGE_SECONDS - 1, lastSeenAt: NOW - 60 };
  const freshTimestampButNeverSeen = { timestamp: NOW - 60, lastSeenAt: 0 };
  const invalid = { note: 'no timestamps' };

  assert.deepEqual(
    pruneOldRecords([fresh, stale, staleButSeenRecently, freshTimestampButNeverSeen, invalid], NOW),
    [fresh, staleButSeenRecently]
  );
  assert.deepEqual(pruneOldRecords('not an array', NOW), []);
});

test('redactUrl strips query strings and hashes', () => {
  assert.equal(
    redactUrl('https://worker.example.dev/csv?password=hunter2#frag'),
    'https://worker.example.dev/csv'
  );
  assert.equal(redactUrl('not a url?password=hunter2'), 'not a url');
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl(null), '');
});

test('sanitizeSecretText removes the journal URL and password values', () => {
  const url = 'https://worker.example.dev/csv?password=hunter2';
  const sanitized = sanitizeSecretText(`Failed to fetch ${url} today`, url);
  assert.equal(sanitized.includes('hunter2'), false);
  assert.equal(sanitized.includes('https://worker.example.dev/csv'), true);

  const bare = sanitizeSecretText('error at ?password=hunter2&x=1', null);
  assert.equal(bare.includes('hunter2'), false);
  assert.equal(bare.includes('password=[redacted]'), true);
});
