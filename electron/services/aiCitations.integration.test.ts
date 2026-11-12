/**
 * Citation tickets against the REAL execution path (§3.3 B3): `@ai-sdk/openai-compatible` parses a scripted SSE
 * body, `streamText` drives the real step loop, `@ai-sdk/mcp` runs the real `get_email` / `search_emails` /
 * `list_emails` tools over an in-memory transport, and `aiCitations.ts` is real. Only `fetch`, the process-level
 * services and the database are faked. What it pins: the model is handed a READY link next to every row it reads
 * (so it can only repeat it), the link is issued for the session of the request, and nothing is issued without a
 * session or a Message-ID. What a ticket resolves to is covered by `aiCitations.test.ts` and the db tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSecretStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}))


vi.mock('./secretStore', () => ({
  secretStore: mockSecretStore,
}))


// `aiFetch` now always dispatches through npm undici (with the mail CA set, see
// aiHttpDispatcher.ts). The suite's many `vi.spyOn(globalThis, 'fetch')` stubs
// stay the network seam: undici's `fetch` is routed to whatever `globalThis.fetch`
// is at call time. `Agent` / `ProxyAgent` stay REAL — the proxy tests rely on the
// real constructor throwing on a malformed URL. The dispatcher's own trust
// behaviour is proven against a live TLS server in aiHttpDispatcher.test.ts.
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

vi.mock('ai', async (importActual) => importActual<typeof import('ai')>())

vi.mock('@napi-rs/canvas', () => ({
  createCanvas: vi.fn(() => ({
    getContext: vi.fn(() => ({
      drawImage: vi.fn(),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16) })),
      putImageData: vi.fn(),
    })),
    toBuffer: vi.fn(() => Buffer.from('resized-img')),
  })),
  loadImage: vi.fn(async () => ({ width: 100, height: 100 })),
}))


const mockGetMessageByUid = vi.hoisted(() => vi.fn())
const mockGetMessages = vi.hoisted(() => vi.fn(() => [] as unknown[]))
const mockSearchMessages = vi.hoisted(() => vi.fn(() => [] as unknown[]))
const mockMintAiCitation = vi.hoisted(() => vi.fn())

const mockDbPrepare = vi.hoisted(() => vi.fn(() => ({
  all: vi.fn(() => []),
})))

// §2.162 — stored rule behind `getMailRule`. The update tools judge a refusal on
// the rule as it will be after the patch, so a test that submits only one half
// (actions, say) drives what the other half is by setting this.
const mockGetMailRule = vi.hoisted(() =>
  vi.fn((): { conditions: string; actions: string } | undefined => undefined),
)

// §2.51 — hoisted so both the db-mock `sumAiCostSince` export AND the
// `admitAiReservation` mock (which reproduces the primitive's projected cap check
// against the same ledger sum) read ONE controllable source. Tests drive over-cap
// vs within-budget by setting this mock's return value.
const mockSumAiCostSince = vi.hoisted(() => vi.fn((sinceIso?: string): number => {
  void sinceIso
  return 0
}))

// §2.51 — real-shaped `AiBudgetReserveError` hoisted so the db-mock export and the
// `admitAiReservation` mock throw the SAME class → `err instanceof
// AiBudgetReserveError` in `admitBudgetedCall` matches when a test drives the
// fail-closed deny.
const MockAiBudgetReserveError = vi.hoisted(() => class AiBudgetReserveError extends Error {
  readonly reason: 'invalid-amount' | 'ledger-write-failed'
  readonly cause?: unknown
  constructor(reason: 'invalid-amount' | 'ledger-write-failed', message: string, cause?: unknown) {
    super(message)
    this.name = 'AiBudgetReserveError'
    this.reason = reason
    this.cause = cause
  }
})

// §2.51 — atomic admission mock reproducing the real db primitive's contract:
// projected `currentSum + reservationUsd > limit` over each active window (using
// the shared `mockSumAiCostSince`), returning `{ ok: false, reason: 'over-cap' }`
// on breach and inserting a reservation otherwise. A non-finite/non-positive
// amount THROWS (fail-closed), matching the primitive. Tests can override this
// with `mockAdmitAiReservation.mockImplementationOnce(...)` for edge cases.
const mockAdmitAiReservation = vi.hoisted(() => vi.fn((
  _accountId: string,
  _provider: string,
  _model: string | null,
  reservationUsd: number,
  windows: ReadonlyArray<{ sinceIso: string; limitUsd: number }>,
) => {
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0) {
    throw new MockAiBudgetReserveError('invalid-amount', `bad amount: ${String(reservationUsd)}`)
  }
  for (const w of windows) {
    if (!Number.isFinite(w.limitUsd) || w.limitUsd <= 0) continue
    const currentSum = mockSumAiCostSince(w.sinceIso)
    if (currentSum + reservationUsd > w.limitUsd) {
      return { ok: false as const, reason: 'over-cap' as const }
    }
  }
  return {
    ok: true as const,
    reservation: { id: 42, reservedUsd: reservationUsd, sessionId: '__ai_cost_ledger__', createdAt: '2024-01-01T00:00:00Z' },
  }
}))

vi.mock('../../packages/db', () => ({
  default: { prepare: mockDbPrepare },
  getMessages: mockGetMessages,
  getMessageByUid: mockGetMessageByUid,
  countUnreadMessages: vi.fn(() => 0),
  getThreadMessages: vi.fn(() => []),
  getMessagesBeforeUid: vi.fn(() => []),
  searchMessages: mockSearchMessages,
  mintAiCitation: mockMintAiCitation,
  getAiCitation: vi.fn(),
  listAiCitations: vi.fn(() => []),
  findMessageForSource: vi.fn(),
  searchContacts: vi.fn(() => []),
  listFolderPrefs: vi.fn(() => []),
  listFolderStats: vi.fn(() => []),
  sumAiCostSince: mockSumAiCostSince,
  // §2.51 — atomic, fail-closed budget admission primitives. `admitAiReservation`
  // does the projected cap check + reservation insert in ONE tx (used by aiChat /
  // generateQuickActionRewrite / generateInstantReplyDrafts for admission);
  // `reconcileAiReservation` settles to the actual cost after the provider returns.
  admitAiReservation: mockAdmitAiReservation,
  reconcileAiReservation: vi.fn((_reservation: unknown, actualUsd: number) => ({
    settled: true,
    finalUsd: Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0,
  })),
  // Real class so `err instanceof AiBudgetReserveError` in admitBudgetedCall works
  // when a test drives admitAiReservation to throw the fail-closed deny signal.
  AiBudgetReserveError: MockAiBudgetReserveError,
  // §3.3 B1 — audit log functions used in aiChat() finally block.
  appendAiActionLog: vi.fn(),
  listAiActionLog: vi.fn(() => ({ rows: [], total: 0 })),
  aggregateAiUsage: vi.fn(() => []),
  softDeleteAiActionEntry: vi.fn(() => true),
  clearAiActionLog: vi.fn(() => 0),
  exportAiActionLog: vi.fn(() => '[]'),
  listMailRules: vi.fn(() => []),
  // §2.162 — the update path reads the stored rule back so a refusal is judged
  // on the rule as it will be AFTER the patch, not on the submitted half alone.
  getMailRule: mockGetMailRule,
  createMailRule: vi.fn(),
  updateMailRule: vi.fn(),
  deleteMailRule: vi.fn(),
  listRuleLog: vi.fn(() => []),
}))

// §2.122 — the non-secret "a key for this provider was saved" marker. Mocked
// here so the save/delete tests can assert that main (and only main) writes it,
// without an electron-store on disk.
const mockSetAiApiKeySavedFlag = vi.hoisted(() => vi.fn())

vi.mock('../../packages/net/config', () => ({
  listAccounts: vi.fn(() => []),
  getAccountMeta: vi.fn(),
  getSettings: vi.fn(() => ({})),
  setAiApiKeySavedFlag: mockSetAiApiKeySavedFlag,
}))

const mockUserDataDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'mailcopilot-ai-test-'))
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockUserDataDir),
  },
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/claude\n'),
}))

const mockLogAI = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => mockLogAI),
}))

const mockSpan = vi.hoisted(() => ({
  setAttributes: vi.fn(),
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
}))

const mockSentryLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  fmt: vi.fn(),
}))

const mockStartInactiveSpan = vi.hoisted(() => vi.fn(() => mockSpan))
const mockReportKeychainUnavailable = vi.hoisted(() => vi.fn())
const mockCaptureException = vi.hoisted(() => vi.fn())

vi.mock('../sentry', () => ({
  startInactiveSpan: mockStartInactiveSpan,
  sentryLogger: mockSentryLogger,
  wrapMcpServerWithSentry: vi.fn((server: unknown) => server),
  captureException: mockCaptureException,
  reportKeychainUnavailable: mockReportKeychainUnavailable,
}))

// §2.82 — metric spans (and every other telemetry sink) are gated on the
// recorded consent decision, which defaults to "not allowed" in a fresh
// process. This suite asserts on the spans the AI service opens, so it has to
// describe the consented state explicitly; the gate itself is covered in
// electron/telemetryGate.test.ts.
import { setTelemetryCollectionAllowed } from '../telemetryGate'
setTelemetryCollectionAllowed(true)

import { aiChat, type AiStreamEvent } from './ai'
import { getSettings } from '../../packages/net/config'



/** An SSE body: each entry is one `data:` event; the stream then simply closes. */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function drainStepping(gen: AsyncGenerator<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = []
  let finished = false
  const pending = (async () => { for await (const e of gen) events.push(e) })().finally(() => { finished = true })
  while (!finished) await vi.advanceTimersByTimeAsync(1000)
  await pending
  return events
}


