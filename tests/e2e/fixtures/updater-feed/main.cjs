// Fixture for tests/e2e/updater-request-headers.spec.ts. Runs the REAL
// electron-updater against a local HTTP feed and prints the headers the feed
// actually received, as one JSON line. It wires the updater the way
// electron/main.ts does: the pinned request headers, plus the session policy
// unless UPDATER_POLICY=off (the control run that proves the header is there
// without it).
const { app, session } = require('electron')
const crypto = require('node:crypto')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Keep the updater's cache and config out of the developer's profile.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-updater-feed-'))
app.setPath('userData', path.join(scratch, 'userData'))
process.env.XDG_CACHE_HOME = path.join(scratch, 'cache')
// The Linux updater reads the running AppImage to try a differential download,
// which is what requests the .blockmap files.
process.env.APPIMAGE = path.join(scratch, 'Fixture-1.0.0.AppImage')
fs.writeFileSync(process.env.APPIMAGE, Buffer.alloc(300_000, 1))

const root = path.resolve(__dirname, '../../../..')
// Electron's Node strips TypeScript types, so the production modules load as they are.
const { buildUpdateRequestHeaders } = require(path.join(root, 'electron/services/updateScheduler.ts'))
const { UPDATER_SESSION_PARTITION, installUpdaterRequestPolicy } = require(path.join(root, 'electron/services/updaterRequestPolicy.ts'))
const { autoUpdater } = require(path.join(root, 'node_modules/electron-updater'))

const payload = Buffer.alloc(300_000, 7)
const sha512 = crypto.createHash('sha512').update(payload).digest('base64')
const seen = []
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url.split('?')[0], headers: req.headers })
  if (req.url.startsWith('/latest-linux.yml') || req.url.startsWith('/latest.yml') || req.url.startsWith('/latest-mac.yml')) {
    res.setHeader('content-type', 'text/yaml')
    res.end(`version: 2.0.0\nfiles:\n  - url: Fixture-2.0.0.AppImage\n    sha512: ${sha512}\n    size: ${payload.length}\npath: Fixture-2.0.0.AppImage\nsha512: ${sha512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`)
  } else if (req.url.startsWith('/Fixture-2.0.0.AppImage')) {
    res.setHeader('content-length', payload.length)
    res.end(payload)
  } else {
    res.statusCode = 404
    res.end('no')
  }
})

app.whenReady().then(async () => {
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    if (process.env.UPDATER_POLICY !== 'off') {
      installUpdaterRequestPolicy(session.fromPartition(UPDATER_SESSION_PARTITION, { cache: false }))
    }
    const feedUrl = `http://127.0.0.1:${server.address().port}/`
    const configPath = path.join(scratch, 'dev-app-update.yml')
    fs.writeFileSync(configPath, `provider: generic\nurl: ${feedUrl}\n`)
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.updateConfigPath = configPath
    autoUpdater.autoDownload = false
    // A finished download must not arm an install-on-quit of the fixture's own payload.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.disableDifferentialDownload = false
    autoUpdater.requestHeaders = buildUpdateRequestHeaders()
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    const check = await autoUpdater.checkForUpdates()
    let downloaded = false
    if (check && check.isUpdateAvailable) {
      try { await autoUpdater.downloadUpdate(); downloaded = true } catch (e) { console.log('DOWNLOAD_ERR ' + e.message) }
    }
    console.log('RESULT ' + JSON.stringify({ available: Boolean(check && check.isUpdateAvailable), downloaded, seen }))
  } catch (e) {
    console.log('FIXTURE_ERR ' + (e && e.stack || e))
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  app.exit(0)
})
