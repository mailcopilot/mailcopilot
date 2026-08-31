// @vitest-environment jsdom
/**
 * Unit tests for src/Root.tsx (§2.82 gap #1 — this file did not exist before).
 *
 * Two things Root owns and nothing else in the diff tests directly:
 *
 *   - `renderChildWindow(hash)`: pure hash → component routing. Also the
 *     condition Root uses to decide whether the consent gate applies (a child
 *     window is anything this function does not route to `null`), so a
 *     routing bug here is also a gate bug.
 *   - The gate itself: while `useTelemetryConsent` reports `checking` or
 *     `required`, `<App/>` must never mount. This is the load-bearing
 *     assertion for AC4 (the account wizard, opened from App's own load
 *     effect, must never appear behind an unanswered consent screen) — proven
 *     here by asserting the mocked App component function is never invoked,
 *     which is a stronger and cheaper statement than asserting one IPC call
 *     App happens to make internally.
 *
 * Every window component (App, Settings, Account, Compose, MailWindow,
 * TelemetryConsentDialog) is mocked to a thin stand-in: their own behavior is
 * covered by their own test files, and mounting the real App.tsx (a §5
 * hotspot with a very large effect graph) is impractical here — see the same
 * reasoning documented in src/windows/Settings.bodyRetention.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'

// react-i18next is NOT mocked here: src/i18n/index.ts calls
// `i18n.use(initReactI18next)` at module load, and every component that would
// otherwise need useTranslation (Settings, TelemetryConsentDialog, ...) is
// mocked below, so the real i18n init never needs to render anything.
// The boundary is a pass-through, but its props are captured: §2.236 AC1(d)
// wires `onError` to the consent reporter, and that wiring is what the crash
// test below asserts (Sentry's own catching behaviour is Sentry's contract, not
// Root's).
const { boundaryProps } = vi.hoisted(() => ({ boundaryProps: { current: null as Record<string, unknown> | null } }))
vi.mock('./sentry', () => ({
  SentryErrorBoundary: (props: { children: ReactNode }) => {
    boundaryProps.current = props as unknown as Record<string, unknown>
    return props.children
  },
  sendFeedback: vi.fn(),
  isSentryActive: () => false,
}))

vi.mock('./App', () => ({ default: vi.fn(() => <div data-testid="app-mounted" />) }))
vi.mock('./windows/Settings', () => ({ default: vi.fn(() => <div data-testid="settings-window" />) }))
vi.mock('./windows/Account', () => ({
  default: vi.fn((props: { initialMode?: 'new' | 'edit'; initialEditId?: number }) => (
    <div data-testid="account-window" data-mode={props.initialMode} data-editid={String(props.initialEditId)} />
  )),
}))
vi.mock('./windows/Compose', () => ({ default: vi.fn(() => <div data-testid="compose-window" />) }))
vi.mock('./windows/MailWindow', () => ({
  default: vi.fn((props: { accountId: number; folder: string; uid: number }) => (
    <div data-testid="mail-window" data-account={props.accountId} data-folder={props.folder} data-uid={props.uid} />
  )),
}))
vi.mock('./components/TelemetryConsentDialog', () => ({
  default: vi.fn((props: { submitting: boolean }) => (
    <div data-testid="consent-dialog" data-submitting={String(props.submitting)} />
  )),
}))

const { useTelemetryConsentMock, reportConsentTreeErrorMock } = vi.hoisted(() => ({
  useTelemetryConsentMock: vi.fn(),
  reportConsentTreeErrorMock: vi.fn(),
}))
vi.mock('./hooks/useTelemetryConsent', () => ({
  useTelemetryConsent: (...args: unknown[]) => useTelemetryConsentMock(...args),
  reportConsentTreeError: (...args: unknown[]) => reportConsentTreeErrorMock(...args),
}))

import Root, { renderChildWindow } from './Root'
import App from './App'
import Settings from './windows/Settings'
import Account from './windows/Account'
import Compose from './windows/Compose'
import MailWindow from './windows/MailWindow'

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff },
  writable: true,
  configurable: true,
})

function consentState(phase: string, extra: Record<string, unknown> = {}) {
  return { phase, submitting: false, decide: vi.fn(), attempts: 1, ...extra }
}

function resolvedConsent() {
  return consentState('resolved')
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({})
  useTelemetryConsentMock.mockReturnValue(resolvedConsent())
  window.location.hash = ''
  delete document.documentElement.dataset.telemetryConsent
  delete document.documentElement.dataset.telemetryConsentAttempts
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

describe('renderChildWindow — hash routing', () => {
  it('returns null for the main window (empty hash, bare "#", "#/")', () => {
    expect(renderChildWindow('')).toBeNull()
    expect(renderChildWindow('#')).toBeNull()
    expect(renderChildWindow('#/')).toBeNull()
  })

  it('returns null for an unrecognized hash', () => {
    expect(renderChildWindow('#/does-not-exist')).toBeNull()
  })

  it('routes #/settings to Settings', () => {
    expect(renderChildWindow('#/settings')?.type).toBe(Settings)
  })

  it('routes #/compose to Compose', () => {
    expect(renderChildWindow('#/compose')?.type).toBe(Compose)
  })

  it('routes #/account with no query to Account in "new" mode, no editId', () => {
    const el = renderChildWindow('#/account')
    expect(el?.type).toBe(Account)
    expect(el?.props).toEqual({ initialMode: 'new', initialEditId: undefined })
  })

  it('routes #/account?mode=edit&id=42 to Account in "edit" mode with the parsed id', () => {
    const el = renderChildWindow('#/account?mode=edit&id=42')
    expect(el?.props).toEqual({ initialMode: 'edit', initialEditId: 42 })
  })

  it('an id without mode=edit stays "new" — mode is the switch, presence of id is not enough', () => {
    const el = renderChildWindow('#/account?id=42')
    expect(el?.props).toEqual({ initialMode: 'new', initialEditId: 42 })
  })

  it('routes #/mail-window with query params to MailWindow with parsed numeric fields', () => {
    const el = renderChildWindow('#/mail-window?accountId=3&folder=INBOX&uid=99')
    expect(el?.type).toBe(MailWindow)
    expect(el?.props).toEqual({ accountId: 3, folder: 'INBOX', uid: 99 })
  })
})

describe('Root — telemetry consent gate (AC4)', () => {
  it('renders nothing while the consent state is being checked — App never mounts', () => {
    useTelemetryConsentMock.mockReturnValue(consentState('checking', { attempts: 1 }))
    render(<Root />)
    expect(screen.queryByTestId('app-mounted')).not.toBeInTheDocument()
    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument()
    expect(vi.mocked(App)).not.toHaveBeenCalled()
  })

  it('shows the consent screen instead of mounting App while a decision is required (AC4)', () => {
    useTelemetryConsentMock.mockReturnValue(consentState('required'))
    render(<Root />)
    expect(screen.getByTestId('consent-dialog')).toBeInTheDocument()
    // The load-bearing assertion: App's mount effect (which lists accounts and
    // can open the account wizard on an empty roster) never runs while a
    // consent decision is pending — breaking the `phase === 'required'` branch
    // in Root.tsx is exactly what turns this red.
    expect(vi.mocked(App)).not.toHaveBeenCalled()
  })

  it('mounts App once the decision is resolved, and the consent screen is gone', () => {
    useTelemetryConsentMock.mockReturnValue(resolvedConsent())
    render(<Root />)
    expect(screen.getByTestId('app-mounted')).toBeInTheDocument()
    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument()
  })

  it('asks useTelemetryConsent with enabled: true for the main window', () => {
    render(<Root />)
    expect(useTelemetryConsentMock).toHaveBeenCalledWith({ enabled: true })
  })

  it('asks useTelemetryConsent with enabled: false for a child window, and never gates it', () => {
    window.location.hash = '#/settings'
    // Even if the hook reported "required", a child window must render its own
    // content, never the consent screen — the gate belongs to the main window.
    useTelemetryConsentMock.mockReturnValue(consentState('required'))
    render(<Root />)
    expect(useTelemetryConsentMock).toHaveBeenCalledWith({ enabled: false })
    expect(screen.getByTestId('settings-window')).toBeInTheDocument()
    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument()
  })

  it('forwards submitting to the dialog', () => {
    useTelemetryConsentMock.mockReturnValue(consentState('required', { submitting: true }))
    render(<Root />)
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-submitting', 'true')
  })
})

/**
 * §2.236 — `unresolved` is a terminal state of its own.
 *
 * Both `resolved` and `unresolved` render the app: mail is never held hostage
 * behind a modal. What must NOT happen is the two becoming indistinguishable —
 * "we could not determine whether to ask" is not "we determined that no question
 * is needed", and the difference is what decides whether the question comes back
 * on the next launch. These tests are the ones that fail if a future change
 * collapses the states again.
 */
