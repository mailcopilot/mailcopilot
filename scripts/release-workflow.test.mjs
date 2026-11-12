/**
 * Contract tests for .github/workflows/release.yml.
 *
 * The `prepare` job decides whether a run is a dry run, a release to build, or an
 * already-published release to leave alone; everything that can publish hangs off
 * its outputs. The decision is tested by evaluating the workflow's own DRY_RUN
 * expression and executing the real `decide` step script (with a fake `gh`), so a
 * change to either is seen here. The permission and gating structure is pinned
 * because it is what keeps a rehearsal from creating a release and keeps secrets
 * out of the publishing job.
 *
 * Run: node --test scripts/release-workflow.test.mjs (or npm run test:scripts).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'release.yml')
const text = readFileSync(WORKFLOW_PATH, 'utf8')
const workflow = yaml.load(text)
const decide = workflow.jobs.prepare.steps.find((s) => s.id === 'decide')
const EXPR_RE = /^\$\{\{([\s\S]*)\}\}$/

/** Evaluates a `${{ ... }}` expression made of ==, &&, ||, string literals and context lookups. */
function evaluate(expression, github, inputs) {
  const m = EXPR_RE.exec(String(expression).trim())
  assert.ok(m, `not a single expression: ${expression}`)
  // The workflow's expression language and JS agree on ==, &&, || and single-quoted strings.
  // eslint-disable-next-line no-new-func
  return new Function('github', 'inputs', `return (${m[1]})`)(github, inputs)
}

const EVENTS = {
  'push of a stable tag': [{ event_name: 'push', ref_type: 'tag', ref_name: 'v1.2.3' }, {}, 'false'],
  'push to a rehearsal branch': [{ event_name: 'push', ref_type: 'branch', ref_name: 'release-rehearsal/abc123def456' }, {}, 'true'],
  'dispatch with dry_run on (the default)': [{ event_name: 'workflow_dispatch', ref_type: 'branch', ref_name: 'develop' }, { dry_run: true }, 'true'],
  'dispatch with dry_run on a tag': [{ event_name: 'workflow_dispatch', ref_type: 'tag', ref_name: 'v1.2.3' }, { dry_run: true }, 'true'],
  'dispatch with dry_run off on a tag': [{ event_name: 'workflow_dispatch', ref_type: 'tag', ref_name: 'v1.2.3' }, { dry_run: false }, 'false'],
  'dispatch with dry_run off on a branch': [{ event_name: 'workflow_dispatch', ref_type: 'branch', ref_name: 'main' }, { dry_run: false }, 'false'],
}

describe('DRY_RUN expression of the prepare job', () => {
  for (const [name, [github, inputs, expected]] of Object.entries(EVENTS)) {
    test(`${name}: DRY_RUN=${expected}`, () => {
      assert.equal(evaluate(decide.env.DRY_RUN, github, inputs), expected)
    })
  }

  test('a branch push is a dry run whatever the branch is called', () => {
    for (const ref_name of ['main', 'develop', 'release-rehearsal/x', 'v1.2.3']) {
      assert.equal(evaluate(decide.env.DRY_RUN, { event_name: 'push', ref_type: 'branch', ref_name }, {}), 'true', ref_name)
    }
  })

  test('the run name labels dry runs and releases the way the decision does', () => {
    const name = workflow['run-name']
    for (const [label, [github, inputs]] of Object.entries(EVENTS)) {
      const dry = evaluate(decide.env.DRY_RUN, github, inputs) === 'true'
      const shown = new Function('github', 'inputs', 'format', `return (${EXPR_RE.exec(name)[1]})`)(github, inputs, (f, ...a) => f.replace(/\{(\d)\}/g, (_, i) => a[i]))
      // A rehearsal is never labelled a release; a real release (always on a tag) never a dry run.
      if (github.event_name === 'push' && github.ref_type === 'branch') assert.match(shown, /^Dry run on /, label)
      if (dry && github.ref_type === 'tag') assert.match(shown, /^Dry run on /, label)
      if (!dry && github.ref_type === 'tag') assert.match(shown, /^Release v/, label)
    }
  })
})