const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: typeof USAGE): string => JSON.stringify({
  id: 'chatcmpl-src', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
})

/** The final step: text only. */
function textStep(text: string): Response {
  return sseResponse([chunk({ role: 'assistant', content: text }), chunk({}, 'stop', USAGE), '[DONE]'])
}


const ticket = (uid: number): string => `kkkkkk${'abcdefgh'[uid % 8]}${'abcdefgh'[Math.floor(uid / 8) % 8]}`
const link = (uid: number): string => `mailref://c/${ticket(uid)}`

const row = (uid: number, over: Record<string, unknown> = {}) => ({
  accountId: 1, folder: 'INBOX', uid, messageId: `<${uid}@test>`, subject: `Subject ${uid}`, from: 'Alice', fromAddr: 'alice@example.test',
  date: '2026-01-01', bodyText: `Body of message ${uid}`, unread: false, flagged: false, hasAttachments: false, ...over,
})

async function ask(opts: { sessionId?: string; context?: { type: 'email'; data: unknown } } = {}): Promise<{ events: AiStreamEvent[] }> {
  vi.mocked(getSettings).mockReturnValue({ aiProvider: 'openai-api', aiMaxBudgetPerRequest: 5, aiDailyBudgetUsd: 5 } as never)
  const events = await drainStepping(aiChat({ requestId: `cite-${Math.random()}`, prompt: 'what is in my mail?', sessionId: opts.sessionId, context: opts.context }))
  return { events }
}

