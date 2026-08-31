import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TELEMETRY_CONSENT_VERSION } from './telemetryConsent'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/does/not/exist') },
}))

const AT = '2026-07-27T10:00:00.000Z'
const GRANTED = { granted: true, version: TELEMETRY_CONSENT_VERSION, at: AT }
const DENIED = { granted: false, version: TELEMETRY_CONSENT_VERSION, at: AT }

describe('sentryPreflight', () => {
  let tmpDir: string
  const ORIG_DATA_DIR = process.env.MAILCOPILOT_DATA_DIR

  beforeEach(() => {
    vi.resetModules()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-preflight-'))
    process.env.MAILCOPILOT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (ORIG_DATA_DIR === undefined) delete process.env.MAILCOPILOT_DATA_DIR
    else process.env.MAILCOPILOT_DATA_DIR = ORIG_DATA_DIR
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function writeSettings(settings: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ settings }))
  }

  // AC1 — all four fail branches return false.
  it('AC1: returns false when settings.json does not exist (first run, never asked)', async () => {
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('AC1: fails closed when settings.json exists but is malformed', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{not valid json')
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('AC1: fails closed on an empty file (partial/truncated write)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '')
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('AC1: fails closed when the file is unreadable', async () => {
    const filePath = path.join(tmpDir, 'settings.json')
    writeSettings({ telemetryConsent: GRANTED })
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    try {
      const { readSentryEnabledPreflight } = await import('./sentryPreflight')
      expect(readSentryEnabledPreflight()).toBe(false)
    } finally {
      readSpy.mockRestore()
      fs.rmSync(filePath, { force: true })
    }
  })

  it('AC1: fails closed when the data dir cannot be resolved', async () => {
    delete process.env.MAILCOPILOT_DATA_DIR
    const { app } = await import('electron')
    vi.mocked(app.getPath).mockImplementationOnce(() => { throw new Error('no userData') })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('returns false when no consent record exists, even with sentryEnabled: true', async () => {
    // Pre-§2.82 installs: the flag defaulted to on, but consent was never asked.
    writeSettings({ sentryEnabled: true })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('returns true only for a granted record at the current disclosure version', async () => {
    writeSettings({ telemetryConsent: GRANTED })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(true)
  })

  it('returns false for a refusal', async () => {
    writeSettings({ telemetryConsent: DENIED, sentryEnabled: true })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('returns false when consent is granted but the About switch is off', async () => {
    writeSettings({ telemetryConsent: GRANTED, sentryEnabled: false })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  // §2.258 — this is the reachable path the fix targets: this preflight reads
  // the raw settings.json BEFORE zod validation, so a corrupt `sentryEnabled`
  // that a schema would normally coerce or reject genuinely arrives here as
  // written. `isTelemetryAllowed` used to admit anything other than literal
  // `false` (null, 0, the string "false", ...) as permission to send; with a
  // valid grant on disk, that meant a corrupt switch still enabled the SDK.
  it('returns false when consent is granted and the raw switch value is corrupt, not literal false', async () => {
    for (const corrupt of [null, 0, '', 'false', 'no', [], {}]) {
      writeSettings({ telemetryConsent: GRANTED, sentryEnabled: corrupt })
      const { readSentryEnabledPreflight } = await import('./sentryPreflight')
      expect(readSentryEnabledPreflight()).toBe(false)
      vi.resetModules()
    }
  })

  it('returns false when the record predates the current disclosure version', async () => {
    writeSettings({ telemetryConsent: { ...GRANTED, version: TELEMETRY_CONSENT_VERSION - 1 } })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  // AC6/AC (e) — a grant recorded by a NEWER build (app downgrade) is honored:
  // the disclosure it covers is at least as wide as this build's.
  it('returns true for a grant recorded by a newer build (downgrade)', async () => {
    writeSettings({ telemetryConsent: { ...GRANTED, version: TELEMETRY_CONSENT_VERSION + 1 } })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(true)
  })

  it('returns false for a refusal recorded by a newer build (downgrade)', async () => {
    writeSettings({ telemetryConsent: { ...DENIED, version: TELEMETRY_CONSENT_VERSION + 1 }, sentryEnabled: true })
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('strips UTF-8 BOM before parsing', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const body = Buffer.from(JSON.stringify({ settings: { telemetryConsent: GRANTED } }), 'utf8')
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), Buffer.concat([bom, body]))
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(true)
  })
})
