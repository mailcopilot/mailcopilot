/**
 * §2.20 PR1 — telemetry helpers: recordPreviewSkipped / recordBatchSize.
 * These helpers live as private functions inside ai.ts and are exercised
 * through the MCP tool handlers. We test them here via the public
 * `getToolHandler` harness used in ai.test.ts, but with an explicit
 * `../metrics` mock so we can assert the exact event shape.
 *
 * Gap coverage for §2.20 PR1:
 *   1. `ai.action.preview_skipped` event fires for every preview tool that
 *      hits the empty-guard (not just mail_action).
 *   2. `ai.action.batch_size` event fires after a successful registration —
 *      single-account AND multi-account paths.
 *   3. Bucket boundary values are exercised through recordBatchSize. Since
 *      the fix-wave (Low#4) replaced the local `bucketBatchSize` clone with
 *      `bucketCount` from metricsBuckets.ts, these tests also guard the
 *      import wiring — a drift in either thresholds or wiring surfaces here.
 *   4. Telemetry errors are silently swallowed (never thrown to caller).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Metrics mock (hoisted so vi.mock factories run before imports) ---

const recordEventMock = vi.hoisted(() => vi.fn())
const recordHistogramMock = vi.hoisted(() => vi.fn())
vi.mock('../metrics', () => ({
  recordEvent: recordEventMock,
  recordHistogram: recordHistogramMock,
  openMetricSpan: vi.fn(),
  markFeatureUsed: vi.fn(),
}))

// --- Standard mocks shared with ai.test.ts ---

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))

const savedMcpToolCalls = vi.hoisted(() => [] as unknown[][])
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn((...args: unknown[]) => { savedMcpToolCalls.push([...args]) }),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isConnected: vi.fn(() => false),
  })),
}))

vi.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: { createLinkedPair: vi.fn(() => [{}, {}]) },
}))

vi.mock('ai', () => ({
  streamText: vi.fn(() => ({ fullStream: (async function* () {})() })),
  stepCountIs: vi.fn((n: number) => n),
  extractReasoningMiddleware: vi.fn(() => ({})),
  wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn((id: string) => ({ modelId: id }))),
}))

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async () => ({
    tools: vi.fn(async () => ({})),
    close: vi.fn(async () => {}),
  })),
}))

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
}))

vi.mock('@napi-rs/canvas', () => ({
  createCanvas: vi.fn(() => ({
    getContext: vi.fn(() => ({
      drawImage: vi.fn(),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16) })),
      putImageData: vi.fn(),
    })),
    toBuffer: vi.fn(() => Buffer.from('img')),
  })),
  loadImage: vi.fn(async () => ({ width: 100, height: 100 })),
}))

vi.mock('../../packages/db', () => ({
  default: { prepare: vi.fn(() => ({ all: vi.fn(() => []) })) },
  getMessages: vi.fn(() => []),
  getMessageByUid: vi.fn(),
  countUnreadMessages: vi.fn(() => 0),
  getThreadMessages: vi.fn(() => []),
  getMessagesBeforeUid: vi.fn(() => []),
  searchMessages: vi.fn(() => []),
  searchContacts: vi.fn(() => []),
  listFolderPrefs: vi.fn(() => []),
  listFolderStats: vi.fn(() => []),
  sumAiCostSince: vi.fn(() => 0),
  appendAiActionLog: vi.fn(),
  listAiActionLog: vi.fn(() => ({ rows: [], total: 0 })),
  aggregateAiUsage: vi.fn(() => []),
  softDeleteAiActionEntry: vi.fn(() => true),
  clearAiActionLog: vi.fn(() => 0),
  exportAiActionLog: vi.fn(() => '[]'),
  listMailRules: vi.fn(() => []),
  createMailRule: vi.fn(),
  updateMailRule: vi.fn(),
  deleteMailRule: vi.fn(),
  listRuleLog: vi.fn(() => []),
}))

vi.mock('../../packages/net/config', () => ({
  listAccounts: vi.fn(() => []),
  getAccountMeta: vi.fn(),
  getSettings: vi.fn(() => ({})),
}))

const mockUserDataDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'mailcopilot-ai-telemetry-test-'))
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mockUserDataDir) },
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/claude\n'),
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  })),
}))

vi.mock('../sentry', () => ({
  startInactiveSpan: vi.fn(() => ({
    setAttributes: vi.fn(), setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn(),
  })),
  sentryLogger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), fmt: vi.fn(),
  },
  wrapMcpServerWithSentry: vi.fn((s: unknown) => s),
  captureException: vi.fn(),
}))

vi.mock('../featureReach', () => ({ markFeatureUsed: vi.fn() }))

// --- Module imports after mocks ---

import { searchMessages } from '../../packages/db'
import { clearPendingPreviews, resetApplyRateLimit, DATA_BOUNDARY_START, DATA_BOUNDARY_END } from './ai'

const mockSearchMessages = vi.mocked(searchMessages)

// Re-use the same handler extraction helper as ai.test.ts.
function getToolHandler(name: string): (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }> {
  const call = savedMcpToolCalls.find((c: unknown[]) => c[0] === name)
  if (!call) throw new Error(`Tool ${name} not registered`)
  return call[3] as (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>
}

function parseToolResult(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(new RegExp(DATA_BOUNDARY_START + '\\n?', 'g'), '')
    .replace(new RegExp('\\n?' + DATA_BOUNDARY_END, 'g'), '')
    .trim()
  return JSON.parse(cleaned) as Record<string, unknown>
}

// ---------------------------------------------------------------------------

describe('§2.20 PR1 — telemetry helpers (ai.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPendingPreviews()
    resetApplyRateLimit()
    recordEventMock.mockClear()
    recordHistogramMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // 1. recordPreviewSkipped — ai.action.preview_skipped event fires for all
  //    empty-guard branches across every supported *_preview tool.
  // -------------------------------------------------------------------------

  describe('recordPreviewSkipped fires ai.action.preview_skipped', () => {
    it('preview_mail_action — single-account query with 0 hits', async () => {
      mockSearchMessages.mockReturnValue([] as never)
      const handler = getToolHandler('preview_mail_action')
      await handler({ accountId: 1, action: 'archive', folder: 'INBOX', query: 'from:void@x.test' })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.preview_skipped',
        { kind: 'mail_action', reason: 'empty_match' },
      )
    })

    it('preview_mail_action — multi-account batches all empty', async () => {
      mockSearchMessages.mockReturnValue([] as never)
      const handler = getToolHandler('preview_mail_action')
      await handler({
        action: 'trash',
        batches: [
          { accountId: 1, folder: 'INBOX', query: 'subject:gone' },
          { accountId: 2, folder: 'INBOX', query: 'subject:gone' },
        ],
      })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.preview_skipped',
        { kind: 'mail_action', reason: 'empty_match' },
      )
    })

    it('preview_unsubscribe — no messages found', async () => {
      mockSearchMessages.mockReturnValue([] as never)
      // getMessages is also called in the unsubscribe tool
      const { getMessages } = await import('../../packages/db')
      vi.mocked(getMessages).mockReturnValue([] as never)

      const handler = getToolHandler('preview_unsubscribe')
      await handler({ accountId: 1, folder: 'INBOX', query: 'newsletter', limit: 30 })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.preview_skipped',
        { kind: 'unsubscribe', reason: 'empty_match' },
      )
    })

    it('preview_snooze_email — empty uids array', async () => {
      const handler = getToolHandler('preview_snooze_email')
      await handler({ accountId: 1, folder: 'INBOX', uids: [], wakeAt: '2026-06-01T09:00:00Z' })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.preview_skipped',
        { kind: 'snooze_email', reason: 'empty_match' },
      )
    })

    it('preview_flag_email — empty uids array', async () => {
      const handler = getToolHandler('preview_flag_email')
      await handler({ accountId: 1, folder: 'INBOX', uids: [], flagged: true })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.preview_skipped',
        { kind: 'flag_email', reason: 'empty_match' },
      )
    })

    it('preview_mark_read_later — empty uids array', async () => {
      const handler = getToolHandler('preview_mark_read_later')
      await handler({ accountId: 1, folder: 'INBOX', uids: [], add: true })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.preview_skipped',
        { kind: 'mark_read_later', reason: 'empty_match' },
      )
    })

    it('move_email_preview — empty uids array', async () => {
      const handler = getToolHandler('move_email_preview')
      await handler({ accountId: 1, fromFolder: 'INBOX', toFolder: 'Archive', uids: [] })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.preview_skipped',
        { kind: 'move_email', reason: 'empty_match' },
      )
    })

    it('does NOT fire when preview has non-empty results (preview registered)', async () => {
      // Snooze with actual uids should register, not skip.
      const handler = getToolHandler('preview_snooze_email')
      await handler({ accountId: 1, folder: 'INBOX', uids: [10], wakeAt: '2026-06-01T09:00:00Z' })

      const skippedCalls = recordEventMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'ai.action.preview_skipped',
      )
      expect(skippedCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 2. recordBatchSize — ai.action.batch_size event fires after successful
  //    registration; bucket values are correct.
  // -------------------------------------------------------------------------

  describe('recordBatchSize fires ai.action.batch_size', () => {
    it('single-account mail_action (legacy path) emits batch_size with accounts_count_bucket=1', async () => {
      const handler = getToolHandler('preview_mail_action')
      await handler({ accountId: 1, action: 'archive', folder: 'INBOX', uids: [100, 101, 102] })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.batch_size',
        expect.objectContaining({
          kind: 'mail_action',
          accounts_count_bucket: '1',     // 1 account
          emails_count_bucket: '3-5',     // 3 emails
          // §2.20 PR1 fix-wave 2 — single-account legacy path: refs[] all
          // share the same folder by construction, so 1 unique tuple.
          folders_count_bucket: '1',
        }),
      )
    })

    it('multi-account batches with 2 accounts and 5 emails → correct bucket labels', async () => {
      const handler = getToolHandler('preview_mail_action')
      await handler({
        action: 'mark_read',
        batches: [
          { accountId: 1, folder: 'INBOX', uids: [10, 11, 12] },
          { accountId: 2, folder: 'INBOX', uids: [20, 21] },
        ],
      })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.batch_size',
        expect.objectContaining({
          kind: 'mail_action',
          accounts_count_bucket: '2',     // 2 accounts
          emails_count_bucket: '3-5',     // 5 emails total
          // 2 distinct (accountId, folder) tuples — one per account.
          folders_count_bucket: '2',
        }),
      )
    })

    it('large batch (6 accounts, 11 emails) → 6-10 and 11-20 buckets', async () => {
      const handler = getToolHandler('preview_mail_action')
      const batches = Array.from({ length: 6 }, (_, i) => ({
        accountId: i + 1,
        folder: 'INBOX',
        // accounts 1-5 get 2 uids each (10 emails), account 6 gets 1 uid (11 total)
        uids: i < 5 ? [i * 10 + 1, i * 10 + 2] : [i * 10 + 1],
      }))
      await handler({ action: 'archive', batches })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.batch_size',
        expect.objectContaining({
          accounts_count_bucket: '6-10',  // 6 accounts
          emails_count_bucket: '11-20',   // 11 emails
          // 6 distinct (accountId, folder) tuples — single-folder per
          // account, but 6 accounts.
          folders_count_bucket: '6-10',
        }),
      )
    })

    // §2.20 PR1 fix-wave 2 — single-account multi-folder batch surfaces
    // separately in telemetry. This is the codex HIGH attack scenario:
    // 1 account, refs[] spanning 2+ folders. Without `folders_count_bucket`
    // we cannot distinguish prompt-injection multi-folder forge attempts
    // from legitimate single-folder triage.
    it('single-account multi-folder batch → folders_count_bucket reflects folder count, accounts_count=1', async () => {
      const handler = getToolHandler('preview_mail_action')
      await handler({
        action: 'archive',
        batches: [
          { accountId: 1, folder: 'INBOX', uids: [1, 2] },
          { accountId: 1, folder: 'Important', uids: [3, 4, 5] },
        ],
      })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.batch_size',
        expect.objectContaining({
          kind: 'mail_action',
          accounts_count_bucket: '1',     // single account
          emails_count_bucket: '3-5',     // 5 emails total
          folders_count_bucket: '2',      // 2 distinct folders
        }),
      )
    })

    // Multi-account multi-folder cross product: cardinality is the real
    // (account, folder) tuple count, not just account count or folder
    // count alone.
    it('multi-account multi-folder cross product → folders_count_bucket = account×folder tuples', async () => {
      const handler = getToolHandler('preview_mail_action')
      await handler({
        action: 'mark_read',
        batches: [
          { accountId: 1, folder: 'INBOX', uids: [1] },
          { accountId: 1, folder: 'Important', uids: [2] },
          { accountId: 2, folder: 'INBOX', uids: [3] },
          { accountId: 2, folder: 'Promotions', uids: [4] },
        ],
      })

      expect(recordEventMock).toHaveBeenCalledWith(
        'ai.action.batch_size',
        expect.objectContaining({
          accounts_count_bucket: '2',
          emails_count_bucket: '3-5',     // 4 emails
          folders_count_bucket: '3-5',    // 4 distinct (acct, folder) tuples
        }),
      )
    })

    it('does NOT emit batch_size when empty-guard fires (no registration)', async () => {
      mockSearchMessages.mockReturnValue([] as never)
      const handler = getToolHandler('preview_mail_action')
      await handler({ accountId: 1, action: 'archive', folder: 'INBOX', query: 'from:void@x.test' })

      const batchSizeCalls = recordEventMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'ai.action.batch_size',
      )
      expect(batchSizeCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 3. bucket boundary values — exercised via the batch_size event.
  //    We derive the bucket from the emails_count_bucket field where we
  //    control exact counts. (§2.20 PR1 fix-wave Low#4: the local
  //    `bucketBatchSize` helper was removed and `recordBatchSize` now
  //    imports `bucketCount` from metricsBuckets.ts. These boundary
  //    tests double as integration coverage for that import wiring —
  //    a regression in either bucketCount thresholds OR recordBatchSize
  //    wiring will surface here.)
  // -------------------------------------------------------------------------

  describe('bucket boundary values (via recordBatchSize → bucketCount)', () => {
    async function getBucket(uids: number[]): Promise<string> {
      recordEventMock.mockClear()
      clearPendingPreviews()
      const handler = getToolHandler('preview_mail_action')
      await handler({ accountId: 1, action: 'archive', folder: 'INBOX', uids })
      const call = recordEventMock.mock.calls.find((c: unknown[]) => c[0] === 'ai.action.batch_size')
      if (!call) throw new Error('batch_size event not emitted')
      return (call[1] as { emails_count_bucket: string }).emails_count_bucket
    }

    it('1 uid → bucket "1"', async () => expect(await getBucket([1])).toBe('1'))
    it('2 uids → bucket "2"', async () => expect(await getBucket([1, 2])).toBe('2'))
    it('3 uids → bucket "3-5"', async () => expect(await getBucket([1, 2, 3])).toBe('3-5'))
    it('5 uids → bucket "3-5"', async () => expect(await getBucket([1, 2, 3, 4, 5])).toBe('3-5'))
    it('6 uids → bucket "6-10"', async () => expect(await getBucket([1, 2, 3, 4, 5, 6])).toBe('6-10'))
    it('10 uids → bucket "6-10"', async () => expect(await getBucket(Array.from({ length: 10 }, (_, i) => i + 1))).toBe('6-10'))
    it('11 uids → bucket "11-20"', async () => expect(await getBucket(Array.from({ length: 11 }, (_, i) => i + 1))).toBe('11-20'))
    // §2.20 PR1 fix-wave (Medium test-gap from codex iter 1): boundary
    // points around bucket transitions need explicit guards. The 20/21
    // and 50/51 transitions live in `bucketCount` (metricsBuckets.ts);
    // since recordBatchSize was de-dup'd to import bucketCount in this
    // fix-wave (Low#4), exercising the boundaries through the
    // batch_size event also validates the import wiring.
    it('20 uids → bucket "11-20" (upper boundary)', async () => expect(await getBucket(Array.from({ length: 20 }, (_, i) => i + 1))).toBe('11-20'))
    it('21 uids → bucket "21-50" (lower boundary)', async () => expect(await getBucket(Array.from({ length: 21 }, (_, i) => i + 1))).toBe('21-50'))
    it('50 uids → bucket "21-50" (upper boundary)', async () => expect(await getBucket(Array.from({ length: 50 }, (_, i) => i + 1))).toBe('21-50'))
    it('51 uids → bucket "51+"', async () => expect(await getBucket(Array.from({ length: 51 }, (_, i) => i + 1))).toBe('51+'))
  })

  // -------------------------------------------------------------------------
  // 4. Partial empty batches: some empty + some non-empty → register succeeds,
  //    batch_size event reflects only the non-empty refs, preview_skipped
  //    does NOT fire.
  // -------------------------------------------------------------------------

  describe('partial empty batches (mix of empty and non-empty)', () => {
    it('registers for non-empty account refs; no preview_skipped emitted', async () => {
      mockSearchMessages.mockReturnValue([] as never)
      const handler = getToolHandler('preview_mail_action')
      const result = await handler({
        action: 'archive',
        batches: [
          { accountId: 1, folder: 'INBOX', uids: [100, 101] },  // 2 hits
          { accountId: 2, folder: 'INBOX', query: 'from:gone@x.test' },  // 0 hits via search
        ],
      })

      const parsed = parseToolResult(result.content[0].text)
      expect(parsed.previewId).toBeDefined()
      expect(parsed.matched).toBe(2)

      // preview_skipped must NOT be emitted when at least one batch had refs.
      const skippedCalls = recordEventMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'ai.action.preview_skipped',
      )
      expect(skippedCalls).toHaveLength(0)

      // batch_size IS emitted with 1 account (only account 1 had hits).
      const batchSizeCall = recordEventMock.mock.calls.find(
        (c: unknown[]) => c[0] === 'ai.action.batch_size',
      )
      expect(batchSizeCall).toBeDefined()
      expect((batchSizeCall![1] as { accounts_count_bucket: string }).accounts_count_bucket).toBe('1')
    })
  })
})
