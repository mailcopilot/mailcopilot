// @vitest-environment jsdom
/**
 * Unit tests for src/windows/Compose.tsx — §2.127 error presentation wiring.
 *
 * Scope: this file does NOT attempt full Compose coverage. Compose.tsx is a
 * 1700+ line window with a mount-time effect that sequentially calls ~10 IPC
 * channels (settings:get, compose:getInit, accounts:list/getCurrent/get,
 * net:mailboxesAndRoles, cache:folderRoles, drafts:wasSent, ...) plus draft
 * restoration from localStorage. A same-quality full harness (every send
 * variant, scheduling, templates, misdirection warnings, identity matching)
 * is a dedicated task of its own, not a byproduct of a `String(e)` →
 * `presentedError(t, e)` substitution.
 *
 * What IS tested here, against the REAL component (no hand-copied logic):
 *   - the mount-time init effect's outer catch (`electron/ipc.ts` §2.127 tag
 *     decoding) renders the closed-vocabulary sentence, never the tagged
 *     string or the server's own text;
 *   - the local, never-tagged attachment-read failure (FileReader/Blob error,
 *     which never crosses IPC) still renders a vocabulary sentence rather
 *     than a raw DOMException/Error message.
 *
 * The other four `presentedError(t, e)` call sites in Compose.tsx (send /
 * send-and-archive / scheduleSend / scheduleSendAt) share the exact same
 * one-line call as the two paths covered here and as Account.tsx / MailWindow.tsx
 * (already covered elsewhere in this batch) — reaching them additionally
 * requires driving the full send flow (draftId + accountId + recipient
 * validation + misdirection dialog) for marginal signal over what is already
 * proven: presentedError() itself is unit-tested in
 * src/utils/errorPresentation.test.ts, and the call signature is
 * compile-time-checked (`Translate` argument order cannot be swapped without
 * a type error, since `e: unknown` cannot satisfy a function-typed parameter).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

// Real locale strings — a missing/renamed key fails the test instead of
// silently rendering the raw dot-path key (same approach as Account.test.tsx).
import en from '../i18n/locales/en.json'

function lookup(key: string): string | undefined {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
  ) as string | undefined
}

const stableT = (key: string, vars?: Record<string, unknown>): string => {
  const raw = lookup(key)
  if (raw === undefined) return key
  if (!vars) return raw
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => (
    vars[name] !== undefined ? String(vars[name]) : `{{${name}}}`
  ))
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

vi.mock('../sentry', () => ({ captureException: vi.fn() }))
vi.mock('../utils/metrics', () => ({
  recordEvent: vi.fn(),
  bucketBodySize: vi.fn(() => 'small'),
  bucketFollowupDays: vi.fn(() => '0'),
}))

import Compose from './Compose'

// ---------------------------------------------------------------------------
// window.api mock — sane defaults for every channel the mount-time effect
// touches, so a test that does not care about the init flow still settles.
// ---------------------------------------------------------------------------

const mockOn = vi.fn()
const mockOff = vi.fn()

function defaultInvoke(channel: string): Promise<unknown> {
  switch (channel) {
    case 'settings:get':
      return Promise.resolve({ draftSyncEnabled: true, sendDelaySeconds: 0 })
    case 'compose:getInit':
      return Promise.resolve({ accountId: 1, init: null })
    case 'accounts:list':
      return Promise.resolve([])
    case 'accounts:getCurrent':
      return Promise.resolve(undefined)
    case 'accounts:get':
      return Promise.resolve(undefined)
    case 'net:mailboxesAndRoles':
      return Promise.resolve({ roles: {} })
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
  value: { invoke: mockInvoke, on: mockOn, off: mockOff, removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

function renderCompose() {
  return render(React.createElement(Compose, {}))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation(defaultInvoke)
  localStorage.clear()
})

afterEach(cleanup)

describe('Compose §2.127 — error presentation', () => {
  it('renders the closed-vocabulary sentence for a tagged init-fetch failure, never the tag or the server text', async () => {
    // The mount-time effect's FIRST await is settings:get, with no inner
    // try/catch around it — a rejection here is the cheapest way to reach the
    // outer catch (`setError(presentedError(tRef.current, e))`) without
    // driving the rest of the ~10-call init sequence.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') {
        return Promise.reject(
          new Error("[mcerr:auth] Error invoking remote method 'settings:get': Invalid credentials"),
        )
      }
      return defaultInvoke(channel)
    })

    renderCompose()

    const banner = await screen.findByTestId('compose-error')
    expect(banner).toHaveTextContent(lookup('app.errors.presented.auth')!)
    expect(document.body.textContent).not.toContain('mcerr')
    expect(document.body.textContent).not.toContain('Invalid credentials')
  })

  it('renders the neutral vocabulary sentence for an offline-tagged failure', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') {
        return Promise.reject(new Error("[mcerr:offline] Error invoking remote method 'settings:get': AggregateError"))
      }
      return defaultInvoke(channel)
    })

    renderCompose()

    const banner = await screen.findByTestId('compose-error')
    expect(banner).toHaveTextContent(lookup('app.errors.presented.offline')!)
    expect(document.body.textContent).not.toContain('AggregateError')
  })

  it('presents a local, never-tagged attachment-read failure through the same closed vocabulary', async () => {
    const { container } = renderCompose()

    // Let the init effect settle first (all defaults succeed) so the
    // attachment error is not masked by an init-time banner.
    await waitFor(() => {
      expect(mockInvoke.mock.calls.some(c => c[0] === 'compose:getInit')).toBe(true)
    })

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()

    const hostileFile = new File(['hello'], 'photo.png', { type: 'image/png' })
    // FileReader/Blob failure (e.g. the OS revoked access mid-read) never
    // crosses IPC, so it can never carry an `[mcerr:...]` tag — this is the
    // renderer-local fallback path in decodeErrorPresentation.
    Object.defineProperty(hostileFile, 'arrayBuffer', {
      value: () => Promise.reject(new Error('NotReadableError: could not read file')),
    })
    Object.defineProperty(fileInput, 'files', { value: [hostileFile] })

    fireEvent.change(fileInput)

    const banner = await screen.findByTestId('compose-error')
    expect(banner).toHaveTextContent(lookup('app.errors.presented.unknown')!)
    expect(document.body.textContent).not.toContain('NotReadableError')
  })

  it('shows an oversized attachment as translated copy, not a presentedError vocabulary sentence', async () => {
    // Regression guard for the boundary right next to the presentedError
    // call: `compose.errors.fileTooLarge` is set directly via `t(...)`, NOT
    // via presentedError — this is OUR copy about a size limit WE enforce,
    // not a third party's failure, and must not be swallowed into "unknown".
    const { container } = renderCompose()
    await waitFor(() => {
      expect(mockInvoke.mock.calls.some(c => c[0] === 'compose:getInit')).toBe(true)
    })

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const oversized = new File([new Uint8Array(26 * 1024 * 1024)], 'huge.bin', { type: 'application/octet-stream' })
    Object.defineProperty(fileInput, 'files', { value: [oversized] })

    fireEvent.change(fileInput)

    const banner = await screen.findByTestId('compose-error')
    expect(banner.textContent).toContain('huge.bin')
    expect(banner.textContent).not.toBe(lookup('app.errors.presented.unknown'))
  })
})
