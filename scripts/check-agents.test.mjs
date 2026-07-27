#!/usr/bin/env node
/**
 * Tests for scripts/check-agents.mjs.
 *
 * check-agents.mjs has no exported functions and calls `main()` unconditionally
 * at module load (no `invokedDirectly` guard like the other check-*.mjs
 * scripts), so it cannot be imported and driven in-process — every test here
 * runs it as a real subprocess (`spawnSync`) with a controlled `cwd`, since
 * `AGENTS_DIR` is the relative path `.claude/agents` resolved against the
 * process cwd, not against the script's own location.
 *
 * Primary focus: the ENOENT carve-out added for open-source readiness (§2.58).
 * `.claude/agents` is stripped from the public GitHub mirror, so
 * `npm run check:agents` must exit 0 for outside contributors who cloned the
 * mirror and never had that directory in the first place — while any OTHER
 * `readdirSync` failure (not "does not exist") must still abort loudly with
 * exit 2, exactly as before this change. Losing that distinction would let a
 * genuine "cannot read the directory" failure (permissions, I/O error) pass
 * silently as if the directory were merely absent.
 *
 * Run:
 *   node --test scripts/check-agents.test.mjs
 *   npm run test:scripts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(SCRIPTS_DIR, 'check-agents.mjs')

/** Runs check-agents.mjs as a subprocess with the given cwd. */
function run(cwd) {
  return spawnSync(process.execPath, [SCRIPT_PATH], { cwd, encoding: 'utf8' })
}

/** A minimal agent frontmatter that passes every CRITICAL and WARNING check. */
const VALID_AGENT = `---
name: sample-agent
description: Use when validating check-agents regression coverage for the mirror export guard test suite.
tools: Read, Edit
model: sonnet
---

Sample agent body with no directive markers to keep the rule count low.
`

test('check-agents: exits 0 when .claude/agents is entirely absent (ENOENT)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'check-agents-enoent-'))
  try {
    // No .claude directory at all — the exact shape of a cloned public mirror,
    // where .claude/ is stripped by scripts/mirror-exclude.list.
    const res = run(tmp)
    assert.equal(res.status, 0, `expected exit 0 on missing dir; got ${res.status}\n${res.stdout}${res.stderr}`)
    assert.match(res.stdout, /not present.*nothing to check/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('check-agents: exits 2 (not 0) when the directory is unreadable for a reason other than ENOENT', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'check-agents-enotdir-'))
  try {
    // .claude/agents exists as a plain FILE, not a directory: readdirSync throws
    // ENOTDIR, not ENOENT. This is the regression guard for the ENOENT carve-out
    // — a real "cannot read" failure must never be swallowed as "absent".
    mkdirSync(path.join(tmp, '.claude'), { recursive: true })
    writeFileSync(path.join(tmp, '.claude/agents'), 'not a directory\n')

    const res = run(tmp)
    assert.equal(res.status, 2, `expected exit 2 on a non-ENOENT read failure; got ${res.status}\n${res.stdout}${res.stderr}`)
    assert.match(res.stderr, /cannot read .claude\/agents/)
    assert.doesNotMatch(res.stdout, /nothing to check/i, 'must not be reported as the ENOENT carve-out path')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('check-agents: exits 2 when the directory exists but has no .md agent files', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'check-agents-empty-'))
  try {
    // Only a non-.md file and an underscore-prefixed shared doc — both filtered
    // out before the `files.length === 0` check.
    mkdirSync(path.join(tmp, '.claude/agents'), { recursive: true })
    writeFileSync(path.join(tmp, '.claude/agents/notes.txt'), 'not an agent\n')
    writeFileSync(path.join(tmp, '.claude/agents/_shared-output-contract.md'), '# shared\n')

    const res = run(tmp)
    assert.equal(res.status, 2, `expected exit 2 on empty agents dir; got ${res.status}\n${res.stdout}${res.stderr}`)
    assert.match(res.stderr, /no \.md files/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('check-agents: exits 0 (ALL CLEAR) for a single well-formed agent', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'check-agents-valid-'))
  try {
    mkdirSync(path.join(tmp, '.claude/agents'), { recursive: true })
    writeFileSync(path.join(tmp, '.claude/agents/sample-agent.md'), VALID_AGENT)

    const res = run(tmp)
    assert.equal(res.status, 0, `expected exit 0 for a clean agent; got ${res.status}\n${res.stdout}${res.stderr}`)
    assert.match(res.stdout, /ALL CLEAR/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('check-agents: exits 1 when an agent has a CRITICAL issue (empty description)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'check-agents-critical-'))
  try {
    const broken = VALID_AGENT.replace(
      /description: .*/,
      'description:',
    )
    mkdirSync(path.join(tmp, '.claude/agents'), { recursive: true })
    writeFileSync(path.join(tmp, '.claude/agents/sample-agent.md'), broken)

    const res = run(tmp)
    assert.equal(res.status, 1, `expected exit 1 on a CRITICAL issue; got ${res.status}\n${res.stdout}${res.stderr}`)
    assert.match(res.stdout, /EMPTY_DESCRIPTION/)
    assert.match(res.stdout, /CI FAIL/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