describe('the decide step, executed', () => {
  function runDecide({ dry, refType, refName, version = '1.2.3', gh = 'notfound' }) {
    const tmp = mkdtempSync(path.join(tmpdir(), 'release-decide-'))
    try {
      const bin = path.join(tmp, 'bin')
      mkdirSync(bin)
      writeFileSync(
        path.join(bin, 'gh'),
        [
          '#!/usr/bin/env bash',
          'echo "gh $*" >> "$FAKE_GH_LOG"',
          'case "$FAKE_GH" in',
          '  published) exit 0 ;;',
          '  notfound) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
          '  *) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;',
          'esac',
          '',
        ].join('\n'),
      )
      chmodSync(path.join(bin, 'gh'), 0o755)
      const work = path.join(tmp, 'work')
      mkdirSync(work)
      writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version }))
      const outputFile = path.join(tmp, 'output')
      writeFileSync(outputFile, '')
      const res = spawnSync('bash', ['-c', decide.run], {
        cwd: work,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: outputFile,
          GITHUB_SHA: 'a'.repeat(40),
          GITHUB_REPOSITORY: 'o/r',
          GH_TOKEN: 'unused',
          FAKE_GH: gh,
          FAKE_GH_LOG: path.join(tmp, 'gh.log'),
          DRY_RUN: dry ? 'true' : 'false',
          REF_TYPE: refType,
          REF_NAME: refName,
        },
      })
      const outputs = Object.fromEntries(
        readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
      let ghCalls = []
      try {
        ghCalls = readFileSync(path.join(tmp, 'gh.log'), 'utf8').split('\n').filter(Boolean)
      } catch {
        /* never called */
      }
      return { res, outputs, ghCalls, output: `${res.stdout}${res.stderr}` }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  test('a dry run publishes nothing: release=false, prefixed artifacts, and the release API is never asked', () => {
    const { res, outputs, ghCalls } = runDecide({ dry: true, refType: 'branch', refName: 'release-rehearsal/abc123def456' })
    assert.equal(res.status, 0)
    assert.deepEqual(outputs, { tag: 'dry-run', release: 'false', published: 'false', artifact_prefix: 'dry-run-', channel: 'latest' })
    assert.deepEqual(ghCalls, [])
  })

  test('a dry run of a prerelease version (develop) names the channel electron-builder will write', () => {
    // develop carries 1.27.0-nightly.9: electron-builder writes nightly*.yml, and
    // the upload paths follow `channel`, so the rehearsal uploads what it built.
    const { res, outputs } = runDecide({ dry: true, refType: 'branch', refName: 'release-rehearsal/abc123def456', version: '1.27.0-nightly.9' })
    assert.equal(res.status, 0)
    assert.equal(outputs.channel, 'nightly')
  })

  test('a dry run of a version whose prerelease starts with a number is refused', () => {
    // electron-builder would fall back to latest*.yml for 1.0.0-0.1; our versions
    // are stable or -nightly.N, so the edge is refused instead of mirrored.
    const { res, outputs, output } = runDecide({ dry: true, refType: 'branch', refName: 'release-rehearsal/abc123def456', version: '1.0.0-0.1' })
    assert.notEqual(res.status, 0)
    assert.match(output, /starts its prerelease with a number/)
    assert.deepEqual(outputs, {})
  })

  test('a dry run does not need package.json to match anything', () => {
    const { res } = runDecide({ dry: true, refType: 'branch', refName: 'develop', version: '0.0.1' })
    assert.equal(res.status, 0)
  })

  test('a stable tag that matches package.json and is not yet published: build and publish, bare artifact names', () => {
    const { res, outputs, ghCalls } = runDecide({ dry: false, refType: 'tag', refName: 'v1.2.3' })
    assert.equal(res.status, 0)
    assert.deepEqual(outputs, { tag: 'v1.2.3', release: 'true', published: 'false', artifact_prefix: '', channel: 'latest' })
    assert.deepEqual(ghCalls, ['gh api repos/o/r/releases/tags/v1.2.3 --silent'])
  })

  test('an already published release is detected, so nothing is built or changed', () => {
    const { res, outputs } = runDecide({ dry: false, refType: 'tag', refName: 'v1.2.3', gh: 'published' })
    assert.equal(res.status, 0)
    assert.deepEqual(outputs, { tag: 'v1.2.3', release: 'true', published: 'true', artifact_prefix: '', channel: 'latest' })
  })

  test('a failing release lookup that is not a 404 stops the run instead of assuming "not published"', () => {
    const { res, outputs, output } = runDecide({ dry: false, refType: 'tag', refName: 'v1.2.3', gh: 'error' })
    assert.notEqual(res.status, 0)
    assert.match(output, /HTTP 502/)
    assert.deepEqual(outputs, {})
  })

  test('a real run on a branch, or on a non-stable tag, is refused before any lookup', () => {
    for (const [refType, refName] of [['branch', 'main'], ['branch', 'v1.2.3'], ['tag', 'v1.2.3-rc.1'], ['tag', 'v1.2'], ['tag', 'v1.2.3.4'], ['tag', 'nightly']]) {
      const { res, outputs, ghCalls, output } = runDecide({ dry: false, refType, refName })
      assert.notEqual(res.status, 0, `${refType} ${refName}`)
      assert.match(output, /stable vX\.Y\.Z tag only/)
      assert.deepEqual(outputs, {})
      assert.deepEqual(ghCalls, [])
    }
  })

  test('a tag that disagrees with package.json is refused before any lookup', () => {
    const { res, ghCalls, output } = runDecide({ dry: false, refType: 'tag', refName: 'v1.2.4', version: '1.2.3' })
    assert.notEqual(res.status, 0)
    assert.match(output, /Tag v1\.2\.4 does not match package\.json version 1\.2\.3/)
    assert.deepEqual(ghCalls, [])
  })
})

