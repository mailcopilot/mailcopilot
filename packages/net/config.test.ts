import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Mock keytar — native module, unavailable in the test environment
const keytarStore = new Map<string, string>()
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn((_service: string, key: string) => Promise.resolve(keytarStore.get(key) ?? null)),
    setPassword: vi.fn((_service: string, key: string, value: string) => { keytarStore.set(key, value); return Promise.resolve() }),
    deletePassword: vi.fn((_service: string, key: string) => { keytarStore.delete(key); return Promise.resolve(true) }),
  },
}))

// Mock electron-store — Electron is not available in the test environment
const storeData = new Map<string, unknown>()
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      get(key: string) { return storeData.get(key) }
      set(key: string, value: unknown) { storeData.set(key, value) }
      delete(key: string) { storeData.delete(key) }
    },
  }
})

// Mock DB deleteAccountData
vi.mock('../db', () => ({
  deleteAccountData: vi.fn(),
}))

import {
  imapSchema,
  smtpSchema,
  accountSaveSchema,
  settingsSchema,
  listAccounts,
  saveAccount,
  getAccountMeta,
  getSettings,
  getRawPersistedSettings,
  saveSettings,
  deleteAccount,
  getAccountConfig,
  saveMcpConnection,
  getMcpConnection,
  listMcpConnections,
  deleteMcpConnection,
  oauthRefreshSecretKey,
  legacyGoogleRefreshSecretKey,
  lookupOauthRefreshToken,
  lookupOauthRefreshTokenWithSource,
  setOauthRefreshToken,
  getOauthRefreshToken,
  getOauthRefreshTokenWithSource,
  deleteLegacyGoogleRefreshToken,
  identitySchema,
  identitiesArraySchema,
  normalizeIdentities,
  rendererWritableSettingsSchema,
  mcpSaveConnectionSchema,
  mcpConnectionSchema,
  isAllowedMcpStdioCommand,
  MAIN_ONLY_SETTINGS_FIELDS,
  DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST,
  FORBIDDEN_MCP_STDIO_ENV_KEYS,
  isForbiddenMcpStdioEnvKey,
  findForbiddenMcpStdioEnvKeys,
  sanitizeMcpConnectionsEnv,
  setMcpEnvSanitizationListener,
  __resetMcpEnvSanitizationAuditFlagForTest,
  setSecretBackend,
  type KeytarGetter,
} from './config'
import type { Settings, SecretBackend, SecretSurface } from './config'

// Valid UUIDs used across the identities test suite. The write-side schema
// (accountSaveSchema.identities[].id) and normalizeIdentities now reject
// non-UUID ids — the renderer sends crypto.randomUUID() values. Keep a
// handful of fixed UUIDs here so tests stay readable and deterministic.
const UUID_PRIMARY = '11111111-1111-4111-8111-111111111111'
const UUID_ALIAS = '22222222-2222-4222-8222-222222222222'
const UUID_NEW_DEFAULT = '33333333-3333-4333-8333-333333333333'
const UUID_STABLE = '44444444-4444-4444-8444-444444444444'
const UUID_DUP = '55555555-5555-4555-8555-555555555555'

