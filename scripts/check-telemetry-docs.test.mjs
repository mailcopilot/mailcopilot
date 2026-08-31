#!/usr/bin/env node
/**
 * Tests for scripts/check-telemetry-docs.mjs.
 *
 * Style follows scripts/check-audit-expiry.test.mjs: node:test + node:assert, no
 * external deps. Synthetic trees are built in a temp directory and passed to the
 * CLI via `--root=`, so nothing here mutates the real disclosure pages — the
 * very files the guard exists to protect.
 *
 * A test that no plausible mutation kills is decoration, and this guard is the
 * only automated thing standing between a schema edit and a metric nobody wrote
 * down (human review still owns whether the wording is right — and whether the
 * row is where a reader will look). So each test states the mutation it kills in
 * a comment above it, except for the four whose own name already is that
 * statement (`parseArgs: --root is extracted, unknown flags throw`) or that
 * repeat a nearby case — another export, another boundary character — under the
 * comment that already explains it.
 *
 * ── Round 2: expectations must be independent of the code under test ──────
 * Three tests here used to compare the parser with ITSELF — "the real schema
 * yields more than 90 names", "every ELECTRON_SPANS member reaches the name set"
 * (both sides produced by `parseNameBlock`). A parser that stably dropped a
 * member passed all of them. The counts below are therefore literal, and the
 * three span inventories are written out in full. Yes, that means adding a
 * metric requires editing a number here — in the same commit that already
 * requires editing six disclosure pages, which is the point. What a count does
 * and does not catch on its own is stated at REAL_BLOCK_COUNTS.
 *
 * ── Round 3: the accepted disclosure format narrowed to a table row ────────
 * The markdown scanner is gone, and with it every test that described the
 * scanner's own behaviour (fence markers, backtick-run lengths, unterminated
 * comments). The tests that described a PROPERTY — "prose written inside a
 * comment does not disclose" — are still here, rewritten, and they now pass for
 * a different reason: not because comments are stripped, but because none of
 * those lines is shaped like a table row.
 *
 * ── Round 4: from "somewhere in the row" to "the row's name cell" ──────────
 * Round 3 matched a name against the row's whole raw text, and that was a false
 * green in the main scenario: `provider`, `folder_role`, `ai.provider` and
 * `install_id_hash` already stand on all six pages as per-metric attributes in
 * the Tags column, so registering a METRIC under any of those names and
 * describing it nowhere left the check green. The unit judged is now the ENTRY —
 * the whole content of a row's first cell — and the four examples are tested
 * BY NAME below, against the real pages and end to end.
 *
 * What these tests do NOT establish, so that nobody reads them as more than
 * they are: that an entry the guard accepted is visible to a reader. Recognition
 * is by shape only, so a row-shaped line inside a comment or a hidden block
 * counts — see "What the guard proves, and what it does not" in the guard's
 * header for the threat model and for what closing that would take.
 *
 * Run:
 *   node --test scripts/check-telemetry-docs.test.mjs
 *   npm run test:scripts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  ROOT,
  SCHEMA_RELPATH,
  CANON_RELPATH,
  I18N_INDEX_RELPATH,
  I18N_RELPATH,
  SCHEMA_BLOCKS,
  SCHEMA_EXPORTS_WITHOUT_NAMES,
  localeDisclosureRelpath,
  parseSourceFile,
  listValueExports,
  assertExportsAccountedFor,
  parseNameBlock,
  collectSchemaNames,
  parseSupportedLanguages,
  docLocalesFrom,
  tableRows,
  firstCellOf,
  listEntryNames,
  findMissing,
  formatReport,
  parseArgs,
} from './check-telemetry-docs.mjs'

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-telemetry-docs.mjs')

/** Languages every synthetic tree claims to ship. Independent of the real repo. */
const SYNTH_LANGUAGES = ['en', 'ru', 'fr', 'de', 'es', 'it']
const SYNTH_LOCALES = SYNTH_LANGUAGES.filter((l) => l !== 'en')

// ============================================================================
// Synthetic-tree helpers
// ============================================================================

/**
 * Minimal schema file shaped like the real one: the five name-registering
 * exports, the excluded DOMAINS, and a type export.
 *
 * `spanOps` defaults to the identity mapping the real schema uses, so the
 * METRIC_SPAN_OP block contributes no name of its own; a test that wants a
 * divergent op passes its own map.
 *
 * DOMAINS and the type export are here because the guard now demands that every
 * value export of the schema be classified: a fixture without DOMAINS would not
 * exercise the exclusion list, and one without a type would not show that types
 * are exempt by form.
 *
 * `extraSource` is appended verbatim — how a test adds an export the lists do
 * not mention.
 */
function makeSchema({
  events = ['app.session_started', 'sync.folder'],
  netSpans = ['imap.idle'],
  electronSpans = ['body_indexer.batch'],
  dbSpans = ['db.search_messages'],
  spanOps = null,
  extraSource = '',
} = {}) {
  const block = (name, entries, extra) =>
    [
      `export const ${name} = {`,
      ...entries.map((e) => `  '${e}': {\n${extra}\n    tags: {\n      folder_role: 'folder_role',\n    },\n  },`),
      `} as const satisfies Record<string, unknown>`,
      '',
    ].join('\n')
  const ops = spanOps ?? Object.fromEntries([...netSpans, ...electronSpans, ...dbSpans].map((n) => [n, n]))
  const opBlock = [
    'export const METRIC_SPAN_OP: Record<MetricSpanName, string> = {',
    ...Object.entries(ops).map(([k, v]) => `  '${k}': '${v}',`),
    '}',
    '',
  ].join('\n')
  return [
    '// synthetic schema fixture',
    "export const DOMAINS = {\n  folder_role: ['inbox', 'sent'],\n} as const\n",
    block('METRIC_EVENTS', events, "    kind: 'event',\n    purpose: 'test',"),
    block('NET_SPANS', netSpans, "    purpose: 'test',"),
    block('ELECTRON_SPANS', electronSpans, "    purpose: 'test',"),
    block('DB_SPANS', dbSpans, "    purpose: 'test',"),
    opBlock,
    'export type MetricName = keyof typeof METRIC_EVENTS',
    extraSource,
    '',
  ].join('\n')
}

/** Minimal src/i18n/index.ts declaring which languages the product ships. */
function makeI18nIndex(languages = SYNTH_LANGUAGES) {
  return [
    "import i18n from 'i18next'",
    '',
    `export const SUPPORTED_LANGUAGES = [${languages.map((l) => `'${l}'`).join(', ')}] as const`,
    'export type Language = typeof SUPPORTED_LANGUAGES[number]',
    '',
    'export default i18n',
    '',
  ].join('\n')
}

/**
 * Disclosure page listing each of `names` as an entry — a row whose first cell
 * is the backticked name, which is how all six real pages are written.
 *
 * `tags` fills the Tags column of every row with attribute names. That column is
 * the round-4 finding in fixture form: whatever stands there is per-metric
 * detail of the row's own metric, and must never vouch for a metric of that
 * name. Default is empty, so a fixture only carries tags when a test asks.
 */
function makePage(names, { tags = [] } = {}) {
  // Both shapes the real pages use, because they defeat different rules: the
  // first row lists every tag (a multi-value cell), and each row after it
  // carries a SINGLE tag, which therefore fills its cell whole — the shape that
  // makes a position-independent "the name is a whole cell" rule useless.
  const tagCell = (i) => {
    if (tags.length === 0) return '—'
    const inCell = i === 0 ? tags : [tags[(i - 1) % tags.length]]
    return inCell.map((t) => `\`${t}\``).join(', ')
  }
  return [
    '---',
    'title: Telemetry',
    '---',
    '',
    '# Telemetry',
    '',
    '| Event | Tags | Purpose |',
    '| --- | --- | --- |',
    ...names.map((n, i) => `| \`${n}\` | ${tagCell(i)} | why it is collected |`),
    '',
  ].join('\n')
}

function writeFileDeep(root, relPath, content) {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/**
 * Builds a complete, passing synthetic tree, then applies the per-test defect
 * described by the options. Returns the temp root; caller removes it.
 */
function makeTree({
  schema,
  i18nIndex,
  languages,
  canonNames,
  localeNames = {},
  skipLocales = [],
  extraLocales = [],
  tags = [],
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'telemetry-docs-'))
  const names = canonNames ?? [
    'app.session_started',
    'sync.folder',
    'imap.idle',
    'body_indexer.batch',
    'db.search_messages',
  ]
  writeFileDeep(root, SCHEMA_RELPATH, schema ?? makeSchema())
  writeFileDeep(root, I18N_INDEX_RELPATH, i18nIndex ?? makeI18nIndex(languages))
  writeFileDeep(root, CANON_RELPATH, makePage(names, { tags }))
  for (const locale of SYNTH_LOCALES) {
    if (skipLocales.includes(locale)) continue
    writeFileDeep(root, localeDisclosureRelpath(locale), makePage(localeNames[locale] ?? names, { tags }))
  }
  for (const locale of extraLocales) {
    // A locale directory that exists but is not a shipped language.
    writeFileDeep(root, localeDisclosureRelpath(locale), makePage(names, { tags }))
  }
  return root
}

function runCli(root, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, `--root=${root}`, ...extraArgs], { encoding: 'utf8' })
}

