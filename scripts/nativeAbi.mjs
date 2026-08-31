#!/usr/bin/env node
/**
 * Authoritative answer to a single question: which runtime ABI is the native
 * module in this working tree currently built for?
 *
 * Why this file exists (§2.265). `better-sqlite3` can only be built for one
 * NODE_MODULE_VERSION at a time — the addon lands in a single
 * `build/Release/better_sqlite3.node` slot. `npm run test:db` rebuilds it for
 * plain Node, then restores it for Electron. When the restore silently no-ops,
 * every later Electron start fails with a misleading error. Consumers that did
 * not run the script themselves (interrupted run, fresh shell, an agent about
 * to launch the app) must be able to ASK what the tree holds instead of
 * assuming.
 *
 * Run:
 *   npm run abi:check           # human-readable verdict, exit 1 on mismatch
 *   node scripts/nativeAbi.mjs --json
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The one native module whose ABI the test scripts flip back and forth. */
export const NATIVE_MODULE = 'better-sqlite3'

/**
 * Marker written by `@electron/rebuild` (module-rebuilder.js `metaPath`).
 * Its content is `${arch}--${ABI}`, and `alreadyBuiltByRebuild()` compares it
 * verbatim to decide whether to skip the module. `npm rebuild` replaces the
 * `.node` binary but never touches this file, which is exactly how a stale
 * marker makes a later `install-app-deps` skip the restore.
 */
export function forgeMetaPath(root = ROOT) {
  return path.join(root, 'node_modules', NATIVE_MODULE, 'build', 'Release', '.forge-meta')
}

/** Parses `x64--148` into `{ arch, abi }`; returns null on anything else. */
export function parseForgeMeta(text) {
  const match = /^(.*?)--(\d+)$/.exec(String(text ?? '').trim())
  return match ? { arch: match[1], abi: Number(match[2]) } : null
}

export function readForgeMeta(root = ROOT) {
  try {
    return parseForgeMeta(readFileSync(forgeMetaPath(root), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The marker is stale when it claims an ABI the binary does not actually have.
 * That is the skip-condition of `@electron/rebuild`, so a stale marker means a
 * subsequent restore would report success while doing nothing.
 */
export function isForgeMetaStale(meta, actualAbi) {
  if (!meta || typeof actualAbi !== 'number') return false
  return meta.abi !== actualAbi
}

/** Removes the marker so the next rebuild cannot take the skip branch. */
export function invalidateForgeMeta(root = ROOT) {
  const target = forgeMetaPath(root)
  if (!existsSync(target)) return false
  rmSync(target, { force: true })
  return true
}

/**
 * Extracts both ABI numbers from a Node loader error. The message names the
 * module's compiled ABI first and the host's required ABI second:
 *   "...using NODE_MODULE_VERSION 148. This version of Node.js requires
 *    NODE_MODULE_VERSION 127."
 */
export function parseLoaderAbi(message) {
  const found = []
  const pattern = /NODE_MODULE_VERSION\s+(\d+)/g
  let match
  while ((match = pattern.exec(String(message ?? '')))) found.push(Number(match[1]))
  if (found.length === 0) return null
  return { moduleAbi: found[0], hostAbi: found.length > 1 ? found[1] : null }
}

/**
 * IMPORTANT: a bare `require('better-sqlite3')` succeeds under ANY ABI and is
 * therefore not a check at all — the addon is dlopen'd lazily inside the
 * Database constructor (better-sqlite3/lib/database.js), not at module load.
 * Only actually constructing a database proves which runtime the binary holds.
 */
function defaultLoadProbe(root) {
  const require_ = createRequire(path.join(root, 'package.json'))
  const Database = require_(NATIVE_MODULE)
  const db = new Database(':memory:')
  db.close()
}

/**
 * Returns the ABI the binary is actually built for, as observed from the
 * current process: on a successful open it is this process's own ABI, on a
 * mismatch the loader names it explicitly.
 */
export function probeNativeAbi({ root = ROOT, load = defaultLoadProbe } = {}) {
  try {
    load(root)
    return { abi: Number(process.versions.modules), reason: 'loaded' }
  } catch (err) {
    const parsed = parseLoaderAbi(err?.message)
    if (parsed) return { abi: parsed.moduleAbi, reason: 'abi-mismatch', hostAbi: parsed.hostAbi }
    return { abi: null, reason: 'unreadable', detail: String(err?.code ?? err?.message ?? err) }
  }
}

export function readElectronVersion(root = ROOT) {
  try {
    const pkg = path.join(root, 'node_modules', 'electron', 'package.json')
    return JSON.parse(readFileSync(pkg, 'utf8')).version || null
  } catch {
    return null
  }
}

/**
 * Expected Electron ABI, never a literal. Primary source is the very
 * computation `@electron/rebuild` performs — `node-abi` resolved through its
 * own dependency path, since the hoisted copy can be older than the installed
 * Electron. Fallback is the marker the same tool last wrote.
 */
export function expectedElectronAbi({ root = ROOT, electronVersion, meta } = {}) {
  const version = electronVersion ?? readElectronVersion(root)
  if (version) {
    const require_ = createRequire(path.join(root, 'package.json'))
    const candidates = [
      path.join(root, 'node_modules', '@electron', 'rebuild', 'node_modules', 'node-abi'),
      'node-abi',
    ]
    for (const candidate of candidates) {
      try {
        const abi = Number(require_(candidate).getAbi(version, 'electron'))
        if (Number.isInteger(abi)) return { abi, source: `node-abi (Electron ${version})` }
      } catch {
        // Older node-abi throws on an Electron release it does not know yet.
      }
    }
  }
  const marker = meta ?? readForgeMeta(root)
  return marker ? { abi: marker.abi, source: '.forge-meta' } : { abi: null, source: null }
}

/** Single description of the tree's ABI state, shared by the CLI and callers. */
export function describeAbiState({ root = ROOT, probe = probeNativeAbi, expected = expectedElectronAbi } = {}) {
  const meta = readForgeMeta(root)
  const actual = probe({ root })
  const target = expected({ root, meta })
  return {
    module: NATIVE_MODULE,
    actualAbi: actual.abi,
    actualReason: actual.reason,
    detail: actual.detail ?? null,
    expectedAbi: target.abi,
    expectedSource: target.source,
    markerAbi: meta?.abi ?? null,
    markerStale: isForgeMetaStale(meta, actual.abi),
    ok: typeof actual.abi === 'number' && actual.abi === target.abi,
  }
}

/** Exact command that repairs the tree, marker invalidation included. */
export function recoveryCommand(root = ROOT) {
  return `rm -f ${path.relative(root, forgeMetaPath(root))} && npx electron-builder install-app-deps`
}

export function formatAbiState(state, root = ROOT) {
  if (state.ok) {
    return `${state.module} is built for Electron ABI ${state.actualAbi} (expected via ${state.expectedSource}).`
  }
  const actual = state.actualAbi ?? `unknown (${state.actualReason}${state.detail ? `: ${state.detail}` : ''})`
  const expected = state.expectedAbi ?? 'unknown'
  const stale = state.markerStale ? ` Stale .forge-meta claims ABI ${state.markerAbi}.` : ''
  return (
    `${state.module} is built for ABI ${actual}, but Electron needs ABI ${expected}` +
    ` (expected via ${state.expectedSource ?? 'no source'}).${stale}\n` +
    `Recover with: ${recoveryCommand(root)}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = describeAbiState()
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(state)}\n`)
  } else {
    process.stdout.write(`${formatAbiState(state)}\n`)
  }
  process.exit(state.ok ? 0 : 1)
}
