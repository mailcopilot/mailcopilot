#!/usr/bin/env node
/**
 * Telemetry schema gate.
 *
 * Greps the source tree for calls to recordEvent / recordHistogram /
 * recordGauge and verifies that every metric name is registered in
 * electron/metricsSchema.ts with a matching kind.
 *
 * Runs in CI before unit tests so a PR that adds a call like
 *   recordEvent('compose.typo')
 * without adding 'compose.typo' to METRIC_EVENTS fails fast with a pointer
 * to the offending file.
 *
 * Compile-time types in metrics.ts already prevent this at the TS level for
 * first-party code, but the script catches:
 *   - freshly-typed names that slipped through a type cast
 *   - schema drift where a name was removed but a call site forgotten
 *   - kind mismatches (recordEvent called for a histogram entry and vice versa)
 */

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_FILE = path.join(ROOT, 'electron/metricsSchema.ts')

const SCAN_ROOTS = [
  path.join(ROOT, 'electron'),
  path.join(ROOT, 'src'),
  path.join(ROOT, 'packages'),
]

const SKIP_SEGMENTS = new Set(['node_modules', 'dist', 'dist-electron', '.git', '.github', '.vite'])

const CALL_RE = /\brecord(Event|Histogram|Gauge)\s*\(\s*['"]([^'"]+)['"]/g
const KIND_BY_FN = { Event: 'event', Histogram: 'histogram', Gauge: 'gauge' }

// Net-layer spans flow through Sentry's tracing sink (see packages/net/telemetry.ts),
// not the recordEvent pipeline. We still want a single registry of allowed
// span names so a typo fails CI instead of silently shipping a new metric.
const NET_SPAN_CALL_RE = /\b(withNetSpan|startNetSpan)\s*\(\s*['"]([^'"]+)['"]/g
// DB spans are bridged via `withDbSpan` / `startDbSpan` in packages/db
// (layer-pure seam). Call sites use string literals — catch typos and
// unregistered names the same way NET_SPAN_CALL_RE does for net spans.
const DB_SPAN_CALL_RE = /\b(withDbSpan|startDbSpan)\s*\(\s*['"]([^'"]+)['"]/g

// Discrete net-layer events emitted via reportNetEvent (packages/net seam)
// bypass the typed recordEvent wrapper on the way out but end up in the
// same METRIC_EVENTS registry after main.ts wires the adapter. Without a
// CI scan a typo here (e.g. 'imap.idle_auth_refreshed' vs an unregistered
// name) would sail past lint and typecheck and only fail in production
// when the main-side validator drops the event. Mirror the recordEvent
// scan shape — every literal name must resolve to METRIC_EVENTS with
// kind='event'. This seam catches Round 1's schema-drift regression
// class (H-1) at static analysis time.
const REPORT_NET_EVENT_CALL_RE = /\breportNetEvent\s*\(\s*['"]([^'"]+)['"]/g

// Mirror seam for packages/db — discrete events emitted via reportDbEvent
// (e.g. 'db.mass_delete_messages' fired by removeStaleMessages when it
// actually purges rows). Same contract as reportNetEvent: the literal
// must resolve to METRIC_EVENTS with kind='event', otherwise the call
// never reaches the typed recordEvent dispatcher in main.ts.
const REPORT_DB_EVENT_CALL_RE = /\breportDbEvent\s*\(\s*['"]([^'"]+)['"]/g

async function parseSchema() {
  const src = await readFile(SCHEMA_FILE, 'utf8')
  // Very small parser — we only need { name, kind } pairs. Tolerant of
  // whitespace and trailing commas. Stops at the matching `} as const satisfies`.
  const start = src.indexOf('export const METRIC_EVENTS')
  if (start < 0) throw new Error(`METRIC_EVENTS not found in ${SCHEMA_FILE}`)
  const tail = src.slice(start)
  const end = tail.indexOf('} as const satisfies')
  if (end < 0) throw new Error('could not find end of METRIC_EVENTS block')
  const body = tail.slice(0, end)
  const entryRe = /'([a-zA-Z0-9_.]+)'\s*:\s*\{\s*kind\s*:\s*'(event|histogram|gauge)'/g
  const out = new Map()
  let m
  while ((m = entryRe.exec(body)) !== null) {
    out.set(m[1], m[2])
  }
  if (out.size === 0) throw new Error('metricsSchema.ts parsed to zero entries')
  return out
}

async function parseNetSpans() {
  const src = await readFile(SCHEMA_FILE, 'utf8')
  const start = src.indexOf('export const NET_SPANS')
  if (start < 0) throw new Error(`NET_SPANS not found in ${SCHEMA_FILE}`)
  const tail = src.slice(start)
  const end = tail.indexOf('} as const satisfies')
  if (end < 0) throw new Error('could not find end of NET_SPANS block')
  const body = tail.slice(0, end)
  const entryRe = /'([a-zA-Z0-9_.]+)'\s*:\s*\{/g
  const out = new Set()
  let m
  while ((m = entryRe.exec(body)) !== null) {
    out.add(m[1])
  }
  if (out.size === 0) throw new Error('NET_SPANS parsed to zero entries')
  return out
}

async function parseDbSpans() {
  const src = await readFile(SCHEMA_FILE, 'utf8')
  const start = src.indexOf('export const DB_SPANS')
  if (start < 0) throw new Error(`DB_SPANS not found in ${SCHEMA_FILE}`)
  const tail = src.slice(start)
  const end = tail.indexOf('} as const satisfies')
  if (end < 0) throw new Error('could not find end of DB_SPANS block')
  const body = tail.slice(0, end)
  const entryRe = /'([a-zA-Z0-9_.]+)'\s*:\s*\{/g
  const out = new Set()
  let m
  while ((m = entryRe.exec(body)) !== null) {
    out.add(m[1])
  }
  if (out.size === 0) throw new Error('DB_SPANS parsed to zero entries')
  return out
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (SKIP_SEGMENTS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield* walk(full)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      yield full
    }
  }
}

async function main() {
  const schema = await parseSchema()
  const netSpans = await parseNetSpans()
  const dbSpans = await parseDbSpans()
  const problems = []
  for (const root of SCAN_ROOTS) {
    for await (const file of walk(root)) {
      // Skip the schema itself and the pipeline module — they define the API.
      if (file.endsWith('metricsSchema.ts')) continue
      const rel = path.relative(ROOT, file)
      const text = await readFile(file, 'utf8')
      CALL_RE.lastIndex = 0
      let match
      while ((match = CALL_RE.exec(text)) !== null) {
        const fn = match[1]
        const name = match[2]
        const expectedKind = KIND_BY_FN[fn]
        const line = text.slice(0, match.index).split('\n').length
        const actualKind = schema.get(name)
        if (!actualKind) {
          problems.push(`${rel}:${line}  unknown metric '${name}' (record${fn})`)
        } else if (actualKind !== expectedKind) {
          problems.push(`${rel}:${line}  kind mismatch for '${name}' — called as ${expectedKind} but registered as ${actualKind}`)
        }
      }
      // Net-span call sites — only the definition module (telemetry.ts)
      // is allowed to reference the helper without a literal span name.
      NET_SPAN_CALL_RE.lastIndex = 0
      while ((match = NET_SPAN_CALL_RE.exec(text)) !== null) {
        const fn = match[1]
        const name = match[2]
        if (!netSpans.has(name)) {
          const line = text.slice(0, match.index).split('\n').length
          problems.push(`${rel}:${line}  unknown net span '${name}' (${fn}) — register in NET_SPANS`)
        }
      }
      // DB-span call sites — catches typos / unregistered renames in
      // packages/db before they ship. Mirror of NET_SPAN_CALL_RE above.
      DB_SPAN_CALL_RE.lastIndex = 0
      while ((match = DB_SPAN_CALL_RE.exec(text)) !== null) {
        const fn = match[1]
        const name = match[2]
        if (!dbSpans.has(name)) {
          const line = text.slice(0, match.index).split('\n').length
          problems.push(`${rel}:${line}  unknown db span '${name}' (${fn}) — register in DB_SPANS`)
        }
      }
      // Discrete reportNetEvent call sites — same contract as recordEvent:
      // the literal must resolve to METRIC_EVENTS with kind='event'.
      REPORT_NET_EVENT_CALL_RE.lastIndex = 0
      while ((match = REPORT_NET_EVENT_CALL_RE.exec(text)) !== null) {
        const name = match[1]
        const line = text.slice(0, match.index).split('\n').length
        const actualKind = schema.get(name)
        if (!actualKind) {
          problems.push(`${rel}:${line}  unknown metric '${name}' (reportNetEvent)`)
        } else if (actualKind !== 'event') {
          problems.push(`${rel}:${line}  kind mismatch for '${name}' — called as event (reportNetEvent) but registered as ${actualKind}`)
        }
      }
      // Same contract for packages/db's reportDbEvent seam.
      REPORT_DB_EVENT_CALL_RE.lastIndex = 0
      while ((match = REPORT_DB_EVENT_CALL_RE.exec(text)) !== null) {
        const name = match[1]
        const line = text.slice(0, match.index).split('\n').length
        const actualKind = schema.get(name)
        if (!actualKind) {
          problems.push(`${rel}:${line}  unknown metric '${name}' (reportDbEvent)`)
        } else if (actualKind !== 'event') {
          problems.push(`${rel}:${line}  kind mismatch for '${name}' — called as event (reportDbEvent) but registered as ${actualKind}`)
        }
      }
    }
  }
  if (problems.length > 0) {
    console.error('Telemetry schema check failed:')
    for (const p of problems) console.error('  ' + p)
    console.error(`\n${problems.length} problem(s). Register new metrics in electron/metricsSchema.ts.`)
    process.exit(1)
  }
  console.log(`Telemetry schema check OK (${schema.size} registered metrics, ${netSpans.size} net spans, ${dbSpans.size} db spans).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
