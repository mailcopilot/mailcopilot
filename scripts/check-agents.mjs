#!/usr/bin/env node
// Static analyzer for .claude/agents/*.md subagent definitions.
//
// Inspired by wshobson/agents plugins/plugin-eval/src/plugin_eval/layers/
// static.py — detects anti-patterns that frequently break our agents in
// practice. We intentionally keep this tool Node-native (no Python/uv
// dependency) and scoped to the real failures we've seen in our own
// sessions:
//
//   - OVER_CONSTRAINED: >15 MUST/NEVER/ALWAYS in a single agent prompt,
//     which correlates with agents ignoring their own rules (our pre-pr-gate
//     was the worst offender before the refactor).
//   - EMPTY_DESCRIPTION: <40 chars description field, or missing altogether.
//     Descriptions <40 chars never contain enough trigger context.
//   - MISSING_TRIGGER: description lacks an "Use" / "Use PROACTIVELY" /
//     "Use when" / "Используй" opener — Claude's routing reads descriptions
//     as instructions.
//   - EMPTY_TOOLS: agent has no `tools:` line in frontmatter at all.
//   - WRITE_WITHOUT_EDIT: declares `Write` in tools but no `Edit`. This is
//     a real footgun: without Edit, agents fall back to full-file Write or
//     python heredoc hacks (observed in session 37e5a2b6).
//   - READ_ONLY_WITH_WRITE: description says "read-only" / "never edits" /
//     "только читает" but tools list includes Write or Edit.
//   - MODEL_MISMATCH: `model:` field missing or refers to a known-obsolete
//     name (claude-3-*, claude-2).
//   - DEAD_CROSS_REF: mentions another agent name like `pre-pr-gate`,
//     `mail-sync`, `db-search`, `renderer-ui`, `electron-boundary`,
//     `ai-mcp`, `i18n-completeness`, `security-reviewer`, `pm` that does
//     not exist in the current .claude/agents/ directory.
//
// Exit codes:
//   0 — all agents pass (no CRITICAL issues).
//   1 — at least one agent has a CRITICAL issue. CI blocks merge.
//
// WARNING-level issues do not block CI but are reported.

import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const AGENTS_DIR = '.claude/agents'
const MAX_RULES = 15
const MIN_DESCRIPTION_CHARS = 40

// Severity constants
const CRITICAL = 'CRITICAL'
const WARNING = 'WARNING'
const INFO = 'INFO'

// Known obsolete model names. Extend as new model releases deprecate older.
const OBSOLETE_MODELS = new Set([
  'claude-2',
  'claude-2.0',
  'claude-2.1',
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
])

// Current known model families (prefix match — version digits after the
// prefix are accepted). Extend when new models ship.
// Canonical aliases (`fable`, `opus`, `sonnet`, `haiku`) are the recommended
// form — they auto-resolve to the latest release of the family (`inherit`
// takes the parent's model). Explicit pinned IDs (`claude-opus-4-7` etc.) are
// also accepted for cases where a specific version must be locked; IDs
// without a version suffix (`claude-fable-5`) live in KNOWN_MODEL_IDS.
const KNOWN_MODEL_PREFIXES = [
  'claude-opus-4-',
  'claude-sonnet-4-',
  'claude-haiku-4-',
]
const KNOWN_MODEL_IDS = new Set([
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
])
const KNOWN_MODEL_ALIASES = new Set([
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'inherit',
])

// English and Russian trigger words that indicate the description is written
// as routing text rather than a passive noun phrase.
const TRIGGER_WORDS = [
  /^use\s+proactively\b/i,
  /^use\s+when\b/i,
  /^use\s+(for|to)\b/i,
  /^используй\s+/i,
  /^вызывай\s+/i,
  /^применяй\s+/i,
]

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) {
    return { ok: false, error: 'missing frontmatter opener `---`' }
  }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) {
    return { ok: false, error: 'missing frontmatter closer `---`' }
  }
  const block = raw.slice(4, end)
  const body = raw.slice(end + 5)
  const fm = {}
  for (const line of block.split('\n')) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    fm[m[1]] = m[2].trim()
  }
  return { ok: true, frontmatter: fm, body }
}

function countRuleMarkers(body) {
  // Case-insensitive count of MUST, NEVER, ALWAYS, REQUIRED as standalone
  // words (also capitalized like MUST/Must/must). wshobson treats these
  // collectively as "directive markers" — more than 15 in one prompt is a
  // code smell.
  let count = 0
  const pattern = /\b(MUST|NEVER|ALWAYS|REQUIRED|ЗАПРЕЩЕНО|ОБЯЗАТЕЛЬНО|ВСЕГДА|НИКОГДА)\b/g
  const matches = body.match(pattern)
  if (matches) count = matches.length
  return count
}

