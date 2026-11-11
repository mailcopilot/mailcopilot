// @vitest-environment jsdom
/**
 * Unit tests for src/windows/Account.tsx — §2.94 OAuth waiting step.
 *
 * Scope (see BACKLOG §2.94 / the diff this covers):
 *   - `wizardStep` transitions into/out of the new 'oauth' step: selecting
 *     Gmail/Outlook leaves the picker immediately and starts the matching
 *     connect flow; a failed connect hands the wizard back to the picker
 *     instead of stranding the user on a spinner that never resolves; a
 *     retry after failure is not blocked by leftover state (no "stuck" wizard).
 *   - The `oauth:progress` subscription: registered exactly once on mount
 *     (mount-once effect, deps `[]` — a re-subscribing effect would leak one
 *     listener per render, same failure mode as the runaway-tabs incident,
 *     §2.25), unregistered with the *same* handler reference on unmount, and
 *     filters out payloads that do not match the `OAuthProgress` shape
 *     (unknown provider, stage outside the known set, null/non-object
 *     payload) as well as progress belonging to a flow this window did not
 *     start, so neither a malformed nor a foreign broadcast can corrupt the
 *     waiting step's state.
 *
 * NOT covered here: the main-process side of the Google OAuth handler. It
 * lives in electron/services/googleConnectService.ts (injected dependencies)
 * and is exercised in electron/services/googleConnectService.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

// Real locale strings — a missing/renamed key must fail a test rather than
// silently render the raw dot-path key (same approach as OAuthWaiting.test.tsx).
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
// `language` is mutable so the FAQ-link tests can switch it (§2.297).
const stableUseTranslation = { t: stableT, i18n: { language: 'en' } }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

vi.mock('../sentry', () => ({ captureException: vi.fn() }))

import Account from './Account'

// ---------------------------------------------------------------------------
// window.api mock
// ---------------------------------------------------------------------------

function makeDeferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let googleConnect: ReturnType<typeof makeDeferred<unknown>>
/** Reply of `oauth:google:availability` (§2.297). The hook is fail-closed, so
 *  every Google-flow test needs an explicit "sign-in allowed" answer. */
let googleAvailability: unknown = { configured: true, newMailboxes: true }
let microsoftConnect: ReturnType<typeof makeDeferred<unknown>>

const mockOn = vi.fn()
const mockOff = vi.fn()
const mockInvoke = vi.fn((channel: string) => {
  if (channel === 'accounts:list') return Promise.resolve([])
  if (channel === 'oauth:google:availability') return Promise.resolve(googleAvailability)
  if (channel === 'win:isMaximized') return Promise.resolve(false)
  if (channel === 'oauth:google:connect') return googleConnect.promise
  if (channel === 'oauth:microsoft:connect') return microsoftConnect.promise
  return Promise.resolve(undefined)
})

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff, removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

/** Every `oauth:progress` handler the component registered via window.api.on. */
function progressOnCalls(): Array<[string, (payload: unknown) => void]> {
  return (mockOn.mock.calls as Array<[string, (payload: unknown) => void]>)
    .filter(c => c[0] === 'oauth:progress')
}

function getProgressHandler(): (payload: unknown) => void {
  const calls = progressOnCalls()
  if (calls.length === 0) throw new Error('oauth:progress listener was not registered')
  return calls[calls.length - 1][1]
}

function renderAccount() {
  return render(React.createElement(Account, {}))
}

/** Counts accounts:list calls so a test can fail only the post-save refresh. */
let listCallCount = 0

const defaultInvoke = (channel: string) => {
  if (channel === 'accounts:list') return Promise.resolve([])
  if (channel === 'oauth:google:availability') return Promise.resolve(googleAvailability)
  if (channel === 'win:isMaximized') return Promise.resolve(false)
  if (channel === 'oauth:google:connect') return googleConnect.promise
  if (channel === 'oauth:microsoft:connect') return microsoftConnect.promise
  return Promise.resolve(undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  googleConnect = makeDeferred()
  microsoftConnect = makeDeferred()
  googleAvailability = { configured: true, newMailboxes: true }
  listCallCount = 0
  stableUseTranslation.i18n.language = 'en'
  mockInvoke.mockImplementation(defaultInvoke)
})

afterEach(cleanup)

