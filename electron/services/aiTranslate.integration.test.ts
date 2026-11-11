/**
 * Chunked message translation against the REAL one-shot AI path.
 *
 * Real here: `translateMessage` (gate, splitting, bounded concurrency,
 * all-or-nothing join), `buildTranslateDeps`, and in `ai.ts` the one-shot
 * `aiChatSimpleOutcome` request builder, the §2.51 admission and settlement,
 * and the provider-verdict parsing. Scripted: the network edge (`fetch`), which
 * plays an OpenAI-compatible endpoint, and the process-level stores. The unit
 * suite injects `chat` by hand and so cannot see the request body, the
 * `finish_reason` mapping or the real admission being called once per request.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const mockSecretStore = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }))
vi.mock('./secretStore', () => ({ secretStore: mockSecretStore }))

vi.mock('undici', async (importActual) => {
  const actual = await importActual<typeof import('undici')>()
  return {
    ...actual,
    fetch: vi.fn((url: string, init?: RequestInit & { dispatcher?: unknown }) => {
      const rest: RequestInit & { dispatcher?: unknown } = { ...init }
      delete rest.dispatcher
      return globalThis.fetch(url, rest)
    }),
  }
})

vi.mock('@napi-rs/canvas', () => ({
  createCanvas: vi.fn(),
  loadImage: vi.fn(),
}))

const mockAdmit = vi.hoisted(() => vi.fn((_a: string, _p: string, _m: string | null, usd: number) => ({
  ok: true as const,
  reservation: { id: 1, reservedUsd: usd, sessionId: '__ai_cost_ledger__', createdAt: '2024-01-01T00:00:00Z' },
})))
const mockReconcile = vi.hoisted(() => vi.fn((_r: unknown, usd: number) => ({ settled: true, finalUsd: usd })))
const mockAudit = vi.hoisted(() => vi.fn())
const mockUpsert = vi.hoisted(() => vi.fn())
const mockMessageText = vi.hoisted(() => ({ value: '' }))

const MockBudgetError = vi.hoisted(() => class AiBudgetReserveError extends Error {})

vi.mock('../../packages/db', () => ({
  default: { prepare: vi.fn(() => ({ all: vi.fn(() => []) })) },
  getMessages: vi.fn(() => []),
  getMessageByUid: vi.fn(() => ({ bodyText: mockMessageText.value })),
  countUnreadMessages: vi.fn(() => 0),
  getThreadMessages: vi.fn(() => []),
  getMessagesBeforeUid: vi.fn(() => []),
  searchMessages: vi.fn(() => []),
  searchContacts: vi.fn(() => []),
  listFolderPrefs: vi.fn(() => []),
  listFolderStats: vi.fn(() => []),
  sumAiCostSince: vi.fn(() => 0),
  admitAiReservation: mockAdmit,
  reconcileAiReservation: mockReconcile,
  AiBudgetReserveError: MockBudgetError,
  appendAiActionLog: mockAudit,
  listAiActionLog: vi.fn(() => ({ rows: [], total: 0 })),
  aggregateAiUsage: vi.fn(() => []),
  softDeleteAiActionEntry: vi.fn(() => true),
  clearAiActionLog: vi.fn(() => 0),
  exportAiActionLog: vi.fn(() => '[]'),
  listMailRules: vi.fn(() => []),
  getMailRule: vi.fn(),
  createMailRule: vi.fn(),
  updateMailRule: vi.fn(),
  deleteMailRule: vi.fn(),
  listRuleLog: vi.fn(() => []),
  computeTranslationSourceHash: (text: string) => `h${text.length}`,
  getAiTranslation: vi.fn(() => undefined),
  upsertAiTranslation: mockUpsert,
}))

const SETTINGS = {
  aiProvider: 'openai-api',
  aiOpenAiBaseUrl: 'https://llm.example.test',
  aiModel: 'gpt-4o-mini',
  aiTranslateEnabled: { '1': true },
}
vi.mock('../../packages/net/config', () => ({
  listAccounts: vi.fn(() => []),
  getAccountMeta: vi.fn(),
  getSettings: vi.fn(() => SETTINGS),
  setAiApiKeySavedFlag: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))
vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import { DATA_BOUNDARY_END, DATA_BOUNDARY_START } from '../../packages/core'
import { translateMessage, __resetRecentTranslationsForTests } from './aiTranslate'

/** The piece the model was shown, out of the request body's user message. */
function pieceFromRequest(init: RequestInit): string {
  const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }
  const user = body.messages.find((m) => m.role === 'user')!.content
  const from = user.indexOf(`${DATA_BOUNDARY_START}\n`) + DATA_BOUNDARY_START.length + 1
  return user.slice(from, user.lastIndexOf(`\n${DATA_BOUNDARY_END}`))
}