describe('Root — unresolved consent state (§2.236)', () => {
  it('renders the app when the consent state could not be resolved', () => {
    useTelemetryConsentMock.mockReturnValue(consentState('unresolved', { attempts: 5 }))
    render(<Root />)
    expect(screen.getByTestId('app-mounted')).toBeInTheDocument()
    // And no screen: we have no evidence the question is due, so we do not
    // invent one — the next launch asks, because no record was written.
    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument()
  })

  it('marks unresolved and resolved differently on <html>, so the two can be told apart', () => {
    useTelemetryConsentMock.mockReturnValue(consentState('unresolved', { attempts: 5 }))
    const first = render(<Root />)
    expect(document.documentElement.dataset.telemetryConsent).toBe('unresolved')
    expect(document.documentElement.dataset.telemetryConsentAttempts).toBe('5')
    first.unmount()

    useTelemetryConsentMock.mockReturnValue(consentState('resolved'))
    render(<Root />)
    expect(document.documentElement.dataset.telemetryConsent).toBe('resolved')
    expect(document.documentElement.dataset.telemetryConsentAttempts).toBe('1')
  })

  it.each(['checking', 'required'] as const)('mirrors the %s phase onto <html> too', phase => {
    useTelemetryConsentMock.mockReturnValue(consentState(phase))
    render(<Root />)
    expect(document.documentElement.dataset.telemetryConsent).toBe(phase)
  })
})

