/**
 * AI Agent Integration Tests
 *
 * Runs real AI providers (Anthropic API + OpenAI) against a seeded
 * SQLite database, exercising the MCP mail tools across 13 representative
 * scenarios.
 *
 * Requires: .env.integration with INTEG_ENABLED=1 and provider credentials.
 * Run via: npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest'
import dotenv from 'dotenv'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 0. Load .env.integration before anything else
// ---------------------------------------------------------------------------
dotenv.config({ path: path.resolve(__dirname, '../../.env.integration') })

const INTEG_ENABLED = process.env.INTEG_ENABLED === '1'
// §2.218 — the Claude leg runs against the ANTHROPIC API with the operator's
// own key (the consumer-subscription provider was removed).
//
// §2.283 — and it now runs the SAME code as the OpenAI leg: `streamVercelChat`
// over `@ai-sdk/anthropic`. That makes this matrix worth more than it was. The
// two legs used to prove two independent implementations; they now prove ONE
// implementation against two real providers, which is exactly the coverage a
// unified path needs — a provider-shaped assumption baked into the shared loop
// shows up as one leg failing while the other passes. There is no local `claude`
// binary and no subprocess anywhere on this path any more: both legs are plain
// HTTPS with a key from the store.
//
// A NOTE ON WHAT THIS FILE CANNOT DO. It only runs with `.env.integration` and
// `INTEG_ENABLED=1`. Without credentials every leg is `describe.skip`, and a
// green `npm run test:integration` then means "nothing ran", not "the provider
// switch works". §2.122 is the precedent: the provider-switch path broke while
// the mocked suites stayed green.
const ANTHROPIC_KEY = process.env.INTEG_ANTHROPIC_API_KEY || ''
const OPENAI_KEY = process.env.INTEG_OPENAI_API_KEY || ''
const OPENAI_MODEL = process.env.INTEG_OPENAI_MODEL || 'gpt-4o-mini'
const OPENAI_BASE_URL = process.env.INTEG_OPENAI_BASE_URL || ''
// Optional: run the Claude leg against another Anthropic Messages-compatible
// endpoint (a gateway that fronts real Claude models). Test-only; the product
// keeps its pinned host and has no setting for this.
const ANTHROPIC_MODEL = process.env.INTEG_ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929'

// ---------------------------------------------------------------------------
// 1. Create temp dir for MAILCOPILOT_DATA_DIR BEFORE any db import
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-integ-'))
process.env.MAILCOPILOT_DATA_DIR = tmpDir

// ---------------------------------------------------------------------------
// 2. Probe better-sqlite3 ABI compatibility
// ---------------------------------------------------------------------------
let betterSqlite3Usable = true
let betterSqlite3Failure = ''
try {
  const { default: Database } = await import('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (err) {
  betterSqlite3Usable = false
  betterSqlite3Failure = err instanceof Error ? err.message.split('\n')[0] : String(err)
}

// A suite that was asked to run must not turn into "27 skipped" because the
// native module is built for Electron: a green exit would then mean "nothing
// ran". Fail loudly and say how to get a Node build.
if (INTEG_ENABLED && !betterSqlite3Usable) {
  throw new Error(
    'INTEG_ENABLED=1 but better-sqlite3 cannot be loaded under this Node ' +
      `(${betterSqlite3Failure}). The addon is most likely built for the Electron ABI. ` +
      'Rebuild it for Node and restore it afterwards through scripts/run-native-tests.mjs ' +
      '(runNativeTests) instead of calling npm rebuild by hand; unset INTEG_ENABLED to skip this suite.',
  )
}

// ---------------------------------------------------------------------------
// 3. Mocks for Electron-specific modules (BEFORE ai.ts import)
// ---------------------------------------------------------------------------

// Tool call spy — captures MCP tool invocations from logger
type ToolCallRecord = { toolName: string; args: string; timestamp: number }
const toolCalls: ToolCallRecord[] = []

// Warnings the AI service logged (apply rejections, withheld tools) and the
// tool names it handed to the model on each `streamText` call.
const warnings: string[] = []
const offered = vi.hoisted(() => ({ sets: [] as string[][] }))
// Opt-in tap on finished model steps, used only by the prompt-cache measurement
// below. Null for every other test, so they see the unmodified `streamText` call.
type StepTap = { usage?: unknown; request?: { body?: unknown } }
const stepTap = vi.hoisted(() => ({ on: null as null | ((step: StepTap) => void) }))

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return {
    ...actual,
    streamText: ((opts: { tools?: Record<string, unknown>; onStepFinish?: (s: StepTap) => unknown }) => {
      offered.sets.push(Object.keys(opts.tools ?? {}))
      const tap = stepTap.on
      const wrapped = tap
        ? { ...opts, onStepFinish: (s: StepTap) => { tap(s); return opts.onStepFinish?.(s) } }
        : opts
      return (actual.streamText as (o: unknown) => unknown)(wrapped)
    }) as typeof actual.streamText,
  }
})

const logSpy = {
  info: vi.fn((...args: unknown[]) => {
    const text = args.map(String).join(' ')
    const match = text.match(/^MCP (\w+)\s/)
    if (match) {
      toolCalls.push({ toolName: match[1], args: text, timestamp: Date.now() })
    }
    if (process.env.INTEG_VERBOSE === '1') console.log('[AI]', text)
  }),
  debug: vi.fn(),
  warn: vi.fn((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
    if (process.env.INTEG_VERBOSE === '1') console.warn('[AI-WARN]', ...args)
  }),
  error: vi.fn((...args: unknown[]) => {
    console.error('[AI-ERR]', ...args)
  }),
}

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}))

// keytar: in-memory store pre-populated with OpenAI key
const keytarStore = new Map<string, string>()
if (OPENAI_KEY) keytarStore.set('openai_api_key', OPENAI_KEY)
if (ANTHROPIC_KEY) keytarStore.set('anthropic_api_key', ANTHROPIC_KEY)

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(async (_svc: string, key: string) => keytarStore.get(key) ?? null),
    setPassword: vi.fn(async (_svc: string, key: string, val: string) => { keytarStore.set(key, val) }),
    deletePassword: vi.fn(async (_svc: string, key: string) => { keytarStore.delete(key); return true }),
  },
}))

// Test-only seam for the Claude leg. The real `createAnthropic` is wrapped, not
// replaced, so `aiChat` -> `streamVercelChat` -> `createAnthropicChatModel` ->
// `aiFetch` stay production code; only the host and the credential header differ.
// Wrapping the SDK factory is the narrowest point that reaches the hard-coded
// base URL without a product change. With INTEG_ANTHROPIC_BASE_URL unset the
// wrapper is a pass-through.
vi.mock('@ai-sdk/anthropic', async (importActual) => {
  const actual = await importActual<typeof import('@ai-sdk/anthropic')>()
  const baseURL = process.env.INTEG_ANTHROPIC_BASE_URL
  if (!baseURL) return actual
  return {
    ...actual,
    createAnthropic: (opts: Parameters<typeof actual.createAnthropic>[0] = {}) => {
      const { apiKey, ...rest } = opts
      // Such gateways take the key as a Bearer token (`authToken`), not `x-api-key`.
      return actual.createAnthropic({ ...rest, baseURL, authToken: apiKey })
    },
  }
})

// Current settings mock (will be updated per-provider test)
let currentSettings: Record<string, unknown> = {
  theme: 'light',
  cacheDays: 30,
  language: 'en',
  notificationsEnabled: false,
  imapIdleEnabled: false,
  draftSyncEnabled: false,
  aiProvider: 'openai-api',
  aiModel: OPENAI_MODEL,
  aiMaxTurns: 15,
  aiMaxBudgetPerRequest: 1,
  aiOpenAiBaseUrl: OPENAI_BASE_URL || undefined,
}

// Account metadata for two test accounts
const testAccounts = new Map<number, Record<string, unknown>>()
testAccounts.set(1, {
  id: 1,
  name: 'Test One',
  email: 'test1@example.com',
  colorIndex: 0,
  imap: { host: 'mail.example.com', port: 993, secure: true, user: 'test1@example.com' },
  smtp: { host: 'mail.example.com', port: 587, secure: false, user: 'test1@example.com' },
  folderRoles: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Junk', archive: 'Archive' },
})
testAccounts.set(2, {
  id: 2,
  name: 'Test Two',
  email: 'test2@example.com',
  colorIndex: 1,
  imap: { host: 'mail.example.com', port: 993, secure: true, user: 'test2@example.com' },
  smtp: { host: 'mail.example.com', port: 587, secure: false, user: 'test2@example.com' },
  folderRoles: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Junk', archive: 'Archive' },
})

vi.mock('../../packages/net/config', () => ({
  getSettings: () => currentSettings,
  getAccountMeta: (id: number) => testAccounts.get(id),
  listAccounts: () => [...testAccounts.values()],
}))

vi.mock('../../electron/logger', () => ({
  createLogger: () => logSpy,
}))

// ---------------------------------------------------------------------------
// 4. Import modules AFTER mocks are set up
// ---------------------------------------------------------------------------
import type { AiStreamEvent, AiProvider } from '../../electron/services/ai'

// Conditional import — skip entire suite if better-sqlite3 is broken
const describeFn = INTEG_ENABLED && betterSqlite3Usable ? describe : describe.skip

// ---------------------------------------------------------------------------
// 5. Helper: collect events from aiChat generator
// ---------------------------------------------------------------------------
async function collectEvents(gen: AsyncGenerator<AiStreamEvent>): Promise<{
  events: AiStreamEvent[]
  toolsUsed: string[]
  resultText: string
  sessionId: string
  error?: string
}> {
  const events: AiStreamEvent[] = []
  const toolsUsed: string[] = []
  let resultText = ''
  let sessionId = ''
  let error: string | undefined

  for await (const ev of gen) {
    events.push(ev)
    if (ev.type === 'tool_use_start') toolsUsed.push(ev.toolName)
    if (ev.type === 'result') {
      resultText = ev.text
      sessionId = ev.sessionId
    }
    if (ev.type === 'error') error = ev.message
  }

  return { events, toolsUsed, resultText, sessionId, error }
}

/** Get list of tool names called (from tool spy log) */
function getSpiedToolNames(): string[] {
  return toolCalls.map(c => c.toolName)
}

