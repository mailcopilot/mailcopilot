import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
if (mode !== 'db' && mode !== 'all') {
  console.error('Usage: node scripts/run-native-tests.mjs <db|all>')
  process.exit(1)
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args, extraEnv = {}) {
  const result = spawnSync(npmCmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  return result.status ?? 1
}

let status = run(['rebuild', 'better-sqlite3'])

if (status === 0) {
  const testArgs = mode === 'db'
    ? ['exec', '--', 'vitest', '--run', 'packages/db']
    : ['exec', '--', 'vitest', '--run', '--passWithNoTests']
  status = run(testArgs)
}

const restoreStatus = run(['exec', '--', 'electron-builder', 'install-app-deps'])
if (status === 0 && restoreStatus !== 0) status = restoreStatus

process.exit(status)
