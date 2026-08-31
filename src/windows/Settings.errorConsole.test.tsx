// @vitest-environment jsdom
/**
 * §2.127 (cross-family review HIGH-2, second batch) — Settings must not print a
 * raw rejection to the console.
 *
 * Same reasoning as src/windows/Compose.errorConsole.test.tsx: renderer console
 * output is a Sentry breadcrumb source (default integrations are on in
 * `src/sentry.ts`), and the text after `[mcerr:*]` is third-party prose kept raw
 * on purpose. Two Settings paths log instead of presenting — the avatar save and
 * the mail-rule save — and both reach IMAP, so both can be handed server text.
 *
 * Both are driven against the REAL component with a unique marker planted in
 * the "server" text; the assertion walks every argument of every console call.
 * The shape is borrowed from src/utils/errorPresentation.test.ts, not reinvented.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ERROR_PRESENTATION_KEYS } from '@mailcopilot/core'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}))
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn(), language: 'en' },
  SUPPORTED_LANGUAGES: ['en', 'ru', 'fr', 'de', 'es', 'it'],
  DEFAULT_LANGUAGE: 'en',
}))
vi.mock('../sentry', () => ({ sendFeedback: vi.fn(), captureException: vi.fn() }))

import Settings from './Settings'

/** Unique token planted in the "server" text; must never reach the console. */
const MARKER = 'MARKER-4b7e02-mailbox-denied'

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
  folderRoles: {},
  identities: [],
}

let invoke: ReturnType<typeof vi.fn>
let errorSpy: ReturnType<typeof vi.spyOn>

function installApi(reject: (channel: string) => boolean): void {
  invoke = vi.fn(async (channel: string) => {
    if (reject(channel)) throw taggedRejection()
    switch (channel) {
      case 'settings:get': return { theme: 'light' }
      case 'settings:save': return { ok: true }
      case 'accounts:list': return [ACCOUNT]
      case 'accounts:getCurrent': return 1
      case 'accounts:get': return ACCOUNT
      case 'mcpExport:status': return { status: 'stopped' }
      case 'mcp:status': return []
      case 'tls:listPins': return []
      case 'rules:list': return []
      case 'aiRules:list': return []
      case 'templates:list': return []
      case 'ai:memoryRead': return ''
      default: return undefined
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(), off: vi.fn(), initialTheme: 'light', installIdHash: '', sentryEnabled: false },
  })
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

/** Nothing the "server" wrote reached the console; only a verdict did. */
function expectNoRawValueLogged(ownLiteral: string): void {
  const args = errorSpy.mock.calls.flat()
  expect(args.length).toBeGreaterThan(0)
  for (const arg of args) {
    expect(typeof arg).toBe('string')
    const text = arg as string
    expect(text).not.toContain(MARKER)
    expect(text).not.toContain('mcerr')
    expect(text).not.toContain('onerror')
    expect([ownLiteral, ...ERROR_PRESENTATION_KEYS]).toContain(text)
  }
  expect(args).toContain('auth')
}

describe('Settings console diagnostics — verdict, never the value', () => {
  it('does not print the raw rejection when the avatar save fails', async () => {
    installApi(channel => channel === 'accounts:save')
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))

    fireEvent.click(screen.getByTestId('settings-tab-accounts'))
    // Open the per-account avatar editor (the palette button).
    const customize = await screen.findByTitle('settings.accounts.customizeAvatar')
    fireEvent.click(customize)

    const colorButton = await waitFor(() => {
      const el = document.querySelector('.avatar-color-btn')
      expect(el).not.toBeNull()
      return el as Element
    })
    errorSpy.mockClear()
    fireEvent.click(colorButton)

    await waitFor(() => {
      expect(invoke.mock.calls.some(([channel]) => channel === 'accounts:save')).toBe(true)
    })
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())

    expectNoRawValueLogged('saveAvatarSettings failed:')
  })

  it('does not print the raw rejection when saving a mail rule fails', async () => {
    installApi(channel => channel === 'rules:create')
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))

    fireEvent.click(screen.getByTestId('settings-tab-rules'))
    fireEvent.click(await screen.findByText(/settings\.rules\.add/))

    const nameInput = await waitFor(() => {
      const el = document.querySelector('.modal-dialog input[type="text"]')
      expect(el).not.toBeNull()
      return el as HTMLInputElement
    })
    fireEvent.change(nameInput, { target: { value: 'Newsletters' } })

    errorSpy.mockClear()
    // Scoped to the modal: the settings header carries its own "Save" button.
    const saveButton = Array.from(document.querySelectorAll('.modal-dialog button'))
      .find(b => b.textContent?.trim() === 'common.save')
    expect(saveButton).toBeTruthy()
    fireEvent.click(saveButton as Element)

    await waitFor(() => {
      expect(invoke.mock.calls.some(([channel]) => channel === 'rules:create')).toBe(true)
    })
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())

    expectNoRawValueLogged('Failed to save rule:')
    // The user still gets our own translated copy, not the server's words.
    expect(window.alert).toHaveBeenCalledWith('settings.rules.saveFailed')
  })
})