/** Builds a tree, runs the CLI, always cleans up. */
function checkTree(options, extraArgs = []) {
  const root = makeTree(options)
  try {
    return runCli(root, extraArgs)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const realSchemaSource = () => readFileSync(path.join(ROOT, SCHEMA_RELPATH), 'utf8')

// ============================================================================
// Unit: parseNameBlock — extraction is compiler-backed, not text-shaped
// ============================================================================

// Mutation killed: returning [] instead of throwing when the export is absent
// (a renamed export would then "disclose" nothing and pass green).
test('parseNameBlock: a missing export block throws with an actionable message', () => {
  assert.throws(
    () => parseNameBlock('export const OTHER = {} as const satisfies X', 'METRIC_EVENTS'),
    /METRIC_EVENTS.*not found/s,
  )
})

// Mutation killed: `if (names.length === 0) return []` — an empty parse treated
// as "nothing to disclose" is exactly the silent-pass this guard forbids.
test('parseNameBlock: a block that parses to zero entries throws, never returns empty', () => {
  const src = 'export const METRIC_EVENTS = {\n} as const satisfies Record<string, unknown>'
  assert.throws(() => parseNameBlock(src, 'METRIC_EVENTS'), /zero entries/)
})

// Mutation killed: dropping the syntax-error check. The TypeScript parser
// RECOVERS from a missing brace and hands back a plausible, silently truncated
// name set — the same defect the old `} as const satisfies` terminator search
// had, in a new coat. A file that does not parse must be a hard failure.
test('parseNameBlock: a truncated schema throws instead of parsing to a shorter set', () => {
  const src = "export const METRIC_EVENTS = {\n  'app.session_started': { kind: 'event' },\n  'sync.folder': {\n"
  assert.throws(() => parseNameBlock(src, 'METRIC_EVENTS'), /syntax error/)
  // Control: the same block, terminated, does parse — so the throw above is
  // about the truncation and not about the fixture being unusable.
  assert.deepEqual(
    parseNameBlock(`${src}  },\n} as const satisfies Record<string, unknown>\n`, 'METRIC_EVENTS'),
    ['app.session_started', 'sync.folder'],
  )
})

// Mutation killed: walking every object literal in the file instead of the
// exported one's own properties — nested tag keys would become metric names.
test('parseNameBlock: nested keys are not mistaken for entries', () => {
  const src = [
    'export const METRIC_EVENTS = {',
    "  'app.session_started': {",
    "    kind: 'event',",
    '    tags: {',
    "      'nested.key': { x: 1 },",
    '    },',
    '  },',
    '} as const satisfies Record<string, unknown>',
  ].join('\n')
  assert.deepEqual(parseNameBlock(src, 'METRIC_EVENTS'), ['app.session_started'])
})

// ── The round-2 finding, proven by execution ────────────────────────────────
// Mutation killed: going back to a text-shaped parser of ANY kind. The round-1
// regex was `/^ {2}'([a-zA-Z0-9_.]+)'\s*:\s*\{/gm`, and its own comment claimed
// a reformat would drop the count to zero and throw. That only holds if EVERY
// entry is reformatted. One NEW entry in a different style was skipped in
// silence while the untouched entries kept the count non-zero — no throw, green
// check, undisclosed metric shipped. Each name below is invisible to that regex
// and must be found now.
test('parseNameBlock: entries are found regardless of quoting, indent or key characters', () => {
  const src = [
    'export const METRIC_EVENTS = {',
    "  'plain.single_quoted': { kind: 'event' },",
    '  "double.quoted": { kind: \'event\' },',
    "      'deeply.indented': { kind: 'event' },",
    "'not.indented': { kind: 'event' },",
    '  unquoted_identifier: { kind: \'event\' },',
    "  'has.a-dash': { kind: 'event' },",
    "  'compact.same_line': { kind: 'event' }, 'second.on_that_line': { kind: 'event' },",
    '} as const satisfies Record<string, unknown>',
  ].join('\n')
  assert.deepEqual(parseNameBlock(src, 'METRIC_EVENTS'), [
    'plain.single_quoted',
    'double.quoted',
    'deeply.indented',
    'not.indented',
    'unquoted_identifier',
    'has.a-dash',
    'compact.same_line',
    'second.on_that_line',
  ])
})

// Mutation killed: bounding the block by searching for the literal text
// `} as const satisfies` (round 1). The schema is a heavily commented file; the
// terminator appearing inside a comment or a string cut the block short and
// every entry after it went unchecked, again with no throw because the entries
// BEFORE it kept the count non-zero.
test('parseNameBlock: the literal terminator text inside a comment or string does not truncate the block', () => {
  const src = [
    'export const METRIC_EVENTS = {',
    "  'before.the_bait': { kind: 'event' },",
    '  // historic note: this block used to end with `} as const satisfies Foo`',
    "  'after.a_comment': { kind: 'event' },",
    "  'after.a_string': { kind: 'event', purpose: 'ends with } as const satisfies Bar' },",
    "  'last.entry': { kind: 'event' },",
    '} as const satisfies Record<string, unknown>',
  ].join('\n')
  assert.deepEqual(parseNameBlock(src, 'METRIC_EVENTS'), [
    'before.the_bait',
    'after.a_comment',
    'after.a_string',
    'last.entry',
  ])
})

// Mutation killed: reintroducing an indent-anchored matcher. Round 1 asserted
// the OPPOSITE of this test — that widening the indent must throw — and called
// that fail-closed behaviour. It was really the parser admitting it read layout
// instead of code. A wholesale reformat is a formatting change and must be a
// no-op for the guard.
test('parseNameBlock: reformatting a whole block changes nothing about the names', () => {
  const twoSpace = [
    'export const METRIC_EVENTS = {',
    "  'app.session_started': {",
    "    kind: 'event',",
    '  },',
    "  'sync.folder': {",
    "    kind: 'event',",
    '  },',
    '} as const satisfies Record<string, unknown>',
  ].join('\n')
  const fourSpace = twoSpace.replace(/^ {2}(?=')/gm, '    ').replace(/^ {4}kind/gm, '        kind')
  assert.notEqual(fourSpace, twoSpace)
  assert.deepEqual(parseNameBlock(fourSpace, 'METRIC_EVENTS'), parseNameBlock(twoSpace, 'METRIC_EVENTS'))
  assert.deepEqual(parseNameBlock(fourSpace, 'METRIC_EVENTS'), ['app.session_started', 'sync.folder'])
})

// Mutation killed: skipping entry shapes the parser cannot resolve instead of
// throwing. A computed key or a spread is a name the guard cannot see; silently
// dropping it is the same silent pass by another route.
test('parseNameBlock: entry shapes that cannot be resolved statically throw', () => {
  const computed = [
    'export const METRIC_EVENTS = {',
    "  'ok.one': { kind: 'event' },",
    "  [SOME_CONST]: { kind: 'event' },",
    '} as const satisfies Record<string, unknown>',
  ].join('\n')
  assert.throws(() => parseNameBlock(computed, 'METRIC_EVENTS'), /not a literal/)

  const spread = [
    'export const METRIC_EVENTS = {',
    "  'ok.one': { kind: 'event' },",
    '  ...OTHER_EVENTS,',
    '} as const satisfies Record<string, unknown>',
  ].join('\n')
  assert.throws(() => parseNameBlock(spread, 'METRIC_EVENTS'), /SpreadAssignment/)
})

// Mutation killed: accepting a non-object export (e.g. `export const X = buildEvents()`)
// and quietly returning nothing to check.
test('parseNameBlock: an export that is not an object literal throws', () => {
  assert.throws(
    () => parseNameBlock('export const METRIC_EVENTS = buildEvents()', 'METRIC_EVENTS'),
    /not an object literal/,
  )
})

// ============================================================================
// Unit: METRIC_SPAN_OP values (round-2 finding 2)
// ============================================================================

// Mutation killed: checking only the KEYS of METRIC_SPAN_OP (round 1 excluded
// the export entirely on the grounds that its keys were covered elsewhere —
// true, and beside the point). The VALUES are the Sentry `op` strings actually
// sent, and the schema explicitly allows one to diverge from its span name.
test('parseNameBlock: METRIC_SPAN_OP is read by its values, not its keys', () => {
  const src = [
    'export const METRIC_SPAN_OP: Record<MetricSpanName, string> = {',
    "  'imap.idle': 'imap.idle',",
    "  'ai.chat': 'ai.request_grouped',",
    '}',
  ].join('\n')
  assert.deepEqual(parseNameBlock(src, 'METRIC_SPAN_OP', 'keys'), ['imap.idle', 'ai.chat'])
  assert.deepEqual(parseNameBlock(src, 'METRIC_SPAN_OP', 'values'), ['imap.idle', 'ai.request_grouped'])
})

// Mutation killed: tolerating a computed op value (a lookup, a template with a
// substitution) by skipping it — the string still reaches Sentry.
test('parseNameBlock: a METRIC_SPAN_OP value that is not a string literal throws', () => {
  const src = [
    'export const METRIC_SPAN_OP: Record<MetricSpanName, string> = {',
    "  'imap.idle': OP_PREFIX + 'idle',",
    '}',
  ].join('\n')
  assert.throws(() => parseNameBlock(src, 'METRIC_SPAN_OP', 'values'), /not a string literal/)
})

// Mutation killed: dropping METRIC_SPAN_OP from SCHEMA_BLOCKS. Proven by
// consequence through the CLI: an op that diverges from its span name is a
// telemetry string no page names, and must turn the guard red.
test('CLI: an op value that diverges from its span name must be disclosed too', () => {
  const schema = makeSchema({
    spanOps: {
      'imap.idle': 'imap.idle',
      'body_indexer.batch': 'body_indexer.batch',
      'db.search_messages': 'db.search_grouped_op',
    },
  })
  const res = checkTree({ schema })
  assert.equal(res.status, 1, `stdout: ${res.stdout}`)
  assert.match(res.stderr, /db\.search_grouped_op/)
  assert.match(res.stderr, /METRIC_SPAN_OP/)
  assert.match(res.stderr, /span op/)
  // The span name itself is documented and is not dragged into the report.
  assert.doesNotMatch(res.stderr, /- db\.search_messages/)
})

// Mutation control for the test above: the identity mapping the real schema
// uses adds no names at all, so including the block costs nothing today.
test('CLI: identity op values add no names and keep the tree green', () => {
  const res = checkTree({})
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.match(res.stdout, /disclosure check OK — all 5 schema names stand as a table entry \(the whole first cell of a row\) in each of 6 files/)
})

// ============================================================================
// Unit: every value export of the schema is accounted for (round-5 finding)
// ============================================================================

/**
 * ── Round 5: the checked set was a hand-written list, and nothing said so ──
 * Rounds 1–4 left the guard reading exactly the exports somebody remembered to
 * put in SCHEMA_BLOCKS, while its header claimed it checked "every
 * name-registering block". A NEW export of metricsSchema.ts was not checked, not
 * reported and not skipped-with-a-warning: it was invisible. That is the same
 * hole ELECTRON_SPANS fell into (a block that existed, was absent from the list,
 * and left the run green) — and honest forgetfulness is precisely the adversary
 * this guard is built for.
 *
 * The tests below hold the fix to its claim: every value export must be
 * classified as checked or as explicitly nameless, an unclassified one is a hard
 * failure, and the split between "needs classifying" and "does not" is by FORM
 * (a type declares nothing that leaves the machine) rather than by name.
 */

/** Parses a synthetic schema the way the guard does. */
const parseSchema = (src) => parseSourceFile(SCHEMA_RELPATH, src)

/** Two exports: one the lists will know, one they will not. */
const TWO_EXPORTS = [
  "export const CHECKED = { 'checked.name': { kind: 'event' } } as const",
  "export const NEWCOMER = { 'newcomer.name': { kind: 'event' } } as const",
].join('\n')

const CHECKED_BLOCK = { exportName: 'CHECKED', label: 'event', side: 'keys' }

// Mutation killed: the round-4 state itself — no accounting at all, i.e. reading
// only the exports named in SCHEMA_BLOCKS. Under that code this source passes
// while 'newcomer.name' is disclosed nowhere.
test('assertExportsAccountedFor: an export in neither list is refused, and the message says what to do', () => {
  assert.throws(
    () =>
      assertExportsAccountedFor(parseSchema(TWO_EXPORTS), SCHEMA_RELPATH, {
        blocks: [CHECKED_BLOCK],
        excluded: [],
      }),
    (err) => {
      // Names the export, so the reader knows which one is meant.
      assert.match(err.message, /'NEWCOMER'/)
      // And both destinations, so the reader knows what the decision is between.
      assert.match(err.message, /SCHEMA_BLOCKS/)
      assert.match(err.message, /SCHEMA_EXPORTS_WITHOUT_NAMES/)
      // The classified export is not dragged into the complaint.
      assert.doesNotMatch(err.message, /'CHECKED'/)
      return true
    },
  )
})

// Mutation killed: refusing every export the blocks do not cover, i.e. ignoring
// SCHEMA_EXPORTS_WITHOUT_NAMES. The exclusion list has to be a real destination,
// otherwise the only way to silence the new check is to pretend an export
// registers names.
test('assertExportsAccountedFor: an export moved into the exclusion list passes', () => {
  assert.doesNotThrow(() =>
    assertExportsAccountedFor(parseSchema(TWO_EXPORTS), SCHEMA_RELPATH, {
      blocks: [CHECKED_BLOCK],
      excluded: [{ exportName: 'NEWCOMER', why: 'internal lookup, registers no name' }],
    }),
  )
  // And being excluded means exactly one thing: its names are not collected, so
  // no page has to mention them.
  const names = collectSchemaNames(TWO_EXPORTS, {
    blocks: [CHECKED_BLOCK],
    excluded: [{ exportName: 'NEWCOMER', why: 'internal lookup, registers no name' }],
  }).map((e) => e.name)
  assert.deepEqual(names, ['checked.name'])
})

// Mutation killed: an accounting check that merely counts an export as "known"
// without ever reading it — classification as checked has to pull the names in
// and make the pages carry them.
test('assertExportsAccountedFor: an export moved into SCHEMA_BLOCKS has its names demanded on the pages', () => {
  const blocks = [CHECKED_BLOCK, { exportName: 'NEWCOMER', label: 'event', side: 'keys' }]
  const collected = collectSchemaNames(TWO_EXPORTS, { blocks, excluded: [] })
  assert.deepEqual(collected.map((e) => e.name), ['checked.name', 'newcomer.name'])

  const problems = findMissing(collected, [
    { relPath: CANON_RELPATH, locale: null, entries: ['checked.name'] },
  ])
  assert.deepEqual(problems.map((p) => p.name), ['newcomer.name'])
  assert.equal(problems[0].exportName, 'NEWCOMER')
})

// Mutation killed: classifying by "is it exported?" alone. metricsSchema.ts has
// a dozen type exports; demanding a list entry for each would turn the real tree
// red and push whoever hit it to widen the lists with meaningless entries.
test('listValueExports: type exports need no classification, value exports do', () => {
  const src = [
    "export const CHECKED = { 'checked.name': {} } as const",
    'export type MetricName = keyof typeof CHECKED',
    'export interface MetricDefinition { kind: string }',
    'export type { MetricName as Alias }',
  ].join('\n')
  assert.deepEqual(listValueExports(parseSchema(src), SCHEMA_RELPATH), ['CHECKED'])
  assert.doesNotThrow(() =>
    assertExportsAccountedFor(parseSchema(src), SCHEMA_RELPATH, { blocks: [CHECKED_BLOCK], excluded: [] }),
  )
})

// Mutation killed: walking `export const` statements only. A value can reach the
// outside through an export clause, and that route must not be a way past the
// classification.
test('listValueExports: a value re-exported through an export clause still needs classification', () => {
  const src = ["const HELPER = { 'helper.name': {} } as const", 'export { HELPER }'].join('\n')
  assert.deepEqual(listValueExports(parseSchema(src), SCHEMA_RELPATH), ['HELPER'])
  assert.throws(
    () => assertExportsAccountedFor(parseSchema(src), SCHEMA_RELPATH, { blocks: [], excluded: [] }),
    /'HELPER'/,
  )
})

// Mutation killed: skipping export forms the enumerator cannot resolve. An
// export the guard cannot even NAME is one it cannot account for; treating it as
// "nothing here" reinstates the silent pass one level up.
test('listValueExports: export forms that cannot be enumerated are refused, not skipped', () => {
  const star = "export const CHECKED = {} as const\nexport * from './other'"
  assert.throws(() => listValueExports(parseSchema(star), SCHEMA_RELPATH), /export \* from/)

  const dflt = "export const CHECKED = {} as const\nexport default { 'sneaky.name': {} }"
  assert.throws(() => listValueExports(parseSchema(dflt), SCHEMA_RELPATH), /export default/)

  const destructured = 'export const { A, B } = SOMETHING'
  assert.throws(() => listValueExports(parseSchema(destructured), SCHEMA_RELPATH), /destructured export/)

  // Control: a namespace re-export CAN be named, so it is classified like any
  // other value export rather than refused.
  const ns = "export * as helpers from './other'"
  assert.deepEqual(listValueExports(parseSchema(ns), SCHEMA_RELPATH), ['helpers'])
})

// Mutation killed: never validating the exclusion list against the file. A
// leftover entry describes nothing, and would silently cover a future export
// that happens to reuse the name.
test('assertExportsAccountedFor: an exclusion naming an export the file does not have is refused', () => {
  assert.throws(
    () =>
      assertExportsAccountedFor(parseSchema("export const CHECKED = { 'checked.name': {} } as const"), SCHEMA_RELPATH, {
        blocks: [CHECKED_BLOCK],
        excluded: [{ exportName: 'LONG_GONE', why: 'used to be a lookup table' }],
      }),
    /LONG_GONE.*does not export/s,
  )
})

/**
 * The real file's value exports, written out rather than derived — same reason
 * as REAL_BLOCK_COUNTS below. Adding an export to metricsSchema.ts means editing
 * this list AND one of the guard's two lists, in the commit that adds it.
 */
const REAL_VALUE_EXPORTS = [
  'DOMAINS',
  'METRIC_EVENTS',
  'NET_SPANS',
  'ELECTRON_SPANS',
  'DB_SPANS',
  'METRIC_SPAN_OP',
]

// Mutation killed: an enumerator that misses a form the real schema uses (the
// literal list would then be longer than what it returns), and a classification
// that drifts from the file (an export in neither list, or a list entry naming
// nothing).
test('the real schema exports exactly these six values, and each is classified exactly once', () => {
  const sourceFile = parseSchema(realSchemaSource())
  assert.deepEqual(listValueExports(sourceFile, SCHEMA_RELPATH), REAL_VALUE_EXPORTS)

  const classified = [
    ...SCHEMA_BLOCKS.map((b) => b.exportName),
    ...SCHEMA_EXPORTS_WITHOUT_NAMES.map((e) => e.exportName),
  ]
  assert.equal(new Set(classified).size, classified.length, 'an export must not be in both lists')
  assert.deepEqual([...classified].sort(), [...REAL_VALUE_EXPORTS].sort())
  assert.doesNotThrow(() => assertExportsAccountedFor(sourceFile, SCHEMA_RELPATH))

  // An exclusion is a decision recorded in writing; an empty `why` is not one.
  for (const entry of SCHEMA_EXPORTS_WITHOUT_NAMES) {
    assert.ok(
      typeof entry.why === 'string' && entry.why.length > 40,
      `${entry.exportName} must state why it registers no telemetry name`,
    )
  }
})

// Mutation killed: dropping the accounting call from collectSchemaNames — every
// unit test above would still pass while the CLI, the thing CI runs, checked
// nothing about unknown exports.
test('CLI: a new schema export in neither list turns the check red end to end', () => {
  const schema = makeSchema({
    extraSource: "export const CONSENT_SCOPES = {\n  'consent.scope_shown': { kind: 'event' },\n} as const\n",
  })
  const res = checkTree({ schema })
  assert.equal(res.status, 1, `stdout: ${res.stdout}`)
  assert.match(res.stderr, /CONSENT_SCOPES/)
  assert.match(res.stderr, /never been told about/)
  assert.match(res.stderr, /SCHEMA_BLOCKS/)
  assert.match(res.stderr, /SCHEMA_EXPORTS_WITHOUT_NAMES/)
})

// Mutation killed: moving DOMAINS out of the exclusion list into SCHEMA_BLOCKS
// (or dropping the exclusion list from the accounting). The synthetic schema
// exports DOMAINS with a `folder_role` key that appears on no page, and the tree
// is green — which is what "excluded" has to mean end to end.
test('CLI: an export listed as registering no names is not demanded on the pages', () => {
  const root = makeTree({})
  try {
    assert.match(readFileSync(path.join(root, SCHEMA_RELPATH), 'utf8'), /export const DOMAINS/)
    assert.doesNotMatch(readFileSync(path.join(root, CANON_RELPATH), 'utf8'), /folder_role/)
    const res = runCli(root)
    assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ============================================================================
// Unit: collectSchemaNames against the REAL schema — literal expectations
// ============================================================================

/**
 * The real registry, written out independently of the parser.
 *
 * Round 1 asserted `all.length > 90` and then compared the total with a sum of
 * the same parser's per-block results. Up to nineteen names could vanish with
 * every assertion still green. These numbers are an oracle instead: if the
 * parser starts dropping entries the count moves, and if you legitimately add a
 * metric you bump the number in the same commit that adds it to six disclosure
 * pages.
 *
 * WHAT A COUNT CATCHES, exactly: LOSS. It does not catch SUBSTITUTION — a
 * parser that drops one entry in the same commit that adds another leaves the
 * count where it was. Closing that needs a name-by-name oracle, which is cheap
 * for a small block and not for a large one, so this file does both and says
 * which is which:
 *
 *   NET_SPANS (3), ELECTRON_SPANS (11), DB_SPANS (3), METRIC_SPAN_OP (17, an
 *   identity mapping of the other three today) — pinned BY NAME below, so a
 *   swap fails too.
 *   METRIC_EVENTS (112) — count only, and therefore loss-only. The uncovered
 *   shape, stated so nobody assumes it is covered: a defect makes the parser
 *   stop seeing one event WHILE a metric is legitimately added, in one commit —
 *   the count stays 112 and the unseen name is never demanded on any page.
 *   A hundred literals would close it, at the price of editing all of them on
 *   every metric added; the trade was made on cost, not on principle, so if it
 *   ever stops looking right, write the names out.
 */
const REAL_BLOCK_COUNTS = {
  METRIC_EVENTS: 112,
  NET_SPANS: 3,
  ELECTRON_SPANS: 11,
  DB_SPANS: 3,
  METRIC_SPAN_OP: 17,
}
const REAL_TOTAL_NAMES = 129

/** Every member of NET_SPANS, listed rather than re-derived. */
const REAL_NET_SPANS = ['imap.idle', 'imap.sync', 'smtp.send']

/** Every member of DB_SPANS, listed rather than re-derived. */
const REAL_DB_SPANS = ['db.upsert_messages', 'db.reconcile_uids', 'db.search_messages']

/** Every member of ELECTRON_SPANS, listed rather than re-derived. */
const REAL_ELECTRON_SPANS = [
  'body_indexer.batch',
  'offline.replay',
  'search.fts',
  'net.message_details',
  'ai.chat',
  'ai.thread_summary.generate',
  'ai.quick_action.rewrite',
  'ai.instant_reply.generate',
  'ai.proofread.check',
  'ai.translate.message',
  'ai.translate.draft',
]

// Mutation killed: any parser that silently returns a subset — the exact defect
// of the deleted generator, which knew 14 of 29 event domains and dropped 60%
// of the schema while reporting success. Checked per block against literal
// counts, so a drop cannot hide inside a large total.
test('collectSchemaNames: the real schema yields exactly the expected number of names per block', () => {
  const src = realSchemaSource()
  for (const block of SCHEMA_BLOCKS) {
    const names = parseNameBlock(src, block.exportName, block.side)
    assert.equal(
      names.length,
      REAL_BLOCK_COUNTS[block.exportName],
      `${block.exportName}: expected ${REAL_BLOCK_COUNTS[block.exportName]} names, got ${names.length}. ` +
        `If you added or removed a metric, update REAL_BLOCK_COUNTS in this file.`,
    )
    assert.equal(new Set(names).size, names.length, `${block.exportName} must not repeat a name`)
  }
  const all = collectSchemaNames(src)
  assert.equal(all.length, REAL_TOTAL_NAMES, `expected ${REAL_TOTAL_NAMES} unique names, got ${all.length}`)
})

// Mutation killed: a parser that drops one entry in a commit that adds another,
// which the counts above cannot see (REAL_BLOCK_COUNTS says so in as many
// words). Naming the members closes that for the three span registries; the op
// map rides on the same literals, since every op equals its span name today.
test('collectSchemaNames: the span registries and the op map are pinned by name, not only by count', () => {
  const src = realSchemaSource()
  assert.deepEqual(parseNameBlock(src, 'NET_SPANS'), REAL_NET_SPANS)
  assert.deepEqual(parseNameBlock(src, 'DB_SPANS'), REAL_DB_SPANS)
  // METRIC_SPAN_OP maps every span name to a Sentry op, and today the mapping
  // is the identity — so the three literal lists ARE its expected values, at no
  // extra maintenance cost. The schema permits an op to diverge; when one does,
  // this assertion is what makes you write the divergent string down here and
  // disclose it on all six pages.
  assert.deepEqual(
    [...parseNameBlock(src, 'METRIC_SPAN_OP', 'values')].sort(),
    [...REAL_NET_SPANS, ...REAL_ELECTRON_SPANS, ...REAL_DB_SPANS].sort(),
  )
})

// Mutation killed: a block-selection bug that reads the wrong export (all four
// name blocks resolving to METRIC_EVENTS, say). The by-name test above already
// pins the three span registries against that; what is left, and what this test
// covers, is METRIC_EVENTS — whose oracle is a count, which a wrong export
// would move but which names nothing — plus the one block no assertion on the
// real schema can isolate.
//
// That block is METRIC_SPAN_OP: it contributes its VALUES, every one of which
// equals its key today, so on the real schema its contribution is
// indistinguishable from the names the span blocks already supplied. Its own
// case — a value that DIVERGES from its key, which is the case the block was
// included for — is therefore demonstrated on a synthetic schema, where the
// divergent string must arrive labelled as coming from METRIC_SPAN_OP. (Its
// end-to-end consequence is a separate test: 'CLI: an op value that diverges
// from its span name must be disclosed too'.)
test('collectSchemaNames: one known name from each of the four span/event blocks reaches the set, and a divergent op does too', () => {
  const set = new Set(collectSchemaNames(realSchemaSource()).map((e) => e.name))
  for (const expected of ['app.session_started', 'imap.idle', 'db.search_messages', 'ai.chat']) {
    assert.ok(set.has(expected), `missing ${expected} from the parsed registry`)
  }

  const collected = collectSchemaNames(
    makeSchema({
      spanOps: {
        'imap.idle': 'imap.idle',
        'body_indexer.batch': 'body_indexer.batch',
        'db.search_messages': 'db.search_grouped_op',
      },
    }),
  )
  const op = collected.find((e) => e.name === 'db.search_grouped_op')
  assert.ok(op, 'a METRIC_SPAN_OP value that diverges from its key must reach the collected set')
  assert.equal(op.exportName, 'METRIC_SPAN_OP')
  assert.equal(op.label, 'span op')
  // And an op equal to its key adds nothing of its own: the span block owns it.
  assert.equal(collected.find((e) => e.name === 'imap.idle').exportName, 'NET_SPANS')
})

// Mutation killed: dropping ELECTRON_SPANS from SCHEMA_BLOCKS again — and, since
// round 2, a parser that stably skips ONE member. Round 1 derived both sides of
// this comparison from `parseNameBlock`, so a parser that never saw
// `ai.instant_reply.generate` agreed with itself and passed.
test('ELECTRON_SPANS is checked, and its members are exactly the eleven listed here', () => {
  assert.ok(
    SCHEMA_BLOCKS.some((b) => b.exportName === 'ELECTRON_SPANS'),
    'ELECTRON_SPANS must be checked like NET_SPANS and DB_SPANS',
  )
  const src = realSchemaSource()
  assert.deepEqual(parseNameBlock(src, 'ELECTRON_SPANS'), REAL_ELECTRON_SPANS)
  const collected = new Set(collectSchemaNames(src).map((e) => e.name))
  for (const name of REAL_ELECTRON_SPANS) {
    assert.ok(collected.has(name), `ELECTRON_SPANS member '${name}' is not being checked`)
  }
})

// ============================================================================
// Unit: SUPPORTED_LANGUAGES is really the source of truth (round-2 finding 4)
// ============================================================================

// Mutation killed: going back to a hardcoded locale list in the guard. Round 1
// documented src/i18n/index.ts as the source of truth and then never opened it,
// so a language added to the product with no documentation directory was
// invisible — the guard only ever looked at directories that already existed.
test('parseSupportedLanguages: the real product language set is read from src/i18n/index.ts', () => {
  const src = readFileSync(path.join(ROOT, I18N_INDEX_RELPATH), 'utf8')
  const languages = parseSupportedLanguages(src)
  assert.deepEqual([...languages].sort(), ['de', 'en', 'es', 'fr', 'it', 'ru'])
  assert.deepEqual(docLocalesFrom(languages).sort(), ['de', 'es', 'fr', 'it', 'ru'])
})

// Mutation killed: falling back to a default list when the export is missing or
// unreadable — "no languages found, nothing to check" must never be a pass.
test('parseSupportedLanguages: an absent, non-array or non-literal export throws', () => {
  assert.throws(() => parseSupportedLanguages('export const OTHER = []'), /not found/)
  assert.throws(
    () => parseSupportedLanguages('export const SUPPORTED_LANGUAGES = buildLanguages()'),
    /not an array literal/,
  )
  assert.throws(
    () => parseSupportedLanguages("export const SUPPORTED_LANGUAGES = ['en', EXTRA_LANG] as const"),
    /non-literal entry/,
  )
  assert.throws(() => parseSupportedLanguages('export const SUPPORTED_LANGUAGES = [] as const'), /is empty/)
})

// Mutation killed: assuming the canonical page's language is whatever comes
// first — the guard has to know which language docs/docs serves, and a set
// without it is a set it cannot map onto files.
test("docLocalesFrom: a language set without 'en' throws rather than guessing", () => {
  assert.throws(() => docLocalesFrom(['ru', 'de']), /does not contain 'en'/)
  assert.deepEqual(docLocalesFrom(['en', 'ru', 'de']), ['ru', 'de'])
})

// Mutation killed: the same hardcoded-list mutation, proven end to end. A
// seventh language shipped in SUPPORTED_LANGUAGES with no docs/i18n directory
// must fail, naming that language.
test('CLI: a shipped language with no translated disclosure fails, naming it', () => {
  const res = checkTree({ languages: [...SYNTH_LANGUAGES, 'pt'] })
  assert.equal(res.status, 1, `stdout: ${res.stdout}`)
  assert.match(res.stderr, /docs\/i18n\/pt\//)
  assert.match(res.stderr, /'pt' translation/)
  assert.match(res.stderr, /fails closed/)
})

// Mutation control for the test above: the identical tree, minus 'pt' from the
// language list, passes — so the failure came from the language registry and
// not from something incidental about the fixture.
test('CLI: the same tree without that language in SUPPORTED_LANGUAGES passes', () => {
  const res = checkTree({ languages: SYNTH_LANGUAGES })
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
})

// Mutation killed: reading src/i18n/index.ts optionally (`catch { return DEFAULTS }`).
test('CLI: an unreadable src/i18n/index.ts fails closed', () => {
  const root = makeTree({})
  try {
    rmSync(path.join(root, I18N_INDEX_RELPATH), { force: true })
    const res = runCli(root)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /src\/i18n\/index\.ts/)
    assert.match(res.stderr, /ENOENT|no such file/i)
    assert.match(res.stderr, /fails closed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ============================================================================
// Unit: name matching is by equality with an entry, not by occurrence
// ============================================================================

/**
 * Round 3 matched a name against the row's raw text with a boundary check, and
 * that function is gone: an entry is compared with the name WHOLE. The property
 * the boundary check bought — "a longer documented name does not vouch for a
 * shorter one" — is kept below, now as a consequence of equality.
 */

// Mutation killed: comparing an entry with `entry.startsWith(name)` or
// `entry.includes(name)` instead of `entry === name`.
test('a documented name does not vouch for a shorter or longer neighbour', () => {
  const page = ['| Event | Purpose |', '| --- | --- |', '| `app.session_started` | once per launch |'].join('\n')
  const entries = listEntryNames(page)
  assert.deepEqual(entries, ['app.session_started'])
  for (const near of ['app.session_start', 'session_started', 'app.session_started2', 'app.session_started.v2']) {
    assert.equal(entries.includes(near), false, `${near} must not be vouched for`)
  }
})

// Mutation killed: `findMissing` comparing against the raw page text instead of
// the declared entries.
test('findMissing: a schema name that is a dotted prefix of another schema name is still checked independently', () => {
  const names = [
    { name: 'sync.folder', label: 'event', exportName: 'METRIC_EVENTS' },
    { name: 'sync.folder.details', label: 'event', exportName: 'METRIC_EVENTS' },
  ]
  const problems = findMissing(names, [
    { relPath: CANON_RELPATH, locale: null, entries: ['sync.folder.details'] },
  ])
  assert.equal(problems.length, 1)
  assert.equal(problems[0].name, 'sync.folder')
})

// ============================================================================
// Unit: the disclosure format — an entry, i.e. the name cell of a table row
// ============================================================================

/**
 * ── Rounds 3 and 4: what "disclosed" means, and why it narrowed twice ──────
 * Rounds 1 and 2 accepted arbitrary markup as disclosure and tried to subtract
 * the parts a reader cannot see, by modelling the renderer (code fences, inline
 * backtick runs, comment shapes). Each round closed one input and left the next
 * — a name hidden in a construct the model did not cover still counted. That
 * model, and every test that described ITS behaviour, is deleted.
 *
 * Round 3 replaced it with one shape rule — the name must stand in a table row —
 * and the tests below about paragraphs, headings, front matter, link targets and
 * expressions belong to it. They pass for that single reason: none of those
 * lines is shaped like a row. Nothing strips comments or front matter any more,
 * and no predicate in the guard has any notion of either (both words survive in
 * its prose and in the text it prints, where they name the constructs it stopped
 * modelling — nowhere in what it computes).
 *
 * Round 4 narrowed the unit from the LINE to the ENTRY, because the line was too
 * wide in the ordinary case: a row's later cells describe the row's own metric,
 * and the Tags column of the real pages already carries `provider`,
 * `folder_role`, `install_id_hash` and `ai.provider`. Matching the whole row let
 * any of those four be registered as a metric and disclosed nowhere. So a name
 * counts only as the whole content of a row's FIRST cell. Two consequences the
 * tests below pin, both reversals of round 3:
 *   - a name in a LATER cell no longer discloses (the Sentry-op column case);
 *   - a link, an expression or a comment written inside the NAME cell no longer
 *     discloses either — not because the guard models them, but because the cell
 *     then holds more than the name.
 *
 * The reason it covers is SHAPE, which is narrower than visibility, and these
 * tests claim no more than that. A construct nobody has invented yet is caught
 * only if it fails to look like an entry; a construct that DOES look like one —
 * a table drawn inside a comment, say — is counted, and the guard's header
 * explains why that stays out of scope rather than becoming round five.
 */

/** The property under test, stated once: does this page disclose that name? */
const discloses = (page, name) => listEntryNames(page).includes(name)

/**
 * A well-formed disclosure table. Every negative case below carries a control
 * name that MUST come back disclosed — this table in all but one of them, its
 * own body row in the header-row case, which has to draw its own table to put a
 * name in the caption. Either way the fixture is proven otherwise readable: a
 * page that disclosed NOTHING would satisfy the negative assertion for the
 * wrong reason.
 */
const CONTROL_TABLE = [
  '| Event | Purpose |',
  '| --- | --- |',
  '| `app.session_started` | once per launch |',
].join('\n')

// Mutation killed: returning the whole page instead of its rows (`text.split`
// dropped, or `tableRows` bypassed in readDisclosures). Every negative case
// below dies with that one mutation, which is exactly the property being
// bought: one rule, not a list of constructs.
test('tableRows: returns body rows verbatim, excluding the header and the delimiter', () => {
  const page = [
    '# Telemetry',
    '',
    '| Event | Purpose |',
    '| --- | --- |',
    '| `sync.folder` | once per folder |',
    '| `imap.idle` | per IDLE cycle |',
    '',
    'trailing prose',
  ].join('\n')
  assert.deepEqual(tableRows(page), [
    '| `sync.folder` | once per folder |',
    '| `imap.idle` | per IDLE cycle |',
  ])
})

// ── Negative cases: everything that is not a table row ─────────────────────

// Mutation killed: matching against the raw page. Under the round-2 scanner
// this passed because comments were stripped; it passes now because these
// commented lines are not row-shaped — the guard no longer knows what a comment
// is, which also means a comment containing a drawn table would count.
test('a name written as prose inside a comment is not disclosed', () => {
  const mdx = ['{/*', '  historic note about `sync.folder`', '*/}', '', CONTROL_TABLE].join('\n')
  assert.equal(discloses(mdx, 'sync.folder'), false)
  assert.equal(discloses(mdx, 'app.session_started'), true)

  const html = ['<!-- historic note about `sync.folder` -->', '', CONTROL_TABLE].join('\n')
  assert.equal(discloses(html, 'sync.folder'), false)
  assert.equal(discloses(html, 'app.session_started'), true)
})

// Mutation killed: matching against the raw page. A URL is not what the reader
// reads — the link text is — so a name that exists only in the target of a
// STANDALONE link is not a disclosure. The qualifier belongs in the sentence:
// under this rule a link sitting inside a table cell is part of that row, the
// row is matched as raw text, and a name present only in THAT target does
// count. The guard judges lines, not constructs; "a link target discloses
// nothing" would be false as stated. Round 2 counted the standalone case too:
// no construct in its model covered URLs.
test('a name only inside a standalone link target is not disclosed', () => {
  const page = [
    'See [the metric reference](https://example.com/metrics/sync.folder) for details.',
    '',
    CONTROL_TABLE,
  ].join('\n')
  assert.equal(discloses(page, 'sync.folder'), false)
  assert.equal(discloses(page, 'app.session_started'), true)
})

// Mutation killed: matching against the raw page (round 2 needed a dedicated
// front-matter scanner for this case; the rule covers it for free).
test('a name only in the front matter is not disclosed', () => {
  const page = [
    '---',
    'title: Telemetry',
    'description: covers `sync.folder`',
    '---',
    '',
    CONTROL_TABLE,
  ].join('\n')
  assert.equal(discloses(page, 'sync.folder'), false)
  assert.equal(discloses(page, 'app.session_started'), true)
})

// Mutation killed: matching against the raw page. An MDX expression is
// evaluated, not printed: what the reader sees is whatever it returns, which
// need not contain the name at all. No round-2 construct covered this. Same
// qualifier as the link case: an expression written INSIDE a row is part of that
// row's raw text and does count.
test('a name only inside a standalone expression is not disclosed', () => {
  const page = ['{METRIC_LABELS["sync.folder"]}', '', CONTROL_TABLE].join('\n')
  assert.equal(discloses(page, 'sync.folder'), false)
  assert.equal(discloses(page, 'app.session_started'), true)
})

// Mutation killed: matching against the raw page. This one is deliberate rather
// than incidental: prose ABOUT a metric is visible and honest, and still does
// not count, because the disclosure is the table and a reader scanning the
// tables would not find the name. The failure report says so in as many words.
test('a name described in a paragraph but absent from the tables is not disclosed', () => {
  const page = [
    'We also send `sync.folder` once per folder synchronization.',
    '',
    CONTROL_TABLE,
  ].join('\n')
  assert.equal(discloses(page, 'sync.folder'), false)
  assert.equal(discloses(page, 'app.session_started'), true)
})

// Mutation killed: dropping the "must stand below the delimiter row" condition,
// i.e. accepting any pipe-shaped line. The header row is a column caption, not
// an entry, so a name that reached only the caption discloses no metric.
test('a name only in a table header row is not disclosed', () => {
  const page = [
    '| `sync.folder` | Purpose |',
    '| --- | --- |',
    '| `app.session_started` | once per launch |',
  ].join('\n')
  assert.equal(discloses(page, 'sync.folder'), false)
  assert.equal(discloses(page, 'app.session_started'), true)
})

// Mutation killed: the same "drop the delimiter condition" mutation, from the
// other side — a pipe-shaped line belonging to no table at all. Markdown does
// not render it as a table either.
test('a pipe-shaped line that belongs to no table is not a row', () => {
  const page = ['| `sync.folder` | not a table |', '', CONTROL_TABLE].join('\n')
  assert.equal(discloses(page, 'sync.folder'), false)
  assert.equal(discloses(page, 'app.session_started'), true)
})

// ── Positive cases: the shapes the real pages actually use ─────────────────

// Mutation killed: comparing the name cell RAW, i.e. forgetting to unwrap the
// code span (turns the whole real tree red — all 112 names are backticked), or
// conversely requiring backticks (a plain name cell is an entry too, so the rule
// does not hang on a formatting habit). Padding is not part of the name either.
test('an entry counts with backticks and without, however it is padded', () => {
  const backticked = ['| Event | Purpose |', '| --- | --- |', '| `sync.folder` | why |'].join('\n')
  assert.equal(discloses(backticked, 'sync.folder'), true)

  const plain = ['| Event | Purpose |', '| --- | --- |', '| sync.folder | why |'].join('\n')
  assert.equal(discloses(plain, 'sync.folder'), true)

  const padded = ['| Event | Purpose |', '| --- | --- |', '|    `sync.folder`    | why |'].join('\n')
  assert.equal(discloses(padded, 'sync.folder'), true)

  const doubleTicks = ['| Event | Purpose |', '| --- | --- |', '| ``sync.folder`` | why |'].join('\n')
  assert.equal(discloses(doubleTicks, 'sync.folder'), true)
})

// Mutation killed: recognising the delimiter row as literal `---` only. An
// aligned table would then have no delimiter, so every one of its rows would
// read as a header and the page would go red for no reason.
test('an aligned table is still a table, and its rows still disclose', () => {
  const page = [
    '| Event | Kind | Purpose |',
    '| :--- | :---: | ---: |',
    '| `sync.folder` | event | why |',
  ].join('\n')
  assert.equal(discloses(page, 'sync.folder'), true)
})

// ── Round 4: the row is not the unit; its first cell is ────────────────────

// Mutation killed: the round-3 state itself — matching a name against the row's
// whole raw text. THE finding: the Tags column carries the attribute names of
// the row's own metric, so it must never vouch for a METRIC of that name. Under
// round 3 this fixture disclosed all four, and all four occur in the tags cells
// of the real pages today.
test('a name standing among other values in the tags cell is not an entry', () => {
  const page = [
    '| Event | Tags | Purpose |',
    '| --- | --- | --- |',
    '| `app.session_started` | `version`, `platform`, `install_id_hash` | once per launch |',
    '| `ai.chat` | `ai.provider`, `ai.model` | one AI request |',
    '| `sync.headers.coalesced` | `folder_role` | duplicate sync attached |',
    '| `imap.auth_refresh_attempt` | `provider` | token refresh |',
  ].join('\n')
  for (const attribute of ['install_id_hash', 'ai.provider', 'folder_role', 'provider']) {
    assert.equal(discloses(page, attribute), false, `${attribute} is an attribute here, not an entry`)
  }
  // Control: the four rows do disclose the metrics they are entries for, so the
  // fixture is readable and the negatives above are about the column, not the
  // table being broken.
  for (const metric of ['app.session_started', 'ai.chat', 'sync.headers.coalesced', 'imap.auth_refresh_attempt']) {
    assert.equal(discloses(page, metric), true)
  }
})

// Mutation killed: matching any cell instead of the first. `folder_role` and
// `provider` are the SOLE tag of several rows on all six real pages, so they
// fill a tags cell whole — a position-independent "the name is a whole cell"
// rule would leave the finding open. Only the name cell separates an entry from
// an attribute.
test('a name that fills the tags cell whole is still not an entry', () => {
  const page = [
    '| Event | Tags | Purpose |',
    '| --- | --- | --- |',
    '| `sync.headers.coalesced` | `folder_role` | duplicate sync attached |',
    '| `imap.auth_refresh_attempt` | `provider` | token refresh |',
  ].join('\n')
  assert.equal(discloses(page, 'folder_role'), false)
  assert.equal(discloses(page, 'provider'), false)
  assert.equal(discloses(page, 'sync.headers.coalesced'), true)
})

// Mutation killed: accepting any cell. Round 3 asserted the OPPOSITE of this
// ("a name in the last cell of a row is disclosed"), which is what made the tags
// column count. The consequence is deliberate and stated in the guard's header:
// when a METRIC_SPAN_OP value diverges from its span name, listing it in a
// "Sentry op" column will not disclose it — it needs a row of its own.
test('a name in a later cell — the Sentry-op column — is not an entry', () => {
  const page = [
    '| Span | Kind | Sentry op |',
    '| --- | --- | --- |',
    '| `imap.idle` | net span | `imap.idle_grouped` |',
  ].join('\n')
  assert.equal(discloses(page, 'imap.idle_grouped'), false)
  assert.equal(discloses(page, 'imap.idle'), true)
})

// Mutation killed: comparing the name cell with `includes` instead of with
// equality. A name cell holding MORE than the name is a description of an
// entry, not the entry — and this is not renderer modelling: the guard does not
// know what a link or an expression is, it only sees a cell whose content is
// not the name. (Round 3 asserted the opposite, since it matched raw row text.)
test('a name wrapped in a link, an expression or a comment inside the name cell is not an entry', () => {
  const page = [
    '| Event | Purpose |',
    '| --- | --- |',
    '| [reference](https://example.com/metrics/sync.folder) | link target in the name cell |',
    '| {METRIC_LABELS["imap.idle"]} | expression in the name cell |',
    '| `db.search_messages` <!-- keep --> | comment in the name cell |',
    '| **`smtp.send`** | bold in the name cell |',
    '| `app.session_started` | plain — the accepted form |',
  ].join('\n')
  for (const name of ['sync.folder', 'imap.idle', 'db.search_messages', 'smtp.send']) {
    assert.equal(discloses(page, name), false, `${name}: the cell holds more than the name`)
  }
  assert.equal(discloses(page, 'app.session_started'), true)
})

// Mutation killed: splitting a row on every '|' regardless of escaping. `\|` is
// the markdown escape for a literal pipe inside a cell; treating it as a cell
// boundary would cut the name cell short. Not a real disclosure shape — a guard
// against a FALSE RED, and the only piece of cell syntax the guard knows.
test('firstCellOf: an escaped pipe does not end the cell', () => {
  // Source string: | `a\|b` | second |   → the cell keeps the literal pipe.
  assert.equal(firstCellOf('| `a\\|b` | second |'), ' `a|b` ')
  assert.equal(firstCellOf('| `sync.folder` | second | third |'), ' `sync.folder` ')
  assert.equal(firstCellOf('||'), '')
})

// Mutation killed: requiring the row to start at column 0. Docusaurus renders
// an indented table as a table; a formatting change must not turn the gate red.
test('an indented table row still discloses', () => {
  const page = ['  | Event | Purpose |', '  | --- | --- |', '  | `sync.folder` | why |'].join('\n')
  assert.equal(discloses(page, 'sync.folder'), true)
})

// ============================================================================
// Unit: findMissing / formatReport / parseArgs
// ============================================================================

// Mutation killed: reporting only the count, or only the file, without the name.
test('formatReport: names the missing metric, its file, and what to do', () => {
  const names = [{ name: 'sync.folder', label: 'event', exportName: 'METRIC_EVENTS' }]
  const problems = findMissing(names, [
    { relPath: CANON_RELPATH, locale: null, entries: [] },
  ])
  assert.equal(problems.length, 1)
  const report = formatReport(problems, SYNTH_LOCALES)
  assert.match(report, /sync\.folder/)
  assert.match(report, /docs\/docs\/privacy\/telemetry\.md/)
  assert.match(report, /What to do/)
  assert.match(report, /HAND-WRITTEN/)
  // The locale list in the instructions is the one passed in, not a constant.
  assert.match(report, new RegExp(`all ${SYNTH_LOCALES.length} translations`))
  assert.match(report, new RegExp(SYNTH_LOCALES.join(', ')))
})

test('parseArgs: --root is extracted, unknown flags throw', () => {
  assert.deepEqual(parseArgs([]), { root: null })
  assert.deepEqual(parseArgs(['--root=/tmp/x']), { root: '/tmp/x' })
  assert.throws(() => parseArgs(['--force']), /unknown argument/)
})

// ============================================================================
// CLI: synthetic trees
// ============================================================================

// Mutation killed: `findMissing` returning [] — the guard's whole purpose.
test('CLI: a name absent from the canonical page fails with that exact name', () => {
  const res = checkTree({
    canonNames: ['app.session_started', 'imap.idle', 'body_indexer.batch', 'db.search_messages'],
  })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /sync\.folder/)
  assert.match(res.stderr, new RegExp(CANON_RELPATH.replace(/[./]/g, '\\$&')))
  assert.match(res.stderr, /canonical page/)
  assert.doesNotMatch(res.stderr, /- app\.session_started/)
})

// Mutation killed: keeping the whole page text in readDisclosures instead of its
// table rows — proven end to end, because the unit tests above could all pass
// while the CLI still matched against raw pages. Also the requirement that the
// failure EXPLAINS the rule: whoever documents a metric in a paragraph has to be
// able to tell from this message that a row is what is wanted, otherwise the
// gate reads as broken.
test('CLI: a page that describes every name in prose instead of a table fails, and says why', () => {
  const names = ['app.session_started', 'sync.folder', 'imap.idle', 'body_indexer.batch', 'db.search_messages']
  const prosePage = ['---', 'title: Telemetry', '---', '', '# Telemetry', '']
    .concat(names.map((n) => `We send \`${n}\` — here is why we collect it.`))
    .join('\n')
  const root = makeTree({})
  try {
    writeFileDeep(root, CANON_RELPATH, prosePage)
    const res = runCli(root)
    assert.equal(res.status, 1, `stdout: ${res.stdout}`)
    for (const name of names) assert.match(res.stderr, new RegExp(name.replace(/\./g, '\\.')))
    // The message states the rule, not just the missing names.
    assert.match(res.stderr, /TABLE ENTRY/)
    assert.match(res.stderr, /whole content of the\nFIRST cell of a table row/)
    assert.match(res.stderr, /give\nit a row of its own/)
    // The names ARE written on this page, just not as entries, and the report
    // has to say which of the two failures this is — "you forgot the metric" and
    // "you wrote it somewhere that does not disclose" need different fixes.
    assert.match(res.stderr, /only as a MENTION/)
    // And it flags that this file has no tables at all, which is the actual
    // diagnosis here — not "five names were forgotten".
    assert.match(res.stderr, /no table rows at all/)
    // The five translations are untouched and must not be dragged in.
    assert.doesNotMatch(res.stderr, /docs\/i18n\//)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Mutation killed: checking only the canonical page. This is the real-world
// failure shape — the English page is updated, the five translations are not.
test('CLI: a name documented in English but missing from one locale fails, naming that locale', () => {
  const full = [
    'app.session_started',
    'sync.folder',
    'imap.idle',
    'body_indexer.batch',
    'db.search_messages',
  ]
  const res = checkTree({
    canonNames: full,
    localeNames: { ru: full.filter((n) => n !== 'db.search_messages') },
  })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /db\.search_messages/)
  assert.match(res.stderr, /docs\/i18n\/ru\//)
  assert.match(res.stderr, /translation 'ru'/)
  assert.doesNotMatch(res.stderr, /docs\/i18n\/(de|es|fr|it)\//)
})

// ── The round-2 finding, proven end to end ─────────────────────────────────
// Mutation killed: any text-shaped entry parser. A NEW metric written in a style
// the round-1 regex did not recognise (double quotes here) was skipped in
// silence while the other entries kept the count non-zero — green check,
// undisclosed metric. It must now turn the CLI red and be named.
test('CLI: a new undisclosed entry written in a different style is caught, not skipped', () => {
  const schema = makeSchema().replace(
    "  'sync.folder': {",
    '  "brand.new_undisclosed": {\n    kind: \'event\',\n  },\n  \'sync.folder\': {',
  )
  const res = checkTree({ schema })
  assert.equal(res.status, 1, `expected the guard to catch the new entry, stdout: ${res.stdout}`)
  assert.match(res.stderr, /brand\.new_undisclosed/)
  assert.match(res.stderr, /METRIC_EVENTS/)
  assert.doesNotMatch(res.stderr, /- sync\.folder/)
})

// Mutation killed: reintroducing the `} as const satisfies` text search for the
// block end. An entry sitting after a comment that quotes the terminator went
// unchecked in round 1, again with no throw.
test('CLI: an undisclosed entry after a comment quoting the block terminator is still caught', () => {
  const schema = makeSchema().replace(
    "} as const satisfies Record<string, unknown>\n\nexport const NET_SPANS",
    "  // historic: this block used to end with `} as const satisfies X`\n" +
      "  'hidden.after_terminator_text': {\n    kind: 'event',\n  },\n" +
      '} as const satisfies Record<string, unknown>\n\nexport const NET_SPANS',
  )
  const res = checkTree({ schema })
  assert.equal(res.status, 1, `stdout: ${res.stdout}`)
  assert.match(res.stderr, /hidden\.after_terminator_text/)
})

// Mutation killed: reintroducing an indent-anchored parser. A wholesale reformat
// of the schema must be a no-op, not a failure and not a silent empty set.
test('CLI: a schema reformatted to a four-space indent still passes with the same names', () => {
  const reformatted = makeSchema().replace(/^ {2}(?=')/gm, '    ')
  const res = checkTree({ schema: reformatted })
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.match(res.stdout, /disclosure check OK — all 5 schema names stand as a table entry \(the whole first cell of a row\) in each of 6 files/)
})

// Mutation killed: `if (names.length === 0) return []` inside the extractor,
// checked end to end through the CLI's exit code.
test('CLI: an empty schema block fails instead of passing with nothing to check', () => {
  const res = checkTree({ schema: makeSchema({ events: [] }) })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /zero entries/)
  assert.match(res.stderr, /METRIC_EVENTS/)
})

// Mutation killed: only METRIC_EVENTS being wired to the zero-entries throw.
test('CLI: an empty NET_SPANS block fails, naming that export specifically', () => {
  const res = checkTree({ schema: makeSchema({ netSpans: [] }) })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /zero entries|not a string literal/)
  assert.match(res.stderr, /NET_SPANS|METRIC_SPAN_OP/)
})

test('CLI: an empty ELECTRON_SPANS block fails, naming that export specifically', () => {
  const res = checkTree({ schema: makeSchema({ electronSpans: [] }) })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /zero entries/)
  assert.match(res.stderr, /ELECTRON_SPANS/)
})

test('CLI: an empty DB_SPANS block fails, naming that export specifically', () => {
  const res = checkTree({ schema: makeSchema({ dbSpans: [] }) })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /zero entries/)
  assert.match(res.stderr, /DB_SPANS/)
})

// Mutation killed: tolerating an absent span registry (e.g. wrapping the
// extractor in try/catch and continuing). A rename now trips the accounting
// check first — the new export is unknown — so the message has to name BOTH
// sides, otherwise "we have never been told about RENAMED_SPANS" reads as a
// request to add a second entry rather than to edit the existing one.
test('CLI: a renamed span registry fails, naming the new export and the old entry', () => {
  const schema = makeSchema().replace('export const NET_SPANS = {', 'export const RENAMED_SPANS = {')
  const res = checkTree({ schema })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /RENAMED_SPANS/)
  assert.match(res.stderr, /NET_SPANS/)
  assert.match(res.stderr, /if that is a rename/)
})

// Mutation killed: dropping the `not found` throw in readNamesFromExport, which
// the rename case above no longer reaches. A block simply DELETED (not renamed)
// leaves nothing unaccounted, so this path is the only thing standing between a
// removed registry and a green run over the remaining blocks.
test('CLI: a schema whose NET_SPANS block was deleted outright fails with "not found"', () => {
  const full = makeSchema()
  const start = full.indexOf('export const NET_SPANS = {')
  const end = full.indexOf('export const ELECTRON_SPANS = {')
  const schema = full.slice(0, start) + full.slice(end)
  const res = checkTree({ schema })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /NET_SPANS/)
  assert.match(res.stderr, /not found/)
})

// Mutation killed: dropping the syntax-error check, proven through the CLI so a
// throw swallowed between the extractor and main() would still be caught.
test('CLI: a schema that does not parse fails instead of yielding a truncated set', () => {
  const schema = makeSchema().replace('} as const satisfies Record<string, unknown>\n\nexport const NET_SPANS', '\nexport const NET_SPANS')
  const res = checkTree({ schema })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /syntax error/)
})

// Mutation killed: `catch { text = '' }` around the disclosure read, or skipping
// unreadable files — a deleted translation would then pass green.
test('CLI: a missing locale disclosure file fails closed', () => {
  const res = checkTree({ skipLocales: ['fr'] })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /docs\/i18n\/fr\//)
  assert.match(res.stderr, /ENOENT/)
  assert.match(res.stderr, /fails closed/)
})

// Mutation killed: dropping the unknown-locale validation — a seventh language
// could ship documentation with no entry in the product's language registry.
test('CLI: a locale directory the product does not ship fails', () => {
  const res = checkTree({ extraLocales: ['pt'] })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /unknown locale\(s\)/)
  assert.match(res.stderr, /pt/)
  assert.match(res.stderr, /SUPPORTED_LANGUAGES/)
})

// Mutation killed: testing directory-ness with `dirent.isDirectory()` alone.
// That is false for a symlink, so a stray locale shipped as a link skipped the
// unknown-locale check entirely in round 1.
test('CLI: an unknown locale directory that is a SYMLINK is still caught', () => {
  const root = makeTree({})
  const target = mkdtempSync(path.join(tmpdir(), 'telemetry-docs-link-'))
  try {
    writeFileDeep(
      target,
      'docusaurus-plugin-content-docs/current/privacy/telemetry.md',
      makePage(['app.session_started']),
    )
    symlinkSync(target, path.join(root, I18N_RELPATH, 'pt'))
    const res = runCli(root)
    assert.equal(res.status, 1, `stdout: ${res.stdout}`)
    assert.match(res.stderr, /unknown locale\(s\)/)
    assert.match(res.stderr, /pt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

// Mutation killed: `catch { /* skip */ }` around the symlink resolution — a link
// the guard cannot follow is a locale it cannot classify.
test('CLI: a dangling symlink under docs/i18n fails closed', () => {
  const root = makeTree({})
  try {
    symlinkSync(path.join(root, 'does-not-exist'), path.join(root, I18N_RELPATH, 'pt'))
    const res = runCli(root)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /symlink that cannot be resolved/)
    assert.match(res.stderr, /fails closed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Mutation killed: reading the i18n root optionally — if docs/i18n disappeared
// (a bad move/rename), "no locales to check" must not read as success.
test('CLI: an absent docs/i18n root fails closed', () => {
  const root = makeTree({})
  try {
    rmSync(path.join(root, I18N_RELPATH), { recursive: true, force: true })
    const res = runCli(root)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /cannot read docs\/i18n/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Mutation killed: `readFile(schema).catch(() => '')` or any swallowing of the
// schema read.
test('CLI: a missing schema file fails closed with an operational message', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'telemetry-docs-'))
  try {
    writeFileDeep(root, I18N_INDEX_RELPATH, makeI18nIndex())
    writeFileDeep(root, CANON_RELPATH, makePage([]))
    for (const locale of SYNTH_LOCALES) writeFileDeep(root, localeDisclosureRelpath(locale), makePage([]))
    const res = runCli(root)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /electron\/metricsSchema\.ts/)
    assert.match(res.stderr, /ENOENT|no such file/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Mutation killed: treating any read failure other than ENOENT as "file does
// not exist, skip".
test('CLI: the canonical page existing as a directory (unreadable as a file) fails closed', () => {
  const root = makeTree({})
  try {
    rmSync(path.join(root, CANON_RELPATH), { force: true })
    mkdirSync(path.join(root, CANON_RELPATH))
    const res = runCli(root)
    assert.equal(res.status, 1)
    assert.match(res.stderr, new RegExp(CANON_RELPATH.replace(/[./]/g, '\\$&')))
    assert.match(res.stderr, /canonical/)
    assert.match(res.stderr, /fails closed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Mutation killed: wiring ELECTRON_SPANS into the canonical check only.
test('an ELECTRON_SPANS name missing from a single translation fails, naming that locale', () => {
  const full = [
    'app.session_started',
    'sync.folder',
    'imap.idle',
    'body_indexer.batch',
    'db.search_messages',
  ]
  const res = checkTree({
    canonNames: full,
    localeNames: { de: full.filter((n) => n !== 'body_indexer.batch') },
  })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /body_indexer\.batch/)
  assert.match(res.stderr, /docs\/i18n\/de\//)
  assert.doesNotMatch(res.stderr, /docs\/i18n\/(es|fr|it|ru)\//)
})

// Mutation killed: dropping ELECTRON_SPANS from SCHEMA_BLOCKS — proven by
// consequence rather than by structure.
test('a new ELECTRON_SPANS-only name that is disclosed nowhere fails the guard', () => {
  const schema = makeSchema({
    electronSpans: ['body_indexer.batch', 'electron.totally_undisclosed_span'],
  })
  const res = checkTree({ schema })
  assert.equal(res.status, 1, `expected the guard to catch an undisclosed span, stdout: ${res.stdout}`)
  assert.match(res.stderr, /electron\.totally_undisclosed_span/)
  assert.match(res.stderr, /ELECTRON_SPANS/)
  assert.match(res.stderr, /electron span/)
  assert.doesNotMatch(res.stderr, /- body_indexer\.batch/)
})

// ============================================================================
// CLI: the round-4 finding, end to end
// ============================================================================

/**
 * The four names the security review built its examples from. Each is a real
 * TAG on the real pages, in the tags cell of some metric's row; none of them is
 * a metric. Under round 3 — which matched a name against the row's whole raw
 * text — registering a metric under any of them and describing it on no page
 * left the check green.
 */
const TAG_NAMES_THAT_ARE_NOT_METRICS = ['ai.provider', 'provider', 'folder_role', 'install_id_hash']

// Mutation killed: any belief that those four are hypothetical. This reads the
// real canonical page: each of them occurs in it, and none of them is an entry.
// If a future edit gives one of them a row of its own, this test says so — and
// the CLI test below would then be testing nothing.
test('the four reviewer examples really do stand in the pages, and really are not entries', () => {
  const canon = readFileSync(path.join(ROOT, CANON_RELPATH), 'utf8')
  const entries = listEntryNames(canon)
  assert.equal(entries.length, REAL_TOTAL_NAMES)
  for (const name of TAG_NAMES_THAT_ARE_NOT_METRICS) {
    assert.ok(canon.includes(name), `${name} was expected to occur in the canonical page`)
    assert.equal(entries.includes(name), false, `${name} must not be an entry of the canonical page`)
  }
})

// Mutation killed: THE round-4 finding, proven by consequence. Each example is
// registered as a metric and described on no page, while every page carries all
// four in its tags column exactly as the real pages do. Round 3 passed all four;
// each must now be red, be named, and be reported as a mention rather than as a
// name nobody wrote down.
for (const name of TAG_NAMES_THAT_ARE_NOT_METRICS) {
  test(`CLI: a metric named '${name}' — a name the tags column already carries — must be red when undisclosed`, () => {
    const res = checkTree({
      schema: makeSchema({ events: ['app.session_started', 'sync.folder', name] }),
      tags: TAG_NAMES_THAT_ARE_NOT_METRICS,
    })
    assert.equal(res.status, 1, `stdout: ${res.stdout}`)
    assert.match(res.stderr, new RegExp(`- ${name.replace(/\./g, '\\.')}\\b`))
    assert.match(res.stderr, /only as a MENTION/)
    assert.match(res.stderr, /Tags column/)
    // The metrics that DO have entries are not dragged into the complaint.
    assert.doesNotMatch(res.stderr, /- app\.session_started/)
    assert.doesNotMatch(res.stderr, /- sync\.folder/)
  })
}

// Mutation control for the four tests above: the same tree, same tags column,
// with the extra metric removed — green. So the red came from the undisclosed
// metric and not from the tags column being present at all.
test('CLI: the same pages with a tags column and no extra metric stay green', () => {
  const res = checkTree({ tags: TAG_NAMES_THAT_ARE_NOT_METRICS })
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
})

// Mutation killed: reporting every miss identically. A name written NOWHERE in
// the file must not be labelled a mention — that label is what tells the reader
// their tags cell did not count.
test('CLI: a name absent from the file entirely is not reported as a mention', () => {
  const res = checkTree({
    schema: makeSchema({ events: ['app.session_started', 'sync.folder', 'brand.new_metric'] }),
    tags: TAG_NAMES_THAT_ARE_NOT_METRICS,
  })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /- brand\.new_metric  \(event, METRIC_EVENTS\)$/m)
  assert.doesNotMatch(res.stderr, /only as a MENTION/)
})

// ============================================================================
// CLI: the real repository tree
// ============================================================================

// Mutation killed: wrong disclosure paths, a wrong locale source, or an
// over-eager matcher — any of which turns the real, complete tree red. Also the
// regression test for the state this task established: every one of the schema's
// names currently stands as an entry — the whole first cell of a row — on all
// six pages, and it must stay so.
test('CLI: the real tree passes — every schema name stands as an entry in all six files', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' })
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.match(res.stdout, /disclosure check OK/)
  assert.match(res.stdout, new RegExp(`all ${REAL_TOTAL_NAMES} schema names stand as a table entry \\(the whole first cell of a row\\) in each of 6 files`))
})
