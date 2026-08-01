import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * §2.82 gap check — electron/sentry.ts and src/sentry.ts each carry an
 * INDEPENDENT copy of scrubUserPaths. This is deliberate (the renderer cannot
 * read os.homedir(), see the header comment above scrubUserPaths in
 * src/sentry.ts for the full reasoning) — but two independent copies drift
 * silently: a regex tweak applied to only one side would pass both files' own
 * test suites (each only asserts against itself) while the two processes
 * disagree on what "scrubbed" means.
 *
 * This file locks the SHAPE-based half — the part both copies claim to share
 * — to byte-identical behavior for the same input. It does NOT exercise the
 * main-only HOME_DIRS branch (os.homedir()-based replacement), which has no
 * renderer counterpart by design and is covered on its own in
 * electron/sentry.test.ts.
 */

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(),
  setUser: vi.fn(),
  getClient: vi.fn(() => ({ getOptions: () => ({ enabled: true }) })),
  startInactiveSpan: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), fmt: vi.fn() },
  wrapMcpServerWithSentry: vi.fn((s: unknown) => s),
}))
vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  ErrorBoundary: vi.fn(),
  browserTracingIntegration: vi.fn(),
  captureFeedback: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  getClient: vi.fn(() => ({ getOptions: () => ({ enabled: true }) })),
  withScope: vi.fn(),
  startSpanManual: vi.fn(),
}))
// electron/sentry.ts <-> electron/metrics.ts is a circular import (sentry.ts
// imports recordEvent from metrics.ts, metrics.ts imports sentryLogger from
// sentry.ts). Same seam electron/sentry.test.ts uses to break the cycle.
vi.mock('./metrics', () => ({
  recordEvent: vi.fn(),
  sentryLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  startInactiveSpan: vi.fn(),
}))

// Shape-based fixtures only — no path here overlaps a real os.homedir() value,
// so the main copy's HOME_DIRS branch cannot accidentally participate.
const SHAPE_FIXTURES = [
  '/home/ivan/app/dist-electron/main.js',
  '/Users/ivan/Library/Application Support/MailCopilot/main.js',
  'C:\\Users\\ivan\\AppData\\Local\\MailCopilot\\main.js',
  'C:\\Users\\Иван\\AppData\\Roaming\\app.js',
  'D:/Users/Иван/app.js',
  '/home/иван/app.js',
  '/usr/lib/electron/resources/app.asar/main.js',
  'node:internal/modules/cjs/loader',
  'app:///assets/index.js',
  '',
]

describe('scrubUserPaths parity — electron/sentry.ts vs src/sentry.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('produces byte-identical output for every shape-based fixture', async () => {
    // Pin os.homedir() so the main-only branch cannot introduce a difference
    // that has nothing to do with the shared shape-based regexes.
    const os = await import('node:os')
    vi.spyOn(os.default, 'homedir').mockReturnValue('/nonexistent-home-fixture-parity')
    vi.resetModules()

    const main = await import('./sentry')
    const renderer = await import('../src/sentry')

    for (const input of SHAPE_FIXTURES) {
      expect(main.scrubUserPaths(input)).toBe(renderer.scrubUserPaths(input))
    }
  })

  it('a drift introduced in only one copy is exactly what this test is meant to catch', async () => {
    // Not a real production assertion — a self-check that the comparison
    // above is actually discriminating and not vacuously true (e.g. because
    // both sides returned the same fixture unmodified). If this ever fails,
    // the parity test above has stopped being meaningful.
    const os = await import('node:os')
    vi.spyOn(os.default, 'homedir').mockReturnValue('/nonexistent-home-fixture-parity')
    vi.resetModules()

    const main = await import('./sentry')
    const renderer = await import('../src/sentry')

    const input = '/home/ivan/app/main.js'
    expect(main.scrubUserPaths(input)).not.toBe(input)
    expect(renderer.scrubUserPaths(input)).not.toBe(input)
  })

  it('both copies are idempotent on the same fixture set', async () => {
    const os = await import('node:os')
    vi.spyOn(os.default, 'homedir').mockReturnValue('/nonexistent-home-fixture-parity')
    vi.resetModules()

    const main = await import('./sentry')
    const renderer = await import('../src/sentry')

    for (const input of SHAPE_FIXTURES) {
      const mainOnce = main.scrubUserPaths(input)
      const rendererOnce = renderer.scrubUserPaths(input)
      expect(main.scrubUserPaths(mainOnce)).toBe(mainOnce)
      expect(renderer.scrubUserPaths(rendererOnce)).toBe(rendererOnce)
    }
  })
})
