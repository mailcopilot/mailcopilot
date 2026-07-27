#!/usr/bin/env node
/**
 * Tests for scripts/check-audit-expiry.mjs.
 *
 * Style follows scripts/check-mirror-exclude.test.mjs: node:test + node:assert,
 * no external deps. All date-sensitive assertions pass a fixed "now" into the
 * functions / CLI (`--now=`) — nothing here depends on Date.now(), so the
 * suite cannot rot as the wall clock advances.
 *
 * Run:
 *   node --test scripts/check-audit-expiry.test.mjs
 *   npm run test:scripts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  parseDateUTC,
  parseAllowlist,
  checkExpiry,
  parseArgs,
  CONFIG_PATH,
  DEFAULT_WARN_DAYS,
} from './check-audit-expiry.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(SCRIPTS_DIR, 'check-audit-expiry.mjs')

/** Builds an audit-ci-shaped config from `[id, meta]` pairs (or raw items). */
function makeConfig(items) {
  return { allowlist: items }
}

function entry(id, expiry, { active = true, notes = 'test notes' } = {}) {
  return { [id]: { active, expiry, notes } }
}

/** Runs the CLI with a synthetic config and fixed now; returns spawnSync result. */
function runCli(config, now, extraArgs = []) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'audit-expiry-'))
  const configPath = path.join(tmp, 'audit-ci.json')
  writeFileSync(configPath, JSON.stringify(config))
  try {
    return spawnSync(
      process.execPath,
      [SCRIPT_PATH, `--config=${configPath}`, `--now=${now}`, ...extraArgs],
      { encoding: 'utf8' },
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ============================================================================
// Unit: parseDateUTC
// ============================================================================

test('parseDateUTC: valid date yields UTC midnight timestamp', () => {
  assert.equal(parseDateUTC('2026-07-01'), Date.UTC(2026, 6, 1))
})

test('parseDateUTC: malformed strings are rejected', () => {
  for (const bad of ['2026-7-1', '01-07-2026', '2026/07/01', 'tomorrow', '', null, undefined, 20260701]) {
    assert.equal(parseDateUTC(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('parseDateUTC: impossible calendar dates are rejected', () => {
  assert.equal(parseDateUTC('2026-02-30'), null)
  assert.equal(parseDateUTC('2026-13-01'), null)
  assert.equal(parseDateUTC('2026-00-10'), null)
})

test('parseDateUTC: leap day handling', () => {
  assert.equal(parseDateUTC('2028-02-29'), Date.UTC(2028, 1, 29)) // leap year
  assert.equal(parseDateUTC('2026-02-29'), null) // not a leap year
})

// ============================================================================
// Unit: parseAllowlist
// ============================================================================

test('parseAllowlist: real .audit-ci.json parses with zero invalid entries', () => {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const { entries, invalid } = parseAllowlist(config)
  assert.deepEqual(invalid, [], `unexpected invalid entries: ${JSON.stringify(invalid)}`)
  assert.ok(entries.length > 0, 'real allowlist should not be empty')
  for (const e of entries) {
    assert.match(e.id, /^GHSA-/, `advisory id should be a GHSA id, got ${e.id}`)
    assert.notEqual(parseDateUTC(e.expiry), null, `entry ${e.id} must have a valid expiry`)
    assert.ok(e.notes.length > 0, `entry ${e.id} must have notes`)
  }
})

test('parseAllowlist: well-formed object entries are extracted', () => {
  const { entries, invalid } = parseAllowlist(
    makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-07-01'), entry('GHSA-dddd-eeee-ffff', '2026-08-01')]),
  )
  assert.equal(invalid.length, 0)
  assert.deepEqual(
    entries.map((e) => e.id),
    ['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'],
  )
})

test('parseAllowlist: bare string entries are flagged invalid (project convention)', () => {
  const { entries, invalid } = parseAllowlist(makeConfig(['GHSA-aaaa-bbbb-cccc']))
  assert.equal(entries.length, 0)
  assert.equal(invalid.length, 1)
  assert.equal(invalid[0].id, 'GHSA-aaaa-bbbb-cccc')
  assert.match(invalid[0].reason, /bare string/)
})

test('parseAllowlist: multi-key and non-object entries are flagged invalid', () => {
  const multiKey = {
    'GHSA-aaaa-bbbb-cccc': { active: true, expiry: '2026-07-01', notes: 'x' },
    'GHSA-dddd-eeee-ffff': { active: true, expiry: '2026-07-01', notes: 'y' },
  }
  const { entries, invalid } = parseAllowlist(makeConfig([multiKey, null, 42, { 'GHSA-gggg-hhhh-iiii': 'not-an-object' }]))
  assert.equal(entries.length, 0)
  assert.equal(invalid.length, 4)
})

test('parseAllowlist: missing/non-array allowlist is reported', () => {
  for (const config of [{}, { allowlist: 'nope' }, { allowlist: {} }]) {
    const { entries, invalid } = parseAllowlist(config)
    assert.equal(entries.length, 0)
    assert.equal(invalid.length, 1)
    assert.match(invalid[0].reason, /not an array/)
  }
})

// ============================================================================
// Unit: checkExpiry (fixed dates, no Date.now)
// ============================================================================

const NOW = parseDateUTC('2026-06-11')

test('checkExpiry: entry expiring beyond warn window is ok', () => {
  const { entries } = parseAllowlist(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-07-01')]))
  const { expiring, invalid, ok } = checkExpiry(entries, NOW)
  assert.deepEqual(expiring, [])
  assert.deepEqual(invalid, [])
  assert.equal(ok, 1)
})

test('checkExpiry: entry expiring in fewer than warn-days is reported with days-left', () => {
  const { entries } = parseAllowlist(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-06-15')]))
  const { expiring, ok } = checkExpiry(entries, NOW)
  assert.equal(ok, 0)
  assert.equal(expiring.length, 1)
  assert.equal(expiring[0].id, 'GHSA-aaaa-bbbb-cccc')
  assert.equal(expiring[0].daysLeft, 4)
})

test('checkExpiry: already-expired entry yields negative days-left', () => {
  const { entries } = parseAllowlist(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-06-01')]))
  const { expiring } = checkExpiry(entries, NOW)
  assert.equal(expiring.length, 1)
  assert.equal(expiring[0].daysLeft, -10)
})

test('checkExpiry: boundary — exactly warn-days away is ok, warn-days minus one warns', () => {
  const exactly7 = parseAllowlist(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-06-18')])).entries
  assert.equal(checkExpiry(exactly7, NOW).expiring.length, 0, '7 days left must pass (daysLeft < 7 is the trigger)')

  const sixDays = parseAllowlist(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-06-17')])).entries
  assert.equal(checkExpiry(sixDays, NOW).expiring.length, 1, '6 days left must warn')
})

test('checkExpiry: expiry equal to now warns with days-left 0', () => {
  const { entries } = parseAllowlist(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-06-11')]))
  const { expiring } = checkExpiry(entries, NOW)
  assert.equal(expiring.length, 1)
  assert.equal(expiring[0].daysLeft, 0)
})

test('checkExpiry: custom warn-days window is respected', () => {
  const { entries } = parseAllowlist(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-07-01')]))
  // 20 days out: fails a 30-day window, passes the default 7-day window.
  assert.equal(checkExpiry(entries, NOW, 30).expiring.length, 1)
  assert.equal(checkExpiry(entries, NOW, DEFAULT_WARN_DAYS).expiring.length, 0)
})

test('checkExpiry: inactive entries are skipped entirely', () => {
  const { entries } = parseAllowlist(
    makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-01-01', { active: false })]),
  )
  const { expiring, invalid, ok } = checkExpiry(entries, NOW)
  assert.deepEqual(expiring, [])
  assert.deepEqual(invalid, [])
  assert.equal(ok, 0)
})

test('checkExpiry: active entry with missing or malformed expiry is invalid', () => {
  const { entries } = parseAllowlist(
    makeConfig([
      { 'GHSA-aaaa-bbbb-cccc': { active: true, notes: 'no expiry at all' } },
      entry('GHSA-dddd-eeee-ffff', 'soon'),
    ]),
  )
  const { invalid } = checkExpiry(entries, NOW)
  assert.equal(invalid.length, 2)
  assert.deepEqual(
    invalid.map((e) => e.id).sort(),
    ['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'],
  )
})

// ============================================================================
// Unit: parseArgs
// ============================================================================

test('parseArgs: recognized flags are extracted, defaults are null', () => {
  assert.deepEqual(parseArgs([]), { now: null, config: null, warnDays: null })
  assert.deepEqual(parseArgs(['--now=2026-06-11', '--config=/x/y.json', '--warn-days=14']), {
    now: '2026-06-11',
    config: '/x/y.json',
    warnDays: '14',
  })
})

test('parseArgs: unknown arguments throw', () => {
  assert.throws(() => parseArgs(['--nope=1']), /unknown argument/)
})

// ============================================================================
// CLI: end-to-end via subprocess (synthetic configs, fixed --now)
// ============================================================================

test('CLI: healthy config exits 0 and reports OK', () => {
  const res = runCli(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-07-01')]), '2026-06-11')
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.match(res.stdout, /expiry check OK/)
})

test('CLI: expiring entry exits 1 and lists id, expiry, days-left, notes excerpt', () => {
  const res = runCli(
    makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-06-15', { notes: 'minimatch ReDoS, waiting upstream' })]),
    '2026-06-11',
  )
  assert.equal(res.status, 1)
  assert.match(res.stderr, /GHSA-aaaa-bbbb-cccc/)
  assert.match(res.stderr, /expiry=2026-06-15/)
  assert.match(res.stderr, /days-left=4/)
  assert.match(res.stderr, /minimatch ReDoS/)
})

test('CLI: expired entry is marked EXPIRED', () => {
  const res = runCli(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-06-01')]), '2026-06-11')
  assert.equal(res.status, 1)
  assert.match(res.stderr, /\[EXPIRED\]/)
  assert.match(res.stderr, /days-left=-10/)
})

test('CLI: invalid expiry metadata exits 1', () => {
  const res = runCli(makeConfig([{ 'GHSA-aaaa-bbbb-cccc': { active: true, notes: 'no expiry' } }]), '2026-06-11')
  assert.equal(res.status, 1)
  assert.match(res.stderr, /\[invalid\]/)
})

test('CLI: --warn-days override widens the window', () => {
  const res = runCli(makeConfig([entry('GHSA-aaaa-bbbb-cccc', '2026-07-01')]), '2026-06-11', ['--warn-days=30'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /days-left=20/)
})

test('CLI: malformed --now exits non-zero with actionable message', () => {
  const res = runCli(makeConfig([]), 'not-a-date')
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /invalid --now date/)
})

test('CLI: missing config file exits non-zero', () => {
  const res = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--config=/nonexistent/audit-ci.json', '--now=2026-06-11'],
    { encoding: 'utf8' },
  )
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /ENOENT|no such file/i)
})

test('CLI: real .audit-ci.json passes when --now is one day after the latest expiry minus warn window', () => {
  // Derive the check date from the file itself instead of hardcoding a date:
  // pick the EARLIEST expiry in the real allowlist and run with now = that
  // expiry minus 8 days → every entry has daysLeft >= 8 > 7 → must pass.
  // This keeps the test green when the team re-extends expiries later.
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const { entries } = parseAllowlist(config)
  const earliest = Math.min(...entries.map((e) => parseDateUTC(e.expiry)))
  const now = new Date(earliest - 8 * 86_400_000).toISOString().slice(0, 10)
  const res = spawnSync(process.execPath, [SCRIPT_PATH, `--now=${now}`], { encoding: 'utf8' })
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
})

test('CLI: real .audit-ci.json fails when --now is inside the warn window of the earliest expiry', () => {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const { entries } = parseAllowlist(config)
  const earliest = Math.min(...entries.map((e) => parseDateUTC(e.expiry)))
  const now = new Date(earliest - 3 * 86_400_000).toISOString().slice(0, 10)
  const res = spawnSync(process.execPath, [SCRIPT_PATH, `--now=${now}`], { encoding: 'utf8' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /expiry check FAILED/)
})
