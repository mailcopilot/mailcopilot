// @vitest-environment jsdom
/**
 * §2.119 — two seams none of the per-module suites can see, because each side
 * was written against a DESCRIBED contract rather than the other side's real
 * code.
 *
 * PART A — the two write paths must merge a requested destination BY THE SAME
 * RULE, and must merge it the same way when JUDGING it (what the guard is
 * asked about) as when USING it (what the request is actually built from).
 *
 * The first version of this suite hand-copied `ai:checkAuth`'s construction
 * into a local helper and asserted against the copy. That is why it stayed
 * green over a live bypass: the handler composed the guard's input with
 * `overrides?.x ?? persisted.x`, which loses a key sent as an explicit
 * `undefined` (zod keeps it as an own property), while the spread that built
 * the request honoured it — a cleared endpoint was judged "unchanged" and the
 * key then went to the vendor default with no dialog. A test that
 * re-implements the code under test cannot see a defect in that code.
 *
 * So this part does two things and no copying:
 *   1. drives the real production functions — the real zod schema for the IPC
 *      payload, `resolveRequestedAiDestination` for the judged values,
 *      `applyAiDestinationOverrides` for the used ones, the real guard;
 *   2. asserts against the SOURCE of electron/main.ts that both handlers call
 *      those functions and name neither address field themselves.
 *
 * Step 2 exists because electron/main.ts cannot be imported by a unit test (it
 * builds windows, opens the database and registers ~300 IPC handlers at module
 * scope — same constraint as aiDestinationWiring.test.ts). WHAT IS MISSING for
 * a true handler-level test is a production seam that registers IPC handlers
 * separately from app bootstrap; until that exists, the honest substitute is
 * asserting the real source rather than a paraphrase of it.
 *
 * PART B — main answers a refused `settings:save` with a literal object built
 * from the guard's real verdict and `aiDestinationRejectionMessage`, and the
 * renderer parses that reply with `parseAiDestinationRejection`. Both sides'
 * own suites test the shape via hand-written fixtures matching the DESCRIBED
 * contract. This drives the actual main-side functions and the actual
 * renderer-side functions together, so a real drift between them — not a
 * mismatch against a comment — is what would turn it red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { act, renderHook, render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import enLocale from '../../src/i18n/locales/en.json'

const mocks = vi.hoisted(() => ({
  recordEvent: vi.fn(),
  getSettings: vi.fn((): Record<string, unknown> => ({ language: 'en' })),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  dialog: { showMessageBox: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../metrics', () => ({ recordEvent: mocks.recordEvent }))
vi.mock('../../packages/net/config', () => ({ getSettings: mocks.getSettings }))

import { createAiDestinationGuard, aiDestinationRejectionMessage } from './aiDestinationGuard'
import {
  aiDestinationOverridesSchema,
  applyAiDestinationOverrides,
  openAiBaseUrlForRequest,
  resolveRequestedAiDestination,
  AI_DESTINATION_FIELDS,
  DEFAULT_OPENAI_BASE_URL,
  type AiDestinationSettings,
} from './aiDestination'
import {
  parseAiDestinationRejection,
  useAiDestinationRejection,
} from '../../src/hooks/useAiDestinationRejection'
import AiDestinationRejectionNotice from '../../src/components/Settings/AiDestinationRejectionNotice'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').pop() as string }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

/** The parsed `ai:checkAuth` overrides argument, produced by the REAL schema
 *  the handler parses with — so a payload written here is a payload the
 *  handler could actually receive, own-property quirks included. */
function checkAuthOverrides(raw: unknown) {
  return aiDestinationOverridesSchema.parse(
    typeof raw === 'object' && raw ? raw : undefined,
  )
}

/** Source of one `handleIpc('<channel>', …)` registration in electron/main.ts,
 *  with comments removed — the assertions below are about what the handler
 *  DOES, and a comment naming a field is not a read of it. */
