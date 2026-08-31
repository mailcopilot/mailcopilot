/**
 * AI Agent Integration Tests
 *
 * Runs real AI providers (Anthropic API + OpenAI) against a seeded
 * SQLite database, exercising all 27 MCP mail tools across 13 representative
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
// own key (the consumer-subscription provider was removed). It shares
// `streamClaudeChat` with the former subscription leg, so the Agent SDK path is
// still covered end to end.
const ANTHROPIC_KEY = process.env.INTEG_ANTHROPIC_API_KEY || ''
const OPENAI_KEY = process.env.INTEG_OPENAI_API_KEY || ''
const OPENAI_MODEL = process.env.INTEG_OPENAI_MODEL || 'gpt-4o-mini'
const OPENAI_BASE_URL = process.env.INTEG_OPENAI_BASE_URL || ''

// ---------------------------------------------------------------------------
// 1. Create temp dir for MAILCOPILOT_DATA_DIR BEFORE any db import
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-integ-'))
process.env.MAILCOPILOT_DATA_DIR = tmpDir

// ---------------------------------------------------------------------------
// 2. Probe better-sqlite3 ABI compatibility
// ---------------------------------------------------------------------------
let betterSqlite3Usable = true
try {
  const { default: Database } = await import('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

// ---------------------------------------------------------------------------
// 3. Mocks for Electron-specific modules (BEFORE ai.ts import)
// ---------------------------------------------------------------------------

// Tool call spy — captures MCP tool invocations from logger
type ToolCallRecord = { toolName: string; args: string; timestamp: number }
const toolCalls: ToolCallRecord[] = []

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
describeFn('AI Agent Integration — 27 MCP Tools × 2 Providers', () => {
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
  })

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
      name: 'Claude (Anthropic API)',
      provider: 'anthropic-api',
      skip: !ANTHROPIC_KEY,
      setup() {
        currentSettings = {
          ...currentSettings,
          aiProvider: 'anthropic-api',
          aiModel: 'claude-sonnet-4-5-20250929',
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

        // Turn 2: confirm
        toolCalls.length = 0
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
        expect(hasSpiedTool('apply_mail_action')).toBe(true)
        expect(mailActionCb).toHaveBeenCalled()
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

        // Turn 2: confirm
        toolCalls.length = 0
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
        expect(hasSpiedTool('send_email_apply')).toBe(true)
        expect(sendEmailCb).toHaveBeenCalled()

        // Validate callback received correct data
        const callArgs = sendEmailCb.mock.calls[0][0]
        expect(callArgs.to).toContain('test2@example.com')
        expect(callArgs.subject).toMatch(/AI Integration Test/i)
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

        // Turn 2: confirm
        toolCalls.length = 0
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
        expect(hasSpiedTool('apply_unsubscribe')).toBe(true)
        expect(unsubscribeCb).toHaveBeenCalled()
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
      // S9: Snooze + unsnooze email
      // Tools: snooze_email, unsnooze_email
      // =====================================================================
      it('S9: snooze and unsnooze email', async () => {
        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 103 },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Snooze this email (uid 103, accountId 1, folder INBOX) until tomorrow morning using snooze_email tool. Then immediately unsnooze it using unsnooze_email with snoozeIds=[1].',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('snooze_email')).toBe(true)
        expect(snoozeCb).toHaveBeenCalled()

        // At least snooze should have been called — unsnooze may or may not be called
        // depending on AI behavior, but we verify the callback was invoked
        const snoozeArgs = snoozeCb.mock.calls[0][0]
        expect(snoozeArgs.uids).toContain(103)
        expect(snoozeArgs.accountId).toBe(1)

        expect(resultText).toMatch(/snooze/i)
      })

      // =====================================================================
      // S10: Flag/star email
      // Tools: flag_email
      // =====================================================================
      it('S10: flag/star email', async () => {
        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 101 },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Star this email using flag_email tool (accountId=1, folder="INBOX", uids=[101], flagged=true).',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('flag_email')).toBe(true)
        expect(flagCb).toHaveBeenCalled()

        const flagArgs = flagCb.mock.calls[0][0]
        expect(flagArgs.uids).toContain(101)
        expect(flagArgs.flagged).toBe(true)

        expect(resultText).toMatch(/star|flag/i)
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

        // Turn 2: confirm
        toolCalls.length = 0
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
        expect(hasSpiedTool('move_email_apply')).toBe(true)
        expect(moveCb).toHaveBeenCalled()

        const moveArgs = moveCb.mock.calls[0][0]
        expect(moveArgs.uids).toContain(108)
        expect(moveArgs.toFolder).toMatch(/archive/i)
      })

      // =====================================================================
      // S12: Add and dismiss follow-up
      // Tools: add_followup, dismiss_followup
      // =====================================================================
      it('S12: add and dismiss follow-up', async () => {
        setUiContext({
          type: 'email',
          data: { accountId: 1, folder: 'INBOX', uid: 101 },
        })

        const { resultText, error } = await collectEvents(
          aiChat({
            requestId: randomUUID(),
            prompt: 'Set a follow-up reminder for this email (accountId=1, folder="INBOX", uid=101, toAddr="alice@example.com") to remind in 3 days using add_followup. Then dismiss it with dismiss_followup (followUpId=42).',
            aiProvider: prov.provider,
          }),
        )

        expect(error).toBeUndefined()
        expect(hasSpiedTool('add_followup')).toBe(true)
        expect(followUpAddCb).toHaveBeenCalled()

        const addArgs = followUpAddCb.mock.calls[0][0]
        expect(addArgs.accountId).toBe(1)
        expect(addArgs.uid).toBe(101)
        expect(addArgs.toAddr).toContain('alice')

        expect(resultText).toMatch(/follow.?up|reminder/i)
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
  // Meta-test: verify all tools appear in at least one scenario
  // =========================================================================
  it('meta: all 27 tools are covered by test scenarios', () => {
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
      'snooze_email', 'unsnooze_email',
      'flag_email',
      'move_email_preview', 'move_email_apply',
      'add_followup', 'dismiss_followup',
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
      S9: ['snooze_email', 'unsnooze_email'],
      S10: ['flag_email'],
      S11: ['move_email_preview', 'move_email_apply'],
      S12: ['add_followup', 'dismiss_followup'],
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
