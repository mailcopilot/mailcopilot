// @vitest-environment jsdom
/**
 * §2.127 (cross-family review HIGH-2, second batch) — Compose must not print a
 * raw rejection to the console.
 *
 * Why the console is not a private sink: the renderer keeps Sentry's default
 * integrations (`src/sentry.ts`), and console capture is one of them — every
 * argument becomes a breadcrumb and ships with the next event that passes
 * `beforeSend`. The text after the `[mcerr:*]` tag is deliberately left raw
 * (two consumers match substrings in it), so a hostile IMAP/SMTP server that
 * controls that text controls a field in our telemetry — the free third-party
 * prose CLAUDE.md §8 forbids.
 *
 * Three Compose paths swallow their failure and print a diagnostic line instead
 * of showing copy, so they never reach `presentedError` and had to be fixed
 * individually: contact upsert, contact search, and IMAP draft sync. Each is
 * driven here against the REAL component, with a unique marker planted in the
 * "server" text; the assertion walks every argument of every console call and
 * fails if the marker appears anywhere.
 *
 * The shape of the check is borrowed from src/utils/errorPresentation.test.ts
 * ("never hands %s to the console verbatim") rather than reinvented.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { ERROR_PRESENTATION_KEYS } from '@mailcopilot/core'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../sentry', () => ({ captureException: vi.fn() }))
vi.mock('../utils/metrics', () => ({
  recordEvent: vi.fn(),
  bucketBodySize: vi.fn(() => 'small'),
  bucketFollowupDays: vi.fn(() => '0'),
}))

import Compose from './Compose'

/** Unique token planted in the "server" text; must never reach the console. */
const MARKER = 'MARKER-9f3c1a-quota-exceeded'

/** A rejection shaped exactly like one that crossed `electron/ipc.ts`. */
function taggedRejection(): Error {
  return new Error(
    `[mcerr:auth] Error invoking remote method 'x': 535 5.7.8 ${MARKER} <img src=x onerror=alert(1)>`,
  )
}

const ACCOUNT = {
  id: 1,
  name: 'Acc',
  email: 'me@example.com',
  imap: { host: 'imap.example.com', port: 993, user: 'me@example.com', secure: true },
  smtp: { host: 'smtp.example.com', port: 465, user: 'me@example.com', secure: true },
  identities: [],
}

function defaultInvoke(channel: string): Promise<unknown> {
  switch (channel) {
    case 'settings:get':
      return Promise.resolve({ draftSyncEnabled: true, sendDelaySeconds: 0 })
    case 'compose:getInit':
      return Promise.resolve({ accountId: 1, init: null })
    case 'accounts:list':
      return Promise.resolve([ACCOUNT])
    case 'accounts:getCurrent':
      return Promise.resolve(1)
    case 'accounts:get':
      return Promise.resolve(ACCOUNT)
    case 'net:mailboxesAndRoles':
      return Promise.resolve({ roles: { drafts: 'Drafts' } })
    case 'cache:folderRoles':
      return Promise.resolve({})
    case 'drafts:wasSent':
      return Promise.resolve({ wasSent: false })
    case 'templates:list':
      return Promise.resolve([])
    case 'win:isMaximized':
      return Promise.resolve(false)
    default:
      return Promise.resolve(undefined)
  }
}

const mockInvoke = vi.fn(defaultInvoke)

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation(defaultInvoke)
  localStorage.clear()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Every argument of every console call, flattened for inspection. */
function consoleArgs(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  return spy.mock.calls.flat()
}

/**
 * The core assertion: nothing the "server" wrote reached the console, and the
 * only non-literal value printed is a closed-vocabulary verdict.
 */
function expectNoRawValueLogged(spy: ReturnType<typeof vi.spyOn>, ownLiteral: string): void {
  const args = consoleArgs(spy)
  expect(args.length).toBeGreaterThan(0)
  for (const arg of args) {
    expect(typeof arg).toBe('string')
    const text = arg as string
    expect(text).not.toContain(MARKER)
    expect(text).not.toContain('mcerr')
    expect(text).not.toContain('onerror')
    expect([ownLiteral, ...ERROR_PRESENTATION_KEYS]).toContain(text)
  }
  // …and the verdict itself was actually printed, so the line still diagnoses.
  expect(args).toContain('auth')
}

async function renderComposeSettled() {
  const view = render(React.createElement(Compose, {}))
  await waitFor(() => {
    expect(mockInvoke.mock.calls.some(c => c[0] === 'net:mailboxesAndRoles')).toBe(true)
  })
  return view
}

describe('Compose console diagnostics — verdict, never the value', () => {
  it('does not print the raw rejection when saving a contact fails', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'contacts:upsert') return Promise.reject(taggedRejection())
      return defaultInvoke(channel)
    })

    await renderComposeSettled()
    warnSpy.mockClear()

    const to = screen.getByTestId('compose-to') as HTMLInputElement
    fireEvent.focus(to)
    fireEvent.change(to, { target: { value: 'bob@example.com' } })
    fireEvent.keyDown(to, { key: 'Enter' })

    await waitFor(() => {
      expect(mockInvoke.mock.calls.some(c => c[0] === 'contacts:upsert')).toBe(true)
    })
    await waitFor(() => expect(warnSpy).toHaveBeenCalled())

    expectNoRawValueLogged(warnSpy, '[Compose] contact save failed:')
  })

  it('does not print the raw rejection when contact search fails', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'contacts:search') return Promise.reject(taggedRejection())
      return defaultInvoke(channel)
    })

    await renderComposeSettled()
    warnSpy.mockClear()

    const to = screen.getByTestId('compose-to') as HTMLInputElement
    fireEvent.focus(to)
    fireEvent.change(to, { target: { value: 'bo' } })

    // The search is debounced by 120 ms.
    await waitFor(() => {
      expect(mockInvoke.mock.calls.some(c => c[0] === 'contacts:search')).toBe(true)
    }, { timeout: 3000 })
    await waitFor(() => expect(warnSpy).toHaveBeenCalled())

    expectNoRawValueLogged(warnSpy, '[Compose] contact search failed:')
  })

  it('does not print the raw rejection when IMAP draft sync fails', async () => {
    // Widest exposure of the three: a Drafts folder the server dislikes
    // answers with its own prose every 1.5 s of typing.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:saveDraft') return Promise.reject(taggedRejection())
      return defaultInvoke(channel)
    })

    await renderComposeSettled()
    warnSpy.mockClear()

    fireEvent.change(screen.getByTestId('compose-subject'), { target: { value: 'hello' } })

    // Draft sync is debounced by 1500 ms.
    await waitFor(() => {
      expect(mockInvoke.mock.calls.some(c => c[0] === 'net:saveDraft')).toBe(true)
    }, { timeout: 8000 })
    await waitFor(() => expect(warnSpy).toHaveBeenCalled())

    expectNoRawValueLogged(warnSpy, '[Compose] draft sync failed:')
  }, 20000)
})
