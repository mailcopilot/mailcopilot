#!/usr/bin/env node
/**
 * Audit allowlist expiry early-warning.
 *
 * Reads `.audit-ci.json` and fails (exit 1) when any active allowlist entry
 * expires in less than WARN_DAYS days (including already-expired entries).
 * Designed to run in a scheduled CI pipeline (job `audit-expiry-warning`) so
 * that expiring entries are surfaced BEFORE they start failing the blocking
 * `audit` job on regular branch pipelines (real incident: expired entries
 * turned `audit` red, the `test` stage never started, and a fix landed on
 * develop without a CI test run).
 *
 * Allowlist shape (audit-ci@7 schema):
 *   {
 *     "allowlist": [
 *       { "GHSA-xxxx-xxxx-xxxx": { "active": true, "expiry": "YYYY-MM-DD", "notes": "..." } },
 *       ...
 *     ]
 *   }
 * audit-ci also accepts bare-string entries ("GHSA-..."), but the project
 * convention (CLAUDE.md §7) requires `expiry` + `notes` on every entry, so
 * bare strings and entries without a valid expiry are reported as invalid.
 *
 * Usage:
 *   node scripts/check-audit-expiry.mjs
 *   node scripts/check-audit-expiry.mjs --now=2026-06-11 --config=/path/to/.audit-ci.json --warn-days=7
 *
 * `--now` / `--config` / `--warn-days` exist for tests and manual dry-runs;
 * defaults are today's date (UTC), the repo `.audit-ci.json`, and 7 days.
 */

import { readFileSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_PATH = path.join(ROOT, '.audit-ci.json')
export const DEFAULT_WARN_DAYS = 7

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NOTES_EXCERPT_LEN = 80

/**
 * Parses a `YYYY-MM-DD` string as UTC midnight. Returns the timestamp in ms,
 * or `null` when the string is malformed or names an impossible date
 * (e.g. 2026-02-30).
 */
export function parseDateUTC(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d)
  const roundTrip = new Date(ms)
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== m - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    return null
  }
  return ms
}

/**
 * Extracts allowlist entries from a parsed `.audit-ci.json` object.
 * Returns `{ entries, invalid }` where `entries` is
 * `[{ id, active, expiry, notes }]` for well-formed object entries and
 * `invalid` is `[{ id, reason }]` for bare strings / malformed shapes.
 */
export function parseAllowlist(config) {
  const entries = []
  const invalid = []
  const allowlist = config?.allowlist
  if (!Array.isArray(allowlist)) {
    return { entries, invalid: [{ id: '(root)', reason: 'allowlist is not an array' }] }
  }
  for (const item of allowlist) {
    if (typeof item === 'string') {
      // Bare-string allowlist entries never expire — forbidden by project
      // convention (every entry must carry expiry + notes).
      invalid.push({ id: item, reason: 'bare string entry without expiry/notes metadata' })
      continue
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      invalid.push({ id: JSON.stringify(item), reason: 'entry is not an object' })
      continue
    }
    const keys = Object.keys(item)
    if (keys.length !== 1) {
      invalid.push({
        id: keys.join(',') || '(empty)',
        reason: `expected exactly one advisory id per entry, got ${keys.length}`,
      })
      continue
    }
    const id = keys[0]
    const meta = item[id]
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      invalid.push({ id, reason: 'advisory metadata is not an object' })
      continue
    }
    entries.push({
      id,
      active: meta.active !== false,
      expiry: meta.expiry,
      notes: typeof meta.notes === 'string' ? meta.notes : '',
    })
  }
  return { entries, invalid }
}

/**
 * Checks entries against `nowMs` (UTC-midnight timestamp).
 * Returns `{ expiring, invalid, ok }`:
 *  - `expiring`: active entries with `daysLeft < warnDays`
 *    (daysLeft may be negative for already-expired entries),
 *  - `invalid`: active entries whose `expiry` is missing or unparseable,
 *  - `ok`: count of active entries comfortably in the future.
 * Inactive entries (`active: false`) are skipped — they do not allowlist
 * anything, so their expiry is irrelevant.
 */
