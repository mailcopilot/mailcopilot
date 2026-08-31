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
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
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

// ---------------------------------------------------------------------------
// §3.3 B6.f-renderer — the AI toolbar's reset key against the REAL window.
//
// This is the one place the defect was observable: the toolbar becomes
// interactive as soon as `accountId` is known, but the mount-time effect only
// reaches `setDraftId` after `accounts:get`, `net:mailboxesAndRoles` and the
// draft-pointer checks. While `draftId` was the reset key, the `'' → real id`
// transition landed in that window and threw away whatever the user had done
// meanwhile — a language pick, or a translation already paid for.
//
// The hook's own tests cannot cover this: they take the key as a prop and
// cannot know when the window changes it. The assertion here is specifically
// that the window hands the toolbar something that does NOT move during init.
// ---------------------------------------------------------------------------
describe('Compose §3.3 B6 — a translate pick made before the draft id lands survives it', () => {
  it('keeps the picked language and the in-flight translation across the draft id landing', async () => {
    let releaseRoles: (() => void) | null = null
    const rolesGate = new Promise<void>(resolve => { releaseRoles = resolve })
    let releaseTranslate: ((value: unknown) => void) | null = null

    mockInvoke.mockImplementation((channel: string) => {
      switch (channel) {
        case 'settings:get':
          return Promise.resolve({
            draftSyncEnabled: false,
            sendDelaySeconds: 0,
            aiTranslateEnabled: { '1': true },
          })
        case 'compose:getInit':
          return Promise.resolve({ accountId: 1, init: null })
        case 'accounts:list':
          return Promise.resolve([{ id: 1, email: 'me@example.com' }])
        case 'accounts:getCurrent':
          return Promise.resolve(1)
        case 'accounts:get':
          return Promise.resolve({ id: 1, email: 'me@example.com', identities: [] })
        // Held open: everything that mints the draft id sits behind this await.
        case 'net:mailboxesAndRoles':
          return rolesGate.then(() => ({ roles: {} }))
        case 'ai:translate:draft':
          return new Promise(resolve => { releaseTranslate = resolve })
        default:
          return defaultInvoke(channel)
      }
    })

    renderCompose()

    // The account is known, so the translate control is live — while the draft
    // id is still empty.
    await waitFor(() => expect(screen.getByTestId('compose-translate-target')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('compose-text'), { target: { value: 'my own text' } })
    fireEvent.change(screen.getByTestId('compose-translate-target'), { target: { value: 'fr' } })
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('fr')

    // ...and the user pays for a translation right there.
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith(
      'ai:translate:draft',
      expect.objectContaining({ accountId: 1, targetLang: 'fr' }),
    ))

    // Let the rest of the init through. `setDraftId` runs on the far side of
    // this await; the autosave writing a `mailcopilot:draft:<id>` entry is the
    // observable proof that a real, non-empty id actually landed — without it
    // this test would pass vacuously against the old code too.
    releaseRoles!()
    await waitFor(
      () => expect(
        Object.keys(localStorage).some(k => k.startsWith('mailcopilot:draft:')),
      ).toBe(true),
      { timeout: 3000 },
    )

    // Neither the pick nor the request noticed.
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('fr')
    releaseTranslate!({
      ok: true,
      translation: { translatedText: 'Ma propre réponse.', targetLang: 'fr', provider: 'p' },
    })
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    expect(screen.getByTestId('quick-action-diff-after')).toHaveTextContent('Ma propre réponse.')
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f2 — the mount-time init is an AWAIT CHAIN, and a `compose:init` for
// another message can land inside it.
//
// The window is reused by pushing `compose:init` into an already-open Compose.
// That handler bumps the epoch and writes the new message's account, recipients
// and body synchronously. The mount-time `compose:getInit` continuation, still
// suspended on `accounts:list` / `accounts:getCurrent`, then resumes holding the
// PREVIOUS message's context — and it used to write the sender (and everything
// derived from it: identities, signature, Drafts mailbox) unguarded, while the
// recipients on screen belonged to the new one. A form addressed to B, sent
// from A. The guard is the same epoch snapshot the early field initialization
// two dozen lines above already uses.
// ---------------------------------------------------------------------------
describe('Compose §3.3 B6.f2 — a stale getInit continuation cannot re-seat the sender', () => {
  const ACCOUNTS = [
    { id: 1, email: 'ann@one.example', smtp: { user: '' }, imap: { user: '' } },
    { id: 2, email: 'bob@two.example', smtp: { user: '' }, imap: { user: '' } },
  ]

  it('keeps the pushed message\'s account when the mount-time init resolves after it', async () => {
    let releaseCurrent: ((value: unknown) => void) | null = null

    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'settings:get':
          return Promise.resolve({ draftSyncEnabled: false, sendDelaySeconds: 0 })
        // The message the window was opened for: account 1.
        case 'compose:getInit':
          return Promise.resolve({ accountId: 1, init: { to: 'ann-recipient@one.example' } })
        case 'accounts:list':
          return Promise.resolve(ACCOUNTS)
        // Held open: `setAccountId` and everything after it sits behind this.
        case 'accounts:getCurrent':
          return new Promise(resolve => { releaseCurrent = resolve })
        case 'accounts:get':
          return Promise.resolve(ACCOUNTS.find(a => a.id === args[0]))
        default:
          return defaultInvoke(channel)
      }
    })

    renderCompose()

    // The chain is now suspended mid-flight, with account 1's context in hand.
    await waitFor(() => expect(releaseCurrent).not.toBeNull())
    await waitFor(() => expect(screen.getByTestId('compose-from')).toBeInTheDocument())

    // A `compose:init` for a DIFFERENT message on account 2 is pushed in.
    const onInit = mockOn.mock.calls.find(c => c[0] === 'compose:init')?.[1] as (p: unknown) => void
    expect(typeof onInit).toBe('function')
    await act(async () => {
      onInit({ accountId: 2, init: { to: 'bob-recipient@two.example', subject: 'For Bob' } })
    })
    expect(screen.getByTestId('compose-to')).toHaveValue('bob-recipient@two.example')
    expect(screen.getByTestId('compose-from')).toHaveAttribute('data-selected-value', '2')

    // Now the stale continuation finishes. Everything it holds — the account,
    // the sender address, the identities, the Drafts mailbox — describes the
    // message this form is no longer showing.
    await act(async () => {
      releaseCurrent!(1)
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('compose-from')).toHaveAttribute('data-selected-value', '2')
    expect(screen.getByTestId('compose-to')).toHaveValue('bob-recipient@two.example')
    expect(screen.getByTestId('compose-subject')).toHaveValue('For Bob')
  })

  it('does not seat the previous account\'s identities from a late accounts:get', async () => {
    // Second guard on the same chain: the epoch is re-checked after EVERY
    // await, not once before them, because the event can land during any one
    // of them — and this is the await that resolves the From line itself.
    // (The third, after `net:mailboxesAndRoles`, is the identical one-liner
    // guarding `draftsMailbox` / `archiveFolder`; those have no renderer-side
    // rendering to assert against, so they ride on this same pattern.)
    let releaseMeta: ((value: unknown) => void) | null = null
    const metaGate = new Promise<unknown>(resolve => { releaseMeta = resolve })

    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'settings:get':
          return Promise.resolve({ draftSyncEnabled: false, sendDelaySeconds: 0 })
        case 'compose:getInit':
          return Promise.resolve({ accountId: 1, init: { to: 'ann-recipient@one.example' } })
        case 'accounts:list':
          return Promise.resolve(ACCOUNTS)
        case 'accounts:getCurrent':
          return Promise.resolve(1)
        case 'accounts:get':
          // Account 1 (the message the window was opened for) answers late and
          // brings TWO identities — which is what makes the picker appear.
          return args[0] === 1 ? metaGate : Promise.resolve({ ...ACCOUNTS[1], identities: [] })
        default:
          return defaultInvoke(channel)
      }
    })

    renderCompose()
    await waitFor(() => expect(releaseMeta).not.toBeNull())
    await waitFor(() => expect(screen.getByTestId('compose-from')).toBeInTheDocument())

    const onInit = mockOn.mock.calls.find(c => c[0] === 'compose:init')?.[1] as (p: unknown) => void
    await act(async () => {
      onInit({ accountId: 2, init: { to: 'bob-recipient@two.example' } })
    })

    await act(async () => {
      releaseMeta!({
        ...ACCOUNTS[0],
        identities: [
          { id: 'i1', name: 'Ann', email: 'ann@one.example', isDefault: true },
          { id: 'i2', name: 'Ann alt', email: 'ann+alt@one.example', isDefault: false },
        ],
      })
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // Account 2 has no identity list, so a visible picker means account 1's
    // identities were written under account 2's recipients.
    expect(screen.queryByTestId('compose-identity')).not.toBeInTheDocument()
    expect(screen.getByTestId('compose-from')).toHaveAttribute('data-selected-value', '2')
    expect(screen.getByTestId('compose-to')).toHaveValue('bob-recipient@two.example')
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f3 — the FIFTH await of the same chain.
//
// The `drafts:wasSent` round trip sits at the very bottom of the mount-time
// init, past four guards, and was the only await in the chain without one. Its
// continuation writes `setDraftId`, the per-account "last draft" pointer and —
// on the restore branch — the recipients, subject and body of a local draft
// belonging to the account the window was opened for. Landing that in a form
// already re-initialized for another message on another account does not just
// look wrong on screen: autosave then pushes that text to the CURRENT account's
// Drafts mailbox, i.e. to a different provider's server.
//
// The window this defect lives in got WIDER in this batch: the reply path now
// waits for a language suggestion before `compose:init` is delivered, which
// lands the event later in the chain — right where the unguarded await is.
// ---------------------------------------------------------------------------
describe('Compose §3.3 B6.f3 — a stale drafts:wasSent continuation cannot restore another account\'s draft', () => {
  const ACCOUNTS = [
    { id: 1, email: 'ann@one.example', smtp: { user: '' }, imap: { user: '' } },
    { id: 2, email: 'bob@two.example', smtp: { user: '' }, imap: { user: '' } },
  ]
  const A_DRAFT_ID = 'draft-of-account-one'
  const A_SECRET = 'Ann’s unsent private text'

  function seedAccountOneDraft() {
    localStorage.setItem(`mailcopilot:draft:last:1`, A_DRAFT_ID)
    localStorage.setItem(`mailcopilot:draft:${A_DRAFT_ID}`, JSON.stringify({
      to: 'ann-private@one.example',
      cc: '',
      bcc: '',
      subject: 'Ann private subject',
      text: A_SECRET,
      updatedAt: new Date().toISOString(),
    }))
  }

  it('keeps the pushed message\'s fields when drafts:wasSent answers after a newer compose:init', async () => {
    seedAccountOneDraft()
    let releaseWasSent: ((value: unknown) => void) | null = null

    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'settings:get':
          return Promise.resolve({ draftSyncEnabled: false, sendDelaySeconds: 0 })
        // A FRESH compose for account 1 — the branch that consults the
        // per-account pointer and therefore reaches `drafts:wasSent`.
        case 'compose:getInit':
          return Promise.resolve({ accountId: 1, init: null })
        case 'accounts:list':
          return Promise.resolve(ACCOUNTS)
        case 'accounts:getCurrent':
          return Promise.resolve(1)
        case 'accounts:get':
          return Promise.resolve(ACCOUNTS.find(a => a.id === args[0]))
        case 'net:mailboxesAndRoles':
          return Promise.resolve({ roles: {} })
        // Held open: the whole draft-id decision sits behind this one await.
        case 'drafts:wasSent':
          return new Promise(resolve => { releaseWasSent = resolve })
        default:
          return defaultInvoke(channel)
      }
    })

    renderCompose()
    await waitFor(() => expect(releaseWasSent).not.toBeNull())

    // The window is reused for a reply on account 2 while the chain is
    // suspended on `drafts:wasSent` for account 1.
    const onInit = mockOn.mock.calls.find(c => c[0] === 'compose:init')?.[1] as (p: unknown) => void
    expect(typeof onInit).toBe('function')
    await act(async () => {
      onInit({
        accountId: 2,
        init: { to: 'bob-recipient@two.example', subject: 'For Bob', text: 'Hi Bob,' },
      })
    })
    expect(screen.getByTestId('compose-from')).toHaveAttribute('data-selected-value', '2')

    // The stale continuation finishes, and main says the pointer is still live
    // — the exact answer that makes it restore account 1's local draft.
    await act(async () => {
      releaseWasSent!({ wasSent: false })
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('compose-to')).toHaveValue('bob-recipient@two.example')
    expect(screen.getByTestId('compose-subject')).toHaveValue('For Bob')
    expect(screen.getByTestId('compose-text')).toHaveValue('Hi Bob,')
    expect(screen.getByTestId('compose-from')).toHaveAttribute('data-selected-value', '2')
    // Nothing of account 1's draft reached the form, by any route.
    expect(document.body.textContent).not.toContain(A_SECRET)
    expect(document.body.textContent).not.toContain('Ann private subject')
    expect(screen.queryByText(lookup('compose.status.draftRestored')!)).not.toBeInTheDocument()
  })

  it('does not re-point the draft id at the previous account\'s draft, so autosave writes elsewhere', async () => {
    // The second half of the damage, and the one the user never sees: even with
    // the fields intact, a stale `setDraftId(lastDraftId)` makes the autosave
    // running under account 2 overwrite account 1's stored draft — and then
    // upload it to account 2's Drafts mailbox.
    seedAccountOneDraft()
    let releaseWasSent: ((value: unknown) => void) | null = null

    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'settings:get':
          return Promise.resolve({ draftSyncEnabled: false, sendDelaySeconds: 0 })
        case 'compose:getInit':
          return Promise.resolve({ accountId: 1, init: null })
        case 'accounts:list':
          return Promise.resolve(ACCOUNTS)
        case 'accounts:getCurrent':
          return Promise.resolve(1)
        case 'accounts:get':
          return Promise.resolve(ACCOUNTS.find(a => a.id === args[0]))
        case 'net:mailboxesAndRoles':
          return Promise.resolve({ roles: {} })
        case 'drafts:wasSent':
          return new Promise(resolve => { releaseWasSent = resolve })
        default:
          return defaultInvoke(channel)
      }
    })

    renderCompose()
    await waitFor(() => expect(releaseWasSent).not.toBeNull())

    const onInit = mockOn.mock.calls.find(c => c[0] === 'compose:init')?.[1] as (p: unknown) => void
    await act(async () => {
      onInit({ accountId: 2, init: { to: 'bob-recipient@two.example', subject: 'For Bob', text: 'Hi Bob,' } })
    })
    await act(async () => {
      releaseWasSent!({ wasSent: false })
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // Type into the reused window and let the autosave debounce elapse.
    fireEvent.change(screen.getByTestId('compose-text'), { target: { value: 'Hi Bob, one more line.' } })
    await waitFor(() => {
      const written = Object.keys(localStorage).filter(k => (
        k.startsWith('mailcopilot:draft:')
        && !k.startsWith('mailcopilot:draft:last')
        && (localStorage.getItem(k) || '').includes('Hi Bob, one more line.')
      ))
      expect(written.length).toBe(1)
    }, { timeout: 3000 })

    const annDraft = localStorage.getItem(`mailcopilot:draft:${A_DRAFT_ID}`) || ''
    expect(annDraft).toContain(A_SECRET)
    expect(annDraft).not.toContain('Hi Bob')
  })
})
