#!/usr/bin/env node
/**
 * Resolve an SQL fingerprint from a freeze log back to a source location.
 *
 * The main-process freeze watchdog (electron/ipc.ts) reports slow statements as
 * `<duration>ms <verb> <table> sql=<fingerprint>`. It cannot report the
 * statement text: packages/db/sqlTiming.ts hashes the text and drops it,
 * because a call site that interpolated a folder name or an address before
 * `prepare()` would otherwise deposit user data in the log. This script is the
 * other half of that trade — it makes the fingerprint resolvable.
 *
 * It reads THIS REPOSITORY'S SOURCE FILES and nothing else: not the database,
 * not the mail store, not log files, not the user's profile. Its only inputs
 * are the fingerprint you type and the .ts/.tsx files under packages/,
 * electron/ and src/.
 *
 * Note what the fingerprint is, since this script demonstrates it: 8 unsalted
 * hex characters are a correlation token, not a redaction. Matching one is done
 * by hashing candidates until one agrees — which is the whole method below. It
 * carries no secrecy guarantee, and does not need to: the statement text is
 * never stored anywhere, so there is nothing for it to protect.
 *
 * Usage:
 *   node scripts/sql-fingerprint.mjs a3f19c2b      # find the statement
 *   node scripts/sql-fingerprint.mjs --sql "SELECT 1"   # fingerprint a string
 *
 * How it works: scan the TypeScript sources for string and template literals
 * that look like SQL, fingerprint each with the SAME algorithm the runtime uses
 * (SHA-256 over whitespace-normalised text, first 8 hex chars), and print the
 * ones that match.
 *
 * Two honest limits:
 *  - a statement assembled at runtime (template literal with `${...}`, or
 *    placeholders expanded from an array length) cannot be reproduced
 *    statically; the script says so and falls back to suggesting a grep by the
 *    digest half of the log line;
 *  - the algorithm is duplicated here, in three lines, so this file can run
 *    under plain node without a TypeScript build. GOLDEN below is checked at
 *    startup against the vector pinned in packages/db/sqlTiming.test.ts — if
 *    the two implementations ever drift, this script refuses to run rather than
 *    print a wrong answer.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['packages', 'electron', 'src']

/** Keep in sync with sqlFingerprint() in packages/db/sqlTiming.ts. */
export function fingerprint(sql) {
  return createHash('sha256').update(String(sql).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8)
}

/** Golden vector, pinned identically in packages/db/sqlTiming.test.ts. */
const GOLDEN_SQL = 'SELECT id\n  FROM messages\n WHERE folder_path = ?'
const GOLDEN_FP = 'adc55a42'

const SQL_START = /^\s*(select|insert|update|delete|replace|create|drop|alter|pragma|with|vacuum|reindex|analyze|begin|commit)\b/i

/** Every string/template literal in `text`, with its 1-based line number. */
function* literals(text) {
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`|'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    const value = m[1] ?? m[2] ?? m[3]
    if (!value || !SQL_START.test(value)) continue
    yield { value, line: text.slice(0, m.index).split('\n').length }
  }
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) yield* sourceFiles(full)
    else if (/\.(ts|tsx|mts)$/.test(entry) && !entry.endsWith('.d.ts')) yield full
  }
}

function main(argv) {
  if (fingerprint(GOLDEN_SQL) !== GOLDEN_FP) {
    console.error(`fingerprint algorithm drifted from packages/db/sqlTiming.ts (golden ${GOLDEN_FP}, got ${fingerprint(GOLDEN_SQL)}). Fix both or neither.`)
    return 2
  }
  const sqlFlag = argv.indexOf('--sql')
  if (sqlFlag !== -1) {
    const sql = argv[sqlFlag + 1]
    if (!sql) { console.error('--sql needs a statement'); return 2 }
    console.log(fingerprint(sql))
    return 0
  }
  const wanted = (argv[0] || '').replace(/^sql=/, '').toLowerCase()
  if (!/^[0-9a-f]{4,64}$/.test(wanted)) {
    console.error('usage: node scripts/sql-fingerprint.mjs <fingerprint> | --sql "<statement>"')
    return 2
  }

  let matches = 0
  let dynamic = 0
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8')
      for (const { value, line } of literals(text)) {
        if (value.includes('${')) { dynamic += 1; continue }
        if (fingerprint(value).startsWith(wanted)) {
          matches += 1
          console.log(`${path.relative(ROOT, file)}:${line}\n  ${value.replace(/\s+/g, ' ').trim()}\n`)
        }
      }
    }
  }
  if (matches === 0) {
    console.log(`no static statement matches ${wanted}.`)
    console.log(`${dynamic} SQL literals in the tree are assembled at runtime and cannot be fingerprinted from source;`)
    console.log('the log line also carries a "<verb> <table>" digest — grep the table name to narrow it down.')
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