// §2.236 AC1(d) — hypothesis 2 (the consent dialog throws and the error is
// eaten) gets instrumentation. Root wires the boundary's onError to the hook's
// reporter, which is where the policy lives; this asserts the wiring exists,
// carrying the phase that tells a consent-screen crash from any other one.
describe('Root — tree crash reporting', () => {
  it('reports a render failure with the consent phase that was on screen', () => {
    useTelemetryConsentMock.mockReturnValue(consentState('required'))
    render(<Root />)

    const onError = boundaryProps.current?.onError as ((e: unknown) => void) | undefined
    expect(onError).toBeTypeOf('function')
    const boom = new Error('consent dialog exploded')
    onError?.(boom)
    // `required` is the phase that matters: a crash there is the one the
    // boundary's own Sentry report cannot deliver, because telemetry is
    // necessarily off while the question is open.
    expect(reportConsentTreeErrorMock).toHaveBeenCalledWith('required', boom)
  })

  it('carries the phase through, so a crash outside the screen is distinguishable', () => {
    useTelemetryConsentMock.mockReturnValue(consentState('unresolved', { attempts: 5 }))
    render(<Root />)
    const onError = boundaryProps.current?.onError as ((e: unknown) => void) | undefined
    const boom = new Error('app exploded')
    onError?.(boom)
    expect(reportConsentTreeErrorMock).toHaveBeenCalledWith('unresolved', boom)
  })
})