describe('Account wizard oauth step §2.94', () => {
  describe('wizardStep transitions', () => {
    it('leaves the provider picker and shows the waiting step when Gmail is selected', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')

      fireEvent.click(document.getElementById('provider-card-gmail')!)

      expect(await screen.findByTestId('account-wizard-oauth-waiting')).toBeInTheDocument()
      expect(screen.queryByTestId('account-wizard-provider')).not.toBeInTheDocument()
      expect(mockInvoke).toHaveBeenCalledWith('oauth:google:connect', undefined)
    })

    it('leaves the provider picker and shows the waiting step when Outlook is selected', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')

      fireEvent.click(document.getElementById('provider-card-outlook')!)

      expect(await screen.findByTestId('account-wizard-oauth-waiting')).toBeInTheDocument()
      expect(screen.queryByTestId('account-wizard-provider')).not.toBeInTheDocument()
      expect(mockInvoke).toHaveBeenCalledWith('oauth:microsoft:connect', undefined)
    })

    it('does not route the generic IMAP/SMTP provider through the oauth waiting step', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')

      fireEvent.click(document.getElementById('provider-card-generic-imap')!)

      expect(await screen.findByTestId('account-wizard-type')).toBeInTheDocument()
      expect(screen.queryByTestId('account-wizard-oauth-waiting')).not.toBeInTheDocument()
      expect(mockInvoke).not.toHaveBeenCalledWith('oauth:google:connect', expect.anything())
      expect(mockInvoke).not.toHaveBeenCalledWith('oauth:microsoft:connect', expect.anything())
    })

    it('hands the wizard back to the provider picker when the Google connect flow rejects', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')

      await act(async () => {
        googleConnect.reject(new Error('boom'))
        await googleConnect.promise.catch(() => { /* expected */ })
      })

      // Picker is back and the waiting step is gone — nothing spins forever.
      expect(screen.getByTestId('account-wizard-provider')).toBeInTheDocument()
      expect(screen.queryByTestId('account-wizard-oauth-waiting')).not.toBeInTheDocument()
      // §2.127: the banner states the failure in our own words; the rejection
      // text ('boom' here, provider prose in production) is not rendered.
      expect(screen.getByText(lookup('app.errors.presented.unknown')!)).toBeInTheDocument()
      expect(screen.queryByText(/boom/)).not.toBeInTheDocument()
    })

    it('hands the wizard back to the provider picker when the Microsoft connect flow rejects', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-outlook')!)
      await screen.findByTestId('account-wizard-oauth-waiting')

      await act(async () => {
        microsoftConnect.reject(new Error('kaboom'))
        await microsoftConnect.promise.catch(() => { /* expected */ })
      })

      expect(screen.getByTestId('account-wizard-provider')).toBeInTheDocument()
      expect(screen.queryByTestId('account-wizard-oauth-waiting')).not.toBeInTheDocument()
      expect(screen.getByText(lookup('app.errors.presented.unknown')!)).toBeInTheDocument()
      expect(screen.queryByText(/kaboom/)).not.toBeInTheDocument()
    })

    it('allows retrying after a failed connect instead of getting stuck', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')

      await act(async () => {
        googleConnect.reject(new Error('first attempt failed'))
        await googleConnect.promise.catch(() => { /* expected */ })
      })
      await screen.findByTestId('account-wizard-provider')

      // Retry: a second click must be able to start a fresh flow, not be a
      // no-op left over from the first attempt's now-settled promise.
      googleConnect = makeDeferred()
      fireEvent.click(document.getElementById('provider-card-gmail')!)

      expect(await screen.findByTestId('account-wizard-oauth-waiting')).toBeInTheDocument()
      expect(mockInvoke).toHaveBeenCalledWith('oauth:google:connect', undefined)
    })
  })

  describe('oauth:progress subscription', () => {
    it('subscribes exactly once on mount, even across later re-renders', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      expect(progressOnCalls()).toHaveLength(1)

      // Selecting a provider re-renders the tree several times (form state,
      // wizardStep, connecting flags). The mount-once effect (deps `[]`) must
      // not add a second listener on any of those re-renders.
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      expect(progressOnCalls()).toHaveLength(1)
    })

    it('unsubscribes the exact same handler reference on unmount', async () => {
      const { unmount } = renderAccount()
      await screen.findByTestId('account-wizard-provider')
      const handler = getProgressHandler()

      unmount()

      const offCalls = (mockOff.mock.calls as Array<[string, unknown]>)
        .filter(c => c[0] === 'oauth:progress')
      expect(offCalls).toHaveLength(1)
      expect(offCalls[0][1]).toBe(handler)
    })

    it('updates the waiting step from a well-formed broadcast', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      const handler = getProgressHandler()

      act(() => { handler({ provider: 'gmail', stage: 'imap' }) })

      expect(screen.getByTestId('account-wizard-oauth-stage').textContent)
        .toBe(stableT('account.wizard.oauthWaiting.stage.imap'))
    })

    it('ignores a broadcast for a provider other than gmail/outlook', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      const handler = getProgressHandler()
      const before = screen.getByTestId('account-wizard-oauth-stage').textContent

      act(() => { handler({ provider: 'yahoo', stage: 'imap' }) })

      expect(screen.getByTestId('account-wizard-oauth-stage').textContent).toBe(before)
    })

    it('ignores a broadcast whose stage is not a string', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      const handler = getProgressHandler()
      const before = screen.getByTestId('account-wizard-oauth-stage').textContent

      act(() => { handler({ provider: 'gmail', stage: 42 }) })

      expect(screen.getByTestId('account-wizard-oauth-stage').textContent).toBe(before)
    })

    it('tolerates null and non-object payloads without throwing or changing state', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      const handler = getProgressHandler()
      const before = screen.getByTestId('account-wizard-oauth-stage').textContent

      expect(() => act(() => { handler(null) })).not.toThrow()
      expect(() => act(() => { handler('not-an-object') })).not.toThrow()
      expect(() => act(() => { handler(42) })).not.toThrow()

      expect(screen.getByTestId('account-wizard-oauth-stage').textContent).toBe(before)
    })

    // codex-bg-review Low #1: an unrecognised stage used to be accepted and
    // interpolated into a translation key, rendering the raw dot-path.
    it('ignores a stage outside the known set instead of rendering a raw key', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      const handler = getProgressHandler()
      const before = screen.getByTestId('account-wizard-oauth-stage').textContent

      act(() => { handler({ provider: 'gmail', stage: 'bogus' }) })

      const after = screen.getByTestId('account-wizard-oauth-stage').textContent
      expect(after).toBe(before)
      expect(after).not.toContain('account.wizard')
    })

    // codex-bg-review Medium #3: the broadcast reaches every window and both
    // providers have independent mutexes, so a flow this window did not start
    // must not drive its waiting step.
    it('ignores progress from a provider whose flow this window did not start', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      const handler = getProgressHandler()
      const before = screen.getByTestId('account-wizard-oauth-stage').textContent

      act(() => { handler({ provider: 'outlook', stage: 'saving' }) })

      expect(screen.getByTestId('account-wizard-oauth-stage').textContent).toBe(before)
    })

    // codex-bg-review (final pass) Low #2: `accountPersisted` correctly stops
    // the return-to-picker, but the waiting step then had no terminal state —
    // a failing accounts:list refresh left the spinner up forever.
    it('leaves the waiting step for the saved account when a post-save step fails', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'accounts:list') {
          // First call (initial load) succeeds; the post-save refresh rejects.
          return listCallCount++ === 0
            ? Promise.resolve([])
            : Promise.reject(new Error('store unavailable'))
        }
        return defaultInvoke(channel)
      })

      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      await screen.findByTestId('account-wizard-oauth-waiting')

      await act(async () => {
        googleConnect.resolve({ ok: true, id: 7, email: 'user@gmail.com' })
        await Promise.resolve()
      })

      // The spinner must be gone: the account exists, only a renderer step failed.
      await waitFor(() => {
        expect(screen.queryByTestId('account-wizard-oauth-waiting')).not.toBeInTheDocument()
      })
      // And we must NOT be back on the picker — that would invite a duplicate.
      expect(screen.queryByTestId('account-wizard-provider')).not.toBeInTheDocument()
    })

    it('accepts progress again once the matching flow is the active one', async () => {
      renderAccount()
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-outlook')!)
      await screen.findByTestId('account-wizard-oauth-waiting')
      const handler = getProgressHandler()

      act(() => { handler({ provider: 'outlook', stage: 'smtp' }) })

      expect(screen.getByTestId('account-wizard-oauth-stage').textContent)
        .toBe(stableT('account.wizard.oauthWaiting.stage.smtp'))
    })
  })
})

