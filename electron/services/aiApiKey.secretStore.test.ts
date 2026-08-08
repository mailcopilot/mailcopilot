import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Codex cross-family review test-gap (Low) — `tests/e2e/ai-key-persistence.spec.ts`
 * proves per-provider delete addressing through `settings.aiApiKeySaved`, a
 * NON-authoritative marker: it is the main process's own note that it wrote a
 * key, not a read of the keychain. A bug that deletes the wrong provider's
 * secret (or all of them) while still flipping only the intended marker would
 * pass that e2e test.
 *
 * This file closes that gap with a REAL `SecretStore` (production
 * `createSecretStore` from ./secretStore, not a hand-rolled double) backed by
 * an in-memory fake `keytar` that reproduces the exact three-method contract
 * (`getPassword` / `setPassword` / `deletePassword`) the real module depends
 * on. `saveApiKey` / `deleteApiKey` (the real exports of ./ai) are exercised
 * unmodified, and the assertions compare the ACTUAL secret strings the store
 * holds afterwards — not a saved/not-saved flag.
 *
 * Differentiation: reverting `deleteApiKey`'s explicit-provider requirement to
 * a default (e.g. `provider ?? 'anthropic-api'`), or reintroducing the old
 * "loop over every provider" deletion, turns these tests red — the wrong
 * provider's real value would come back null, or a surviving provider's value
 * would be gone — while `ai.test.ts`'s call-count assertions on a `vi.fn()`
 * mock cannot observe that at all (the mock never stores anything).
 *
 * The heavy vi.mock blocks below are the SAME third-party-SDK stubs
 * `ai.test.ts` uses to import `./ai` without pulling in the Claude Agent SDK /
 * MCP / canvas native deps — they mock libraries this file does not exercise,
 * not the module under test. Only `./secretStore` differs from `ai.test.ts`:
 * there it is a bare `vi.fn()` triple with no storage; here it is the real
 * store engine.
 */

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isConnected: vi.fn(() => false),
  })),
}))

vi.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: {
    createLinkedPair: vi.fn(() => [{}, {}]),
  },
}))

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return {
    APICallError: actual.APICallError,
    streamText: vi.fn(),
    stepCountIs: vi.fn((n: number) => n),
    extractReasoningMiddleware: vi.fn(() => ({})),
    wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
  }
})

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn((modelId: string) => ({ modelId }))),
}))

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async () => ({
    tools: vi.fn(async () => ({})),
    close: vi.fn(async () => {}),
  })),
}))

vi.mock('@napi-rs/canvas', () => ({
  createCanvas: vi.fn(),
  loadImage: vi.fn(),
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
  admitAiReservation: vi.fn(),
  reconcileAiReservation: vi.fn(),
  AiBudgetReserveError: class AiBudgetReserveError extends Error {},
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

// §2.122 marker — not this file's concern (that is ai.test.ts's job); stubbed
// so saveApiKey/deleteApiKey's non-secret bookkeeping call does not throw.
vi.mock('../../packages/net/config', () => ({
  listAccounts: vi.fn(() => []),
  getAccountMeta: vi.fn(),
  getSettings: vi.fn(() => ({})),
  setAiApiKeySavedFlag: vi.fn(),
}))

const mockUserDataDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'mailcopilot-ai-key-secretstore-test-'))
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mockUserDataDir) },
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/claude\n'),
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

vi.mock('../sentry', () => ({
  startInactiveSpan: vi.fn(() => ({ setAttributes: vi.fn(), setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() })),
  sentryLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), fmt: vi.fn() },
  wrapMcpServerWithSentry: vi.fn((server: unknown) => server),
  captureException: vi.fn(),
  reportKeychainUnavailable: vi.fn(),
}))

