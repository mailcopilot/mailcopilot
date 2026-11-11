import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { UPDATER_SESSION_PARTITION } from './services/updaterRequestPolicy'

// The privacy policy says an update request identifies no installation. That
// rests on two facts outside our own code, pinned here so a dependency bump or
// a refactor cannot silently turn the promise into a lie:
//   1. electron-updater puts its per-install id in the `x-user-staging-id`
//      header and lets `requestHeaders` override it (computeFinalHeaders);
//   2. main.ts sets `requestHeaders` unconditionally (not only with a token).

const require = createRequire(import.meta.url)

describe('update request headers contract', () => {
  it('electron-updater still sends the staging id under the header we override, and lets requestHeaders win', () => {
    const pkgDir = path.dirname(require.resolve('electron-updater/package.json'))
    const source = fs.readFileSync(path.join(pkgDir, 'out', 'AppUpdater.js'), 'utf-8')
    expect(source).toContain('computeFinalHeaders({ "x-user-staging-id": stagingUserId })')
    expect(source).toMatch(/Object\.assign\(headers, this\.requestHeaders\)/)
  })

  it('main.ts pins the headers unconditionally', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8')
    expect(main).toMatch(/^\s*autoUpdater\.requestHeaders = buildUpdateRequestHeaders\(updateToken\)$/m)
    expect(main).not.toMatch(/if \(updateToken\) autoUpdater\.requestHeaders/)
  })

  // The language header is removed on the session electron-updater issues its
  // requests on. A different name would leave the real traffic untouched and
  // nothing would fail, so the name is pinned to the library's own constant.
  it('removes Accept-Language on the very session electron-updater uses', () => {
    const lib = require('electron-updater/out/electronHttpExecutor') as { NET_SESSION_NAME: string }
    expect(UPDATER_SESSION_PARTITION).toBe(lib.NET_SESSION_NAME)
    const executor = fs.readFileSync(
      path.join(path.dirname(require.resolve('electron-updater/package.json')), 'out', 'electronHttpExecutor.js'),
      'utf-8',
    )
    // Options only apply when a partition's session is first created, and main.ts creates it
    // first, so its `{ cache: false }` becomes the updater's: keep it identical to the library's.
    expect(executor).toMatch(/fromPartition\(exports\.NET_SESSION_NAME, \{\s*cache: false/)
  })

  it('main.ts installs the policy on that session when it sets up the updater', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8')
    expect(main).toMatch(/installUpdaterRequestPolicy\(session\.fromPartition\(UPDATER_SESSION_PARTITION, \{ cache: false \}\)\)/)
  })
})
