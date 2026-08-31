#!/usr/bin/env node
/**
 * Rebuilds the native module for plain Node, runs the vitest suites that need
 * it, then restores the Electron ABI — and refuses to exit 0 unless the
 * restore is proven to have landed (§2.265).
 *
 * The guarantee is terminal, not preventive: a run never ends successfully
 * while leaving the tree unusable by Electron. It cannot cover a killed
 * process — for that, ask `npm run abi:check` (scripts/nativeAbi.mjs).
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NATIVE_MODULE,
  ROOT,
  formatAbiState,
  invalidateForgeMeta,
  readForgeMeta,
} from './nativeAbi.mjs'

const ABI_SCRIPT = path.join(ROOT, 'scripts', 'nativeAbi.mjs')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function npmRun(args) {
  const result = spawnSync(npmCmd, args, { stdio: 'inherit', env: process.env })
  return result.status ?? 1
}

/**
 * The ABI probe runs in a FRESH child process on purpose. Node's module cache
 * is per-process: probing before the restore would leave the old addon loaded,
 * and the post-restore probe would then report the pre-restore ABI. `spawn` is
 * injectable so a test can assert the call goes through a real subprocess
 * launch (a new `process.execPath`) rather than an in-process shortcut that
 * would silently reintroduce the stale-cache bug.
 */
export function probeAbiState({ spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, [ABI_SCRIPT, '--json'], { encoding: 'utf8' })
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { module: NATIVE_MODULE, actualAbi: null, actualReason: 'probe-failed', expectedAbi: null, ok: false }
  }
}

export function runNativeTests({
  mode,
  run = npmRun,
  probe = probeAbiState,
  readMeta = readForgeMeta,
  invalidateMeta = invalidateForgeMeta,
  log = console,
} = {}) {
  let status = run(['rebuild', NATIVE_MODULE])

  if (status === 0) {
    const testArgs = mode === 'db'
      ? ['exec', '--', 'vitest', '--run', 'packages/db']
      : ['exec', '--', 'vitest', '--run', '--passWithNoTests']
    status = run(testArgs)
  }

  // `npm rebuild` swapped the binary but left `.forge-meta` naming the previous
  // ABI. `electron-builder install-app-deps` has no force flag of its own, so
  // the marker is dropped here — otherwise @electron/rebuild takes its
  // already-built skip branch and the restore is a silent no-op.
  const beforeRestore = probe()
  const staleMeta = readMeta()
  if (staleMeta && staleMeta.abi !== beforeRestore.actualAbi) {
    log.log(
      `[abi] stale marker before restore: .forge-meta says ABI ${staleMeta.abi}, binary is ABI ${beforeRestore.actualAbi ?? 'unknown'}`,
    )
  }
  invalidateMeta()

  const restoreStatus = run(['exec', '--', 'electron-builder', 'install-app-deps'])
  const state = probe()

  if (!state.ok || restoreStatus !== 0) {
    log.error(`[abi] Electron ABI restore failed.\n${formatAbiState(state)}`)
    return status === 0 ? (restoreStatus === 0 ? 1 : restoreStatus) : status
  }

  log.log(`[abi] ${formatAbiState(state)}`)
  return status
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode !== 'db' && mode !== 'all') {
    console.error('Usage: node scripts/run-native-tests.mjs <db|all>')
    process.exit(1)
  }
  process.exit(runNativeTests({ mode }))
}