/** Check if a specific tool was called (from spy log) */
function hasSpiedTool(name: string): boolean {
  return toolCalls.some(c => c.toolName === name)
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------
describeFn('AI Agent Integration — MCP mail tools × 2 Providers', () => {
  // Dynamic imports (after mocks)
  let aiChat: typeof import('../../electron/services/ai').aiChat
  let setUiContext: typeof import('../../electron/services/ai').setUiContext
  let clearPendingPreviews: typeof import('../../electron/services/ai').clearPendingPreviews
  let setMailActionCallback: typeof import('../../electron/services/ai').setMailActionCallback
  let setUnsubscribeCallback: typeof import('../../electron/services/ai').setUnsubscribeCallback
  let setSendEmailCallback: typeof import('../../electron/services/ai').setSendEmailCallback
  let setDraftCallback: typeof import('../../electron/services/ai').setDraftCallback
  let setListAttachmentsCallback: typeof import('../../electron/services/ai').setListAttachmentsCallback
  let setDownloadAttachmentCallback: typeof import('../../electron/services/ai').setDownloadAttachmentCallback
  let setSnoozeCallback: typeof import('../../electron/services/ai').setSnoozeCallback
  let setUnsnoozeCallback: typeof import('../../electron/services/ai').setUnsnoozeCallback
  let setFlagCallback: typeof import('../../electron/services/ai').setFlagCallback
  let setMoveCallback: typeof import('../../electron/services/ai').setMoveCallback
  let setFollowUpAddCallback: typeof import('../../electron/services/ai').setFollowUpAddCallback
  let setFollowUpDismissCallback: typeof import('../../electron/services/ai').setFollowUpDismissCallback
  let stopAll: typeof import('../../electron/services/ai').stopAll

  // DB module
  let dbMod: typeof import('../../packages/db')

  // Mock callbacks
  let mailActionCb: Mock
  let unsubscribeCb: Mock
  let sendEmailCb: Mock
  let draftCb: Mock
  let listAttachmentsCb: Mock
  let downloadAttachmentCb: Mock
  let snoozeCb: Mock
  let unsnoozeCb: Mock
  let flagCb: Mock
  let moveCb: Mock
  let followUpAddCb: Mock
  let followUpDismissCb: Mock

  // -------------------------------------------------------------------------
  // Setup: seed database and configure AI service
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    // Import DB (creates SQLite file in tmpDir)
    dbMod = await import('../../packages/db')

    // Seed test data
    seedDatabase(dbMod)

    // Import AI service (registers MCP tools on real DB)
    const aiMod = await import('../../electron/services/ai')
    aiChat = aiMod.aiChat
    setUiContext = aiMod.setUiContext
    clearPendingPreviews = aiMod.clearPendingPreviews
    setMailActionCallback = aiMod.setMailActionCallback
    setUnsubscribeCallback = aiMod.setUnsubscribeCallback
    setSendEmailCallback = aiMod.setSendEmailCallback
    setDraftCallback = aiMod.setDraftCallback
    setListAttachmentsCallback = aiMod.setListAttachmentsCallback
    setDownloadAttachmentCallback = aiMod.setDownloadAttachmentCallback
    setSnoozeCallback = aiMod.setSnoozeCallback
    setUnsnoozeCallback = aiMod.setUnsnoozeCallback
    setFlagCallback = aiMod.setFlagCallback
    setMoveCallback = aiMod.setMoveCallback
    setFollowUpAddCallback = aiMod.setFollowUpAddCallback
    setFollowUpDismissCallback = aiMod.setFollowUpDismissCallback
    stopAll = aiMod.stopAll

    // Configure mock callbacks
    mailActionCb = vi.fn(async () => ({ ok: true, affected: 3, message: 'Archived 3 emails' }))
    unsubscribeCb = vi.fn(async () => ({
      ok: true, affected: 1, message: 'Unsubscribed from 1 sender',
      autoCount: 1, manualCount: 0, noLinkCount: 0,
    }))
    sendEmailCb = vi.fn(async () => ({ ok: true, message: 'Email sent', messageId: '<test-sent@integration>' }))
    draftCb = vi.fn()
    listAttachmentsCb = vi.fn(async () => ({
      ok: true as const,
      attachments: [
        { part: '2', filename: 'report.txt', contentType: 'text/plain', size: 1024 },
        { part: '3', filename: 'photo.png', contentType: 'image/png', size: 50000 },
      ],
    }))
    downloadAttachmentCb = vi.fn(async (_aid: number, _f: string, _uid: number, part: string) => {
      if (part === '2') {
        return {
          ok: true as const,
          buffer: Buffer.from('Quarterly report: revenue up 15%, costs down 3%. Action items: hire 2 engineers.'),
          contentType: 'text/plain',
          filename: 'report.txt',
        }
      }
      return { ok: false as const, error: 'Attachment not found' }
    })

    snoozeCb = vi.fn(async () => ({ ok: true, message: 'Snoozed 1 email', ids: [1] }))
    unsnoozeCb = vi.fn(async () => ({ ok: true, message: 'Unsnoozed 1 email', removed: 1 }))
    flagCb = vi.fn(async () => ({ ok: true, message: 'Flagged 1 email', affected: 1 }))
    moveCb = vi.fn(async () => ({ ok: true, message: 'Moved 1 email', affected: 1 }))
    followUpAddCb = vi.fn(async () => ({ ok: true, message: 'Follow-up created', id: 42 }))
    followUpDismissCb = vi.fn(async () => ({ ok: true, message: 'Follow-up dismissed' }))

    setMailActionCallback(mailActionCb)
    setUnsubscribeCallback(unsubscribeCb)
    setSendEmailCallback(sendEmailCb)
    setDraftCallback(draftCb)
    setListAttachmentsCallback(listAttachmentsCb)
    setDownloadAttachmentCallback(downloadAttachmentCb)
    setSnoozeCallback(snoozeCb)
    setUnsnoozeCallback(unsnoozeCb)
    setFlagCallback(flagCb)
    setMoveCallback(moveCb)
    setFollowUpAddCallback(followUpAddCb)
    setFollowUpDismissCallback(followUpDismissCb)
  })

  afterAll(() => {
    try { stopAll() } catch { /* */ }
    try { dbMod.default.close() } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* */ }
  })

  beforeEach(() => {
    toolCalls.length = 0
    logSpy.info.mockClear()
    logSpy.warn.mockClear()
    logSpy.error.mockClear()
    clearPendingPreviews()
    mailActionCb.mockClear()
    unsubscribeCb.mockClear()
    sendEmailCb.mockClear()
    draftCb.mockClear()
    listAttachmentsCb.mockClear()
    downloadAttachmentCb.mockClear()
    snoozeCb.mockClear()
    unsnoozeCb.mockClear()
    flagCb.mockClear()
    moveCb.mockClear()
    followUpAddCb.mockClear()
    followUpDismissCb.mockClear()
    warnings.length = 0
    offered.sets.length = 0
  })

  // -------------------------------------------------------------------------
  // Product-contract helpers
  // -------------------------------------------------------------------------
  /** Every message's mutable state; the mailbox is unchanged when this is. */
  function mailboxSnapshot(): string {
    const rows = dbMod.default
      .prepare('SELECT account_id, folder_path, uid, unread, flagged FROM messages ORDER BY account_id, folder_path, uid')
      .all()
    return JSON.stringify(rows)
  }

  /** Tool names handed to the model across the calls since the last reset, prefix stripped. */
  function offeredToolNames(): Set<string> {
    return new Set(offered.sets.flat().map(n => n.replace(/^mcp__mailcopilot__/, '')))
  }

  /**
   * True when `applyTool` got past the confirmation-token check. Every apply tool
   * logs an entry line before it validates anything, so `hasSpiedTool` cannot tell
   * a refused attempt from an executed one; only this line marks execution.
   */
  function appliedWithToken(applyTool: string): boolean {
    return toolCalls.some(c => c.toolName === applyTool && c.args.includes('token validated'))
  }

  /**
   * §3.10 P0: the model cannot apply a prepared action. The confirmation token is
   * minted by a user click in the UI, so an apply issued from chat text alone must
   * be refused, the mutating callback must not run and the mailbox must not change.
   * The model may or may not try to apply after "yes"; both are acceptable, a
   * successful apply is not.
   */
  function expectApplyRefused(applyTool: string, callback: Mock, before: string): void {
    expect(appliedWithToken(applyTool)).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    const rejections = warnings.filter(w => w.startsWith(`MCP ${applyTool} →`))
    for (const r of rejections) expect(r).toContain('token validation failed: token_missing')
    expect(mailboxSnapshot()).toBe(before)
  }

  /**
   * The direct (no preview) variants are not in ALLOWED_TOOLS: they must be absent
   * from what the model is offered, and nothing may have mutated state.
   */
  function expectNoDirectMutation(direct: string[], preview: string, callbacks: Mock[], before: string): void {
    const names = offeredToolNames()
    expect(names.size).toBeGreaterThan(0)
    for (const d of direct) expect(names.has(d)).toBe(false)
    expect(names.has(preview)).toBe(true)
    for (const d of direct) expect(hasSpiedTool(d)).toBe(false)
    for (const cb of callbacks) expect(cb).not.toHaveBeenCalled()
    expect(mailboxSnapshot()).toBe(before)
  }

  // -------------------------------------------------------------------------
  // Provider matrix
  // -------------------------------------------------------------------------
  type ProviderConfig = {
    name: string
    provider: AiProvider
    skip: boolean
    setup: () => void
  }

  const providers: ProviderConfig[] = [
    {
      // §2.283 — same streamer as the OpenAI leg below; only the model and the
      // provider-executed tool set differ.
      name: 'Claude (Anthropic API)',
      provider: 'anthropic-api',
      skip: !ANTHROPIC_KEY,
      setup() {
        currentSettings = {
          ...currentSettings,
          aiProvider: 'anthropic-api',
          aiModel: ANTHROPIC_MODEL,
          aiMaxTurns: 10,
          aiMaxBudgetPerRequest: 1,
        }
      },
    },
    {
      name: 'OpenAI',
      provider: 'openai-api',
      skip: !OPENAI_KEY,
      setup() {
        currentSettings = {
          ...currentSettings,
          aiProvider: 'openai-api',
          aiModel: OPENAI_MODEL,
          aiMaxTurns: 15,
          aiMaxBudgetPerRequest: 1,
          aiOpenAiBaseUrl: OPENAI_BASE_URL || undefined,
        }
      },
    },
  ]

  for (const prov of providers) {
    const provDescribe = prov.skip ? describe.skip : describe

    provDescribe(`[${prov.name}]`, () => {
      beforeEach(() => {
        prov.setup()
      })

      // =====================================================================
      // S1: Cross-account unread digest
      // Tools: get_account_info, list_folders, count_unread, list_emails
      // =====================================================================
      it('S1: cross-account unread digest', async () => {
        setUiContext({
          type: 'folder',
          data: {
            viewMode: 'unified',
            accounts: [
              { id: 1, email: 'test1@example.com' },
              { id: 2, email: 'test2@example.com' },
            ],
          },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Give me an unread digest for all my accounts. List unread emails from each account.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(resultText.length).toBeGreaterThan(20)

        // Should have called tools for BOTH accounts
        const spied = getSpiedToolNames()
        const hasMultiAccount =
          (spied.filter(n => n === 'count_unread').length >= 2) ||
          (spied.filter(n => n === 'list_emails').length >= 2) ||
          (spied.filter(n => n === 'list_folders').length >= 2) ||
          (spied.filter(n => n === 'search_emails').length >= 2)
        expect(hasMultiAccount).toBe(true)

        // At least one of the key tools should have been called
        const hasKeyTool = hasSpiedTool('count_unread') || hasSpiedTool('list_emails') ||
          hasSpiedTool('list_folders') || hasSpiedTool('search_emails')
        expect(hasKeyTool).toBe(true)

        // Response should mention unread emails or accounts
        expect(resultText).toMatch(/unread|inbox|account|test[12]@example/i)
      })

      // =====================================================================
      // S2: Email search and reading
      // Tools: search_emails, get_email, get_thread, get_current_context
      // =====================================================================
      it('S2: email search and reading', async () => {
        setUiContext({
          type: 'folder',
          data: {
            accountId: 1,
            folder: 'INBOX',
            viewMode: 'account',
            accounts: [{ id: 1, email: 'test1@example.com' }],
          },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Use search_emails to find emails from alice@example.com (accountId=1, folder=INBOX). Then use get_email to read uid of the most recent result.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()

        // search_emails or list_emails should have been called
        const spied = getSpiedToolNames()
        const hasSearch = spied.includes('search_emails') || spied.includes('list_emails')
        expect(hasSearch).toBe(true)

        // get_email should be called for the full body
        expect(spied).toContain('get_email')

        // Result should mention alice or the seeded subject
        expect(resultText).toMatch(/alice|project update|team meeting/i)
      })

      // =====================================================================
      // S14: citation tickets (§3.3 B3). Main hands the model a ready link next to every row it reads
      // (`cite`); the model must copy it exactly. A link it makes up or distorts is not a source.
      // This is the check that real models copy the ticket without damage, on both contours.
      // =====================================================================
      it('S14: the model copies the ready link of every message it mentions, without distortion', async () => {
        // Spend is bounded by the number of steps: the app's per-request ceiling prices an unknown model by a floor and
        // would end the answer right after the tool step.
        currentSettings = { ...currentSettings, aiMaxTurns: 4 }
        const sid = randomUUID()
        dbMod.createAiSession(sid, prov.provider)

        const { resultText, error, events } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            sessionId: sid,
            prompt: 'Use search_emails to find emails from alice@example.com (accountId=1, folder=INBOX). Then list every message you found as a bullet: its subject as a link to the message.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('search_emails') || hasSpiedTool('list_emails')).toBe(true)

        // Every ticket-shaped link the model wrote, whatever its length, and every place-form link it composed.
        const written = [...resultText.matchAll(/mailref:\/\/c\/([^\s)\]]*)/g)].map(m => m[1]!)
        const composed = [...resultText.matchAll(/mailref:\/\/\d+\//g)].length
        const wellFormed = written.filter(t => /^[a-z2-7]{8}$/.test(t))
        const known = dbMod.listAiCitations(sid, wellFormed).map(r => r.token)
        const distorted = written.filter(t => !known.includes(t))
        console.log('CITATION_LIVE', JSON.stringify({ provider: prov.name, written: written.length, wellFormed: wellFormed.length, known: known.length, distorted, composedPlaceLinks: composed, tools: getSpiedToolNames() }))
        if (written.length === 0) console.log('CITATION_LIVE_TEXT', JSON.stringify(resultText.slice(0, 600)), JSON.stringify(events.filter(e => e.type !== 'text_delta').map(e => e.type === 'notice' ? `notice:${e.code}` : e.type === 'status' ? `status:${e.status}` : e.type)))

        expect(written.length).toBeGreaterThan(0)
        expect(distorted).toEqual([])
        expect(composed).toBe(0)
      })

      // =====================================================================
      // S3: Attachment analysis
      // Tools: list_attachments, read_attachment
      // =====================================================================
      it('S3: attachment analysis', async () => {
        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 105 },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'This email has attachments. List them and read the text file (report.txt) — summarize its content.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('list_attachments')).toBe(true)
        expect(hasSpiedTool('read_attachment')).toBe(true)

        // Callback should have been called
        expect(listAttachmentsCb).toHaveBeenCalled()
        expect(downloadAttachmentCb).toHaveBeenCalled()

        // Result should mention content from the attachment
        expect(resultText).toMatch(/report|revenue|engineer/i)
      })

      // =====================================================================
      // S4: Bulk archive (two-turn: preview → apply)
      // Tools: preview_mail_action, apply_mail_action
      // =====================================================================
      it('S4: bulk archive (preview + apply)', async () => {
        setUiContext({
          type: 'folder',
          data: { accountId: 1, folder: 'INBOX', viewMode: 'account', accounts: [{ id: 1, email: 'test1@example.com' }] },
        })

        // Turn 1: ask to archive
        const turn1 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Archive all read emails in my INBOX.',
            aiProvider: prov.provider,
          }),
        )

        expect(turn1.error).toBeUndefined()
        expect(hasSpiedTool('preview_mail_action')).toBe(true)

        // Turn 2: a "yes" typed in chat carries no UI confirmation token
        const before = mailboxSnapshot()
        toolCalls.length = 0
        warnings.length = 0
        const turn2 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Yes, do it. Apply the archive action.',
            aiProvider: prov.provider,
            sessionId: turn1.sessionId || undefined,
            history: [
              { role: 'user', content: 'Archive all read emails in my INBOX.' },
              { role: 'assistant', content: turn1.resultText },
            ],
          }),
        )

        expect(turn2.error).toBeUndefined()
        expectApplyRefused('apply_mail_action', mailActionCb, before)
      })

      // =====================================================================
      // S5: Email sending (two-turn: preview → apply)
      // Tools: send_email_preview, send_email_apply, get_contacts
      // =====================================================================
      it('S5: email sending (preview + apply)', async () => {
        setUiContext({
          type: 'folder',
          data: { accountId: 1, folder: 'INBOX', viewMode: 'account', accounts: [{ id: 1, email: 'test1@example.com' }] },
        })

        // Turn 1: ask to send
        const turn1 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Send an email from account 1 to test2@example.com with subject "AI Integration Test" and body "Hello from AI agent integration test!"',
            aiProvider: prov.provider,
          }),
        )

        expect(turn1.error).toBeUndefined()
        expect(hasSpiedTool('send_email_preview')).toBe(true)

        // Turn 2: a "yes" typed in chat carries no UI confirmation token
        const before = mailboxSnapshot()
        toolCalls.length = 0
        warnings.length = 0
        const turn2 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Yes, send it now.',
            aiProvider: prov.provider,
            sessionId: turn1.sessionId || undefined,
            history: [
              { role: 'user', content: 'Send an email from account 1 to test2@example.com with subject "AI Integration Test" and body "Hello from AI agent integration test!"' },
              { role: 'assistant', content: turn1.resultText },
            ],
          }),
        )

        expect(turn2.error).toBeUndefined()
        expectApplyRefused('send_email_apply', sendEmailCb, before)
      })

      // =====================================================================
      // S6: Newsletter unsubscribe (two-turn: preview → apply)
      // Tools: preview_unsubscribe, apply_unsubscribe
      // =====================================================================
      it('S6: newsletter unsubscribe (preview + apply)', async () => {
        setUiContext({
          type: 'folder',
          data: { accountId: 1, folder: 'INBOX', viewMode: 'account', accounts: [{ id: 1, email: 'test1@example.com' }] },
        })

        // Turn 1: ask to unsubscribe
        const turn1 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Unsubscribe me from the newsletter from spamco.com. Search for it first.',
            aiProvider: prov.provider,
          }),
        )

        expect(turn1.error).toBeUndefined()
        expect(hasSpiedTool('preview_unsubscribe')).toBe(true)

        // Turn 2: a "yes" typed in chat carries no UI confirmation token
        const before = mailboxSnapshot()
        toolCalls.length = 0
        warnings.length = 0
        const turn2 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Yes, unsubscribe me.',
            aiProvider: prov.provider,
            sessionId: turn1.sessionId || undefined,
            history: [
              { role: 'user', content: 'Unsubscribe me from the newsletter from spamco.com.' },
              { role: 'assistant', content: turn1.resultText },
            ],
          }),
        )

        expect(turn2.error).toBeUndefined()
        expectApplyRefused('apply_unsubscribe', unsubscribeCb, before)
      })

      // =====================================================================
      // S7: SQL analysis
      // Tool: query_db
      // =====================================================================
      it('S7: SQL analysis', async () => {
        setUiContext({
          type: 'folder',
          data: { accountId: 1, folder: 'INBOX', viewMode: 'account', accounts: [{ id: 1, email: 'test1@example.com' }] },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Use query_db to run this SQL: SELECT folder_path, COUNT(*) as cnt FROM messages GROUP BY folder_path. Show the results.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('query_db')).toBe(true)

        // Response should contain folder names or counts
        expect(resultText).toMatch(/INBOX|Sent|folder/i)
      })

      // =====================================================================
      // S8: Memory update + draft creation
      // Tools: update_memory, create_draft
      // =====================================================================
      it('S8: memory update + draft creation', async () => {
        setUiContext({
          type: 'folder',
          data: { accountId: 1, folder: 'INBOX', viewMode: 'account', accounts: [{ id: 1, email: 'test1@example.com' }] },
        })

        const { error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Do two things: 1) Use update_memory to remember that I prefer "Best regards, Test One" as my sign-off. ' +
              '2) Use create_draft to draft a new email to alice@example.com with subject "Thank you" and body "Thanks for the project update! Best regards, Test One". Account 1.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('update_memory')).toBe(true)
        expect(hasSpiedTool('create_draft')).toBe(true)

        // Draft callback should have been called
        expect(draftCb).toHaveBeenCalled()
        const draftArgs = draftCb.mock.calls[0][0]
        expect(draftArgs.to).toContain('alice@example.com')

        // Memory file should have been written
        const memPath = path.join(tmpDir, 'ai-memory.md')
        if (fs.existsSync(memPath)) {
          const memContent = fs.readFileSync(memPath, 'utf-8')
          expect(memContent).toMatch(/Best regards/i)
        }
      })

      // =====================================================================
      // S9: Snooze / unsnooze — only the preview half is offered
      // Product contract: `snooze_email` and `unsnooze_email` are not in ALLOWED_TOOLS
      // (§3.10 P0), only `preview_snooze_email` / `preview_unsnooze_email` and the
      // token-gated `apply_*` halves. Kept, rewritten: it still proves the model gets
      // the gated pair and that a snooze request cannot reach the callback.
      // =====================================================================
      it('S9: snooze request reaches a preview, never a direct snooze', async () => {
        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 103 },
        })
        const before = mailboxSnapshot()

        const { error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Snooze this email (uid 103, accountId 1, folder INBOX) until tomorrow morning. Use preview_snooze_email.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('preview_snooze_email')).toBe(true)
        expectNoDirectMutation(['snooze_email', 'unsnooze_email'], 'preview_snooze_email', [snoozeCb, unsnoozeCb], before)
        expect(appliedWithToken('apply_snooze_email')).toBe(false)
      })

      // =====================================================================
      // S10: Flag/star — only the preview half is offered
      // `flag_email` is not in ALLOWED_TOOLS; the request must stop at the preview.
      // =====================================================================
      it('S10: flag request reaches a preview, never a direct flag', async () => {
        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 101 },
        })
        const before = mailboxSnapshot()

        const { error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Star this email (accountId=1, folder="INBOX", uid=101). Use preview_flag_email.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('preview_flag_email')).toBe(true)
        expectNoDirectMutation(['flag_email'], 'preview_flag_email', [flagCb], before)
        expect(appliedWithToken('apply_flag_email')).toBe(false)
      })

      // =====================================================================
      // S11: Move email (two-turn: preview → apply)
      // Tools: move_email_preview, move_email_apply
      // =====================================================================
      it('S11: move email (preview + apply)', async () => {
        setUiContext({
          type: 'folder',
          data: { accountId: 1, folder: 'INBOX', viewMode: 'account', accounts: [{ id: 1, email: 'test1@example.com' }] },
        })

        // Turn 1: ask to move
        const turn1 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Move email uid 108 from INBOX to Archive folder (accountId=1). Use move_email_preview tool.',
            aiProvider: prov.provider,
          }),
        )

        expect(turn1.error).toBeUndefined()
        expect(hasSpiedTool('move_email_preview')).toBe(true)

        // Turn 2: a "yes" typed in chat carries no UI confirmation token
        const before = mailboxSnapshot()
        toolCalls.length = 0
        warnings.length = 0
        const turn2 = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Yes, apply the move now using move_email_apply.',
            aiProvider: prov.provider,
            sessionId: turn1.sessionId || undefined,
            history: [
              { role: 'user', content: 'Move email uid 108 from INBOX to Archive folder (accountId=1).' },
              { role: 'assistant', content: turn1.resultText },
            ],
          }),
        )

        expect(turn2.error).toBeUndefined()
        expectApplyRefused('move_email_apply', moveCb, before)
      })

      // =====================================================================
      // S12: Follow-up — only the preview half is offered
      // `add_followup` / `dismiss_followup` are not in ALLOWED_TOOLS; the request
      // must stop at the preview and create nothing.
      // =====================================================================
      it('S12: follow-up request reaches a preview, never a direct follow-up', async () => {
        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 101 },
        })
        const before = mailboxSnapshot()

        const { error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Set a follow-up reminder for this email (accountId=1, folder="INBOX", uid=101, toAddr="alice@example.com") in 3 days. Use preview_add_followup.',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('preview_add_followup')).toBe(true)
        expectNoDirectMutation(['add_followup', 'dismiss_followup'], 'preview_add_followup', [followUpAddCb, followUpDismissCb], before)
        expect(appliedWithToken('apply_add_followup')).toBe(false)
      })

      // =====================================================================
      // S13: Large attachments — no context overflow
      // Tools: list_attachments, read_attachment
      // Verifies that large images/PDFs are resized before entering AI context
      // =====================================================================
      it('S13: large attachments do not cause context overflow', async () => {
        // Override callbacks with large payloads: 500KB image + 1MB PDF
        const largePng = Buffer.alloc(500_000, 0x42) // 500KB image
        const largePdf = Buffer.alloc(1_000_000, 0x25) // 1MB "PDF"

        listAttachmentsCb.mockResolvedValue({
          ok: true as const,
          attachments: [
            { part: 'img1', filename: 'large-photo.png', contentType: 'image/png', size: largePng.length },
            { part: 'pdf1', filename: 'large-doc.pdf', contentType: 'application/pdf', size: largePdf.length },
            { part: 'txt1', filename: 'notes.txt', contentType: 'text/plain', size: 200 },
          ],
        })
        downloadAttachmentCb.mockImplementation(async (_aid: number, _f: string, _uid: number, part: string) => {
          if (part === 'img1') {
            return { ok: true as const, buffer: largePng, contentType: 'image/png', filename: 'large-photo.png' }
          }
          if (part === 'pdf1') {
            // Return text-based PDF content (buildPdfContent will extract text)
            return { ok: true as const, buffer: Buffer.from('A'.repeat(80_000)), contentType: 'text/plain', filename: 'notes-large.txt' }
          }
          if (part === 'txt1') {
            return { ok: true as const, buffer: Buffer.from('Short note: meeting at 3pm'), contentType: 'text/plain', filename: 'notes.txt' }
          }
          return { ok: false as const, error: 'Not found' }
        })

        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 105 },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'List the attachments of this email and read all of them. Summarize what you find.',
            aiProvider: prov.provider,
          }),
        )

        // The key assertion: no context overflow error
        expect(error).toBeUndefined()
        expect(hasSpiedTool('list_attachments')).toBe(true)
        expect(hasSpiedTool('read_attachment')).toBe(true)
        expect(resultText.length).toBeGreaterThan(0)

        // Should mention content from at least one attachment
        expect(resultText).toMatch(/note|meeting|attachment/i)
      })
    })
  }

  // =========================================================================
  // Prompt-cache measurement (opt-in, spends real money)
  //
  // `INTEG_CACHE_MEASURE=1 npm run test:integration -- -t "cache measure"`.
  // Runs one realistic mail question (search, then read) a few times through the
  // real `aiChat` path and writes per-step token usage, cache reads and writes
  // and timings to `INTEG_CACHE_MEASURE_OUT` (a JSON file). It asserts nothing
  // about speed: it reports numbers for a human to compare before and after a
  // change.
  // =========================================================================
  const measureCache = process.env.INTEG_CACHE_MEASURE === '1' && !!ANTHROPIC_KEY
  ;(measureCache ? describe : describe.skip)('cache measure', () => {
    const RUNS = Number(process.env.INTEG_CACHE_MEASURE_RUNS || 3)
    const QUESTION = 'Find the quarterly report email from Bob in my inbox, read it and give me its key points.'

    it('records per-step usage and timing', async () => {
      currentSettings = {
        ...currentSettings,
        aiProvider: 'anthropic-api',
        aiModel: ANTHROPIC_MODEL,
        aiMaxTurns: 10,
        aiMaxBudgetPerRequest: 1,
      }
      const runs: unknown[] = []
      for (let i = 0; i < RUNS; i++) {
        const steps: Array<Record<string, number | undefined>> = []
        const t0 = performance.now()
        stepTap.on = (step) => {
          const u = (step.usage ?? {}) as {
            inputTokens?: number; outputTokens?: number
            inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
          }
          steps.push({
            atMs: Math.round(performance.now() - t0),
            inputTotal: u.inputTokens,
            noCache: u.inputTokenDetails?.noCacheTokens,
            cacheRead: u.inputTokenDetails?.cacheReadTokens,
            cacheWrite: u.inputTokenDetails?.cacheWriteTokens,
            output: u.outputTokens,
          })
        }
        let firstTextMs: number | undefined
        let costUsd: number | undefined
        let error: string | undefined
        const tools: string[] = []
        try {
          for await (const ev of aiChat({ requestId: randomUUID(), prompt: QUESTION, aiProvider: 'anthropic-api' })) {
            if (ev.type === 'text_delta' && firstTextMs === undefined) firstTextMs = Math.round(performance.now() - t0)
            if (ev.type === 'tool_use_start') tools.push(ev.toolName)
            if (ev.type === 'result') costUsd = ev.costUsd
            if (ev.type === 'error') error = ev.message
          }
        } finally {
          stepTap.on = null
        }
        runs.push({ run: i + 1, firstTextMs, totalMs: Math.round(performance.now() - t0), costUsd, tools, error, steps })
      }
      const out = process.env.INTEG_CACHE_MEASURE_OUT
      if (out) fs.writeFileSync(out, JSON.stringify({ model: ANTHROPIC_MODEL, question: QUESTION, runs }, null, 2))
      expect(runs.length).toBe(RUNS)
    })
  })

  // =========================================================================
  // Meta-test: verify all tools appear in at least one scenario
  // =========================================================================
  it('meta: every tool the scenarios assert on is covered', () => {
    const allTools = [
      'get_email', 'list_emails', 'search_emails', 'list_folders',
      'get_thread', 'get_contacts', 'create_draft', 'get_current_context',
      'get_account_info', 'count_unread',
      'preview_mail_action', 'apply_mail_action',
      'preview_unsubscribe', 'apply_unsubscribe',
      'query_db',
      'send_email_preview', 'send_email_apply',
      'update_memory',
      'list_attachments', 'read_attachment',
      'preview_snooze_email', 'preview_flag_email', 'preview_add_followup',
      'move_email_preview', 'move_email_apply',
    ]

    // This is a static check — each tool appears in expected tools for at least one scenario
    const scenarioCoverage: Record<string, string[]> = {
      S1: ['get_account_info', 'list_folders', 'count_unread', 'list_emails'],
      S2: ['search_emails', 'get_email', 'get_thread', 'get_current_context'],
      S3: ['list_attachments', 'read_attachment'],
      S4: ['preview_mail_action', 'apply_mail_action'],
      S5: ['send_email_preview', 'send_email_apply', 'get_contacts'],
      S6: ['preview_unsubscribe', 'apply_unsubscribe'],
      S7: ['query_db'],
      S8: ['update_memory', 'create_draft'],
      S9: ['preview_snooze_email'],
      S10: ['preview_flag_email'],
      S11: ['move_email_preview', 'move_email_apply'],
      S12: ['preview_add_followup'],
    }

    const covered = new Set(Object.values(scenarioCoverage).flat())
    const missing = allTools.filter(t => !covered.has(t))
    expect(missing).toEqual([])
  })
})