describe('permissions, gating and isolation', () => {
  const jobs = workflow.jobs
  const BUILDS = ['build-linux', 'build-windows', 'build-macos']

  test('nothing is granted by default; only the publishing job can write, and only contents', () => {
    assert.deepEqual(workflow.permissions, {})
    for (const [name, job] of Object.entries(jobs)) {
      assert.ok(job.permissions, `${name} must name its own permissions`)
      const expected = name === 'publish-github' ? { contents: 'write' } : { contents: 'read' }
      assert.deepEqual(job.permissions, expected, name)
    }
  })

  test('every build waits for prepare and is skipped for an already published release', () => {
    for (const name of BUILDS) {
      assert.equal(jobs[name].needs, 'prepare', name)
      assert.equal(jobs[name].if, "needs.prepare.outputs.published != 'true'", name)
    }
  })

  test('the release is created only after all three builds, only for a real release, and only once', () => {
    const job = jobs['publish-github']
    assert.deepEqual([...job.needs].sort(), ['build-linux', 'build-macos', 'build-windows', 'prepare'])
    assert.equal(job.if, "needs.prepare.outputs.release == 'true' && needs.prepare.outputs.published != 'true'")
  })

  test('the publishing job sees no repository secret and installs nothing', () => {
    const job = jobs['publish-github']
    const serialized = JSON.stringify(job)
    assert.ok(!/secrets\./.test(serialized), 'no secret reference in the publishing job')
    assert.ok(!/npm (ci|install)|npx /.test(serialized), 'no dependency install or npx in the publishing job')
    assert.equal(job.env, undefined)
    const run = job.steps.at(-1)
    assert.equal(run.run, 'node scripts/publish-github-release.mjs')
    assert.deepEqual(Object.keys(run.env).sort(), ['GITHUB_TOKEN', 'RELEASE_TAG'])
    assert.equal(run.env.GITHUB_TOKEN, '${{ github.token }}')
  })

  test('repository secrets reach the three build jobs only', () => {
    for (const [name, job] of Object.entries(jobs)) {
      const uses = /secrets\./.test(JSON.stringify(job))
      assert.equal(uses, BUILDS.includes(name), name)
    }
  })

  test('every checkout is of the triggering commit and leaves no credentials in the checkout', () => {
    const checkouts = Object.entries(jobs).flatMap(([name, job]) =>
      (job.steps ?? []).filter((s) => String(s.uses ?? '').startsWith('actions/checkout')).map((s) => [name, s]),
    )
    assert.equal(checkouts.length, Object.keys(jobs).length)
    for (const [name, step] of checkouts) {
      assert.equal(step.with.ref, '${{ github.sha }}', name)
      assert.equal(step.with['persist-credentials'], false, name)
    }
  })

  test('runs for one ref queue; an in-flight release is never cancelled', () => {
    assert.equal(workflow.concurrency.group, 'release-${{ github.ref }}')
    assert.equal(workflow.concurrency['cancel-in-progress'], false)
  })

  test('the dispatch input defaults to a dry run', () => {
    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true)
    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.type, 'boolean')
  })

  test('every artifact of the builds is named through the dry-run prefix output and kept 30 days, failing on empty', () => {
    const uploads = BUILDS.flatMap((name) => jobs[name].steps.filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact')))
    assert.equal(uploads.length, 3)
    for (const up of uploads) {
      assert.match(up.with.name, /^\$\{\{ needs\.prepare\.outputs\.artifact_prefix \}\}(linux|windows|macos)-build$/)
      assert.equal(up.with['retention-days'], 30)
      assert.equal(up.with['if-no-files-found'], 'error')
    }
  })

  test('builds package with --publish never and the official-build delivery check runs before building', () => {
    for (const name of BUILDS) {
      const steps = jobs[name].steps
      const guard = steps.findIndex((s) => /check-release-vars\.mjs/.test(s.run ?? ''))
      const build = steps.findIndex((s) => /electron-builder/.test(s.run ?? ''))
      assert.ok(guard >= 0 && build > guard, `${name}: the guard must precede the build`)
      assert.match(steps[build].run, /--publish never/, name)
    }
  })
})

