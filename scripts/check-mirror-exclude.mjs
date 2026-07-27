#!/usr/bin/env node
/**
 * Mirror EXCLUDE guard.
 *
 * The EXCLUDE list is stored as plain text in `scripts/mirror-exclude.list`
 * (one path per line, `#` starts a comment, blank lines ignored). Both mirror
 * scripts read that same file at runtime. This guard verifies that every
 * critical internal-only path in `CRITICAL_PATHS` below is present in the
 * list — so a PR that adds a new internal document (russian-language
 * roadmap, health report, etc.) cannot forget to update the mirror exclusion
 * and leak the file to the public GitHub mirror.
 *
 * By design the guard does NOT parse bash. The list is line-oriented plain
 * text, so there is no quoting / substitution / heredoc attack surface.
 *
 * Deployment constraint: this script and `scripts/mirror-exclude.list` must be
 * colocated at their real on-disk path. LIST_PATH is resolved via
 * `import.meta.url`, which Node fully resolves through symlinks — if this
 * script is invoked via a symlink, the guard will read the list next to the
 * real module, while the bash mirror scripts (`mirror-github.sh`,
 * `trigger-github-macos.sh`) resolve `$0` relative to the symlink location.
 * Symlinked invocation is therefore unsupported; mirror scripts are always
 * invoked directly from the repo tree in CI.
 */

import { readFileSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LIST_PATH = path.join(ROOT, 'scripts/mirror-exclude.list')

// Paths that MUST be present in mirror-exclude.list.
// Adding a new internal-only document? Add it here AND to the list file.
// This set is also the denylist enforced against the actual exported tree by
// scripts/check-mirror-export.mjs, so it must stay in sync with the list file.
export const CRITICAL_PATHS = [
  // GitLab CI/CD and release plumbing
  '.gitlab-ci.yml',
  '.releaserc.json',
  'CHANGELOG.md',
  // Internal scripts
  'scripts/publish-packages.sh',
  'scripts/test-mail.mjs',
  'scripts/test-mcp-virustotal.mjs',
  'scripts/mirror-github.sh',
  'scripts/trigger-github-macos.sh',
  'scripts/trigger-github-build.sh',
  // The export guard embeds the internal markers it scans for
  'scripts/check-mirror-export.mjs',
  // Tests whose subject is excluded from the mirror
  'scripts/check-mirror-exclude.test.mjs',
  'scripts/check-mirror-export.test.mjs',
  'scripts/trigger-github-build.test.mjs',
  'scripts/enforce-e2e-wrapper.test.mjs',
  // AI agents and internal instructions
  'CLAUDE.md',
  'AGENTS.md',
  // Internal planning / architecture documents
  'BACKLOG.md',
  'BACKLOG-ARCHIVE.md',
  'docs/PRD.md',
  'docs/ARCHITECTURE.md',
  'docs/HEALTH_REPORT.md',
  'docs/.health-baseline.json',
  'docs/qa',
  // Local configs (also gitignored — belt and suspenders)
  '.codex',
  '.claude',
  '.mcp.json',
  '.env',
  '.env.test',
  '.env.integration',
]

/**
 * Critical paths that are deliberately NOT tracked by git (gitignored local
 * configs and secrets). They stay in CRITICAL_PATHS as belt-and-suspenders
 * entries: if such a file ever appears in a developer's tree it must never
 * reach the mirror. `checkTracked()` skips them, since "does not exist as a
 * tracked path" is their normal state, not a stale-entry signal.
 *
 * `.claude` is the exception inside the exception: the agent definitions under
 * `.claude/agents/` ARE tracked, so it is not listed here.
 */
export const UNTRACKED_BY_DESIGN = new Set([
  '.codex',
  '.mcp.json',
  '.env',
  '.env.test',
  '.env.integration',
])

/**
 * Parses the plain-text list. Strips first `#`-to-end-of-line as a comment,
 * trims whitespace, drops blanks. Returns a Set of entries.
 */
export function parseList(src) {
  const entries = new Set()
  for (const rawLine of src.split(/\r?\n/)) {
    const noComment = rawLine.replace(/#.*$/, '')
    const trimmed = noComment.trim()
    if (trimmed.length > 0) entries.add(trimmed)
  }
  return entries
}

/**
 * Path-matching semantics shared by the mirror bash scripts and both guards.
 *
 * The bash side does:
 *   - `rm -rf "$WORK_DIR/$pattern"` for patterns containing `/`
 *     → repo-root-relative exact path (a directory takes its subtree with it);
 *   - `find "$WORK_DIR" -name "$pattern" -exec rm -rf {} +` otherwise
 *     → any entry (file OR directory) whose basename equals the pattern, at any
 *       depth; a matched directory takes its subtree with it.
 *
 * `relPath` is a repo-root-relative path with `/` separators and no leading
 * `./`. Patterns are treated literally — see `assertNoGlobPatterns()`.
 */
export function matchesPattern(relPath, pattern) {
  if (pattern.includes('/')) {
    return relPath === pattern || relPath.startsWith(`${pattern}/`)
  }
  return relPath.split('/').includes(pattern)
}

/**
 * The bash side feeds patterns to `find -name`, which interprets glob
 * metacharacters, while the JS side matches literally. No current entry uses
 * globs; if one ever does, the two semantics silently diverge — so we fail
 * loudly instead. Returns the offending entries.
 */
export function assertNoGlobPatterns(entries) {
  return [...entries].filter((e) => /[*?[\]]/.test(e))
}

/**
 * Lists repository files via `git ls-files`, relative to ROOT: tracked files
 * plus untracked-but-not-ignored ones. Untracked files are included so that a
 * brand-new internal document counts as "present" before its first commit —
 * otherwise the guard would reject the very commit that introduces it. Ignored
 * files stay out, which is what `UNTRACKED_BY_DESIGN` accounts for.
 *
 * Returns `null` when git is unavailable or ROOT is not a work tree — callers
 * treat that as "cannot verify" rather than "verified empty".
 */
export function listTrackedFiles(root = ROOT) {
  const res = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) return null
  return res.stdout.split('\0').filter((f) => f.length > 0)
}

/**
 * Marker file by which the EXPORTER declares "this tree is a published mirror".
 *
 * This exists because the staleness check below has one legitimate exemption —
 * the guard also ships inside the public mirror, where every internal path is
 * absent by design. That exemption used to be INFERRED ("all critical paths
 * vanished ⇒ we must be in a mirror"), which is a conclusion drawn from
 * absence: a mass rename or deletion of internal documents in the main
 * repository would disable the staleness check at exactly the moment it is most
 * needed. An exported tree has to say so explicitly instead.
 *
 * WHY A FILE AND NOT AN ENVIRONMENT VARIABLE. The declaration used to be
 * `MAILCOPILOT_MIRROR_EXPORT=1`, which had no producer at all: no mirror script
 * and no CI job ever set it, while ANY shell that happened to export the name
 * could switch the exemption on. A signal that nobody produces and anybody can
 * forge is not a signal. The mirror scripts now write this file INTO THE SNAPSHOT
 * after the exclude filter has run (`mirror-github.sh`,
 * `trigger-github-build.sh`), so the declaration:
 *   - is produced by exactly one place — the export path itself;
 *   - travels with the artefact it describes, instead of with the ambient env;
 *   - cannot exist in the internal repository without somebody committing it,
 *     which the export guard's allowlist assertion (e) rejects.
 * The exemption still requires EVERY critical path to be absent as well, so even
 * a forged marker cannot excuse a partially stripped tree.
 *
 * The content is deliberately STATIC: `sync_mirror_branch` commits only when the
 * tree changed, so a timestamp or a version here would produce a new mirror
 * commit on every run even when the source did not move.
 */
export const MIRROR_EXPORT_MARKER = '.mirror-export'

/** The exact line the marker file must contain to count as a declaration. */
export const MIRROR_EXPORT_MARKER_SIGNATURE = 'mailcopilot-public-mirror-snapshot'

/**
 * Whether this tree carries the exporter's mirror declaration. Reads the marker
 * file next to the repository root; anything unreadable, missing, or without the
 * exact signature line is "not declared" (fail-closed).
 */
export function isDeclaredMirrorExport(root = ROOT) {
  try {
    const src = readFileSync(path.join(root, MIRROR_EXPORT_MARKER), 'utf8')
    return src.split(/\r?\n/).some((line) => line.trim() === MIRROR_EXPORT_MARKER_SIGNATURE)
  } catch {
    return false
  }
}

/**
 * §2.12-f2 guard: every critical path must still exist as a tracked file or
 * directory. Without this, renaming (or deleting) an internal document leaves a
 * stale entry in the list and the guard keeps passing vacuously while the new
 * name leaks to the mirror.
 *
 * Returns `{ stale, skipped, checked, unavailable, unavailableTolerated,
 * publishedMirror }`; `stale` is the actionable failure.
 *
 * `unavailable` (git could not list the repository files) is itself a FAILURE in
 * the internal repository — see `main`. The staleness check is the only thing
 * that notices a renamed internal document, so "could not verify" must not read
 * as "verified": that turns the guard off exactly when it stopped working. The
 * single tolerated case is a tree that declares itself an exported mirror
 * (`unavailableTolerated`), where there may be no git work tree at all and where
 * every internal path is absent by design.
 *
 * `publishedMirror` is true only when the tree carries the exporter's marker file
 * (see MIRROR_EXPORT_MARKER) AND every checked path is indeed absent (a
 * partially-stripped tree is not an export — it is a broken export, and must
 * fail). Without that explicit declaration, "all critical paths are missing" is
 * reported as staleness, never excused.
 */
export function checkTracked(trackedFiles = listTrackedFiles(), { mirrorExport } = {}) {
  const declaredMirror = mirrorExport === undefined ? isDeclaredMirrorExport() : mirrorExport
  if (trackedFiles === null) {
    return {
      stale: [],
      skipped: [...UNTRACKED_BY_DESIGN],
      checked: 0,
      unavailable: true,
      unavailableTolerated: declaredMirror,
      publishedMirror: false,
    }
  }
  const stale = []
  const skipped = []
  let checked = 0
  for (const p of CRITICAL_PATHS) {
    if (UNTRACKED_BY_DESIGN.has(p)) {
      skipped.push(p)
      continue
    }
    checked++
    if (!trackedFiles.some((f) => matchesPattern(f, p))) stale.push(p)
  }
  const publishedMirror = declaredMirror && checked > 0 && stale.length === checked
  return {
    stale: publishedMirror ? [] : stale,
    skipped,
    checked,
    unavailable: false,
    unavailableTolerated: false,
    publishedMirror,
  }
}

/**
 * Reads LIST_PATH and verifies CRITICAL_PATHS ⊆ entries.
 * Returns `{ entries, missing }`.
 */
export function checkList() {
  const src = readFileSync(LIST_PATH, 'utf8')
  const entries = parseList(src)
  const missing = CRITICAL_PATHS.filter((p) => !entries.has(p))
  return { entries, missing }
}

/**
 * Writes an error line to stderr via a direct synchronous write to fd 2.
 *
 * We avoid both `console.error(...)` and `process.stderr.write(...)` here
 * because, when this script is launched via `spawnSync(...)` with a captured
 * `stderr` pipe, both routes can lose output before `process.exit(1)` fires.
 * `console.error` serializes through `util.inspect` and queues asynchronously,
 * and `process.stderr.write` on a pipe sink goes through Node's stream stdio
 * machinery, which has been observed (Node v22.22.0, sandboxed spawnSync
 * contexts) to leave the parent with `status=1` but an empty `stderr` string.
 *
 * `fs.writeSync(2, ...)` bypasses Node's stream stdio entirely and performs a
 * synchronous POSIX write on fd 2, which is reliable across sandboxed /
 * subprocess invocations.
 */
function writeStderrLine(msg) {
  writeSync(2, `${msg}\n`)
}

export function main() {
  const { entries, missing } = checkList()
  let failed = false

  if (missing.length > 0) {
    failed = true
    writeStderrLine('Mirror EXCLUDE check failed:')
    for (const m of missing) {
      writeStderrLine(`  missing '${m}' in scripts/mirror-exclude.list`)
    }
    writeStderrLine('')
    writeStderrLine(
      `${missing.length} critical path(s) missing. Add the entries to ` +
        `scripts/mirror-exclude.list to prevent leaking internal-only files ` +
        `to the public GitHub mirror.`,
    )
  }

  const globs = assertNoGlobPatterns(entries)
  if (globs.length > 0) {
    failed = true
    writeStderrLine('Mirror EXCLUDE check failed: glob patterns are not supported:')
    for (const g of globs) writeStderrLine(`  '${g}'`)
    writeStderrLine(
      'The bash mirror scripts expand globs via `find -name`, the JS guards ' +
        'match literally. Use explicit paths instead.',
    )
  }

  const { stale, checked, unavailable, unavailableTolerated, publishedMirror } = checkTracked()
  if (unavailable && !unavailableTolerated) {
    // Fail-closed: a git that cannot list the repository disables the staleness
    // check, and the previous behaviour printed "check OK" in exactly that case.
    failed = true
    writeStderrLine(
      'Mirror EXCLUDE check failed: cannot list the repository files ' +
        '(git is unavailable, or this is not a git work tree).',
    )
    writeStderrLine(
      'The staleness check is the only thing that catches a renamed or deleted ' +
        'internal document leaving a vacuous entry behind, so "cannot verify" is ' +
        'a failure here, not a pass. Run the guard inside the repository work ' +
        `tree. (An exported mirror — a tree carrying '${MIRROR_EXPORT_MARKER}' — is ` +
        'the one place where the absence of a work tree is expected and tolerated.)',
    )
  }
  if (stale.length > 0) {
    failed = true
    writeStderrLine('Mirror EXCLUDE check failed: stale critical path(s):')
    for (const s of stale) writeStderrLine(`  '${s}' is not tracked by git any more`)
    writeStderrLine(
      'A renamed or deleted internal file leaves the guard passing vacuously ' +
        'while the new name leaks. Update CRITICAL_PATHS and ' +
        'scripts/mirror-exclude.list together. ' +
        `(Running this guard INSIDE an exported public mirror? The mirror scripts ` +
        `write '${MIRROR_EXPORT_MARKER}' into the snapshot — that file is the only ` +
        'way to declare the absence of internal paths intentional, and only the ' +
        'export path produces it.)',
    )
  }

  if (failed) process.exit(1)

  let trackingNote = `${checked} of them confirmed tracked`
  if (unavailable) {
    // Only reachable with the mirror declaration in hand — the undeclared case
    // failed above.
    trackingNote = `git unavailable inside a declared '${MIRROR_EXPORT_MARKER}' tree, tracking check skipped`
  }
  if (publishedMirror) {
    trackingNote = `'${MIRROR_EXPORT_MARKER}' present, tracking check skipped`
  }

  console.log(
    `Mirror EXCLUDE check OK (${CRITICAL_PATHS.length} critical paths verified, ` +
      `${trackingNote}, ` +
      `${entries.size} total entries in scripts/mirror-exclude.list).`,
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
    // Use synchronous stderr write + explicit message serialization rather
    // than `console.error(err)`. The latter serializes Error objects through
    // `util.inspect`, which can queue output asynchronously and race with
    // `process.exit(1)` in sandboxed spawnSync contexts (see writeStderrLine
    // above). We preserve the stack for local diagnostics when available.
    const msg = err instanceof Error ? (err.stack || err.message) : String(err)
    writeStderrLine(`[check-mirror-exclude] ${msg}`)
    process.exit(1)
  }
}