function checkAgent(file, raw, knownAgentNames) {
  const issues = []
  const result = parseFrontmatter(raw)
  if (!result.ok) {
    issues.push({ severity: CRITICAL, code: 'FRONTMATTER_BROKEN', message: result.error })
    return issues
  }
  const { frontmatter: fm, body } = result

  // --- description checks ---
  const desc = fm.description || ''
  if (desc.length === 0) {
    issues.push({ severity: CRITICAL, code: 'EMPTY_DESCRIPTION', message: 'description field is empty' })
  } else if (desc.length < MIN_DESCRIPTION_CHARS) {
    issues.push({
      severity: WARNING,
      code: 'SHORT_DESCRIPTION',
      message: `description is ${desc.length} chars (<${MIN_DESCRIPTION_CHARS}); unlikely to contain trigger context`,
    })
  }
  const hasTrigger = TRIGGER_WORDS.some((re) => re.test(desc))
  if (!hasTrigger && desc.length > 0) {
    issues.push({
      severity: CRITICAL,
      code: 'MISSING_TRIGGER',
      message: 'description lacks a trigger word (Use/Use PROACTIVELY/Use when/Используй) — Claude routing may never auto-invoke',
    })
  }

  // --- tools checks ---
  const toolsRaw = fm.tools || ''
  const tools = toolsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  if (tools.length === 0) {
    issues.push({ severity: CRITICAL, code: 'EMPTY_TOOLS', message: 'tools field is missing or empty' })
  } else {
    const hasWrite = tools.includes('Write')
    const hasEdit = tools.includes('Edit')
    // Opt-out: agents that only ever do full-file overwrites (e.g. report
    // generators like code-health-scanner) set `writeMode: overwrite-only`
    // in frontmatter to silence WRITE_WITHOUT_EDIT. The prompt body is still
    // expected to forbid incremental edits explicitly.
    const overwriteOnly = fm.writeMode === 'overwrite-only'
    if (hasWrite && !hasEdit && !overwriteOnly) {
      issues.push({
        severity: CRITICAL,
        code: 'WRITE_WITHOUT_EDIT',
        message: 'agent has Write but no Edit — will fall back to full-file rewrites or python heredoc hacks for targeted patches. If this agent only overwrites full files, add `writeMode: overwrite-only` to frontmatter.',
      })
    }

    const descLower = desc.toLowerCase()
    const bodyLower = body.toLowerCase()
    const claimsReadOnly =
      /\bread[- ]?only\b/.test(descLower) ||
      /\bnever edits?\b/.test(descLower) ||
      /только читаешь/.test(body) ||
      /только читает/.test(body) ||
      /никогда не редактируешь/.test(bodyLower)
    if (claimsReadOnly && (hasWrite || hasEdit)) {
      issues.push({
        severity: CRITICAL,
        code: 'READ_ONLY_WITH_WRITE',
        message: `agent claims read-only but tools include ${[hasWrite && 'Write', hasEdit && 'Edit'].filter(Boolean).join(', ')}`,
      })
    }
  }

  // --- model check ---
  const model = fm.model || ''
  if (model.length === 0) {
    issues.push({
      severity: WARNING,
      code: 'MODEL_MISSING',
      message: 'no model: field — agent will inherit from parent, which is usually but not always what you want',
    })
  } else if (OBSOLETE_MODELS.has(model)) {
    issues.push({
      severity: CRITICAL,
      code: 'MODEL_OBSOLETE',
      message: `model '${model}' is obsolete — use a canonical alias (fable/opus/sonnet/haiku) or a pinned ID (claude-fable-5, claude-opus-4-x, claude-sonnet-4-x, claude-haiku-4-x)`,
    })
  } else if (
    !KNOWN_MODEL_ALIASES.has(model) &&
    !KNOWN_MODEL_IDS.has(model) &&
    !KNOWN_MODEL_PREFIXES.some((p) => model.startsWith(p))
  ) {
    issues.push({
      severity: WARNING,
      code: 'MODEL_UNKNOWN',
      message: `model '${model}' is not recognized — use canonical alias (fable/opus/sonnet/haiku/inherit) or pinned ID (claude-fable-5, claude-opus-4-*, claude-sonnet-4-*, claude-haiku-4-*)`,
    })
  }

  // --- rule marker count ---
  const ruleCount = countRuleMarkers(body)
  if (ruleCount > MAX_RULES) {
    issues.push({
      severity: WARNING,
      code: 'OVER_CONSTRAINED',
      message: `${ruleCount} MUST/NEVER/ALWAYS/REQUIRED markers (>${MAX_RULES}) — agents under too many absolute rules tend to violate them`,
    })
  }

  // --- dead cross-references ---
  for (const name of knownAgentNames) {
    // We don't check self-references.
    if (name === fm.name) continue
  }
  // Find all cross-references of form `<agent-name>` (backticked or word).
  // We look for bare words that match any .md file in .claude/agents/ — if
  // we see something that LOOKS like an agent name (kebab-case identifier
  // ending in common agent suffixes) but isn't in the set, flag.
  const referencedAgents = new Set()
  const agentRefRe = /`([a-z][a-z0-9-]+)`/g
  let m
  while ((m = agentRefRe.exec(body)) !== null) {
    const ref = m[1]
    if (/^[a-z]+(-[a-z]+)+$/.test(ref) || knownAgentNames.has(ref)) {
      referencedAgents.add(ref)
    }
  }
  for (const ref of referencedAgents) {
    // Only flag if it looks like an intended agent reference (has hyphen
    // and could plausibly be an agent name) and isn't in the known set.
    const looksLikeAgent = /^[a-z]+(-[a-z]+)+$/.test(ref)
    const isKnown = knownAgentNames.has(ref)
    // Skip common domain words that are hyphenated but not agent names.
    const commonNonAgents = new Set([
      'send-queue',
      'offline-replay',
      'better-sqlite3',
      'pre-pr-gate',
      'merge-gate',
      'touch-area',
      'pre-pr',
      'e2e-bg',
    ])
    if (looksLikeAgent && !isKnown && !commonNonAgents.has(ref)) {
      // Only flag if it has the distinctive shape of an agent name (noun-noun).
      // Example: `old-agent-name` in a body after renaming.
      // We don't want to false-positive on ordinary prose; require at least
      // one of: ends with `-agent`, contains `-reviewer`, contains `-sync`,
      // contains `-boundary`, contains `-mcp`, or matches our naming convention.
      if (/-(agent|reviewer|sync|boundary|mcp|gate|completeness|ui|search)$/.test(ref)) {
        issues.push({
          severity: WARNING,
          code: 'DEAD_CROSS_REF',
          message: `references agent \`${ref}\` which does not exist in ${AGENTS_DIR}/`,
        })
      }
    }
  }

  return issues
}

