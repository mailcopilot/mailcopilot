import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

// §2.297 — official builds must not connect NEW mailboxes through Google
// sign-in (Google's lifetime cap on new users cannot be reset). The switch is
// the build variable MAILCOPILOT_OFFICIAL_BUILD, read by vite.config.ts. A
// self-build leaves it unset and keeps the sign-in, so the failure to guard
// against is the opposite one: a release path that silently loses the line and
// ships a build with the sign-in open. The built bundle cannot be inspected
// for the flag after `define` has folded it, so the wiring is pinned here, on
// every path that produces a release artifact.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')

describe('official build flag (§2.297)', () => {
  for (const job of ['build-linux', 'build-windows', 'build-macos']) {
    test(`release.yml ${job} sets it at job level, where the build step reads it`, () => {
      const doc = yaml.load(read('.github', 'workflows', 'release.yml'))
      assert.equal(String(doc.jobs[job].env.MAILCOPILOT_OFFICIAL_BUILD), '1')
    })
  }

  test('vite.config.ts folds it into __GOOGLE_NEW_MAILBOXES__ and defaults to open', () => {
    const src = read('vite.config.ts')
    const line = src.split('\n').find((l) => l.includes('__GOOGLE_NEW_MAILBOXES__:'))
    assert.ok(line, 'define entry missing')
    // The parser is shared with the refusal; the line must not re-read the
    // variable on its own. Production bundles enforce the release-tag check.
    assert.ok(line.includes('resolveNewGoogleMailboxes(process.env'), 'must use the shared resolver')
    assert.ok(line.includes("enforceRelease: mode === 'production'"), 'must enforce the release check for production bundles')
    assert.ok(!line.includes('process.env.MAILCOPILOT_OFFICIAL_BUILD'), 'must not read the variable directly')
  })
})
