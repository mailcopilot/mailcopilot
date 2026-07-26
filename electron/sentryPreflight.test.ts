import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/does/not/exist') },
}))

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

  it('returns true when settings.json does not exist (first run)', async () => {
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(true)
  })

  it('returns true when settings.json has no sentryEnabled key (default-enabled)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ settings: { theme: 'dark' } }))
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(true)
  })

  it('returns false when sentryEnabled is explicitly false', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ settings: { sentryEnabled: false } }))
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('returns true when sentryEnabled is explicitly true', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ settings: { sentryEnabled: true } }))
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(true)
  })

  it('strips UTF-8 BOM before parsing', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const body = Buffer.from(JSON.stringify({ settings: { sentryEnabled: false } }), 'utf8')
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), Buffer.concat([bom, body]))
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('fails closed (returns false) when settings.json exists but is malformed', async () => {
    // Prefer silent loss of events over silent leakage when we cannot
    // verify the user's preference from a file that is clearly supposed
    // to exist.
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{not valid json')
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })

  it('fails closed on an empty file (partial/truncated write)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '')
    const { readSentryEnabledPreflight } = await import('./sentryPreflight')
    expect(readSentryEnabledPreflight()).toBe(false)
  })
})