/**
 * The one deliberate difference from ai.test.ts: `./secretStore` is mocked to
 * export the REAL `createSecretStore(...)` engine (via `importActual`) wired
 * to an in-memory fake keytar, instead of a bare `{ get, set, delete: vi.fn() }`
 * triple. The fake keytar reproduces `KeytarLike`'s exact three-method async
 * contract (electron/services/secretStore.ts) — same signatures, same
 * resolve/reject shape (getPassword resolves `null` for a missing key,
 * deletePassword resolves a boolean, never throws for "not found") — so the
 * store's own probe/backend logic runs unmodified and picks the `keytar`
 * backend (never the disk fallback), exactly as it would against a healthy OS
 * keychain.
 */
vi.mock('./secretStore', async (importActual) => {
  const actual = await importActual<typeof import('./secretStore')>()
  const backing = new Map<string, string>()
  const fakeKeytar = {
    async getPassword(_service: string, account: string): Promise<string | null> {
      return backing.has(account) ? backing.get(account)! : null
    },
    async setPassword(_service: string, account: string, password: string): Promise<void> {
      backing.set(account, password)
    },
    async deletePassword(_service: string, account: string): Promise<boolean> {
      return backing.delete(account)
    },
  }
  const realStore = actual.createSecretStore({ keytar: () => fakeKeytar })
  return { secretStore: realStore, createSecretStore: actual.createSecretStore }
})

import { saveApiKey, deleteApiKey } from './ai'
import { secretStore } from './secretStore'

// §2.122 — the identifier scheme the real service uses (mirrors
// `getApiKeyId` in electron/services/ai.ts, which is not exported). Reading
// through the SAME real `secretStore` instance the production code writes
// through — not a second store — so this reads back exactly what
// saveApiKey/deleteApiKey actually persisted.
const KEY_ID: Record<'anthropic-api' | 'openai-api' | 'gemini-api', string> = {
  'anthropic-api': 'anthropic_api_key',
  'openai-api': 'openai_api_key',
  'gemini-api': 'gemini_api_key',
}

describe('AI API key persistence — real SecretStore engine (in-memory keytar double)', () => {
  afterEach(async () => {
    // Leave no residue between tests: delete whatever any test wrote.
    for (const id of Object.values(KEY_ID)) {
      await secretStore.delete(id, 'ai_keys').catch(() => {})
    }
  })

  it('deleting one provider removes exactly that value and leaves the other two byte-for-byte intact', async () => {
    await saveApiKey('sk-ant-real-0001', 'anthropic-api')
    await saveApiKey('sk-openai-real-0002', 'openai-api')
    await saveApiKey('sk-gemini-real-0003', 'gemini-api')

    await deleteApiKey('openai-api')

    // The deleted provider's ACTUAL secret is gone — not merely its marker.
    await expect(secretStore.get(KEY_ID['openai-api'], 'ai_keys')).resolves.toBeNull()

    // The untouched providers still hold the EXACT values that were saved —
    // proves addressing, not just "something survived".
    await expect(secretStore.get(KEY_ID['anthropic-api'], 'ai_keys')).resolves.toBe('sk-ant-real-0001')
    await expect(secretStore.get(KEY_ID['gemini-api'], 'ai_keys')).resolves.toBe('sk-gemini-real-0003')
  })

  it('re-saving a deleted provider with a new value round-trips the new value, not the old one', async () => {
    await saveApiKey('sk-openai-old-value', 'openai-api')
    await deleteApiKey('openai-api')
    await saveApiKey('sk-openai-new-value', 'openai-api')

    await expect(secretStore.get(KEY_ID['openai-api'], 'ai_keys')).resolves.toBe('sk-openai-new-value')
  })

  it('deleting a provider that was never saved is a real no-op — the other two are untouched', async () => {
    await saveApiKey('sk-ant-untouched', 'anthropic-api')
    await saveApiKey('sk-gemini-untouched', 'gemini-api')

    await deleteApiKey('openai-api')

    await expect(secretStore.get(KEY_ID['anthropic-api'], 'ai_keys')).resolves.toBe('sk-ant-untouched')
    await expect(secretStore.get(KEY_ID['gemini-api'], 'ai_keys')).resolves.toBe('sk-gemini-untouched')
  })
})