describe('packages/net/config', () => {
  beforeEach(() => {
    storeData.clear()
    keytarStore.clear()
    vi.clearAllMocks()
  })

  // --- Zod schemas ---

  describe('Zod schemas', () => {
    it('imapSchema accepts a valid config', () => {
      const result = imapSchema.parse({
        host: 'imap.example.com',
        port: 993,
        secure: true,
        user: 'alice@example.com',
        pass: 'secret',
      })
      expect(result.host).toBe('imap.example.com')
      expect(result.port).toBe(993)
    })

    it('imapSchema rejects empty host', () => {
      expect(() => imapSchema.parse({ host: '', port: 993, secure: true, user: 'a@b.com', pass: 'x' })).toThrow()
    })

    it('imapSchema rejects negative port', () => {
      expect(() => imapSchema.parse({ host: 'h', port: -1, secure: true, user: 'a@b.com', pass: 'x' })).toThrow()
    })

    it('imapSchema rejects empty user', () => {
      expect(() => imapSchema.parse({ host: 'h', port: 993, secure: true, user: '', pass: 'x' })).toThrow()
    })

    it('imapSchema accepts without pass (optional)', () => {
      const result = imapSchema.parse({ host: 'h', port: 993, secure: true, user: 'a@b.com' })
      expect(result.pass).toBeUndefined()
    })

    it('imapSchema strips legacy skipTlsVerify field', () => {
      const result = imapSchema.parse({
        host: 'imap.example.com',
        port: 993,
        secure: true,
        user: 'alice@example.com',
        skipTlsVerify: true,
      })
      expect('skipTlsVerify' in result).toBe(false)
    })

    // Pinned certificate bodies travel with their fingerprints: buildTlsOptions
    // uses them as explicit trust anchors so a pinned self-signed server can
    // verify with rejectUnauthorized: true. A schema that does not declare the
    // field would strip it on parse and silently keep such accounts broken.
    it('imapSchema preserves tlsPinnedCertsPem alongside tlsPinsSha256', () => {
      const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
      const result = imapSchema.parse({
        host: 'imap.example.com',
        port: 993,
        secure: true,
        user: 'alice@example.com',
        tlsPinsSha256: ['AA:BB:CC'],
        tlsPinnedCertsPem: [pem],
      })
      expect(result.tlsPinnedCertsPem).toEqual([pem])
      expect(result.tlsPinsSha256).toEqual(['AA:BB:CC'])
    })

    it('smtpSchema preserves tlsPinnedCertsPem, and omitting it stays valid', () => {
      const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
      const withPem = smtpSchema.parse({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        user: 'alice@example.com',
        tlsPinnedCertsPem: [pem],
      })
      expect(withPem.tlsPinnedCertsPem).toEqual([pem])

      // Absent field: optional, no default, existing behaviour unchanged.
      const without = smtpSchema.parse({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'alice@example.com',
        pass: 'secret',
      })
      expect(without.tlsPinnedCertsPem).toBeUndefined()
      expect('tlsPinnedCertsPem' in without).toBe(false)
    })

    it('smtpSchema is similar to imapSchema', () => {
      const result = smtpSchema.parse({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'alice@example.com',
        pass: 'secret',
      })
      expect(result.host).toBe('smtp.example.com')
    })

    it('settingsSchema applies defaults', () => {
      const result = settingsSchema.parse({
        theme: 'dark',
        cacheDays: 30,
      })
      expect(result.language).toBe('en')
      expect(result.notificationsEnabled).toBe(true)
      expect(result.imapIdleEnabled).toBe(true)
      expect(result.draftSyncEnabled).toBe(true)
      expect(result.groupConversations).toBe(true)
      expect(result.offlineEnabled).toBe(false)
      expect(result.offlineSyncDays).toBe(30)
    })

    // §2.15-ter: bodyRetentionDays replaces the old cacheDays runtime read
    // path. Schema default must match the UI default (1 year) and only the
    // documented enum values are accepted.
    it('settingsSchema — bodyRetentionDays defaults to 365', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.bodyRetentionDays).toBe(365)
    })

    it('settingsSchema — bodyRetentionDays accepts 30/90/180/365/-1', () => {
      for (const v of [30, 90, 180, 365, -1] as const) {
        const result = settingsSchema.parse({ theme: 'light', cacheDays: 30, bodyRetentionDays: v })
        expect(result.bodyRetentionDays).toBe(v)
      }
    })

    it('settingsSchema — bodyRetentionDays rejects values outside the allowed enum', () => {
      for (const v of [0, 7, 60, 999, 1000]) {
        expect(() => settingsSchema.parse({ theme: 'light', cacheDays: 30, bodyRetentionDays: v })).toThrow()
      }
    })

    it('settingsSchema — cacheDays remains optional with default 30 (deprecated, kept for legacy persisted configs)', () => {
      const result = settingsSchema.parse({ theme: 'light' })
      expect(result.cacheDays).toBe(30)
    })

    it('settingsSchema rejects invalid theme', () => {
      expect(() => settingsSchema.parse({ theme: 'rainbow', cacheDays: 30 })).toThrow()
    })

    it('settingsSchema — syncIntervalMinutes default=1', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.syncIntervalMinutes).toBe(1)
    })

    it('settingsSchema — syncIntervalMinutes accepts 1-30', () => {
      expect(settingsSchema.parse({ theme: 'light', cacheDays: 30, syncIntervalMinutes: 5 }).syncIntervalMinutes).toBe(5)
      expect(settingsSchema.parse({ theme: 'light', cacheDays: 30, syncIntervalMinutes: 30 }).syncIntervalMinutes).toBe(30)
    })

    it('settingsSchema — syncIntervalMinutes rejects <1 and >30', () => {
      expect(() => settingsSchema.parse({ theme: 'light', cacheDays: 30, syncIntervalMinutes: 0 })).toThrow()
      expect(() => settingsSchema.parse({ theme: 'light', cacheDays: 30, syncIntervalMinutes: 31 })).toThrow()
    })

    it('settingsSchema — sentryEnabled default=true', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.sentryEnabled).toBe(true)
    })

    it('settingsSchema — sentryEnabled accepts false', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30, sentryEnabled: false })
      expect(result.sentryEnabled).toBe(false)
    })

    // §2.82 — the raw settingsSchema shape for the consent record. The
    // renderer-writable rejection is covered separately in
    // electron/telemetryConsent.test.ts (AC9); this pins the parse contract
    // itself, which nothing else exercises.
    it('settingsSchema — telemetryConsent is absent by default (no record means "not answered yet")', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.telemetryConsent).toBeUndefined()
    })

    it('settingsSchema — telemetryConsent accepts a well-formed record', () => {
      const result = settingsSchema.parse({
        theme: 'light',
        cacheDays: 30,
        telemetryConsent: { granted: true, version: 1, at: '2026-07-27T10:00:00.000Z' },
      })
      expect(result.telemetryConsent).toEqual({ granted: true, version: 1, at: '2026-07-27T10:00:00.000Z' })
    })

    it('settingsSchema — telemetryConsent rejects a non-integer version', () => {
      expect(() => settingsSchema.parse({
        theme: 'light',
        cacheDays: 30,
        telemetryConsent: { granted: true, version: 1.5, at: '2026-07-27T10:00:00.000Z' },
      })).toThrow()
    })

    it('settingsSchema — telemetryConsent rejects an empty timestamp', () => {
      expect(() => settingsSchema.parse({
        theme: 'light',
        cacheDays: 30,
        telemetryConsent: { granted: true, version: 1, at: '' },
      })).toThrow()
    })

    it('settingsSchema — telemetryConsent rejects a missing `granted`', () => {
      expect(() => settingsSchema.parse({
        theme: 'light',
        cacheDays: 30,
        telemetryConsent: { version: 1, at: '2026-07-27T10:00:00.000Z' },
      })).toThrow()
    })

    it('settingsSchema — aiMaxTurns default=30', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.aiMaxTurns).toBe(30)
    })

    it('settingsSchema — aiMaxTurns accepts 1-200', () => {
      expect(settingsSchema.parse({ theme: 'light', cacheDays: 30, aiMaxTurns: 1 }).aiMaxTurns).toBe(1)
      expect(settingsSchema.parse({ theme: 'light', cacheDays: 30, aiMaxTurns: 200 }).aiMaxTurns).toBe(200)
    })

    it('settingsSchema — aiMaxTurns rejects <1 and >200', () => {
      expect(() => settingsSchema.parse({ theme: 'light', cacheDays: 30, aiMaxTurns: 0 })).toThrow()
      expect(() => settingsSchema.parse({ theme: 'light', cacheDays: 30, aiMaxTurns: 201 })).toThrow()
    })

    it('settingsSchema — aiMaxBudgetPerRequest default=2', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.aiMaxBudgetPerRequest).toBe(2)
    })

    it('settingsSchema — aiMaxBudgetPerRequest accepts 0-100', () => {
      expect(settingsSchema.parse({ theme: 'light', cacheDays: 30, aiMaxBudgetPerRequest: 0 }).aiMaxBudgetPerRequest).toBe(0)
      expect(settingsSchema.parse({ theme: 'light', cacheDays: 30, aiMaxBudgetPerRequest: 100 }).aiMaxBudgetPerRequest).toBe(100)
    })

    it('settingsSchema — aiMaxBudgetPerRequest rejects >100', () => {
      expect(() => settingsSchema.parse({ theme: 'light', cacheDays: 30, aiMaxBudgetPerRequest: 101 })).toThrow()
    })

    it('settingsSchema — aiProxyUrl is optional', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.aiProxyUrl).toBeUndefined()
    })

    it('settingsSchema — aiProxyUrl accepts proxy URL', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30, aiProxyUrl: 'http://proxy:3128' })
      expect(result.aiProxyUrl).toBe('http://proxy:3128')
    })

    it('settingsSchema — aiProxyUrl trims whitespace', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30, aiProxyUrl: '  http://proxy:3128  ' })
      expect(result.aiProxyUrl).toBe('http://proxy:3128')
    })

    it('settingsSchema — aiOpenAiBaseUrl is optional', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
      expect(result.aiOpenAiBaseUrl).toBeUndefined()
    })

    it('settingsSchema — aiOpenAiBaseUrl accepts URL', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30, aiOpenAiBaseUrl: 'https://openrouter.ai/api' })
      expect(result.aiOpenAiBaseUrl).toBe('https://openrouter.ai/api')
    })

    it('settingsSchema — aiOpenAiBaseUrl trims whitespace', () => {
      const result = settingsSchema.parse({ theme: 'light', cacheDays: 30, aiOpenAiBaseUrl: '  https://openrouter.ai/api  ' })
      expect(result.aiOpenAiBaseUrl).toBe('https://openrouter.ai/api')
    })

    it('accountSaveSchema accepts minimal config', () => {
      const result = accountSaveSchema.parse({
        imap: { host: 'h', port: 993, secure: true, user: 'a@b.com', pass: 'x' },
        smtp: { host: 'h', port: 587, secure: false, user: 'a@b.com', pass: 'x' },
      })
      expect(result.imap.host).toBe('h')
    })

    it('accountSaveSchema rejects extra fields (strict)', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'h', port: 993, secure: true, user: 'a@b.com', pass: 'x' },
        smtp: { host: 'h', port: 587, secure: false, user: 'a@b.com', pass: 'x' },
        extraField: 'bad',
      })).toThrow()
    })
  })

  // --- Account management ---

  describe('Account management', () => {
    it('listAccounts returns empty array without accounts', () => {
      const accounts = listAccounts()
      expect(accounts).toEqual([])
    })

    it('saveAccount creates a new account with id=1', async () => {
      const result = await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
      })
      expect(result.id).toBe(1)
      const accounts = listAccounts()
      expect(accounts.length).toBe(1)
      expect(accounts[0].id).toBe(1)
      expect(accounts[0].imap.host).toBe('imap.test')
      expect(typeof accounts[0].colorIndex).toBe('number')
      // Password must not be in AccountMeta
      expect((accounts[0].imap as unknown as { pass?: string }).pass).toBeUndefined()
    })

    it('saveAccount second account gets id=2', async () => {
      await saveAccount({
        imap: { host: 'imap1.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp1.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
      })
      const result = await saveAccount({
        imap: { host: 'imap2.test', port: 993, secure: true, user: 'b@test', pass: 'p1' },
        smtp: { host: 'smtp2.test', port: 587, secure: false, user: 'b@test', pass: 'p2' },
      })
      expect(result.id).toBe(2)
      expect(listAccounts().length).toBe(2)
      const [a1, a2] = listAccounts()
      // Should have different color indexes (while palette is not exhausted).
      expect(a1.colorIndex).not.toBeUndefined()
      expect(a2.colorIndex).not.toBeUndefined()
      if (a1.colorIndex !== undefined && a2.colorIndex !== undefined) {
        expect(a1.colorIndex).not.toBe(a2.colorIndex)
      }
    })

    it('saveAccount updates existing account by id', async () => {
      await saveAccount({
        imap: { host: 'old.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'old.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
      })
      await saveAccount({
        id: 1,
        imap: { host: 'new.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'new.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
      })
      const accounts = listAccounts()
      expect(accounts.length).toBe(1)
      expect(accounts[0].imap.host).toBe('new.test')
    })

    it('saveAccount saves avatar settings (avatarInitials, avatarIcon, avatarMode)', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
        avatarInitials: 'AB',
        avatarIcon: 'star',
        avatarMode: 'icon',
      })
      const acc = listAccounts()[0]
      expect(acc.avatarInitials).toBe('AB')
      expect(acc.avatarIcon).toBe('star')
      expect(acc.avatarMode).toBe('icon')
    })

    it('saveAccount saves avatarMode=gravatar', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
        avatarMode: 'gravatar',
      })
      const acc = listAccounts()[0]
      expect(acc.avatarMode).toBe('gravatar')
    })

    it('saveAccount preserves existing avatar settings on update', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
        avatarInitials: 'XY',
        avatarMode: 'initials',
      })
      // Update account without specifying avatar fields — they should be preserved.
      await saveAccount({
        id: 1,
        imap: { host: 'imap2.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp2.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
      })
      const acc = listAccounts()[0]
      expect(acc.avatarInitials).toBe('XY')
      expect(acc.avatarMode).toBe('initials')
    })

    it('getAccountMeta returns account by id', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
      })
      const meta = getAccountMeta(1)
      expect(meta).toBeDefined()
      expect(meta!.imap.host).toBe('imap.test')
    })

    it('getAccountMeta returns undefined for non-existent id', () => {
      expect(getAccountMeta(999)).toBeUndefined()
    })

    it('getAccountConfig restores passwords from keytar', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'imapPass' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'smtpPass' },
      })
      const config = await getAccountConfig(1)
      expect(config).toBeDefined()
      expect(config!.imap.pass).toBe('imapPass')
      expect(config!.smtp.pass).toBe('smtpPass')
    })

    it('getAccountConfig returns undefined for non-existent id', async () => {
      expect(await getAccountConfig(999)).toBeUndefined()
    })

    it('deleteAccount removes account and secrets', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
      })
      expect(listAccounts().length).toBe(1)
      await deleteAccount(1)
      expect(listAccounts().length).toBe(0)
    })

    it('saveAccount with folderRoles', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p' },
        folderRoles: { trash: 'Trash', archive: 'Archive' },
      })
      const meta = getAccountMeta(1)
      expect(meta?.folderRoles?.trash).toBe('Trash')
      expect(meta?.folderRoles?.archive).toBe('Archive')
    })

    it('saveAccount with name and signature', async () => {
      await saveAccount({
        name: 'Work',
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p' },
        signature: 'Best regards',
      })
      const meta = getAccountMeta(1)
      expect(meta?.name).toBe('Work')
      expect(meta?.signature).toBe('Best regards')
    })

    it('listAccounts sanitizes legacy skipTlsVerify fields from stored accounts', () => {
      storeData.set('accounts', [{
        id: 1,
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', skipTlsVerify: true },
        smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'alice@example.com', skipTlsVerify: true },
      }])

      const accounts = listAccounts()
      expect(accounts).toHaveLength(1)
      expect('skipTlsVerify' in accounts[0].imap).toBe(false)
      expect('skipTlsVerify' in accounts[0].smtp).toBe(false)
    })
  })

  describe('MCP connections', () => {
    it('saves and lists MCP connections in settings store', () => {
      saveSettings({ theme: 'light', cacheDays: 30 } as Settings)

      saveMcpConnection({
        id: 'obsidian',
        name: 'Obsidian',
        transport: 'sse',
        url: 'http://localhost:27182/mcp',
        enabled: true,
        autoConnect: true,
      })

      expect(listMcpConnections()).toHaveLength(1)
      expect(getMcpConnection('obsidian')?.url).toBe('http://localhost:27182/mcp')
    })

    it('deletes MCP connections from settings store', () => {
      saveSettings({ theme: 'light', cacheDays: 30 } as Settings)
      saveMcpConnection({
        id: 'obsidian',
        name: 'Obsidian',
        transport: 'sse',
        url: 'http://localhost:27182/mcp',
        enabled: true,
        autoConnect: false,
      })

      deleteMcpConnection('obsidian')
      expect(listMcpConnections()).toEqual([])
      expect(getMcpConnection('obsidian')).toBeUndefined()
    })
  })

  // --- §3.10 P0 schema split ---

  describe('rendererWritableSettingsSchema', () => {
    it('accepts a plain renderer payload', () => {
      const result = rendererWritableSettingsSchema.safeParse({
        theme: 'dark',
        language: 'en',
        notificationsEnabled: false,
      })
      expect(result.success).toBe(true)
    })

    it('rejects mcpEnableStdio from renderer payload (forbidden_field)', () => {
      const result = rendererWritableSettingsSchema.safeParse({
        theme: 'dark',
        mcpEnableStdio: true,
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const forbidden = result.error.issues
          .filter(i => i.code === 'unrecognized_keys')
          .flatMap(i => {
            const keys = (i as { keys?: unknown }).keys
            return Array.isArray(keys) ? (keys as string[]) : []
          })
        expect(forbidden).toContain('mcpEnableStdio')
      }
    })

    it('rejects stdioApproved from renderer payload', () => {
      const result = rendererWritableSettingsSchema.safeParse({
        theme: 'dark',
        stdioApproved: { source: 'native-confirm', approvedAt: 'x', appVersion: '1' },
      })
      expect(result.success).toBe(false)
    })

    it('rejects mcpConnections from renderer payload (must use mcp:saveConnection IPC)', () => {
      const result = rendererWritableSettingsSchema.safeParse({
        theme: 'dark',
        mcpConnections: [{
          id: 'x', name: 'x', transport: 'sse', url: 'http://localhost:1', enabled: true, autoConnect: false,
        }],
      })
      expect(result.success).toBe(false)
    })

    it('MAIN_ONLY_SETTINGS_FIELDS matches the rejected-forbidden set', () => {
      // Regression guard: if someone adds a new main-only field, they must
      // also add it to MAIN_ONLY_SETTINGS_FIELDS, else the §3.10 P0 audit
      // hook in electron/main.ts won't catch renderer attempts to write it.
      for (const field of MAIN_ONLY_SETTINGS_FIELDS) {
        const result = rendererWritableSettingsSchema.safeParse({ [field]: 'whatever' })
        expect(result.success).toBe(false)
      }
    })

    // §3.10 P1: aiEgressPolicy
    it('accepts valid aiEgressPolicy values from renderer', () => {
      for (const value of ['default-deny', 'ask', 'allow']) {
        const result = rendererWritableSettingsSchema.safeParse({ aiEgressPolicy: value })
        expect(result.success).toBe(true)
      }
    })

    it('rejects unknown aiEgressPolicy values from renderer', () => {
      // Bounded enum prevents a compromised renderer from extending the
      // policy surface with a fourth value the gate doesn't know how to handle.
      const result = rendererWritableSettingsSchema.safeParse({ aiEgressPolicy: 'block' })
      expect(result.success).toBe(false)
    })

    // §3.3 B4 — aiInstantReplyEnabled (per-account Instant Reply opt-in map).
    // A plain UX opt-in (not a security gate like mcpEnableStdio), so it is
    // renderer-writable — the Settings → AI toggle writes here directly.
    it('accepts a well-formed aiInstantReplyEnabled record from the renderer', () => {
      const result = rendererWritableSettingsSchema.safeParse({
        aiInstantReplyEnabled: { '1': true, '2': false },
      })
      expect(result.success).toBe(true)
    })

    it('accepts an empty aiInstantReplyEnabled record (all accounts default OFF)', () => {
      const result = rendererWritableSettingsSchema.safeParse({ aiInstantReplyEnabled: {} })
      expect(result.success).toBe(true)
    })

    it('rejects a non-boolean value inside aiInstantReplyEnabled (bounded value shape)', () => {
      const result = rendererWritableSettingsSchema.safeParse({
        aiInstantReplyEnabled: { '1': 'yes' },
      })
      expect(result.success).toBe(false)
    })

    it('omitting aiInstantReplyEnabled from a renderer payload is valid (field is optional here)', () => {
      const result = rendererWritableSettingsSchema.safeParse({ theme: 'dark' })
      expect(result.success).toBe(true)
    })
  })

  describe('settingsSchema — aiInstantReplyEnabled default (§3.3 B4)', () => {
    it('defaults to an empty record (feature OFF for every account) when omitted', () => {
      const parsed = settingsSchema.parse({ theme: 'light' })
      expect(parsed.aiInstantReplyEnabled).toEqual({})
    })

    it('parses a populated per-account opt-in map', () => {
      const parsed = settingsSchema.parse({ theme: 'light', aiInstantReplyEnabled: { '1': true, '2': false } })
      expect(parsed.aiInstantReplyEnabled).toEqual({ '1': true, '2': false })
    })

    it('is NOT present in MAIN_ONLY_SETTINGS_FIELDS (renderer-writable, not a security gate)', () => {
      expect(MAIN_ONLY_SETTINGS_FIELDS).not.toContain('aiInstantReplyEnabled')
    })
  })

  describe('§3.10 P0 stdio command allowlist', () => {
    it('accepts all entries in DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST', () => {
      for (const cmd of DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST) {
        expect(isAllowedMcpStdioCommand(cmd)).toBe(true)
      }
    })

    it('rejects arbitrary binaries', () => {
      expect(isAllowedMcpStdioCommand('/usr/bin/evil')).toBe(false)
      expect(isAllowedMcpStdioCommand('rm')).toBe(false)
      expect(isAllowedMcpStdioCommand('../node')).toBe(false)
      expect(isAllowedMcpStdioCommand('')).toBe(false)
    })

    it('is exact-match — absolute paths to allowed binaries are rejected', () => {
      // Deliberate: spawn resolves PATH on the command name alone, so users
      // should pass bare names. Absolute paths indicate a bypass attempt.
      expect(isAllowedMcpStdioCommand('/usr/bin/node')).toBe(false)
      expect(isAllowedMcpStdioCommand('/usr/local/bin/npx')).toBe(false)
    })
  })

  describe('mcpSaveConnectionSchema (§3.10 P0)', () => {
    it('accepts a valid sse payload', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'sse',
        url: 'http://localhost:27182/mcp',
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(true)
    })

    it('accepts an approvedSource field but it is ignored downstream', () => {
      // The schema is accept-and-ignore on approvedSource so main can re-stamp
      // it on save. We test that parsing succeeds with the field present;
      // the main-side handler is what drops it.
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@some/server'],
        enabled: true,
        autoConnect: false,
        approvedSource: 'native-confirm',
      })
      expect(r.success).toBe(true)
    })

    it('rejects unknown fields (strict)', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'sse',
        url: 'http://localhost:27182/mcp',
        enabled: true,
        autoConnect: false,
        smugglingAttempt: 'extra-field',
      })
      expect(r.success).toBe(false)
    })
  })

  // --- §3.10 P0 wave 2: per-connection stdio env denylist ---

  describe('FORBIDDEN_MCP_STDIO_ENV_KEYS (§3.10 P0 wave 2)', () => {
    // BLOCKER-1: Node / Python / Bun / Deno loader-hook env vars give a
    // remote-code-execution path even for allowlisted `command` values
    // (e.g. NODE_OPTIONS=--require /tmp/evil.js preloads before the
    // approved script runs). Each of the keys below must be rejected by
    // both the renderer-write schema and the persisted-read schema.

    it('rejects NODE_OPTIONS in mcpSaveConnectionSchema env', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        args: ['./server.js'],
        env: { NODE_OPTIONS: '--require /tmp/evil.js' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('rejects PYTHONSTARTUP in mcpSaveConnectionSchema env', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'python',
        args: ['-i'],
        env: { PYTHONSTARTUP: '/tmp/evil.py' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('rejects LD_PRELOAD in mcpSaveConnectionSchema env', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { LD_PRELOAD: '/tmp/evil.so' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('rejects PATH in mcpSaveConnectionSchema env (PATH-shadowing attack)', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { PATH: '/tmp/attacker-bins:/usr/bin' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('rejects DYLD_INSERT_LIBRARIES on macOS injection vector', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('rejects BUN_CONFIG_PRELOAD via prefix guard', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'bun',
        env: { BUN_CONFIG_PRELOAD: '/tmp/evil.ts' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('rejects a future BUN_CONFIG_* key we have not seen yet (prefix guard)', () => {
      // Bun adds config env vars over time; the prefix guard keeps new
      // runtime-affecting knobs locked out without a code change.
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'bun',
        env: { BUN_CONFIG_SOMETHING_NEW: 'hostile' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('rejects case-variant "node_options" (Windows-normalized path)', () => {
      // Env var names are case-sensitive on Linux/macOS but Windows
      // normalizes — and the MCP spawn could be re-rigged to hit that
      // path. Rejecting all case variants removes the platform-specific
      // bypass.
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { node_options: '--require /tmp/evil.js' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('allows harmless user-declared OPENAI_API_KEY', () => {
      // The denylist targets loader-hook / PATH-shadow keys; user-opted
      // secrets like OPENAI_API_KEY remain legitimate per the existing
      // `STDIO_ENV_WHITELIST` layering in mcpClient.ts.
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { OPENAI_API_KEY: 'sk-user-declared' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(true)
    })

    it('allows unrelated custom env keys (MY_VAR)', () => {
      const r = mcpSaveConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { MY_VAR: 'whatever' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(true)
    })

    it('also rejects forbidden keys on the persisted-read schema', () => {
      // Defense-in-depth: if a poisoned config ever made it into the
      // settings store (schema skew across versions, manual edit,
      // …) the read-side schema still rejects on load. Guarantees the
      // mcp:connect path never sees a poisoned env.
      const r = mcpConnectionSchema.safeParse({
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { NODE_OPTIONS: '--require /tmp/evil.js' },
        enabled: true,
        autoConnect: false,
      })
      expect(r.success).toBe(false)
    })

    it('isForbiddenMcpStdioEnvKey is case-insensitive', () => {
      expect(isForbiddenMcpStdioEnvKey('NODE_OPTIONS')).toBe(true)
      expect(isForbiddenMcpStdioEnvKey('node_options')).toBe(true)
      expect(isForbiddenMcpStdioEnvKey('Node_Options')).toBe(true)
      expect(isForbiddenMcpStdioEnvKey('OPENAI_API_KEY')).toBe(false)
      expect(isForbiddenMcpStdioEnvKey('path')).toBe(true)
    })

    it('findForbiddenMcpStdioEnvKeys returns all offending keys', () => {
      const env = {
        OPENAI_API_KEY: 'sk-ok',
        NODE_OPTIONS: '--require /tmp/evil.js',
        LD_PRELOAD: '/tmp/evil.so',
        MY_VAR: 'ok',
      }
      const hits = findForbiddenMcpStdioEnvKeys(env)
      expect(hits.sort()).toEqual(['LD_PRELOAD', 'NODE_OPTIONS'])
    })

    it('findForbiddenMcpStdioEnvKeys handles undefined env safely', () => {
      expect(findForbiddenMcpStdioEnvKeys(undefined)).toEqual([])
    })

    it('FORBIDDEN_MCP_STDIO_ENV_KEYS covers every runtime in the command allowlist', () => {
      // Smoke test: each runtime in the allowlist needs at least one
      // entry in the denylist (the loader-hook env var for that
      // runtime). If we add a new runtime (e.g. 'ruby') this test
      // reminds us to extend the denylist too.
      const keys = FORBIDDEN_MCP_STDIO_ENV_KEYS as readonly string[]
      expect(keys).toContain('NODE_OPTIONS')
      expect(keys).toContain('PYTHONSTARTUP')
      expect(keys).toContain('BUN_CONFIG_PRELOAD')
      expect(keys).toContain('DENO_DIR')
      expect(keys).toContain('LD_PRELOAD')
      expect(keys).toContain('PATH')
    })
  })

  // --- §3.10 P0 wave 3: pre-wave-2 mcpConnections env migration tolerance ---

  describe('sanitizeMcpConnectionsEnv (wave 3)', () => {
    it('returns input unchanged when mcpConnections is absent', () => {
      const r = sanitizeMcpConnectionsEnv(undefined)
      expect(r.sanitized).toBeUndefined()
      expect(r.stripped).toEqual([])
    })

    it('returns input unchanged when mcpConnections is not an array (defensive)', () => {
      const r = sanitizeMcpConnectionsEnv('not-an-array')
      expect(r.sanitized).toBe('not-an-array')
      expect(r.stripped).toEqual([])
    })

    it('preserves connections whose env is clean', () => {
      const input = [
        { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { OPENAI_API_KEY: 'sk-ok' } },
      ]
      const r = sanitizeMcpConnectionsEnv(input)
      expect(r.sanitized).toEqual(input)
      expect(r.stripped).toEqual([])
    })

    it('strips a single forbidden env key from one connection', () => {
      const input = [
        { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { PATH: '/tmp/evil:/usr/bin', OPENAI_API_KEY: 'sk-ok' } },
      ]
      const r = sanitizeMcpConnectionsEnv(input)
      expect(r.sanitized).toEqual([
        { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { OPENAI_API_KEY: 'sk-ok' } },
      ])
      expect(r.stripped).toEqual([{ id: 'c1', key: 'PATH' }])
    })

    it('preserves all non-env fields on sanitized connections', () => {
      const input = [{
        id: 'c1',
        name: 'My server',
        transport: 'stdio',
        command: 'node',
        args: ['./server.js', '--port=9000'],
        enabled: true,
        autoConnect: true,
        approvedSource: 'native-confirm',
        env: { NODE_OPTIONS: '--require /tmp/evil.js' },
      }]
      const r = sanitizeMcpConnectionsEnv(input) as { sanitized: unknown[]; stripped: unknown }
      const [conn] = r.sanitized as Array<Record<string, unknown>>
      expect(conn.id).toBe('c1')
      expect(conn.name).toBe('My server')
      expect(conn.transport).toBe('stdio')
      expect(conn.command).toBe('node')
      expect(conn.args).toEqual(['./server.js', '--port=9000'])
      expect(conn.enabled).toBe(true)
      expect(conn.autoConnect).toBe(true)
      expect(conn.approvedSource).toBe('native-confirm')
      expect(conn.env).toEqual({})
    })

    it('sanitizes multiple connections: mix of clean and dirty env', () => {
      const input = [
        { id: 'clean', name: 'clean', transport: 'sse', url: 'http://x', enabled: true, autoConnect: false },
        { id: 'dirty', name: 'dirty', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { NODE_OPTIONS: '--require /tmp/evil.js', USER_VAR: 'ok' } },
      ]
      const r = sanitizeMcpConnectionsEnv(input)
      const sanitized = r.sanitized as Array<Record<string, unknown>>
      // Clean connection: passed through unchanged (referentially equal).
      expect(sanitized[0]).toBe(input[0])
      // Dirty connection: env stripped.
      expect(sanitized[1].env).toEqual({ USER_VAR: 'ok' })
      expect(r.stripped).toEqual([{ id: 'dirty', key: 'NODE_OPTIONS' }])
    })

    it('case-insensitive: strips lowercase / camel-cased variants', () => {
      const input = [
        { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { node_options: '--require /evil.js', Path: '/tmp/evil', dyld_insert_libraries: '/tmp/evil.dylib' } },
      ]
      const r = sanitizeMcpConnectionsEnv(input)
      const sanitized = r.sanitized as Array<Record<string, unknown>>
      expect(sanitized[0].env).toEqual({})
      expect(r.stripped.map(s => s.key).sort()).toEqual(['Path', 'dyld_insert_libraries', 'node_options'])
    })

    it('records ids of all affected connections (for audit aggregation)', () => {
      const input = [
        { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { NODE_OPTIONS: 'a' } },
        { id: 'c2', name: 'c2', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { LD_PRELOAD: 'b' } },
        { id: 'c3', name: 'c3', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { NODE_OPTIONS: 'c', PATH: 'd' } },
      ]
      const r = sanitizeMcpConnectionsEnv(input)
      expect(r.stripped.length).toBe(4)
      const byId = r.stripped.reduce((acc, s) => {
        acc[s.id ?? ''] = (acc[s.id ?? ''] ?? 0) + 1
        return acc
      }, {} as Record<string, number>)
      expect(byId).toEqual({ c1: 1, c2: 1, c3: 2 })
    })

    it('tolerates connection without id (records undefined)', () => {
      const input = [
        { name: 'no-id', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { PATH: '/evil' } },
      ]
      const r = sanitizeMcpConnectionsEnv(input)
      expect(r.stripped).toEqual([{ id: undefined, key: 'PATH' }])
    })
  })

  describe('getSettings — wave-3 env denylist migration', () => {
    beforeEach(() => {
      __resetMcpEnvSanitizationAuditFlagForTest()
      setMcpEnvSanitizationListener(null)
    })

    it('loads cleanly when settings have no mcpConnections', () => {
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
      })
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)
      const s = getSettings()
      expect(s.theme).toBe('light')
      expect(listener).not.toHaveBeenCalled()
    })

    it('loads cleanly when mcpConnections env is already clean', () => {
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
        mcpConnections: [
          { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { OPENAI_API_KEY: 'sk-ok' } },
        ],
      })
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)
      const s = getSettings()
      expect(s.mcpConnections?.[0].env).toEqual({ OPENAI_API_KEY: 'sk-ok' })
      expect(listener).not.toHaveBeenCalled()
    })

    it('sanitizes forbidden env keys on load and fires the audit listener once', () => {
      // Pre-wave-2 record: NODE_OPTIONS was persisted before the denylist
      // existed. The wave-2 schema rejects it; wave-3 sanitizes and
      // re-parses rather than crashing at boot.
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
        mcpConnections: [
          { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { NODE_OPTIONS: '--require /tmp/evil.js', USER_VAR: 'ok' } },
        ],
      })
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)
      const s = getSettings()
      expect(s.mcpConnections?.[0].env).toEqual({ USER_VAR: 'ok' })
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({
        stripped: [{ id: 'c1', key: 'NODE_OPTIONS' }],
      })
    })

    it('audit listener fires at most once per launch even across successive getSettings calls', () => {
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
        mcpConnections: [
          { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { PATH: '/evil' } },
        ],
      })
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)

      getSettings() // first call → audit + persist
      // After persist, the stored record is clean. Second call takes the
      // success path without audit.
      getSettings()
      getSettings()

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('persists the sanitized record so next launch bypasses sanitization', () => {
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
        mcpConnections: [
          { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { LD_PRELOAD: '/tmp/evil.so' } },
        ],
      })

      getSettings()

      // Re-read the stored record: the LD_PRELOAD key must be gone.
      const persisted = storeData.get('settings') as { mcpConnections: Array<{ env: Record<string, string> }> }
      expect(persisted.mcpConnections[0].env).toEqual({})

      // Simulate a fresh launch: reset the flag, install a fresh listener,
      // verify that re-reading does NOT fire the listener (clean path).
      __resetMcpEnvSanitizationAuditFlagForTest()
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)
      getSettings()
      expect(listener).not.toHaveBeenCalled()
    })

    it('sanitizes multiple connections in a single record, aggregating audit in one event', () => {
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
        mcpConnections: [
          { id: 'a', name: 'a', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { NODE_OPTIONS: 'x' } },
          { id: 'b', name: 'b', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { OPENAI_API_KEY: 'ok' } },
          { id: 'c', name: 'c', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { PATH: '/evil', NODE_PATH: '/tmp' } },
        ],
      })
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)
      getSettings()
      expect(listener).toHaveBeenCalledTimes(1)
      const [evt] = listener.mock.calls[0] as [{ stripped: Array<{ id: string; key: string }> }]
      expect(evt.stripped.length).toBe(3)
      // All three offending entries aggregated into a single event.
      const keysById = evt.stripped.reduce((acc, s) => {
        acc[s.id] = (acc[s.id] ?? []).concat(s.key)
        return acc
      }, {} as Record<string, string[]>)
      expect(keysById.a).toEqual(['NODE_OPTIONS'])
      expect(keysById.c.sort()).toEqual(['NODE_PATH', 'PATH'])
      expect(keysById.b).toBeUndefined()
    })

    it('listener failure does not brick getSettings', () => {
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
        mcpConnections: [
          { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { NODE_OPTIONS: 'x' } },
        ],
      })
      setMcpEnvSanitizationListener(() => { throw new Error('audit pipeline boom') })
      // Must not throw — boot path tolerance.
      expect(() => getSettings()).not.toThrow()
      const s = getSettings()
      expect(s.mcpConnections?.[0].env).toEqual({})
    })

    it('case-insensitive sanitization: accepts Path, node_options, DYLD_INSERT_LIBRARIES', () => {
      storeData.set('settings', {
        theme: 'light',
        cacheDays: 30,
        mcpConnections: [
          { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { Path: '/evil', node_options: '--require', DYLD_INSERT_LIBRARIES: '/evil.dylib' } },
        ],
      })
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)
      const s = getSettings()
      expect(s.mcpConnections?.[0].env).toEqual({})
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('falls back to strict parse for non-env parse failures (other errors still surface)', () => {
      // Invalid theme — not something sanitization can rescue. Behaviour
      // should match pre-wave-3: parse throws, upstream falls back to
      // defaults via the `try { settingsSchema.parse(...) } catch`
      // pattern in migration code.
      storeData.set('settings', { theme: 'nonsense' })
      expect(() => getSettings()).toThrow()
    })

    it('sanitization does not mask unrelated errors when both are present', () => {
      // Record has both NODE_OPTIONS (sanitizable) AND invalid theme
      // (terminal). After env strip, the retry parse still fails on
      // theme. The terminal parse at the end should throw.
      storeData.set('settings', {
        theme: 'invalid-theme',
        cacheDays: 30,
        mcpConnections: [
          { id: 'c1', name: 'c1', transport: 'stdio', command: 'node', enabled: true, autoConnect: false, env: { NODE_OPTIONS: 'x' } },
        ],
      })
      const listener = vi.fn()
      setMcpEnvSanitizationListener(listener)
      expect(() => getSettings()).toThrow()
      // Listener must NOT fire when the retry parse still fails — we
      // only audit when sanitization actually rescued the record.
      expect(listener).not.toHaveBeenCalled()
    })
  })

  // --- Settings ---

  describe('Settings', () => {
    it('getSettings returns defaults without saved settings', () => {
      const settings = getSettings()
      expect(settings.theme).toBe('light')
      expect(settings.cacheDays).toBe(30)
      expect(settings.language).toBe('en')
      expect(settings.notificationsEnabled).toBe(true)
      expect(settings.groupConversations).toBe(true)
    })

    it('saveSettings/getSettings round-trip', () => {
      const s: Settings = {
        theme: 'dark',
        cacheDays: 7,
        language: 'ru',
        notificationsEnabled: false,
        imapIdleEnabled: false,
        draftSyncEnabled: false,
        groupConversations: false,
      }
      saveSettings(s)
      const loaded = getSettings()
      expect(loaded.theme).toBe('dark')
      expect(loaded.cacheDays).toBe(7)
      expect(loaded.language).toBe('ru')
      expect(loaded.notificationsEnabled).toBe(false)
      expect(loaded.groupConversations).toBe(false)
    })

    it('saveSettings with hiddenUnreadFolders', () => {
      const s: Settings = {
        theme: 'light',
        cacheDays: 30,
        language: 'en',
        notificationsEnabled: true,
        imapIdleEnabled: true,
        draftSyncEnabled: true,
        hiddenUnreadFolders: ['Trash', 'Junk'],
      }
      saveSettings(s)
      const loaded = getSettings()
      expect(loaded.hiddenUnreadFolders).toEqual(['Trash', 'Junk'])
    })

    it('saveSettings validates input (invalid theme)', () => {
      expect(() => saveSettings({
        theme: 'invalid' as 'light',
        cacheDays: 30,
        language: 'en',
        notificationsEnabled: true,
        imapIdleEnabled: true,
        draftSyncEnabled: true,
      })).toThrow()
    })

    it('saveAccount sets currentAccountId for the first account', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p' },
      })
      const settings = getSettings()
      expect(settings.currentAccountId).toBe(1)
    })

    it('deleteAccount updates currentAccountId', async () => {
      await saveAccount({
        imap: { host: 'imap1', port: 993, secure: true, user: 'a@test', pass: 'p' },
        smtp: { host: 'smtp1', port: 587, secure: false, user: 'a@test', pass: 'p' },
      })
      await saveAccount({
        imap: { host: 'imap2', port: 993, secure: true, user: 'b@test', pass: 'p' },
        smtp: { host: 'smtp2', port: 587, secure: false, user: 'b@test', pass: 'p' },
      })
      saveSettings({ ...getSettings(), currentAccountId: 1 })

      await deleteAccount(1)
      const settings = getSettings()
      // Should switch to the remaining account
      expect(settings.currentAccountId).toBe(2)
    })
  })

  // --- Provider abstraction migration (phase 2.1-A) ---

  describe('accountMetaSchema — provider migration preprocess', () => {
    it('(a) legacy password-shape JSON normalizes providerId/transportType', () => {
      storeData.set('accounts', [{
        id: 1,
        authType: 'password',
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
      }])
      const [acc] = listAccounts()
      expect(acc.authType).toBe('password')
      expect(acc.providerId).toBe('generic-imap')
      expect(acc.transportType).toBe('imap-smtp')
    })

    it('(a\') legacy record without authType at all falls back to generic-imap', () => {
      storeData.set('accounts', [{
        id: 1,
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
      }])
      const [acc] = listAccounts()
      expect(acc.providerId).toBe('generic-imap')
      expect(acc.transportType).toBe('imap-smtp')
    })

    it('(b) legacy google_oauth2-shape JSON normalizes to gmail / oauth2', () => {
      storeData.set('accounts', [{
        id: 1,
        authType: 'google_oauth2',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      const [acc] = listAccounts()
      expect(acc.authType).toBe('oauth2')
      expect(acc.providerId).toBe('gmail')
      expect(acc.transportType).toBe('imap-smtp')
    })

    it('(c) new-shape JSON with all three fields round-trips', () => {
      storeData.set('accounts', [{
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      const [acc] = listAccounts()
      expect(acc.authType).toBe('oauth2')
      expect(acc.providerId).toBe('gmail')
      expect(acc.transportType).toBe('imap-smtp')
    })

    it('(c\') canonical oauth2 WITHOUT providerId resolves to gmail (round-trip symmetric with write side)', () => {
      // Regression guard: earlier the read-side preprocess inferred
      // providerId='generic-imap' for `{authType:'oauth2'}` without a
      // providerId, while the write side inferred 'gmail'. A record that
      // arrived on the read side first (e.g. legacy settings.json loaded at
      // startup) would be mis-tagged as generic-imap. Both sides now
      // resolve to gmail, because the only OAuth2 provider shipped today
      // is Google. Microsoft OAuth2 (task 2.2) will extend this.
      storeData.set('accounts', [{
        id: 1,
        authType: 'oauth2',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      const [acc] = listAccounts()
      expect(acc.authType).toBe('oauth2')
      expect(acc.providerId).toBe('gmail')
      expect(acc.transportType).toBe('imap-smtp')
    })

    it('(d) mixed JSON with google_oauth2 + explicit providerId=gmail normalizes authType only', () => {
      storeData.set('accounts', [{
        id: 1,
        authType: 'google_oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      const [acc] = listAccounts()
      expect(acc.authType).toBe('oauth2')
      expect(acc.providerId).toBe('gmail')
      expect(acc.transportType).toBe('imap-smtp')
    })
  })

  describe('oauth keytar helpers', () => {
    it('(e) key functions return expected strings', () => {
      expect(oauthRefreshSecretKey('gmail', 1)).toBe('oauth-refresh:gmail:1')
      expect(oauthRefreshSecretKey('outlook', 42)).toBe('oauth-refresh:outlook:42')
      expect(legacyGoogleRefreshSecretKey(1)).toBe('google:refresh:1')
      expect(legacyGoogleRefreshSecretKey(42)).toBe('google:refresh:42')
    })

    it('(f) lookupOauthRefreshToken — new key takes precedence when both set', async () => {
      const store = new Map<string, string>([
        ['oauth-refresh:gmail:1', 'new-token'],
        ['google:refresh:1', 'legacy-token'],
      ])
      const getter: KeytarGetter = (_svc, key) => Promise.resolve(store.get(key) ?? null)
      expect(await lookupOauthRefreshToken('gmail', 1, getter)).toBe('new-token')
    })

    it('(f) lookupOauthRefreshToken — falls back to legacy when new key absent', async () => {
      const store = new Map<string, string>([
        ['google:refresh:1', 'legacy-token'],
      ])
      const getter: KeytarGetter = (_svc, key) => Promise.resolve(store.get(key) ?? null)
      expect(await lookupOauthRefreshToken('gmail', 1, getter)).toBe('legacy-token')
    })

    it('(f) lookupOauthRefreshToken — returns undefined when both absent', async () => {
      const getter: KeytarGetter = () => Promise.resolve(null)
      expect(await lookupOauthRefreshToken('gmail', 1, getter)).toBeUndefined()
    })

    it('(f) lookupOauthRefreshToken — survives thrown error from new-key read and still tries legacy', async () => {
      const getter: KeytarGetter = (_svc, key) => {
        if (key === 'oauth-refresh:gmail:1') return Promise.reject(new Error('keytar backend unavailable'))
        if (key === 'google:refresh:1') return Promise.resolve('legacy-token')
        return Promise.resolve(null)
      }
      expect(await lookupOauthRefreshToken('gmail', 1, getter)).toBe('legacy-token')
    })
  })

  // --- Provider abstraction — write-side schema ---

  describe('accountSaveSchema — write-side provider migration', () => {
    it('(g) rejects legacy google_oauth2 literal in incoming payload', async () => {
      // After 2.1-D cleanup, the write-side schema accepts the canonical
      // two-member union only. The legacy literal survives only as a read-side
      // safety net for stored electron-store records; any incoming IPC payload
      // that still uses it must be rejected at parse time.
      await expect(saveAccount({
        authType: 'google_oauth2',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).rejects.toThrow()

      expect(() => accountSaveSchema.parse({
        authType: 'google_oauth2',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).toThrow()
    })

    // (g-defensive) Schema must consistently reject malformed / non-string
    // authType values instead of silently coercing them. This is a
    // regression guard: if zod ever changes its coercion behaviour or a
    // future refactor accidentally loosens the enum, these cases pin the
    // rejection contract.
    it.each([
      { label: 'null', value: null },
      { label: 'number 0', value: 0 },
      { label: 'object', value: { malicious: true } },
      { label: 'empty string', value: '' },
      { label: 'case mismatch OAUTH2', value: 'OAUTH2' },
      { label: 'bogus literal', value: 'bearer' },
    ])('(g-defensive) accountSaveSchema rejects authType=$label', ({ value }) => {
      expect(() => accountSaveSchema.parse({
        authType: value,
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).toThrow()
    })

    it('(g-defensive) accountSaveSchema allows undefined authType (treated as password by normalize step)', () => {
      // Undefined is the one non-string value that must NOT throw: the
      // field is optional on the schema and the downstream normalize step
      // defaults it to 'password'. Documented here so future tightening
      // does not break legacy password-only payloads.
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p' },
      })).not.toThrow()
    })

    // (g-refine-*) OAuth providerId allowlist refine. Write-side must
    // reject oauth2 + unknown providerId. Gmail and Outlook are supported;
    // generic-imap and unknown providers are rejected.
    it('(g-refine-accept-outlook) accepts oauth2 + providerId=outlook', () => {
      expect(() => accountSaveSchema.parse({
        authType: 'oauth2',
        providerId: 'outlook',
        imap: { host: 'imap.outlook.com', port: 993, secure: true, user: 'a@outlook.com' },
        smtp: { host: 'smtp.outlook.com', port: 587, secure: false, user: 'a@outlook.com' },
      })).not.toThrow()
    })

    it('(g-refine-reject-unknown-provider) rejects oauth2 + unknown providerId', () => {
      expect(() => accountSaveSchema.parse({
        authType: 'oauth2',
        providerId: 'some-unknown',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com' },
      } as Parameters<typeof accountSaveSchema.parse>[0])).toThrow()
    })

    it('(g-refine-reject-generic) rejects oauth2 + providerId=generic-imap', () => {
      expect(() => accountSaveSchema.parse({
        authType: 'oauth2',
        providerId: 'generic-imap',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com' },
      })).toThrow(/providerId/i)
    })

    it('(g-refine-accept-gmail) accepts oauth2 + providerId=gmail', () => {
      expect(() => accountSaveSchema.parse({
        authType: 'oauth2',
        providerId: 'gmail',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).not.toThrow()
    })

    it('(g-refine-accept-undefined) accepts oauth2 with omitted providerId (normalize fills in gmail)', () => {
      // Legacy shape the renderer may still occasionally emit: authType
      // only, providerId undefined. normalizeAccountSavePayload defaults
      // it to 'gmail', so the refine must allow this shape through.
      expect(() => accountSaveSchema.parse({
        authType: 'oauth2',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).not.toThrow()
    })

    it('(g-refine-password-unaffected) password + providerId=generic-imap still accepted', () => {
      // Sanity: the refine is scoped to authType === 'oauth2' only.
      expect(() => accountSaveSchema.parse({
        authType: 'password',
        providerId: 'generic-imap',
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p' },
      })).not.toThrow()
    })

    it('(g-refine-saveAccount-accept-outlook) saveAccount surface accepts oauth2 + providerId=outlook', async () => {
      // oauth2 + outlook is now a supported combination.
      const { id } = await saveAccount({
        authType: 'oauth2',
        providerId: 'outlook',
        imap: { host: 'imap.outlook.com', port: 993, secure: true, user: 'a@outlook.com' },
        smtp: { host: 'smtp.outlook.com', port: 587, secure: false, user: 'a@outlook.com' },
      })
      expect(id).toBeGreaterThan(0)
      const raw = storeData.get('accounts') as Array<Record<string, unknown>>
      expect(raw[raw.length - 1].authType).toBe('oauth2')
      expect(raw[raw.length - 1].providerId).toBe('outlook')
    })

    it('(g-refine-merge-bypass-unknown) saveAccount rejects omitted-authType update that smuggles an unknown providerId into an existing oauth2 account', async () => {
      // Attack path: a compromised renderer omits `authType` on an
      // update payload and sets an unknown providerId. The refine short-
      // circuits on undefined authType, but the post-merge invariant
      // check catches the effective pair {oauth2, unknown-provider}.
      storeData.set('accounts', [{
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      keytarStore.set('oauth-refresh:gmail:1', 'legit-refresh-token')

      // providerId enum rejects unknown values at the schema level
      expect(() => accountSaveSchema.parse({
        id: 1,
        providerId: 'some-unknown',
        imap: { host: 'imap.evil.com', port: 993, secure: true, user: 'a@evil.com' },
        smtp: { host: 'smtp.evil.com', port: 587, secure: false, user: 'a@evil.com' },
      })).toThrow()

      // Store must remain on the canonical record — no partial mutation.
      const raw = storeData.get('accounts') as Array<Record<string, unknown>>
      expect(raw).toHaveLength(1)
      expect(raw[0].authType).toBe('oauth2')
      expect(raw[0].providerId).toBe('gmail')
      expect((raw[0].imap as Record<string, unknown>).host).toBe('imap.gmail.com')
    })

    it('(g-refine-merge-omit-all) saveAccount accepts an update that omits both authType and providerId on an existing oauth2 account', async () => {
      // Sanity: the post-merge invariant check must not penalize a
      // legitimate re-save that only updates unrelated fields (e.g. the
      // display name). The effective merged pair stays {oauth2, gmail},
      // which is allowed.
      storeData.set('accounts', [{
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      keytarStore.set('oauth-refresh:gmail:1', 'legit-refresh-token')

      await expect(saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).resolves.toEqual({ id: 1 })

      const raw = storeData.get('accounts') as Array<Record<string, unknown>>
      expect(raw[0].authType).toBe('oauth2')
      expect(raw[0].providerId).toBe('gmail')
      expect(raw[0].name).toBe('Alice')
    })

    it('(g-refine-merge-explicit-oauth2-outlook) saveAccount accepts explicit oauth2+outlook update against an existing oauth2 account', async () => {
      // With outlook now in the allowlist, an explicit oauth2+outlook
      // update is a legitimate operation (e.g. re-linking to a different
      // provider). Both refine and post-merge check accept this combo.
      storeData.set('accounts', [{
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      keytarStore.set('oauth-refresh:gmail:1', 'legit-refresh-token')

      await expect(saveAccount({
        id: 1,
        authType: 'oauth2',
        providerId: 'outlook',
        imap: { host: 'imap.outlook.com', port: 993, secure: true, user: 'a@outlook.com' },
        smtp: { host: 'smtp.outlook.com', port: 587, secure: false, user: 'a@outlook.com' },
      })).resolves.toEqual({ id: 1 })

      const raw = storeData.get('accounts') as Array<Record<string, unknown>>
      expect(raw[0].providerId).toBe('outlook')
    })

    it('(h) accepts new-shape oauth2 payload as-is', async () => {
      await saveAccount({
        authType: 'oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })
      const raw = storeData.get('accounts') as Array<Record<string, unknown>>
      expect(raw).toHaveLength(1)
      expect(raw[0].authType).toBe('oauth2')
      expect(raw[0].providerId).toBe('gmail')
      expect(raw[0].transportType).toBe('imap-smtp')
    })

    it('(i) password-shape payload persists with generic-imap provider', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p' },
      })
      const raw = storeData.get('accounts') as Array<Record<string, unknown>>
      expect(raw[0].authType).toBe('password')
      expect(raw[0].providerId).toBe('generic-imap')
      expect(raw[0].transportType).toBe('imap-smtp')
    })

    it('(j) saveAccount switching oauth2 -> password triggers refresh token cleanup (read-side legacy literal in store)', async () => {
      // Seed: existing oauth account stored with the legacy 'google_oauth2'
      // literal (pre-migration on-disk record). The read-side preprocess
      // normalizes it to 'oauth2' on load, so the cleanup branch in
      // saveAccount sees the canonical value and wipes both the new and the
      // legacy keytar keys.
      storeData.set('accounts', [{
        id: 1,
        authType: 'google_oauth2',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      keytarStore.set('oauth-refresh:gmail:1', 'new-refresh')
      keytarStore.set('google:refresh:1', 'legacy-refresh')

      // Save with password auth — should wipe both new and legacy keys.
      await saveAccount({
        id: 1,
        authType: 'password',
        imap: { host: 'imap.new', port: 993, secure: true, user: 'a@new', pass: 'p' },
        smtp: { host: 'smtp.new', port: 587, secure: false, user: 'a@new', pass: 'p' },
      })
      expect(keytarStore.get('oauth-refresh:gmail:1')).toBeUndefined()
      expect(keytarStore.get('google:refresh:1')).toBeUndefined()
    })

    it('(k-guard-attack) saveAccount rejects password->oauth transition with no keytar refresh token', async () => {
      // Attack path: a compromised renderer crafts a save payload that
      // flips an existing password account to oauth2 without going
      // through oauth:google:connect first. The IPC trust gap guard in
      // saveAccount must refuse because no refresh token exists in
      // keytar for this account id.
      storeData.set('accounts', [{
        id: 1,
        authType: 'password',
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
      }])
      // keytarStore is empty for account #1.

      await expect(saveAccount({
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).rejects.toThrow(/OAuth account save requires a completed OAuth flow/)
    })

    it('(k-guard-legit) saveAccount accepts password->oauth transition when keytar already has refresh token', async () => {
      // Legitimate path: oauth:google:connect writes the refresh token
      // to keytar BEFORE calling saveAccount for the transition case
      // (see electron/main.ts ordering). With the token planted, the
      // guard lets the save through.
      storeData.set('accounts', [{
        id: 1,
        authType: 'password',
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
      }])
      keytarStore.set('oauth-refresh:gmail:1', 'legitimate-refresh-token')

      await expect(saveAccount({
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).resolves.toEqual({ id: 1 })
    })

    it('(k-guard-new-account) saveAccount allows brand-new OAuth account without pre-existing keytar token', async () => {
      // New-account path: no existing record, so the guard is a no-op.
      // The new-account creation flow in oauth:google:connect writes the
      // refresh token to keytar AFTER saveAccount returns with the
      // assigned id.
      await expect(saveAccount({
        authType: 'oauth2',
        providerId: 'gmail',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).resolves.toEqual({ id: 1 })
    })

    it('(k-guard-resave) saveAccount allows re-save of an already-OAuth account without keytar check', async () => {
      storeData.set('accounts', [{
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      // keytarStore intentionally empty — the existing record is already
      // in OAuth state, so the guard must not re-check keytar on a plain
      // re-save (e.g. UI updating display name).
      await expect(saveAccount({
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        name: 'Alice',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      })).resolves.toEqual({ id: 1 })
    })

    it('(k) saveAccount switching canonical oauth2 -> password also triggers cleanup', async () => {
      storeData.set('accounts', [{
        id: 1,
        authType: 'oauth2',
        providerId: 'gmail',
        transportType: 'imap-smtp',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
      }])
      keytarStore.set('oauth-refresh:gmail:1', 'new-refresh')

      await saveAccount({
        id: 1,
        authType: 'password',
        imap: { host: 'imap.new', port: 993, secure: true, user: 'a@new', pass: 'p' },
        smtp: { host: 'smtp.new', port: 587, secure: false, user: 'a@new', pass: 'p' },
      })
      expect(keytarStore.get('oauth-refresh:gmail:1')).toBeUndefined()
    })
  })

  describe('oauth keytar writers', () => {
    it('(l) setOauthRefreshToken writes to the new key', async () => {
      await setOauthRefreshToken('gmail', 7, 'tok-7')
      expect(keytarStore.get('oauth-refresh:gmail:7')).toBe('tok-7')
      expect(keytarStore.get('google:refresh:7')).toBeUndefined()
    })

    it('(l) setOauthRefreshToken with null deletes the new key', async () => {
      keytarStore.set('oauth-refresh:gmail:7', 'tok-7')
      await setOauthRefreshToken('gmail', 7, null)
      expect(keytarStore.get('oauth-refresh:gmail:7')).toBeUndefined()
    })

    it('(l) setOauthRefreshToken with empty string also deletes', async () => {
      keytarStore.set('oauth-refresh:gmail:7', 'tok-7')
      await setOauthRefreshToken('gmail', 7, '')
      expect(keytarStore.get('oauth-refresh:gmail:7')).toBeUndefined()
    })

    it('(m) getOauthRefreshToken reads new key when present', async () => {
      keytarStore.set('oauth-refresh:gmail:3', 'new')
      expect(await getOauthRefreshToken('gmail', 3)).toBe('new')
    })

    it('(m) getOauthRefreshToken falls back to legacy', async () => {
      keytarStore.set('google:refresh:3', 'legacy')
      expect(await getOauthRefreshToken('gmail', 3)).toBe('legacy')
    })

    it('(m) getOauthRefreshToken returns null when absent', async () => {
      expect(await getOauthRefreshToken('gmail', 3)).toBeNull()
    })

    it('(n) getOauthRefreshTokenWithSource reports source=new', async () => {
      keytarStore.set('oauth-refresh:gmail:3', 'new')
      const found = await getOauthRefreshTokenWithSource('gmail', 3)
      expect(found).toEqual({ token: 'new', source: 'new' })
    })

    it('(n) getOauthRefreshTokenWithSource reports source=legacy', async () => {
      keytarStore.set('google:refresh:3', 'legacy')
      const found = await getOauthRefreshTokenWithSource('gmail', 3)
      expect(found).toEqual({ token: 'legacy', source: 'legacy' })
    })

    it('(n) getOauthRefreshTokenWithSource returns null when absent', async () => {
      expect(await getOauthRefreshTokenWithSource('gmail', 3)).toBeNull()
    })

    it('(o) deleteLegacyGoogleRefreshToken deletes ONLY the legacy key', async () => {
      keytarStore.set('oauth-refresh:gmail:5', 'new')
      keytarStore.set('google:refresh:5', 'legacy')
      await deleteLegacyGoogleRefreshToken(5)
      expect(keytarStore.get('google:refresh:5')).toBeUndefined()
      expect(keytarStore.get('oauth-refresh:gmail:5')).toBe('new')
    })

    it('(p) lookupOauthRefreshTokenWithSource via injected getter — source=new', async () => {
      const store = new Map<string, string>([['oauth-refresh:outlook:1', 'tok']])
      const getter: KeytarGetter = (_svc, key) => Promise.resolve(store.get(key) ?? null)
      expect(await lookupOauthRefreshTokenWithSource('outlook', 1, getter)).toEqual({ token: 'tok', source: 'new' })
    })

    it('(p) lookupOauthRefreshTokenWithSource via injected getter — source=legacy', async () => {
      const store = new Map<string, string>([['google:refresh:1', 'tok']])
      const getter: KeytarGetter = (_svc, key) => Promise.resolve(store.get(key) ?? null)
      expect(await lookupOauthRefreshTokenWithSource('gmail', 1, getter)).toEqual({ token: 'tok', source: 'legacy' })
    })
  })

  // --- Multi-identity (phase 2.3-A) ---

  describe('identitySchema (strict write-side)', () => {
    it('accepts a valid identity', () => {
      const result = identitySchema.parse({
        id: 'id-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        signature: 'Best,\nAlice',
        defaultBcc: 'archive@example.com',
        isDefault: true,
      })
      expect(result.displayName).toBe('Alice')
      expect(result.isDefault).toBe(true)
    })

    it('rejects empty displayName', () => {
      expect(() => identitySchema.parse({
        id: 'id-1', displayName: '', email: 'alice@example.com', isDefault: true,
      })).toThrow()
    })

    it('rejects non-email email', () => {
      expect(() => identitySchema.parse({
        id: 'id-1', displayName: 'Alice', email: 'not-an-email', isDefault: true,
      })).toThrow()
    })

    it('rejects empty id', () => {
      expect(() => identitySchema.parse({
        id: '', displayName: 'Alice', email: 'alice@example.com', isDefault: true,
      })).toThrow()
    })

    // 2.3 wave 4: empty-string defaultBcc is the explicit "clear" sentinel
    // emitted by the Identities tab; `.min(1)` in the previous wave rejected
    // it and failed `accounts:save`, locking users out of clearing the field.
    it('accepts empty-string defaultBcc as explicit clear sentinel', () => {
      const result = identitySchema.parse({
        id: 'id-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        defaultBcc: '',
        isDefault: true,
      })
      expect(result.defaultBcc).toBe('')
    })

    it('normalizes whitespace-only defaultBcc to empty string via trim()', () => {
      const result = identitySchema.parse({
        id: 'id-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        defaultBcc: '   ',
        isDefault: true,
      })
      // Trim runs before .optional(); whitespace-only collapses to '',
      // which is then the canonical "cleared" state (consistent with how
      // displayName/email trim their leading/trailing whitespace).
      expect(result.defaultBcc).toBe('')
    })

    it('preserves a valid defaultBcc address verbatim', () => {
      const result = identitySchema.parse({
        id: 'id-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        defaultBcc: 'archive@example.com',
        isDefault: true,
      })
      expect(result.defaultBcc).toBe('archive@example.com')
    })

    it('accepts identity without defaultBcc (undefined — field optional)', () => {
      const result = identitySchema.parse({
        id: 'id-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        isDefault: true,
      })
      expect(result.defaultBcc).toBeUndefined()
    })
  })

  describe('identitiesArraySchema — invariants', () => {
    it('accepts a single default identity', () => {
      expect(() => identitiesArraySchema.parse([{
        id: 'id-1', displayName: 'Alice', email: 'alice@example.com', isDefault: true,
      }])).not.toThrow()
    })

    it('rejects empty array', () => {
      expect(() => identitiesArraySchema.parse([])).toThrow(/at least one identity/)
    })

    it('rejects array with zero defaults', () => {
      expect(() => identitiesArraySchema.parse([{
        id: 'id-1', displayName: 'Alice', email: 'alice@example.com', isDefault: false,
      }])).toThrow(/exactly one identity must have isDefault/)
    })

    it('rejects array with two defaults', () => {
      expect(() => identitiesArraySchema.parse([
        { id: 'id-1', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        { id: 'id-2', displayName: 'Bob', email: 'bob@example.com', isDefault: true },
      ])).toThrow(/exactly one identity must have isDefault/)
    })

    it('rejects duplicate ids', () => {
      expect(() => identitiesArraySchema.parse([
        { id: 'dup', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        { id: 'dup', displayName: 'Bob', email: 'bob@example.com', isDefault: false },
      ])).toThrow(/unique/)
    })

    it('accepts two identities with different ids and one default', () => {
      expect(() => identitiesArraySchema.parse([
        { id: 'id-1', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        { id: 'id-2', displayName: 'Alias', email: 'alias@example.com', isDefault: false },
      ])).not.toThrow()
    })
  })

  describe('normalizeIdentities', () => {
    it('fills in missing ids with UUIDs', () => {
      const result = normalizeIdentities([
        { displayName: 'Alice', email: 'alice@example.com', isDefault: true },
      ])
      expect(result[0].id).toMatch(/^[0-9a-f-]{36}$/i)
    })

    it('preserves provided UUID ids', () => {
      const result = normalizeIdentities([
        { id: UUID_STABLE, displayName: 'Alice', email: 'alice@example.com', isDefault: true },
      ])
      expect(result[0].id).toBe(UUID_STABLE)
    })

    it('rejects non-UUID ids (M1: renderer cannot forge id)', () => {
      expect(() => normalizeIdentities([
        { id: 'custom-id-forged', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
      ])).toThrow(/UUID/)
    })

    it('throws on invariant violation after id synthesis', () => {
      expect(() => normalizeIdentities([
        { displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        { displayName: 'Bob', email: 'bob@example.com', isDefault: true },
      ])).toThrow(/exactly one identity/)
    })
  })

  describe('accountMetaSchema — identities migration on read', () => {
    it('synthesizes default identity from legacy name/email/signature', () => {
      storeData.set('accounts', [{
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        signature: 'Best,\nAlice',
        authType: 'password',
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
      }])
      const [acc] = listAccounts()
      expect(acc.identities).toHaveLength(1)
      expect(acc.identities[0]).toMatchObject({
        displayName: 'Alice',
        email: 'alice@example.com',
        signature: 'Best,\nAlice',
        isDefault: true,
      })
      expect(acc.identities[0].id).toMatch(/^[0-9a-f-]{36}$/i)
      // Legacy signature must still be exposed for one release cycle so
      // Compose / Settings / AI send helpers keep working while wave 2
      // migrates them to the identity selector.
      expect(acc.signature).toBe('Best,\nAlice')
    })

    it('falls back to email local-part when legacy name is absent', () => {
      storeData.set('accounts', [{
        id: 1,
        email: 'alice@example.com',
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
      }])
      const [acc] = listAccounts()
      expect(acc.identities).toHaveLength(1)
      expect(acc.identities[0].displayName).toBe('alice')
      expect(acc.identities[0].email).toBe('alice@example.com')
    })

    it('falls back to smtp.user when top-level email is absent', () => {
      storeData.set('accounts', [{
        id: 1,
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
      }])
      const [acc] = listAccounts()
      // smtp.user is the email-format fallback (see imapSchema: user is just a
      // non-empty string, so real bare usernames are possible; tests cover
      // the happy path where user IS an email).
      expect(acc.identities[0].email).toBe('alice@example.com')
    })

    it('preserves existing identities[] when present in stored record', () => {
      storeData.set('accounts', [{
        id: 1,
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
        identities: [
          { id: 'id-primary', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
          { id: 'id-alias', displayName: 'Alice Alias', email: 'alias@example.com', isDefault: false },
        ],
      }])
      const [acc] = listAccounts()
      expect(acc.identities).toHaveLength(2)
      expect(acc.identities[0].id).toBe('id-primary')
      expect(acc.identities[1].id).toBe('id-alias')
      expect(acc.identities[1].isDefault).toBe(false)
    })

    it('rejects stored record with corrupted identities (zero defaults) rather than silently repairing', () => {
      storeData.set('accounts', [{
        id: 1,
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
        identities: [
          { id: 'id-1', displayName: 'Alice', email: 'alice@example.com', isDefault: false },
        ],
      }])
      // Corrupted record is dropped by listAccounts (safeParse fails).
      expect(listAccounts()).toEqual([])
    })

    it('rejects stored record with empty identities[] array', () => {
      storeData.set('accounts', [{
        id: 1,
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
        identities: [],
      }])
      // Identities present but empty must not silently re-synthesize — the
      // UI has no reason to emit an empty array, and accepting it would mask
      // a bug in the caller. Corrupted record is dropped.
      expect(listAccounts()).toEqual([])
    })

    it('read-side schema is permissive on email (bare username tolerated for legacy migration)', () => {
      // A pre-2.3-A record where smtp.user is a bare username (not email
      // format) would synthesize an identity with a non-email email. The
      // permissive read-side schema accepts it so the user is not locked
      // out; the write side will enforce strictness on the next save.
      storeData.set('accounts', [{
        id: 1,
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice' },
      }])
      const [acc] = listAccounts()
      expect(acc.identities).toHaveLength(1)
      expect(acc.identities[0].email).toBe('alice')
    })
  })

  describe('accountSaveSchema — identities on write path', () => {
    it('accepts payload with explicit identities[]', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })).not.toThrow()
    })

    it('rejects forged non-UUID id on incoming payload (M1)', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { id: 'custom-id-forged', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })).toThrow(/UUID|uuid/)
    })

    it('accepts payload where identities[] use crypto.randomUUID() values', async () => {
      const { randomUUID } = await import('node:crypto')
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { id: randomUUID(), displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })).not.toThrow()
    })

    it('accepts payload where identities[] omit ids (UUIDs filled in by normalizeIdentities)', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })).not.toThrow()
    })

    it('rejects payload with zero defaults in identities[]', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { id: 'id-1', displayName: 'Alice', email: 'alice@example.com', isDefault: false },
        ],
      })).toThrow(/identities/)
    })

    it('rejects payload with two defaults in identities[]', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { id: 'id-1', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
          { id: 'id-2', displayName: 'Alice Alias', email: 'alias@example.com', isDefault: true },
        ],
      })).toThrow(/identities/)
    })

    it('rejects payload with duplicate ids in identities[]', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { id: UUID_DUP, displayName: 'Alice', email: 'alice@example.com', isDefault: true },
          { id: UUID_DUP, displayName: 'Alias', email: 'alias@example.com', isDefault: false },
        ],
      })).toThrow(/identities/)
    })

    it('rejects payload with empty identities[] array', () => {
      expect(() => accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [],
      })).toThrow()
    })

    // 2.3 wave 4: empty-string defaultBcc must survive the IPC schema — wave 3
    // renderer forwards it verbatim as the "clear" sentinel; wave-3 regression
    // was `defaultBcc: z.string().trim().min(1)` rejecting it and failing the
    // entire accounts:save. Guard the contract at the schema layer so a future
    // refactor cannot re-introduce `.min(1)` without a test failure.
    it('accepts empty-string defaultBcc on identities[] (wave-3 clear signal)', () => {
      const result = accountSaveSchema.parse({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'a@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'a@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', defaultBcc: '', isDefault: true },
        ],
      })
      expect(result.identities?.[0].defaultBcc).toBe('')
    })
  })

  describe('saveAccount — identities round-trip', () => {
    it('new account without identities[] synthesizes a single default identity', async () => {
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        signature: 'Best,\nAlice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
      })
      const meta = getAccountMeta(1)
      expect(meta?.identities).toHaveLength(1)
      expect(meta?.identities[0]).toMatchObject({
        displayName: 'Alice',
        email: 'alice@example.com',
        signature: 'Best,\nAlice',
        isDefault: true,
      })
      expect(meta?.identities[0].id).toMatch(/^[0-9a-f-]{36}$/i)
      // Legacy signature field still populated for backward compat.
      expect(meta?.signature).toBe('Best,\nAlice')
    })

    it('new account with explicit identities[] persists them verbatim (ids stable)', async () => {
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'Primary sig', isDefault: true },
          { id: UUID_ALIAS, displayName: 'Alice Alias', email: 'alias@example.com', signature: 'Alias sig', defaultBcc: 'archive@example.com', isDefault: false },
        ],
      })
      const meta = getAccountMeta(1)
      expect(meta?.identities).toHaveLength(2)
      expect(meta?.identities[0].id).toBe(UUID_PRIMARY)
      expect(meta?.identities[1].id).toBe(UUID_ALIAS)
      expect(meta?.identities[1].defaultBcc).toBe('archive@example.com')
    })

    it('re-save without identities[] preserves existing identities (ids stable across saves)', async () => {
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', isDefault: true },
          { id: UUID_ALIAS, displayName: 'Alice Alias', email: 'alias@example.com', isDefault: false },
        ],
      })
      const before = getAccountMeta(1)
      expect(before?.identities.map(i => i.id)).toEqual([UUID_PRIMARY, UUID_ALIAS])

      // Re-save changing only unrelated avatar settings — identities must not churn.
      await saveAccount({
        id: 1,
        name: 'Alice',
        avatarMode: 'icon',
        avatarIcon: 'star',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
      })
      const after = getAccountMeta(1)
      expect(after?.identities.map(i => i.id)).toEqual([UUID_PRIMARY, UUID_ALIAS])
      expect(after?.avatarIcon).toBe('star')
    })

    it('re-save with new identities[] replaces the list', async () => {
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })

      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_NEW_DEFAULT, displayName: 'Alice (New)', email: 'alice@example.com', isDefault: true },
          { id: UUID_ALIAS, displayName: 'Alias', email: 'alias@example.com', isDefault: false },
        ],
      })
      const meta = getAccountMeta(1)
      expect(meta?.identities.map(i => i.id)).toEqual([UUID_NEW_DEFAULT, UUID_ALIAS])
      expect(meta?.identities[0].displayName).toBe('Alice (New)')
    })

    it('legacy signature field reflects the default identity signature after save', async () => {
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'From identity', isDefault: true },
          { id: UUID_ALIAS, displayName: 'Alias', email: 'alias@example.com', signature: 'Alias sig', isDefault: false },
        ],
      })
      const meta = getAccountMeta(1)
      // Backward-compat: legacy readers (Compose, Settings → Signature, AI
      // send helpers) continue to see meta.signature; it's wired to the
      // default identity's signature so re-saves through the identity
      // editor propagate correctly.
      expect(meta?.signature).toBe('From identity')
    })

    it('brand-new account without name/email/signature falls back to smtp.user for identity email', async () => {
      // Coverage gap: saveAccount merge branch (3) — new account with no
      // explicit identities AND no legacy top-level name/email/signature.
      // The synthesized identity must still validate (non-empty displayName +
      // email), using smtp.user as the email fallback and the local-part as
      // displayName.
      await saveAccount({
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'bob@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'bob@example.com', pass: 'p' },
      })
      const meta = getAccountMeta(1)
      expect(meta?.identities).toHaveLength(1)
      expect(meta?.identities[0].email).toBe('bob@example.com')
      expect(meta?.identities[0].displayName).toBe('bob') // email local-part
      expect(meta?.identities[0].isDefault).toBe(true)
      // Signature is undefined (no legacy signature supplied), NOT empty string.
      expect(meta?.identities[0].signature).toBeUndefined()
    })

    it('loading a legacy OAuth2 record synthesizes a default identity alongside authType normalization', async () => {
      // Coverage gap: read-side migration on a legacy google_oauth2 record
      // (no identities[]) — synthesis must run regardless of authType, and
      // the record must still land with canonical authType='oauth2' +
      // providerId='gmail' after preprocess.
      storeData.set('accounts', [{
        id: 1,
        name: 'Alice',
        email: 'alice@gmail.com',
        authType: 'google_oauth2',
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'alice@gmail.com' },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'alice@gmail.com' },
      }])
      const [acc] = listAccounts()
      expect(acc.authType).toBe('oauth2')
      expect(acc.providerId).toBe('gmail')
      expect(acc.identities).toHaveLength(1)
      expect(acc.identities[0]).toMatchObject({
        displayName: 'Alice',
        email: 'alice@gmail.com',
        isDefault: true,
      })
    })

    // 2.3 wave 4: clearing defaultBcc via the Identities tab must round-trip.
    // Renderer (wave 3) sends `defaultBcc: ''` explicitly; schema (wave 4)
    // must accept and persist it so the cleared state survives listAccounts().
    it('round-trips defaultBcc clear (empty string) through save + reload', async () => {
      // First save: identity with a populated defaultBcc.
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          {
            id: UUID_PRIMARY,
            displayName: 'Alice',
            email: 'alice@example.com',
            defaultBcc: 'archive@example.com',
            isDefault: true,
          },
        ],
      })
      expect(getAccountMeta(1)?.identities[0].defaultBcc).toBe('archive@example.com')

      // Re-save with defaultBcc cleared (empty string as the clear sentinel).
      await saveAccount({
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          {
            id: UUID_PRIMARY,
            displayName: 'Alice',
            email: 'alice@example.com',
            defaultBcc: '',
            isDefault: true,
          },
        ],
      })
      const after = getAccountMeta(1)
      // Empty string persisted verbatim — NOT coerced back to
      // 'archive@example.com' or dropped to undefined. The distinction
      // matters for the Compose Bcc-sync hook: undefined means "no default",
      // '' means "user explicitly cleared it" (same intent in practice, but
      // the write path must not silently resurrect the prior value).
      expect(after?.identities[0].defaultBcc).toBe('')
    })

    it('loading a legacy record then saving without identities[] upgrades the on-disk record', async () => {
      // Pre-2.3-A on-disk record: no identities field.
      storeData.set('accounts', [{
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        signature: 'Best,\nAlice',
        authType: 'password',
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
      }])

      // listAccounts synthesizes a default identity (read-side migration).
      const before = getAccountMeta(1)
      expect(before?.identities).toHaveLength(1)
      const synthId = before!.identities[0].id

      // Re-save without explicitly touching identities — merge branch (2)
      // reuses the just-synthesized identities from listAccounts(), so the
      // id stays stable and the on-disk record is upgraded in-place.
      await saveAccount({
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
      })

      const raw = storeData.get('accounts') as Array<Record<string, unknown>>
      expect(Array.isArray(raw[0].identities)).toBe(true)
      expect((raw[0].identities as Array<{ id: string }>)[0].id).toBe(synthId)
    })
  })

  // --- BLOCKER: legacy Signature tab propagates into default identity (2.3 re-review) ---

  describe('saveAccount — legacy signature propagation (BLOCKER)', () => {
    it('legacy signature write with no identities[] overwrites the default identity signature', async () => {
      // Existing account has default identity with signature "A".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'A', isDefault: true },
        ],
      })
      expect(getAccountMeta(1)?.identities[0].signature).toBe('A')

      // Legacy Signature tab save: carries `signature: "B"` with no identities[].
      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        signature: 'B',
      })

      const meta = getAccountMeta(1)
      // Default identity signature must reflect the legacy write, not the stale "A".
      expect(meta?.identities[0].signature).toBe('B')
      expect(meta?.identities[0].id).toBe(UUID_PRIMARY) // id stable
      // Legacy signature field mirrors the default identity signature.
      expect(meta?.signature).toBe('B')
    })

    it('identities[] wins over legacy signature when both are submitted', async () => {
      // Existing account has default identity with signature "A".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'A', isDefault: true },
        ],
      })

      // Save with BOTH identities:[{signature:"X"}] AND legacy signature:"Y".
      // identities[] is the settled state from the Identities tab — it must win.
      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        signature: 'Y',
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'X', isDefault: true },
        ],
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities[0].signature).toBe('X')
      // Legacy signature field mirrors the default identity's signature ("X"), NOT the
      // top-level legacy field ("Y"). Semantic source of truth is the identity.
      expect(meta?.signature).toBe('X')
    })

    it('empty-string signature is preserved as explicit clear (distinct from undefined)', async () => {
      // Existing account has default identity with signature "A".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'A', isDefault: true },
        ],
      })

      // User opens legacy Signature tab, clears the textarea, hits save.
      // The payload carries `signature: ""` — must distinguish from undefined.
      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        signature: '',
      })

      const meta = getAccountMeta(1)
      // Empty-string clear survives the round-trip: identity signature is "", NOT "A".
      expect(meta?.identities[0].signature).toBe('')
    })

    it('undefined signature (not submitted) preserves existing default identity signature', async () => {
      // Existing account has default identity with signature "A".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'A', isDefault: true },
        ],
      })

      // Re-save without touching `signature` (e.g. avatar-only update).
      await saveAccount({
        id: 1,
        name: 'Alice',
        avatarMode: 'icon',
        avatarIcon: 'star',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
      })

      const meta = getAccountMeta(1)
      // Undefined signature = "not submitted, preserve" — original "A" survives.
      expect(meta?.identities[0].signature).toBe('A')
      expect(meta?.avatarIcon).toBe('star')
    })
  })

  // --- HIGH-2 (2.3 wave 3): identities[] is sole source of truth for meta.signature ---

  describe('saveAccount — HIGH-2 identities[] owns meta.signature when submitted', () => {
    it('clears meta.signature to "" when default identity.signature is undefined in submitted identities[]', async () => {
      // Existing account carries a legacy `signature` mirror = "stale".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'stale', isDefault: true },
        ],
      })
      expect(getAccountMeta(1)?.signature).toBe('stale')

      // Renderer submits identities[] with default.signature = undefined.
      // Older callers (or current IdentitiesTab paths) may omit the field
      // entirely; this must still mean "cleared", not "fall back to legacy".
      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          // Explicitly no `signature` field on the submitted identity.
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })

      const meta = getAccountMeta(1)
      // Default identity's signature is undefined — legacy mirror must be "",
      // NOT fallback to the pre-existing "stale" value.
      expect(meta?.identities[0].signature).toBeUndefined()
      expect(meta?.signature).toBe('')
    })

    it('clears meta.signature to "" when default identity.signature is empty string in submitted identities[]', async () => {
      // Existing account carries a legacy `signature` mirror = "stale".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'stale', isDefault: true },
        ],
      })
      expect(getAccountMeta(1)?.signature).toBe('stale')

      // Renderer-ui's updated IdentitiesTab emits '' explicitly for "user
      // cleared the signature". The save path must honour the empty string
      // as source of truth on meta.signature, not resurrect the legacy mirror.
      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: '', isDefault: true },
        ],
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities[0].signature).toBe('')
      expect(meta?.signature).toBe('')
    })

    it('derives meta.signature from the default identity when identities[] carries new text', async () => {
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'old', isDefault: true },
        ],
      })

      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'new text', isDefault: true },
        ],
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities[0].signature).toBe('new text')
      expect(meta?.signature).toBe('new text')
    })

    it('identities[] wins over top-level legacy signature — cleared identity defeats legacy "Y"', async () => {
      // Existing account has default identity with signature "A".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'A', isDefault: true },
        ],
      })

      // Hostile payload shape: Settings still emits a top-level `signature: "Y"`
      // from its independent state, but the IdentitiesTab cleared the default
      // identity's signature. identities[] is the settled state — it wins,
      // and meta.signature must be "" (the cleared value), NOT "Y".
      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        signature: 'Y',
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: '', isDefault: true },
        ],
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities[0].signature).toBe('')
      expect(meta?.signature).toBe('')
    })

    it('legacy-only save (no identities[]) preserves wave-2 propagation into default identity', async () => {
      // Seed an account with default identity signature "A".
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: 'A', isDefault: true },
        ],
      })

      // Legacy Signature-tab save path: no identities[], just top-level signature.
      // Wave-2 BLOCKER fix must still work — propagate "from tab" into both
      // the default identity AND the legacy mirror.
      await saveAccount({
        id: 1,
        name: 'Alice',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        signature: 'from tab',
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities[0].signature).toBe('from tab')
      expect(meta?.signature).toBe('from tab')
    })

    it('migration-on-read then save-with-identities[] derives meta.signature from new identities, not legacy mirror', async () => {
      // Pre-2.3-A on-disk record with legacy signature "pre-2.3".
      storeData.set('accounts', [{
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        signature: 'pre-2.3',
        authType: 'password',
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
      }])

      // First save the user explicitly edits identities[] (Identities tab in
      // the 2.3-A UI) and clears the signature. meta.signature must reflect
      // the cleared identity, NOT fall back to the legacy "pre-2.3" mirror
      // that listAccounts would otherwise surface via existing?.signature.
      await saveAccount({
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'alice@example.com', signature: '', isDefault: true },
        ],
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities[0].signature).toBe('')
      expect(meta?.signature).toBe('')
    })
  })

  // --- HIGH-3: strict re-validation of existing.identities on save ---

  describe('saveAccount — HIGH-3 re-validation of existing.identities', () => {
    it('normalizes legacy bare-username email in default identity on re-save', async () => {
      // Pre-2.3-A on-disk record: identity synthesized from bare IMAP username
      // (read-side schema permissive, accepts non-email emails to avoid
      // locking users out). Write path must auto-normalize on first re-save.
      storeData.set('accounts', [{
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
        identities: [
          { id: 'legacy-non-uuid', displayName: 'Alice', email: 'alice', isDefault: true },
        ],
      }])

      // Verify read-side tolerates the bare username.
      expect(getAccountMeta(1)?.identities[0].email).toBe('alice')

      // Re-save without identities[]. The HIGH-3 reconciliation must normalize
      // email to the account's primary email (fallback chain) while keeping
      // the legacy id, displayName, and isDefault flag.
      await saveAccount({
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities).toHaveLength(1)
      // Email normalized to the primary email.
      expect(meta?.identities[0].email).toBe('alice@example.com')
      // Id preserved (stability — even when it's a legacy non-UUID value).
      expect(meta?.identities[0].id).toBe('legacy-non-uuid')
      expect(meta?.identities[0].displayName).toBe('Alice')
      expect(meta?.identities[0].isDefault).toBe(true)
    })

    it('normalizes only the invalid identity in a mixed list', async () => {
      // Two identities: one valid (email-shape), one legacy (bare).
      // HIGH-3 reconciliation must touch only the legacy entry.
      storeData.set('accounts', [{
        id: 1,
        email: 'alice@example.com',
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
        identities: [
          { id: UUID_PRIMARY, displayName: 'Alice', email: 'valid@example.com', isDefault: true },
          { id: UUID_ALIAS, displayName: 'Alice Alias', email: 'bare', isDefault: false },
        ],
      }])

      await saveAccount({
        id: 1,
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
      })

      const meta = getAccountMeta(1)
      expect(meta?.identities).toHaveLength(2)
      // Valid one preserved verbatim.
      expect(meta?.identities[0].email).toBe('valid@example.com')
      expect(meta?.identities[0].id).toBe(UUID_PRIMARY)
      // Legacy bare one normalized to primary email (fallback chain).
      expect(meta?.identities[1].email).toBe('alice@example.com')
      expect(meta?.identities[1].id).toBe(UUID_ALIAS)
      expect(meta?.identities[1].displayName).toBe('Alice Alias')
    })
  })

  // --- M1: Identity.id enforced as UUID on write, permissive on read ---

  describe('saveAccount — M1 UUID id enforcement', () => {
    it('server generates UUID when incoming identity has no id', async () => {
      await saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          // No id — server assigns one.
          { displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })
      const meta = getAccountMeta(1)
      // Generated id must be a valid UUID.
      expect(meta?.identities[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    })

    it('rejects forged non-UUID id on saveAccount', async () => {
      await expect(saveAccount({
        name: 'Alice',
        email: 'alice@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', pass: 'p' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com', pass: 'p' },
        identities: [
          { id: 'attacker-controlled', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      })).rejects.toThrow(/UUID|uuid/)
    })

    it('read-side still accepts non-UUID legacy ids (permissive)', () => {
      // Records predating UUID enforcement may carry non-UUID ids. Reading
      // must not reject — users must not be locked out.
      storeData.set('accounts', [{
        id: 1,
        providerId: 'generic-imap',
        transportType: 'imap-smtp',
        imap: { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' },
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice@example.com' },
        identities: [
          { id: 'legacy-non-uuid', displayName: 'Alice', email: 'alice@example.com', isDefault: true },
        ],
      }])
      const [acc] = listAccounts()
      expect(acc.identities).toHaveLength(1)
      expect(acc.identities[0].id).toBe('legacy-non-uuid')
    })
  })

  describe('listAccounts password stripping', () => {
    it('strips passwords from listAccounts output even if store is contaminated', async () => {
      await saveAccount({
        imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'secret1' },
        smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'secret2' },
      })
      // Manually contaminate the store with a password
      const accounts = storeData.get('accounts') as Array<Record<string, unknown>>
      const acc = accounts[0] as { imap: Record<string, unknown>; smtp: Record<string, unknown> }
      acc.imap.pass = 'leaked-imap'
      acc.smtp.pass = 'leaked-smtp'
      storeData.set('accounts', accounts)

      const result = listAccounts()
      expect(result).toHaveLength(1)
      expect((result[0].imap as Record<string, unknown>).pass).toBeUndefined()
      expect((result[0].smtp as Record<string, unknown>).pass).toBeUndefined()
    })
  })
})

// §2.33 PR2a — injectable SecretBackend (IMAP/SMTP passwords + OAuth refresh tokens)
//
// config.ts no longer calls keytar directly at the call sites: every secret
// get/set/delete routes through an injectable SecretBackend. The DEFAULT backend
// is direct keytar (already exercised by the suites above via the keytar mock).
// electron/main.ts injects the secretStore-backed implementation
// (electron/services/secretStore.ts) at startup. These suites exercise the seam
// itself: injection, default reset, get/set/delete routing, surface tags, the
// legacy-key migration through the backend, and the null-on-disk-only re-entry
// boundary.
//
// Keychain-unavailability telemetry moved INTO secretStore — config.ts must not
// double-report (§2.33 brief item 5), so the old §2.34 net-telemetry-seam
// assertions (reportNetError / reportNetEvent / per-session latch) are gone with
// the latch they tested. What remains here is the DEFAULT-backend error
// semantics (a keychain failure still propagates so a connection never starts
// without credentials) plus the new seam coverage.

type SecretBackendCall = { op: 'get' | 'set' | 'delete'; key: string; surface?: SecretSurface }

/** In-memory fake SecretBackend that records every call so tests can assert
 *  both routing (which key/surface) and that raw keytar was bypassed. */
function makeFakeSecretBackend(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  const calls: SecretBackendCall[] = []
  const backend: SecretBackend = {
    get: async (key, surface) => { calls.push({ op: 'get', key, surface }); return map.get(key) ?? null },
    set: async (key, value, surface) => { calls.push({ op: 'set', key, surface }); map.set(key, value) },
    delete: async (key, surface) => { calls.push({ op: 'delete', key, surface }); map.delete(key) },
  }
  return { backend, map, calls }
}

describe('§2.33 PR2a — injectable SecretBackend', () => {
  beforeEach(() => {
    storeData.clear()
    keytarStore.clear()
    vi.clearAllMocks()
    setSecretBackend(null) // start every case from the default keytar backend
  })
  afterEach(() => {
    // Never leak an injected backend into the keytar-based suites that follow.
    setSecretBackend(null)
  })

  it('default backend routes IMAP/SMTP password set+get through keytar', async () => {
    // No injection: saveAccount writes to the keytar mock, getAccountConfig
    // reads it back. Proves the default wiring is direct keytar (portability).
    await saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'imapPw' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'smtpPw' },
    })
    expect(keytarStore.get('imap:1')).toBe('imapPw')
    expect(keytarStore.get('smtp:1')).toBe('smtpPw')
    const cfg = await getAccountConfig(1)
    expect(cfg?.imap.pass).toBe('imapPw')
    expect(cfg?.smtp.pass).toBe('smtpPw')
  })

  it('setSecretBackend injects a backend; IMAP/SMTP secrets go to it, not keytar', async () => {
    const { backend, map } = makeFakeSecretBackend()
    setSecretBackend(backend)
    await saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'imapPw' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'smtpPw' },
    })
    expect(map.get('imap:1')).toBe('imapPw')
    expect(map.get('smtp:1')).toBe('smtpPw')
    // The keytar mock must be untouched — no direct keytar call leaked.
    expect(keytarStore.get('imap:1')).toBeUndefined()
    expect(keytarStore.get('smtp:1')).toBeUndefined()
  })

  it('setSecretBackend(null) restores the default keytar backend', async () => {
    const { backend, map } = makeFakeSecretBackend()
    setSecretBackend(backend)
    setSecretBackend(null)
    await saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
    })
    expect(map.size).toBe(0) // injected backend untouched after reset
    expect(keytarStore.get('imap:1')).toBe('p1')
  })

  it('getAccountConfig reads IMAP/SMTP passwords through the backend with imap_smtp surface', async () => {
    const { backend, calls } = makeFakeSecretBackend()
    setSecretBackend(backend)
    await saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'imapPw' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'smtpPw' },
    })
    calls.length = 0
    const cfg = await getAccountConfig(1)
    expect(cfg?.imap.pass).toBe('imapPw')
    expect(cfg?.smtp.pass).toBe('smtpPw')
    const gets = calls.filter(c => c.op === 'get')
    expect(gets.length).toBeGreaterThan(0)
    expect(gets.every(c => c.surface === 'imap_smtp')).toBe(true)
    expect(gets.map(c => c.key)).toContain('imap:1')
    expect(gets.map(c => c.key)).toContain('smtp:1')
  })

  it('saveAccount writes IMAP/SMTP passwords through the backend with imap_smtp surface', async () => {
    const { backend, calls } = makeFakeSecretBackend()
    setSecretBackend(backend)
    await saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'imapPw' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'smtpPw' },
    })
    const sets = calls.filter(c => c.op === 'set')
    expect(sets.some(c => c.key === 'imap:1' && c.surface === 'imap_smtp')).toBe(true)
    expect(sets.some(c => c.key === 'smtp:1' && c.surface === 'imap_smtp')).toBe(true)
  })

  it('OAuth refresh-token set/get/delete route through the backend with oauth_refresh surface', async () => {
    const { backend, map, calls } = makeFakeSecretBackend()
    setSecretBackend(backend)
    await setOauthRefreshToken('gmail', 9, 'tok-9')
    expect(map.get('oauth-refresh:gmail:9')).toBe('tok-9')
    expect(await getOauthRefreshToken('gmail', 9)).toBe('tok-9')
    await setOauthRefreshToken('gmail', 9, null)
    expect(map.get('oauth-refresh:gmail:9')).toBeUndefined()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(c => c.surface === 'oauth_refresh')).toBe(true)
  })

  it('getOauthRefreshTokenWithSource falls new→legacy through the backend', async () => {
    const { backend } = makeFakeSecretBackend({ 'google:refresh:1': 'legacy-tok' })
    setSecretBackend(backend)
    const found = await getOauthRefreshTokenWithSource('gmail', 1)
    expect(found).toEqual({ token: 'legacy-tok', source: 'legacy' })
  })

  it('deleteLegacyGoogleRefreshToken deletes only the legacy key through the backend', async () => {
    const { backend, map } = makeFakeSecretBackend({
      'oauth-refresh:gmail:5': 'new',
      'google:refresh:5': 'legacy',
    })
    setSecretBackend(backend)
    await deleteLegacyGoogleRefreshToken(5)
    expect(map.get('google:refresh:5')).toBeUndefined()
    expect(map.get('oauth-refresh:gmail:5')).toBe('new')
  })

  it('deleteAccount removes IMAP/SMTP + OAuth secrets through the backend', async () => {
    const { backend, map } = makeFakeSecretBackend()
    setSecretBackend(backend)
    await saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
    })
    await setOauthRefreshToken('gmail', 1, 'tok')
    expect(map.size).toBeGreaterThan(0)
    await deleteAccount(1)
    expect(map.get('imap:1')).toBeUndefined()
    expect(map.get('smtp:1')).toBeUndefined()
    expect(map.get('oauth-refresh:gmail:1')).toBeUndefined()
    // No raw keytar deletes leaked.
    expect(keytarStore.size).toBe(0)
  })

  it('legacy IMAP/SMTP key migration runs through the backend (item 6)', async () => {
    // Pre-migration install: account meta exists but secrets live only under
    // the legacy host-scoped keys. getAccountConfig must migrate them to the
    // id-scoped keys VIA THE BACKEND, not raw keytar.
    const { backend, map, calls } = makeFakeSecretBackend()
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])
    map.set('imap:a@test@imap.test', 'legacyImap')
    map.set('smtp:a@test@smtp.test', 'legacySmtp')

    const cfg = await getAccountConfig(1)
    expect(cfg?.imap.pass).toBe('legacyImap')
    expect(cfg?.smtp.pass).toBe('legacySmtp')
    // Migrated into the id-scoped keys; legacy keys deleted.
    expect(map.get('imap:1')).toBe('legacyImap')
    expect(map.get('smtp:1')).toBe('legacySmtp')
    expect(map.get('imap:a@test@imap.test')).toBeUndefined()
    expect(map.get('smtp:a@test@smtp.test')).toBeUndefined()
    // The migration touched the backend (set new key + delete legacy key).
    expect(calls.some(c => c.op === 'set' && c.key === 'imap:1' && c.surface === 'imap_smtp')).toBe(true)
    expect(calls.some(c => c.op === 'delete' && c.key === 'imap:a@test@imap.test')).toBe(true)
    // keytar mock stayed empty — proves no direct keytar call leaked.
    expect(keytarStore.size).toBe(0)
  })

  it('migration boundary: disk-only secret invisible to a reappeared keyring → pass undefined (needs re-entry), never throws', async () => {
    // Models the §2.33 re-entry boundary (item 7): after a fallback session the
    // OS keyring is back, but a secret written disk-only is not in the keyring.
    // The backend returns a CLEAN null (no throw, no stale value); getAccountConfig
    // must surface pass: undefined so the connection layer treats it as
    // "needs re-entry". The re-entry UI is PR3.
    const backend: SecretBackend = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    }
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])
    const cfg = await getAccountConfig(1)
    expect(cfg).toBeDefined()
    expect(cfg?.imap.pass).toBeUndefined()
    expect(cfg?.smtp.pass).toBeUndefined()
  })

  it('OAuth account getAccountConfig returns base config without reading any secret', async () => {
    // OAuth accounts obtain an access token from the refresh token at runtime,
    // so getAccountConfig must not read IMAP/SMTP passwords at all.
    const { backend, calls } = makeFakeSecretBackend()
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'oauth2',
      providerId: 'gmail',
      transportType: 'imap-smtp',
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
    }])
    const cfg = await getAccountConfig(1)
    expect(cfg).toBeDefined()
    expect(calls.length).toBe(0)
  })

  it('OAuth→password switch wipes the refresh token through the backend', async () => {
    const { backend, map } = makeFakeSecretBackend({
      'oauth-refresh:gmail:1': 'new-refresh',
      'google:refresh:1': 'legacy-refresh',
    })
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'oauth2',
      providerId: 'gmail',
      transportType: 'imap-smtp',
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
    }])
    await saveAccount({
      id: 1,
      authType: 'password',
      imap: { host: 'imap.new', port: 993, secure: true, user: 'a@new', pass: 'p' },
      smtp: { host: 'smtp.new', port: 587, secure: false, user: 'a@new', pass: 'p' },
    })
    expect(map.get('oauth-refresh:gmail:1')).toBeUndefined()
    expect(map.get('google:refresh:1')).toBeUndefined()
    // New password secrets written through the backend.
    expect(map.get('imap:1')).toBe('p')
    expect(map.get('smtp:1')).toBe('p')
  })

  it('password→oauth trust-gap guard reads the refresh token through the backend', async () => {
    // The guard rejects unless a refresh token already exists. With a token
    // planted in the injected backend, the transition is allowed — proving the
    // guard reads via the backend, not raw keytar.
    const { backend } = makeFakeSecretBackend({ 'oauth-refresh:gmail:1': 'legit-token' })
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])
    await expect(saveAccount({
      id: 1,
      authType: 'oauth2',
      providerId: 'gmail',
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
    })).resolves.toEqual({ id: 1 })
  })

  it('password→oauth trust-gap guard rejects when the backend has no refresh token', async () => {
    const { backend } = makeFakeSecretBackend() // empty backend
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])
    await expect(saveAccount({
      id: 1,
      authType: 'oauth2',
      providerId: 'gmail',
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
    })).rejects.toThrow(/OAuth account save requires a completed OAuth flow/)
  })

  // --- §2.33 PR2a gaps: partial legacy migration + surface tag on deleteLegacy ---

  it('partial legacy migration: only IMAP legacy key exists — IMAP migrated, SMTP stays undefined', async () => {
    // tryMigrateLegacySecrets handles each credential independently. A buggy
    // implementation that stops after a successful IMAP migration and skips
    // the SMTP lookup would pass the "both keys" test but fail here.
    const { backend, map } = makeFakeSecretBackend()
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])
    // Only the legacy IMAP key is seeded — SMTP has nothing.
    map.set('imap:a@test@imap.test', 'onlyImapLegacy')

    const cfg = await getAccountConfig(1)
    expect(cfg).toBeDefined()
    expect(cfg?.imap.pass).toBe('onlyImapLegacy')
    expect(cfg?.smtp.pass).toBeUndefined()
    // IMAP migrated to id-scoped key; legacy IMAP key deleted.
    expect(map.get('imap:1')).toBe('onlyImapLegacy')
    expect(map.get('imap:a@test@imap.test')).toBeUndefined()
    // SMTP legacy key was never there; smtp:1 still absent.
    expect(map.get('smtp:1')).toBeUndefined()
    // No raw keytar calls leaked.
    expect(keytarStore.size).toBe(0)
  })

  it('partial legacy migration: only SMTP legacy key exists — SMTP migrated, IMAP stays undefined', async () => {
    // Symmetric counterpart: the SMTP-only case validates the separate
    // try/catch blocks in tryMigrateLegacySecrets (if IMAP were guarded by
    // a condition that returns early on absent legacy key, SMTP would be skipped).
    const { backend, map } = makeFakeSecretBackend()
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])
    // Only the legacy SMTP key is seeded.
    map.set('smtp:a@test@smtp.test', 'onlySmtpLegacy')

    const cfg = await getAccountConfig(1)
    expect(cfg).toBeDefined()
    expect(cfg?.imap.pass).toBeUndefined()
    expect(cfg?.smtp.pass).toBe('onlySmtpLegacy')
    // SMTP migrated; id-scoped key written, legacy key deleted.
    expect(map.get('smtp:1')).toBe('onlySmtpLegacy')
    expect(map.get('smtp:a@test@smtp.test')).toBeUndefined()
    // IMAP has no legacy key; imap:1 still absent.
    expect(map.get('imap:1')).toBeUndefined()
    // No raw keytar calls leaked.
    expect(keytarStore.size).toBe(0)
  })

  it('deleteLegacyGoogleRefreshToken passes oauth_refresh surface to the backend', async () => {
    // The other OAuth operations (setOauthRefreshToken/getOauthRefreshToken)
    // have explicit surface-tag assertions; this covers the remaining call site
    // so the injected secretStore receives the correct surface for all
    // once-per-session keychain-unavailability telemetry decisions.
    const { backend, calls } = makeFakeSecretBackend({
      'google:refresh:7': 'legacy-tok',
    })
    setSecretBackend(backend)
    await deleteLegacyGoogleRefreshToken(7)
    const deletes = calls.filter(c => c.op === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].key).toBe('google:refresh:7')
    expect(deletes[0].surface).toBe('oauth_refresh')
  })

  // ── FINDING 1 clobber regression ────────────────────────────────────────────
  // tryMigrateLegacySecrets receives (migrateImap, migrateSmtp) flags so it
  // only migrates a credential whose id-scoped key is ABSENT.  Before the fix
  // the call was unconditional: when one id-scoped key was present but the
  // OTHER was missing, migration still ran for the PRESENT key and overwrote
  // a valid working password with a potentially stale legacy value.

  it('(FINDING 1 clobber) no overwrite of existing id-scoped imap key when only smtp is missing', async () => {
    // Scenario: imap:1 is present and valid; smtp:1 is absent.  A stale legacy
    // imap key also exists.  Migration must run only for SMTP (migrateImap=false).
    const { backend, map } = makeFakeSecretBackend({
      'imap:1': 'currentImapPass',
      'imap:a@test@imap.test': 'staleImapLegacy',
      'smtp:a@test@smtp.test': 'smtpLegacy',
    })
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])

    const cfg = await getAccountConfig(1)
    // imap:1 was present — migration must not run for IMAP
    expect(cfg?.imap.pass).toBe('currentImapPass')
    expect(map.get('imap:1')).toBe('currentImapPass') // id-scoped key unchanged
    // The stale legacy imap key must NOT have been deleted (migration skipped it)
    expect(map.get('imap:a@test@imap.test')).toBe('staleImapLegacy')
    // smtp:1 was absent → migrated from legacy key
    expect(cfg?.smtp.pass).toBe('smtpLegacy')
    expect(map.get('smtp:1')).toBe('smtpLegacy')
    expect(map.get('smtp:a@test@smtp.test')).toBeUndefined() // legacy deleted
    expect(keytarStore.size).toBe(0)
  })

  it('(FINDING 1 clobber) no overwrite of existing id-scoped smtp key when only imap is missing', async () => {
    // Symmetric case: smtp:1 is present; imap:1 is absent.
    const { backend, map } = makeFakeSecretBackend({
      'smtp:1': 'currentSmtpPass',
      'smtp:a@test@smtp.test': 'staleSmtpLegacy',
      'imap:a@test@imap.test': 'imapLegacy',
    })
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])

    const cfg = await getAccountConfig(1)
    // smtp:1 was present — migration must not run for SMTP
    expect(cfg?.smtp.pass).toBe('currentSmtpPass')
    expect(map.get('smtp:1')).toBe('currentSmtpPass') // id-scoped key unchanged
    // The stale legacy smtp key must NOT have been deleted
    expect(map.get('smtp:a@test@smtp.test')).toBe('staleSmtpLegacy')
    // imap:1 was absent → migrated from legacy key
    expect(cfg?.imap.pass).toBe('imapLegacy')
    expect(map.get('imap:1')).toBe('imapLegacy')
    expect(map.get('imap:a@test@imap.test')).toBeUndefined() // legacy deleted
    expect(keytarStore.size).toBe(0)
  })

  // ── FINDING 1 migration — backend.set rejects (read-only keyring) ────────────

  it('(FINDING 1 migration) migration preserves legacy key and creates no partial target when backend.set rejects', async () => {
    // If the backend is read-only, backend.set throws.  The try/catch in
    // tryMigrateLegacySecrets swallows it.  The subsequent backend.delete must
    // NOT be called (delete only runs after a successful set), so the legacy
    // key is preserved and no partial id-scoped key is left behind.
    const calls: Array<{ op: string; key: string }> = []
    const backend: SecretBackend = {
      get: async (key) => {
        calls.push({ op: 'get', key })
        if (key === 'imap:a@test@imap.test') return 'legacyImap'
        return null
      },
      set: async (key) => {
        calls.push({ op: 'set', key })
        throw new Error('keyring read-only')
      },
      delete: async (key) => {
        calls.push({ op: 'delete', key })
      },
    }
    setSecretBackend(backend)
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])

    // The migration error is swallowed; getAccountConfig must not throw.
    const cfg = await getAccountConfig(1)
    expect(cfg).toBeDefined()

    // backend.set was attempted (imap:1 write tried but rejected)
    expect(calls.some(c => c.op === 'set' && c.key === 'imap:1')).toBe(true)
    // backend.delete must NOT have been called — set failed before delete
    expect(calls.filter(c => c.op === 'delete')).toHaveLength(0)

    // Migration failed silently; the new key was never written → pass: undefined
    expect(cfg?.imap.pass).toBeUndefined()
  })

  // ── saveAccount mid-save backend failure ─────────────────────────────────────

  it('saveAccount surfaces backend.set rejection when smtp write fails after imap succeeded', async () => {
    // The two backend.set calls in saveAccount are not wrapped in a try/catch;
    // a rejection from the smtp write propagates to the caller.  This is the
    // documented behaviour: no silent partial-success claim.
    let imapWritten = false
    const backend: SecretBackend = {
      get: async () => null,
      set: async (key) => {
        if (key === 'imap:1') {
          imapWritten = true
          return // imap write completes normally
        }
        throw new Error('keyring locked') // smtp write rejects
      },
      delete: async () => {},
    }
    setSecretBackend(backend)

    await expect(saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'imapPw' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'smtpPw' },
    })).rejects.toThrow('keyring locked')

    // Confirm the imap write ran to completion before the smtp failure
    expect(imapWritten).toBe(true)
  })

  // ── FINDING 2 PII-safe logging ───────────────────────────────────────────────
  // setOauthRefreshToken and deleteLegacyGoogleRefreshToken now log ONLY a
  // stable label + err.name in their catch blocks.  No account id, no
  // provider, no key string, no raw err.message (which can embed the key).

  it('(FINDING 2 PII-safe) setOauthRefreshToken catch logs stable label + err.name only on backend.set failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const backend: SecretBackend = {
        get: async () => null,
        set: async () => {
          const err = new Error('oauth-refresh:gmail:9 write failed for account 9 provider gmail')
          err.name = 'KeyringError'
          throw err
        },
        delete: async () => {},
      }
      setSecretBackend(backend)

      // Must not throw despite backend rejection
      await setOauthRefreshToken('gmail', 9, 'some-token')

      expect(warnSpy).toHaveBeenCalled()
      const logged = warnSpy.mock.calls[0].join(' ')
      // Stable content present
      expect(logged).toContain('[net/config] setOauthRefreshToken failed:')
      expect(logged).toContain('KeyringError') // err.name only
      // PII must not appear in any form
      expect(logged).not.toContain('oauth-refresh:gmail:9') // no key
      expect(logged).not.toContain('gmail')                  // no provider
      expect(logged).not.toContain('write failed for account 9 provider gmail') // no raw message
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('(FINDING 2 PII-safe) setOauthRefreshToken null-token path logs stable label + err.name only on backend.delete failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const backend: SecretBackend = {
        get: async () => null,
        set: async () => {},
        delete: async () => {
          const err = new Error('oauth-refresh:outlook:7 delete failed: access denied')
          err.name = 'AccessDeniedError'
          throw err
        },
      }
      setSecretBackend(backend)

      await setOauthRefreshToken('outlook', 7, null)

      expect(warnSpy).toHaveBeenCalled()
      const logged = warnSpy.mock.calls[0].join(' ')
      expect(logged).toContain('[net/config] setOauthRefreshToken failed:')
      expect(logged).toContain('AccessDeniedError')
      expect(logged).not.toContain('oauth-refresh:outlook:7') // no key
      expect(logged).not.toContain('outlook')                   // no provider
      expect(logged).not.toContain('delete failed: access denied') // no raw message
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('(FINDING 2 PII-safe) deleteLegacyGoogleRefreshToken catch logs stable label + err.name only on backend.delete failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const backend: SecretBackend = {
        get: async () => null,
        set: async () => {},
        delete: async () => {
          const err = new Error('google:refresh:5 delete failed: permission denied for account 5')
          err.name = 'PermissionError'
          throw err
        },
      }
      setSecretBackend(backend)

      await deleteLegacyGoogleRefreshToken(5)

      expect(warnSpy).toHaveBeenCalled()
      const logged = warnSpy.mock.calls[0].join(' ')
      expect(logged).toContain('[net/config] deleteLegacyGoogleRefreshToken failed:')
      expect(logged).toContain('PermissionError')
      expect(logged).not.toContain('google:refresh:5') // no key
      expect(logged).not.toContain('delete failed: permission denied for account 5') // no raw message
    } finally {
      warnSpy.mockRestore()
    }
  })

  // ── FINDING 3 backend snapshot — concurrent swap ─────────────────────────────

  it('(FINDING 3 snapshot) in-flight getAccountConfig uses the backend snapshot taken at op start, not a post-swap backend', async () => {
    // Each public secret op snapshots `const backend = secretBackend` at its
    // start.  A concurrent setSecretBackend() call mid-operation must not cause
    // the in-flight op to silently switch to the new backend mid-flight.
    let resolveImapGet: (v: string | null) => void = () => {}

    const firstBackend: SecretBackend = {
      get: async (key) => {
        if (key === 'imap:1') {
          // Pause so the test can swap the backend before this resolves.
          return new Promise<string | null>(res => { resolveImapGet = res })
        }
        return key === 'smtp:1' ? 'smtpFromFirst' : null
      },
      set: async () => {},
      delete: async () => {},
    }

    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])

    setSecretBackend(firstBackend)
    const configPromise = getAccountConfig(1) // pauses at imap:1 get

    // Swap to a different backend while the op is suspended
    const secondBackend: SecretBackend = {
      get: async () => 'from-second-backend',
      set: async () => {},
      delete: async () => {},
    }
    setSecretBackend(secondBackend)

    // Resume the first backend's imap read
    resolveImapGet('imapFromFirst')

    const cfg = await configPromise

    // Both reads must have come from the firstBackend snapshot, not secondBackend.
    // Without the snapshot: smtp.pass would be 'from-second-backend'.
    expect(cfg?.imap.pass).toBe('imapFromFirst')
    expect(cfg?.smtp.pass).toBe('smtpFromFirst')
  })

  // ── FINDING 3 backend snapshot — saveAccount ─────────────────────────────────

  it('(FINDING 3 snapshot) in-flight setSecretBackend swap during saveAccount does not split OAuth cleanup across backends', async () => {
    // Scenario: an existing OAuth2 account is switched to password auth.
    // saveAccount snapshots `const backend = secretBackend` at the very start.
    // A concurrent setSecretBackend(B) that lands AFTER the snapshot but BEFORE
    // the OAuth-cleanup step (setOauthRefreshTokenWith + deleteLegacyGoogleRefreshTokenWith)
    // must not cause the cleanup to use backend B — all four secret ops (imap set,
    // smtp set, oauth-refresh delete, legacy-google delete) must land on backend A.
    //
    // Barrier placement: backendA.set pauses at 'imap:1' so the test can swap to
    // backendB before saveAccount resumes; the OAuth-cleanup has not yet run at
    // that point.

    const aCalls: Array<{ op: string; key: string }> = []
    let resolveImapSet!: () => void

    const backendA: SecretBackend = {
      get: async () => null,
      set: async (key) => {
        aCalls.push({ op: 'set', key })
        if (key === 'imap:1') {
          // Barrier: pause so the test can call setSecretBackend(B) before the
          // OAuth-cleanup step runs.
          await new Promise<void>(res => { resolveImapSet = res })
        }
      },
      delete: async (key) => { aCalls.push({ op: 'delete', key }) },
    }

    const bCalls: Array<{ op: string; key: string }> = []
    const backendB: SecretBackend = {
      get: async (key) => { bCalls.push({ op: 'get', key }); return null },
      set: async (key) => { bCalls.push({ op: 'set', key }) },
      delete: async (key) => { bCalls.push({ op: 'delete', key }) },
    }

    // Existing account: OAuth2/gmail — the relevant OAuth keys to clean up.
    storeData.set('accounts', [{
      id: 1,
      authType: 'oauth2',
      providerId: 'gmail',
      transportType: 'imap-smtp',
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a@gmail.com' },
    }])

    setSecretBackend(backendA)
    // saveAccount runs synchronously until the first await inside backendA.set('imap:1').
    // At that point it suspends at the barrier; resolveImapSet is assigned.
    const savePromise = saveAccount({
      id: 1,
      authType: 'password',
      imap: { host: 'imap.new', port: 993, secure: true, user: 'a@new', pass: 'imapPw' },
      smtp: { host: 'smtp.new', port: 587, secure: false, user: 'a@new', pass: 'smtpPw' },
    })

    // Swap the module-global BEFORE the barrier resolves — the OAuth-cleanup step
    // (setOauthRefreshTokenWith + deleteLegacyGoogleRefreshTokenWith) has not yet
    // executed, but saveAccount already snapshotted backendA at its start.
    setSecretBackend(backendB)
    resolveImapSet()  // unblock; backendA.set('imap:1') completes; saveAccount continues
    await savePromise

    // All four secret ops must have gone to backendA (the snapshot, not the swap).
    expect(aCalls.some(c => c.op === 'set' && c.key === 'imap:1')).toBe(true)
    expect(aCalls.some(c => c.op === 'set' && c.key === 'smtp:1')).toBe(true)
    expect(aCalls.some(c => c.op === 'delete' && c.key === 'oauth-refresh:gmail:1')).toBe(true)
    expect(aCalls.some(c => c.op === 'delete' && c.key === 'google:refresh:1')).toBe(true)
    // backendB must have received zero calls from this single operation.
    expect(bCalls).toHaveLength(0)
  })

  // ── FINDING 3 backend snapshot — deleteAccount ────────────────────────────────

  it('(FINDING 3 snapshot) in-flight setSecretBackend swap during deleteAccount does not split secret cleanup across backends', async () => {
    // deleteAccount snapshots `const backend = secretBackend` at the very start,
    // then issues five deletes: imap, smtp, oauth-refresh:gmail, oauth-refresh:outlook,
    // google:refresh. A setSecretBackend(B) that races between the imap delete and
    // the OAuth-cleanup deletes must not redirect any of the remaining deletes to B.
    //
    // Barrier placement: backendA.delete pauses at 'imap:1' so the test can swap
    // to backendB before the smtp and OAuth deletes run.

    const aCalls: string[] = []
    let resolveImapDelete!: () => void

    const backendA: SecretBackend = {
      get: async () => null,
      set: async () => {},
      delete: async (key) => {
        aCalls.push(key)
        if (key === 'imap:1') {
          // Barrier: pause so the test can call setSecretBackend(B) before the
          // smtp and OAuth cleanup deletes run.
          await new Promise<void>(res => { resolveImapDelete = res })
        }
      },
    }

    const bCalls: string[] = []
    const backendB: SecretBackend = {
      get: async () => null,
      set: async () => {},
      delete: async (key) => { bCalls.push(key) },
    }

    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])

    setSecretBackend(backendA)
    // deleteAccount runs synchronously until the first await: backendA.delete('imap:1').
    // At that point it suspends at the barrier; resolveImapDelete is assigned.
    const deletePromise = deleteAccount(1)

    // Swap BEFORE resuming — smtp delete and all three OAuth deletes have not yet run.
    setSecretBackend(backendB)
    resolveImapDelete()  // unblock; backendA.delete('imap:1') completes; operation continues
    await deletePromise

    // All five deletes must have gone to backendA (the snapshot, not the swap).
    expect(aCalls).toContain('imap:1')
    expect(aCalls).toContain('smtp:1')
    expect(aCalls).toContain('oauth-refresh:gmail:1')
    expect(aCalls).toContain('oauth-refresh:outlook:1')
    expect(aCalls).toContain('google:refresh:1')
    // backendB must have received zero calls from this single operation.
    expect(bCalls).toHaveLength(0)
  })

  // ── FINDING 3 backend snapshot — public wrapper snapshot ─────────────────────

  it('public setOauthRefreshToken snapshots module-global at call time so a concurrent swap has no effect on the write', async () => {
    // The public wrapper takes `const backend = secretBackend` synchronously before
    // its first await. A setSecretBackend() call that races between the function
    // entry and the completion of the internal backend.set must not redirect the write.

    const aMap = new Map<string, string>()
    let resolveWrite!: () => void

    const backendA: SecretBackend = {
      get: async () => null,
      set: async (key, value) => {
        aMap.set(key, value)
        // Barrier: suspend until the test resolves, after swapping to backendB.
        await new Promise<void>(res => { resolveWrite = res })
      },
      delete: async () => {},
    }

    const bMap = new Map<string, string>()
    const backendB: SecretBackend = {
      get: async () => null,
      set: async (key, value) => { bMap.set(key, value) },
      delete: async () => {},
    }

    setSecretBackend(backendA)
    // setOauthRefreshToken captures `const backend = secretBackend` synchronously,
    // then suspends at the barrier inside backendA.set.
    const writePromise = setOauthRefreshToken('gmail', 1, 'tok-public-snap')

    // Swap the module-global after the function captured its snapshot.
    setSecretBackend(backendB)
    resolveWrite()  // let backendA.set complete
    await writePromise

    // The write must have landed on backendA (the snapshot taken at call time).
    expect(aMap.get('oauth-refresh:gmail:1')).toBe('tok-public-snap')
    // backendB must be untouched.
    expect(bMap.size).toBe(0)
  })

  it('public deleteLegacyGoogleRefreshToken snapshots module-global at call time so a concurrent swap has no effect on the delete', async () => {
    // Symmetric snapshot test for the deleteLegacyGoogleRefreshToken public wrapper.

    const aCalls: string[] = []
    let resolveDelete!: () => void

    const backendA: SecretBackend = {
      get: async () => null,
      set: async () => {},
      delete: async (key) => {
        aCalls.push(key)
        // Barrier: suspend so the test can swap to backendB before resolving.
        await new Promise<void>(res => { resolveDelete = res })
      },
    }

    const bCalls: string[] = []
    const backendB: SecretBackend = {
      get: async () => null,
      set: async () => {},
      delete: async (key) => { bCalls.push(key) },
    }

    setSecretBackend(backendA)
    // deleteLegacyGoogleRefreshToken captures the snapshot synchronously,
    // then suspends at the barrier inside backendA.delete.
    const delPromise = deleteLegacyGoogleRefreshToken(3)

    // Swap after the snapshot is already captured.
    setSecretBackend(backendB)
    resolveDelete()  // let backendA.delete complete
    await delPromise

    // The delete must have landed on backendA.
    expect(aCalls).toContain('google:refresh:3')
    // backendB must be untouched.
    expect(bCalls).toHaveLength(0)
  })

  // ── Default keytar null semantics ────────────────────────────────────────────

  it('default keytar backend: absent password (null, not throw) resolves to pass: undefined without throwing', async () => {
    // The default backend wraps keytar.getPassword which returns null (not throw)
    // for absent keys. getAccountConfig must treat null as pass: undefined and
    // not misinterpret a null return as an error. keytarStore is empty here
    // (cleared in beforeEach) so both gets return null.
    storeData.set('accounts', [{
      id: 1,
      authType: 'password',
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test' },
    }])

    const cfg = await getAccountConfig(1)
    expect(cfg).toBeDefined()
    expect(cfg?.imap.pass).toBeUndefined()
    expect(cfg?.smtp.pass).toBeUndefined()
  })
})