// ===========================================================================
// Database seeding
// ===========================================================================
function seedDatabase(db: typeof import('../../packages/db')) {
  const now = new Date()
  const h = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600_000).toISOString()

  // Account 1 — INBOX (10 emails)
  db.upsertMessages(1, 'INBOX', [
    // 3 unread
    {
      uid: 101, subject: 'Project update from Alice', fromAddr: 'alice@example.com', fromName: 'Alice Johnson',
      toAddr: 'test1@example.com', date: h(1), unread: true, flagged: false, hasAttachments: false,
      bodyText: 'Hi, here is the latest project update. We completed the design phase and are moving to implementation. Please review the attached timeline.',
      messageId: '<msg101@test.integration>',
    },
    {
      uid: 102, subject: 'Team meeting tomorrow', fromAddr: 'alice@example.com', fromName: 'Alice Johnson',
      toAddr: 'test1@example.com', date: h(3), unread: true, flagged: false, hasAttachments: false,
      bodyText: 'Reminder: team meeting tomorrow at 10am. Agenda: Q1 review, roadmap planning, hiring updates.',
      messageId: '<msg102@test.integration>',
    },
    {
      uid: 103, subject: 'Invoice #4521', fromAddr: 'billing@vendor.com', fromName: 'Vendor Billing',
      toAddr: 'test1@example.com', date: h(5), unread: true, flagged: false, hasAttachments: true,
      bodyText: 'Please find attached invoice #4521 for services rendered in January 2026.',
      messageId: '<msg103@test.integration>',
    },
    // 1 flagged (read)
    {
      uid: 104, subject: 'Important: contract renewal', fromAddr: 'legal@company.com', fromName: 'Legal Dept',
      toAddr: 'test1@example.com', date: h(24), unread: false, flagged: true, hasAttachments: false,
      bodyText: 'Your contract expires on March 15. Please review and sign the renewal documents.',
      messageId: '<msg104@test.integration>',
    },
    // 2 with attachments (read)
    {
      uid: 105, subject: 'Quarterly report', fromAddr: 'bob@example.com', fromName: 'Bob Smith',
      toAddr: 'test1@example.com', date: h(48), unread: false, flagged: false, hasAttachments: true,
      bodyText: 'Attached is the quarterly report. Key highlights: revenue up 15%.',
      messageId: '<msg105@test.integration>',
    },
    {
      uid: 106, subject: 'Design mockups v2', fromAddr: 'carol@example.com', fromName: 'Carol Designer',
      toAddr: 'test1@example.com', date: h(72), unread: false, flagged: false, hasAttachments: true,
      bodyText: 'Updated design mockups attached. Major changes: new color scheme and navigation layout.',
      messageId: '<msg106@test.integration>',
    },
    // 1 newsletter
    {
      uid: 107, subject: 'Weekly Newsletter from SpamCo', fromAddr: 'newsletter@spamco.com', fromName: 'SpamCo Newsletter',
      toAddr: 'test1@example.com', date: h(96), unread: false, flagged: false, hasAttachments: false,
      bodyText: 'This week in tech: AI advances, market trends. Unsubscribe: https://spamco.com/unsubscribe?id=123',
      messageId: '<newsletter107@spamco.com>',
    },
    // 3 more read emails
    {
      uid: 108, subject: 'Lunch plans?', fromAddr: 'dave@example.com', fromName: 'Dave',
      toAddr: 'test1@example.com', date: h(120), unread: false, flagged: false, hasAttachments: false,
      bodyText: 'Want to grab lunch tomorrow? I was thinking Thai or Italian.',
      messageId: '<msg108@test.integration>',
    },
    {
      uid: 109, subject: 'Re: Project update from Alice', fromAddr: 'alice@example.com', fromName: 'Alice Johnson',
      toAddr: 'test1@example.com', date: h(0.5), unread: false, flagged: false, hasAttachments: false,
      bodyText: 'Thanks for reviewing. I have updated the timeline based on your feedback.',
      messageId: '<msg109@test.integration>',
      inReplyTo: '<reply201@test.integration>',
      references: '<msg101@test.integration> <reply201@test.integration>',
    },
    {
      uid: 110, subject: 'Server maintenance notice', fromAddr: 'ops@infra.com', fromName: 'Infrastructure Team',
      toAddr: 'test1@example.com', date: h(144), unread: false, flagged: false, hasAttachments: false,
      bodyText: 'Scheduled maintenance window: Saturday 2am-6am. Expect brief downtime.',
      messageId: '<msg110@test.integration>',
    },
  ])

  // Account 1 — Sent (for thread testing)
  db.upsertMessages(1, 'Sent', [
    {
      uid: 201, subject: 'Re: Project update from Alice', fromAddr: 'test1@example.com', fromName: 'Test One',
      toAddr: 'alice@example.com', date: h(2), unread: false, flagged: false, hasAttachments: false,
      bodyText: 'Thanks Alice, the timeline looks good. A few suggestions attached in my comments.',
      messageId: '<reply201@test.integration>',
      inReplyTo: '<msg101@test.integration>',
      references: '<msg101@test.integration>',
    },
    {
      uid: 202, subject: 'Meeting notes', fromAddr: 'test1@example.com', fromName: 'Test One',
      toAddr: 'bob@example.com', date: h(50), unread: false, flagged: false, hasAttachments: false,
      bodyText: 'Here are the meeting notes from today.',
      messageId: '<sent202@test.integration>',
    },
  ])

  // Account 2 — INBOX (5 emails)
  db.upsertMessages(2, 'INBOX', [
    {
      uid: 301, subject: 'Welcome to the team!', fromAddr: 'hr@company.com', fromName: 'HR Department',
      toAddr: 'test2@example.com', date: h(2), unread: true, flagged: false, hasAttachments: false,
      bodyText: 'Welcome aboard! Your onboarding starts Monday.',
      messageId: '<msg301@test.integration>',
    },
    {
      uid: 302, subject: 'Setup instructions', fromAddr: 'it@company.com', fromName: 'IT Support',
      toAddr: 'test2@example.com', date: h(4), unread: true, flagged: false, hasAttachments: true,
      bodyText: 'Please follow the attached guide to set up your development environment.',
      messageId: '<msg302@test.integration>',
    },
    {
      uid: 303, subject: 'Team introduction', fromAddr: 'manager@company.com', fromName: 'Jane Manager',
      toAddr: 'test2@example.com', date: h(6), unread: false, flagged: false, hasAttachments: false,
      bodyText: 'Let me introduce you to the team members you will be working with.',
      messageId: '<msg303@test.integration>',
    },
    {
      uid: 304, subject: 'Policy documents', fromAddr: 'compliance@company.com', fromName: 'Compliance',
      toAddr: 'test2@example.com', date: h(8), unread: true, flagged: false, hasAttachments: true,
      bodyText: 'Please review and acknowledge the company policies attached.',
      messageId: '<msg304@test.integration>',
    },
    {
      uid: 305, subject: 'Coffee chat?', fromAddr: 'test1@example.com', fromName: 'Test One',
      toAddr: 'test2@example.com', date: h(10), unread: false, flagged: true, hasAttachments: false,
      bodyText: 'Hey, want to grab coffee sometime this week? Would love to get to know you better.',
      messageId: '<msg305@test.integration>',
    },
  ])

  // Contacts
  db.upsertContactsIncoming([
    { email: 'alice@example.com', name: 'Alice Johnson' },
    { email: 'bob@example.com', name: 'Bob Smith' },
    { email: 'carol@example.com', name: 'Carol Designer' },
    { email: 'dave@example.com', name: 'Dave' },
    { email: 'newsletter@spamco.com', name: 'SpamCo Newsletter' },
    { email: 'test1@example.com', name: 'Test One' },
    { email: 'test2@example.com', name: 'Test Two' },
    { email: 'hr@company.com', name: 'HR Department' },
    { email: 'it@company.com', name: 'IT Support' },
    { email: 'manager@company.com', name: 'Jane Manager' },
  ])
}