/** A step that calls one tool, then a final text step: the second request carries the tool result. */
function twoSteps(tool: string, args: Record<string, unknown>) {
  let n = 0
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    n++
    return n === 1
      ? sseResponse([
          chunk({ role: 'assistant', content: 'Let me look.' }),
          chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }),
          chunk({}, 'tool_calls', USAGE),
          '[DONE]',
        ])
      : textStep('Done.')
  })
}

describe('citation tickets against the real step loop (§3.3 B3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mockSecretStore.get.mockResolvedValue('sk-test-key')
    mockGetMessageByUid.mockImplementation((accountId: number, folder: string, uid: number) => row(uid, { accountId, folder }))
    mockMintAiCitation.mockImplementation((_sid: string, r: { uid: number; messageId?: string | null }) => (r.messageId ? ticket(r.uid) : null))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // The text the model actually reads in each request: every string of the request body, un-escaped.
  const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
  const bodies = (spy: { mock: { calls: unknown[][] } }): string[] =>
    spy.mock.calls.map(call => strings(JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}'))).join('\n'))

  it('get_email: the model is handed a ready link in the row it reads, issued for this session', async () => {
    const fetchSpy = twoSteps('get_email', { accountId: 1, folder: 'INBOX', uid: 42 })
    await ask({ sessionId: 's1' })
    expect(mockMintAiCitation).toHaveBeenCalledWith('s1', expect.objectContaining({ accountId: 1, folder: 'INBOX', uid: 42, messageId: '<42@test>' }))
    // the ticket is the FIRST field of the row the model reads
    // Backslashes dropped first, so the check does not depend on how many JSON layers escaped the quotes.
    expect(bodies(fetchSpy)[1]!.split('\\').join('')).toContain(`{"cite":"${link(42)}`)
  })

  it('search_emails: every row has its own link', async () => {
    mockSearchMessages.mockReturnValue([row(10), row(11)])
    const spy = twoSteps('search_emails', { accountId: 1, query: 'invoice' })
    await ask({ sessionId: 's1' })
    const body = bodies(spy)[1]!
    expect(body).toContain(link(10))
    expect(body).toContain(link(11))
  })

  it('list_emails: every row has its own link', async () => {
    mockGetMessages.mockReturnValue([row(20)])
    const spy = twoSteps('list_emails', { accountId: 1, folder: 'INBOX' })
    await ask({ sessionId: 's1' })
    expect(bodies(spy)[1]).toContain(link(20))
  })

  it('the model text never carries the Message-ID or a place link; only the ready link identifies the row', async () => {
    const fetchSpy = twoSteps('search_emails', { accountId: 1, query: 'invoice' })
    mockSearchMessages.mockReturnValue([row(10)])
    await ask({ sessionId: 's1' })
    expect(bodies(fetchSpy)[1]).not.toContain('<10@test>')
  })

  it('no session, no link: nothing is issued and the row carries no cite field', async () => {
    const fetchSpy = twoSteps('get_email', { accountId: 1, folder: 'INBOX', uid: 42 })
    await ask({})
    expect(mockMintAiCitation).not.toHaveBeenCalled()
    expect(bodies(fetchSpy)[1]).not.toContain(link(42))
    expect(bodies(fetchSpy)[1]).not.toMatch(/cite\\*":\\*"mailref/)
  })

  it('a message without a Message-ID gets no link', async () => {
    mockGetMessageByUid.mockImplementation((accountId: number, folder: string, uid: number) => row(uid, { accountId, folder, messageId: null }))
    const fetchSpy = twoSteps('get_email', { accountId: 1, folder: 'INBOX', uid: 42 })
    await ask({ sessionId: 's1' })
    expect(bodies(fetchSpy)[1]).not.toContain(link(42))
    expect(bodies(fetchSpy)[1]).not.toMatch(/cite\\*":\\*"mailref/)
  })

  it('the open message of the UI context gets its link in the prompt', async () => {
    let n = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { n++; return textStep('ok') })
    await ask({ sessionId: 's1', context: { type: 'email', data: { accountId: 1, folder: 'INBOX', uid: 77, subject: 'Hi' } } })
    expect(n).toBe(1)
    expect(mockMintAiCitation).toHaveBeenCalledWith('s1', expect.objectContaining({ uid: 77 }))
    expect(bodies(fetchSpy)[0]).toContain(link(77))
  })

  it('a cite field the renderer put into the UI context never replaces main\'s ticket', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => textStep('ok'))
    await ask({ sessionId: 's1', context: { type: 'email', data: { accountId: 1, folder: 'INBOX', uid: 77, subject: 'Hi', cite: 'mailref://c/zzzzzzzz' } } })
    const prompt = bodies(fetchSpy)[0]!
    expect(prompt).toContain(link(77))
    expect(prompt).not.toContain('mailref://c/zzzzzzzz')
  })

  it('the system prompt tells the model to copy the cite field and not to compose a link', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => textStep('ok'))
    await ask({ sessionId: 's1' })
    const first = bodies(fetchSpy)[0]!
    expect(first).toContain('copying the')
    expect(first).toMatch(/"cite" field/)
    expect(first).toContain('NEVER compose or edit a mailref link yourself')
  })
})
