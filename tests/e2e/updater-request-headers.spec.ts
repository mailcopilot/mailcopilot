/**
 * The update feed must not learn the user's language.
 *
 * Runs the REAL electron-updater (check and download) inside a real Electron
 * process against a local HTTP server standing in for the feed, and reads the
 * headers the server received. Nothing is mocked: the header is added by
 * Chromium's network stack, so only a real request can show whether it is gone.
 * The fixture wires the updater the way electron/main.ts does; a control run
 * without the session policy proves the header is really there to remove.
 */
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronLaunchArgs, hasDisplayServer } from './launchArgs'

type SeenRequest = { method: string; url: string; headers: Record<string, string> }
type FixtureResult = { available: boolean; downloaded: boolean; seen: SeenRequest[] }

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'updater-feed')

/** Everything a feed request may carry: what Chromium's stack and the library add on their own, and nothing about the user. */
const ALLOWED_HEADERS = new Set([
  'host', 'connection', 'accept', 'user-agent', 'cache-control', 'accept-encoding', 'range',
  'x-user-staging-id', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
])

async function runFixture(policy: 'on' | 'off'): Promise<FixtureResult> {
  const electronBinary = createRequire(import.meta.url)('electron') as string
  const args = [FIXTURE_DIR, ...electronLaunchArgs().slice(1)]
  const env = { ...process.env, UPDATER_POLICY: policy }
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE
  const proc = hasDisplayServer()
    ? spawn(electronBinary, args, { env, stdio: 'pipe' })
    : spawn('xvfb-run', ['-a', electronBinary, ...args], { env, stdio: 'pipe' })
  let out = ''
  proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
  proc.stderr.on('data', () => { /* Chromium noise */ })
  await new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('exit', () => resolve())
  })
  const line = out.split('\n').find(l => l.startsWith('RESULT '))
  if (!line) throw new Error(`fixture produced no result:\n${out.slice(-2000)}`)
  return JSON.parse(line.slice('RESULT '.length)) as FixtureResult
}

test.describe('update feed request headers', () => {
  test('control: without the session policy Chromium sends the UI language', async () => {
    const result = await runFixture('off')
    expect(result.available).toBe(true)
    const check = result.seen.find(r => r.url.endsWith('.yml'))
    expect(check?.headers['accept-language']).toBeTruthy()
  })

  test('with the policy no updater request carries Accept-Language, and nothing else changes', async () => {
    const result = await runFixture('on')
    expect(result.available).toBe(true)
    expect(result.downloaded).toBe(true)
    // The check and the installer download both went out and were inspected.
    expect(result.seen.some(r => r.url.endsWith('.yml'))).toBe(true)
    expect(result.seen.some(r => r.url.endsWith('.AppImage'))).toBe(true)
    for (const request of result.seen) {
      expect(request.headers['accept-language'], `${request.url} leaks the language`).toBeUndefined()
      const unexpected = Object.keys(request.headers).filter(h => !ALLOWED_HEADERS.has(h))
      expect(unexpected, `${request.url} carries unexpected headers`).toEqual([])
      // The pinned headers from buildUpdateRequestHeaders survive untouched.
      expect(request.headers['x-user-staging-id']).toBe('00000000-0000-0000-0000-000000000000')
      expect(request.headers['user-agent']).toBe('electron-builder')
    }
  })
})
