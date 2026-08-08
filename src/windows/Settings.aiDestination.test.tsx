// @vitest-environment jsdom
/**
 * BACKLOG §2.119 — the settings window must not report a save it did not get.
 *
 * Main gates a change of `aiOpenAiBaseUrl` / `aiProxyUrl` behind a native
 * confirmation and, when the change does not go through, answers
 * `settings:save` with `{ ok: true, aiDestinationRejected: {...} }` — every
 * other edit in the same save WAS applied, only the address was held back.
 *
 * This window's sole "saved" signal is that it closes. Closing on a refusal
 * therefore leaves the person believing their API key now travels to the
 * address they typed, while every subsequent AI request goes to the old one.
 * These tests are about that: what the window does with the reply, not what
 * main decided (that is electron/services/aiDestination*.test.ts).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

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

type SaveReply = Record<string, unknown>

const ACCOUNT = {
  id: 1,
  name: 'Test',
  email: 'user@example.com',
  imap: { host: 'imap.example.com', port: 993, user: 'user@example.com', secure: true },
  smtp: { host: 'smtp.example.com', port: 465, user: 'user@example.com', secure: true },
}

const SETTINGS_BLOB = {
  theme: 'light',
  language: 'en',
  bodyRetentionDays: 365,
  aiProvider: 'openai-api',
  aiOpenAiBaseUrl: 'https://api.openai.com',
  aiProxyUrl: '',
}

let invoke: ReturnType<typeof vi.fn>
let closeSpy: ReturnType<typeof vi.spyOn>

function installApi(saveReply: SaveReply): void {
  invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'settings:get': return SETTINGS_BLOB
      case 'settings:save': return saveReply
      case 'accounts:list': return [ACCOUNT]
      case 'accounts:get': return ACCOUNT
      case 'accounts:getCurrent': return 1
      case 'mcpExport:status': return { status: 'stopped' }
      case 'mcp:status': return {}
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

/** Mount, wait for the initial load, and press Save. */
async function mountAndSave(saveReply: SaveReply): Promise<void> {
  installApi(saveReply)
  render(<Settings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
  fireEvent.click(screen.getByTestId('settings-save'))
  await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'settings:save')).toBe(true))
}

function rejectionReply(reason: string, fields: string[] = ['aiOpenAiBaseUrl']): SaveReply {
  return {
    ok: true,
    aiDestinationRejected: { reason, fields, message: `main says: ${reason}` },
  }
}

beforeEach(() => {
  closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('§2.119 settings window — a refused address change is not a completed save', () => {
  // REGRESSION GUARD — this is the defect. The window closed, and closing is
  // the only "saved" signal it has.
  it.each(['declined', 'invalid', 'busy'])('keeps the window open on %s', async reason => {
    await mountAndSave(rejectionReply(reason))
    await screen.findByTestId('settings-ai-destination-notice')
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it.each(['declined', 'invalid', 'busy'])('shows main\'s own sentence for %s', async reason => {
    await mountAndSave(rejectionReply(reason))
    const notice = await screen.findByTestId('settings-ai-destination-notice')
    expect(notice).toHaveAttribute('data-reason', reason)
    expect(screen.getByTestId('settings-ai-destination-message'))
      .toHaveTextContent(`main says: ${reason}`)
  })

  it('names the field that was held back', async () => {
    await mountAndSave(rejectionReply('declined', ['aiProxyUrl']))
    await screen.findByTestId('settings-ai-destination-fields')
  })

  it('states that the rest of the save landed', async () => {
    await mountAndSave(rejectionReply('declined'))
    await screen.findByTestId('settings-ai-destination-other-saved')
  })

  // The refusal costs the CLOSE and nothing else: main applied every other edit
  // in the same payload, so the window must not abort the remaining save steps
  // either. `accounts:save` is the observable one of those.
  it('still runs the rest of the save after a refusal', async () => {
    await mountAndSave(rejectionReply('declined'))
    await waitFor(() =>
      expect(invoke.mock.calls.some(([c]) => c === 'accounts:save')).toBe(true))
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('offers a retry for the transient case that saves again', async () => {
    await mountAndSave(rejectionReply('busy'))
    const retry = await screen.findByTestId('settings-ai-destination-retry')
    const before = invoke.mock.calls.filter(([c]) => c === 'settings:save').length
    fireEvent.click(retry)
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === 'settings:save').length).toBe(before + 1))
  })
})

describe('§2.119 settings window — an accepted save is unaffected', () => {
  it('closes the window and shows no notice', async () => {
    await mountAndSave({ ok: true })
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-ai-destination-notice')).toBeNull()
  })

  it('closes the window when main answers with no payload at all', async () => {
    await mountAndSave(undefined as unknown as SaveReply)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
  })
})