/**
 * §2.127 — every rejection that crosses electron/ipc.ts arrives prefixed with a
 * machine tag (`[mcerr:<key>] `), and the wizard used to render that text
 * verbatim: on a wrong password the very first screen a new user meets would
 * read "[mcerr:auth] Error invoking remote method 'accounts:save': ...".
 */
describe('Account §2.127 — error presentation', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // The presentation helper deliberately keeps the raw value in DevTools.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { consoleError.mockRestore() })

  it('never renders the machine tag or the server text of a tagged connect rejection', async () => {
    renderAccount()
    await screen.findByTestId('account-wizard-provider')
    fireEvent.click(document.getElementById('provider-card-gmail')!)
    await screen.findByTestId('account-wizard-oauth-waiting')

    await act(async () => {
      googleConnect.reject(new Error("[mcerr:auth] Error invoking remote method 'oauth:google:connect': Invalid credentials — call +1-800-NOT-US"))
      await googleConnect.promise.catch(() => { /* expected */ })
    })

    expect(screen.getByText(lookup('app.errors.presented.auth')!)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('mcerr')
    expect(document.body.textContent).not.toContain('+1-800-NOT-US')
    // Raw value still available for diagnostics.
    expect(consoleError).toHaveBeenCalled()
  })

  it('keeps our own translated copy when the connect flow reports ok:false', async () => {
    renderAccount()
    await screen.findByTestId('account-wizard-provider')
    fireEvent.click(document.getElementById('provider-card-outlook')!)
    await screen.findByTestId('account-wizard-oauth-waiting')

    await act(async () => {
      microsoftConnect.resolve({ ok: false, id: 0, email: '' })
      await Promise.resolve()
    })

    // TranslatedError path: the vocabulary must NOT overwrite a sentence this
    // window authored itself.
    await waitFor(() => {
      expect(screen.getByText(lookup('account.errors.microsoftOAuthFailed')!)).toBeInTheDocument()
    })
    expect(screen.queryByText(lookup('app.errors.presented.unknown')!)).not.toBeInTheDocument()
  })

  it('presents a tagged accounts:list failure on the initial load', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'accounts:list') {
        return Promise.reject(new Error("[mcerr:offline] Error invoking remote method 'accounts:list': AggregateError"))
      }
      return defaultInvoke(channel)
    })

    renderAccount()

    await waitFor(() => {
      expect(screen.getByText(lookup('app.errors.presented.offline')!)).toBeInTheDocument()
    })
    expect(document.body.textContent).not.toContain('mcerr')
    expect(document.body.textContent).not.toContain('AggregateError')
  })
})