function completion(text: string, finish: string = 'stop', completionTokens = 50): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: finish }],
    usage: { prompt_tokens: 120, completion_tokens: completionTokens },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** 20 000 characters of mail: a short reply on top of quoted history. */
function mailWithQuotedHistory(): string {
  const head = 'Thanks, Thursday works for me.\n\nPlease send the signed invoice.\n\nOn Mon, Alice wrote:\n'
  const quoted = Array.from({ length: 2000 }, (_, i) => `> Earlier line ${i}: the contract terms were discussed.`)
  return (head + quoted.join('\n')).slice(0, 20_000)
}

describe('translateMessage — a long message through the real one-shot path', () => {
  const REQ = { accountId: 1, folder: 'INBOX', uid: 7, targetLang: 'ru' as const, sourceLang: 'en' as const }
  let fetchSpy: MockInstance<typeof fetch>

  beforeEach(() => {
    __resetRecentTranslationsForTests()
    mockSecretStore.get.mockResolvedValue('sk-test')
    mockMessageText.value = mailWithQuotedHistory()
    mockAdmit.mockClear(); mockReconcile.mockClear(); mockAudit.mockClear(); mockUpsert.mockClear()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => { fetchSpy.mockRestore() })

  it('translates a 20 000 character message with quoted history in several bounded requests', async () => {
    let inFlight = 0
    let peak = 0
    fetchSpy.mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return completion(pieceFromRequest(init!).toUpperCase())
    }) as typeof fetch)

    const res = await translateMessage(REQ)

    expect(res.ok).toBe(true)
    const requests = fetchSpy.mock.calls.length
    expect(requests).toBeGreaterThanOrEqual(7)
    expect(requests).toBeLessThanOrEqual(9)
    expect(peak).toBe(3)
    // Every request carries one piece within the per-request budget.
    for (const [, init] of fetchSpy.mock.calls) {
      expect(pieceFromRequest(init as RequestInit).length).toBeLessThanOrEqual(3000)
    }
    // The whole translation, paragraph breaks intact.
    if (res.ok) expect(res.translation.translatedText).toBe(mockMessageText.value.toUpperCase().trim())
    // The real admission and settlement ran once per request, one audit row each,
    // and the cache got the WHOLE translation once.
    expect(mockAdmit).toHaveBeenCalledTimes(requests)
    expect(mockReconcile).toHaveBeenCalledTimes(requests)
    expect(mockAudit).toHaveBeenCalledTimes(requests)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })

  it('shows nothing and caches nothing when one piece stops at the output limit', async () => {
    let n = 0
    fetchSpy.mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
      n++
      // The provider's own verdict on the third answer: it ran out of room.
      return n === 3 ? completion('half of a transl', 'length', 2500) : completion(pieceFromRequest(init!))
    }) as typeof fetch)

    const res = await translateMessage(REQ)

    expect(res).toEqual({ ok: false, reason: 'answer_too_long' })
    expect(mockUpsert).not.toHaveBeenCalled()
    // Remaining pieces were not started once the failure was known.
    expect(fetchSpy.mock.calls.length).toBeLessThan(10)
  })

  it('fails the whole translation on a provider 4xx for one piece', async () => {
    let n = 0
    fetchSpy.mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
      n++
      return n === 2
        ? new Response('{}', { status: 400 })
        : completion(pieceFromRequest(init!))
    }) as typeof fetch)

    await expect(translateMessage(REQ)).resolves.toEqual({ ok: false, reason: 'provider_error' })
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('refuses a message over 60 000 characters before any request', async () => {
    mockMessageText.value = 'word '.repeat(12_001)
    fetchSpy.mockImplementation((async () => completion('x')) as typeof fetch)
    await expect(translateMessage(REQ)).resolves.toEqual({ ok: false, reason: 'too_long' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
