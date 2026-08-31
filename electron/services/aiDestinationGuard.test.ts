/**
 * §2.119 — the confirmation itself.
 *
 * The property under test is narrow and absolute: the address the user's AI
 * API key is sent to moves only after a human said so in a dialog the renderer
 * cannot produce, and every other outcome (refusal, an unusable address, a
 * second request arriving mid-dialog) leaves the stored address alone and says
 * so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({
  recordEvent: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  getSettings: vi.fn((): Record<string, unknown> => ({ language: 'en' })),
  showMessageBox: vi.fn(),
  fromWebContents: vi.fn(),
  isPackaged: false,
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.isPackaged } },
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}))
vi.mock('../metrics', () => ({ recordEvent: mocks.recordEvent }))
vi.mock('../../packages/net/config', () => ({ getSettings: mocks.getSettings }))

import {
  createAiDestinationGuard,
  buildAiDestinationPrompt,
  aiDestinationLabels,
  aiDestinationRejectionMessage,
  type AiDestinationGuardDeps,
  type AiDestinationPrompt,
} from './aiDestinationGuard'
import { planAiDestinationChanges, type AiDestinationSettings } from './aiDestination'

// `aiProvider` is part of the state the WARNING TEXT describes: the endpoint
// setting is inert under any provider but the OpenAI-compatible one. These
// fixtures have it selected, so the "in use now" wording applies; the
// provider-matrix block below covers the other half.
const STORED: AiDestinationSettings = {
  aiOpenAiBaseUrl: 'https://llm.example.tld',
  aiProxyUrl: undefined,
  aiProvider: 'openai-api',
}
const ATTACKER: AiDestinationSettings = {
  aiOpenAiBaseUrl: 'https://collector.evil.tld',
  aiProxyUrl: undefined,
  aiProvider: 'openai-api',
}

/** A guard whose "human" is a controllable stub. */
function makeGuard(answer: boolean | (() => Promise<boolean>), current = STORED) {
  // The prompt parameter is typed (not ignored) so that assertions on the
  // dialog text below get the real shape rather than `any`.
  const confirm = vi.fn(
    async (prompt: AiDestinationPrompt) => {
      expect(prompt.title).toBeTruthy()
      return typeof answer === 'function' ? answer() : answer
    },
  )
  const deps: AiDestinationGuardDeps = {
    getCurrent: () => current,
    getLanguage: () => 'en',
    confirm,
  }
  return { guard: createAiDestinationGuard(deps), confirm }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSettings.mockReturnValue({ language: 'en' })
})