function main() {
  let files
  try {
    files = readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => !f.startsWith('_')) // `_foo.md` = shared non-agent docs (e.g. _shared-output-contract.md)
      .sort()
  } catch (err) {
    // A missing directory is not a failure: `.claude/` is internal-only tooling
    // and is stripped from the published source mirror, where this script still
    // has to exit 0 so `npm run check:agents` does not break for outside
    // contributors. Any OTHER error (unreadable directory, EACCES, EIO) still
    // aborts with exit 2 — "cannot read" must never be mistaken for "clean".
    if (err.code === 'ENOENT') {
      console.log(`check-agents: ${AGENTS_DIR} not present — nothing to check.`)
      process.exit(0)
    }
    console.error(`ERROR: cannot read ${AGENTS_DIR}: ${err.message}`)
    process.exit(2)
  }

  if (files.length === 0) {
    console.error(`ERROR: no .md files in ${AGENTS_DIR}`)
    process.exit(2)
  }

  // First pass: collect all agent names for cross-ref resolution.
  const agentNames = new Set()
  const fileContents = new Map()
  for (const f of files) {
    const path = join(AGENTS_DIR, f)
    const raw = readFileSync(path, 'utf8')
    fileContents.set(f, raw)
    const fm = parseFrontmatter(raw)
    if (fm.ok && fm.frontmatter.name) {
      agentNames.add(fm.frontmatter.name)
    }
  }

  // Second pass: check each agent.
  const report = []
  let critical = 0
  let warning = 0
  let info = 0
  for (const f of files) {
    const raw = fileContents.get(f)
    const issues = checkAgent(f, raw, agentNames)
    for (const issue of issues) {
      report.push({ file: f, ...issue })
      if (issue.severity === CRITICAL) critical++
      else if (issue.severity === WARNING) warning++
      else info++
    }
  }

  // Report.
  console.log(`check-agents: scanned ${files.length} agent files in ${AGENTS_DIR}\n`)

  if (report.length === 0) {
    console.log('ALL CLEAR — no issues found.')
    process.exit(0)
  }

  // Group by severity for readability.
  for (const sev of [CRITICAL, WARNING, INFO]) {
    const group = report.filter((r) => r.severity === sev)
    if (group.length === 0) continue
    console.log(`## ${sev} (${group.length})\n`)
    for (const r of group) {
      console.log(`  ${r.file} [${r.code}]`)
      console.log(`    ${r.message}`)
    }
    console.log()
  }

  console.log(`Summary: ${critical} CRITICAL, ${warning} WARNING, ${info} INFO`)

  if (critical > 0) {
    console.log('\nCI FAIL: CRITICAL issues must be fixed before merge.')
    process.exit(1)
  }
  process.exit(0)
}

main()