export function checkExpiry(entries, nowMs, warnDays = DEFAULT_WARN_DAYS) {
  const expiring = []
  const invalid = []
  let ok = 0
  for (const entry of entries) {
    if (!entry.active) continue
    const expiryMs = parseDateUTC(entry.expiry)
    if (expiryMs === null) {
      invalid.push({ id: entry.id, reason: `missing or malformed expiry: ${JSON.stringify(entry.expiry)}` })
      continue
    }
    const daysLeft = Math.floor((expiryMs - nowMs) / DAY_MS)
    if (daysLeft < warnDays) {
      expiring.push({ id: entry.id, expiry: entry.expiry, daysLeft, notes: entry.notes })
    } else {
      ok += 1
    }
  }
  return { expiring, invalid, ok }
}

/** Synchronous fd-2 write; see scripts/check-mirror-exclude.mjs for rationale. */
function writeStderrLine(msg) {
  writeSync(2, `${msg}\n`)
}

function notesExcerpt(notes) {
  if (!notes) return '(no notes)'
  return notes.length > NOTES_EXCERPT_LEN ? `${notes.slice(0, NOTES_EXCERPT_LEN)}…` : notes
}

/** Parses `--key=value` CLI args. Throws on unknown flags. */
export function parseArgs(argv) {
  const out = { now: null, config: null, warnDays: null }
  for (const arg of argv) {
    if (arg.startsWith('--now=')) out.now = arg.slice('--now='.length)
    else if (arg.startsWith('--config=')) out.config = arg.slice('--config='.length)
    else if (arg.startsWith('--warn-days=')) out.warnDays = arg.slice('--warn-days='.length)
    else throw new Error(`unknown argument: ${arg} (expected --now=, --config=, --warn-days=)`)
  }
  return out
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  const nowStr = args.now ?? new Date().toISOString().slice(0, 10)
  const nowMs = parseDateUTC(nowStr)
  if (nowMs === null) throw new Error(`invalid --now date: ${nowStr} (expected YYYY-MM-DD)`)

  const warnDays = args.warnDays === null ? DEFAULT_WARN_DAYS : Number(args.warnDays)
  if (!Number.isInteger(warnDays) || warnDays < 0) {
    throw new Error(`invalid --warn-days: ${args.warnDays} (expected non-negative integer)`)
  }

  const configPath = args.config ?? CONFIG_PATH
  const config = JSON.parse(readFileSync(configPath, 'utf8'))

  const { entries, invalid: parseInvalid } = parseAllowlist(config)
  const { expiring, invalid: expiryInvalid, ok } = checkExpiry(entries, nowMs, warnDays)
  const invalid = [...parseInvalid, ...expiryInvalid]

  if (expiring.length > 0 || invalid.length > 0) {
    writeStderrLine(`Audit allowlist expiry check FAILED (now=${nowStr}, warn-days=${warnDays}):`)
    for (const e of expiring) {
      const status = e.daysLeft < 0 ? 'EXPIRED' : 'expiring'
      writeStderrLine(
        `  ${e.id}  expiry=${e.expiry}  days-left=${e.daysLeft}  [${status}]  ${notesExcerpt(e.notes)}`,
      )
    }
    for (const e of invalid) {
      writeStderrLine(`  ${e.id}  [invalid]  ${e.reason}`)
    }
    writeStderrLine('')
    writeStderrLine(
      `${expiring.length} expiring/expired and ${invalid.length} invalid allowlist ` +
        `entr(y/ies) in ${path.relative(ROOT, configPath) || configPath}. Re-triage each ` +
        `advisory and extend its expiry (with updated notes) before the blocking ` +
        `\`audit\` job starts failing branch pipelines.`,
    )
    process.exit(1)
  }

  console.log(
    `Audit allowlist expiry check OK (now=${nowStr}, warn-days=${warnDays}): ` +
      `${ok} active entr(y/ies) expire ${warnDays}+ days from now.`,
  )
}

// Only run main() when executed directly, not when imported by tests.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  try {
    main()
  } catch (err) {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err)
    writeStderrLine(`[check-audit-expiry] ${msg}`)
    process.exit(1)
  }
}