describe('§2.33 PR2a — default backend error semantics (no config-local telemetry)', () => {
  // The DEFAULT (keytar) backend has no telemetry and no disk fallback. A
  // keychain failure must propagate exactly as it did pre-§2.33 so the IMAP
  // connection is never started without credentials. Reporting + the encrypted
  // disk fallback are the injected secretStore's job (electron/, out of scope
  // for packages/net). vi.resetModules() gives each case a fresh keytar mock
  // whose implementation can be overridden in isolation.
  beforeEach(() => {
    storeData.clear()
    keytarStore.clear()
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('getAccountConfig re-throws the original keytar error when the keychain is down', async () => {
    const { saveAccount, getAccountConfig } = await import('./config')
    const keytarModule = await import('keytar')

    await saveAccount({
      imap: { host: 'imap.test', port: 993, secure: true, user: 'a@test', pass: 'p1' },
      smtp: { host: 'smtp.test', port: 587, secure: false, user: 'a@test', pass: 'p2' },
    })

    const keychainErr = new Error(
      'Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached',
    )
    vi.mocked(keytarModule.default.getPassword).mockRejectedValue(keychainErr)

    // Identity preserved: the default backend does not wrap the error.
    await expect(getAccountConfig(1)).rejects.toBe(keychainErr)
  })

  it('OAuth new→legacy fallback survives a keytar rejection on the new key', async () => {
    // The per-key try/catch inside lookupOauthRefreshTokenWithSource must still
    // recover from a backend rejection on the new key and resolve from legacy.
    const { getOauthRefreshTokenWithSource } = await import('./config')
    const keytarModule = await import('keytar')

    vi.mocked(keytarModule.default.getPassword)
      .mockRejectedValueOnce(new Error('org.freedesktop.secrets: Timeout was reached'))
      .mockResolvedValueOnce('legacy-token-value')

    const result = await getOauthRefreshTokenWithSource('gmail', 1)
    expect(result).toEqual({ token: 'legacy-token-value', source: 'legacy' })
  })
})

// §2.82 iter2 finding 4 — the consent migration must be able to tell "the key
// was never written" from "the user explicitly turned it off". `getSettings()`
// cannot: zod substitutes a default for every absent field, so the distinction
// currently survives only because `sentryEnabled` happens to default to `true`.
// `getRawPersistedSettings` is the explicit answer.
describe('§2.82 — getRawPersistedSettings', () => {
  beforeEach(() => {
    storeData.clear()
    vi.clearAllMocks()
  })

  it('returns undefined when nothing has been persisted yet', () => {
    expect(getRawPersistedSettings()).toBeUndefined()
  })

  it('reports an absent key as absent, while getSettings() shows the default', () => {
    storeData.set('settings', { theme: 'dark' })

    expect(getRawPersistedSettings()).toEqual({ theme: 'dark' })
    expect(getRawPersistedSettings()!.sentryEnabled).toBeUndefined()
    // The parsed view cannot make the distinction — that is the whole point.
    expect(getSettings().sentryEnabled).toBe(settingsSchema.parse({ theme: 'dark' }).sentryEnabled)
  })

  it('reports an explicitly persisted false as false', () => {
    storeData.set('settings', { theme: 'dark', sentryEnabled: false })
    expect(getRawPersistedSettings()!.sentryEnabled).toBe(false)
  })

  it('applies no defaults and no migrations', () => {
    storeData.set('settings', { sentryEnabled: false })
    // Byte-for-byte what is on disk: no cacheDays, no language, no theme.
    expect(getRawPersistedSettings()).toEqual({ sentryEnabled: false })
  })

  it('returns undefined for a non-object stored value', () => {
    for (const bogus of ['string', 42, [], null]) {
      storeData.set('settings', bogus)
      expect(getRawPersistedSettings()).toBeUndefined()
    }
  })
})