// ---------------------------------------------------------------------------
// §2.127 side effect: `load` now depends on `t` (presentedError needs it),
// so a language switch — which gives react-i18next's `t` a new identity —
// re-runs the `[load]` effect: it unsubscribes/resubscribes `accounts:changed`
// and calls `accounts:list` again. This was noted by the implementing agent
// as a behavioural change relying on `initialLoadDone.current` to avoid
// clobbering an in-progress edit, but shipped without a test. This section is
// that test: it does NOT change production code, only pins the guard down.
// ---------------------------------------------------------------------------
describe('Account §2.127 — load() re-subscribes when `t` changes (language switch)', () => {
  afterEach(() => {
    // Module-level mock object shared by every test in this file — must not
    // leak a non-default `t` identity into unrelated tests.
    stableUseTranslation.t = stableT
  })

  it('re-fetches accounts:list on a language switch but does not clobber an in-progress edit', async () => {
    const editedMeta = {
      id: 7,
      name: 'Work',
      email: 'work@example.com',
      authType: 'password' as const,
      providerId: 'generic-imap' as const,
      transportType: 'imap-smtp' as const,
      imap: { host: 'imap.original.example', port: 993, secure: true, user: 'work@example.com' },
      smtp: { host: 'smtp.original.example', port: 587, secure: true, user: 'work@example.com' },
    }
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'accounts:list') return Promise.resolve([editedMeta])
      if (channel === 'tls:listPins') return Promise.resolve([])
      return defaultInvoke(channel)
    })

    const { rerender } = render(React.createElement(Account, { initialMode: 'edit', initialEditId: 7 }))

    const hostInput = await screen.findByDisplayValue('imap.original.example')
    expect(mockInvoke.mock.calls.filter(c => c[0] === 'accounts:list')).toHaveLength(1)
    const onCallsBefore = mockOn.mock.calls.filter(c => c[0] === 'accounts:changed').length

    // The user starts editing the IMAP host but has not saved yet.
    fireEvent.change(hostInput, { target: { value: 'user-typed.example.com' } })
    expect(screen.getByDisplayValue('user-typed.example.com')).toBeInTheDocument()

    // Simulate a language switch: `t` gets a new function identity — exactly
    // what happens on every consumer of `useTranslation()` when
    // `i18n.changeLanguage()` fires.
    stableUseTranslation.t = (key: string, vars?: Record<string, unknown>) => stableT(key, vars)
    await act(async () => {
      rerender(React.createElement(Account, { initialMode: 'edit', initialEditId: 7 }))
      await Promise.resolve()
    })

    // `load`'s identity changed with `t`, so the `[load]` effect re-ran: a
    // second accounts:list fetch, and a fresh accounts:changed subscription.
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(c => c[0] === 'accounts:list')).toHaveLength(2)
    })
    expect(mockOn.mock.calls.filter(c => c[0] === 'accounts:changed').length).toBe(onCallsBefore + 1)
    expect(mockOff.mock.calls.filter(c => c[0] === 'accounts:changed').length).toBeGreaterThanOrEqual(1)

    // The `initialLoadDone` guard must still stop the fresh fetch from
    // overwriting the field the user is mid-edit on. Without it, this second
    // `load()` calls `setForm(mapMetaToForm(meta))` again and silently
    // discards the in-progress edit — reverting the host back to the
    // server-loaded value.
    expect(screen.getByDisplayValue('user-typed.example.com')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('imap.original.example')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// §2.297 — new mailboxes do not go through Google sign-in in the official
// build. The renderer only decides what to OFFER (main enforces the refusal in
// `oauth:google:connect`, see electron/main.googleConnectPolicyWiring.test.ts).
// ---------------------------------------------------------------------------
describe('Account §2.297 — Google sign-in availability', () => {
  const googleMeta = {
    id: 7,
    name: 'Ada',
    email: 'ada@gmail.com',
    authType: 'oauth2' as const,
    providerId: 'gmail' as const,
    transportType: 'imap-smtp' as const,
    imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'ada@gmail.com' },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'ada@gmail.com' },
  }
  const passwordMeta = {
    ...googleMeta,
    id: 8,
    authType: 'password' as const,
    providerId: 'generic-imap' as const,
    imap: { host: 'imap.example.com', port: 993, secure: true, user: 'ada@example.com' },
    smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'ada@example.com' },
  }

  function renderEdit(meta: typeof googleMeta | typeof passwordMeta) {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'accounts:list') return Promise.resolve([meta])
      if (channel === 'tls:listPins') return Promise.resolve([])
      return defaultInvoke(channel)
    })
    return render(React.createElement(Account, { initialMode: 'edit', initialEditId: meta.id }))
  }

  const reconnectName = () => stableT('account.actions.googleReauth')

  describe.each([
    ['sign-in closed to new mailboxes', { configured: true, newMailboxes: false }],
    ['no Google client in the build', { configured: false, newMailboxes: false }],
  ])('wizard when %s', (_label, availability) => {
    beforeEach(() => { googleAvailability = availability })

    it('shows the app-password description on the Gmail card', async () => {
      renderAccount()
      await screen.findByText(stableT('account.wizard.provider.gmail.descAppPassword'))
      expect(screen.queryByText(stableT('account.wizard.provider.gmail.desc'))).not.toBeInTheDocument()
    })

    it('sends the Gmail card to the app-password step without calling the Google connect', async () => {
      renderAccount()
      await screen.findByText(stableT('account.wizard.provider.gmail.descAppPassword'))

      fireEvent.click(document.getElementById('provider-card-gmail')!)

      expect(await screen.findByTestId('account-wizard-gmail-password')).toBeInTheDocument()
      expect(screen.queryByTestId('account-wizard-oauth-waiting')).not.toBeInTheDocument()
      expect(mockInvoke).not.toHaveBeenCalledWith('oauth:google:connect', expect.anything())
    })

    it('leads Next from the app-password step to the credentials form', async () => {
      renderAccount()
      await screen.findByText(stableT('account.wizard.provider.gmail.descAppPassword'))
      fireEvent.click(document.getElementById('provider-card-gmail')!)

      fireEvent.click(await screen.findByTestId('account-wizard-gmail-password-next'))

      expect(await screen.findByTestId('account-wizard-credentials')).toBeInTheDocument()
      expect(screen.queryByTestId('account-wizard-gmail-password')).not.toBeInTheDocument()
      expect(mockInvoke).not.toHaveBeenCalledWith('oauth:google:connect', expect.anything())
    })

    it('takes Back from the credentials form to the app-password step', async () => {
      renderAccount()
      await screen.findByText(stableT('account.wizard.provider.gmail.descAppPassword'))
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      fireEvent.click(await screen.findByTestId('account-wizard-gmail-password-next'))

      fireEvent.click(await screen.findByTestId('account-wizard-credentials-back'))

      expect(await screen.findByTestId('account-wizard-gmail-password')).toBeInTheDocument()
    })
  })

  it('keeps the Google sign-in description and flow when new mailboxes are allowed', async () => {
    renderAccount()
    await screen.findByText(stableT('account.wizard.provider.gmail.desc'))

    fireEvent.click(document.getElementById('provider-card-gmail')!)

    expect(await screen.findByTestId('account-wizard-oauth-waiting')).toBeInTheDocument()
    expect(mockInvoke).toHaveBeenCalledWith('oauth:google:connect', undefined)
  })

  it('falls back to the app-password path while the availability reply is missing', async () => {
    // Fail-closed: an unanswered or failing availability call must never
    // open Google sign-in for a new mailbox.
    mockInvoke.mockImplementation((channel: string) => (
      channel === 'oauth:google:availability' ? Promise.reject(new Error('down')) : defaultInvoke(channel)
    ))
    renderAccount()
    await screen.findByTestId('account-wizard-provider')

    fireEvent.click(document.getElementById('provider-card-gmail')!)

    expect(await screen.findByTestId('account-wizard-gmail-password')).toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalledWith('oauth:google:connect', expect.anything())
  })

  describe('edit form', () => {
    it('hides the reconnect button and explains why for a Google mailbox when the build has no client', async () => {
      googleAvailability = { configured: false, newMailboxes: false }
      renderEdit(googleMeta)

      expect(await screen.findByTestId('account-google-unavailable')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: reconnectName() })).not.toBeInTheDocument()
    })

    it('offers reconnect for a Google mailbox when sign-in is closed to new mailboxes', async () => {
      googleAvailability = { configured: true, newMailboxes: false }
      renderEdit(googleMeta)

      expect(await screen.findByRole('button', { name: reconnectName() })).toBeInTheDocument()
      expect(screen.queryByTestId('account-google-unavailable')).not.toBeInTheDocument()
    })

    it('offers no Google button for a password mailbox when sign-in is closed to new mailboxes', async () => {
      googleAvailability = { configured: true, newMailboxes: false }
      renderEdit(passwordMeta)
      await screen.findByDisplayValue('imap.example.com')

      expect(screen.queryByRole('button', { name: reconnectName() })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: stableT('account.actions.googleSignIn') })).not.toBeInTheDocument()
      expect(screen.queryByTestId('account-google-unavailable')).not.toBeInTheDocument()
    })

    it('offers Sign in with Google for a password mailbox when new mailboxes are allowed', async () => {
      googleAvailability = { configured: true, newMailboxes: true }
      renderEdit(passwordMeta)

      expect(await screen.findByRole('button', { name: stableT('account.actions.googleSignIn') })).toBeInTheDocument()
    })

    it('makes the IMAP and SMTP user inputs read-only for an OAuth mailbox', async () => {
      googleAvailability = { configured: true, newMailboxes: false }
      renderEdit(googleMeta)
      await screen.findByDisplayValue('imap.gmail.com')

      const userInputs = screen.getAllByDisplayValue('ada@gmail.com')
        .filter(el => el.getAttribute('placeholder') === stableT('account.fields.user'))
      expect(userInputs).toHaveLength(2)
      for (const el of userInputs) {
        expect(el).toHaveAttribute('readonly')
      }
    })

    it('keeps the IMAP and SMTP user inputs editable for a password mailbox', async () => {
      googleAvailability = { configured: true, newMailboxes: false }
      renderEdit(passwordMeta)
      await screen.findByDisplayValue('imap.example.com')

      const userInputs = screen.getAllByDisplayValue('ada@example.com')
        .filter(el => el.getAttribute('placeholder') === stableT('account.fields.user'))
      expect(userInputs).toHaveLength(2)
      for (const el of userInputs) {
        expect(el).not.toHaveAttribute('readonly')
      }
    })

    it('shows the translated mismatch message with the mailbox address when main refuses account_mismatch', async () => {
      googleAvailability = { configured: true, newMailboxes: false }
      renderEdit(googleMeta)
      fireEvent.click(await screen.findByRole('button', { name: reconnectName() }))

      await act(async () => {
        googleConnect.resolve({ ok: false, refusal: 'account_mismatch' })
        await Promise.resolve()
      })

      await waitFor(() => {
        expect(screen.getByText(stableT('account.errors.googleAccountMismatch', { email: 'ada@gmail.com' }))).toBeInTheDocument()
      })
      expect(mockInvoke).toHaveBeenCalledWith('oauth:google:connect', 7)
      // The form is still there, not replaced by anything half-saved.
      expect(screen.getByRole('button', { name: reconnectName() })).not.toBeDisabled()
    })
  })

  it('shows the translated new-mailbox message and returns to the picker when main refuses new_mailbox_closed', async () => {
    // A renderer that offered the Google flow anyway (stale or replaced):
    // main's verdict must still come out as our own sentence.
    renderAccount()
    await screen.findByText(stableT('account.wizard.provider.gmail.desc'))
    fireEvent.click(document.getElementById('provider-card-gmail')!)
    await screen.findByTestId('account-wizard-oauth-waiting')

    await act(async () => {
      googleConnect.resolve({ ok: false, refusal: 'new_mailbox_closed' })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText(stableT('account.errors.googleNewMailboxClosed'))).toBeInTheDocument()
    })
    expect(screen.getByTestId('account-wizard-provider')).toBeInTheDocument()
    expect(screen.queryByTestId('account-wizard-oauth-waiting')).not.toBeInTheDocument()
  })

  it('shows the not-configured message for a not_configured refusal', async () => {
    renderAccount()
    await screen.findByText(stableT('account.wizard.provider.gmail.desc'))
    fireEvent.click(document.getElementById('provider-card-gmail')!)
    await screen.findByTestId('account-wizard-oauth-waiting')

    await act(async () => {
      googleConnect.resolve({ ok: false, refusal: 'not_configured' })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText(stableT('account.errors.googleNotConfigured'))).toBeInTheDocument()
    })
  })

  it('falls back to the generic Google failure sentence for an unknown refusal value', async () => {
    renderAccount()
    await screen.findByText(stableT('account.wizard.provider.gmail.desc'))
    fireEvent.click(document.getElementById('provider-card-gmail')!)
    await screen.findByTestId('account-wizard-oauth-waiting')

    await act(async () => {
      googleConnect.resolve({ ok: false, refusal: 'something_new' })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText(stableT('account.errors.googleOAuthFailed'))).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// §2.297 — read-only user fields are Google-only; Gmail card server choice;
// FAQ link on the app-password step.
// ---------------------------------------------------------------------------
describe('Account §2.297 — OAuth mailbox fields and the Gmail card', () => {
  const outlookMeta = {
    id: 9,
    name: 'Shared',
    email: 'shared@corp.example',
    authType: 'oauth2' as const,
    providerId: 'outlook' as const,
    transportType: 'imap-smtp' as const,
    imap: { host: 'outlook.office365.com', port: 993, secure: true, user: 'shared@corp.example' },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false, user: 'shared@corp.example' },
  }

  const gmailPreset = {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    displayName: 'Gmail',
    source: 'preset',
  }

  /** Walks the wizard: provider card -> (type step for IMAP) -> credentials -> Next. */
  async function fillCredentialsAndDetect(email: string) {
    const emailInput = await screen.findByTestId('account-wizard-email')
    fireEvent.change(emailInput, { target: { value: email } })
    fireEvent.change(screen.getByTestId('account-wizard-password'), { target: { value: 'app-password-1234' } })
    fireEvent.click(screen.getByTestId('account-wizard-next'))
  }

  it('leaves the IMAP and SMTP user inputs of an Outlook oauth2 mailbox editable (shared mailboxes)', async () => {
    googleAvailability = { configured: true, newMailboxes: false }
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'accounts:list') return Promise.resolve([outlookMeta])
      if (channel === 'tls:listPins') return Promise.resolve([])
      return defaultInvoke(channel)
    })
    render(React.createElement(Account, { initialMode: 'edit', initialEditId: outlookMeta.id }))
    await screen.findByDisplayValue('outlook.office365.com')

    const userInputs = screen.getAllByDisplayValue('shared@corp.example')
      .filter(el => el.getAttribute('placeholder') === stableT('account.fields.user'))
    expect(userInputs).toHaveLength(2)
    for (const el of userInputs) {
      expect(el).not.toHaveAttribute('readonly')
    }
  })

  describe('closed build: Gmail card', () => {
    beforeEach(() => { googleAvailability = { configured: true, newMailboxes: false } })

    async function chooseGmailCardAndGoToCredentials() {
      renderAccount()
      await screen.findByText(stableT('account.wizard.provider.gmail.descAppPassword'))
      fireEvent.click(document.getElementById('provider-card-gmail')!)
      fireEvent.click(await screen.findByTestId('account-wizard-gmail-password-next'))
    }

    it('asks accounts:autoconfig for the gmail preset even for a non-gmail domain (Workspace)', async () => {
      mockInvoke.mockImplementation((channel: string) => (
        channel === 'accounts:autoconfig' ? Promise.resolve(gmailPreset) : defaultInvoke(channel)
      ))
      await chooseGmailCardAndGoToCredentials()

      await fillCredentialsAndDetect('ada@corp.example')

      expect(await screen.findByTestId('account-wizard-detected')).toBeInTheDocument()
      expect(mockInvoke).toHaveBeenCalledWith('accounts:autoconfig', 'ada@corp.example', 'gmail')
      expect(screen.getByDisplayValue('imap.gmail.com')).toBeInTheDocument()
      expect(screen.getByDisplayValue('smtp.gmail.com')).toBeInTheDocument()
    })

    it('passes undefined as the second argument once another provider card is chosen afterwards', async () => {
      mockInvoke.mockImplementation((channel: string) => (
        channel === 'accounts:autoconfig' ? Promise.resolve(null) : defaultInvoke(channel)
      ))
      await chooseGmailCardAndGoToCredentials()
      // Back to the picker (credentials -> app-password step -> provider), then
      // the generic IMAP card: the Gmail choice must not stick.
      fireEvent.click(screen.getByTestId('account-wizard-credentials-back'))
      await screen.findByTestId('account-wizard-gmail-password')
      fireEvent.click(screen.getByText(stableT('account.actions.back')))
      await screen.findByTestId('account-wizard-provider')
      fireEvent.click(document.getElementById('provider-card-generic-imap')!)
      fireEvent.click(await screen.findByTestId('account-wizard-imap'))

      await fillCredentialsAndDetect('ada@corp.example')

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('accounts:autoconfig', 'ada@corp.example', undefined)
      })
      expect(mockInvoke).not.toHaveBeenCalledWith('accounts:autoconfig', expect.anything(), 'gmail')
    })

    it.each([
      ['en', 'https://docs.mailcopilot.io/faq#app-passwords-missing'],
      ['ru', 'https://docs.mailcopilot.io/ru/faq#app-passwords-missing'],
      ['de-DE', 'https://docs.mailcopilot.io/de/faq#app-passwords-missing'],
      ['fr', 'https://docs.mailcopilot.io/fr/faq#app-passwords-missing'],
      ['es', 'https://docs.mailcopilot.io/es/faq#app-passwords-missing'],
      ['it', 'https://docs.mailcopilot.io/it/faq#app-passwords-missing'],
      ['xx', 'https://docs.mailcopilot.io/faq#app-passwords-missing'],
    ])('opens the FAQ entry through ui:openExternal for language %s', async (language, expectedUrl) => {
      stableUseTranslation.i18n.language = language
      renderAccount()
      await screen.findByText(stableT('account.wizard.provider.gmail.descAppPassword'))
      fireEvent.click(document.getElementById('provider-card-gmail')!)

      fireEvent.click(await screen.findByTestId('account-wizard-gmail-password-faq'))

      expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', expectedUrl)
    })
  })

  it('asks accounts:autoconfig with undefined as the second argument for the generic IMAP provider', async () => {
    mockInvoke.mockImplementation((channel: string) => (
      channel === 'accounts:autoconfig' ? Promise.resolve(null) : defaultInvoke(channel)
    ))
    renderAccount()
    await screen.findByTestId('account-wizard-provider')
    fireEvent.click(document.getElementById('provider-card-generic-imap')!)
    fireEvent.click(await screen.findByTestId('account-wizard-imap'))

    await fillCredentialsAndDetect('ada@example.com')

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('accounts:autoconfig', 'ada@example.com', undefined)
    })
  })
})