// Located by walking up from the working directory: this file runs in the
// jsdom environment (Part B renders React), where `import.meta.url` is not a
// file:// URL and cannot be resolved with `fileURLToPath`.
const MAIN_TS = readFileSync((() => {
  let dir = process.cwd()
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, 'electron', 'main.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`electron/main.ts not found upwards from ${process.cwd()}`)
})(), 'utf8')
function handlerCode(channel: string): string {
  const start = MAIN_TS.indexOf(`handleIpc('${channel}'`)
  expect(start, `handleIpc('${channel}') not found in electron/main.ts`).toBeGreaterThan(-1)
  const next = MAIN_TS.indexOf('\nhandleIpc(', start + 1)
  return MAIN_TS.slice(start, next === -1 ? undefined : next)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

describe('§2.119 Part A — one merge rule, and it is the same one that acts', () => {
  const persisted: AiDestinationSettings = {
    aiOpenAiBaseUrl: 'https://llm.example.tld',
    aiProxyUrl: undefined,
  }

  /** Every shape of `ai:checkAuth` overrides a renderer can send. */
  const PAYLOADS: Array<[label: string, raw: unknown]> = [
    ['no overrides at all', undefined],
    ['an empty object', {}],
    ['a new endpoint', { aiOpenAiBaseUrl: 'https://collector.evil.tld' }],
    ['a new proxy', { aiProxyUrl: 'http://mitm.evil.tld:8080' }],
    ['both fields at once', { aiOpenAiBaseUrl: 'https://collector.evil.tld', aiProxyUrl: 'http://mitm.evil.tld:8080' }],
    // The bypass: the key is PRESENT and undefined. `??` reads this as
    // "unchanged"; the spread that builds the request performs the clear.
    ['an explicitly cleared endpoint', { aiOpenAiBaseUrl: undefined }],
    ['an explicitly cleared proxy', { aiProxyUrl: undefined }],
    ['an emptied endpoint input', { aiOpenAiBaseUrl: '' }],
  ]

  it.each(PAYLOADS)(
    'checkAuth judges and uses the same address — %s',
    async (_label, raw) => {
      const overrides = checkAuthOverrides(raw)
      // What the guard is asked about, and what the request is built from —
      // both taken from production code, not rebuilt here.
      const judged = resolveRequestedAiDestination(overrides, persisted)
      const used = applyAiDestinationOverrides(persisted, overrides)
      for (const field of AI_DESTINATION_FIELDS) {
        expect(used[field], `${field} judged vs used`).toBe(judged[field])
      }
    },
  )

  it('prompts for an explicitly cleared endpoint, and the request then goes to the vendor default', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const guard = createAiDestinationGuard({ getCurrent: () => persisted, getLanguage: () => 'en', confirm })

    // The settings window sends `undefined` for an input the user emptied.
    const overrides = checkAuthOverrides({ aiOpenAiBaseUrl: undefined })
    expect(Object.prototype.hasOwnProperty.call(overrides ?? {}, 'aiOpenAiBaseUrl')).toBe(true)

    const verdict = await guard.ensureApproved(resolveRequestedAiDestination(overrides, persisted))
    expect(verdict).toEqual({ ok: false, reason: 'declined', fields: ['aiOpenAiBaseUrl'] })
    expect(confirm).toHaveBeenCalledTimes(1)

    // And this is the address the human was protected from: had the guard been
    // asked about the persisted value while the request was built from the
    // cleared one, the key would have gone here unannounced.
    const used = applyAiDestinationOverrides(persisted, overrides)
    expect(openAiBaseUrlForRequest(used.aiOpenAiBaseUrl)).toBe(DEFAULT_OPENAI_BASE_URL)
    expect(openAiBaseUrlForRequest(persisted.aiOpenAiBaseUrl)).not.toBe(DEFAULT_OPENAI_BASE_URL)
  })

  it('does not re-prompt when settings:save asks for the exact address checkAuth just confirmed', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const guard = createAiDestinationGuard({ getCurrent: () => persisted, getLanguage: () => 'en', confirm })

    // 1) The settings window's "test connection" button, before Save is
    // pressed: the real checkAuth payload through the real merge rule.
    const overrides = checkAuthOverrides({ aiOpenAiBaseUrl: 'https://collector.evil.tld' })
    const tested = resolveRequestedAiDestination(overrides, persisted)
    await expect(guard.ensureApproved(tested)).resolves.toEqual({ ok: true, prompted: true })
    expect(confirm).toHaveBeenCalledTimes(1)

    // 2) The user then presses Save: the settings:save payload — the whole
    // settings object, as that channel always round-trips it — through the
    // same rule.
    const saved = resolveRequestedAiDestination(
      { theme: 'dark', aiOpenAiBaseUrl: 'https://collector.evil.tld', aiProxyUrl: undefined },
      persisted,
    )
    await expect(guard.ensureApproved(saved)).resolves.toEqual({ ok: true, prompted: false })

    // The dialog was shown exactly once for one human decision, not twice for
    // one edit split across two IPC calls.
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('DOES re-prompt when the save asks for a different address than the one checkAuth confirmed', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const guard = createAiDestinationGuard({ getCurrent: () => persisted, getLanguage: () => 'en', confirm })

    const tested = resolveRequestedAiDestination(
      checkAuthOverrides({ aiOpenAiBaseUrl: 'https://collector.evil.tld' }),
      persisted,
    )
    await guard.ensureApproved(tested)
    expect(confirm).toHaveBeenCalledTimes(1)

    // The user edited the field again after testing, before saving.
    const saved = resolveRequestedAiDestination({ aiOpenAiBaseUrl: 'https://second.evil.tld' }, persisted)
    await guard.ensureApproved(saved)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})

/**
 * The half of Part A that no in-process assertion can reach: that the shipped
 * handlers are the callers of that one rule. This is what goes red if the
 * `??` construction — or any other second merge — comes back.
 */
describe('§2.119 Part A — electron/main.ts merges through the shared rule, not its own', () => {
  const checkAuth = handlerCode('ai:checkAuth')
  const settingsSave = handlerCode('settings:save')

  it('ai:checkAuth never names the address fields itself', () => {
    // Both reads go through the shared functions, so the handler has no reason
    // to mention either field. A hand-rolled merge — `overrides?.aiOpenAiBaseUrl
    // ?? persisted.aiOpenAiBaseUrl` and friends — cannot avoid naming them.
    for (const field of AI_DESTINATION_FIELDS) {
      expect(checkAuth, `ai:checkAuth builds its own merge of ${field}`).not.toContain(field)
    }
  })

  it('ai:checkAuth judges and sends through the same resolver, in that order', () => {
    expect(checkAuth).toContain('resolveRequestedAiDestination(overrides,')
    expect(checkAuth).toContain('applyAiDestinationOverrides(getSettings(), overrides)')
    const judged = checkAuth.indexOf('resolveRequestedAiDestination(overrides,')
    const asked = checkAuth.indexOf('ensureAiDestinationApproved(')
    const used = checkAuth.indexOf('applyAiDestinationOverrides(')
    const sent = checkAuth.indexOf('aiCheckAuth(')
    expect(judged).toBeGreaterThan(-1)
    expect(asked).toBeGreaterThan(judged)
    expect(used).toBeGreaterThan(asked)
    expect(sent).toBeGreaterThan(used)
  })

  it('settings:save writes the addresses through the same resolver it was judged by', () => {
    expect(settingsSave).toContain('resolveRequestedAiDestination(')
    expect(settingsSave).toContain('applyAiDestinationOverrides(')
    expect(settingsSave.indexOf('applyAiDestinationOverrides('))
      .toBeLessThan(settingsSave.indexOf('saveSettings('))
  })

  it('neither handler carries a `??` fallback over the requested destination', () => {
    for (const [channel, code] of [['ai:checkAuth', checkAuth], ['settings:save', settingsSave]] as const) {
      expect(code, `${channel} composes a destination with ??`).not.toMatch(/overrides\??\.?\w*\s*\?\?/)
    }
  })
})

describe('§2.119 Part B — a real refusal round-trips through main and the renderer unchanged', () => {
  const persisted: AiDestinationSettings = {
    aiOpenAiBaseUrl: 'https://llm.example.tld',
    aiProxyUrl: undefined,
  }

  /** Builds the literal `settings:save` reply electron/main.ts returns on a
   *  refusal, from the REAL guard verdict and the REAL message function —
   *  not a fixture shaped to match the description. */
  async function realRejectedSaveReply(reason: 'declined' | 'invalid' | 'busy') {
    const confirm = reason === 'declined' ? vi.fn().mockResolvedValue(false) : vi.fn()
    const guard = createAiDestinationGuard({ getCurrent: () => persisted, getLanguage: () => 'en', confirm })
    const next = reason === 'invalid'
      ? { ...persisted, aiProxyUrl: 'socks5://p:1080' } // unparseable — refused pre-dialog
      : { ...persisted, aiOpenAiBaseUrl: 'https://collector.evil.tld' }
    if (reason === 'busy') {
      // Open one dialog and, while it is pending, ask again.
      let release: (v: boolean) => void = () => {}
      const pending = new Promise<boolean>(resolve => { release = resolve })
      const busyGuard = createAiDestinationGuard({
        getCurrent: () => persisted,
        getLanguage: () => 'en',
        confirm: () => pending,
      })
      const first = busyGuard.ensureApproved(next)
      await Promise.resolve()
      const second = await busyGuard.ensureApproved({ ...persisted, aiOpenAiBaseUrl: 'https://third.evil.tld' })
      release(true)
      await first
      expect(second.ok).toBe(false)
      if (second.ok) throw new Error('unreachable')
      return {
        ok: true as const,
        aiDestinationRejected: {
          reason: second.reason,
          fields: second.fields,
          message: aiDestinationRejectionMessage(second.reason, 'en'),
        },
      }
    }
    const verdict = await guard.ensureApproved(next)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    return {
      ok: true as const,
      aiDestinationRejected: {
        reason: verdict.reason,
        fields: verdict.fields,
        message: aiDestinationRejectionMessage(verdict.reason, 'en'),
      },
    }
  }

  it.each(['declined', 'invalid', 'busy'] as const)(
    '%s: the renderer reads the real reply as a rejection, not a success',
    async reason => {
      const reply = await realRejectedSaveReply(reason)
      const parsed = parseAiDestinationRejection(reply)
      expect(parsed).not.toBeNull()
      expect(parsed?.reason).toBe(reason)
      // Compared against the literal on-disk sentence, not against a second
      // call to aiDestinationRejectionMessage — otherwise a bug that swapped
      // which sentence maps to which reason would be invisible here (both
      // sides would use the same wrong mapping).
      expect(parsed?.message).toBe((enLocale.aiDestination as Record<string, string>)[reason])
    },
  )

  it('declined: the hook reports the save as not applied, using the real reply', async () => {
    const reply = await realRejectedSaveReply('declined')
    const { result } = renderHook(() => useAiDestinationRejection())
    let applied = true
    act(() => { applied = result.current.recordSettingsSaveResult(reply) })
    expect(applied).toBe(false)
    expect(result.current.aiDestinationRejection?.fields).toEqual(['aiOpenAiBaseUrl'])
  })

  it('invalid: the notice renders main\'s real localized sentence, verbatim', async () => {
    const reply = await realRejectedSaveReply('invalid')
    const parsed = parseAiDestinationRejection(reply)
    render(<AiDestinationRejectionNotice rejection={parsed} onRetry={vi.fn()} />)
    const notice = screen.getByTestId('settings-ai-destination-notice')
    expect(notice).toHaveAttribute('data-reason', 'invalid')
    expect(notice).toHaveAttribute('role', 'alert') // the one reason that IS an alert
    expect(screen.getByTestId('settings-ai-destination-message'))
      .toHaveTextContent(enLocale.aiDestination.invalid)
    cleanup()
  })
})