describe('ensureApproved — when nothing is asked', () => {
  it('does not prompt when the stored value is saved again', async () => {
    const { guard, confirm } = makeGuard(false)
    await expect(guard.ensureApproved({ ...STORED })).resolves.toEqual({ ok: true, prompted: false })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not prompt for a value that normalises to the same destination', async () => {
    const { guard, confirm } = makeGuard(false)
    const verdict = await guard.ensureApproved({
      aiOpenAiBaseUrl: 'HTTPS://LLM.Example.TLD:443/v1/',
      aiProxyUrl: undefined,
    })
    expect(verdict).toEqual({ ok: true, prompted: false })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not prompt when the proxy is removed', async () => {
    const { guard, confirm } = makeGuard(false, { ...STORED, aiProxyUrl: 'http://proxy.corp:3128' })
    await expect(guard.ensureApproved({ ...STORED, aiProxyUrl: undefined }))
      .resolves.toEqual({ ok: true, prompted: false })
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('ensureApproved — a genuinely new destination', () => {
  it('prompts, and only says yes after the human did', async () => {
    const { guard, confirm } = makeGuard(true)
    await expect(guard.ensureApproved(ATTACKER)).resolves.toEqual({ ok: true, prompted: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.recordEvent).toHaveBeenCalledWith('ai.destination_confirm', {
      field: 'endpoint',
      outcome: 'accepted',
    })
  })

  it('names the new address, and the old one, in the prompt', async () => {
    const { guard, confirm } = makeGuard(true)
    await guard.ensureApproved(ATTACKER)
    const prompt = confirm.mock.calls[0][0]
    expect(prompt.detail).toContain('https://collector.evil.tld:443')
    expect(prompt.detail).toContain('https://llm.example.tld:443')
    // Cancel is first, and is what Enter/Esc produce.
    expect(prompt.buttons[0]).toBe(aiDestinationLabels('en').cancelButton)
  })

  it('refuses when the human says no, and reports which field was refused', async () => {
    const { guard, confirm } = makeGuard(false)
    await expect(guard.ensureApproved(ATTACKER)).resolves.toEqual({
      ok: false,
      reason: 'declined',
      fields: ['aiOpenAiBaseUrl'],
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.recordEvent).toHaveBeenCalledWith('ai.destination_confirm', {
      field: 'endpoint',
      outcome: 'declined',
    })
  })

  it('treats a dialog that could not be shown as a refusal', async () => {
    const { guard } = makeGuard(async () => { throw new Error('no display') })
    await expect(guard.ensureApproved(ATTACKER)).resolves.toMatchObject({ ok: false, reason: 'declined' })
  })

  it('does not ask twice for a destination the human already accepted', async () => {
    const { guard, confirm } = makeGuard(true)
    await guard.ensureApproved(ATTACKER)
    // Same address arriving again — e.g. the settings save that follows the
    // connection check the user just confirmed.
    await expect(guard.ensureApproved({ ...ATTACKER, aiOpenAiBaseUrl: 'https://collector.evil.tld/v1/' }))
      .resolves.toEqual({ ok: true, prompted: false })
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('asks again for a DIFFERENT destination after one was accepted', async () => {
    const { guard, confirm } = makeGuard(true)
    await guard.ensureApproved(ATTACKER)
    await guard.ensureApproved({ ...STORED, aiOpenAiBaseUrl: 'https://second.evil.tld' })
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('does not remember a refusal as an approval', async () => {
    const { guard, confirm } = makeGuard(false)
    await guard.ensureApproved(ATTACKER)
    await expect(guard.ensureApproved(ATTACKER)).resolves.toMatchObject({ ok: false, reason: 'declined' })
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('approving an endpoint does not approve the same host as a proxy', async () => {
    const { guard, confirm } = makeGuard(true)
    await guard.ensureApproved({ aiOpenAiBaseUrl: 'http://host.tld:8080', aiProxyUrl: undefined })
    await guard.ensureApproved({ ...STORED, aiProxyUrl: 'http://host.tld:8080' })
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})

describe('ensureApproved — an address that cannot be named', () => {
  it('refuses without opening a dialog', async () => {
    const { guard, confirm } = makeGuard(true)
    await expect(guard.ensureApproved({ ...STORED, aiProxyUrl: 'socks5://proxy.corp:1080' }))
      .resolves.toEqual({ ok: false, reason: 'invalid', fields: ['aiProxyUrl'] })
    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.recordEvent).toHaveBeenCalledWith('ai.destination_confirm', {
      field: 'proxy',
      outcome: 'blocked_invalid',
    })
  })
})

describe('ensureApproved — a second change arriving while the dialog is open', () => {
  it('opens exactly one dialog, refuses the second request, and loses no answer', async () => {
    let release: (answer: boolean) => void = () => {}
    const pending = new Promise<boolean>(resolve => { release = resolve })
    const { guard, confirm } = makeGuard(() => pending)

    const first = guard.ensureApproved(ATTACKER)
    // Let the first call reach the dialog.
    await Promise.resolve()
    const second = await guard.ensureApproved({ ...STORED, aiOpenAiBaseUrl: 'https://second.evil.tld' })

    expect(second).toEqual({ ok: false, reason: 'busy', fields: ['aiOpenAiBaseUrl'] })
    expect(confirm).toHaveBeenCalledTimes(1)

    release(true)
    // The answer belongs to the question that was actually asked.
    await expect(first).resolves.toEqual({ ok: true, prompted: true })
    expect(mocks.recordEvent).toHaveBeenCalledWith('ai.destination_confirm', {
      field: 'endpoint',
      outcome: 'blocked_busy',
    })
  })

  it('accepts a new confirmation once the first one has been answered', async () => {
    let release: (answer: boolean) => void = () => {}
    const pending = new Promise<boolean>(resolve => { release = resolve })
    let answer: () => Promise<boolean> = () => pending
    const { guard, confirm } = makeGuard(() => answer())

    const first = guard.ensureApproved(ATTACKER)
    await Promise.resolve()
    release(false)
    await first

    answer = async () => true
    await expect(guard.ensureApproved({ ...STORED, aiOpenAiBaseUrl: 'https://second.evil.tld' }))
      .resolves.toEqual({ ok: true, prompted: true })
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})

describe('buildAiDestinationPrompt', () => {
  const labels = aiDestinationLabels('en')
  /** The prompt the guard would draw for `current` → `next`. */
  function promptFor(next: AiDestinationSettings, current: AiDestinationSettings = STORED) {
    return buildAiDestinationPrompt(planAiDestinationChanges(current, next), labels, next)
  }

  it('puts both fields in ONE dialog when both move', () => {
    const prompt = promptFor({
      aiOpenAiBaseUrl: 'https://collector.evil.tld',
      aiProxyUrl: 'http://mitm.evil.tld:8080',
    })
    expect(prompt.detail).toContain(labels.endpointLabel)
    expect(prompt.detail).toContain(labels.proxyLabel)
    expect(prompt.detail).toContain('https://collector.evil.tld:443')
    expect(prompt.detail).toContain('http://mitm.evil.tld:8080')
    // The warning about what an address change means is always present.
    expect(prompt.detail).toContain(labels.confirmDetail)
  })

  it('describes the absence of a proxy in words, never as an empty line', () => {
    expect(promptFor({ ...STORED, aiProxyUrl: 'http://mitm.evil.tld:8080' }).detail)
      .toContain(labels.directValue)
  })

  /**
   * WHAT THE PROMPT CLAIMS MUST BE TRUE OF THE STATE IT LEADS TO. An endpoint
   * operator is the TLS peer and holds the key; a forward proxy in front of an
   * https endpoint holds metadata; a proxy in front of an http endpoint holds
   * everything. The last case is the one that made the first version of this
   * wording false, and it is reachable WITHOUT touching the endpoint field —
   * hence every case below is expressed as "the state after approving", not as
   * "the field that changed".
   */
  const HTTP_STORED: AiDestinationSettings = {
    aiOpenAiBaseUrl: 'http://llm.lan:8080',
    aiProxyUrl: undefined,
    aiProvider: 'openai-api',
  }

  it('endpoint change, https after: the endpoint sentence, and only it', () => {
    const prompt = promptFor({ ...STORED, aiOpenAiBaseUrl: 'https://collector.evil.tld' })
    expect(prompt.detail).toContain(labels.endpointRisk)
    expect(prompt.detail).not.toContain(labels.endpointRiskCleartext)
    expect(prompt.detail).not.toContain(labels.proxyRisk)
  })

  it('endpoint change, http after: the cleartext endpoint sentence REPLACES the plain one', () => {
    const prompt = promptFor({ ...STORED, aiOpenAiBaseUrl: 'http://collector.evil.tld' })
    expect(prompt.detail).toContain(labels.endpointRiskCleartext)
    // Not stapled together: the cleartext variant is self-contained, so the
    // base sentence must not also appear as a separate line.
    expect(prompt.detail.split('\n').filter(l => l === labels.endpointRisk)).toEqual([])
  })

  it('proxy change over an https endpoint: metadata only, and it never claims the key', () => {
    const prompt = promptFor({ ...STORED, aiProxyUrl: 'http://proxy.corp:3128' })
    expect(prompt.detail).toContain(labels.proxyRisk)
    expect(prompt.detail).not.toContain(labels.proxyRiskCleartext)
    expect(prompt.detail).not.toContain(labels.endpointRisk)
  })

  /**
   * THE REACHABLE LIE this replaced: the endpoint is already http://, the user
   * changes ONLY the proxy, and the old wording told them — in a native dialog
   * — that this proxy could read nothing without intercepting TLS. Over a
   * cleartext endpoint it reads the key and every message with no interception
   * at all.
   */
  it('proxy change over an http endpoint: says the proxy reads the key, because it does', () => {
    const prompt = promptFor({ ...HTTP_STORED, aiProxyUrl: 'http://mitm.evil.tld:8080' }, HTTP_STORED)
    expect(prompt.detail).toContain(labels.proxyRiskCleartext)
    expect(prompt.detail).not.toContain(labels.proxyRisk)
  })

  it('endpoint moving OFF cleartext is described by where it lands, not where it was', () => {
    const upgrade = promptFor({ ...HTTP_STORED, aiOpenAiBaseUrl: 'https://llm.example.tld' }, HTTP_STORED)
    expect(upgrade.detail).toContain(labels.endpointRisk)
    expect(upgrade.detail).not.toContain(labels.endpointRiskCleartext)

    const downgrade = promptFor({ ...STORED, aiOpenAiBaseUrl: 'http://llm.lan:8080' })
    expect(downgrade.detail).toContain(labels.endpointRiskCleartext)
  })

  it('both fields at once: one endpoint verdict decides BOTH sentences', () => {
    const cleartext = promptFor({ ...STORED, aiOpenAiBaseUrl: 'http://collector.evil.tld', aiProxyUrl: 'http://mitm.evil.tld:8080' })
    expect(cleartext.detail).toContain(labels.endpointRiskCleartext)
    expect(cleartext.detail).toContain(labels.proxyRiskCleartext)
    expect(cleartext.detail).not.toContain(labels.proxyRisk)

    const secure = promptFor({ ...STORED, aiOpenAiBaseUrl: 'https://collector.evil.tld', aiProxyUrl: 'http://mitm.evil.tld:8080' })
    expect(secure.detail).toContain(labels.endpointRisk)
    expect(secure.detail).toContain(labels.proxyRisk)
    expect(secure.detail).not.toContain(labels.proxyRiskCleartext)
  })

  it('a CLEARED endpoint is judged by the vendor default it falls back to, which is https', () => {
    const prompt = promptFor({ ...HTTP_STORED, aiOpenAiBaseUrl: undefined, aiProxyUrl: 'http://proxy.corp:3128' }, HTTP_STORED)
    expect(prompt.detail).toContain(labels.endpointRisk)
    expect(prompt.detail).toContain(labels.proxyRisk)
    expect(prompt.detail).not.toContain(labels.proxyRiskCleartext)
  })

  it('an unusable stored endpoint does not produce a cleartext claim — nothing is sent at all', () => {
    const broken: AiDestinationSettings = { aiOpenAiBaseUrl: 'not a url', aiProxyUrl: undefined }
    const prompt = promptFor({ ...broken, aiProxyUrl: 'http://proxy.corp:3128' }, broken)
    expect(prompt.detail).toContain(labels.proxyRisk)
    expect(prompt.detail).not.toContain(labels.proxyRiskCleartext)
  })

  it('keeps the closing instruction on every prompt', () => {
    for (const next of [
      { ...STORED, aiOpenAiBaseUrl: 'https://collector.evil.tld' },
      { ...STORED, aiOpenAiBaseUrl: 'http://collector.evil.tld' },
      { ...STORED, aiProxyUrl: 'http://proxy.corp:3128' },
    ]) {
      expect(promptFor(next).detail.endsWith(labels.confirmDetail)).toBe(true)
    }
  })

  /**
   * THE STATE IS COMPOSITE. `aiOpenAiBaseUrl` is inert under every provider but
   * the OpenAI-compatible one, so the same two addresses mean different things
   * depending on which provider will be in force after the save. Deriving the
   * sentence from the endpoint alone produced two wrong prompts: an unused
   * `http://` endpoint made the PROXY warning claim the proxy reads the key
   * (Gemini/Anthropic are https), and an endpoint change under
   * another provider was described as rerouting requests that it does not
   * touch.
   */
  describe('provider matrix', () => {
    const GEMINI_HTTP: AiDestinationSettings = {
      aiOpenAiBaseUrl: 'http://llm.lan:8080',
      aiProxyUrl: undefined,
      aiProvider: 'gemini-api',
    }

    it('proxy change under Gemini with a stale http endpoint: no cleartext claim', () => {
      const prompt = promptFor({ ...GEMINI_HTTP, aiProxyUrl: 'http://proxy.corp:3128' }, GEMINI_HTTP)
      expect(prompt.detail).toContain(labels.proxyRisk)
      expect(prompt.detail).not.toContain(labels.proxyRiskCleartext)
    })

    it('the same proxy change under the OpenAI-compatible provider DOES claim it', () => {
      const openai = { ...GEMINI_HTTP, aiProvider: 'openai-api' }
      const prompt = promptFor({ ...openai, aiProxyUrl: 'http://proxy.corp:3128' }, openai)
      expect(prompt.detail).toContain(labels.proxyRiskCleartext)
    })

    it.each(['gemini-api', 'anthropic-api', 'stale-provider', undefined])(
      'endpoint change under %s is described as taking effect later, not now',
      provider => {
        const current = { ...GEMINI_HTTP, aiOpenAiBaseUrl: undefined, aiProvider: provider }
        const prompt = promptFor({ ...current, aiOpenAiBaseUrl: 'https://collector.evil.tld' }, current)
        expect(prompt.detail).toContain(labels.endpointRiskInactive)
        expect(prompt.detail).not.toContain(labels.endpointRisk)
      },
    )

    it('an inactive endpoint that is also http:// still says so', () => {
      const current = { ...GEMINI_HTTP, aiOpenAiBaseUrl: undefined }
      const prompt = promptFor({ ...current, aiOpenAiBaseUrl: 'http://collector.evil.tld' }, current)
      expect(prompt.detail).toContain(labels.endpointRiskInactiveCleartext)
    })

    it('a save that switches provider AND endpoint together is described by the result', () => {
      // Stored: Gemini. Saved: OpenAI-compatible + a new endpoint. The address
      // becomes live in the same save, so the active wording is the true one.
      const current = { ...GEMINI_HTTP, aiOpenAiBaseUrl: undefined }
      const prompt = promptFor(
        { aiOpenAiBaseUrl: 'https://collector.evil.tld', aiProxyUrl: undefined, aiProvider: 'openai-api' },
        current,
      )
      expect(prompt.detail).toContain(labels.endpointRisk)
      expect(prompt.detail).not.toContain(labels.endpointRiskInactive)
    })
  })
})

/**
 * Locale coverage — same construction and the same reason as the one in
 * contextMenu.test.ts: the i18n merge gate only sees src/i18n/locales/*.json,
 * so a seventh language would ship with a silently English SECURITY prompt
 * unless something walks the directory.
 */
const LOCALE_DIR = fileURLToPath(new URL('../../src/i18n/locales', import.meta.url))
const SHIPPED_LOCALES = readdirSync(LOCALE_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.slice(0, -'.json'.length))
  .sort()

describe('aiDestinationLabels', () => {
  it('serves every locale that ships in src/i18n/locales, straight from that file', () => {
    expect(SHIPPED_LOCALES.length).toBeGreaterThanOrEqual(6)
    for (const lang of SHIPPED_LOCALES) {
      const onDisk = JSON.parse(readFileSync(join(LOCALE_DIR, `${lang}.json`), 'utf8')).aiDestination
      expect(onDisk, `${lang}.json is missing the aiDestination block`).toBeTruthy()
      expect(aiDestinationLabels(lang), `${lang} destination labels`).toEqual(onDisk)
    }
  })

  it('falls back to English for an unknown language without leaving a key empty', () => {
    expect(aiDestinationLabels('xx')).toEqual(aiDestinationLabels('en'))
    for (const lang of SHIPPED_LOCALES) {
      for (const [key, value] of Object.entries(aiDestinationLabels(lang))) {
        expect(value, `${lang}.${key}`).toBeTruthy()
      }
    }
  })
})

/**
 * The real dialog path, through the process-wide guard. Loaded fresh per case
 * because the singleton caches its approval set.
 */
async function freshGuard() {
  vi.resetModules()
  const mod = await import('./aiDestinationGuard')
  return mod.getAiDestinationGuard()
}

describe('the native confirmation', () => {
  const NEW_DESTINATION = { aiOpenAiBaseUrl: 'https://collector.evil.tld', aiProxyUrl: undefined }

  beforeEach(() => {
    mocks.getSettings.mockReturnValue({ language: 'en', aiOpenAiBaseUrl: 'https://llm.example.tld' })
    mocks.fromWebContents.mockReturnValue(null)
  })

  it('shows an OS dialog and treats only the second button as acceptance', async () => {
    delete process.env.MAILCOPILOT_E2E
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const guard = await freshGuard()
    await expect(guard.ensureApproved(NEW_DESTINATION)).resolves.toMatchObject({ ok: false, reason: 'declined' })
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    const opts = mocks.showMessageBox.mock.calls[0][0] as { detail: string; defaultId: number; cancelId: number }
    expect(opts.detail).toContain('https://collector.evil.tld:443')
    // A stray Enter or Esc lands on Cancel.
    expect(opts.defaultId).toBe(0)
    expect(opts.cancelId).toBe(0)

    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    const guard2 = await freshGuard()
    await expect(guard2.ensureApproved(NEW_DESTINATION)).resolves.toEqual({ ok: true, prompted: true })
  })

  it('auto-approves ONLY in an unpackaged e2e run — the env var alone buys nothing', async () => {
    process.env.MAILCOPILOT_E2E = '1'
    mocks.isPackaged = true
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const packaged = await freshGuard()
    // A shipped binary ignores the flag: the dialog is still drawn, and the
    // refusal still stands.
    await expect(packaged.ensureApproved(NEW_DESTINATION)).resolves.toMatchObject({ ok: false })
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)

    mocks.isPackaged = false
    mocks.showMessageBox.mockClear()
    const harness = await freshGuard()
    await expect(harness.ensureApproved(NEW_DESTINATION)).resolves.toEqual({ ok: true, prompted: true })
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    delete process.env.MAILCOPILOT_E2E
  })
})

describe('aiDestinationRejectionMessage', () => {
  it('gives the renderer a localized sentence per refusal reason', () => {
    const ru = aiDestinationLabels('ru')
    expect(aiDestinationRejectionMessage('declined', 'ru')).toBe(ru.declined)
    expect(aiDestinationRejectionMessage('invalid', 'ru')).toBe(ru.invalid)
    expect(aiDestinationRejectionMessage('busy', 'ru')).toBe(ru.busy)
    // Distinct texts: "you said no" and "that address is unusable" are
    // different things to tell a user.
    expect(new Set([ru.declined, ru.invalid, ru.busy]).size).toBe(3)
  })
})