describe('supply chain of the workflow itself (fix wave 1)', () => {
  test('every `uses:` is pinned to a full commit SHA with the version in a trailing comment', () => {
    const uses = text.split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l))
    assert.ok(uses.length >= 10, 'expected the checkout/setup/upload/download steps')
    for (const line of uses) {
      assert.match(line, /uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/, line.trim())
    }
  })

  test('the macOS cross-arch module is installed at exactly the version package-lock.json records', () => {
    const step = workflow.jobs['build-macos'].steps.find((s) => /canvas-darwin-x64/.test(s.run ?? ''))
    assert.ok(step, 'cross-arch install step missing')
    assert.match(step.run, /require\('\.\/package-lock\.json'\)\.packages\['node_modules\/@napi-rs\/canvas-darwin-x64'\]\.version/)
    assert.match(step.run, /"@napi-rs\/canvas-darwin-x64@\$\{version\}"/)
    assert.doesNotMatch(step.run, /npm install[^\n]*canvas-darwin-x64(?!@)/, 'an unversioned install would take the npm `latest` tag')
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
    assert.match(lock.packages['node_modules/@napi-rs/canvas-darwin-x64'].version, /^\d+\.\d+\.\d+$/)
  })

  test('the update feed reaches the build only through the guard', () => {
    for (const name of ['build-linux', 'build-windows', 'build-macos']) {
      const job = workflow.jobs[name]
      assert.ok(!('MAILCOPILOT_UPDATE_URL' in job.env), `${name}: the judged name must come from $GITHUB_ENV`)
      assert.equal(job.env.MAILCOPILOT_UPDATE_URL_RAW, '${{ vars.MAILCOPILOT_UPDATE_URL }}')
      assert.ok(job.steps.some((s) => s.run === 'node scripts/check-release-vars.mjs --from-github-settings'), name)
    }
  })
})
