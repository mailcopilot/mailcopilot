// Sentry is initialized as early as possible, with the persisted
// sentryEnabled flag already applied, so session envelopes and early
// events honor the user's telemetry toggle. The preflight reader uses
// only electron + fs + path so we don't drag config.ts (better-sqlite3,
// keytar, zod, electron-store) in front of this call.
//
// Caveat: ES imports are hoisted — the static `import`s further down
// this file (packages/net, electron services) execute their side
// effects BEFORE any imperative code on this line. If those native
// bindings throw during module load (e.g. better-sqlite3 ABI mismatch
// or missing keytar), the error happens before setSentryUserEnabled /
// initSentry run and Sentry will not see it. A full fix would require
// splitting bootstrap into a two-stage entrypoint (a tiny file that
// inits Sentry, then `await import()`s the rest). That is an
// architectural change, orthogonal to this fix, and not done here.
// What IS fixed: the SDK's own `enabled` flag now starts in the
// correct state, so session envelopes and all post-init events respect
// the user's opt-out.
import { readSentryEnabledPreflight } from './sentryPreflight'
import { initSentry, captureException, flushSentry, setSentryUserEnabled, setSentryUserId } from './sentry'
setSentryUserEnabled(readSentryEnabledPreflight())
initSentry()

// Wire packages/net telemetry sink to the Sentry-backed startMetricSpan.
// packages/net ships with a no-op default so tests / non-Electron consumers
// never pull Sentry into their import graph. The sink is installed here
// before any IMAP/SMTP work can start so every sync, IDLE cycle and SMTP
// send gets a proper span from the first second of the session.
import { startMetricSpanDynamic } from './metrics'
import { setNetTelemetrySink, setNetErrorReporter, setNetEventReporter } from '../packages/net/telemetry'
// Uses the Dynamic variant because packages/net forwards `name: string` —
// the layer-pure seam cannot reference MetricSpanName. Direct callers in
// electron/services/* use the typed startMetricSpan for compile-time
// safety on span names (see metrics.ts for the split rationale).
setNetTelemetrySink((name, attributes) => startMetricSpanDynamic(name, attributes))
setNetErrorReporter((source, err, context) => {
  captureException(err, { source, ...(context ?? {}) })
})
// Bridge typed discrete events from packages/net (e.g. auth refresh cooldown
// suppression) into recordEvent. The registered schema entry validates tag
// names/values; unknown names fall through to recordEvent's own guard.
// Note: the closure captures `recordEvent` as a live ES-module binding —
// the `import { recordEvent }` lower in this file is hoisted and the
// binding becomes usable inside this closure at invocation time (well
// after module eval finishes).
setNetEventReporter((name, tags) => {
  // We type-erase here because reportNetEvent is provider-generic. Tag
  // shape is validated by metrics.ts against metricsSchema.ts at call
  // time, so a typo or cardinality drift still blocks the emission.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (recordEvent as any)(name, tags)
  } catch {
    // Telemetry must never break IMAP flow.
  }
})

// Same pattern for packages/db: install the Sentry-backed span starter and
// error reporter. Unlike packages/net (whose sockets only open on demand),
// packages/db opens SQLite and runs schema migrations at module-import time
// — and ES imports are hoisted, so by the time this imperative call runs,
// the very first DB ops (including the entire cold-start migration round)
// have already executed against the default sink. To avoid silently
// dropping that telemetry, the seam in packages/db/telemetry.ts uses a
// bounded ring buffer as its default sink and drains it into the real
// starter on installation. See the "Buffered ring buffer" comment in
// packages/db/telemetry.ts for the timing-fidelity tradeoff and the
// `buffered=true` / `buffered_duration_ms` attribute decoration applied
// to replayed spans. packages/db itself never imports Sentry.
import { setDbTelemetrySink, setDbErrorReporter, setDbEventReporter } from '../packages/db/telemetry'
// Same rationale as setNetTelemetrySink above — packages/db forwards
// `name: string` through a layer-pure seam.
setDbTelemetrySink((name, attributes) => startMetricSpanDynamic(name, attributes))
setDbErrorReporter((source, err, context) => {
  captureException(err, { source, ...(context ?? {}) })
})
// Typed event bridge: db layer is layer-pure and doesn't know about
// electron/metrics, so we map its event names to the typed recordEvent
// dispatcher here. `db.mass_delete_messages` is the first consumer —
// every folder-wide DELETE inside removeStaleMessages emits through this
// path so Sentry has a product-level signal if the data-loss regression
// re-appears in the wild. Tag whitelist matches METRIC_EVENTS entry.
setDbEventReporter((name, tags) => {
  try {
    if (name === 'db.mass_delete_messages') {
      recordEvent('db.mass_delete_messages', tags as Parameters<typeof recordEvent>[1])
      return
    }
    // Silently drop unknown names — the seam is permissive by design, but
    // adding a new event requires a metricsSchema.ts entry and a branch here.
  } catch { /* never let telemetry break the caller */ }
})

// Logging: electron-log writes to file + console.
// initLogger() is called below, after importing app (needs app.isPackaged).
import { initLogger, createLogger } from './logger'

const logMain = createLogger('Main')
const logMcpStdio = createLogger('McpStdio')
const logOAuth = createLogger('OAuth')
const logUpdate = createLogger('Update')
const logMail = createLogger('Mail')
const logSync = createLogger('Sync')
const logAI = createLogger('AI')
const logSnooze = createLogger('Snooze')
const logFollowUp = createLogger('FollowUp')
const logReadLater = createLogger('ReadLater')
const logRules = createLogger('Rules')
const logMailboxesAndRoles = createLogger('MailboxesAndRoles')
const logShutdown = createLogger('Shutdown')
const logDraftSync = createLogger('DraftSync')

// Catch unhandled errors to prevent app crashes (e.g., Socket timeout from ImapFlow IDLE).
process.on('uncaughtException', (err) => {
  logMain.error('Uncaught exception:', err)
  captureException(err, { source: 'uncaughtException' })
})
process.on('unhandledRejection', (reason) => {
  logMain.error('Unhandled rejection:', reason)
  captureException(reason, { source: 'unhandledRejection' })
})

import { app, BrowserWindow, shell, Menu, dialog, screen } from 'electron'
import { handleIpc, registerMetricsRecordHandler, registerUiFreezeHandler, startMainLoopFreezeWatchdog } from './ipc'
import { recordEvent, recordHistogram, flushAggregator, startMetricSpan, bucketQueryLen, bucketResultCount, bucketDuration, bucketFolderCount, bucketTimeSinceSync, bucketCount, bucketFreedBytes, bucketBodySize, folderRoleFromPath, providerFromHost } from './metrics'
import {
  getInstallIdHash,
  getLastSeenAppVersion,
  setLastSeenAppVersion,
  markAccountSeen,
  getAccountSeenAt,
  markFirstHeadersSync,
  getFirstHeadersSyncAt,
  markFirstMessageOpened,
} from './installId'
import { featureReach, markFeatureUsed } from './featureReach'

// Single Instance Lock: prevent multiple app instances sharing the same DB.
// Disabled in E2E mode — tests run multiple isolated instances in parallel.
const gotSingleInstanceLock = process.env.MAILCOPILOT_E2E === '1' || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  process.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    const allWindows = BrowserWindow.getAllWindows()
    const mainWindow = allWindows.find(w => !w.isDestroyed())
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    // Handle mailto: URL passed from second instance (Linux/Windows)
    const mailtoArg = argv.find(a => a.startsWith('mailto:'))
    if (mailtoArg) handleMailtoUrl(mailtoArg)
  })
}

// §2.15-bis: graceful-shutdown signal handlers.
//
// Default Linux `kill <pid>` sends SIGTERM; terminal Ctrl+C sends SIGINT;
// parent terminal close sends SIGHUP. Without explicit handlers, Node may
// abort the process immediately and Electron's `before-quit` lifecycle
// (where we drain timers + run `wal_checkpoint(TRUNCATE)`) never fires —
// leaving committed pages in `.db-wal` un-checkpointed. Electron's own
// SIGINT routing is process/TTY-dependent (only when the main process is
// foregrounded in a terminal), so we cannot rely on it; routing all three
// through `app.quit()` is the safe default. SIGKILL cannot be caught —
// that's what the periodic PASSIVE checkpoint (every 60s) is for.
//
// Codex §2.15-bis review iteration 2 Medium #2.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    logShutdown.info(`${signal} received — initiating graceful quit`)
    app.quit()
  })
}

// --- mailto: protocol handler ---

/** Parse a mailto: URL into ComposeInit fields (to, cc, bcc, subject, body). */
function parseMailtoUrl(url: string): { to: string; cc?: string; bcc?: string; subject?: string; text?: string } {
  // mailto:user@example.com?subject=Hello&body=Hi
  const withoutScheme = url.replace(/^mailto:/i, '')
  const [rawTo, queryStr] = withoutScheme.split('?', 2)
  const to = decodeURIComponent(rawTo || '')
  if (!queryStr) return { to }
  const params = new URLSearchParams(queryStr)
  return {
    to,
    cc: params.get('cc') || undefined,
    bcc: params.get('bcc') || undefined,
    subject: params.get('subject') || undefined,
    text: params.get('body') || undefined,
  }
}

/** Queue a mailto URL to open compose when the app is ready. */
let pendingMailtoUrl: string | null = null
function handleMailtoUrl(url: string) {
  if (!app.isReady()) {
    pendingMailtoUrl = url
    return
  }
  const init = { ...parseMailtoUrl(url), source: 'mailto' as const }
  const accountId = getSettings().currentAccountId ?? listAccounts()[0]?.id ?? 1
  composeCtx = { accountId, init }
  openComposeWindow()
}

// macOS: open-url fires when the OS opens our app via protocol
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (url.startsWith('mailto:')) handleMailtoUrl(url)
})

// Linux/Windows: mailto: URL passed as command-line argument on first launch
const launchMailto = process.argv.find(a => a.startsWith('mailto:'))
if (launchMailto) handleMailtoUrl(launchMailto)

import { autoUpdater } from 'electron-updater'
import path from 'node:path'
import fs from 'node:fs'
import dns from 'node:dns'
import { randomUUID, X509Certificate } from 'node:crypto'
import { isTransientNetworkError, isLinuxInstallerError } from '@mailcopilot/core'

// Prefer IPv4: not all networks support IPv6, and DNS round-robin may
// return an unreachable IPv6 address, causing SMTP/IMAP timeouts.
dns.setDefaultResultOrder('ipv4first')
import { domainToUnicode } from 'node:url'
import tls from 'node:tls'
import { z } from 'zod'
import { refreshGoogleAccessToken, runGoogleOAuthFlow } from './googleOAuth'
// Microsoft OAuth low-level flows are now consumed via electron/services/outlookOAuthService.ts
import {
  testImapConnection,
  testSmtpConnection,
  fetchInboxSummaries,
  fetchFolderSummariesPage,
  fetchAllFolderHeaders,
  syncFolderFlagsOnly,
  forceDisconnectImap,
  listMailboxes,
  fetchMessageDetails,
  fetchMessageBody,
  downloadMessagePart,
  parseEmlBuffer,
  extractEmlAttachment,
  EML_ATTACHMENT_PART_PREFIX,
  downloadRawMessage,
  saveEml,
  readEml,
  deleteEmls,
  deleteAccountEmls,
  listAccounts,
  getAccountMeta,
  getAccountConfig,
  getOauthRefreshToken,
  getOauthRefreshTokenWithSource,
  setOauthRefreshToken,
  deleteLegacyGoogleRefreshToken,
  saveAccount,
  deleteAccount,
  sendMail,
  buildRawMessage,
  classifySmtpError,
  SMTP_RETRY_DELAYS_MS,
  setSeen,
  setFlagged,
  startIdle,
  stopIdle,
  saveDraft,
  deleteDraft,
  withSaveDraftLock,
  sweepOrphanDrafts,
  moveMessages,
  deleteMessagesRemote,
  detectFolderRoles,
  appendToMailbox,
  createMailbox,
  renameMailbox,
  deleteMailbox,
  disconnectAllPerAccount,
  emlCacheSizeBytes,
  imapSearchFolder,
  fetchSummariesByUids,
  autoconfig,
  tryAutoUnsubscribe,
  extractUnsubLinksFromHtml,
  getSettings,
  getMcpConnection,
  saveSettings,
  saveMcpConnection,
  deleteMcpConnection,
  listMcpConnections,
  imapSchema,
  smtpSchema,
  accountSaveSchema,
  settingsSchema,
  rendererWritableSettingsSchema,
  mcpSaveConnectionObjectSchema,
  MAIN_ONLY_SETTINGS_FIELDS,
  BODY_RETENTION_DAYS_VALUES,
  DEFAULT_BODY_RETENTION_DAYS,
  isAllowedMcpStdioCommand,
  DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST,
  findForbiddenMcpStdioEnvKeys,
  setMcpEnvSanitizationListener,
} from '../packages/net/index'
import { requestSafeRemoteBytes } from '../packages/net/safeRemoteFetch'
// §2.33 PR2a: setSecretBackend is exported from packages/net/config but is NOT
// re-exported from packages/net/index — import it directly from the config
// module (same style as electron/services/ai.ts), keeping scope to main.ts.
import { setSecretBackend } from '../packages/net/config'
import type { AccountConfig, AccountMeta, AttachmentMeta, CalendarInvite, ComposeInit, FolderRoles, FolderPreference, ImapConfig, Mailbox, MessageDetails, UnsubscribeAttemptResult } from '../packages/net/types'
import { queueItemToComposeInit } from './queueComposeBridge'
import { quickActionRewriteSchema, instantReplyGenerateSchema } from './ipcSchemas'
import {
  MailLinkRouter,
  ANOMALY_WINDOW_MS,
  isAllowedExternalUrl,
  parseRoutedMailLink,
  decideMailLinkAction,
} from './mailLinkRouter'
import {
  ExternalOpenGate,
  EXTERNAL_OPEN_BUCKET_CAPACITY,
  EXTERNAL_OPEN_REFILL_INTERVAL_MS,
  isTrustedOpenSource,
} from './externalOpenGate'
import {
  deleteMessages,
  getMessagesBeforeUid,
  getMessageByUid,
  getUnifiedInboxPage,
  setUnread,
  setFlagged as setFlaggedLocal,
  upsertMessages,
  setBodyDownloaded,
  updateMessageBodyText,
  getUidsWithoutBody,
  getUidsOlderThan,
  previewBodyRetentionImpact,
  sumMessageSizes,
  countBodiesDownloaded,
  getAccountMessageCount,
  searchContacts,
  upsertContactManual,
  upsertContactsOutgoing,
  upsertContactsIncoming,
  enqueueSendQueue,
  type ArchiveRef,
  listSendQueue,
  listDueSendQueue,
  getSendQueueById,
  markSendQueueSending,
  markSendQueueSent,
  markSendQueueFailed,
  cancelSendQueue,
  sendQueueNow,
  rescheduleSendQueue,
  listTlsPins,
  listTlsPinsForEndpoint,
  listTlsPinnedCertsPemForEndpoint,
  upsertTlsPin,
  removeTlsPin,
  listFolderPrefs,
  listFolderStats,
  getFolderPref,
  upsertFolderPref,
  removeFolderPref,
  deleteStaleFolderPrefs,
  deleteFolderCrawlStatesByPaths,
  insertSnooze,
  removeSnooze,
  removeSnoozeByUid,
  listSnoozed,
  listDueSnooze,
  listAllSnoozedUids,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  insertFollowUp,
  removeFollowUp,
  listFollowUps,
  listDueFollowUps,
  dismissFollowUp,
  markFollowUpNotified,
  insertReadLater,
  removeReadLater,
  removeReadLaterByUid,
  listReadLater,
  listAllReadLaterUids,
  cacheFolderRoles,
  getCachedFolderRoles,
  getAllCachedFolderRoles,
  cacheMailboxes,
  getAllCachedMailboxes,
  getAllFolderPrefs,
  getLastAiMessages,
  getAiSession,
  updateAiSessionClaudeId,
  createAiSession,
  listAiSessions,
  updateAiSessionTitle,
  deleteAiSession,
  deleteAllAiSessions,
  insertAiMessage,
  listAiMessages,
  getMaxUidForFolder,
  removeStaleMessages,
  listMailRules,
  createMailRule,
  updateMailRule,
  deleteMailRule,
  getMessagesForRuleTest,
  listAiRules,
  createAiRule,
  updateAiRule,
  deleteAiRule,
  listAiRuleLog,
  insertAiRuleLog,
  sumAiRuleCostSince,
  appendAiActionLog,
  getThreadSummary,
  upsertThreadSummary,
  // §2.51.f2 High-3 — the budget primitives are deliberately NOT imported here
  // any more. Admission, settlement and release all go through
  // `admitBudgetedCall` / `settleReservationUsd` / `releaseReservationNoSpend` in
  // services/ai, which carry the ledger-trust guard and the under-count retry
  // that every paid surface must share. Calling the db primitives directly from
  // main.ts is what let the thread-summary path drift out of that discipline.
  setPinned,
  insertRuleLog,
  listRuleLog,
  upsertFolderCrawlState,
  getFolderCrawlState,
  applyFolderSyncBatch,
  checkpointWal,
  checkpointWalPassive,
  hasBodyTextIndexed,
  getCachedDetail,
  setCachedDetail,
  insertNotification,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  purgeOldNotifications,
  upsertOfflineOp,
  getOfflineOps,
  getSyncState,
  upsertSyncState,
  moveMessagesLocally,
  optimizeFts,
  appendMcpAuditEvent,
  listAiActionLog,
  aggregateAiUsage,
  softDeleteAiActionEntry,
  clearAiActionLog,
  exportAiActionLog,
} from '../packages/db'
import type { TlsPinRow, AiCostReservation } from '../packages/db'
import { matchRule, parseSearchQuery, type MailRule, type MailContext, type RuleAction, type RuleCondition } from '../packages/core'
import {
  AI_RULE_BATCH_SIZE as CORE_AI_RULE_BATCH_SIZE,
  AI_RULE_MAX_CALLS_PER_HOUR,
  estimateAiRuleCostUsd,
  nullUsageReservationUsd,
  type AiRulePendingItem as CoreAiRulePendingItem,
} from '../packages/core'
import {
  createRateLimitState,
  enqueueForAiRules as pipelineEnqueue,
  processAiRuleBatch as pipelineProcessBatch,
  type AiRulesPipelineDeps,
} from './services/aiRulesPipeline'
import { startBodyIndexer, stopBodyIndexer, waitForIdle as waitForBodyIndexerIdle, type FetchBodyFn } from './services/bodyIndexer'
import { replayOfflineOps } from './services/offlineReplay'
import { searchWorkerClient } from './services/searchWorkerClient'
import { canWriteAppDir, classifyUpdateError, detectUpdateChannel, type SystemInfo } from './services/updateCheck'
import { computeOfflineSinceDate } from './services/offlineRetention'
import { reportSentCopyAppendFailure } from './services/sentCopyFailure'
import { getOutlookAccessToken, getOutlookGraphSendAccessToken, clearOutlookTokenCache, forceRefreshOutlookAccessToken, connectOutlookAccount } from './services/outlookOAuthService'
import { secretStore } from './services/secretStore'
import { sendMailViaGraph } from '../packages/net/graphSend'
import { registerAuthErrorHandler, unregisterAuthErrorHandler, registerCertErrorHandler, unregisterCertErrorHandler } from '../packages/net/imap'
import { verifyCertTrust } from '../packages/net/tls'
import { initCertRecovery } from './services/certRecovery'
import { extractIcsFromRawEml } from '../packages/net/message'
import {
  parseCalendarPart,
  registerInviteHandlers,
  toPublicInvite,
  makeInviteCache,
  type RsvpFromResolver,
  type InviteResolver,
  type RsvpSender,
} from './services/inviteBridge'

// §3.10 P0 wave 3 reinforcement: bridge the packages/net settings-migration
// audit hook into the main-side audit pipeline (electron-log + ai_audit_log +
// recordEvent). packages/net stays layer-pure — it only knows about a typed
// listener callback set by main. The listener fires at most once per launch
// (packages/net tracks the "audited this launch" flag internally); we log
// + append + telemetry here rather than inline in config.ts.
//
// Why wire it at module-top rather than inside app.whenReady():
// `getSettings()` is called as early as the file-logging bootstrap below
// (line ~429), long before whenReady. Wiring the listener here guarantees
// that any pre-whenReady sanitization call still routes through the
// audit pipeline, so the wave-2→wave-3 migration event is never lost.
setMcpEnvSanitizationListener(({ stripped }) => {
  try {
    // Aggregate the stripped keys: distinct keys (deduped) and connection
    // count for the log message. Raw values aren't sensitive (loader-hook
    // names are public) but we don't log per-connection details to keep
    // the line compact.
    const uniqueKeys = Array.from(new Set(stripped.map(s => s.key))).sort()
    const affectedConnCount = new Set(
      stripped.map(s => s.id ?? '<unknown>'),
    ).size
    logMcpStdio.warn(
      `Settings migration: stripped ${stripped.length} forbidden env key(s) [${uniqueKeys.join(', ')}] from ${affectedConnCount} mcpConnection(s) (wave-2 → wave-3 env denylist)`,
    )
    appendMcpAuditEvent({
      eventType: 'settings.forbidden_env_key',
      reason: `migration:${uniqueKeys.join(',')}`,
    })
    try {
      const countBucket = stripped.length <= 1 ? '1'
        : stripped.length <= 5 ? '2-5'
          : stripped.length <= 10 ? '6-10'
            : '11+'
      recordEvent('mcp.stdio.env_sanitized_on_load', { count_bucket: countBucket })
    } catch {
      // Telemetry must not block the boot path.
    }
  } catch (err) {
    // The listener itself runs inside a try/catch in packages/net, so
    // throwing here doesn't brick boot — but log for diagnostics.
    try {
      logMcpStdio.warn('env sanitization audit listener failed', err)
    } catch {
      // Logger itself may not be ready in the very early boot window.
    }
  }
})

// §2.33 PR2a: inject the real machine-bound secret backend into packages/net.
// Without this, config.ts keeps its keytar-only default (no disk fallback, no
// keychain telemetry) and managed-Linux-no-keyring installs regress to the
// pre-2.33 hard-fail. Wired at module-top — the earliest pre-whenReady point —
// so it precedes the file-logging bootstrap, all IPC handlers, and every
// background service (periodic sync, IDLE cycle, send-queue, offline replay,
// snooze/follow-up polling). `secretStore` is contravariantly assignable to
// SecretBackend (wider surface union), so no adapter is needed. The injection
// logs nothing sensitive.
setSecretBackend(secretStore)

// `__dirname` points to the `dist-electron` directory (main is built as CommonJS).
process.env.APP_ROOT = path.join(__dirname, '..')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// For e2e/data isolation, userData can be overridden (including localStorage/Chromium profile).
if (process.env.MAILCOPILOT_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MAILCOPILOT_DATA_DIR))
}

// File logging: always in dev, in production — only if debugLogging is enabled in settings.
{
  const isDev = !app.isPackaged
  let debugLogging = false
  try {
    const s = getSettings()
    debugLogging = s?.debugLogging === true
    setSentryUserEnabled(s?.sentryEnabled !== false)
    // Attach the stable anonymous install identity as soon as settings
    // are loaded — Sentry needs this to count unique installs. Safe to
    // call unconditionally because setSentryUserId no-ops when the user
    // toggle is off.
    setSentryUserId(getInstallIdHash())
  } catch { /* settings not ready yet */ }
  initLogger({ fileLogging: isDev || debugLogging })
}

// IPC wiring: the `handleIpc` wrapper, `metrics:record` bridge, renderer
// freeze reporter, and main-loop watchdog all live in `./ipc`, which owns
// the sole `ipcMain` import in the project (see electron/ipc.ts and
// BACKLOG.md §2.13). Register them here, at startup, in the same order
// the previous inline block used.
registerMetricsRecordHandler()
registerUiFreezeHandler()
startMainLoopFreezeWatchdog()

// Zod schemas for IPC parameter validation
const accountIdSchema = z.number().int().positive()
const accountIdsSchema = z.array(accountIdSchema).min(1)
const mailboxSchema = z.string().min(1)
const uidSchema = z.number().int().positive()
const uidsSchema = z.array(uidSchema).min(1)
// §2.7 iter3 (codex security High): hard cap on uids array for pending-move
// IPC handlers. Pending-move is the only IPC path that allocates per-uid
// `NodeJS.Timeout` handles surviving past the call (10s TTL) — a compromised
// renderer could exhaust main-process memory by sending a huge uids array.
// 10000 is generous for legitimate batch operations (Move 1000 messages = OK)
// while blocking adversarial payloads (100k+ entries). Other IPC handlers
// using `uidsSchema` (net:move, net:setSeen, net:setFlagged, net:delete) do
// not allocate persistent per-uid resources, so the global cap stays loose.
const PENDING_MOVE_MAX_UIDS_PER_CALL = 10_000
const pendingMoveUidsSchema = z.array(uidSchema).min(1).max(PENDING_MOVE_MAX_UIDS_PER_CALL)
// §2.7 iter3: cap the registry size per account (sum of uids across all
// folders) so repeated calls cannot accumulate unbounded entries.
const PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT = 50_000
// §2.7 iter4 (codex security High): defense-in-depth global cap on the total
// registry size across all accounts. The per-account cap alone is bypassable
// by a compromised renderer that targets fictitious account IDs (1..N) — each
// fresh accountId allocates its own per-account bucket up to the per-account
// cap, reopening the DoS class. The per-account cap × ~50 accounts (typical
// power-user upper bound) sets the global ceiling at 200000 entries, well
// above legitimate aggregate use yet bounded for hostile callers that pass
// accountId existence (see PENDING_MOVE_REJECT_UNKNOWN_ACCOUNT below) but
// still try to fan out across many real accounts.
const PENDING_MOVE_MAX_REGISTRY_GLOBAL = 200_000
// §2.7 iter3: cap folder-name length to prevent unbounded string allocation
// inside Map keys. Real IMAP folder names are ≤255 chars (RFC 3501); 256
// gives a small margin and stops absurd payloads cleanly.
const PENDING_MOVE_MAX_FOLDER_LEN = 256
const paginationSchema = z.object({ limit: z.number().int().positive(), offset: z.number().int().min(0) })
const beforeUidSchema = z.number().int().positive().optional()
const partSchema = z.string().min(1)
const composeAttachmentSchema = z.object({
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  contentType: z.string().min(1).optional(),
}).strict()
const composeInitSchema = z.object({
  draftId: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z.array(composeAttachmentSchema).optional(),
  replyRef: z.object({
    accountId: accountIdSchema,
    folder: mailboxSchema,
    uid: uidSchema,
  }).optional(),
  originalRecipients: z.array(z.string().email()).optional(),
  source: z.enum(['new', 'reply', 'reply_all', 'forward', 'mailto', 'template', 'ai_chip', 'draft']).optional(),
  // 2.3-B re-review: preserve user-picked identity through queue→cancel→edit.
  // Must stay in sync with the matching field on `ComposeInit`.
  identityId: z.string().min(1).optional(),
}).strict()
const sendMailOptionsSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z.array(composeAttachmentSchema).optional(),
  /**
   * 2.3-B: identity used to produce the From header. When set, the main
   * process resolves the identity from `AccountMeta.identities` and overrides
   * both the displayName and the email in the outgoing From header. Unknown
   * or missing ids fall back to the legacy single-identity resolution path.
   */
  identityId: z.string().min(1).optional(),
})
const delayMsSchema = z.number().int().min(0).max(31 * 24 * 60 * 60 * 1000)
const sendAtIsoSchema = z.string().datetime({ offset: true })
const snoozeWakeAtSchema = z.string().datetime({ offset: true })
const snoozeUidsSchema = z.array(z.number().int().min(1)).min(1).max(500)
const snoozeIdSchema = z.number().int().min(1)
const readLaterUidsSchema = z.array(z.number().int().min(1)).min(1).max(100)
const readLaterIdSchema = z.number().int().min(1)
const templateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().max(500).default(''),
  body: z.string().max(50000).default(''),
  shortcut: z.string().max(50).optional(),
})
const templateUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(50000).optional(),
  shortcut: z.string().max(50).nullable().optional(),
})
const templateIdSchema = z.number().int().min(1)

// Mail Rules (B2.22)
const mailRuleCreateSchema = z.object({
  accountId: z.string().nullable().optional(),
  name: z.string().min(1).max(200),
  conditions: z.string().max(50000),
  actions: z.string().max(10000),
  priority: z.number().int().min(0).max(9999).default(0),
  stopProcessing: z.boolean().default(false),
})
const mailRuleUpdateSchema = z.object({
  accountId: z.string().nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  conditions: z.string().max(50000).optional(),
  actions: z.string().max(10000).optional(),
  stopProcessing: z.boolean().optional(),
})
const mailRuleIdSchema = z.string().uuid()

// AI Rules (B2.23 / §2.39)
const aiRuleCreateSchema = z.object({
  accountId: z.string().nullable().optional(),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(10000),
  allowedActions: z.string().max(5000),
  budgetPerDayUsd: z.number().min(0).max(100).default(0.50),
  // §2.39: a new AI rule is disabled by default. The client may pass
  // `enabled: true` explicitly, but the safe default is inactive.
  enabled: z.boolean().default(false),
})
const aiRuleUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  prompt: z.string().min(1).max(10000).optional(),
  allowedActions: z.string().max(5000).optional(),
  budgetPerDayUsd: z.number().min(0).max(100).optional(),
})
const aiRuleIdSchema = z.string().uuid()
const aiRuleLogLimitSchema = z.number().int().min(1).max(500).default(50)

const queueIdSchema = z.string().min(1).max(128)
type SendMailOptions = z.infer<typeof sendMailOptionsSchema>
// §2.16 iter4 (Low) — draftId flows into Message-Id, X-MailCopilot-Draft-Id,
// IMAP SEARCH terms, log lines, and the drafts:wasSent IPC payload. Tighten
// from `z.string().min(1)` to a bounded alphanumeric/underscore/hyphen token
// (max 64 chars) so any caller-supplied value cannot smuggle CRLF, control
// chars, or oversized blobs into headers/logs. UUIDs (36 chars) and the
// internal randomId() output both fit comfortably.
const draftIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/)
const draftPayloadSchema = z.object({
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
}).strict()
const contactsSearchLimitSchema = z.number().int().positive().max(50).optional()
const e2eLanguageSchema = z.enum(['en', 'ru', 'fr', 'de', 'es', 'it'])
const tlsPinIdSchema = z.number().int().positive()
const tlsPinSchema = z.object({
  accountId: accountIdSchema,
  host: z.string().min(1),
  port: z.number().int().positive(),
  fingerprintSha256: z.string().min(1),
}).strict()
// Renderer-driven certificate probe target. Bounded on both axes: `positive()`
// alone accepted port 70000 and a megabyte-long host, i.e. main would open a
// socket for anything the renderer named. 253 = max DNS name length.
const tlsServerSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
}).strict()
/**
 * TLS trust rework — `net:trustCert` payload.
 *
 * Deliberately STRICTER than `tlsPinSchema` (which serves the Settings UI,
 * where the user types an arbitrary endpoint on purpose). This channel is
 * driven by a dialog the main process itself opened, so a payload that does
 * not describe one of the account's own endpoints is either stale or forged:
 * accepting it would let a compromised renderer pin an attacker-chosen
 * fingerprint onto an unrelated host. Shape validation here, endpoint
 * ownership in the handler.
 *
 * - port: full 1..65535 range (tlsPinSchema's `positive()` accepts 70000).
 * - fingerprint: SHA-256 only — 64 hex chars, optionally colon/dash grouped;
 *   canonicalized before it reaches the pin store.
 */
const SHA256_FINGERPRINT_RE = /^(?:[0-9a-fA-F]{2}[:-]){31}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{64}$/
const certTrustSchema = z.object({
  accountId: accountIdSchema,
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  fingerprintSha256: z.string().trim().regex(SHA256_FINGERPRINT_RE),
}).strict()
// Phase A2 — cert:dismiss carries the host whose recovery dialog the user
// declined; `port` is optional (older renderer builds send host only, in
// which case every pending endpoint of that host is resolved).
// 253 = max DNS name length.
const certDismissSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).optional(),
}).strict()

/** Canonical SHA-256 fingerprint: uppercase hex byte pairs joined by ':'.
 *  `normalizeFingerprintSha256` (packages/net) only uppercases and swaps '-'
 *  for ':', so a bare 64-hex string would be stored in a different shape than
 *  the colon-grouped form the pin comparison expects. */
function canonicalFingerprintSha256(raw: string): string {
  const hex = raw.replace(/[:-]/g, '').toUpperCase()
  return (hex.match(/.{2}/g) ?? []).join(':')
}

/** Host comparison form for endpoint-ownership checks (see certRecovery's
 *  normalizeCertHost — same rule, kept local to avoid a service import in the
 *  schema section). */
function normalizeEndpointHost(host: string): string {
  return (host || '').trim().toLowerCase().replace(/\.+$/, '')
}
const folderPrefPatchSchema = z.object({
  visible: z.boolean().optional(),
  includeInBadges: z.boolean().optional(),
  headerSyncMode: z.enum(['full', 'on_open', 'period', 'off']).optional(),
  headerSyncDays: z.number().int().positive().optional(),
  offlineMode: z.enum(['off', 'period', 'full']).optional(),
  offlineDays: z.number().int().positive().optional(),
  icon: z.string().max(8).optional(),
  // §2.15-ter: per-folder search index gate. Defaults to true at creation
  // time (column DEFAULT 1) and is auto-disabled for Junk/Spam/Trash by
  // ensureFolderPrefs(); user toggles via the folder context menu.
  indexInSearch: z.boolean().optional(),
}).strict()
const syncFolderHeadersOptionsSchema = z.object({
  mode: z.enum(['full', 'period']).optional(),
  days: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().max(500).optional(),
  maxBatches: z.number().int().positive().max(5000).optional(),
}).strict().optional()

const IS_E2E = process.env.MAILCOPILOT_E2E === '1'

/**
 * Defense-in-depth guard for renderer-exposed `e2e:*` IPC handlers.
 *
 * The handlers (`e2e:localizeMails`, `e2e:injectCalendarMail`, `e2e:injectMail`)
 * exist solely so Playwright specs can seed deterministic mail fixtures into
 * the in-memory `E2E_BOXES` store. They MUST NOT be invokable from a packaged
 * build under any circumstances — even if an attacker manages to inject
 * `MAILCOPILOT_E2E=1` into the runtime environment (wrapper script, dropper,
 * shell profile). A successful invocation would let arbitrary mail content
 * appear in the UI as if it came from the user's IMAP server.
 *
 * `app.isPackaged === true` whenever the build was produced by electron-builder
 * (DMG / AppImage / NSIS / deb / rpm), regardless of any env tampering, so
 * combining it with the env flag closes the env-injection escape. Dev runs
 * (`electron .`) and Playwright runs (`vite build --mode e2e && electron-builder
 * install-app-deps && playwright test`) keep `isPackaged === false`, so the
 * legitimate e2e flow continues to work.
 *
 * On a packaged-build invocation we also fire a Sentry breadcrumb because it
 * is a high-signal anomaly: a benign user cannot trigger it.
 *
 * See `electron/main.e2eGuard.test.ts` for the truth table.
 */
function assertE2EHandlerAllowed(channel: string): void {
  if (app.isPackaged) {
    // Fire-and-forget; captureException is wrapped to never throw.
    captureException(new Error(`${channel} called in packaged build`), {
      source: 'security:e2e_guard',
      channel,
    })
    throw new Error(`${channel} is disabled in packaged builds`)
  }
  if (!IS_E2E) throw new Error(`${channel} is only available in e2e mode`)
}

// E2E: deterministic stubs for UI tests without real IMAP/SMTP/CalDAV.
let E2E_CURRENT_ACCOUNT_ID = 1
const E2E_ACCOUNTS: AccountMeta[] = [
  {
    id: 1,
    name: 'E2E One',
    colorIndex: 0,
    providerId: 'generic-imap',
    transportType: 'imap-smtp',
    imap: { host: 'imap1.example.test', port: 993, secure: true, user: 'e2e1@example.test' },
    smtp: { host: 'smtp1.example.test', port: 465, secure: true, user: 'e2e1@example.test' },
    folderRoles: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Junk', archive: 'Archive' },
    // Deterministic identity id so e2e snapshots stay stable.
    identities: [{
      id: 'e2e-identity-1',
      displayName: 'E2E One',
      email: 'e2e1@example.test',
      isDefault: true,
    }],
  },
  {
    id: 2,
    name: 'E2E Two',
    colorIndex: 1,
    providerId: 'generic-imap',
    transportType: 'imap-smtp',
    imap: { host: 'imap2.example.test', port: 993, secure: true, user: 'e2e2@example.test' },
    smtp: { host: 'smtp2.example.test', port: 465, secure: true, user: 'e2e2@example.test' },
    folderRoles: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Junk', archive: 'Archive' },
    identities: [{
      id: 'e2e-identity-2',
      displayName: 'E2E Two',
      email: 'e2e2@example.test',
      isDefault: true,
    }],
  },
]

type E2EMail = {
  uid: number
  from: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  date: string
  unread: boolean
  flagged: boolean
  messageId?: string
  inReplyTo?: string
  references?: string
  hasAttachments?: boolean
  text?: string
  html?: string
  attachments?: AttachmentMeta[]
  draftId?: string
  /** §2.22 — calendar invite fixture for e2e RSVP flow tests. */
  calendarInvite?: CalendarInvite
}

let E2E_UID_SEQ = 300
const E2E_DRAFT_UID_BY_ID = new Map<string, number>()

type E2ELanguage = z.infer<typeof e2eLanguageSchema>
type E2EText = {
  firstSubject: string
  firstBody: string
  htmlSubject: string
  htmlIntro: string
  marketingSubject: string
  marketingIntro: string
  marketingPoint1: string
  marketingPoint2: string
  marketingPoint3: string
  marketingFooter: string
  secondSubject: string
  secondBody: string
  flaggedSubject: string
  flaggedBody: string
  threadRootSubject: string
  threadRootBody: string
  threadReplySubject: string
  threadReplyBody: string
  account2FirstSubject: string
  account2FirstBody: string
}

const E2E_TEXTS: Record<E2ELanguage, E2EText> = {
  en: {
    firstSubject: 'E2E1: first email',
    firstBody: 'E2E test email for account 1.\n\nCheck that opening and text rendering work.',
    htmlSubject: 'E2E1: html email',
    htmlIntro: 'E2E: HTML email for privacy/links/inline images checks.',
    marketingSubject: 'MailCopilot: weekly inbox digest',
    marketingIntro: 'Your inbox is under control this week.',
    marketingPoint1: '12 important threads processed',
    marketingPoint2: '4 drafts prepared with AI assistance',
    marketingPoint3: '0 delayed replies in priority folders',
    marketingFooter: 'Open MailCopilot and finish your review in under 10 minutes.',
    secondSubject: 'E2E1: second email',
    secondBody: 'Second E2E message for account 1.',
    flaggedSubject: 'E2E1: flagged email',
    flaggedBody: 'Starred email (⭐) for filter checks (account 1).',
    threadRootSubject: 'E2E1: thread root',
    threadRootBody: 'Thread root message',
    threadReplySubject: 'Re: E2E1: thread root',
    threadReplyBody: 'Thread reply message',
    account2FirstSubject: 'E2E2: first email',
    account2FirstBody: 'E2E test email for account 2.',
  },
  ru: {
    firstSubject: 'E2E1: первое письмо',
    firstBody: 'Тестовое письмо для e2e (аккаунт 1).\n\nПроверяем открытие и отображение текста.',
    htmlSubject: 'E2E1: html письмо',
    htmlIntro: 'E2E: HTML письмо для проверки privacy/links/inline images.',
    marketingSubject: 'MailCopilot: еженедельный дайджест inbox',
    marketingIntro: 'На этой неделе входящие под контролем.',
    marketingPoint1: '12 важных цепочек уже разобраны',
    marketingPoint2: '4 черновика подготовлены с помощью AI',
    marketingPoint3: '0 просроченных ответов в приоритетных папках',
    marketingFooter: 'Откройте MailCopilot и завершите разбор почты меньше чем за 10 минут.',
    secondSubject: 'E2E1: второе письмо',
    secondBody: 'Второе тестовое письмо для e2e (аккаунт 1).',
    flaggedSubject: 'E2E1: flagged письмо',
    flaggedBody: 'Письмо с флагом (⭐) для проверки фильтров (аккаунт 1).',
    threadRootSubject: 'E2E1: thread root',
    threadRootBody: 'Thread root message',
    threadReplySubject: 'Re: E2E1: thread root',
    threadReplyBody: 'Thread reply message',
    account2FirstSubject: 'E2E2: первое письмо',
    account2FirstBody: 'Тестовое письмо для e2e (аккаунт 2).',
  },
  fr: {
    firstSubject: 'E2E1: premier e-mail',
    firstBody: "E-mail de test E2E pour le compte 1.\n\nVerifiez l'ouverture et l'affichage du texte.",
    htmlSubject: 'E2E1: e-mail HTML',
    htmlIntro: 'E2E: e-mail HTML pour verifier privacy/links/inline images.',
    marketingSubject: 'MailCopilot: digest hebdomadaire de la boite de reception',
    marketingIntro: 'Votre boite de reception est sous controle cette semaine.',
    marketingPoint1: '12 fils importants traites',
    marketingPoint2: '4 brouillons prepares avec aide IA',
    marketingPoint3: '0 reponse en retard dans les dossiers prioritaires',
    marketingFooter: 'Ouvrez MailCopilot et terminez votre tri en moins de 10 minutes.',
    secondSubject: 'E2E1: deuxieme e-mail',
    secondBody: 'Deuxieme e-mail de test E2E pour le compte 1.',
    flaggedSubject: 'E2E1: e-mail marque',
    flaggedBody: 'E-mail marque (⭐) pour verifier les filtres (compte 1).',
    threadRootSubject: 'E2E1: racine du fil',
    threadRootBody: 'Message racine du fil',
    threadReplySubject: 'Re: E2E1: racine du fil',
    threadReplyBody: 'Reponse du fil',
    account2FirstSubject: 'E2E2: premier e-mail',
    account2FirstBody: 'E-mail de test E2E pour le compte 2.',
  },
  de: {
    firstSubject: 'E2E1: erste E-Mail',
    firstBody: 'E2E-Test-E-Mail fuer Konto 1.\n\nPruefen Sie das Oeffnen und die Textdarstellung.',
    htmlSubject: 'E2E1: HTML-E-Mail',
    htmlIntro: 'E2E: HTML-E-Mail fuer privacy/links/inline images Tests.',
    marketingSubject: 'MailCopilot: woechentlicher Inbox-Report',
    marketingIntro: 'Ihr Posteingang ist diese Woche unter Kontrolle.',
    marketingPoint1: '12 wichtige Threads bearbeitet',
    marketingPoint2: '4 Entwuerfe mit KI-Hilfe vorbereitet',
    marketingPoint3: '0 ueberfaellige Antworten in Prioritaetsordnern',
    marketingFooter: 'Oeffnen Sie MailCopilot und schliessen Sie den Review in unter 10 Minuten ab.',
    secondSubject: 'E2E1: zweite E-Mail',
    secondBody: 'Zweite E2E-Test-E-Mail fuer Konto 1.',
    flaggedSubject: 'E2E1: markierte E-Mail',
    flaggedBody: 'Markierte E-Mail (⭐) fuer Filtertests (Konto 1).',
    threadRootSubject: 'E2E1: Thread-Start',
    threadRootBody: 'Thread-Startnachricht',
    threadReplySubject: 'Re: E2E1: Thread-Start',
    threadReplyBody: 'Thread-Antwortnachricht',
    account2FirstSubject: 'E2E2: erste E-Mail',
    account2FirstBody: 'E2E-Test-E-Mail fuer Konto 2.',
  },
  es: {
    firstSubject: 'E2E1: primer correo',
    firstBody: 'Correo de prueba E2E para la cuenta 1.\n\nComprueba la apertura y el renderizado del texto.',
    htmlSubject: 'E2E1: correo HTML',
    htmlIntro: 'E2E: correo HTML para verificar privacy/links/inline images.',
    marketingSubject: 'MailCopilot: resumen semanal de bandeja',
    marketingIntro: 'Tu bandeja de entrada esta bajo control esta semana.',
    marketingPoint1: '12 hilos importantes procesados',
    marketingPoint2: '4 borradores preparados con ayuda de IA',
    marketingPoint3: '0 respuestas atrasadas en carpetas prioritarias',
    marketingFooter: 'Abre MailCopilot y completa la revision en menos de 10 minutos.',
    secondSubject: 'E2E1: segundo correo',
    secondBody: 'Segundo correo de prueba E2E para la cuenta 1.',
    flaggedSubject: 'E2E1: correo destacado',
    flaggedBody: 'Correo destacado (⭐) para verificar filtros (cuenta 1).',
    threadRootSubject: 'E2E1: inicio del hilo',
    threadRootBody: 'Mensaje inicial del hilo',
    threadReplySubject: 'Re: E2E1: inicio del hilo',
    threadReplyBody: 'Respuesta del hilo',
    account2FirstSubject: 'E2E2: primer correo',
    account2FirstBody: 'Correo de prueba E2E para la cuenta 2.',
  },
  it: {
    firstSubject: 'E2E1: prima email',
    firstBody: "Email di test E2E per l'account 1.\n\nVerifica apertura e rendering del testo.",
    htmlSubject: 'E2E1: email HTML',
    htmlIntro: 'E2E: email HTML per verificare privacy/links/inline images.',
    marketingSubject: 'MailCopilot: riepilogo settimanale inbox',
    marketingIntro: "La tua inbox e sotto controllo questa settimana.",
    marketingPoint1: '12 thread importanti gia gestiti',
    marketingPoint2: "4 bozze preparate con l'aiuto dell'AI",
    marketingPoint3: '0 risposte in ritardo nelle cartelle prioritarie',
    marketingFooter: 'Apri MailCopilot e completa la revisione in meno di 10 minuti.',
    secondSubject: 'E2E1: seconda email',
    secondBody: 'Seconda email di test E2E per account 1.',
    flaggedSubject: 'E2E1: email con stella',
    flaggedBody: 'Email con stella (⭐) per verificare i filtri (account 1).',
    threadRootSubject: 'E2E1: radice thread',
    threadRootBody: 'Messaggio radice del thread',
    threadReplySubject: 'Re: E2E1: radice thread',
    threadReplyBody: 'Risposta del thread',
    account2FirstSubject: 'E2E2: prima email',
    account2FirstBody: 'Email di test E2E per account 2.',
  },
}

function buildE2EBoxes(lang: E2ELanguage): Record<number, Record<string, E2EMail[]>> {
  const t = E2E_TEXTS[lang]
  return {
    1: {
      INBOX: [
        {
          uid: 101,
          from: 'alice@example.test',
          to: 'e2e1@example.test, bob@example.test',
          cc: 'carol@example.test',
          subject: t.firstSubject,
          date: '2026-02-08T00:00:00.000Z',
          unread: true,
          flagged: false,
          text: t.firstBody,
        },
        {
          uid: 100,
          from: 'alice@example.test',
          to: 'e2e1@example.test',
          subject: t.htmlSubject,
          date: '2026-02-08T00:05:00.000Z',
          unread: false,
          flagged: false,
          hasAttachments: true,
          text: t.htmlIntro,
          html: [
            '<div>',
            `<p><b>E2E:</b> ${t.htmlIntro}</p>`,
            '<p><a href="http://xn--e1awd7f.com/phish">google.com</a></p>',
            '<p><img alt="pixel" src="https://tracker.example.test/pixel.png" /></p>',
            '<p><img alt="inline" src="cid:img1" /></p>',
            '</div>',
          ].join(''),
          attachments: [
            { part: '2', disposition: 'inline', contentType: 'image/png', cid: 'img1', filename: undefined, size: 3 },
            { part: '3', disposition: 'attachment', contentType: 'application/pdf', cid: undefined, filename: 'report.pdf', size: 12345 },
          ],
        },
        {
          uid: 104,
          from: 'MailCopilot Team <product@mailcopilot.io>',
          to: 'e2e1@example.test',
          subject: t.marketingSubject,
          date: '2026-02-08T00:07:00.000Z',
          unread: false,
          flagged: false,
          text: [
            t.marketingIntro,
            `- ${t.marketingPoint1}`,
            `- ${t.marketingPoint2}`,
            `- ${t.marketingPoint3}`,
            '',
            t.marketingFooter,
          ].join('\n'),
          html: [
            '<div style="font-family:Inter,Segoe UI,Arial,sans-serif; max-width:660px; margin:0 auto; color:#0f172a; line-height:1.5;">',
            '<div style="background:linear-gradient(135deg,#0ea5e9,#2563eb); color:#fff; border-radius:14px; padding:20px 22px; margin:0 0 14px;">',
            `<h2 style="margin:0 0 8px; font-size:22px;">${t.marketingSubject}</h2>`,
            `<p style="margin:0; opacity:.95;">${t.marketingIntro}</p>`,
            '</div>',
            '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; background:#f8fafc;">',
            '<ul style="margin:0; padding-left:18px;">',
            `<li style="margin:0 0 6px;">${t.marketingPoint1}</li>`,
            `<li style="margin:0 0 6px;">${t.marketingPoint2}</li>`,
            `<li>${t.marketingPoint3}</li>`,
            '</ul>',
            '</div>',
            `<p style="margin:14px 0 0; color:#334155;">${t.marketingFooter}</p>`,
            '</div>',
          ].join(''),
        },
        {
          uid: 102,
          from: 'bob@example.test',
          to: 'e2e1@example.test',
          subject: t.secondSubject,
          date: '2026-02-08T00:10:00.000Z',
          unread: false,
          flagged: false,
          text: t.secondBody,
        },
        {
          uid: 103,
          from: 'carol@example.test',
          to: 'e2e1@example.test',
          subject: t.flaggedSubject,
          date: '2026-02-08T00:20:00.000Z',
          unread: false,
          flagged: true,
          text: t.flaggedBody,
        },
        {
          uid: 89,
          from: 'alice@example.test',
          to: 'e2e1@example.test',
          subject: t.threadRootSubject,
          date: '2026-02-08T00:40:00.000Z',
          unread: false,
          flagged: false,
          text: t.threadRootBody,
          messageId: '<e2e-thread-root@example.test>',
        },
        {
          uid: 88,
          from: 'e2e1@example.test',
          to: 'alice@example.test',
          subject: t.threadReplySubject,
          date: '2026-02-08T00:41:00.000Z',
          unread: false,
          flagged: false,
          text: t.threadReplyBody,
          messageId: '<e2e-thread-reply@example.test>',
          inReplyTo: '<e2e-thread-root@example.test>',
          references: '<e2e-thread-root@example.test>',
        },
      ],
      Sent: [],
      Drafts: [],
      Trash: [],
      Junk: [],
      Archive: [],
    },
    2: {
      INBOX: [
        {
          uid: 201,
          from: 'dave@example.test',
          to: 'e2e2@example.test',
          subject: t.account2FirstSubject,
          date: '2026-02-08T00:30:00.000Z',
          unread: true,
          flagged: false,
          text: t.account2FirstBody,
        },
      ],
      Sent: [],
      Drafts: [],
      Trash: [],
      Junk: [],
      Archive: [],
    },
  }
}

let E2E_LANGUAGE: E2ELanguage = 'ru'
let E2E_BOXES: Record<number, Record<string, E2EMail[]>> = buildE2EBoxes(E2E_LANGUAGE)

function e2eBoxes(accountId: number): Record<string, E2EMail[]> {
  if (!E2E_BOXES[accountId]) E2E_BOXES[accountId] = {}
  return E2E_BOXES[accountId]
}

function e2eBox(accountId: number, path: string): E2EMail[] {
  const boxes = e2eBoxes(accountId)
  if (!boxes[path]) boxes[path] = []
  return boxes[path]
}

function e2eFindInAnyBox(accountId: number, uid: number): E2EMail | undefined {
  for (const box of Object.values(e2eBoxes(accountId))) {
    const found = box.find(m => m.uid === uid)
    if (found) return found
  }
  return undefined
}

function parseDisplayAddress(raw: string): { name?: string; address?: string } {
  const s = (raw || '').trim()
  if (!s) return {}
  const m = s.match(/^(.*)<([^>]+)>$/)
  if (m) {
    const name = m[1]?.replace(/^"|"$/g, '').trim()
    const address = (m[2] || '').trim()
    return { name: name || undefined, address: address || undefined }
  }
  // Fallback: if it looks like an email or similar — treat as address.
  if (s.includes('@')) return { address: s }
  return { name: s }
}

function parseDisplayAddressList(rawList: string | undefined): Array<{ name?: string; address?: string }> {
  const s = (rawList || '').trim()
  if (!s) return []
  return s
    .split(',')
    .map(x => parseDisplayAddress(x))
    .filter(x => Boolean((x.address || '').trim()))
}

function displayFromParts(raw: string): { from: string; fromAddr: string; fromName?: string } {
  const p = parseDisplayAddress(raw)
  const fromAddr = (p.address || '').trim()
  const fromName = (p.name || '').trim() || undefined
  const from = (fromName || fromAddr || '').trim()
  return { from, fromAddr: fromAddr || raw.trim(), fromName }
}

function htmlToPlainText(html: string): string {
  return (html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function getSearchableBodyText(details: { text?: string; html?: string }): string | null {
  const text = (details.text || '').trim()
  if (text) return text
  const html = (details.html || '').trim()
  if (!html) return null
  const plain = htmlToPlainText(html)
  return plain || null
}

function e2eMailboxes(accountId: number) {
  const unreadCount = (path: string) => e2eBox(accountId, path).filter(m => m.unread).length
  const draftsCount = e2eBox(accountId, 'Drafts').length
  return [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unread: unreadCount('INBOX') },
    { path: 'Sent', name: 'Sent', specialUse: '\\Sent', unread: undefined },
    // For Drafts, show draft count (not UNSEEN): so the UI can display a badge.
    { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', unread: draftsCount > 0 ? draftsCount : undefined },
    { path: 'Trash', name: 'Trash', specialUse: '\\Trash', unread: undefined },
    { path: 'Junk', name: 'Junk', specialUse: '\\Junk', unread: unreadCount('Junk') || undefined },
    { path: 'Archive', name: 'Archive', specialUse: '\\Archive', unread: unreadCount('Archive') || undefined },
  ] as const
}

// Enable CDP port via app.commandLine, since Electron v30+ uses the Node argument parser
// and may reject Chromium flags like --remote-debugging-port when launched through wrappers.
// MAILCOPILOT_E2E_CDP_PORT — for e2e tests (requires IS_E2E).
// MAILCOPILOT_CDP_PORT     — for demos/debugging without e2e mocks (e.g. OAuth demo video).
{
  const cdpPort = (IS_E2E && process.env.MAILCOPILOT_E2E_CDP_PORT) || process.env.MAILCOPILOT_CDP_PORT
  if (cdpPort) app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
}

// Linux: set X11 WM_CLASS so the window manager associates the running window
// with our .desktop file's StartupWMClass=MailCopilot, instead of creating a
// separate "Electron" taskbar group when launched in dev mode (where the
// Electron binary is `node_modules/.bin/electron`, not the renamed production
// binary). Skip in E2E to avoid interfering with parallel test isolation.
if (process.platform === 'linux' && !IS_E2E) {
  app.commandLine.appendSwitch('class', 'MailCopilot')
}

let win: BrowserWindow | null

// External-link protocol allowlist, `mailcopilot-link://` routing parser and
// the `will-frame-navigate` decision logic live in ./mailLinkRouter (pure, no
// Electron imports, unit-tested) and are imported above.

function dirSizeBytes(root: string): number {
  try {
    const st = fs.statSync(root)
    if (!st.isDirectory()) return st.size
  } catch {
    return 0
  }

  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        try { total += fs.statSync(p).size } catch { /* ignore */ }
      }
    }
  }
  return total
}

// §2.25 (re-diagnosis) — the single, process-wide choke point in front of
// every shell.openExternal. See electron/externalOpenGate.ts for the full
// rationale: the 2026-05-22 / 2026-06-09 tab storms were an OS-level
// xdg-open/snap-firefox re-launch loop, and the app's job is to refuse to be
// the amplifier. Two token buckets keyed by trust class: the untrusted bucket
// fronts every email-/renderer-driven open (window-open handler, ui:openExternal
// IPC, mail_link, unsubscribe fallback), the trusted bucket fronts app-constructed
// opens (OAuth, update dialogs). The isolation means a content-driven storm can
// drain the untrusted bucket without ever starving a legitimate auth/update flow.
const logExternalOpen = createLogger('ExternalOpen')
// Two buckets keyed by trust class (see isTrustedOpenSource /
// TRUSTED_OPEN_SOURCES in externalOpenGate.ts). The untrusted bucket fronts
// every email-content-/renderer-driven open ('window_open', 'ui_ipc',
// 'mail_link', 'unsubscribe'); the trusted bucket fronts app-constructed,
// user-initiated opens ('oauth', 'update_dialog'). Isolating them means an
// email-content open storm can drain the untrusted bucket without ever
// starving a legitimate OAuth/update open. Same capacity/refill for both —
// the isolation is the protection, not a larger limit.
const externalOpenGateUntrusted = new ExternalOpenGate()
const externalOpenGateTrusted = new ExternalOpenGate()

/**
 * The ONLY place in the main process that calls `shell.openExternal`. Every
 * external-open path funnels through here so the rate limiter (and the
 * URL-protocol validation) cannot be bypassed.
 *
 * Behaviour:
 *   - no-op in IS_E2E (preserves existing e2e behaviour — tests never spawn a
 *     real browser);
 *   - validates the protocol with `isAllowedExternalUrl` (defence in depth —
 *     most call sites already validate, but this guarantees the invariant at
 *     the choke point);
 *   - consults the token-bucket gate; on denial it records an aggregate
 *     metric and, once per storm, logs + reports a Sentry anomaly — carrying
 *     ONLY the call-site `source` and aggregate counts, NEVER the URL
 *     (CLAUDE.md §8 PII rule);
 *   - on success dispatches `shell.openExternal` fire-and-forget (NOT awaited)
 *     so a hung xdg-open chain can never hold a caller — notably the
 *     `ui:openExternal` IPC reply — hostage. Both a synchronous throw and an
 *     async rejection are swallowed (the latter via an attached `.catch`, so it
 *     never escapes to the global `unhandledRejection` handler with a raw,
 *     URL-bearing message); this function never rejects.
 *
 * Returns the DISPATCH decision (NOT the OS completion): `true` only when the
 * URL passed protocol validation AND the trust-class gate granted a token AND
 * `shell.openExternal` was invoked without throwing synchronously. Callers that
 * report a user-facing result (the unsubscribe browser fallback) MUST use this
 * to avoid claiming "opened in browser" for a request the gate suppressed. In
 * IS_E2E the dispatch is a no-op but the decision is `true` (the URL would have
 * been dispatched — preserving the pre-gate observable result for e2e).
 */
async function openExternalGated(url: string, source: string): Promise<boolean> {
  if (IS_E2E) return true
  if (!isAllowedExternalUrl(url)) {
    // Sanitized: log only the call-site tag, never the rejected URL.
    logExternalOpen.warn(`blocked external open: disallowed protocol from source=${source}`)
    return false
  }

  // Route to the trust-class bucket: email-content-/renderer-driven opens use
  // the untrusted bucket, app-constructed user-initiated opens the trusted one,
  // so a content-driven storm cannot starve OAuth/update opens.
  const gate = isTrustedOpenSource(source) ? externalOpenGateTrusted : externalOpenGateUntrusted
  const decision = gate.tryAcquire()
  if (!decision.allowed) {
    // Aggregate metric on every denial (10s-windowed — a storm collapses to a
    // few count records). Wrapped: telemetry must never break this path.
    try { recordEvent('links.external_open_suppressed', { source }) } catch { /* telemetry must not block */ }
    // Bounded logging: one warn at the start of a dry spell and one at the
    // storm anomaly — NOT one per suppressed call (a runaway can be thousands;
    // flooding the log would defeat the purpose). suppressedCount/source are
    // aggregate, PII-clean.
    if (decision.suppressedCount === 1 || decision.anomaly) {
      logExternalOpen.warn(`external open suppressed by gate source=${source} suppressedCount=${decision.suppressedCount ?? 0}${decision.anomaly ? ' (storm anomaly)' : ''}`)
    }
    if (decision.anomaly) {
      captureException(new Error('external open storm suppressed by gate'), {
        source: 'externalOpenGate',
        openSource: source,
        suppressedCount: decision.suppressedCount,
        capacity: EXTERNAL_OPEN_BUCKET_CAPACITY,
        refillIntervalMs: EXTERNAL_OPEN_REFILL_INTERVAL_MS,
      })
    }
    return false
  }

  try {
    // Fire-and-forget by design — see the docstring. Electron 40 on Linux
    // resolves this fast, but we never await it from any caller. The attached
    // `.catch` keeps an async rejection (e.g. a failing xdg-open handler) from
    // escaping to the global `unhandledRejection` handler, which would log the
    // raw — URL-bearing — rejection reason. Sanitized: code/source only.
    void shell.openExternal(url).catch((err) => {
      logExternalOpen.warn(`shell.openExternal rejected for source=${source}: ${(err as { code?: string })?.code ?? 'unknown'}`)
    })
  } catch (err) {
    // shell.openExternal can throw synchronously for a malformed handler.
    // Sanitized: code/source only, never the URL or err.message.
    logExternalOpen.warn(`shell.openExternal threw for source=${source}: ${(err as { code?: string })?.code ?? 'unknown'}`)
    return false
  }
  return true
}

function configureExternalLinks(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalGated(url, 'window_open')
    return { action: 'deny' }
  })

  // §2.25 — per-webContents idempotency + circuit breaker for the renderer
  // `mail:link` routing path. NOTE (re-diagnosed 2026-06-09): the original
  // tab-storm root cause was an OS-level xdg-open/snap-firefox re-launch loop,
  // NOT Chromium re-firing navigation events — a live repro showed one click =
  // exactly one will-navigate (see mailLinkRouter.ts header + BACKLOG §2.25).
  // This router stays as defence-in-depth against renderer-side or
  // queued-event `mail:link` floods (a renderer bug, an event backlog flushing
  // after a freeze, or a compromised renderer). The machine-crushing OS loop
  // is bounded one layer down by the process-wide externalOpenGate. Two layers,
  // both in the router (pure, unit-tested in mailLinkRouter.test.ts):
  //   1. dedup — collapses identical-URL firings within DEDUP_WINDOW_MS into
  //      one `mail:link`;
  //   2. circuit breaker — once emissions spike past ANOMALY_THRESHOLD, the
  //      router latches into a suppression state and `shouldEmit` returns
  //      false for EVERY url until cooldown. That is the real STOP: while
  //      the breaker is open `emitMailLink` never reaches `webContents.send`,
  //      so the renderer stops opening tabs and shell.openExternal stops
  //      being called — the runaway halts instead of merely slowing down.
  const linkRouter = new MailLinkRouter()

  // Single funnel for every routed `mail:link` emission. `shouldEmit` gates
  // on BOTH layers (breaker first, then dedup); `payload` carries the
  // original href so two events resolving to the same external URL dedup
  // correctly regardless of which interceptor (will-navigate /
  // will-frame-navigate) observed them.
  const emitMailLink = (payload: { href: string; text: string; unsafeBypass?: boolean }) => {
    // shouldEmit returns false while the circuit breaker is open — once a
    // runaway is detected NO further emission gets through, so the send
    // below (and the downstream shell.openExternal) is genuinely stopped.
    if (!linkRouter.shouldEmit(payload.href)) return
    const { recentCount, breakerTripped } = linkRouter.noteEmit(payload.href)
    if (w.isDestroyed()) return
    w.webContents.send('mail:link', payload)
    if (breakerTripped) {
      // Report exactly once per trip — on the emission that opened the
      // breaker. From here on `shouldEmit` suppresses every url until
      // cooldown, so this `mail:link` is the LAST one that goes out. The
      // wording is accurate: the runaway is now actually halted, not just
      // reported. Sanitized — only the count and window reach Sentry,
      // never the user-controlled href/text (CLAUDE.md §8 PII rule).
      logMain.warn(`mail:link routing runaway halted — circuit breaker tripped after ${recentCount} emissions within ${ANOMALY_WINDOW_MS}ms; suppressing all mail:link emissions for the cooldown`)
      captureException(new Error('mail:link routing runaway halted by circuit breaker'), {
        source: 'configureExternalLinks:runaway',
        recentEmitCount: recentCount,
        windowMs: ANOMALY_WINDOW_MS,
      })
    }
  }

  // Intercept links from sandboxed iframe (HTML emails): renderer rewrites <a> to mailcopilot-link://...
  // Here we prevent navigation and send the original href back to renderer to show the phishing prompt.
  w.webContents.on('will-navigate', (event, url) => {
    const parsed = parseRoutedMailLink(url)
    if (!parsed) return
    event.preventDefault()
    emitMailLink(parsed)
  })

  // `will-frame-navigate` catches navigations inside the sandboxed email
  // iframe. Electron 40 types it natively (`electron.d.ts`:
  // `on(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void)`)
  // — the listener receives a SINGLE details object with `.url`, `.isMainFrame`
  // and `.preventDefault()`. (This differs from `will-navigate` above, which
  // still passes `url` as a deprecated positional arg — Electron is
  // inconsistent between the two events.) An earlier `as unknown as { on }`
  // cast read positional args here, so `url` was always `''` and the raw-link
  // safety net below was dead. The typed `.on()` lets `tsc` verify the shape.
  //
  // The routing decision is delegated to the pure, unit-tested
  // `decideMailLinkAction` in ./mailLinkRouter:
  //   - main-frame navigation              → ignore;
  //   - `mailcopilot-link://` routed URL   → preventDefault + emit the
  //     de-referenced href (renderer shows the phishing prompt);
  //   - raw allowed-external URL that escaped rewriteMailHtmlLinks()
  //     → preventDefault + emit with `unsafeBypass: true` so the renderer's
  //     link-warning UI fires unconditionally. This is the defense-in-depth
  //     net (codex-security-review HIGH B4): a raw link that escaped the
  //     rewriter is forced through the phishing prompt instead of being
  //     opened directly via shell.openExternal.
  w.webContents.on('will-frame-navigate', (details) => {
    const action = decideMailLinkAction({ url: details.url, isMainFrame: details.isMainFrame })
    if (action.kind === 'ignore') return
    details.preventDefault()
    emitMailLink(action.payload)
  })
}

// --- Window state persistence ---

// Runtime geometry corrections (monitor hotplug, resolution change, resume
// with a different display set) are owned by the windowRescue service —
// see initWindowRescue() in the whenReady chain. Do not add display-event
// handling or bounds clamping here; the previous in-file implementation
// oscillated against the renderer's own fit logic and the WM (window
// "shaking"). Full rationale: docs/ARCHITECTURE.md "Window geometry —
// single writer / rescue-not-police".
import { normalizeWindowState, type PersistedWindowState } from './windowGeometry'
import { initWindowRescue } from './services/windowRescue'

type WindowState = PersistedWindowState

/** Must match the BrowserWindow minWidth/minHeight in createWindow(). */
const MAIN_WINDOW_MIN_WIDTH = 900
const MAIN_WINDOW_MIN_HEIGHT = 600

function loadWindowState(): WindowState | null {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'window-state.json'), 'utf8')
    // normalizeWindowState validates the untrusted on-disk shape (finite
    // numbers, positive sizes, strict-boolean isMaximized) and clamps the
    // geometry onto the current display set via the rescue math — the saved
    // size survives an undock/resolution change instead of being discarded.
    return normalizeWindowState(
      JSON.parse(raw),
      screen.getAllDisplays().map(d => d.workArea),
      { width: MAIN_WINDOW_MIN_WIDTH, height: MAIN_WINDOW_MIN_HEIGHT },
    )
  } catch {
    return null
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? (win as unknown as { _lastBounds?: Electron.Rectangle })._lastBounds ?? win.getNormalBounds() : win.getBounds()
    const state: WindowState = { ...bounds, isMaximized }
    fs.writeFileSync(path.join(app.getPath('userData'), 'window-state.json'), JSON.stringify(state))
  } catch { /* non-critical */ }
}

/** Background colors must match CSS --bg in src/index.css for both themes. */
const DARK_BG = '#0b1020'
const LIGHT_BG = '#ffffff'

function themeBg(): string {
  return getSettings().theme === 'dark' ? DARK_BG : LIGHT_BG
}

function themeArgs(): string[] {
  return getSettings().theme === 'dark' ? ['--theme=dark'] : []
}

/**
 * Pass the anonymous install-id hash into the renderer process via
 * Chromium additionalArguments so the renderer's Sentry.init can attach
 * the same identity as main without a first-paint IPC round-trip. The
 * flag is synchronous for preload (process.argv) and therefore available
 * before any React code runs.
 */
function installIdArgs(): string[] {
  try {
    return [`--install-id-hash=${getInstallIdHash()}`]
  } catch {
    return []
  }
}

/**
 * Propagate the persisted sentryEnabled flag to the renderer before its
 * Sentry.init runs. Without this there is a startup window where the
 * renderer uses the default "enabled" and can emit events (and attach the
 * stable anonymous install-id) even though the user has telemetry off in
 * settings. The renderer reads this flag synchronously from process.argv
 * in preload.
 *
 * Tri-state so the renderer can apply symmetric fail-closed semantics:
 *   --sentry-enabled=true  → confirmed on
 *   --sentry-enabled=false → confirmed off
 *   (absent)               → unknown, renderer treats as off
 *
 * If getSettings() throws (store broken, corrupted JSON), we emit neither
 * token and let the renderer default to fail-closed. Same policy as
 * sentryPreflight.ts for the main process: prefer silent loss of events
 * over silent leakage when we cannot verify the user's preference.
 */
function sentryEnabledArgs(): string[] {
  try {
    return [getSettings().sentryEnabled === false ? '--sentry-enabled=false' : '--sentry-enabled=true']
  } catch {
    return []
  }
}

function childBrowserArgs(): string[] {
  return [...themeArgs(), ...installIdArgs(), ...sentryEnabledArgs()]
}

function createWindow() {
  // Remove standard menu (File, Edit, View...)
  Menu.setApplicationMenu(null)

  const savedState = loadWindowState()

  win = new BrowserWindow({
    width: savedState?.width ?? 1200,
    height: savedState?.height ?? 800,
    x: savedState?.x,
    y: savedState?.y,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    frame: false,
    show: false,
    backgroundColor: themeBg(),
    title: 'MailCopilot Beta',
    icon: path.join(process.env.VITE_PUBLIC, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      scrollBounce: true,
      additionalArguments: childBrowserArgs(),
    },
  })

  if (savedState?.isMaximized) win.maximize()

  // Save window state on close; track the last normal (non-maximized)
  // bounds on both resize AND move so a maximized-window save restores the
  // position the user actually left the normal window at.
  win.on('close', () => { if (win && !win.isDestroyed()) saveWindowState(win) })
  const rememberNormalBounds = () => {
    if (win && !win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) {
      (win as unknown as { _lastBounds?: Electron.Rectangle })._lastBounds = win.getBounds()
    }
  }
  win.on('resize', rememberNormalBounds)
  win.on('move', rememberNormalBounds)

  // Broadcast maximize state changes to renderer so the titlebar button icon stays in sync.
  // Without this, OS-level snap/maximize (drag to edge, WM shortcuts) desynchronizes
  // the isMaximized() state from the UI, causing the maximize button to stop working.
  win.on('maximize', () => { if (!win!.isDestroyed()) win!.webContents.send('win:maximizeChanged', true) })
  win.on('unmaximize', () => { if (!win!.isDestroyed()) win!.webContents.send('win:maximizeChanged', false) })

  // Display-change repositioning is handled app-wide by the windowRescue
  // service (one subscription covering all windows) — no per-window screen
  // listeners here.

  // Show the window only when content is ready — eliminates white screen flash.
  win.once('ready-to-show', () => {
    win!.show()
    // Measure startup latency at the moment the window is actually visible
    // to the user, not at createWindow(). The schema documents this metric
    // as "first visible BrowserWindow" and anything earlier is misleading.
    if (!startupRecorded) {
      startupRecorded = true
      try {
        const accCount = (() => {
          try { return (listAccounts() ?? []).length } catch { return 0 }
        })()
        recordHistogram('app.startup_ms', Date.now() - sessionStartedAtMs, {
          accounts_count: accCount,
        })
      } catch { /* telemetry never throws */ }
    }
  })

  configureExternalLinks(win)

  // §3.3.C-print.f1: Intercept Ctrl+P before Chromium handles it as a
  // built-in browser print shortcut and forward the action to the renderer
  // via `mail:print`. The renderer scopes printing to the focused message
  // body iframe (`iframe.contentWindow.print()`) so the surrounding UI
  // chrome (sidebar, toolbar, AI panel) is excluded from the printout.
  // Direct `webContents.print()` would print the entire window.
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'p' && !input.shift && !input.alt) {
      event.preventDefault()
      win!.webContents.send('mail:print')
    }
  })

  if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(RENDERER_DIST, 'index.html'))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// Guard flag so before-quit runs its async shutdown exactly once. The
// handler defers the real quit with event.preventDefault(), waits for
// telemetry + Sentry flush, then calls app.quit() again. Without this gate
// the second quit would re-enter the handler and deadlock.
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown) {
    // Re-entrant call — typically a second SIGTERM (impatient supervisor) or
    // an external app.quit() arriving while the first drain is still in
    // flight. We MUST keep deferring the quit; otherwise Electron is allowed
    // to exit before TRUNCATE checkpoint runs, losing committed WAL frames
    // (Codex §2.15-bis review iteration 2 Medium #1).
    event.preventDefault()
    return
  }
  shuttingDown = true
  // Defer quit until telemetry is actually on the wire.
  event.preventDefault()
  void (async () => {
    // Telemetry: emit session_ended + usage.session_summary, then wait for
    // Sentry to flush. before-quit is synchronous by default and a fast
    // quit/update cycle would drop session-level events otherwise.
    try {
      flushAggregator()
      const durMs = Date.now() - sessionStartedAtMs
      recordHistogram('app.session_ended', durMs, {
        reason: 'quit',
        install_id_hash: getInstallIdHash(),
      })
      recordEvent('usage.session_summary', {
        search_used: featureReach.search,
        compose_used: featureReach.compose,
        snooze_used: featureReach.snooze,
        read_later_used: featureReach.read_later,
        ai_used: featureReach.ai,
        rules_used: featureReach.rules,
        templates_used: featureReach.templates,
        followup_used: featureReach.followup,
        install_id_hash: getInstallIdHash(),
      })
    } catch { /* never block shutdown on telemetry */ }
    // Try to stop background IMAP IDLE connection.
    try { await stopIdle() } catch { /* ignore */ }
    // Close per-account IMAP connections (offline sync).
    try { await disconnectAllPerAccount() } catch { /* ignore */ }
    // Stop background search worker.
    try { await searchWorkerClient.shutdown() } catch { /* ignore */ }
    // Stop MCP export server if running.
    if (mcpExportServer?.status === 'running') {
      try { await mcpExportServer.stop() } catch { /* ignore */ }
    }
    // Disconnect all MCP client connections.
    if (mcpClientManager) {
      try { await mcpClientManager.disconnectAll() } catch { /* ignore */ }
    }
    // Stop DB-writing background timers BEFORE WAL checkpoint (Codex §2.15
    // wave-1 High #2, wave-2 High, wave-3 High). Two-step teardown:
    //   1. Clear every DB-writing interval so no NEW tick starts.
    //   2. Await in-flight ticks so their commits land BEFORE checkpoint,
    //      not after. A tick already past its `running = true` barrier can
    //      be awaiting IMAP RTT (observed 30s for slow servers) and would
    //      otherwise write `updateMessageBodyText()` / `applyFolderSyncBatch()`
    //      after the checkpoint, re-growing the WAL with exactly the frames
    //      the TRUNCATE just reclaimed.
    try { stopBodyIndexer() } catch { /* ignore */ }
    if (periodicSyncTimer) {
      try { clearInterval(periodicSyncTimer) } catch { /* ignore */ }
      periodicSyncTimer = null
    }
    // Clear the remaining DB-writing intervals: send queue (1s cadence —
    // clearest race window), snooze, follow-up, offline sync, AI rules.
    shutdownDbWritingTimers()
    // Await in-flight body indexer + periodic sync. Individual 10s cap:
    // IMAP socket timeout is 30s and a stuck fetch on one path should not
    // deny the other its drain budget. Upper bound: ~20s worst case. If
    // either exceeds the cap we log and fall through — SQLite auto-replays
    // any pages still in `.db-wal` on next open, so residual data safety
    // does not depend on a successful checkpoint here.
    try {
      const bodyIdle = await waitForBodyIndexerIdle(10_000)
      if (!bodyIdle) logMain.warn('body indexer still running after 10s drain — checkpoint will proceed; SQLite WAL auto-replay is the backstop')
    } catch { /* ignore */ }
    try {
      const syncIdle = await waitForPeriodicSyncIdle(10_000)
      if (!syncIdle) logMain.warn('periodic sync still running after 10s drain — checkpoint will proceed; SQLite WAL auto-replay is the backstop')
    } catch { /* ignore */ }
    // Short post-idle drain catches any short single-statement write that
    // fired just before shutdownDbWritingTimers() (send-queue/snooze/etc.
    // callbacks are synchronous DB writes, not awaited IMAP operations).
    // Capped at 200ms.
    try { await new Promise<void>(resolve => setTimeout(resolve, 150)) } catch { /* ignore */ }
    // WAL checkpoint on shutdown (2026-04-21 P0 data-loss fix).
    //
    // SQLite in WAL mode buffers committed transactions in `.db-wal` until a
    // checkpoint folds them into the main DB file. Without an explicit
    // `wal_checkpoint(TRUNCATE)` at shutdown, a growing WAL (observed 72 MB
    // on the affected profile) can lose committed writes if the file is lost
    // between sessions (OS cleanup, external process touching the file,
    // filesystem error). Running the checkpoint here is the last-resort
    // guarantee that everything visible in WAL is in the main file before
    // the DB handle closes.
    //
    // Must come AFTER stopIdle/disconnectAllPerAccount/searchWorkerClient
    // shutdown so no other writer is racing against us — wal_checkpoint
    // returns busy=1 if a reader holds a snapshot.
    //
    // Invariant: this must NEVER block shutdown. The helper catches and
    // returns an `ok: false` flag rather than throwing, and the whole call
    // is wrapped in try/catch as a last line of defence.
    try {
      const t0 = Date.now()
      const cp = checkpointWal()
      const dt = Date.now() - t0
      logMain.info(
        `WAL checkpoint(TRUNCATE) on shutdown: ` +
        `before=${cp.beforeBytes}B after=${cp.afterBytes}B ` +
        `frames=${cp.checkpointedFrames}/${cp.totalFrames} busy=${cp.busy} ok=${cp.ok} took=${dt}ms`
      )
      const reclaimedKb = Math.max(0, Math.floor((cp.beforeBytes - cp.afterBytes) / 1024))
      const reclaimedBucket = reclaimedKb < 1 ? 'none'
        : reclaimedKb < 100 ? '<100kb'
        : reclaimedKb < 1024 ? '<1mb'
        : reclaimedKb < 10 * 1024 ? '<10mb'
        : reclaimedKb < 100 * 1024 ? '<100mb'
        : '>=100mb'
      recordHistogram('db.shutdown_wal_checkpoint_ms', dt, {
        busy: cp.busy,
        reclaimed_kb_bucket: reclaimedBucket,
        ok: cp.ok,
      })
    } catch (err) {
      // WAL checkpoint failure is not fatal — the DB handle will still be
      // finalised by the OS on process exit, and SQLite's next-open will
      // replay any unchecked WAL pages. Worst case we lose the reclamation
      // round; data loss from a missing checkpoint is blocked by the helper.
      logMain.warn('WAL checkpoint on shutdown failed:', err instanceof Error ? err.message : err)
    }
    // Wait for buffered Sentry events to actually be sent. Hard cap so a
    // misbehaving Sentry transport can't strand the quit — losing the
    // last session's telemetry is infinitely preferable to hanging the
    // user in a "quitting..." state.
    try { await flushSentry(1500) } catch { /* ignore */ }
    // app.exit(0) — bypasses before-quit. The drain above is complete; we
    // just want process exit. Using app.quit() here would re-enter the
    // before-quit handler whose re-entry guard (Codex §2.15-bis review
    // iteration 2 Medium #1) correctly preventDefaults a second entry,
    // creating an infinite-defer loop where the real quit is canceled.
    app.exit(0)
  })()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// Session start time. featureReach lives in its own module so both the
// main-side recordEvent/recordHistogram path (via metrics.ts) and the
// IPC-bridged renderer events write to the same bitmap.
const sessionStartedAtMs = Date.now()
let startupRecorded = false

app.whenReady().then(createWindow).then(() => {
  // Single writer for window-geometry corrections (CLAUDE.md §5 "Window
  // management"). Rescue passes are deferred while the user drags the
  // custom frameless edge-resize (resizeState is the module-level state
  // behind win:startResize below); a flag stuck past the deferral cap is
  // force-stopped so its 16ms interval cannot race the rescue writer.
  initWindowRescue({
    isInteractiveOperationActive: () => resizeState !== null,
    stopInteractiveOperation: () => stopActiveResize(),
  })
  // Emit app.session_started. Carries install_id_hash — the ONLY event
  // besides session_ended and session_summary that does.
  try {
    const s0 = getSettings()
    const accCount = (() => {
      try { return (listAccounts() ?? []).length } catch { return 0 }
    })()
    recordEvent('app.session_started', {
      version: app.getVersion(),
      platform: process.platform as 'linux' | 'darwin' | 'win32',
      theme: s0.theme === 'dark' ? 'dark' : 'light',
      lang: s0.language || 'en',
      accounts_count: accCount,
      install_id_hash: getInstallIdHash(),
    })
    // app.startup_ms is emitted from the main BrowserWindow's
    // ready-to-show handler — that's when the user actually sees content.
    // One-shot app.updated: compare stored last-seen version with current.
    const lastVer = getLastSeenAppVersion() ?? ''
    const curVer = app.getVersion()
    if (lastVer && lastVer !== curVer) {
      recordEvent('app.updated', { from_version: lastVer, to_version: curVer })
    }
    setLastSeenAppVersion(curVer)
  } catch (err) {
    logMain.warn('session_started telemetry failed', err instanceof Error ? err.message : err)
  }
  // Register/unregister as mailto: handler based on user setting
  const s = getSettings()
  if (s.defaultMailApp) {
    if (!app.isDefaultProtocolClient('mailto')) {
      app.setAsDefaultProtocolClient('mailto')
    }
  }
  // Process mailto: URL that arrived before app was ready
  if (pendingMailtoUrl) {
    handleMailtoUrl(pendingMailtoUrl)
    pendingMailtoUrl = null
  }
  if (s.mcpExportEnabled) {
    void ensureMcpExportServer().then(srv =>
      srv.start(s.mcpExportPort ?? 23847, s.mcpExportWhitelist ?? undefined)
    ).catch(() => {})
  }
  // §3.10 P0 requirement #8: migrate existing stdio connections. When the
  // app upgrades to the gate-enforcing build, pre-existing stdio connections
  // must not auto-grant themselves an approval — the user has to see the
  // per-connection approval dialog once. We mark any stdio connection
  // without an explicit `approvedSource` as `null` so readers (Settings UI,
  // `resolveConnectionApproval`) see "awaiting approval" rather than
  // "legacy pre-gate unknown". Existing users with stdio off-by-default
  // see the "Needs approval" badge next to each connection.
  try {
    const preGateConns = listMcpConnections()
    let migratedCount = 0
    for (const conn of preGateConns) {
      if (conn.transport === 'stdio' && conn.approvedSource === undefined) {
        try {
          saveMcpConnection({ ...conn, approvedSource: null })
          migratedCount++
        } catch (err) {
          logMcpStdio.warn(`Failed to migrate stdio connection "${conn.name}"`, err)
        }
      }
    }
    if (migratedCount > 0) {
      logMcpStdio.info(
        `Migrated ${migratedCount} stdio connection(s) to null approval state — user must approve each via Settings`,
      )
    }
  } catch (err) {
    logMcpStdio.warn('stdio connection migration failed', err)
  }

  // Auto-connect MCP client connections that have autoConnect enabled.
  // §3.10 P0 requirement #3: respect the approval gate even for auto-connect;
  // unapproved stdio connections silently skip (the user has to go into
  // Settings and approve). SSE connections are unaffected.
  const conns = listMcpConnections()
  for (const conn of conns) {
    if (!conn.enabled || !conn.autoConnect) continue
    void (async () => {
      try {
        const { resolveConnectionApproval } = await import('./services/mcpClient')
        const approval = resolveConnectionApproval(conn, app.getVersion())
        if (!approval.approved) {
          if (conn.transport === 'stdio') {
            logMcpStdio.info(
              `Auto-connect skipped for "${conn.name}": ${approval.reason ?? 'not_approved'}`,
            )
          }
          return
        }
        const effectiveConfig = approval.source === 'env'
          ? { ...conn, approvedSource: 'env' as const }
          : conn
        const mgr = await ensureMcpClientManager()
        await mgr.connect(effectiveConfig)
      } catch { /* auto-connect failures are non-fatal */ }
    })()
  }
})

// --- Auto-update (packaged app only, not dev/e2e) ---
//
// §2.19 — module-level canSelfUpdate is captured once at startup so the
// `update:systemInfo` and `update:check` IPC handlers can return it
// without recomputing fs.accessSync per call. The flag is constant for
// the lifetime of the process — the install path doesn't change at runtime.
const updateCanSelfUpdate = app.isPackaged ? canWriteAppDir(process.execPath) : false

// §2.19 — track which trigger started the in-flight download so the
// `update.download_completed` / `download_failed` events carry the right
// `source` tag. Reset on every start; null between downloads.
let updateDownloadSource: 'auto' | 'manual' | null = null

// §2.19 — track whether we've already emitted update.download_started for
// the current download. electron-updater can fire `download-progress`
// many times per download but we only want to record `started` once.
let updateDownloadStartedEmitted = false

if (app.isPackaged && !IS_E2E) {
  // §2.19 — initial autoDownload state mirrors the persisted setting,
  // but only when the install directory is writable. On read-only
  // installs (admin-deployed /opt, system package) the user cannot
  // self-update at all (see SystemInfo state machine — UI disables the
  // checkbox when canSelfUpdate=false). Without this gate, a previously
  // persisted autoUpdateEnabled=true would silently keep auto-downloading
  // updates that can never be applied, while the disabled checkbox in
  // Settings → About prevents the user from turning it off.
  // Runtime toggle via Settings → About is handled in onSettingsChangedMain.
  autoUpdater.autoDownload = getSettings().autoUpdateEnabled === true && updateCanSelfUpdate
  autoUpdater.autoInstallOnAppQuit = true
  // WARNING: secrets must not be stored in source code. If the update feed requires
  // headers (e.g., private GitLab), set the token via environment variable.
  const updateToken = process.env.MAILCOPILOT_UPDATE_TOKEN
  if (updateToken) autoUpdater.requestHeaders = { 'PRIVATE-TOKEN': updateToken }

  if (!updateCanSelfUpdate) {
    logUpdate.info('App directory is not writable — user cannot self-update (admin install?)')
    // §2.19 iter3 — one-shot warning when persisted setting is true but
    // the install path is read-only. Helps diagnose user reports of
    // "update never applies": their setting says yes, but reality says no.
    if (getSettings().autoUpdateEnabled === true) {
      logUpdate.warn('autoUpdateEnabled=true but install path is read-only — autoDownload forced to false')
    }
  }

  autoUpdater.on('update-available', (info) => {
    const version = info?.version ? String(info.version) : ''
    // §2.19 — broadcast a consistent checkResult so renderer state machines
    // (Settings → About, the App banner) all observe the same outcome
    // regardless of whether the trigger was auto or manual.
    broadcast('update:checkResult', { status: 'available' as const, version })
    try { recordEvent('update.check_result', { result: 'available' }) } catch { /* telemetry must not block */ }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:available', { version, canSelfUpdate: updateCanSelfUpdate })
    }
    // If autoDownload is enabled, electron-updater starts the download
    // automatically; tag the source so completion/failure telemetry knows.
    if (autoUpdater.autoDownload) {
      updateDownloadSource = 'auto'
      updateDownloadStartedEmitted = false
    }
  })

  autoUpdater.on('update-not-available', () => {
    broadcast('update:checkResult', { status: 'up-to-date' as const })
    try { recordEvent('update.check_result', { result: 'up-to-date' }) } catch { /* telemetry must not block */ }
  })

  autoUpdater.on('download-progress', (progress) => {
    if (!updateDownloadStartedEmitted) {
      updateDownloadStartedEmitted = true
      try {
        recordEvent('update.download_started', { source: updateDownloadSource ?? 'auto' })
      } catch { /* telemetry must not block */ }
    }
    // Best-effort progress fanout — payload is structural (percent + bytes),
    // never PII. Renderer floors percent for display; raw value passes through.
    const percent = typeof progress?.percent === 'number' ? progress.percent : 0
    const transferred = typeof progress?.transferred === 'number' ? progress.transferred : 0
    const total = typeof progress?.total === 'number' ? progress.total : 0
    broadcast('update:downloadProgress', { percent, transferred, total })
  })

  autoUpdater.on('update-downloaded', () => {
    try {
      recordEvent('update.download_completed')
    } catch { /* telemetry must not block */ }
    updateDownloadSource = null
    updateDownloadStartedEmitted = false
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:downloaded')
    }
  })

  // Transient network errors are expected (proxy, sleep, VPN, etc.) — log only, do not report to Sentry.
  // Single source of truth: packages/core/transientErrors.ts.
  autoUpdater.on('error', (err) => {
    const errorClass = classifyUpdateError(err)
    // §2.19 iter4 — log the bucketed class, NOT raw err.message. Raw
    // updater text can include install paths, version strings, server
    // hostnames, usernames and stderr fragments (electron-updater
    // signature/dpkg/pkexec failures are rich in PII). Local file logs
    // (electron-log) are user-readable and rotate to disk; treat them
    // with the same privacy hygiene as Sentry events.
    logUpdate.error(`Auto-update error class=${errorClass}`)
    // §2.19 — broadcast a checkResult so any UI waiting on a manual check
    // promise (which doesn't get a return value when the error fires
    // out-of-band) clears its "checking…" state. Same payload shape as the
    // manual `update:check` reply.
    broadcast('update:checkResult', { status: 'error' as const, error_class: errorClass })
    try { recordEvent('update.check_result', { result: 'error', error_class: errorClass }) } catch { /* telemetry must not block */ }
    // If we were mid-download, treat this error as a download failure too —
    // electron-updater raises both download and check errors through the
    // same `error` event, so we differentiate by whether we tagged a source.
    if (updateDownloadSource !== null) {
      try { recordEvent('update.download_failed', { error_class: errorClass }) } catch { /* telemetry must not block */ }
      broadcast('update:downloadFailed', { error_class: errorClass })
      updateDownloadSource = null
      updateDownloadStartedEmitted = false
    }
    if (isTransientNetworkError(err)) return
    if (isLinuxInstallerError(err)) return
    // §2.19 iter4 — do NOT pass `err` directly to Sentry: its `.message`
    // and stack frames can carry the same PII the local log avoids. The
    // bucketed `error_class` already lands in Sentry via the metrics sink
    // (`update.check_result:error` / `update.download_failed`); this
    // captureException exists only to surface the residual `unknown`
    // bucket for forward-compat triage. Wrap the class in a synthetic
    // Error so Sentry has a stable, PII-clean signature to group on.
    captureException(new Error(`update_${errorClass}`), { source: 'autoUpdater' })
  })

  app.whenReady().then(() => {
    // §2.19 — initial check + hourly background poll both count as 'auto'.
    try { recordEvent('update.check_triggered', { source: 'auto' }) } catch { /* telemetry must not block */ }
    void autoUpdater.checkForUpdates().catch(() => {})
    setInterval(() => {
      try { recordEvent('update.check_triggered', { source: 'auto' }) } catch { /* telemetry must not block */ }
      void autoUpdater.checkForUpdates().catch(() => {})
    }, 3_600_000)
  })
}

handleIpc('update:download', async () => {
  if (!app.isPackaged) return { ok: true as const }
  // §2.19 iter4 — gate on updateCanSelfUpdate. SystemInfo.tsx disables the
  // download/restart affordance on read-only installs (admin /opt, system
  // package), but a compromised renderer could bypass the disabled UI and
  // invoke this IPC directly. The `permission` bucket is the same enum the
  // renderer's state machine already understands.
  if (!updateCanSelfUpdate) {
    return { ok: false as const, reason: 'permission_denied', error_class: 'permission' as const }
  }
  // §2.19 — tag the download source so completion / failure telemetry
  // can split manual clicks from background autoDownload-driven downloads.
  updateDownloadSource = 'manual'
  updateDownloadStartedEmitted = false
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true as const }
  } catch (err) {
    // Transient net errors reach us here as rejected promises from
    // electron-updater. autoUpdater.on('error') already logs and filters
    // them for Sentry — don't re-throw, since a thrown IPC becomes an
    // unhandledrejection in the renderer (MAILCOPILOT-8, MAILCOPILOT-A).
    // §2.19 iter4 — log the bucketed class, NOT raw err.message; updater
    // text leaks paths/usernames into the local file log otherwise. The
    // IPC return shape also drops the raw `message` field — renderer
    // consumes only `error_class` (see SystemInfo.tsx).
    const errorClass = classifyUpdateError(err)
    logUpdate.warn(`update:download failed class=${errorClass}`)
    // §2.19 iter3 — telemetry is emitted exclusively by autoUpdater.on('error')
    // (canonical emit point). electron-updater's downloadUpdate() rejection
    // is the same error that already flowed through the 'error' event, so
    // emitting update.download_failed here would double-count the bucket.
    // The autoUpdater handler also resets updateDownloadSource /
    // updateDownloadStartedEmitted; this catch only owns the IPC return
    // shape for the renderer.
    return { ok: false as const, reason: 'download_failed', error_class: errorClass }
  }
})

/**
 * §2.19 — manual "Check for updates" button in Settings → About.
 *
 * Returns a structured reply so the renderer state machine can drive the
 * inline status text (idle → checking → up-to-date | available | error).
 * The actual outcome may also arrive asynchronously via the
 * `update:checkResult` event broadcast from the autoUpdater listeners
 * above — that's the single source of truth for state on existing
 * windows. This IPC just gives the click handler an immediate ack.
 *
 * Guard: when not packaged (dev/e2e), returns 'unsupported' without
 * touching autoUpdater (which would throw "Skip checkForUpdates because
 * application is not packed"). The renderer should hide the button in
 * that case anyway.
 */
handleIpc('update:check', async () => {
  if (!app.isPackaged) {
    return { ok: true as const, status: 'unsupported' as const }
  }
  try { recordEvent('update.check_triggered', { source: 'manual' }) } catch { /* telemetry must not block */ }
  try {
    const result = await autoUpdater.checkForUpdatesAndNotify()
    // electron-updater returns null when no update is available OR when
    // the check is suppressed (already in progress, app not packed).
    // The 'update-available' / 'update-not-available' listeners above will
    // also fire and broadcast the canonical checkResult — but we synthesize
    // a sensible reply here so the renderer's optimistic UI has something
    // to render before the broadcast lands.
    if (result && result.updateInfo && result.updateInfo.version) {
      return {
        ok: true as const,
        status: 'available' as const,
        version: String(result.updateInfo.version),
      }
    }
    return { ok: true as const, status: 'up-to-date' as const }
  } catch (err) {
    const errorClass = classifyUpdateError(err)
    // §2.19 iter4 — log the bucketed class, NOT raw err.message; updater
    // text leaks paths/version strings/server hostnames into the local
    // file log otherwise. The IPC response also no longer carries a raw
    // `message` field (renderer consumes `error_class` only — see
    // SystemInfo.tsx state machine).
    logUpdate.warn(`update:check failed class=${errorClass}`)
    // §2.19 iter3 — telemetry emitted exclusively by autoUpdater.on('error')
    // (canonical emit point). checkForUpdatesAndNotify() rejections always
    // flow through the autoUpdater 'error' event first; emitting
    // update.check_result:error here would double-count the bucket. The
    // bucketed error_class is still returned to the renderer so the UI
    // state machine can show the right inline message.
    return { ok: false as const, status: 'error' as const, error_class: errorClass }
  }
})

/**
 * §2.19 — system info for the About panel (versions, install path,
 * channel badge). Static at runtime, so the renderer can fetch this
 * once on Settings open. PII-safe by construction — no hostname,
 * username, or environment variables leak through.
 */
handleIpc('update:systemInfo', (): SystemInfo => {
  const appVersion = app.getVersion()
  return {
    appVersion,
    channel: detectUpdateChannel(appVersion, app.isPackaged),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    installPath: process.execPath,
    installPathWritable: updateCanSelfUpdate,
    canSelfUpdate: app.isPackaged && updateCanSelfUpdate,
    isPackaged: app.isPackaged,
  }
})

handleIpc('update:install', async () => {
  if (!app.isPackaged) return { ok: true as const }
  // §2.19 iter4 — gate on updateCanSelfUpdate. Symmetric with update:download:
  // a compromised renderer must not be able to invoke quitAndInstall on a
  // read-only install (no-op at best, dialog spam at worst).
  if (!updateCanSelfUpdate) {
    return { ok: false as const, reason: 'permission_denied', error_class: 'permission' as const }
  }
  try {
    autoUpdater.quitAndInstall()
    // §2.19 — handed off to OS for restart-and-install. On most platforms
    // this is fire-and-forget (the process is about to exit) but we still
    // record the success so we can compute funnel ratios against
    // `install_outcome { result: 'failed' }`.
    try { recordEvent('update.install_outcome', { result: 'success' }) } catch { /* telemetry must not block */ }
    return { ok: true as const }
  } catch (err) {
    // On Linux, electron-updater's DebUpdater throws synchronously from
    // quitAndInstall() when pkexec/dpkg exits non-zero (MAILCOPILOT-9,
    // 121 events from one user). Show a dialog with a manual-download
    // hint instead of crashing the IPC handler and reporting to Sentry.
    const code =
      err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : ''
    // §2.19 iter4 — bucketed install_outcome telemetry. error_class is the
    // same taxonomy as download_failed for cross-event consistency.
    const errorClass = classifyUpdateError(err)
    // §2.19 iter4 — log the bucketed class, NOT raw err.message. Raw
    // updater text (especially DebUpdater stderr) routinely contains
    // install paths and dpkg/pkexec output. The Sentry capture below is
    // also synthetic for the same reason.
    logUpdate.error(`update:install failed class=${errorClass} code=${code || 'none'}`)
    try { recordEvent('update.install_outcome', { result: 'failed', error_class: errorClass }) } catch { /* telemetry must not block */ }
    if (isLinuxInstallerError(err)) {
      try {
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: 'Update installation failed',
          message: 'Automatic installation could not complete.',
          detail:
            'This usually means pkexec or dpkg is unavailable on this system. ' +
            'You can download the latest .deb manually from the releases page.' +
            (code ? `\n\nError code: ${code}` : ''),
          buttons: ['Open releases page', 'Dismiss'],
          defaultId: 0,
          cancelId: 1,
        })
        if (result.response === 0) {
          void openExternalGated('https://docs.mailcopilot.io/download', 'update_dialog')
        }
      } catch (dialogErr) {
        logUpdate.error('Failed to show install-failure dialog:', dialogErr)
      }
      // §2.19 iter4 — drop raw `message` from IPC response; renderer
      // consumes `error_class` only.
      return { ok: false as const, reason: 'linux_installer_failed', error_class: errorClass }
    }
    // Unknown install failure — report to Sentry for visibility, show a
    // generic dialog to the user (symmetric to the Linux path so the
    // failure is never silent on non-Linux), and reject the IPC so the
    // renderer's .catch clears any pending "installing" UI state.
    // §2.19 iter4 — Sentry capture uses a synthetic Error keyed on the
    // bucket, not the raw `err` object (its `.message` and stack frames
    // can carry install paths / stderr fragments).
    captureException(new Error(`update_install_${errorClass}`), { source: 'autoUpdater', step: 'quitAndInstall' })
    try {
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: 'Update installation failed',
        message: 'Automatic installation could not complete.',
        detail:
          'The update could not be installed. You can download the latest ' +
          'version manually from the releases page.' +
          (code ? `\n\nError code: ${code}` : ''),
        buttons: ['Open releases page', 'Dismiss'],
        defaultId: 0,
        cancelId: 1,
      })
      if (result.response === 0) {
        void openExternalGated('https://docs.mailcopilot.io/download', 'update_dialog')
      }
    } catch (dialogErr) {
      logUpdate.error('Failed to show install-failure dialog:', dialogErr)
    }
    // §2.19 iter4 — reject with a synthetic, sanitized Error so the
    // renderer's .catch(() => {}) guard receives a PII-clean payload
    // (Electron's IPC bridge serializes the thrown Error's `message`
    // into the renderer's promise rejection — raw `err` would leak the
    // same updater text we sanitized out of the local log and Sentry).
    throw new Error(`update_install_${errorClass}`)
  }
})

/**
 * Send `payload` on `channel` to every live renderer window.
 *
 * Returns the number of windows that actually received it. Load-bearing for
 * one-shot UX events (cert-recovery dialog, interception notice): a broadcast
 * with zero live windows silently succeeds, and a caller that then records
 * "already shown" would drop the notice forever. Such callers must check the
 * count and retry instead. Ordinary fire-and-forget callers ignore it.
 */
function broadcast(channel: string, payload: unknown): number {
  let delivered = 0
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w.isDestroyed()) continue
      w.webContents.send(channel, payload)
      delivered++
    } catch { /* window may have been destroyed between check and send */ }
  }
  return delivered
}

async function readStreamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) throw new Error(`Stream exceeds limit of ${maxBytes} bytes`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

// Google OAuth (Desktop app, PKCE). Env var overrides for dev/CI.
const GOOGLE_CLIENT_ID = (process.env.MAILCOPILOT_GOOGLE_CLIENT_ID || '').trim()
  || '407178545885-08stok46n6sba3dp75mnul6h63ujubh5.apps.googleusercontent.com'
const GOOGLE_CLIENT_SECRET = (process.env.MAILCOPILOT_GOOGLE_CLIENT_SECRET || '').trim()
  || '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'

type GoogleTokenCacheEntry = { accessToken: string; expiresAt: number }
const GOOGLE_TOKEN_CACHE = new Map<number, GoogleTokenCacheEntry>()
const GOOGLE_TOKEN_REFRESH_INFLIGHT = new Map<number, Promise<GoogleTokenCacheEntry>>()
let googleOAuthBusy = false

async function doGoogleOAuthFlow() {
  if (googleOAuthBusy) throw new Error('Google OAuth is already running in another window')
  googleOAuthBusy = true
  try {
    return await runGoogleOAuthFlow({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      openExternal: (url) => { void openExternalGated(url, 'oauth') },
    })
  } finally {
    googleOAuthBusy = false
  }
}

async function getGoogleAccessToken(accountId: number): Promise<string> {
  const cached = GOOGLE_TOKEN_CACHE.get(accountId)
  // Refresh token early (60 seconds ahead) to avoid race conditions in parallel requests.
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.accessToken

  const inflight = GOOGLE_TOKEN_REFRESH_INFLIGHT.get(accountId)
  if (inflight) return (await inflight).accessToken

  const p = (async () => {
    const found = await getOauthRefreshTokenWithSource('gmail', accountId)
    if (!found) throw new Error(`Google refresh token for account #${accountId} not found (re-authorization required)`)
    const refreshToken = found.token

    const result = await refreshGoogleAccessToken({ clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken })
    GOOGLE_TOKEN_CACHE.set(accountId, result)

    // Migrate-on-first-use: if we read from the legacy `google:refresh:${id}`
    // key, write it under the new `oauth-refresh:gmail:${id}` key and drop
    // the legacy one. Keytar errors inside setOauthRefreshToken are
    // swallowed — the helper returns void regardless of success. To avoid
    // losing both copies of the refresh token on a keytar write failure,
    // we verify the new key was actually persisted by reading it back
    // BEFORE deleting the legacy key. If verify fails, leave the legacy
    // key alone so the next token refresh retries the migration.
    if (found.source === 'legacy') {
      await setOauthRefreshToken('gmail', accountId, refreshToken)
      const verify = await getOauthRefreshToken('gmail', accountId)
      if (verify && verify === refreshToken) {
        await deleteLegacyGoogleRefreshToken(accountId)
        logOAuth.info(`Migrated legacy refresh token key for account #${accountId} to oauth-refresh:gmail:${accountId}`)
      } else {
        logOAuth.warn(`Refresh token migration verify failed for account #${accountId}; leaving legacy key in place for retry`)
      }
    }
    return result
  })()
  GOOGLE_TOKEN_REFRESH_INFLIGHT.set(accountId, p)
  try {
    return (await p).accessToken
  } finally {
    if (GOOGLE_TOKEN_REFRESH_INFLIGHT.get(accountId) === p) GOOGLE_TOKEN_REFRESH_INFLIGHT.delete(accountId)
  }
}

function normalizeFingerprintSha256(fpRaw: string): string {
  return (fpRaw || '').trim().toUpperCase().replace(/-/g, ':')
}

/** PEM body of a peer certificate, derived from the SAME DER bytes the
 *  fingerprint was computed over.
 *
 *  Deriving the PEM from `cert.raw` (rather than re-fetching or walking the
 *  chain) is what makes the pin store's cross-check — "does this PEM hash to
 *  the pinned fingerprint?" — pass by construction. `X509Certificate` also
 *  rejects unparseable DER here, before it can reach the DB layer.
 *  Returns undefined when the certificate carries no raw bytes. */
function peerCertificateToPem(cert: tls.DetailedPeerCertificate | null | undefined): string | undefined {
  const raw = cert?.raw
  if (!raw || raw.length === 0) return undefined
  try {
    return new X509Certificate(raw).toString()
  } catch {
    return undefined
  }
}

/**
 * Read the leaf certificate of a TLS endpoint.
 *
 * `certPem` is INTERNAL — it exists so the pin store can persist a trust
 * anchor. It must not be forwarded to the renderer (kilobytes per pin, no UI
 * uses it); the `tls:getServerCert` handler projects it out explicitly.
 *
 * Implicit TLS only: a STARTTLS port (143/587) yields no certificate on a raw
 * ClientHello. Callers that know the transport must skip this for
 * `secure === false` endpoints.
 */
async function fetchServerCertificate(hostRaw: string, portRaw: number): Promise<{
  host: string
  port: number
  fingerprintSha256: string
  subject?: string
  issuer?: string
  certPem?: string
}> {
  const host = (hostRaw || '').trim()
  const port = Math.floor(Number(portRaw))
  if (!host) throw new Error('Host is required')
  if (!Number.isFinite(port) || port <= 0) throw new Error('Port is invalid')

  return await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false,
    }, () => {
      try {
        const cert = socket.getPeerCertificate(true)
        const fingerprintSha256 = normalizeFingerprintSha256(String(cert?.fingerprint256 || ''))
        if (!fingerprintSha256) throw new Error('Server certificate fingerprint is empty')
        resolve({
          host,
          port,
          fingerprintSha256,
          subject: cert?.subject?.CN,
          issuer: cert?.issuer?.CN,
          certPem: peerCertificateToPem(cert),
        })
      } catch (e) {
        reject(e)
      } finally {
        try { socket.end() } catch { /* ignore */ }
      }
    })

    socket.setTimeout(12_000, () => {
      try { socket.destroy(new Error('TLS certificate probe timeout')) } catch { /* ignore */ }
    })
    socket.once('error', (err) => reject(err))
  })
}

// --- IPC: accounts ---
handleIpc('accounts:list', () => {
  if (IS_E2E) return E2E_ACCOUNTS
  return listAccounts()
})

handleIpc('accounts:get', (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  if (IS_E2E) return E2E_ACCOUNTS.find(a => a.id === id)
  return getAccountMeta(id)
})

handleIpc('accounts:getCurrent', () => {
  if (IS_E2E) return E2E_CURRENT_ACCOUNT_ID
  return getSettings().currentAccountId
})

handleIpc('accounts:setCurrent', (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  if (IS_E2E) {
    E2E_CURRENT_ACCOUNT_ID = id
    broadcast('accounts:changed', { kind: 'current', id })
    return { ok: true as const }
  }
  const meta = getAccountMeta(id)
  if (!meta) throw new Error(`Account #${id} not found`)
  const s = getSettings()
  saveSettings({ ...s, currentAccountId: id })
  broadcast('accounts:changed', { kind: 'current', id })
  return { ok: true as const }
})

handleIpc('accounts:save', async (_e, input: unknown) => {
  const parsed = accountSaveSchema.parse(input)
  if (IS_E2E) {
    const id = parsed.id ?? 1
    broadcast('accounts:changed', { kind: 'saved', id })
    return { ok: true as const, id }
  }
  const { id } = await saveAccount(parsed)
  // Telemetry: remember the first time this account id was seen so the
  // onboarding funnel can measure "time from save → first headers sync".
  // No-op for re-saves of an existing account.
  markAccountSeen(id)
  broadcast('accounts:changed', { kind: 'saved', id })
  return { ok: true as const, id }
})

handleIpc('accounts:removePreview', (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const messageCount = getAccountMessageCount(id)
  const emlDir = path.join(process.env.MAILCOPILOT_DATA_DIR || path.join(app.getPath('home'), '.mailcopilot'), 'mail', String(id))
  const localDataBytes = dirSizeBytes(emlDir)
  return { messageCount, localDataBytes }
})

handleIpc('accounts:autoconfig', async (_e, email: unknown) => {
  const parsedEmail = z.string().email().parse(email)
  if (IS_E2E) {
    const domain = parsedEmail.split('@')[1]?.toLowerCase() || ''
    if (domain === 'gmail.com') {
      return {
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
        source: 'guess',
      }
    }
    // For other domains in E2E — return null immediately, without real DNS/HTTP requests.
    return null
  }
  return autoconfig(parsedEmail)
})

handleIpc('accounts:remove', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  if (IS_E2E) {
    // In e2e we don't support real account deletion: a stable list is sufficient.
    broadcast('accounts:changed', { kind: 'removed', id })
    return { ok: true as const }
  }
  // Unregister auth-error handler BEFORE deleting the account so that stale
  // closures don't live until process exit (they hold references to token caches).
  // Registry is keyed by accountId (integer), so no need to rebuild cfg or
  // recompute a userKey — the id alone uniquely identifies the handler slot.
  unregisterAuthErrorHandler(id)
  // Phase A2: drop the cert-error subscription alongside the auth handler.
  certRecovery.unregisterAccount(id)
  // If removing an account with an active IDLE, stop the push connection.
  try { await stopIdle() } catch { /* ignore */ }
  await deleteAccount(id)
  GOOGLE_TOKEN_CACHE.delete(id)
  GOOGLE_TOKEN_REFRESH_INFLIGHT.delete(id)
  clearOutlookTokenCache(id)
  deleteAccountEmls(id)
  broadcast('accounts:changed', { kind: 'removed', id })
  return { ok: true as const }
})

handleIpc('oauth:google:connect', async (_e, existingAccountId: unknown) => {
  if (IS_E2E) throw new Error('Google OAuth is not available in e2e mode')

  const existingId = (existingAccountId === undefined || existingAccountId === null)
    ? undefined
    : accountIdSchema.parse(existingAccountId)

  if (typeof existingId === 'number' && !getAccountMeta(existingId)) {
    throw new Error(`Account #${existingId} not found`)
  }

  logOAuth.info('Starting OAuth flow...')
  const tokens = await doGoogleOAuthFlow()
  logOAuth.info('OAuth flow completed, got email:', tokens.email)

  const imapMeta = {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    user: tokens.email,
  }
  const smtpMeta = {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    user: tokens.email,
  }

  logOAuth.info('Token received, email:', tokens.email)

  // Verify token scopes (diagnostics for Invalid credentials).
  try {
    logOAuth.info('Checking tokeninfo...')
    const tokenInfo = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tokens.accessToken)}`)
    const info = await tokenInfo.json() as { scope?: string; error_description?: string }
    // Defensive projection: Google's tokeninfo response is typed narrowly above,
    // but the runtime shape is not validated. Log only the two fields we care
    // about so an undocumented field (e.g. an echoed token) can't leak into logs.
    logOAuth.info('tokeninfo:', JSON.stringify({ scope: info.scope, error_description: info.error_description }))
    if (info.error_description) {
      throw new Error(`Google access token is invalid: ${info.error_description}`)
    }
    const scopes = (info.scope || '').split(' ')
    if (!scopes.includes('https://mail.google.com/')) {
      throw new Error('Google access token does not contain scope https://mail.google.com/ — add this scope in OAuth consent screen in Google Cloud Console (Scopes section)')
    }
    logOAuth.info('Scopes OK')
  } catch (e) {
    if (e instanceof Error && (e.message.includes('scope') || e.message.includes('invalid'))) throw e
    logOAuth.warn('Could not verify tokeninfo:', e)
  }

  // Test IMAP/SMTP with timeout (30 sec) to avoid hanging indefinitely.
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms / 1000}s)`)), ms))])

  const isTlsCertError = (msg: string) =>
    /SELF.SIGNED|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|DEPTH_ZERO|CERT_UNTRUSTED|CERT_REJECTED|CERT_ALTNAME_INVALID|ERR_TLS_CERT/i.test(msg)

  let tlsCertImap: { host: string; port: number } | undefined
  let tlsCertSmtp: { host: string; port: number } | undefined

  logOAuth.info('Testing IMAP...')
  const imapRes = await withTimeout(testImapConnection({ ...imapMeta, accessToken: tokens.accessToken }), 30_000, 'IMAP')
  logOAuth.info('IMAP result:', JSON.stringify(imapRes))
  if (!imapRes.ok) {
    if (isTlsCertError(imapRes.error || '')) {
      tlsCertImap = { host: imapMeta.host, port: imapMeta.port }
      logOAuth.warn('IMAP TLS cert error (account will be saved, user can accept the certificate):', imapRes.error)
    } else {
      throw new Error(`IMAP: ${imapRes.error || 'error'}\n\nMake sure IMAP is enabled in Gmail (Settings → Forwarding and POP/IMAP → Enable IMAP)`)
    }
  }

  // SMTP test — non-critical. If IMAP passed, the token works and SMTP should too.
  // nodemailer verify() sometimes hangs with OAuth2, so we don't block account creation.
  logOAuth.info('Testing SMTP...')
  try {
    let smtpRes = await withTimeout(testSmtpConnection({ ...smtpMeta, accessToken: tokens.accessToken }), 15_000, 'SMTP')
    if (!smtpRes.ok && /timeout|ETIMEDOUT|Connection timeout/i.test(String(smtpRes.error || ''))) {
      logOAuth.warn('SMTP 465 timeout, retrying 587 STARTTLS')
      smtpRes = await withTimeout(testSmtpConnection({
        ...smtpMeta,
        port: 587,
        secure: false,
        accessToken: tokens.accessToken,
      }), 15_000, 'SMTP (587)')
      if (smtpRes.ok) {
        smtpMeta.port = 587
        smtpMeta.secure = false
      }
    }
    logOAuth.info('SMTP result:', JSON.stringify(smtpRes))
    if (!smtpRes.ok) {
      if (isTlsCertError(smtpRes.error || '')) {
        tlsCertSmtp = { host: smtpMeta.host, port: smtpMeta.port }
        logOAuth.warn('SMTP TLS cert error (user can accept the certificate):', smtpRes.error)
      } else {
        logOAuth.warn('SMTP test failed (account will be saved):', smtpRes.error)
      }
    }
  } catch (e) {
    logOAuth.warn('SMTP test failed with error (account will be saved):', e instanceof Error ? e.message : e)
  }

  const existingMeta = typeof existingId === 'number' ? getAccountMeta(existingId) : undefined

  // Ordering constraint (IPC trust gap — see saveAccount guard in
  // packages/net/config.ts): when transitioning an existing non-OAuth
  // account into OAuth, the refresh token MUST already be in keytar
  // before saveAccount runs, otherwise the guard rejects the save. For
  // brand-new accounts, id is allocated by saveAccount itself and no
  // existing record exists (guard is a no-op), so the keytar write
  // happens afterwards.
  const existingIsNonOAuth = !!existingMeta && existingMeta.authType !== 'oauth2'
  if (typeof existingId === 'number' && existingIsNonOAuth) {
    await setOauthRefreshToken('gmail', existingId, tokens.refreshToken)
  }

  const { id } = await saveAccount({
    id: existingId,
    name: existingMeta?.name,
    authType: 'oauth2',
    providerId: 'gmail',
    transportType: 'imap-smtp',
    imap: imapMeta,
    smtp: smtpMeta,
    folderRoles: existingMeta?.folderRoles ?? {},
    signature: existingMeta?.signature,
  })

  // For the new-account path (no existing record) and the re-save-of-
  // OAuth-account path, write the refresh token after saveAccount so we
  // have the final id. If we pre-wrote above for the transition path,
  // this call is a harmless no-op overwrite with the same token.
  await setOauthRefreshToken('gmail', id, tokens.refreshToken)
  GOOGLE_TOKEN_CACHE.set(id, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
  broadcast('accounts:changed', { kind: 'saved', id })
  const tlsCertRequired = (tlsCertImap || tlsCertSmtp) ? { imap: tlsCertImap, smtp: tlsCertSmtp } : undefined
  return { ok: true as const, id, email: tokens.email, tlsCertRequired }
})

// Microsoft 365 / Outlook.com OAuth — delegated to electron/services/outlookOAuthService.ts
handleIpc('oauth:microsoft:connect', async (_e, existingAccountId: unknown) => {
  return connectOutlookAccount({
    existingAccountId,
    openExternal: (url) => { void openExternalGated(url, 'oauth') },
    broadcast,
    isE2E: IS_E2E,
  })
})

// --- TLS cert recovery (Phase A2) -----------------------------------------
// Policy/state live in electron/services/certRecovery.ts (hotspot policy —
// main.ts only wires dependencies). The interception-notice "already shown"
// host list is persisted in its own tiny JSON file under userData rather
// than in settings: `settingsSchema` (packages/net/config.ts) strips unknown
// keys on parse, so a new settings field would require a packages/net schema
// change that is out of scope for this phase.
const CERT_NOTICE_STORE_FILE = 'cert-interception-notice.json'

function loadCertNoticeShownHosts(): string[] {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), CERT_NOTICE_STORE_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : []
  } catch {
    // Missing file is the common case (first run); corrupted JSON degrades
    // to "not shown yet", which only risks a duplicate notice — acceptable.
    return []
  }
}

function persistCertNoticeShownHosts(hosts: string[]): void {
  // Throws on failure — the service logs and contains it (persistence is
  // best-effort; a failed write only re-runs the probe next session).
  //
  // Write-then-rename, not a direct write to the final path: a crash (or a
  // full disk) mid-write leaves a TRUNCATED file, and `loadCertNoticeShownHosts`
  // degrades invalid JSON to "nothing shown yet" — every host silently loses
  // its record. rename(2) is atomic within a filesystem, so a reader ever sees
  // either the previous complete list or the new complete list.
  const dir = app.getPath('userData')
  const finalPath = path.join(dir, CERT_NOTICE_STORE_FILE)
  const tmpPath = path.join(dir, `${CERT_NOTICE_STORE_FILE}.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(Array.from(new Set(hosts))), 'utf8')
    fs.renameSync(tmpPath, finalPath)
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    throw err
  }
}

const certRecovery = initCertRecovery({
  registerCertErrorHandler,
  unregisterCertErrorHandler,
  verifyCertTrust,
  broadcast,
  recordEvent: (name, tags) => recordEvent(name, tags),
  providerFromHost,
  getAccountImapEndpoint: async (id) => {
    const base = await getAccountConfig(id)
    // `secure` matters: probing a STARTTLS port (143) as implicit TLS always
    // fails on transport, which would make the check retry forever.
    return base ? { host: base.imap.host, port: base.imap.port, secure: base.imap.secure } : null
  },
  loadNoticeShownHosts: loadCertNoticeShownHosts,
  persistNoticeShownHosts: persistCertNoticeShownHosts,
})

/** PII-safe error identifier for TLS-pin logging: the Node error code when
 *  present, otherwise 'unknown'. Never the raw message — TLS/IMAP failures
 *  can echo server-supplied text (mirrors errCode in services/certRecovery). */
function errCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'unknown'
}

/**
 * Outcome of the pin-time certificate capture.
 *
 * `fingerprint-mismatch` is a first-class result, not an error detail: the
 * endpoint served a DIFFERENT certificate between the moment the user was
 * shown a fingerprint and the moment they accepted it (load balancer, rotation
 * — or an active attacker). Whether that aborts the pin is the caller's
 * policy decision, so the capture layer only reports it.
 */
type PinCertCapture =
  | { status: 'captured'; pem: string }
  | { status: 'unavailable' }
  | { status: 'fingerprint-mismatch' }

/**
 * Fetch the certificate the user is about to pin, so its PEM can be stored
 * alongside the fingerprint.
 *
 * Why the PEM matters: the pinned TLS path keeps `rejectUnauthorized: true`,
 * and a SHA-256 fingerprint cannot act as a trust anchor — only the
 * certificate itself can (`buildTlsOptions` feeds it to OpenSSL via `ca`).
 * Without it a pinned self-signed server stays fail-closed.
 *
 * Best-effort by design: `unavailable` (endpoint unreachable, STARTTLS port,
 * no raw bytes) degrades to the pre-existing behaviour — a fingerprint-only
 * pin — rather than blocking the user's decision.
 */
async function capturePinCertPem(
  host: string,
  port: number,
  expectedFingerprint: string,
  secure: boolean,
): Promise<PinCertCapture> {
  // A raw ClientHello into a STARTTLS port returns no certificate; probing it
  // would just burn a connection and a 12s timeout.
  if (!secure) return { status: 'unavailable' }
  try {
    const cert = await fetchServerCertificate(host, port)
    if (normalizeFingerprintSha256(cert.fingerprintSha256) !== normalizeFingerprintSha256(expectedFingerprint)) {
      return { status: 'fingerprint-mismatch' }
    }
    return cert.certPem ? { status: 'captured', pem: cert.certPem } : { status: 'unavailable' }
  } catch (err) {
    // PII discipline: probe errors can echo server-supplied text.
    logMain.warn('pin certificate capture failed, storing fingerprint only', {
      port,
      code: errCodeOf(err),
    })
    return { status: 'unavailable' }
  }
}

/** Telemetry tag for a capture outcome (see DOMAINS.cert_pin_pem). */
function pemTag(capture: PinCertCapture): 'captured' | 'unavailable' | 'mismatch' {
  if (capture.status === 'captured') return 'captured'
  if (capture.status === 'fingerprint-mismatch') return 'mismatch'
  return 'unavailable'
}

/**
 * Native confirmations currently on screen, keyed by account + endpoint.
 *
 * A native message box is modal and must be answered; without this guard a
 * compromised renderer could stack an unbounded pile of them on one open offer
 * and grind the user down until one gets clicked through (confirmation
 * fatigue). One endpoint may have at most one confirmation in flight.
 */
const certTrustConfirmInFlight = new Set<string>()

/**
 * Gate 5 — the trusted confirmation surface for minting a TLS trust anchor.
 *
 * Every other gate on `net:trustCert` checks values the renderer already knows:
 * main itself sent the accountId, endpoint and fingerprint to the renderer in
 * the `cert:recoveryRequired` broadcast that opened the offer. Delivering an
 * event to a renderer is not consent from a human, so a compromised renderer
 * (XSS via email content, prompt injection, rogue MCP tool) could replay those
 * four values and pin the attacker's certificate without anything ever being
 * shown to the user — after which the anchored TLS path accepts it. Same
 * problem, same shape and same remedy as `ai:auditLog:clear` (§3.3.B1.f1): put
 * the decision behind a dialog the OS draws, which the renderer cannot script,
 * focus, pre-answer or read.
 *
 * The fingerprint is IN THE PROMPT deliberately: the user confirms one specific
 * certificate on one specific endpoint, not an abstract "trust something".
 *
 * `IS_E2E` short-circuits, as in the exemplar — the harness cannot drive a
 * native dialog.
 */
async function confirmCertTrustNatively(
  sender: Electron.WebContents,
  host: string,
  port: number,
  fingerprint: string,
): Promise<boolean> {
  // The e2e short-circuit is ALSO gated on the build being unpackaged. `IS_E2E`
  // alone reads `MAILCOPILOT_E2E=1` straight out of the environment, which
  // anything running as the user can set (wrapper script, dropper, shell
  // profile) — and a consent gate that an env var switches off is not a consent
  // gate. `app.isPackaged` is true for every electron-builder artifact
  // regardless of env tampering, while dev runs and the Playwright flow keep it
  // false, so the legitimate harness is unaffected. Same reasoning, same pair of
  // conditions as `assertE2EHandlerAllowed` above; see its comment for the full
  // threat model.
  if (IS_E2E && !app.isPackaged) return true
  // English literal: i18next does not run in the main process (see the window
  // title comment near createWindow) — same constraint as the audit-log gate.
  const opts = {
    type: 'warning' as const,
    title: 'Trust this certificate?',
    message: `Trust the certificate presented by ${host}:${port}?`,
    detail:
      `SHA-256 fingerprint:\n${fingerprint}\n\n` +
      'MailCopilot will accept exactly this certificate for this account from ' +
      'now on, including when it is not signed by a recognised authority. ' +
      'Continue only if this fingerprint matches the one published by your ' +
      'mail provider — someone intercepting the connection would present a ' +
      'different certificate. If you did not just ask to trust a certificate, ' +
      'choose Cancel.',
    buttons: ['Cancel', 'Trust Certificate'],
    defaultId: 0,
    cancelId: 0,
  }
  const parent = BrowserWindow.fromWebContents(sender)
  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts)
  // Anything that is not the explicit second button — Cancel, Esc, a destroyed
  // parent window (response −1), an undefined response — is a refusal.
  return result.response === 1
}

/**
 * IPC projection of a pin row: the certificate BODY never crosses to the
 * renderer. It is not a secret, but it is kilobytes per pin on a list the
 * settings window re-reads, and no UI renders it — a boolean is the entire
 * information the renderer needs ("is this pin a usable trust anchor?").
 */
function toPinDto(row: TlsPinRow): Omit<TlsPinRow, 'certPem'> & { hasCertPem: boolean } {
  const { certPem, ...rest } = row
  return { ...rest, hasCertPem: Boolean(certPem) }
}

handleIpc('tls:listPins', (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  return listTlsPins(id).map(toPinDto)
})

/**
 * Settings-driven pin. Separation of powers: this channel may NARROW trust,
 * never grant it.
 *
 * It deliberately stores NO certificate body. A PEM is an OpenSSL trust anchor
 * — the power to make an otherwise-untrusted chain verify — and this channel
 * carries no evidence that a human ever saw the certificate: a compromised
 * renderer can drive `tls:getServerCert` → `tls:addPin` unattended, and under
 * active interception that would silently anchor the attacker's certificate.
 * Anchors are minted only through the main-initiated recovery dialog
 * (`net:trustCert`, gated on a trust offer).
 *
 * A fingerprint-only pin cannot grant anything: the pinned path keeps
 * `rejectUnauthorized: true`, so the chain must ALSO verify against the real
 * root stores. The worst a forged pin achieves is refusing to connect.
 *
 * Consequence: a self-signed server pinned from Settings stays fail-closed
 * until it is confirmed through the recovery dialog — which is exactly where
 * the user sees what they are trusting.
 */
handleIpc('tls:addPin', async (_e, payload: unknown) => {
  const parsed = tlsPinSchema.parse(payload)
  const meta = getAccountMeta(parsed.accountId)
  if (!meta) throw new Error(`Account #${parsed.accountId} not found`)
  let row: TlsPinRow
  try {
    row = upsertTlsPin(parsed.accountId, parsed.host, parsed.port, parsed.fingerprintSha256, null)
  } catch (err) {
    // The pin store validates its inputs and writes nothing when it rejects.
    logMain.warn('tls:addPin rejected by the pin store', {
      accountId: parsed.accountId,
      code: errCodeOf(err),
    })
    throw new Error('tls_pin_write_failed')
  }
  // After adding a pin, the main window should re-sync —
  // the certificate is now accepted and IMAP/SMTP connection should succeed.
  broadcast('accounts:changed', { kind: 'saved', id: parsed.accountId })
  return { ok: true as const, pin: toPinDto(row) }
})

handleIpc('tls:removePin', (_e, pinId: unknown) => {
  const id = tlsPinIdSchema.parse(pinId)
  return { ok: true as const, removed: removeTlsPin(id) }
})

/**
 * Budget for renderer-driven certificate probes (`tls:getServerCert`).
 *
 * The channel legitimately targets endpoints that are NOT yet an account —
 * the Account window fetches a fingerprint while the server is still being
 * typed in — so it cannot be restricted to saved endpoints, and blocking
 * private IP ranges would break self-hosted mail servers, which are the whole
 * reason certificate pinning exists here. What CAN be bounded is volume: a
 * human pinning a certificate needs a handful of probes, a compromised
 * renderer sweeping loopback and the LAN for TLS services needs thousands.
 *
 * Two limits, because they stop different things: the concurrency cap stops
 * parallel socket/slot exhaustion (each probe holds a socket for up to 12s),
 * the rate cap stops slow sequential scanning.
 */
const CERT_PROBE_MAX_CONCURRENT = 2
const CERT_PROBE_MAX_PER_WINDOW = 12
const CERT_PROBE_WINDOW_MS = 60_000
let certProbeInFlight = 0
let certProbeWindowStart = 0
let certProbeWindowCount = 0

/** Reserve a probe slot, or throw. Never leaks the caller's target. */
function acquireCertProbeSlot(): void {
  const nowMs = Date.now()
  if (nowMs - certProbeWindowStart >= CERT_PROBE_WINDOW_MS) {
    certProbeWindowStart = nowMs
    certProbeWindowCount = 0
  }
  if (certProbeInFlight >= CERT_PROBE_MAX_CONCURRENT) {
    logMain.warn('tls:getServerCert refused: too many concurrent probes', {
      inFlight: certProbeInFlight,
    })
    throw new Error('tls_probe_busy')
  }
  if (certProbeWindowCount >= CERT_PROBE_MAX_PER_WINDOW) {
    logMain.warn('tls:getServerCert refused: probe rate limit reached', {
      windowCount: certProbeWindowCount,
    })
    throw new Error('tls_probe_rate_limited')
  }
  certProbeInFlight++
  certProbeWindowCount++
}

handleIpc('tls:getServerCert', async (_e, payload: unknown) => {
  const parsed = tlsServerSchema.parse(payload)
  acquireCertProbeSlot()
  try {
    // Explicit projection: `certPem` is main-process-only (see
    // fetchServerCertificate) — the renderer displays the fingerprint, never
    // the certificate body.
    const cert = await fetchServerCertificate(parsed.host, parsed.port)
    // If a recovery dialog for this endpoint is open and still has no
    // fingerprint to show, this probe result is what it is about to display —
    // record it so the later confirmation can be held against exactly what the
    // user saw. A no-op for every other endpoint (see noteProbedFingerprint):
    // this channel accepts arbitrary addresses, so it must not be able to mint
    // authorization on its own.
    certRecovery.noteProbedFingerprint(parsed.host, parsed.port, cert.fingerprintSha256)
    return {
      host: cert.host,
      port: cert.port,
      fingerprintSha256: cert.fingerprintSha256,
      subject: cert.subject,
      issuer: cert.issuer,
    }
  } finally {
    certProbeInFlight = Math.max(0, certProbeInFlight - 1)
  }
})

/**
 * Resolve the endpoint of `accountId` that a cert-trust payload refers to.
 *
 * A pin is a trust decision, so the endpoint has to be one this account
 * actually talks to. Without the check, any (host, port) the renderer sends
 * gets a pin row: a stale dialog payload pins the wrong server, and a
 * compromised renderer pins an attacker fingerprint onto an arbitrary
 * endpoint. Returns null when nothing matches.
 */
function matchAccountTlsEndpoint(
  meta: AccountMeta,
  host: string,
  port: number,
): 'imap' | 'smtp' | null {
  const wanted = normalizeEndpointHost(host)
  if (normalizeEndpointHost(meta.imap.host) === wanted && meta.imap.port === port) return 'imap'
  if (normalizeEndpointHost(meta.smtp.host) === wanted && meta.smtp.port === port) return 'smtp'
  return null
}

/**
 * Accounts that must be re-synced as soon as their current sync pass ends.
 *
 * A Set, so N trust clicks during one pass collapse into ONE deferred pass.
 * Drained by `drainPendingPostTrustResync` at the single place where
 * `periodicSyncInFlight` is released.
 */
const pendingPostTrustResync = new Set<number>()

/**
 * One-shot per-account resync, used after the user trusted a certificate.
 *
 * `accounts:changed { kind: 'saved' }` refreshes account metadata, prefs,
 * counters and folder roles in the renderer, but it does NOT restart the mail
 * sync that the certificate failure aborted — the user would sit without new
 * mail until the next periodic cycle (up to `periodicSyncIntervalMin`).
 * `runOneAccountPeriodicSync` is the existing per-account entry point (offline
 * replay + sequential folder sync under the soft budget); it never broadcasts
 * `accounts:changed` itself, so no resync→broadcast→resync loop is possible.
 *
 * An in-flight pass does NOT satisfy this resync and must not swallow it: that
 * pass started BEFORE the pin was stored, so it still holds the old connection
 * config without the new trust anchor — it is precisely the pass whose
 * certificate failures raised the dialog. Riding on it would leave the user in
 * the original symptom (clicked "Trust", dialog closed, still no mail). So the
 * account is flagged instead and gets exactly one pass once the current one
 * releases its slot.
 */
function triggerAccountResync(accountId: number): void {
  try {
    if (shuttingDown || IS_E2E) return
    if (getSettings().workOffline) return
    if (periodicSyncInFlight.has(accountId)) {
      // Deferred, not dropped. Set semantics cap this at one pending pass no
      // matter how many times the user confirms.
      pendingPostTrustResync.add(accountId)
      logSync.info(`Post-trust resync for account #${accountId} deferred until the current pass ends`)
      return
    }
    void runOneAccountPeriodicSync(accountId).catch((err) => {
      // Local log keeps the full error for diagnostics; Sentry gets a
      // synthetic one. IMAP/SMTP rejection text can inline server-side user
      // identifiers (over-quota / policy alerts naming the mailbox), so only
      // the already-classified code reaches the remote sink (§8 PII).
      logSync.warn(`Post-trust resync failed for account #${accountId}:`, err)
      const code = (err as { code?: unknown } | null | undefined)?.code
      captureException(new Error('cert_recovery resync failed'), {
        source: 'cert_recovery:resync',
        accountId,
        code: typeof code === 'string' ? code : 'unknown',
      })
    })
  } catch (err) {
    // Never let the resync trigger fail the trust flow — the pin is stored.
    logSync.warn(`Post-trust resync could not start for account #${accountId}:`, err)
  }
}

/**
 * Run the deferred post-trust resync for `accountId`, if one was requested
 * while its previous pass held the in-flight slot.
 *
 * Called from the one place that releases `periodicSyncInFlight`. The flag is
 * cleared BEFORE the new pass starts, so the pass cannot re-arm itself — only
 * a fresh trust click can. `setImmediate` keeps the new pass off the stack of
 * the finally block that just ended the previous one, and routing through
 * `triggerAccountResync` re-evaluates the gates (the user may have gone
 * offline or quit while the pass was draining).
 */
function drainPendingPostTrustResync(accountId: number): void {
  try {
    if (!pendingPostTrustResync.delete(accountId)) return
    setImmediate(() => triggerAccountResync(accountId))
  } catch (err) {
    logSync.warn(`Deferred post-trust resync could not start for account #${accountId}:`, err)
  }
}

/**
 * TLS trust rework — the user accepted the certificate shown by the
 * cert-recovery dialog. This is the ONLY channel that can mint a TLS trust
 * anchor, so it is gated five times over:
 *
 *   1. shape (`certTrustSchema`: bounded port, strict SHA-256);
 *   2. the account exists;
 *   3. the endpoint is one of THAT account's IMAP/SMTP endpoints;
 *   4. main itself has an outstanding trust offer for that ACCOUNT, endpoint
 *      and certificate — i.e. main decided to show this dialog, main is the
 *      one who put that fingerprint on screen (either from its own enrichment
 *      probe or from the `tls:getServerCert` it served to the dialog), and the
 *      user is answering it. Gate 4 is what a compromised renderer cannot
 *      forge: a fresh re-probe only proves what the server serves right now,
 *      never that a human agreed to it, and a token handed to the renderer
 *      would be readable by the same compromised renderer.
 *   5. a native `dialog.showMessageBox`, drawn by the OS, naming this endpoint
 *      and this fingerprint, answered with the explicit trust button. Gates
 *      1–4 all check values main previously BROADCAST to the renderer, so a
 *      compromised renderer can satisfy every one of them by replaying its own
 *      `cert:recoveryRequired` payload — receiving that event is not a human
 *      decision. Gate 5 is the part the renderer cannot produce, and it is what
 *      makes "the user saw this certificate and agreed to it" — the assumption
 *      the anchored TLS path rests on — true by construction rather than by
 *      assumption. See `confirmCertTrustNatively`.
 *
 * Gate 5 covers the WHOLE trust operation, not just the anchor write: the
 * capture probe is an outbound connection, a fingerprint-only pin still narrows
 * how that endpoint is validated, and success burns the offer and kicks off a
 * resync. None of those may follow from a renderer-only decision.
 *
 * Only then is the certificate re-fetched (proving the fingerprint still
 * describes the live endpoint), pinned, and the offer burned.
 */
handleIpc('net:trustCert', async (e, payload: unknown) => {
  const parsed = certTrustSchema.parse(payload)
  const meta = getAccountMeta(parsed.accountId)
  if (!meta) throw new Error(`Account #${parsed.accountId} not found`)
  const host = normalizeEndpointHost(parsed.host)
  const endpointKind = matchAccountTlsEndpoint(meta, host, parsed.port)
  if (!endpointKind) {
    // PII discipline: the rejected host/port are renderer-controlled strings —
    // log the shape of the rejection, never the values.
    logMain.warn('net:trustCert rejected: endpoint does not belong to the account', {
      accountId: parsed.accountId,
      hostLen: host.length,
    })
    throw new Error('Certificate endpoint does not belong to this account')
  }
  const fingerprint = canonicalFingerprintSha256(parsed.fingerprintSha256)
  // Gate 4 — authorization. Peek, do not consume: a later failure (probe,
  // pin write) must leave the dialog answerable so the user can retry.
  const offer = certRecovery.peekTrustOffer(parsed.accountId, host, parsed.port, fingerprint)
  if (offer !== 'ok') {
    const reason = offer === 'fingerprint-mismatch' ? 'offer_fingerprint_mismatch' : 'no_pending_offer'
    logMain.warn('net:trustCert rejected: no matching trust offer from the recovery dialog', {
      accountId: parsed.accountId,
      port: parsed.port,
      reason,
    })
    try {
      recordEvent('cert.trust_rejected', { provider: providerFromHost(host), reason })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_not_offered')
  }
  // Gate 5 — trusted confirmation. Placed after the cheap gates on purpose: an
  // unauthorized caller must not be able to raise a native dialog at all, so
  // the prompt can only appear for an endpoint main itself just flagged.
  const confirmKey = `${parsed.accountId}|${host}|${parsed.port}`
  if (certTrustConfirmInFlight.has(confirmKey)) {
    logMain.warn('net:trustCert rejected: a trust confirmation is already on screen', {
      accountId: parsed.accountId,
      port: parsed.port,
    })
    try {
      recordEvent('cert.trust_rejected', {
        provider: providerFromHost(host),
        reason: 'confirm_in_flight',
      })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_confirm_in_flight')
  }
  certTrustConfirmInFlight.add(confirmKey)
  let confirmed: boolean
  try {
    confirmed = await confirmCertTrustNatively(e.sender, host, parsed.port, fingerprint)
  } finally {
    certTrustConfirmInFlight.delete(confirmKey)
  }
  if (!confirmed) {
    // A refusal is a normal outcome, not a failure: nothing is probed, nothing
    // is written, and the offer is left intact so the user can look again and
    // confirm (or dismiss the dialog) afterwards.
    logMain.info('net:trustCert declined at the native confirmation', {
      accountId: parsed.accountId,
      port: parsed.port,
    })
    try {
      recordEvent('cert.trust_rejected', {
        provider: providerFromHost(host),
        reason: 'user_declined',
      })
    } catch { /* telemetry must not block the trust flow */ }
    return { ok: false as const, cancelled: true as const }
  }
  // Re-check the offer: the confirmation is modal and may sit on screen for a
  // long time, and nothing may be pinned once the offer has aged out of
  // CERT_TRUST_OFFER_TTL_MS or been resolved from elsewhere in the meantime.
  if (certRecovery.peekTrustOffer(parsed.accountId, host, parsed.port, fingerprint) !== 'ok') {
    logMain.warn('net:trustCert rejected: the trust offer expired while the confirmation was open', {
      accountId: parsed.accountId,
      port: parsed.port,
    })
    try {
      recordEvent('cert.trust_rejected', {
        provider: providerFromHost(host),
        reason: 'no_pending_offer',
      })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_not_offered')
  }
  // Capture the certificate body so the pin becomes a usable trust anchor —
  // without it a pinned self-signed server keeps failing closed.
  const secure = endpointKind === 'smtp' ? meta.smtp.secure : meta.imap.secure
  const capture = await capturePinCertPem(host, parsed.port, fingerprint, secure)
  if (capture.status === 'fingerprint-mismatch') {
    // The endpoint now serves a DIFFERENT certificate than the one the dialog
    // showed. Storing a pin for a fingerprint the server no longer presents
    // would be junk at best and would rubber-stamp an active swap at worst.
    // Fail loudly: the renderer keeps the dialog open with an inline error.
    logMain.warn('net:trustCert rejected: served certificate no longer matches the shown fingerprint', {
      accountId: parsed.accountId,
      port: parsed.port,
    })
    try {
      recordEvent('cert.trust_rejected', {
        provider: providerFromHost(host),
        reason: 'fingerprint_mismatch',
      })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_fingerprint_mismatch')
  }
  try {
    upsertTlsPin(
      parsed.accountId, host, parsed.port, fingerprint,
      capture.status === 'captured' ? capture.pem : null,
    )
  } catch (err) {
    // The pin store validates the certificate and writes nothing on rejection;
    // surface it instead of leaving the user with a dialog that "worked" but
    // stored nothing.
    logMain.warn('net:trustCert rejected by the pin store', {
      accountId: parsed.accountId,
      pem: pemTag(capture),
      code: errCodeOf(err),
    })
    try {
      recordEvent('cert.trust_rejected', {
        provider: providerFromHost(host),
        reason: 'pin_write_failed',
      })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_pin_write_failed')
  }
  // The pin exists — burn the offer so this dialog cannot authorize a second
  // one, and start the re-delivery debounce.
  certRecovery.consumeTrustOffer(parsed.accountId, host, parsed.port)
  try {
    recordEvent('cert.trust_clicked', { provider: providerFromHost(host), pem: pemTag(capture) })
  } catch { /* telemetry must not block the trust flow */ }
  broadcast('accounts:changed', { kind: 'saved', id: parsed.accountId })
  triggerAccountResync(parsed.accountId)
  return { ok: true as const }
})

/**
 * Phase A2 — the user declined the cert-recovery dialog. In-memory only: marks
 * the endpoint resolved so repeated cert errors from background sync do not
 * re-open the dialog until the service debounce elapses.
 *
 * Rejects when no dialog is actually pending for that endpoint. Otherwise the
 * channel doubles as a mute button: a renderer could dismiss an endpoint
 * BEFORE its warning happens and swallow the dialog the user is supposed to
 * see. A retry of an already-accepted dismiss still succeeds (the service
 * treats the debounce window as idempotent).
 */
handleIpc('cert:dismiss', (_e, payload: unknown) => {
  const parsed = certDismissSchema.parse(payload)
  const accepted = certRecovery.dismiss(normalizeEndpointHost(parsed.host), parsed.port)
  if (!accepted) {
    logMain.warn('cert:dismiss rejected: no recovery dialog pending for that endpoint', {
      hostLen: parsed.host.length,
      hasPort: parsed.port !== undefined,
    })
    throw new Error('cert_dismiss_not_pending')
  }
  return { ok: true as const }
})

handleIpc('folder:prefs:list', (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  return listFolderPrefs(id)
})

handleIpc('folder:prefs:upsert', (_e, accountId: unknown, folderPath: unknown, patch: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const pathValue = mailboxSchema.parse(folderPath)
  const parsedPatch = folderPrefPatchSchema.parse(patch)
  // §2.15-ter: capture the prior indexInSearch so we can emit
  // cache.folder_index_disabled when the user toggles via context menu.
  const prevIndexInSearch = getFolderPref(id, pathValue)?.indexInSearch
  const pref = upsertFolderPref(id, pathValue, parsedPatch)
  if (
    typeof parsedPatch.indexInSearch === 'boolean' &&
    parsedPatch.indexInSearch === false &&
    prevIndexInSearch !== false
  ) {
    recordEvent('cache.folder_index_disabled', { count: 1, role: 'manual' })
  }
  return { ok: true as const, pref }
})

handleIpc('folder:prefs:remove', (_e, accountId: unknown, folderPath: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const pathValue = mailboxSchema.parse(folderPath)
  return { ok: true as const, removed: removeFolderPref(id, pathValue) }
})

/** Unread counts from SQLite cache (without IMAP requests). */
handleIpc('folder:refreshCounts', (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const stats = listFolderStats(id)
  const result: Record<string, { unread: number; total: number }> = {}
  for (const s of stats) {
    result[s.folderPath] = { unread: s.unreadCount, total: s.messageCount }
  }
  return result
})

// --- IPC: network operations ---
handleIpc('net:testImap', async (_e, cfg: unknown) => {
  if (IS_E2E) return { ok: true as const }
  const parsed = imapSchema.parse(cfg)
  return testImapConnection(parsed)
})

handleIpc('net:testSmtp', async (_e, cfg: unknown) => {
  if (IS_E2E) return { ok: true as const }
  const parsed = smtpSchema.parse(cfg)
  return testSmtpConnection(parsed)
})

// classifyRefreshError moved to electron/authRefreshClassifier.ts so it can
// be unit-tested without booting the whole main.ts module graph.
import { classifyRefreshError } from './authRefreshClassifier'

async function requireAccountConfig(accountIdRaw: unknown): Promise<{ id: number; meta: AccountMeta; cfg: AccountConfig }> {
  const id = accountIdSchema.parse(accountIdRaw)
  const meta = getAccountMeta(id)
  if (!meta) throw new Error(`Account #${id} not found`)
  // Phase A2: subscribe this account to TLS cert-error notifications from the
  // packages/net retry wrappers. Idempotent (service-side registry), so the
  // call is safe on every config load; placing it here guarantees the
  // handler exists before any IMAP operation that could hit a cert failure.
  certRecovery.ensureAccountRegistered(id)
  const base = await getAccountConfig(id)
  if (!base) throw new Error(`Could not load config for account #${id}`)
  const imapPins = listTlsPinsForEndpoint(id, base.imap.host, base.imap.port)
  const smtpPins = listTlsPinsForEndpoint(id, base.smtp.host, base.smtp.port)
  // Pinned certificate bodies travel with the pins: `buildTlsOptions` adds
  // them to `ca` as explicit trust anchors, which is what lets a self-signed
  // or private-CA server verify WITHOUT weakening `rejectUnauthorized`.
  // Empty array (pins created before capture landed, or capture failed) keeps
  // the previous fail-closed behaviour.
  const imapPinCerts = listTlsPinnedCertsPemForEndpoint(id, base.imap.host, base.imap.port)
  const smtpPinCerts = listTlsPinnedCertsPemForEndpoint(id, base.smtp.host, base.smtp.port)

  if (meta.authType === 'oauth2') {
    const accessToken = meta.providerId === 'outlook'
      ? await getOutlookAccessToken(id)
      : await getGoogleAccessToken(id)
    const imapCfg = {
      ...base.imap,
      accessToken,
      tlsPinsSha256: imapPins,
      tlsPinnedCertsPem: imapPinCerts,
    }

    // Register auth-error handler so withImapRetry can refresh the OAuth
    // token on XOAUTH2 failures (e.g. token expired mid-session).
    // The handler clears the token cache and fetches a fresh access token.
    // Keyed by accountId so two DB rows with identical (user, host, port,
    // TLS, pins) — e.g. the same email added twice with distinct refresh
    // tokens — keep separate handler slots.
    registerAuthErrorHandler(id, async () => {
      const provider = meta.providerId === 'outlook' ? 'outlook' : 'google'
      recordEvent('imap.auth_refresh_attempt', { provider })
      try {
        let token: string
        if (meta.providerId === 'outlook') {
          token = await forceRefreshOutlookAccessToken(id)
        } else {
          // Google: clear in-memory cache so getGoogleAccessToken forces a refresh.
          // Google's getGoogleAccessToken already has single-flight via
          // GOOGLE_TOKEN_REFRESH_INFLIGHT, so clearing only the cache is safe.
          GOOGLE_TOKEN_CACHE.delete(id)
          token = await getGoogleAccessToken(id)
        }
        recordEvent('imap.auth_refresh_success', { provider })
        return token
      } catch (err) {
        const reason = classifyRefreshError(err)
        recordEvent('imap.auth_refresh_failure', { provider, reason })
        // PII safety (§8): never forward the raw refresh error to Sentry —
        // Azure/Google error_description can inline UPN (email-like user
        // identifier). Emit a synthetic Error whose message carries only
        // the already-classified enum values. `cause` is intentionally
        // omitted so the original err (and its stack file paths, private
        // OAuth details) stays local to this process.
        // accountId is intentionally dropped from context: it's a
        // low-cardinality correlator that, combined with other events in
        // the same session, could re-identify an account — and this
        // event already carries enough signal via `provider` + `reason`
        // to triage.
        captureException(
          new Error(`auth_refresh_failed: ${provider}/${reason}`),
          { source: 'imap_auth_refresh', provider, reason },
        )
        throw err
      }
    })

    return {
      id,
      meta,
      cfg: {
        imap: imapCfg,
        smtp: {
          ...base.smtp,
          accessToken,
          tlsPinsSha256: smtpPins,
          tlsPinnedCertsPem: smtpPinCerts,
        },
      },
    }
  }

  return {
    id,
    meta,
    cfg: {
      imap: { ...base.imap, tlsPinsSha256: imapPins, tlsPinnedCertsPem: imapPinCerts },
      smtp: { ...base.smtp, tlsPinsSha256: smtpPins, tlsPinnedCertsPem: smtpPinCerts },
    },
  }
}

function assertImapAuth(accountId: number, cfg: AccountConfig['imap']) {
  if (!cfg.pass && !cfg.accessToken) throw new Error(`IMAP authentication for account #${accountId} is not configured`)
}

function assertSmtpAuth(accountId: number, cfg: AccountConfig['smtp']) {
  if (!cfg.pass && !cfg.accessToken) throw new Error(`SMTP authentication for account #${accountId} is not configured`)
}

// unwrapAggregate moved to ./unwrapAggregate for unit-testability — pure
// function, does not depend on the main-process module graph. Used on IPC
// failure paths for §2.14 offline-fallback surface.
import { unwrapAggregate } from './unwrapAggregate'

// queueItemToComposeInit lives in ./queueComposeBridge so the pure
// queue-payload → ComposeInit transform can be unit-tested without dragging
// the Electron module graph into vitest. Kept separate from the surrounding
// schemas to avoid a circular import back into main.ts.

function notifyQueueChanged(accountId?: number) {
  broadcast('mail:queueChanged', {
    accountId: typeof accountId === 'number' ? accountId : null,
    at: new Date().toISOString(),
  })
}

type QueueEnqueuedSource = 'immediate' | 'delay' | 'schedule'

const archiveRefSchema = z.object({
  accountId: accountIdSchema,
  folder: mailboxSchema,
  archiveFolder: mailboxSchema,
  uid: uidSchema,
}).strict()

function notifyQueueEnqueued(payload: { id: string; accountId: number; sendAt: string; source: QueueEnqueuedSource }) {
  broadcast('mail:queued', payload)
}

async function sendMailWithAccountConfig(accountId: number, parsedOptions: SendMailOptions) {
  const metaForFrom = IS_E2E ? E2E_ACCOUNTS.find(a => a.id === accountId) : getAccountMeta(accountId)

  // 2.3-B: honour identityId when Compose supplied it. The identity wins over
  // both the legacy top-level `name` and the `parsedOptions.from` email — the
  // whole point of the selector is to let the user send from an alias/other
  // identity without touching the primary account config.
  const matchedIdentity = parsedOptions.identityId
    ? (metaForFrom?.identities ?? []).find(i => i.id === parsedOptions.identityId)
    : undefined
  const identityDisplayName = matchedIdentity?.displayName?.trim()
  const identityEmail = matchedIdentity?.email?.trim()

  const displayName = (identityDisplayName || metaForFrom?.name || '').trim()
  const fromEmail = identityEmail || parsedOptions.from
  const fromHeader = displayName ? `${displayName} <${fromEmail}>` : fromEmail

  if (IS_E2E) {
    const now = new Date().toISOString()
    const msg: E2EMail = {
      uid: ++E2E_UID_SEQ,
      from: fromHeader,
      to: parsedOptions.to,
      cc: parsedOptions.cc,
      bcc: parsedOptions.bcc,
      subject: parsedOptions.subject,
      date: now,
      unread: false,
      flagged: false,
      hasAttachments: Boolean(parsedOptions.attachments && parsedOptions.attachments.length > 0),
      text: parsedOptions.text,
      html: parsedOptions.html,
    }
    e2eBox(accountId, 'Sent').unshift(msg)
    upsertContactsOutgoing([
      ...parseDisplayAddressList(parsedOptions.to),
      ...parseDisplayAddressList(parsedOptions.cc),
      ...parseDisplayAddressList(parsedOptions.bcc),
    ].map(a => ({ email: a.address || '', name: a.name })))
    return { messageId: 'e2e' }
  }

  const { meta, cfg } = await requireAccountConfig(accountId)

  // Strip identityId before handing off — it's a renderer-side hint used
  // only by the From-header resolver above. Unknown fields are harmless
  // but noisy.
  const { identityId: _identityId, ...sendMailOptionsForTransport } = parsedOptions
  void _identityId

  let result: { messageId: string }
  if (meta.providerId === 'outlook') {
    // Personal Outlook.com mailboxes have SMTP AUTH disabled server-side
    // with no user toggle for most accounts created in 2024+ (Mozilla SUMO
    // KB + Microsoft Q&A 5816949). Send via Graph `POST /me/sendMail`
    // which uses a separate `graph.microsoft.com` resource token and is
    // unaffected by the SMTP policy.
    logMail.info(`Graph send attempt account=${accountId} provider=outlook`)
    const graphToken = await getOutlookGraphSendAccessToken(accountId)
    result = await sendMailViaGraph({
      accessToken: graphToken,
      options: { ...sendMailOptionsForTransport, from: fromHeader },
    })
  } else {
    assertSmtpAuth(accountId, cfg.smtp)
    const trySend = async (smtpCfg: AccountConfig['smtp']) => {
      logMail.info(`SMTP send attempt account=${accountId} host=${smtpCfg.host}:${smtpCfg.port} secure=${smtpCfg.secure ? 'true' : 'false'}`)
      return sendMail(smtpCfg, { ...sendMailOptionsForTransport, from: fromHeader })
    }

    try {
      result = await trySend(cfg.smtp)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const isTimeout = /timeout|ETIMEDOUT|Connection timeout/i.test(message)
      const canFallbackGmail = cfg.smtp.host.toLowerCase() === 'smtp.gmail.com' && cfg.smtp.port === 465 && cfg.smtp.secure
      if (isTimeout && canFallbackGmail) {
        logMail.warn(`SMTP timeout on 465, retrying STARTTLS 587 for account=${accountId}`)
        result = await trySend({ ...cfg.smtp, port: 587, secure: false })
      } else {
        throw e
      }
    }
  }
  upsertContactsOutgoing([
    ...parseDisplayAddressList(parsedOptions.to),
    ...parseDisplayAddressList(parsedOptions.cc),
    ...parseDisplayAddressList(parsedOptions.bcc),
  ].map(a => ({ email: a.address || '', name: a.name })))

  // Save a copy to the Sent folder via IMAP APPEND.
  //
  // Skip for Outlook: Graph `POST /me/sendMail` auto-saves server-side
  // to the mailbox's default "Sent Items" folder. The `saveToSentItems`
  // query parameter is documented for the JSON request shape only — the
  // MIME variant (text/plain + base64) ignores it (Microsoft Q&A 2122804).
  // An explicit APPEND here would therefore create a duplicate.
  //
  // Known limitation (2.2-F follow-up): users with a custom `folderRoles.sent`
  // override on Outlook accounts will see sent mail in the mailbox's default
  // Sent Items folder, not their custom one. Fixing this requires switching
  // the Graph send payload to JSON mode (which supports saveToSentItems=false),
  // letting our APPEND be authoritative again. Deferred — it's an edge case
  // since most users rely on the default Sent folder.
  // §2.23 diagnostic — hoist sentFolder + rawSize so catch can report which
  // folder we targeted and how big the payload was. Without this, the only
  // signal on APPEND failure is the opaque `Error: Command failed`.
  let sentFolderForDiag: string | undefined
  let rawSizeForDiag: number | undefined
  if (meta.providerId !== 'outlook') try {
    assertImapAuth(accountId, cfg.imap)
    const mailboxes = await listMailboxes(accountId, cfg.imap)
    const detected = detectFolderRoles(mailboxes)
    const roles = mergeRoles(mailboxes, detected, meta.folderRoles ?? {})
    const sentFolder = roles.sent
    sentFolderForDiag = sentFolder

    if (sentFolder) {
      // §2.22 fix iter2A — propagate `alternatives` (e.g. `text/calendar;
      // method=REPLY` for RSVP) into the APPEND'ed copy so the Sent-folder
      // mirror of an RSVP carries the same calendar alternative the
      // recipient saw. `sendMailOptionsForTransport` is the post-zod-schema
      // object; the optional widening to `{ alternatives?: ... }` is honoured
      // by buildRawMessage's MailComposer layer.
      const transportWithAlts = sendMailOptionsForTransport as
        SendMailOptions & { alternatives?: Array<{ contentType: string; content: string | Buffer }> }
      const raw = await buildRawMessage({
        from: fromHeader,
        to: parsedOptions.to,
        cc: parsedOptions.cc,
        bcc: parsedOptions.bcc,
        subject: parsedOptions.subject,
        text: parsedOptions.text,
        html: parsedOptions.html,
        attachments: parsedOptions.attachments,
        alternatives: transportWithAlts.alternatives,
        messageId: result.messageId,
      })
      rawSizeForDiag = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
      await appendToMailbox(accountId, cfg.imap, sentFolder, raw)
      // Notify renderer so Sent folder refreshes immediately without waiting for IDLE.
      broadcast('mail:exists', { accountId, path: sentFolder, force: true })
    } else {
      // No Sent folder resolved — log so we can spot accounts where
      // detectFolderRoles + folderRoles override both come up empty.
      logMail.warn(`Sent folder not resolved for account=${accountId} provider=${meta.providerId} — APPEND skipped, message delivered via SMTP only`)
    }
  } catch (e) {
    // §2.23 — enrich silent APPEND failure with server response + folder +
    // size + Sentry capture. ImapFlow errors typically carry
    // `code`/`response`/`responseStatus`/`responseText`/`serverResponseCode`/
    // `command` — defensively extract whatever exists.
    const err = e as {
      code?: unknown
      response?: unknown
      responseStatus?: unknown
      responseText?: unknown
      serverResponseCode?: unknown
      command?: unknown
      message?: unknown
    } | null | undefined
    const pickStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, 500) : undefined
    // Cap the String(e) fallback the same way as every other field — an
    // unbounded stringified error must not reach Sentry (codex §2.24 MEDIUM-3).
    const diag = {
      accountId,
      providerId: meta.providerId ?? null,
      sentFolder: sentFolderForDiag ?? null,
      rawSize: rawSizeForDiag ?? null,
      messageId: result.messageId ?? null,
      errorMessage: pickStr(err?.message)
        ?? (e instanceof Error ? e.message : String(e)).slice(0, 500),
      errorCode: pickStr(err?.code),
      errorResponse: pickStr(err?.response),
      errorResponseStatus: pickStr(err?.responseStatus),
      errorResponseText: pickStr(err?.responseText),
      errorServerResponseCode: pickStr(err?.serverResponseCode),
      errorCommand: pickStr(err?.command),
    }
    logMail.warn('Could not save copy to Sent (diag):', diag)
    captureException(e, { source: 'sendMail:appendToSent', ...diag })
    // §2.23 PR1 — fire-and-forget: typed `send_queue.append_failed` metric
    // (enum buckets only — see services/sentCopyFailure.ts for the PII
    // boundary) + `mail:sentCopyFailed` broadcast so the renderer can toast
    // "delivered, but no Sent copy". Never throws — SMTP already succeeded.
    reportSentCopyAppendFailure(e, {
      accountId,
      providerId: meta.providerId,
      sentFolder: sentFolderForDiag ?? null,
    }, broadcast)
  }

  return result
}

// --- Snooze background processing ---

function notifySnoozeChanged(accountId?: number) {
  broadcast('mail:snoozeChanged', {
    accountId: typeof accountId === 'number' ? accountId : null,
    at: new Date().toISOString(),
  })
}

let snoozeProcessing = false

function processSnoozed() {
  if (shuttingDown) return
  if (snoozeProcessing) return
  snoozeProcessing = true
  try {
    const now = new Date().toISOString()
    const due = listDueSnooze(now)
    for (const item of due) {
      removeSnooze(item.id)
      logSnooze.info(`Snooze wake: id=${item.id} account=${item.accountId} folder=${item.folder} uid=${item.uid}`)
      broadcast('mail:snoozeWake', {
        id: item.id,
        accountId: item.accountId,
        folder: item.folder,
        uid: item.uid,
        messageId: item.messageId,
      })
      notifySnoozeChanged(item.accountId)
    }
  } catch (e) {
    logSnooze.error('processSnoozed error:', e instanceof Error ? e.message : e)
  } finally {
    snoozeProcessing = false
  }
}

let followUpProcessing = false
const FOLLOWUP_POLL_INTERVAL_MS = 60_000

function processFollowUps() {
  if (shuttingDown) return
  if (followUpProcessing) return
  followUpProcessing = true
  try {
    const now = new Date().toISOString()
    const due = listDueFollowUps(now)
    for (const fu of due) {
      logFollowUp.info(`Follow-up due: id=${fu.id} account=${fu.accountId} to=${fu.toAddr} subject=${fu.subject}`)
      broadcast('mail:followUpDue', {
        id: fu.id,
        accountId: fu.accountId,
        toAddr: fu.toAddr,
        subject: fu.subject,
        remindAt: fu.remindAt,
        sentMessageId: fu.sentMessageId,
      })
      markFollowUpNotified(fu.id)
      // Persist notification so it doesn't get lost if user misses the desktop popup
      addNotification(
        'followup_due',
        fu.subject ?? `Follow-up: ${fu.toAddr}`,
        fu.toAddr,
        String(fu.id),
      )
    }
  } catch (e) {
    logFollowUp.error('processFollowUps error:', e instanceof Error ? e.message : e)
  } finally {
    followUpProcessing = false
  }
}

/**
 * Classify an SMTP send failure into a low-cardinality tag domain. Mirrors
 * DOMAINS.send_failure_kind in metricsSchema.ts.
 */
function smtpFailureKind(code: number | null, err: unknown): 'auth' | 'tls' | 'network' | 'rate_limit' | 'permanent' | 'unknown' {
  const msg = String((err as Error)?.message ?? err ?? '').toLowerCase()
  if (code != null) {
    if (code === 421 || code === 450 || code === 451 || code === 452) return 'rate_limit'
    if (code === 535 || code === 530 || code === 534) return 'auth'
    if (code >= 500) return 'permanent'
    if (code >= 400) return 'network'
  }
  if (/auth|credentials|password|login/i.test(msg)) return 'auth'
  if (/tls|cert|ssl|pin/i.test(msg)) return 'tls'
  if (/timeout|network|enotfound|econn|offline|dns/i.test(msg)) return 'network'
  if (/rate.?limit|too many/i.test(msg)) return 'rate_limit'
  return 'unknown'
}

let sendQueueProcessing = false

async function processSendQueue() {
  if (shuttingDown) return
  if (sendQueueProcessing) return
  sendQueueProcessing = true
  try {
    const due = listDueSendQueue(new Date().toISOString(), 20)
    for (const item of due) {
      const claimed = markSendQueueSending(item.id)
      if (!claimed) continue
      const dispatchT0 = Date.now()
      try {
        const options = sendMailOptionsSchema.parse(item.messageData)
        await sendMailWithAccountConfig(item.accountId, options)
        markSendQueueSent(item.id)
        // Telemetry: time from row creation to successful SMTP delivery.
        // item.createdAt is the original enqueue timestamp — this captures
        // the full user-visible latency, not just the SMTP roundtrip.
        const enqueuedAt = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : dispatchT0
        recordHistogram('send_queue.sent', Date.now() - enqueuedAt, {
          scheduled: item.sendAt != null && Date.parse(item.sendAt) > enqueuedAt + 1000,
        })
        // Archive original message if this was a Send & Archive operation
        if (item.archiveRef) {
          try {
            const ref = item.archiveRef
            const { cfg } = await requireAccountConfig(ref.accountId)
            assertImapAuth(ref.accountId, cfg.imap)
            await moveMessages(cfg.imap, ref.folder, ref.archiveFolder, [ref.uid], ref.accountId)
            purgeVirtualFolderRefs(ref.accountId, ref.folder, [ref.uid])
            logMail.info(`Archived original after send: account=${ref.accountId} ${ref.folder}/${ref.uid} → ${ref.archiveFolder}`)
            broadcast('mail:backgroundArchived', { accountId: ref.accountId, folder: ref.folder, uids: [ref.uid] })
          } catch (archiveErr) {
            logMail.warn('Could not archive original after send:', archiveErr)
          }
        }
      } catch (e) {
        const { code, isTransient } = classifySmtpError(e)
        const subj = typeof item.messageData === 'object' && item.messageData && 'subject' in item.messageData
          ? String((item.messageData as Record<string, unknown>).subject || '')
          : ''

        if (isTransient && item.attemptCount < 5) {
          // Transient error (4xx / network): reschedule with exponential backoff
          const delayMs = SMTP_RETRY_DELAYS_MS[Math.min(item.attemptCount, SMTP_RETRY_DELAYS_MS.length - 1)]
          const retryAt = new Date(Date.now() + delayMs).toISOString()
          rescheduleSendQueue(item.id, retryAt)
          recordEvent('send_queue.retried', { attempt_number: item.attemptCount + 1 })
          logMail.warn(`Send queue item ${item.id} transient error (code=${code}), retry #${item.attemptCount + 1} at ${retryAt}: ${String(e)}`)
        } else {
          // Permanent error (5xx) or max attempts reached
          markSendQueueFailed(item.id, String(e))
          recordEvent('send_queue.failed', { failure_kind: smtpFailureKind(code, e) })
          logMail.error(`Send queue item ${item.id} failed permanently (code=${code}, attempts=${item.attemptCount}): ${String(e)}`)
          broadcast('mail:sendFailed', {
            id: item.id,
            accountId: item.accountId,
            error: String(e),
            subject: subj,
          })
          addNotification(
            'send_failed',
            subj || 'Send failed',
            String(e),
            item.id,
          )
        }
      } finally {
        notifyQueueChanged(item.accountId)
      }
    }
  } finally {
    sendQueueProcessing = false
  }
}

// --- IMAP IDLE / push ---

/**
 * §2.16 — accounts whose Drafts mailbox we've already swept this session.
 * The sweep walks every UID in Drafts and groups by our X-MailCopilot-Draft-Id
 * header to delete duplicates left by previous saves that hit the
 * `dedup_impossible` branch (or by SEARCH races on mail.ru-class servers).
 * One pass per account is enough — if more orphans appear during the
 * session they are caught by saveDraft's primary dedup path.
 */
const draftsSweptAccounts = new Set<number>()

function maybeScheduleOrphanDraftsSweep(accountId: number, cfg: ImapConfig): void {
  if (draftsSweptAccounts.has(accountId)) return
  // Resolve the Drafts folder. We rely on cached folder roles populated by
  // listMailboxes; if Drafts is not yet known, skip silently — the next
  // time IDLE comes up (e.g. user opens a folder) we'll try again.
  const roles = getCachedFolderRoles(accountId) as Record<string, string | undefined> | null
  const draftsPath = roles?.drafts
  if (!draftsPath) return
  draftsSweptAccounts.add(accountId)
  // Fire-and-forget: NEVER await the sweep from the IDLE start path. setTimeout
  // moves it out of the current microtask queue so IDLE bring-up is not
  // delayed even by a single tick. sweepOrphanDrafts itself is wrapped in
  // try/catch and reports errors via reportNetError.
  setTimeout(() => {
    void (async () => {
      try {
        const result = await sweepOrphanDrafts(accountId, cfg, draftsPath)
        if (result.deleted > 0) {
          logDraftSync.info(`sweep account=${accountId} groups=${result.groups} deleted=${result.deleted}`)
        }
      } catch (err) {
        logDraftSync.warn(`sweep failed account=${accountId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }, 0)
}

handleIpc('net:idleStart', async (_e, accountId: unknown, mailbox: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  if (IS_E2E || getSettings().workOffline) return { ok: true as const }

  // Replay pending offline ops before starting IDLE (push local changes first)
  try {
    const pendingOps = getOfflineOps(id)
    if (pendingOps.length > 0) {
      await replayOfflineOps(id, getImapConfigForReplay)
    }
  } catch (err) {
    logReplay.warn(`Pre-IDLE replay failed for account #${id}:`, err)
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)

  await startIdle(id, cfg.imap, parsedMailbox, (data) => {
    // Forward the event to renderer, where we decide what to do (sync/notifications).
    broadcast('mail:exists', { accountId: id, ...data })
  })
  // §2.16 — opportunistically clean up any duplicate drafts left by previous
  // sessions. Non-blocking, runs once per account per app session.
  maybeScheduleOrphanDraftsSweep(id, cfg.imap)
  return { ok: true as const }
})

handleIpc('net:idleStop', async () => {
  if (IS_E2E) return { ok: true as const }
  await stopIdle()
  return { ok: true as const }
})

/** Merge auto-detected roles with user-defined overrides (non-empty and existing only). */
function mergeRoles(mailboxes: { path: string }[], detected: FolderRoles, userRoles: FolderRoles): FolderRoles {
  const mailboxPaths = new Set(mailboxes.map(m => m.path))
  const overrides = Object.fromEntries(
    Object.entries(userRoles).filter(([, v]) => typeof v === 'string' && v.length > 0 && mailboxPaths.has(v))
  ) as FolderRoles
  return { ...detected, ...overrides } as FolderRoles
}

function folderRoleByPath(pathValue: string, specialUse: string | null | undefined, roles: FolderRoles): string | null {
  if (specialUse) return specialUse
  if (pathValue === 'INBOX') return '\\Inbox'
  if (roles.archive === pathValue) return '\\Archive'
  if (roles.trash === pathValue) return '\\Trash'
  if (roles.sent === pathValue) return '\\Sent'
  if (roles.drafts === pathValue) return '\\Drafts'
  if (roles.junk === pathValue) return '\\Junk'
  return null
}

function isTypicalRole(role: string | null): boolean {
  return role === '\\Inbox'
    || role === '\\Sent'
    || role === '\\Drafts'
    || role === '\\Trash'
    || role === '\\Junk'
    || role === '\\Archive'
}

function defaultFolderPref(role: string | null): Pick<FolderPreference, 'visible' | 'includeInBadges' | 'headerSyncMode' | 'offlineMode' | 'offlineDays' | 'indexInSearch'> {
  // §2.15-ter: auto-exclude Junk/Spam/Trash from full-text search. Users
  // can override via the folder context menu, but the default keeps these
  // high-noise folders from polluting search results.
  const noiseRoles = role === '\\Trash' || role === '\\Junk'
  if (role === '\\Inbox') {
    return {
      visible: true,
      includeInBadges: true,
      headerSyncMode: 'full',
      offlineMode: 'period',
      offlineDays: 30,
      indexInSearch: true,
    }
  }
  if (isTypicalRole(role)) {
    return {
      visible: true,
      includeInBadges: false,
      headerSyncMode: 'full',
      offlineMode: 'off',
      indexInSearch: !noiseRoles,
    }
  }
  return {
    visible: false,
    includeInBadges: false,
    headerSyncMode: 'off',
    offlineMode: 'off',
    indexInSearch: true,
  }
}

function ensureFolderPrefs(accountId: number, mailboxes: Array<{ path: string; specialUse?: string | null }>, roles: FolderRoles): Record<string, FolderPreference> {
  const existingRows = listFolderPrefs(accountId)
  const byPath = new Map(existingRows.map(r => [r.folderPath, r]))
  const serverPaths = new Set(mailboxes.map(b => b.path))

  // Prune stale folder_prefs for folders no longer on server (e.g. Gmail language change).
  const stalePaths = existingRows
    .filter(r => !serverPaths.has(r.folderPath))
    .map(r => r.folderPath)
  if (stalePaths.length > 0) {
    deleteStaleFolderPrefs(accountId, stalePaths)
    deleteFolderCrawlStatesByPaths(accountId, stalePaths)
    for (const p of stalePaths) byPath.delete(p)
    logSync.info(`Pruned ${stalePaths.length} stale folder prefs for account #${accountId}: ${stalePaths.join(', ')}`)
  }

  // §2.15-ter telemetry: count how many folders we auto-flag as
  // index_in_search=false on first registration so dashboards can spot
  // providers where role detection differs (e.g. localised Trash/Junk
  // folder names not caught by detectFolderRoles).
  const autoDisabledByRole = { junk: 0, trash: 0 }

  for (const box of mailboxes) {
    const role = folderRoleByPath(box.path, box.specialUse, roles)
    if (!byPath.has(box.path)) {
      const defaults = defaultFolderPref(role)
      const created = upsertFolderPref(accountId, box.path, defaults)
      byPath.set(created.folderPath, created)
      if (defaults.indexInSearch === false) {
        if (role === '\\Junk') autoDisabledByRole.junk++
        else if (role === '\\Trash') autoDisabledByRole.trash++
      }
    } else {
      // Migration: upgrade typical folders from on_open to full (Search Excellence Hardening).
      // Previously typical folders defaulted to on_open; now they default to full.
      const existing = byPath.get(box.path)!
      if (existing.headerSyncMode === 'on_open' && isTypicalRole(role)) {
        const updated = upsertFolderPref(accountId, box.path, { headerSyncMode: 'full' })
        byPath.set(updated.folderPath, updated)
      }
    }
  }

  if (autoDisabledByRole.junk > 0) {
    recordEvent('cache.folder_index_disabled', { count: autoDisabledByRole.junk, role: 'spam' })
  }
  if (autoDisabledByRole.trash > 0) {
    recordEvent('cache.folder_index_disabled', { count: autoDisabledByRole.trash, role: 'trash' })
  }

  const result: Record<string, FolderPreference> = {}
  for (const [pathValue, pref] of byPath) {
    result[pathValue] = {
      accountId: pref.accountId,
      folderPath: pref.folderPath,
      visible: pref.visible,
      includeInBadges: pref.includeInBadges,
      headerSyncMode: pref.headerSyncMode,
      headerSyncDays: pref.headerSyncDays,
      offlineMode: pref.offlineMode,
      offlineDays: pref.offlineDays,
      icon: pref.icon,
      indexInSearch: pref.indexInSearch,
    }
  }
  return result
}

// Per-account single-flight dedup for `net:mailboxesAndRoles`. Renderer cold
// start previously fired three parallel IPCs for the same account (observed
// 2026-04-23: three concurrent LIST on one account held main-event-loop blocked
// 22s). Part 1 (commit ca7ed27) closed renderer-side coalescing; this Map
// closes the main-side race where IPCs were already in flight before the
// renderer debounce could merge them. We wrap the whole handler (not just the
// slow IMAP branch) so the Map shape is uniform regardless of which return
// path hits — E2E / workOffline paths return quickly, and sharing a promise
// across them is a no-op cost. Cleanup is funnel-finally (single `.finally`
// on the wrapper promise) so a synchronous throw inside the executor, or a
// rejected promise from listMailboxes, cannot leak a stale entry in the Map.
// Inflight value type is left as the handler body's inferred return (a union
// of the IS_E2E / workOffline / IMAP-fetch branch shapes). We intentionally
// do NOT tighten it with an explicit annotation here: the `workOffline` path
// returns `prefs: FolderPrefRow[]` while the other two paths return
// `prefs: Record<string, FolderPreference>`, and reconciling that shape
// divergence is out of scope for Subtask 3 (renderer already handles both).
type MailboxesAndRolesPayload = Awaited<ReturnType<typeof computeMailboxesAndRoles>>
const mailboxesAndRolesInflight = new Map<number, Promise<MailboxesAndRolesPayload>>()

async function computeMailboxesAndRoles(id: number) {
  if (IS_E2E) {
    const meta = E2E_ACCOUNTS.find(a => a.id === id)
    const userRoles = meta?.folderRoles ?? {}
    const mailboxes = [...e2eMailboxes(id)]
    const detected = detectFolderRoles(mailboxes)
    const roles = mergeRoles(mailboxes, detected, userRoles)
    const prefs = ensureFolderPrefs(id, mailboxes, roles)
    return { mailboxes, detected, roles, prefs }
  }

  if (getSettings().workOffline) {
    // Return cached data without IMAP
    const allCached = getAllCachedMailboxes()
    const cached = allCached[id] ?? []
    const cachedRoles = getCachedFolderRoles(id)
    const prefs = listFolderPrefs(id)
    return { mailboxes: cached, detected: cachedRoles ?? {}, roles: cachedRoles ?? {}, prefs }
  }

  const { meta, cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)

  const mailboxes: Mailbox[] = await listMailboxes(id, cfg.imap)
  const detected = detectFolderRoles(mailboxes)
  const userRoles = meta.folderRoles ?? {}
  const roles = mergeRoles(mailboxes, detected, userRoles)
  const prefs = ensureFolderPrefs(id, mailboxes, roles)
  // Cache roles and mailboxes for instant startup on next launch.
  try { cacheFolderRoles(id, roles) } catch { /* non-critical */ }
  try { cacheMailboxes(id, mailboxes.map(m => ({ path: m.path, name: m.name, specialUse: m.specialUse, unread: m.unread }))) } catch { /* non-critical */ }
  return { mailboxes, detected, roles, prefs }
}

// Returns folder list and roles in a single request (to avoid 2x LIST and race conditions).
handleIpc('net:mailboxesAndRoles', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)

  const existing = mailboxesAndRolesInflight.get(id)
  if (existing) {
    logMailboxesAndRoles.debug(`Coalescing mailboxesAndRoles for account ${id} (attaching to in-flight request)`)
    return existing
  }

  const run = computeMailboxesAndRoles(id)

  mailboxesAndRolesInflight.set(id, run)

  // Clean up only if the map still points at THIS run — defensive against a
  // theoretical race where a caller somehow overwrote the slot (shouldn't
  // happen with a single handler, but costs nothing to guard). The .catch on
  // the .finally chain itself is there so an unexpected throw inside the
  // cleanup callback (there isn't one, but belt-and-suspenders) doesn't
  // create an unhandledRejection — the real rejection of `run` propagates to
  // every awaiter via the `return run` below.
  run.finally(() => {
    if (mailboxesAndRolesInflight.get(id) === run) {
      mailboxesAndRolesInflight.delete(id)
    }
  }).catch(() => { /* swallow — original rejection propagates via `run` */ })

  return run
})

handleIpc('net:inboxSummaries', async (_e, accountId: unknown, folder?: unknown, lightweight?: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFolder = folder ? mailboxSchema.parse(folder) : 'INBOX'
  const isLightweight = lightweight === true

  if (IS_E2E) {
    const box = e2eBox(id, parsedFolder)
    const list = [...box]
      .sort((a, b) => b.uid - a.uid)
      .map(m => ({
        ...displayFromParts(m.from),
        accountId: id,
        folder: parsedFolder,
        uid: m.uid,
        subject: m.subject,
        toAddr: m.to,
        messageId: m.messageId,
        inReplyTo: m.inReplyTo,
        references: m.references,
        date: m.date,
        unread: m.unread,
        flagged: m.flagged,
        hasAttachments: Boolean(m.hasAttachments),
      }))
    upsertMessages(id, parsedFolder, list.map(m => ({ ...m })))
    upsertContactsIncoming(
      list
        .map(m => ({ email: (m.fromAddr || '').trim(), name: m.fromName || undefined }))
        .filter(x => Boolean(x.email))
    )
    // §2.7: drop UIDs the renderer has optimistically moved out (undo window).
    return filterPendingMoves(list)
  }

  if (getSettings().workOffline) return []

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)

  // Snapshot max UID before fetch so we can detect truly new messages for rule evaluation.
  const prevMaxUid = getMaxUidForFolder(id, parsedFolder)
  const result = await fetchInboxSummaries(cfg.imap, parsedFolder, 50, id, isLightweight)

  // Evaluate mail rules on newly appeared messages (fire-and-forget).
  const newUids = result.filter(m => m.uid > prevMaxUid).map(m => m.uid)
  if (newUids.length > 0) {
    processMailRules(id, parsedFolder, newUids).catch(err =>
      logRules.error('Background processMailRules (inboxSummaries) failed:', err)
    )
  }

  // §2.7: drop UIDs the renderer has optimistically moved out (undo window).
  return filterPendingMoves(result)
})

handleIpc('net:folderPage', async (_e, accountId: unknown, folder: unknown, limit: unknown, beforeUidRaw: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  const lim = z.number().int().positive().parse(limit)
  const beforeUid = beforeUidSchema.parse(beforeUidRaw)

  if (IS_E2E) {
    const sorted = [...e2eBox(id, parsedFolder)].sort((a, b) => b.uid - a.uid)
    const page = typeof beforeUid === 'number'
      ? sorted.filter(m => m.uid < beforeUid).slice(0, lim)
      : sorted.slice(0, lim)
    const list = page.map(m => ({
      ...displayFromParts(m.from),
      accountId: id,
      folder: parsedFolder,
      uid: m.uid,
      subject: m.subject,
      toAddr: m.to,
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
      date: m.date,
      unread: m.unread,
      flagged: m.flagged,
      hasAttachments: Boolean(m.hasAttachments),
    }))
    upsertMessages(id, parsedFolder, list.map(m => ({ ...m })))
    upsertContactsIncoming(
      list
        .map(m => ({ email: (m.fromAddr || '').trim(), name: m.fromName || undefined }))
        .filter(x => Boolean(x.email))
    )
    // §2.7: drop UIDs the renderer has optimistically moved out (undo window).
    return filterPendingMoves(list)
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  // §2.7: drop UIDs the renderer has optimistically moved out (undo window).
  return filterPendingMoves(await fetchFolderSummariesPage(cfg.imap, parsedFolder, lim, beforeUid, id))
})

/**
 * Remove stale read_later and snoozed entries when messages are moved or deleted.
 * UIDs change on IMAP MOVE, so references become dangling.
 */
function purgeVirtualFolderRefs(accountId: number, folder: string, uids: number[]): void {
  for (const uid of uids) {
    removeReadLaterByUid(accountId, folder, uid)
    removeSnoozeByUid(accountId, folder, uid)
  }
}

// --- Static mail rules ---

/**
 * Execute a single rule action on a message via IMAP.
 * Folder-role based actions (archive, trash, spam) resolve target folder from cached roles.
 */
async function executeRuleAction(accountId: number, folder: string, uid: number, action: RuleAction): Promise<void> {
  const { cfg } = await requireAccountConfig(accountId)
  assertImapAuth(accountId, cfg.imap)
  const roles = getCachedFolderRoles(accountId) as Record<string, string | undefined> | null

  switch (action.type) {
    case 'archive': {
      const target = roles?.archive
      if (target && target !== folder) {
        await moveMessages(cfg.imap, folder, target, [uid], accountId)
        deleteEmls(accountId, folder, [uid])
        purgeVirtualFolderRefs(accountId, folder, [uid])
      }
      break
    }
    case 'trash': {
      const target = roles?.trash
      if (target && target !== folder) {
        await moveMessages(cfg.imap, folder, target, [uid], accountId)
        deleteEmls(accountId, folder, [uid])
        purgeVirtualFolderRefs(accountId, folder, [uid])
      }
      break
    }
    case 'mark_spam': {
      const target = roles?.junk
      if (target && target !== folder) {
        await moveMessages(cfg.imap, folder, target, [uid], accountId)
        deleteEmls(accountId, folder, [uid])
        purgeVirtualFolderRefs(accountId, folder, [uid])
      }
      break
    }
    case 'move': {
      if (action.folder && action.folder !== folder) {
        await moveMessages(cfg.imap, folder, action.folder, [uid], accountId)
        deleteEmls(accountId, folder, [uid])
        purgeVirtualFolderRefs(accountId, folder, [uid])
      }
      break
    }
    case 'mark_read': {
      await setSeen(cfg.imap, folder, [uid], true, accountId)
      break
    }
    case 'mark_starred': {
      await setFlagged(cfg.imap, folder, [uid], true, accountId)
      break
    }
  }
}

/**
 * Evaluate static mail rules on newly synced messages.
 * Called after folder header sync with UIDs that were not previously in the DB cache.
 */
async function processMailRules(accountId: number, folder: string, newUids: number[]): Promise<void> {
  if (newUids.length === 0) return
  try {
    const rows = listMailRules(String(accountId))
    if (rows.length === 0) return

    const parsedRules: MailRule[] = rows.filter(r => r.enabled).map(r => ({
      id: r.id,
      accountId: r.accountId,
      name: r.name,
      enabled: true,
      priority: r.priority,
      conditions: JSON.parse(r.conditions) as MailRule['conditions'],
      actions: JSON.parse(r.actions) as MailRule['actions'],
      stopProcessing: r.stopProcessing,
    }))
    if (parsedRules.length === 0) return

    for (const uid of newUids) {
      try {
        const msg = getMessageByUid(accountId, folder, uid)
        if (!msg) continue

        const context: MailContext = {
          from: msg.from,
          fromAddr: msg.fromAddr,
          to: msg.toAddr || '',
          subject: msg.subject,
          hasAttachments: msg.hasAttachments,
          accountId,
        }

        // Evaluate rules and collect matched (rule, actions) pairs in one pass.
        const sorted = [...parsedRules].sort((a, b) => a.priority - b.priority)
        const matched: Array<{ rule: MailRule; actions: RuleAction[] }> = []
        for (const rule of sorted) {
          if (!rule.enabled) continue
          if (rule.accountId !== null && String(rule.accountId) !== String(context.accountId)) continue
          if (!matchRule(rule, context)) continue
          matched.push({ rule, actions: rule.actions })
          if (rule.stopProcessing) break
        }

        if (matched.length === 0) {
          // No static rule matched — enqueue for AI rules pipeline
          enqueueForAiRules({
            accountId,
            folder,
            uid,
            from: msg.from,
            to: msg.toAddr || '',
            subject: msg.subject,
            bodyPreview: (msg.bodyText || '').substring(0, 500),
            hasAttachment: msg.hasAttachments,
          })
          continue
        }

        const allActions = matched.flatMap(m => m.actions)
        logRules.info(`Rule matched for uid=${uid} in ${folder}: ${allActions.map(a => a.type).join(',')}`)

        for (const { rule, actions } of matched) {
          for (const action of actions) {
            await executeRuleAction(accountId, folder, uid, action)
            try {
              insertRuleLog({
                ruleId: rule.id,
                ruleName: rule.name,
                accountId,
                folder,
                uid,
                subject: msg.subject,
                fromAddr: msg.fromAddr,
                actionTaken: JSON.stringify(action),
              })
            } catch (logErr) {
              logRules.error(`Failed to log rule execution:`, logErr)
            }
          }
        }
      } catch (err) {
        logRules.error(`Failed to process rule for uid=${uid}:`, err)
      }
    }
  } catch (err) {
    logRules.error('processMailRules error:', err)
  }
}

// --- AI Rules pipeline (B2.23 / §2.39) ---
//
// Background email triage driven by user-authored natural-language rules. This
// is the ONE background path that calls a model on untrusted email content, so
// it carries the same invariants as the interactive AI contour (CLAUDE.md §5).
// The orchestration itself lives in `./services/aiRulesPipeline` (extracted so
// tests exercise the REAL pipeline with injected fakes instead of a mirror
// copy of the loop). main.ts owns only: the in-memory queue instance, the
// rolling rate-limit state, the timer, and the wiring of real collaborators
// (aiChatSimple, executeRuleAction, DB accessors, telemetry).

const logAiRules = createLogger('AiRules')

type AiRulePendingItem = CoreAiRulePendingItem

const aiRuleQueue: AiRulePendingItem[] = []
const AI_RULE_BATCH_INTERVAL = 30_000
const AI_RULE_BATCH_SIZE = CORE_AI_RULE_BATCH_SIZE
const AI_RULE_MAX_PER_HOUR = AI_RULE_MAX_CALLS_PER_HOUR

const aiRuleRateState = createRateLimitState()

/** Reset the rolling hourly rate-limit window (exported for tests). */
function resetAiRuleRateLimit(): void {
  aiRuleRateState.callCount = 0
  aiRuleRateState.resetAt = Date.now() + 3_600_000
}

/** Assemble the injected dependency bundle for the extracted pipeline. Every
 *  collaborator here is a real main-process function; the pipeline never
 *  reaches into main.ts state directly. */
function buildAiRulesDeps(): AiRulesPipelineDeps {
  return {
    queue: aiRuleQueue,
    isShuttingDown: () => shuttingDown,
    listAiRules: () => listAiRules(),
    sumRuleCostSince: (sinceIso) => sumAiRuleCostSince(sinceIso),
    getMailboxCache: () => getAllCachedMailboxes(),
    aiChatSimple: (systemPrompt, userPrompt) => aiChatSimple(systemPrompt, userPrompt),
    executeRuleAction: (accountId, folder, uid, action) =>
      executeRuleAction(accountId, folder, uid, action),
    insertAiRuleLog: (data) => { insertAiRuleLog(data) },
    // Best-effort audit mirror (Privacy Panel). §2.39: the daily budget is a
    // SOFT cap, so the pipeline does not depend on the durable-persist result —
    // no cross-tick carry of un-persisted charges (the HARD hourly call cap is
    // the real bound).
    appendAiActionLog: (row) => { appendAiActionLog(row) },
    getProviderModel: () => {
      const settings = getSettings()
      return { provider: settings.aiProvider ?? 'unknown', model: settings.aiModel ?? null }
    },
    recordEvent: (name, tags) => { (recordEvent as (n: string, t: Record<string, string>) => void)(name, tags) },
    log: {
      info: (msg) => logAiRules.info(msg),
      warn: (msg) => logAiRules.warn(msg),
      error: (msg, err) => logAiRules.error(msg, err),
    },
    now: () => Date.now(),
  }
}

/** Enqueue an email for background AI-rule triage (delegates to the pipeline's
 *  bounded drop-oldest queue). */
function enqueueForAiRules(item: AiRulePendingItem): void {
  pipelineEnqueue(aiRuleQueue, item)
}

/** Run one AI-rule batch through the extracted pipeline. */
async function processAiRuleBatch(): Promise<void> {
  await pipelineProcessBatch(buildAiRulesDeps(), aiRuleRateState)
}

// Exported for tests
export { aiRuleQueue, enqueueForAiRules, processAiRuleBatch, resetAiRuleRateLimit, AI_RULE_BATCH_SIZE, AI_RULE_MAX_PER_HOUR }

// Track active header sync operations so body indexer can pause during heavy sync.
let activeHeaderSyncs = 0
export function isHeaderSyncActive() { return activeHeaderSyncs > 0 }

// Single-flight coalescing for duplicate concurrent syncs on the same
// (accountId, folder). Renderer navigation + periodic sync + IDLE EXISTS
// can all fire a sync for the same folder within milliseconds; running
// them in parallel produces IMAP connection contention, duplicated DB
// writes, and amplifies main-thread stalls. Instead we keep the first
// sync's promise and return it for any follow-up requests until it settles.
type SyncFolderHeadersResult = { ok: true; fetched: number; completed: boolean } | undefined
const inflightSyncs = new Map<string, Promise<SyncFolderHeadersResult>>()
const SYNC_SLOW_UPSERT_MS = 100
const SYNC_SLOW_POST_MS = 50

handleIpc('net:syncFolderHeaders', async (_e, accountId: unknown, folder: unknown, options: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  const opts = syncFolderHeadersOptionsSchema.parse(options)

  if (getSettings().workOffline) return

  // Key includes mode because 'full' and 'period' have materially different
  // semantics (full walks the entire UID space, period limits to N days).
  // Coalescing across modes would let a manual full-sync silently attach to
  // an in-flight periodic run and never execute full-sync semantics.
  const mode = opts?.mode ?? 'full'
  const syncKey = `${id}\x00${parsedFolder}\x00${mode}`
  const inflight = inflightSyncs.get(syncKey)
  if (inflight) {
    logSync.info(`Coalescing syncFolderHeaders for account ${id} folder "${parsedFolder}" mode=${mode} (attaching to in-flight run)`)
    recordEvent('sync.headers.coalesced', {
      folder_role: folderRoleFromPath(parsedFolder),
    })
    return inflight
  }

  const runPromise = runSyncFolderHeaders(id, parsedFolder, opts)
  inflightSyncs.set(syncKey, runPromise)
  try {
    return await runPromise
  } finally {
    // Clear only if still pointing at this run — defensive against a race where
    // the map was somehow overwritten (shouldn't happen, but cheap to guard).
    if (inflightSyncs.get(syncKey) === runPromise) {
      inflightSyncs.delete(syncKey)
    }
  }
})

async function runSyncFolderHeaders(
  id: number,
  parsedFolder: string,
  opts: z.infer<typeof syncFolderHeadersOptionsSchema>,
): Promise<SyncFolderHeadersResult> {
  const mode = opts?.mode ?? 'full'
  const batchSize = opts?.batchSize ?? 500
  const syncWallStart = Date.now()
  let syncSucceeded = false

  // Instrumentation: track time spent in the synchronous better-sqlite3
  // write callback vs the rest (IMAP network wait, crawl-state writes).
  // Aggregated per sync run and logged at the end so we can see where the
  // actual main-thread blocking is, instead of guessing.
  let upsertTotalMs = 0
  let upsertBatches = 0
  let upsertRows = 0
  let upsertMaxBatchMs = 0

  // Increment BEFORE any async work so body indexer sees isPaused()=true
  // and doesn't grab per-account lock that would deadlock header sync.
  activeHeaderSyncs++
  try {

  // Replay pending offline ops before sync so local changes are pushed first
  try {
    const pendingOps = getOfflineOps(id)
    if (pendingOps.length > 0) {
      await replayOfflineOps(id, getImapConfigForReplay)
    }
  } catch (err) {
    logReplay.warn(`Pre-sync replay failed for account #${id}:`, err)
  }

  if (IS_E2E) {
    const list = [...e2eBox(id, parsedFolder)].sort((a, b) => b.uid - a.uid)
    upsertMessages(id, parsedFolder, list.map(m => ({
      uid: m.uid,
      subject: m.subject,
      fromAddr: m.from,
      fromName: undefined,
      toAddr: m.to,
      date: m.date,
      unread: m.unread,
      flagged: m.flagged,
      hasAttachments: Boolean(m.hasAttachments),
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
    })))
    return { ok: true as const, fetched: list.length, completed: true }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)

  // Mark folder as crawling before starting sync — but only for first-time crawls.
  // For already-covered folders doing incremental sync, keep their covered status
  // to avoid counter jumps in the UI statusbar.
  try {
    const existingState = getFolderCrawlState(id, parsedFolder)
    const isCovered = existingState?.status === 'covered_full' || existingState?.status === 'covered_recent'
    if (!isCovered) {
      upsertFolderCrawlState(id, parsedFolder, {
        status: 'crawling',
        lastAttemptAt: new Date().toISOString(),
        error: null,
      })
    }
  } catch { /* non-critical */ }

  // Snapshot the current max UID so we can detect truly new messages after sync.
  const prevMaxUid = getMaxUidForFolder(id, parsedFolder)


  let fetched = 0
  let completed = false
  const allFetchedUids: number[] = []

  try {
    // Resumable crawl: always start from the top (newest first) and walk down.
    // If a prior crawl already reached a watermark, we stop early once we reach
    // that watermark — the messages below it were already fetched in a prior run.
    // For already covered_full folders, the watermark also acts as a stop point:
    // only new messages above the watermark are fetched (incremental sync).
    let beforeUid: number | undefined = undefined
    const priorCrawl = getFolderCrawlState(id, parsedFolder)
    const priorSync = getSyncState(id, parsedFolder)

    // If prior crawl was partial (covered_recent) — resume from where we left off,
    // starting below the watermark to continue crawling deeper into the folder.
    const resumingPartialCrawl = mode === 'full' && priorCrawl?.status === 'covered_recent' && priorCrawl.watermarkUid
    if (resumingPartialCrawl) {
      beforeUid = priorCrawl.watermarkUid! + 1 // start just below prior watermark
      logSync.info(`Resuming partial crawl for ${parsedFolder} account ${id} from uid<${beforeUid}`)
    }

    // NOTE: we no longer call getMailboxStatus() here — it used the main singleton
    // connection which competes with IDLE for connection slots on Yandex (which has
    // a strict connection limit). fetchAllFolderHeaders() already opens the mailbox
    // on a dedicated connection and returns exists/modseq/uidValidity.
    // Deletion detection is handled by syncFolderFlagsOnly() / CONDSTORE reconciliation.
    let liveServerCount: number | null = priorCrawl?.totalExists ?? null
    let liveModseq: string | null = priorCrawl?.highestModseq ?? null
    // Tracks whether the FLAGS-only "fetch new-UIDs" inner branch got a
    // skipped result (stale_wipe_guard tripped). Gates the final crawl
    // state advance so we don't promote the folder to 'covered_full'
    // while the newly discovered UIDs were NOT actually fetched.
    // Codex §2.15 wave-3 Medium #2.
    let newResultWasSkipped = false
    logSync.info(`${parsedFolder} account ${id}: priorModseq=${liveModseq ?? 'none'} priorExists=${liveServerCount ?? 'none'}`)

    const resumeWatermark = (mode === 'full' && priorCrawl?.watermarkUid && !resumingPartialCrawl)
      ? priorCrawl.watermarkUid
      : undefined

    const syncAccountEmail = cfg.imap.user || `account-${id}`
    const serverTotal = liveServerCount ?? priorCrawl?.totalExists ?? null
    // Don't broadcast initial progress — it shows stale counts like "505/2721"
    // that persist in statusbar when sync stalls. Only broadcast during actual FETCH.

    // Non-CONDSTORE servers with prior sync: use lightweight FLAGS-only sync (Thunderbird pattern).
    // Only fetch UIDs + FLAGS (~40 bytes/msg) instead of full headers (~500 bytes/msg).
    // Then fetch full headers only for NEW messages not in local cache.
    const hasCompletedSync = priorCrawl?.status === 'covered_full' || priorCrawl?.status === 'covered_recent'
    if (!liveModseq && hasCompletedSync && !resumingPartialCrawl) {
      try {
        const flagResult = await syncFolderFlagsOnly(cfg.imap, parsedFolder, id, priorSync?.uidValidity ?? undefined)
        logSync.info(`FLAGS sync ${parsedFolder} account ${id}: new=${flagResult.newUids.length} deleted=${flagResult.deletedCount} flagsUpdated=${flagResult.flagsUpdated}`)

        // UIDVALIDITY changed — cache was purged, fall through to full header sync
        if (flagResult.uidValidityChanged) {
          logSync.warn(`UIDVALIDITY changed for ${parsedFolder} account ${id}, falling back to full sync`)
          try { upsertSyncState(id, parsedFolder, null, flagResult.uidValidity) } catch { /* non-critical */ }
          // Don't return — fall through to the full sync path below
        } else {
          if (flagResult.newUids.length > 0) {
            // FLAGS-hole recovery (2026-04-21 P0 data-loss fix).
            //
            // When FLAGS-only sync discovers new UIDs while prior status was
            // 'covered_full', we might be looking at one of two scenarios:
            //   1. Legitimate new mail that arrived since last sync.
            //   2. A recovery from a partial cache wipe — UIDs that should
            //      have been in the cache but somehow aren't (the actual
            //      regression trigger on 2026-04-21: ~2685 "new" UIDs in
            //      Archive that were really the missing majority of the
            //      folder, re-surfacing after WAL loss).
            //
            // In case 2, the status MUST be downgraded to 'crawling' before
            // we start the recovery fetch. If we keep 'covered_full' and
            // the process crashes mid-recovery, the next launch will see
            // the stale 'covered_full' and skip the re-fetch — leaving the
            // hole permanently.
            //
            // Cheap heuristic: if newUids.length is > 5% of total_exists
            // or > 100 absolute, treat as recovery. Under normal incoming
            // mail that threshold is almost never hit.
            const newUidCount = flagResult.newUids.length
            const totalOnServer = priorCrawl?.totalExists ?? 0
            const isLikelyRecovery = priorCrawl?.status === 'covered_full' &&
              (newUidCount > 100 || (totalOnServer > 0 && newUidCount * 20 > totalOnServer))
            if (isLikelyRecovery) {
              logSync.warn(
                `FLAGS-hole recovery for ${parsedFolder} account ${id}: ` +
                `${newUidCount} new UIDs found while status=covered_full ` +
                `(total_on_server=${totalOnServer}). Downgrading status to 'crawling' ` +
                `until recovery completes.`
              )
              try {
                upsertFolderCrawlState(id, parsedFolder, {
                  status: 'crawling',
                  lastAttemptAt: new Date().toISOString(),
                  error: null,
                })
              } catch { /* non-critical — state downgrade failure doesn't block fetch */ }
            }

            // Fetch full headers only for new messages
            const newResult = await fetchAllFolderHeaders(
              cfg.imap, parsedFolder, id,
              (batch, totalFetched) => {
                const t0 = Date.now()
                // Atomic boundary (2026-04-21 P0 data-loss fix): messages
                // batch upsert AND folder_crawl_state.crawled_count bump
                // happen in one transaction. Prevents partial persistence
                // where rows exist on disk but the crawl state doesn't
                // reflect them (or the other way around).
                applyFolderSyncBatch(
                  id,
                  parsedFolder,
                  batch.map(m => ({
                    uid: m.uid, subject: m.subject, fromAddr: m.fromAddr || '', fromName: m.fromName,
                    toAddr: m.toAddr, date: m.date, unread: m.unread, flagged: m.flagged,
                    hasAttachments: m.hasAttachments, messageId: m.messageId,
                    inReplyTo: m.inReplyTo, references: m.references,
                    attachmentFilenames: m.attachmentFilenames,
                  })),
                  null,
                )
                const dt = Date.now() - t0
                upsertTotalMs += dt
                upsertBatches++
                upsertRows += batch.length
                if (dt > upsertMaxBatchMs) upsertMaxBatchMs = dt
                if (dt >= SYNC_SLOW_UPSERT_MS) {
                  logSync.warn(`slow upsertMessages ${parsedFolder} acc ${id}: ${dt}ms for ${batch.length} rows`)
                }
                for (const m of batch) allFetchedUids.push(m.uid)
                fetched = totalFetched
                broadcast('sync:folderProgress', { accountId: id, account: syncAccountEmail, folder: parsedFolder, fetched, total: serverTotal })
              },
              { sinceUid: Math.min(...flagResult.newUids) - 1, batchSize },
            )
            liveModseq = newResult.highestModseq ?? liveModseq
            newResultWasSkipped = Boolean(newResult.skipped)
            logSync.info(`Header sync ${parsedFolder} account ${id}: fetched=${fetched} (new messages only)${newResultWasSkipped ? ' — fetch skipped by stale_wipe_guard' : ''}`)
          } else {
            logSync.info(`Header sync ${parsedFolder} account ${id}: no new messages (FLAGS-only sync)`)
          }
          // Gate state advance on the newResult (if we took that branch):
          // if fetchAllFolderHeaders returned { skipped: true } via the
          // stale_wipe_guard path, the newly discovered UIDs were NOT
          // actually fetched. Advancing to 'covered_full' here would pin
          // the folder in a state where next sync trusts an incomplete
          // cache. Codex §2.15 wave-3 Medium #2.
          // State advance is unsafe if:
          //   1. FLAGS sync itself tripped its stale_wipe_guard (ambiguous
          //      mailbox.exists from server — we don't know which UIDs are
          //      new or deleted), OR
          //   2. FLAGS sync returned new UIDs, but the inner fetch for those
          //      new UIDs was skipped via stale_wipe_guard on the full-header
          //      path (rare but possible when mailbox state flips between
          //      the two mailboxOpen calls).
          // Codex §2.15 wave-4 Medium.
          const stateAdvanceSafe = !flagResult.stalewipeGuardTripped
            && !(flagResult.newUids.length > 0 && newResultWasSkipped)
          completed = stateAdvanceSafe
          broadcast('sync:folderProgress', { accountId: id, account: syncAccountEmail, folder: parsedFolder, fetched, total: serverTotal, done: true })
          if (!stateAdvanceSafe) {
            logSync.warn(`Header sync ${parsedFolder} account ${id}: new-UIDs fetch returned skipped — NOT advancing crawl state`)
          }

          // Update crawl state — only when state advance is safe.
          if (stateAdvanceSafe) try {
            const postT0 = Date.now()
            const now = new Date().toISOString()
            const totalCrawled = getAccountMessageCount(id, parsedFolder)
            const maxUid = getMaxUidForFolder(id, parsedFolder)
            // Final commit via applyFolderSyncBatch. Messages array is
            // empty here — this reduces to a single-statement transactional
            // `upsertFolderCrawlState`. The ordering guarantee (no message
            // batch pending after this call) comes from the synchronous
            // completion of the fetch await above, not from a shared
            // BEGIN/COMMIT with message rows.
            applyFolderSyncBatch(id, parsedFolder, [], {
              status: 'covered_full',
              watermarkUid: maxUid > 0 ? maxUid : (priorCrawl?.watermarkUid ?? null),
              totalExists: liveServerCount ?? priorCrawl?.totalExists ?? null,
              crawledCount: totalCrawled,
              highestModseq: null, // non-CONDSTORE
              lastAttemptAt: now,
              completedAt: now,
              error: null,
            })
            try { upsertSyncState(id, parsedFolder, null, flagResult.uidValidity) } catch { /* non-critical */ }
            const postDt = Date.now() - postT0
            if (postDt >= SYNC_SLOW_POST_MS) {
              logSync.warn(`slow post-sync writes ${parsedFolder} acc ${id}: ${postDt}ms`)
            }
            logSync.info(`Crawl state update ${parsedFolder} account ${id}: status=covered_full watermark=${maxUid} totalExists=${liveServerCount}`)
          } catch { /* non-critical */ }

          syncSucceeded = true
          return { ok: true as const, fetched, completed }
        }
      } catch (err) {
        // FLAGS-only sync failed — fall through to full sync
        logSync.warn(`FLAGS-only sync failed for ${parsedFolder} account ${id}, falling back to full sync:`, err)
      }
    }

    // Full header sync (CONDSTORE servers, initial crawl, or fallback)
    // sinceUid = skip UIDs below this value (incremental: only fetch new messages above watermark).
    // For resumingPartialCrawl (covered_recent) — do NOT set sinceUid! The crawl needs to go DEEPER
    // (below watermark), not higher. beforeUid is already set above for that purpose.
    const sinceUid: number | undefined = resumeWatermark
    logSync.info(`Starting fetchAllFolderHeaders for ${parsedFolder} account ${id} sinceUid=${sinceUid ?? 'none'}`)
    const result = await fetchAllFolderHeaders(
      cfg.imap,
      parsedFolder,
      id,
      (batch, totalFetched) => {
        // Save to DB — without this, headers are fetched but never persisted!
        // Atomic boundary (2026-04-21 P0 data-loss fix): wrap the batch
        // upsert in applyFolderSyncBatch so message rows and any crawl
        // state update happen under the same transaction. Batches in the
        // middle of the fetch only persist messages (crawl state is
        // finalised after the whole fetch completes), but using the
        // helper here keeps the surface uniform and ensures the
        // transaction boundary is respected even if a future caller
        // starts nudging crawl state mid-fetch.
        const t0 = Date.now()
        applyFolderSyncBatch(
          id,
          parsedFolder,
          batch.map(m => ({
            uid: m.uid,
            subject: m.subject,
            fromAddr: m.fromAddr || '',
            fromName: m.fromName,
            toAddr: m.toAddr,
            date: m.date,
            unread: m.unread,
            flagged: m.flagged,
            hasAttachments: m.hasAttachments,
            messageId: m.messageId,
            inReplyTo: m.inReplyTo,
            references: m.references,
            attachmentFilenames: m.attachmentFilenames,
          })),
          null,
        )
        const dt = Date.now() - t0
        upsertTotalMs += dt
        upsertBatches++
        upsertRows += batch.length
        if (dt > upsertMaxBatchMs) upsertMaxBatchMs = dt
        if (dt >= SYNC_SLOW_UPSERT_MS) {
          logSync.warn(`slow upsertMessages ${parsedFolder} acc ${id}: ${dt}ms for ${batch.length} rows`)
        }
        for (const m of batch) allFetchedUids.push(m.uid)
        fetched = totalFetched
        broadcast('sync:folderProgress', { accountId: id, account: syncAccountEmail, folder: parsedFolder, fetched, total: serverTotal })
      },
      {
        sinceUid: sinceUid ?? undefined,
        // Partial-crawl signal. The numeric value is a historical watermark
        // from the prior descent, but fetchAllFolderHeaders no longer uses
        // it as a header-fetch ceiling: after a partial cache wipe, gap UIDs
        // can live ABOVE the watermark and must still be recovered. Its
        // current role is (a) presence disables the CONDSTORE CHANGEDSINCE
        // optimisation so the FLAGS scan returns every server UID, and
        // (b) it documents the caller's intent for future readers.
        beforeUid: resumingPartialCrawl ? beforeUid : undefined,
        batchSize,
        // CONDSTORE: pass known modseq so unchanged folders are skipped entirely.
        // Do NOT pass for partial crawl — we need to download old messages, not skip them.
        knownModseq: resumingPartialCrawl ? undefined : (priorCrawl?.highestModseq ?? undefined),
        // UIDVALIDITY guard: if server reassigned UIDs, forces full resync
        knownUidValidity: priorSync?.uidValidity ?? undefined,
      },
    )
    // Guard (Codex §2.15 wave-2 Medium / wave-4 Medium): three
    // `skipped: true` paths exist:
    //   1. CONDSTORE modseq unchanged → exists = real count (trust it).
    //   2. stale_wipe_guard non-numeric → exists = 0 (untrusted).
    //   3. stale_wipe_guard negative   → exists < 0 (untrusted).
    // And one non-skipped empty-folder path that legitimately reports 0.
    // Rule: only overwrite liveServerCount AND liveModseq when the result
    // is trustworthy. `highestModseq` must be gated the same way — if the
    // ambiguous response carried a new modseq, persisting it would let
    // next CONDSTORE sync skip work the cache never fetched.
    //   - non-skipped (fresh FETCH completed), OR
    //   - skipped but exists > 0 (CONDSTORE fast-path with real count).
    if (!result.skipped) {
      liveServerCount = result.exists ?? liveServerCount
      liveModseq = result.highestModseq ?? liveModseq
    } else if (typeof result.exists === 'number' && result.exists > 0) {
      liveServerCount = result.exists
      liveModseq = result.highestModseq ?? liveModseq
    }
    // Trust-tier gate for `completed` (Codex §2.15 wave-3 Medium #1):
    //   - non-skipped → real FETCH ran, state advance is safe.
    //   - skipped + exists > 0 → CONDSTORE modseq-unchanged fast path
    //     with a real server count; state advance is safe (nothing new
    //     to fetch).
    //   - skipped + exists <= 0 → stale_wipe_guard tripped on ambiguous
    //     server response (non-numeric / negative exists); we cannot
    //     trust this run to represent "folder fully crawled". Leave
    //     completed = false so downstream does not promote the folder
    //     to 'covered_full' with a stale snapshot.
    const stalewipeSuspect = Boolean(result.skipped) && !(typeof result.exists === 'number' && result.exists > 0)
    completed = !stalewipeSuspect
    if (stalewipeSuspect) {
      logSync.warn(`Header sync ${parsedFolder} account ${id}: stale_wipe_guard tripped (exists=${String(result.exists)}) — NOT advancing crawl state`)
    } else if (result.skipped) {
      logSync.info(`Header sync ${parsedFolder} account ${id}: skipped (CONDSTORE modseq unchanged, exists=${result.exists})`)
    } else {
      logSync.info(`Header sync ${parsedFolder} account ${id}: fetched=${fetched}`)
    }
    broadcast('sync:folderProgress', { accountId: id, account: syncAccountEmail, folder: parsedFolder, fetched, total: serverTotal, done: true })

    // Remove stale messages ONLY when we're confident we have the complete UID set.
    // For CONDSTORE: result.skipped means nothing changed — don't touch.
    // For non-CONDSTORE: FLAGS-only path handles deletions separately via syncFolderFlagsOnly.
    // Full header fetch: only safe if we actually fetched ALL messages (fetched >= server count).
    const safeToRemoveStale = !result.skipped && allFetchedUids.length > 0 && mode === 'full' && !sinceUid
      && serverTotal != null && allFetchedUids.length >= serverTotal
    if (safeToRemoveStale) {
      // allFetchedUids is number[] but `safeToRemoveStale` has already
      // narrowed it to non-empty. The new-signature overload requires either
      // a non-empty tuple (compile-time proven) or an explicit opts.reason.
      // We use the second path with 'reconcile' because this is precisely
      // the reconciliation case: caller has the full authoritative UID set
      // from the just-completed full crawl.
      try {
        removeStaleMessages(id, parsedFolder, allFetchedUids, { reason: 'reconcile' })
      } catch { /* non-critical */ }
    }

    // Update folder crawl state for search coverage tracking.
    // Watermark semantics differ by completion state:
    //   covered_full  → watermark = maxUid (next sync: fetch only UID > watermark)
    //   covered_recent → watermark = lowestUid reached (next partial crawl: continue below)
    const postT0 = Date.now()
    try {
      const now = new Date().toISOString()
      const totalOnServer = liveServerCount ?? priorCrawl?.totalExists ?? null
      const totalCrawled = getAccountMessageCount(id, parsedFolder)
      const trulyComplete = completed && (!totalOnServer || totalCrawled >= totalOnServer)
      const newStatus = trulyComplete ? 'covered_full' : 'covered_recent'

      let effectiveWatermark: number | null
      if (trulyComplete) {
        // covered_full: store maxUid as watermark for incremental sync (skip everything below)
        const maxUid = getMaxUidForFolder(id, parsedFolder)
        effectiveWatermark = maxUid > 0 ? maxUid : (priorCrawl?.watermarkUid ?? null)
      } else {
        // covered_recent: store lowest UID reached for resumable crawl (continue below)
        const lowestUidThisRun = allFetchedUids.length > 0 ? Math.min(...allFetchedUids) : null
        effectiveWatermark = lowestUidThisRun ?? priorCrawl?.watermarkUid ?? null
      }
      logSync.info(`Crawl state update ${parsedFolder} account ${id}: status=${newStatus} watermark=${effectiveWatermark} totalExists=${liveServerCount}`)
      // Route through applyFolderSyncBatch(id, folder, [], crawlStateUpdate)
      // so every final-state write goes through the same seam that supports
      // a tail-batch upsert (messages + state in one transaction) when a
      // future caller chooses to use it. In the current call the messages
      // array is empty, so this reduces to a single-statement transactional
      // `upsertFolderCrawlState` — NOT a true messages+state atomic commit.
      // Correctness of the "state ahead of data" property here still comes
      // from the sequential ordering (all message batches committed before
      // this call), not from a shared BEGIN/COMMIT.
      applyFolderSyncBatch(id, parsedFolder, [], {
        status: newStatus,
        watermarkUid: effectiveWatermark,
        totalExists: liveServerCount ?? priorCrawl?.totalExists ?? null,
        crawledCount: totalCrawled,
        highestModseq: liveModseq ?? priorCrawl?.highestModseq ?? null,
        lastAttemptAt: now,
        completedAt: trulyComplete ? (priorCrawl?.completedAt ?? now) : null,
        error: null,
      })
      // Persist UIDVALIDITY + modseq for next sync's guard/skip checks
      upsertSyncState(id, parsedFolder, liveModseq ?? priorCrawl?.highestModseq ?? null, result.uidValidity)
    } catch (crawlErr) {
      logSync.error(`Crawl state update failed for ${parsedFolder} account ${id}:`, crawlErr instanceof Error ? crawlErr.message : crawlErr)
    }
    const postDt = Date.now() - postT0
    if (postDt >= SYNC_SLOW_POST_MS) {
      logSync.warn(`slow post-sync writes ${parsedFolder} acc ${id}: ${postDt}ms`)
    }

    // Evaluate static mail rules on newly appeared messages (fire-and-forget).
    const newUids = allFetchedUids.filter(uid => uid > prevMaxUid)
    if (newUids.length > 0) {
      processMailRules(id, parsedFolder, newUids).catch(err =>
        logRules.error('Background processMailRules failed:', err)
      )
    }
  } catch (syncErr) {
    // Force-close stale IMAP connection on timeout/error so next sync gets a fresh one
    const errMsg = syncErr instanceof Error ? syncErr.message : String(syncErr)
    if (/timeout|ETIMEDOUT|not usable|closed/i.test(errMsg)) {
      logSync.warn(`Force-disconnecting IMAP after error: ${errMsg}`)
      forceDisconnectImap()
    }
    // Clear sync progress in the UI so statusbar doesn't show stale data
    broadcast('sync:folderProgress', { accountId: id, folder: parsedFolder, done: true })
    // Record error state in folder crawl state.
    try {
      upsertFolderCrawlState(id, parsedFolder, {
        status: 'error',
        lastAttemptAt: new Date().toISOString(),
        error: errMsg.slice(0, 500),
      })
    } catch { /* non-critical */ }
    throw syncErr
  }

  syncSucceeded = true
  return { ok: true as const, fetched, completed }

  } finally {
    activeHeaderSyncs--
    const wallMs = Date.now() - syncWallStart
    // Onboarding funnel: first successful sync for this account closes the
    // "account added → mail visible" step. markFirstHeadersSync is one-shot
    // per account id, so a second sync never re-emits.
    if (syncSucceeded) {
      // Phase A2: the first successful sync of an account in this session
      // triggers the one-time TLS interception-notice probe (dedup, host
      // persistence and error containment live inside the service).
      try { certRecovery.noteSyncSuccess(id) } catch { /* never break sync */ }
      try {
        // Legacy-safe gate: only accounts that were observed created by
        // the accounts:save handler AFTER telemetry shipped have an entry
        // in accountSeenAt. Accounts from pre-telemetry installs return
        // null here and must NOT pollute the onboarding funnel with a
        // fake "duration 0" first-sync. We still mark firstSyncDone so
        // the check doesn't walk the store on every subsequent sync.
        const seenAt = getAccountSeenAt(id)
        const firstSyncAt = markFirstHeadersSync(id)
        if (firstSyncAt !== null && seenAt !== null) {
          const duration = Math.max(0, firstSyncAt - seenAt)
          const allMailboxes = getAllCachedMailboxes()
          const boxes = allMailboxes[id] ?? []
          const folderCount = boxes.length
          const { cfg: accCfg } = await requireAccountConfig(id).catch(() => ({ cfg: null }))
          const providerTag = accCfg ? providerFromHost(accCfg.imap.host) : 'other'
          recordHistogram('onboarding.first_headers_sync_completed', duration, {
            provider: providerTag,
            folder_count_bucket: bucketFolderCount(folderCount),
          })
        }
      } catch { /* telemetry never breaks sync */ }
    }
    // Per-run instrumentation summary. Only log when there was real work
    // or when wall time exceeded a threshold (avoid flooding on skipped syncs).
    if (upsertBatches > 0 || wallMs >= 1000) {
      logSync.info(
        `sync profile ${parsedFolder} acc ${id}: wall=${wallMs}ms ` +
        `upsert=${upsertTotalMs}ms (${upsertBatches} batches, ${upsertRows} rows, max=${upsertMaxBatchMs}ms) ` +
        `other=${wallMs - upsertTotalMs}ms`,
      )
    }
    // Emit structured metrics for aggregate analysis. Runs are keyed by
    // folder role (not path) so cross-account dashboards are meaningful.
    recordHistogram('sync.headers.wall_ms', wallMs, {
      folder_role: folderRoleFromPath(parsedFolder),
      upsert_ms: upsertTotalMs,
      other_ms: wallMs - upsertTotalMs,
      batches: upsertBatches,
      rows: upsertRows,
      max_batch_ms: upsertMaxBatchMs,
    })
  }
}

handleIpc('net:setSeen', async (_e, accountId: unknown, mailbox: unknown, uids: unknown, seen: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  const parsedUids = uidsSchema.parse(uids)
  const parsedSeen = z.boolean().parse(seen)

  if (IS_E2E) {
    const set = new Set(parsedUids)
    const box = e2eBox(id, parsedMailbox)
    for (const m of box) {
      if (set.has(m.uid)) m.unread = !parsedSeen
    }
    setUnread(id, parsedMailbox, parsedUids, !parsedSeen)
    return { ok: true as const }
  }

  if (getSettings().workOffline) {
    setUnread(id, parsedMailbox, parsedUids, !parsedSeen)
    const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
    for (const uid of parsedUids) {
      upsertOfflineOp(id, parsedMailbox, uid, 'flag_seen', { seen: parsedSeen }, uidVal)
    }
    return { ok: true as const }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  try {
    await setSeen(cfg.imap, parsedMailbox, parsedUids, parsedSeen, id)
  } catch (err) {
    if (isTransientNetworkError(err)) {
      logMail.warn(`net:setSeen transient failure, queueing: ${err instanceof Error ? err.message : String(err)}`)
      setUnread(id, parsedMailbox, parsedUids, !parsedSeen)
      const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
      for (const uid of parsedUids) {
        upsertOfflineOp(id, parsedMailbox, uid, 'flag_seen', { seen: parsedSeen }, uidVal)
      }
      return { ok: true as const, queued: true as const }
    }
    throw unwrapAggregate(err)
  }
  return { ok: true as const }
})

handleIpc('net:setFlagged', async (_e, accountId: unknown, mailbox: unknown, uids: unknown, flagged: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  const parsedUids = uidsSchema.parse(uids)
  const parsedFlagged = z.boolean().parse(flagged)

  if (IS_E2E) {
    const set = new Set(parsedUids)
    const box = e2eBox(id, parsedMailbox)
    for (const m of box) {
      if (set.has(m.uid)) m.flagged = parsedFlagged
    }
    setFlaggedLocal(id, parsedMailbox, parsedUids, parsedFlagged)
    return { ok: true as const }
  }

  if (getSettings().workOffline) {
    setFlaggedLocal(id, parsedMailbox, parsedUids, parsedFlagged)
    const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
    for (const uid of parsedUids) {
      upsertOfflineOp(id, parsedMailbox, uid, 'flag_flagged', { flagged: parsedFlagged }, uidVal)
    }
    return { ok: true as const }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  try {
    await setFlagged(cfg.imap, parsedMailbox, parsedUids, parsedFlagged, id)
  } catch (err) {
    if (isTransientNetworkError(err)) {
      logMail.warn(`net:setFlagged transient failure, queueing: ${err instanceof Error ? err.message : String(err)}`)
      setFlaggedLocal(id, parsedMailbox, parsedUids, parsedFlagged)
      const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
      for (const uid of parsedUids) {
        upsertOfflineOp(id, parsedMailbox, uid, 'flag_flagged', { flagged: parsedFlagged }, uidVal)
      }
      return { ok: true as const, queued: true as const }
    }
    throw unwrapAggregate(err)
  }
  return { ok: true as const }
})

handleIpc('net:sendMail', async (_e, accountId: unknown, options: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedOptions = sendMailOptionsSchema.parse(options)
  return sendMailWithAccountConfig(id, parsedOptions)
})

// §2.22 Wave A — ICS / iTIP invite bridge.
//
// Three injected resolvers:
//
//   1. resolveInvite — same four-tier lookup as net:messageDetails (memory →
//      DB → on-disk EML → IMAP). Reuses the cache helpers so an RSVP click
//      never causes a second IMAP roundtrip when the body is already cached.
//
//   2. resolveFrom — synthesises the (email, displayName) pair the RSVP
//      ATTENDEE entry needs. Mirrors the from-header resolver inside
//      sendMailWithAccountConfig (default identity → meta.email → smtp.user
//      → imap.user).
//
//   3. sendRsvp — actually delivers the RSVP through the per-account
//      transport. Reuses sendMailWithAccountConfig under the hood so SMTP /
//      Outlook Graph routing, TLS pinning, and Sent-folder APPEND happen
//      identically to a normal send. The ics payload is attached twice:
//      once inside `multipart/alternative` (Outlook / Apple Calendar
//      requirement, RFC 5546 + Outlook quirk) and once as a regular
//      `invite.ics` attachment (Gmail web, Thunderbird).
const resolveInviteForRsvp: InviteResolver = async (accountId, folder, uid) => {
  // §2.22 fix iter2A — privacy-aware tier walk. The renderer-facing caches
  // (`getDetailsFromCache` / `getCachedDetail`) only carry CalendarInvitePublic
  // and therefore CANNOT be used to mint an RFC 5546 conforming REPLY (no
  // rawIcs, no SEQUENCE preserved in the public DTO). The full invite with
  // rawIcs lives only in `inviteCacheStore` (this session) or has to be
  // re-extracted from on-disk EML / IMAP.
  //
  // Tier order:
  //   (a) main-only invite cache — populated by `enrichDetailsWithCalendarInvite`
  //       on every body load; instant hit during the same session.
  //   (b) on-disk EML — survives restart so RSVP after relaunch still works
  //       without an IMAP roundtrip.
  //   (c) IMAP refetch — last resort when EML is missing (e.g. user opened
  //       message via search before body sync, then closed the window before
  //       EML cache was written).
  //
  // The on-disk EML and IMAP tiers re-warm the in-memory cache so a second
  // RSVP attempt during the same session is instant.

  // (a) main-only invite cache — full payload, no IMAP / disk hit.
  const memInvite = inviteCacheStore.get(accountId, folder, uid)
  if (memInvite) return memInvite

  // (b) on-disk EML.
  const localEml = readEml(accountId, folder, uid)
  if (localEml) {
    const raw = await extractIcsFromRawEml(localEml)
    if (raw) {
      const parsed = parseCalendarPart(raw)
      if (parsed) {
        inviteCacheStore.put(accountId, folder, uid, parsed)
        return parsed
      }
    }
  }

  // (c) IMAP — last resort. Re-fetch the message details (which populates
  // calendarInviteRaw) and parse on the way through. We deliberately do not
  // share the existing fetchMessageDetailsWithTimeout budget here: the user
  // is actively waiting on this click, and the alternative is a silent
  // "could not RSVP" with no diagnostic.
  try {
    const { cfg } = await requireAccountConfig(accountId)
    const details = await fetchMessageDetails(accountId, cfg.imap, folder, uid)
    if (details.calendarInviteRaw) {
      const parsed = parseCalendarPart(details.calendarInviteRaw)
      if (parsed) {
        inviteCacheStore.put(accountId, folder, uid, parsed)
        return parsed
      }
    }
  } catch (err) {
    logMail.warn(`rsvp resolveInvite IMAP fallback failed: ${err instanceof Error ? err.message : err}`)
  }

  return null
}

const resolveFromForRsvp: RsvpFromResolver = async (accountId) => {
  // §2.22 — in e2e mode getAccountMeta reads from SQLite (not populated), so
  // fall back to the in-memory E2E_ACCOUNTS roster instead.
  const meta = (IS_E2E ? E2E_ACCOUNTS.find(a => a.id === accountId) : undefined) ?? getAccountMeta(accountId)
  if (!meta) throw new Error(`Account #${accountId} not found`)
  // Default identity wins over meta.email (matches sendMailWithAccountConfig).
  const defaultIdentity = (meta.identities ?? []).find(i => i.isDefault)
    ?? (meta.identities ?? [])[0]
  const email = (defaultIdentity?.email?.trim()
    || meta.email
    || meta.smtp.user
    || meta.imap.user
    || '').trim()
  if (!email) throw new Error('No sending address configured for account')
  const displayName = (defaultIdentity?.displayName?.trim() || meta.name || '').trim() || undefined
  return { email, displayName }
}

const sendRsvpEmail: RsvpSender = async (accountId, payload) => {
  // ICS goes in two places (RFC 5546 + practical client compatibility):
  //
  //   1. As an `attachments` entry — Gmail webmail, Thunderbird and most
  //      mobile clients pick it up here.
  //
  //   2. As an `alternatives` entry — Outlook desktop / Apple Calendar
  //      require the ics inside `multipart/alternative` to auto-recognize
  //      the RSVP. nodemailer's MailComposer honours `alternatives` natively
  //      and ignores it on transports that don't need it.
  //
  // §2.22 fix iter3A — `alternatives` is a first-class field on
  // `packages/net/smtp.ts#SendMailOptions` AND in MailComposer (so both the
  // SMTP `sendMail` path and the IMAP-APPEND-to-Sent `buildRawMessage` path
  // honour it). The local `SendMailOptions` alias here in main.ts is a
  // narrower zod-inferred type used to validate renderer IPC payloads, and it
  // deliberately does NOT declare `alternatives` — the renderer must not be
  // able to smuggle a calendar alternative through `net:sendMail`. So we
  // extend the validated object via a localised cast at this trusted main
  // call site only.
  const ics = payload.icsBody
  const icsContentType = 'text/calendar; method=REPLY; charset=UTF-8'
  const optionsForSchema = sendMailOptionsSchema.parse({
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    attachments: [{
      filename: 'invite.ics',
      contentBase64: Buffer.from(ics, 'utf8').toString('base64'),
      contentType: icsContentType,
    }],
  })
  const extended = optionsForSchema as SendMailOptions & {
    alternatives?: Array<{ contentType: string; content: string }>
  }
  extended.alternatives = [{ contentType: icsContentType, content: ics }]
  return sendMailWithAccountConfig(accountId, extended)
}

registerInviteHandlers({
  resolveInvite: resolveInviteForRsvp,
  resolveFrom: resolveFromForRsvp,
  sendRsvp: sendRsvpEmail,
})

handleIpc('mail:scheduleSend', async (_e, accountId: unknown, messageData: unknown, delayMsRaw: unknown, archiveRefRaw?: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMessage = sendMailOptionsSchema.parse(messageData)
  const delayMs = delayMsSchema.parse(delayMsRaw)
  const archiveRef: ArchiveRef | null = archiveRefRaw ? archiveRefSchema.parse(archiveRefRaw) : null
  if (archiveRef && archiveRef.accountId !== id) throw new Error('archiveRef.accountId must match the sending account')

  // Always enqueue — non-blocking for Compose window
  const sendAt = delayMs <= 0
    ? new Date().toISOString()
    : new Date(Date.now() + delayMs).toISOString()
  const queueId = enqueueSendQueue(id, parsedMessage, sendAt, randomUUID(), archiveRef)
  const source: QueueEnqueuedSource = delayMs <= 0 ? 'immediate' : 'delay'
  notifyQueueEnqueued({ id: queueId, accountId: id, sendAt, source })
  notifyQueueChanged(id)
  // Trigger processing immediately for instant sends
  if (delayMs <= 0) void processSendQueue()
  return { id: queueId, sendAt }
})

handleIpc('mail:scheduleSendAt', async (_e, accountId: unknown, messageData: unknown, sendAtRaw: unknown, archiveRefRaw?: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMessage = sendMailOptionsSchema.parse(messageData)
  const sendAt = sendAtIsoSchema.parse(sendAtRaw)
  const archiveRef: ArchiveRef | null = archiveRefRaw ? archiveRefSchema.parse(archiveRefRaw) : null
  if (archiveRef && archiveRef.accountId !== id) throw new Error('archiveRef.accountId must match the sending account')
  const queueId = enqueueSendQueue(id, parsedMessage, sendAt, randomUUID(), archiveRef)
  notifyQueueEnqueued({ id: queueId, accountId: id, sendAt, source: 'schedule' })
  notifyQueueChanged(id)
  if (new Date(sendAt).getTime() <= Date.now()) void processSendQueue()
  return { id: queueId, sendAt }
})

handleIpc('mail:queueList', (_e, accountId?: unknown) => {
  const id = (accountId === undefined || accountId === null) ? undefined : accountIdSchema.parse(accountId)
  return listSendQueue({ accountId: id, statuses: ['queued', 'sending', 'failed'], limit: 500 })
})

handleIpc('mail:cancelSend', (_e, queueIdRaw: unknown) => {
  const queueId = queueIdSchema.parse(queueIdRaw)
  const canceled = cancelSendQueue(queueId)
  if (!canceled) throw new Error('Message is already being sent or cannot be canceled')
  notifyQueueChanged(canceled.accountId)
  return {
    id: canceled.id,
    accountId: canceled.accountId,
    messageData: queueItemToComposeInit(canceled.messageData, canceled.archiveRef),
  }
})

handleIpc('mail:queueSendNow', async (_e, queueIdRaw: unknown) => {
  const queueId = queueIdSchema.parse(queueIdRaw)
  const item = getSendQueueById(queueId)
  if (!item) throw new Error(`Queue entry ${queueId} not found`)
  if (!sendQueueNow(queueId)) throw new Error('Cannot send now for current status')
  notifyQueueChanged(item.accountId)
  void processSendQueue()
  return { ok: true as const }
})

handleIpc('mail:queueReschedule', (_e, queueIdRaw: unknown, sendAtRaw: unknown) => {
  const queueId = queueIdSchema.parse(queueIdRaw)
  const sendAt = sendAtIsoSchema.parse(sendAtRaw)
  const item = getSendQueueById(queueId)
  if (!item) throw new Error(`Queue entry ${queueId} not found`)
  if (!rescheduleSendQueue(queueId, sendAt)) throw new Error('Cannot reschedule for current status')
  notifyQueueChanged(item.accountId)
  if (new Date(sendAt).getTime() <= Date.now()) void processSendQueue()
  return { ok: true as const, sendAt }
})

handleIpc('contacts:search', (_e, query: unknown, limit: unknown) => {
  const q = z.string().parse(query)
  const lim = contactsSearchLimitSchema.parse(limit) ?? 8
  return searchContacts(q, lim)
})

handleIpc('contacts:upsert', (_e, email: unknown, name: unknown) => {
  const parsedEmail = z.string().min(1).parse(email)
  const parsedName = z.string().optional().parse(name)
  upsertContactManual(parsedEmail, parsedName)
  return { ok: true as const }
})

handleIpc('net:saveDraft', async (_e, accountId: unknown, draftsMailbox: unknown, draftId: unknown, payload: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(draftsMailbox)
  const parsedDraftId = draftIdSchema.parse(draftId)
  const parsedPayload = draftPayloadSchema.parse(payload)

  // §2.16 iter4 (Medium) — finalized-LRU short-circuit. If the draftId is
  // already in `sentDraftIdsByAccount`, the draft was sent or explicitly
  // deleted; an autosave that started before finalize completed must NOT
  // re-APPEND a stale copy after the IMAP DELETE. This is the safety net
  // for the race that the per-account lock alone cannot fully cover (the
  // save callback may have been queued behind the delete in the lock chain
  // but with `_throwOnRace`-style stale state in the renderer payload).
  if (wasDraftFinalized(id, parsedDraftId)) {
    logDraftSync.info(`saveDraft no-op (finalized) account=${id} draftId=${parsedDraftId}`)
    return { ok: true as const, uid: undefined }
  }

  if (IS_E2E) {
    const key = `${id}:${parsedDraftId}`
    const existingUid = E2E_DRAFT_UID_BY_ID.get(key)
    const uid = existingUid ?? ++E2E_UID_SEQ
    if (!existingUid) E2E_DRAFT_UID_BY_ID.set(key, uid)

    const acc = E2E_ACCOUNTS.find(a => a.id === id)
    const now = new Date().toISOString()
    const msg: E2EMail = {
      uid,
      from: acc?.smtp.user || `e2e${id}@example.test`,
      to: parsedPayload.to ?? '',
      cc: parsedPayload.cc,
      bcc: parsedPayload.bcc,
      subject: parsedPayload.subject ?? '',
      date: now,
      unread: false,
      flagged: false,
      text: parsedPayload.text,
      html: parsedPayload.html,
      draftId: parsedDraftId,
    }
    const box = e2eBox(id, parsedMailbox)
    const idx = box.findIndex(m => m.uid === uid)
    if (idx >= 0) box[idx] = msg
    else box.unshift(msg)

    return { ok: true as const, uid }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  // §2.16 — per-account mutex serializes saveDraft. Concurrent autosaves on
  // the same account cannot race against each other's APPEND/SEARCH/DELETE
  // triple, which is the failure mode that piled up 25 drafts on mail.ru.
  // Different accountIds proceed in parallel.
  // §2.16 iter4 — `net:deleteDraft` shares this lock, so a finalize cannot
  // interleave with an in-flight save (and vice versa).
  const res = await withSaveDraftLock(id, async () => {
    // Re-check inside the lock: the LRU may have been touched by a
    // concurrent net:deleteDraft that completed between the outer guard and
    // lock acquisition. Without the re-check the call would still proceed.
    if (wasDraftFinalized(id, parsedDraftId)) {
      return { uid: undefined as number | undefined }
    }
    return saveDraft(id, cfg.imap, parsedMailbox, parsedDraftId, parsedPayload)
  })
  logDraftSync.info(`saved draft account=${id} draftId=${parsedDraftId} subjectLen=${(parsedPayload.subject || '').length} uid=${res.uid ?? 'unknown'}`)
  return { ok: true as const, uid: res.uid }
})

/**
 * §2.16 — recently-sent draft tracker. Compose's per-account
 * `mailcopilot:draft:last:<accountId>` localStorage key reuses the same
 * draftId across "New Message" reopens, but only if the prior draft has
 * not been finalized (sent or explicitly discarded). `net:deleteDraft` is
 * the single signal that a draft has reached terminal state — both the
 * send path (`finalizeAfterDispatch`) and the discard path call it.
 *
 * The tracker is a per-account FIFO of recent draftIds with a small upper
 * bound so a long-running session can't grow unbounded. Reuse-check via
 * `drafts:wasSent` IPC returns true if the draftId appears in the tracker
 * for that account.
 */
const SENT_DRAFTS_PER_ACCOUNT_LIMIT = 64
const sentDraftIdsByAccount = new Map<number, string[]>()

function rememberDraftFinalized(accountId: number, draftId: string): void {
  const list = sentDraftIdsByAccount.get(accountId) ?? []
  // Move-to-end (FIFO with re-touch). Drop duplicates so a re-finalize doesn't
  // bloat the bucket.
  const idx = list.indexOf(draftId)
  if (idx >= 0) list.splice(idx, 1)
  list.push(draftId)
  while (list.length > SENT_DRAFTS_PER_ACCOUNT_LIMIT) list.shift()
  sentDraftIdsByAccount.set(accountId, list)
}

function wasDraftFinalized(accountId: number, draftId: string): boolean {
  const list = sentDraftIdsByAccount.get(accountId)
  return Boolean(list && list.includes(draftId))
}

handleIpc('net:deleteDraft', async (_e, accountId: unknown, draftsMailbox: unknown, draftId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(draftsMailbox)
  const parsedDraftId = draftIdSchema.parse(draftId)

  if (IS_E2E) {
    const key = `${id}:${parsedDraftId}`
    const uid = E2E_DRAFT_UID_BY_ID.get(key)
    if (uid) {
      E2E_DRAFT_UID_BY_ID.delete(key)
      const box = e2eBox(id, parsedMailbox)
      E2E_BOXES[id] = E2E_BOXES[id] ?? {}
      E2E_BOXES[id][parsedMailbox] = box.filter(m => m.uid !== uid)
      deleteMessages(id, parsedMailbox, [uid])
    } else {
      const box = e2eBox(id, parsedMailbox)
      E2E_BOXES[id] = E2E_BOXES[id] ?? {}
      E2E_BOXES[id][parsedMailbox] = box.filter(m => m.draftId !== parsedDraftId)
    }
    rememberDraftFinalized(id, parsedDraftId)
    return { ok: true as const }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  // §2.16 iter4 (Medium) — share the per-account saveDraft mutex so a
  // delete cannot interleave with an in-flight autosave. Without this lock,
  // a saveDraft that started just before send/finalize could APPEND its
  // copy after deleteDraft removed the prior one, leaving a sent message
  // body lingering in Drafts (privacy/data-retention regression).
  // rememberDraftFinalized() runs inside the same lock so any subsequent
  // save callback queued behind this delete sees the finalized LRU bit and
  // short-circuits via the wasDraftFinalized re-check in net:saveDraft.
  await withSaveDraftLock(id, async () => {
    await deleteDraft(id, cfg.imap, parsedMailbox, parsedDraftId)
    rememberDraftFinalized(id, parsedDraftId)
  })
  return { ok: true as const }
})

handleIpc('drafts:wasSent', (_e, accountId: unknown, draftId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedDraftId = draftIdSchema.parse(draftId)
  return { wasSent: wasDraftFinalized(id, parsedDraftId) }
})

// In-memory LRU cache for parsed EML results.
// Avoids re-running simpleParser() on every click for emails with many attachments.
const DETAILS_CACHE_MAX = 30
const detailsCache = new Map<string, MessageDetails>()
function detailsCacheKey(accountId: number, folder: string, uid: number) { return `${accountId}:${folder}:${uid}` }
function getDetailsFromCache(accountId: number, folder: string, uid: number): MessageDetails | undefined {
  const key = detailsCacheKey(accountId, folder, uid)
  const val = detailsCache.get(key)
  if (val) {
    // Move to end (most recently used)
    detailsCache.delete(key)
    detailsCache.set(key, val)
  }
  return val
}
function putDetailsInCache(accountId: number, folder: string, uid: number, details: MessageDetails) {
  const key = detailsCacheKey(accountId, folder, uid)
  detailsCache.delete(key) // refresh position
  if (detailsCache.size >= DETAILS_CACHE_MAX) {
    // Evict oldest entry
    const oldest = detailsCache.keys().next().value!
    detailsCache.delete(oldest)
  }
  detailsCache.set(key, details)
}

// --- §2.17 Phase 0 — mail-open hot-path observability helpers --------------
//
// Extracted out of the net:messageDetails handler to keep the hotspot file
// from growing further. Each helper is fire-and-forget telemetry: a thrown
// span/histogram emission must NOT propagate into the open path.

/**
 * Cache tier that ultimately served a net:messageDetails call. Mirrors
 * DOMAINS.cache_hit_level in metricsSchema.ts. `imap_timeout` is a distinct
 * level (not a sub-state of `imap`) because it answers a separate dashboard
 * question — "did the network actually reply?".
 */
type CacheHitLevel = 'memory' | 'db' | 'eml' | 'imap' | 'imap_timeout'

/** Conservative size estimate for body_size bucketing. Counts whichever of
 *  html/text is present (preferring the larger), in UTF-16 code units —
 *  bucketBodySize boundaries are coarse enough that the JS-string-vs-byte
 *  distinction does not move the bucket. */
function estimateBodyBytes(details: MessageDetails | undefined | null): number {
  if (!details) return 0
  const h = details.html?.length ?? 0
  const t = details.text?.length ?? 0
  return Math.max(h, t)
}

/** §2.17 Phase 0 — IMAP fetch step gets a 10s AbortController timeout.
 *  Cache and DB tiers are not timed out (they are local and fast).
 *  imapflow does not support a real abort signal, so the timeout is
 *  enforced via Promise.race; a slow fetch may still complete in the
 *  background, but the handler returns the cached-headers fallback to
 *  the renderer within the budget. */
const IMAP_FETCH_TIMEOUT_MS = 10_000

/** Result discriminator for the timed IMAP fetch helper. */
type ImapFetchOutcome =
  | { kind: 'ok'; details: MessageDetails }
  | { kind: 'timeout' }

async function fetchMessageDetailsWithTimeout(
  accountId: number,
  cfg: ImapConfig,
  mailbox: string,
  uid: number,
): Promise<ImapFetchOutcome> {
  // AbortController is threaded into fetchMessageDetails as of Phase 0 fix
  // iter 2: the signal short-circuits awaits at logical boundaries (between
  // mailboxOpen / fetchOne / download steps), so the renderer-visible budget
  // is honored even when the underlying socket I/O cannot be cancelled.
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<ImapFetchOutcome>((resolve) => {
    timer = setTimeout(() => {
      try { ac.abort() } catch { /* ignore */ }
      resolve({ kind: 'timeout' })
    }, IMAP_FETCH_TIMEOUT_MS)
    // Don't keep the event loop alive for telemetry-only timers.
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      try { (timer as { unref?: () => void }).unref?.() } catch { /* ignore */ }
    }
  })
  try {
    const fetchPromise = fetchMessageDetails(accountId, cfg, mailbox, uid, ac.signal)
      .then((details): ImapFetchOutcome => ({ kind: 'ok', details }))
      .catch((err): ImapFetchOutcome => {
        // If the abort fired between awaits, fetchMessageDetails throws
        // AbortError. The Promise.race already resolved as 'timeout' in
        // that case, but ImapFlow may also throw AbortError after the
        // race winner — swallow it so it doesn't bubble as unhandled.
        if (err instanceof Error && err.name === 'AbortError') return { kind: 'timeout' }
        throw err
      })
    return await Promise.race([fetchPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** §2.17 Phase 0 — same Promise.race timeout pattern for the per-folder
 *  offline mode full-EML download. Without this, a stalled socket on the
 *  cache-miss path could pin the renderer's open call for the duration of
 *  the underlying ImapFlow socket timeout (minutes). The signal short-
 *  circuits the chunk loop at logical boundaries; in-flight reads may
 *  complete in the background. */
type RawMessageOutcome =
  | { kind: 'ok'; raw: Buffer | null }
  | { kind: 'timeout' }

async function downloadRawMessageWithTimeout(
  accountId: number,
  cfg: ImapConfig,
  mailbox: string,
  uid: number,
): Promise<RawMessageOutcome> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<RawMessageOutcome>((resolve) => {
    timer = setTimeout(() => {
      try { ac.abort() } catch { /* ignore */ }
      resolve({ kind: 'timeout' })
    }, IMAP_FETCH_TIMEOUT_MS)
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      try { (timer as { unref?: () => void }).unref?.() } catch { /* ignore */ }
    }
  })
  try {
    const fetchPromise = downloadRawMessage(accountId, cfg, mailbox, uid, ac.signal)
      .then((raw): RawMessageOutcome => ({ kind: 'ok', raw }))
      .catch((err): RawMessageOutcome => {
        if (err instanceof Error && err.name === 'AbortError') return { kind: 'timeout' }
        throw err
      })
    return await Promise.race([fetchPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Build the offline-fallback envelope from cached headers. Used both by the
 *  workOffline branch and the IMAP-timeout / IMAP-error branches so the
 *  renderer sees one consistent shape. */
function buildOfflineFallback(
  cached: ReturnType<typeof getMessageByUid>,
): MessageDetails | null {
  if (!cached) return null
  return {
    uid: cached.uid,
    envelope: {
      subject: cached.subject,
      date: cached.date,
      from: cached.fromAddr ? [{ name: cached.fromName ?? undefined, address: cached.fromAddr }] : undefined,
      to: cached.toAddr ? cached.toAddr.split(',').map(a => ({ address: a.trim() })) : undefined,
      messageId: cached.messageId ?? undefined,
      inReplyTo: cached.inReplyTo ?? undefined,
      references: cached.references ?? undefined,
    },
    flags: [
      ...(cached.unread ? [] : ['Seen']),
      ...(cached.flagged ? ['Flagged'] : []),
    ],
    offlineFallback: true,
  }
}

/**
 * §2.22 Wave A — translate the transient `calendarInviteRaw` field produced
 * by `packages/net` into the parsed `calendarInvite` consumed by the renderer.
 *
 * Two entry conditions:
 *   1. The IMAP fetch path populates `details.calendarInviteRaw` directly
 *      (see `fetchMessageDetails` in packages/net/message.ts).
 *   2. The on-disk EML path produces a fully-formed `MessageDetails` via
 *      `parseEmlBuffer`, which intentionally skips attachment content for
 *      speed — we re-extract the ics from the raw buffer if the caller
 *      passes it.
 *
 * In either case the raw ics is parsed exactly once (here in main) and the
 * `calendarInviteRaw` field is stripped before caching, so the JSON cache
 * row, the in-memory LRU, and the IPC payload that crosses to the renderer
 * never carry the original ics blob — only the structured CalendarInvite.
 */
async function enrichDetailsWithCalendarInvite(
  details: MessageDetails,
  ctx: { accountId: number; folder: string; uid: number },
  rawEml?: Buffer,
): Promise<MessageDetails> {
  let raw = details.calendarInviteRaw
  if (!raw && rawEml) {
    try {
      raw = await extractIcsFromRawEml(rawEml)
    } catch { /* extraction is best-effort */ }
  }
  // Strip the transient field unconditionally — never leaks past main.
  if ('calendarInviteRaw' in details) {
    delete (details as { calendarInviteRaw?: string }).calendarInviteRaw
  }
  if (!raw) return details
  try {
    const parsed = parseCalendarPart(raw)
    if (parsed) {
      // §2.22 fix iter2A — split by privacy boundary:
      //   - main-only invite cache holds the full invite (with rawIcs and
      //     description) so the RSVP click can mint a conforming RFC 5546
      //     REPLY without re-fetching from IMAP;
      //   - the renderer / SQLite cache / IPC envelope receive only
      //     CalendarInvitePublic (no rawIcs, no description), so the raw
      //     VCALENDAR text never crosses to disk or worker layers.
      inviteCacheStore.put(ctx.accountId, ctx.folder, ctx.uid, parsed)
      details.calendarInvite = toPublicInvite(parsed)
    }
  } catch (err) {
    logMail.warn('parseCalendarPart threw', err instanceof Error ? err.message : String(err))
  }
  return details
}

/**
 * §2.22 fix iter2A — single shared instance of the main-only invite cache.
 * Keyed by (accountId, folder, uid). Populated whenever
 * `enrichDetailsWithCalendarInvite` parses a raw ics; consumed by
 * `resolveInviteForRsvp` so RSVP clicks during the same session never need
 * to re-extract from EML / IMAP. Bounded LRU (256 entries by default).
 */
const inviteCacheStore = makeInviteCache()

/** Span + histogram terminator. Always called exactly once per handler call.
 *  Any exception inside (Sentry SDK transient state, schema drift) is
 *  swallowed — telemetry must not break the user-visible open.
 *
 *  Returns a small handle whose `finalize` is idempotent: callers that
 *  finalize on every terminal branch can still be wrapped in a top-level
 *  try/finally that calls `finalize` again with a default level — the
 *  second call is a no-op. This closes the gap where a synchronous throw
 *  between span start and the next `finalizeMessageDetailsTelemetry` call
 *  (e.g. a parse error in parseEmlBuffer, a DB write failure during the
 *  EML cache path, or an unexpected throw from IPC zod parsing) would
 *  leak the span. */
function makeMessageDetailsFinalizer(
  span: ReturnType<typeof startMetricSpan>,
  t0: number,
): {
  finalize: (level: CacheHitLevel, details: MessageDetails | null) => void
  ensureClosed: (defaultLevel: CacheHitLevel) => void
} {
  let closed = false
  const finalize = (level: CacheHitLevel, details: MessageDetails | null): void => {
    if (closed) return
    closed = true
    try {
      const wallMs = Date.now() - t0
      const bytes = estimateBodyBytes(details)
      const attachmentsCount = details?.attachments?.length ?? 0
      try {
        span.setAttributes({
          cache_hit_level: level,
          body_size_bucket: bucketBodySize(bytes),
          attachments_count: attachmentsCount,
        })
      } catch { /* ignore */ }
      try { span.end() } catch { /* ignore */ }
      recordHistogram('net.message_details.wall_ms', wallMs, {
        cache_hit_level: level,
      })
    } catch { /* never let telemetry break the open path */ }
  }
  const ensureClosed = (defaultLevel: CacheHitLevel): void => {
    if (closed) return
    finalize(defaultLevel, null)
  }
  return { finalize, ensureClosed }
}

handleIpc('net:messageDetails', async (_e, accountId: unknown, mailbox: unknown, uid: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  const parsedUid = uidSchema.parse(uid)

  // Onboarding funnel closing step: the first time the user opens any
  // message after connecting an account. One-shot install-wide.
  //
  // Legacy-safe gate: fire ONLY if the account being opened was observed
  // created after telemetry shipped (getAccountSeenAt is non-null). This
  // prevents legacy installs — where mail is already configured and the
  // user just happens to open an email after the telemetry release —
  // from flipping the install-wide bit with a fake "activation". A later
  // genuinely-new account on the same install still triggers the event,
  // because markFirstMessageOpened() has not fired yet.
  //
  // time_since_sync_bucket is measured from the first successful header
  // sync of THIS account, not account_saved — the schema says
  // "time since sync", and mixing the two would double-count pre-sync
  // waiting time.
  try {
    if (getAccountSeenAt(id) !== null && markFirstMessageOpened()) {
      const firstSyncAt = getFirstHeadersSyncAt(id)
      const timeSinceSyncMs = firstSyncAt != null ? Math.max(0, Date.now() - firstSyncAt) : 0
      recordEvent('onboarding.first_message_opened', {
        time_since_sync_bucket: bucketTimeSinceSync(timeSinceSyncMs),
      })
    }
  } catch { /* telemetry never blocks open */ }

  const t0 = Date.now()
  // §2.17 Phase 0 — span covers the whole handler. Closed exactly once on
  // every terminal branch (each `finalizer.finalize(...)` call is
  // idempotent). The top-level try/finally below adds a guard against
  // unexpected synchronous throws between span start and the next explicit
  // finalize call (parseEmlBuffer, DB writes, JSON.parse on a corrupt
  // cache row that our inner try/catch missed, etc.) — without it, those
  // throws would leak the span. Sampling is governed by tracesSampleRate
  // in sentry.ts, so high-traffic users won't generate one transaction
  // per click.
  const span = startMetricSpan('net.message_details', {})
  const finalizer = makeMessageDetailsFinalizer(span, t0)

  try {
    // Check in-memory cache first (instant — no disk I/O or parsing)
    const cached = getDetailsFromCache(id, parsedMailbox, parsedUid)
    if (cached) {
      logMail.info(`messageDetails memory cache hit: uid=${parsedUid} ${Date.now() - t0}ms`)
      finalizer.finalize('memory', cached)
      return cached
    }

    // Check DB cache — survives app restarts, avoids re-parsing large EML files
    try {
      const dbJson = getCachedDetail(id, parsedMailbox, parsedUid)
      if (dbJson) {
        const details = JSON.parse(dbJson) as MessageDetails
        putDetailsInCache(id, parsedMailbox, parsedUid, details)
        logMail.info(`messageDetails DB cache hit: uid=${parsedUid} ${Date.now() - t0}ms`)
        finalizer.finalize('db', details)
        return details
      }
    } catch { /* corrupted cache — fall through to normal path */ }

    if (IS_E2E) {
      const msg = e2eBox(id, parsedMailbox).find(m => m.uid === parsedUid) ?? e2eFindInAnyBox(id, parsedUid)
      const acc = E2E_ACCOUNTS.find(a => a.id === id)

      const addrList = (raw?: string) => {
        const emails = (raw || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        return emails.length > 0 ? emails.map(address => ({ address })) : undefined
      }

      const details: MessageDetails = {
        uid: parsedUid,
        envelope: {
          subject: msg?.subject || 'E2E',
          date: msg?.date || new Date().toISOString(),
          from: [parseDisplayAddress(msg?.from || 'alice@example.test')],
          to: addrList(msg?.to) ?? [{ address: acc?.imap.user || `e2e${id}@example.test` }],
          cc: addrList(msg?.cc),
          bcc: addrList(msg?.bcc),
        },
        flags: [
          msg?.unread ? '' : 'Seen',
          msg?.flagged ? 'Flagged' : '',
        ].filter(Boolean),
        html: msg?.html,
        text: msg?.text ?? 'Test message (unknown UID).',
        attachments: msg?.attachments ?? [],
        draftId: msg?.draftId,
        // §2.22 fix iter2A — propagate the public DTO only; the full invite
        // (with rawIcs / description) lives in the main-only invite cache so
        // an RSVP click can rebuild the conforming REPLY without re-fetching.
        calendarInvite: msg?.calendarInvite ? toPublicInvite(msg.calendarInvite) : undefined,
      }
      if (msg?.calendarInvite) {
        inviteCacheStore.put(id, parsedMailbox, parsedUid, msg.calendarInvite)
      }
      updateMessageBodyText(id, parsedMailbox, parsedUid, getSearchableBodyText(details))
      // §2.22 — populate memory cache so resolveInviteForRsvp finds calendarInvite on RSVP click.
      putDetailsInCache(id, parsedMailbox, parsedUid, details)
      // E2E path is treated as an in-process fetch — same telemetry shape so
      // smoke specs exercise the histogram emission too.
      finalizer.finalize('imap', details)
      return details
    }

    // 1. Check local EML on disk (instant offline access)
    const localEml = readEml(id, parsedMailbox, parsedUid)
    if (localEml) {
      const t1 = Date.now()
      const parsedDetails = await parseEmlBuffer(parsedUid, localEml)
      // §2.22 Wave A — parseEmlBuffer skips attachment content for speed, so
      // recover any text/calendar payload from the raw buffer here. Cheap
      // (one mailparser pass on the bytes already in memory).
      const details = await enrichDetailsWithCalendarInvite(
        parsedDetails,
        { accountId: id, folder: parsedMailbox, uid: parsedUid },
        localEml,
      )
      logMail.info(`EML hit: uid=${parsedUid} size=${localEml.length} parse=${Date.now() - t1}ms total=${Date.now() - t0}ms`)
      if (!hasBodyTextIndexed(id, parsedMailbox, parsedUid)) {
        updateMessageBodyText(id, parsedMailbox, parsedUid, getSearchableBodyText(details))
      }
      putDetailsInCache(id, parsedMailbox, parsedUid, details)
      try { setCachedDetail(id, parsedMailbox, parsedUid, JSON.stringify(details)) } catch { /* non-critical */ }
      finalizer.finalize('eml', details)
      return details
    }
    logMail.debug(`EML miss: account=${id} folder=${parsedMailbox} uid=${parsedUid}`)

    // 1b. In workOffline mode, skip IMAP entirely — use cached headers
    if (getSettings().workOffline) {
      const cached = getMessageByUid(id, parsedMailbox, parsedUid)
      if (cached) {
        logMail.info(`Work-offline fallback for uid=${parsedUid}`)
        const fallback = buildOfflineFallback(cached)
        if (fallback) {
          // Cache-tier signal: workOffline returns headers-only DB data, same
          // as the IMAP-error path. Tag as `db` to share the dashboard slice.
          finalizer.finalize('db', fallback)
          return fallback
        }
      }
      finalizer.finalize('db', null)
      throw new Error('Message not available offline')
    }

    // 2. Download from IMAP (with offline fallback to cached headers)
    try {
      const { cfg } = await requireAccountConfig(id)
      assertImapAuth(id, cfg.imap)

      // If per-folder offline mode is enabled — download full EML and cache on disk
      const folderPref = getFolderPref(id, parsedMailbox)
      if (folderPref && folderPref.offlineMode !== 'off') {
        const rawOutcome = await downloadRawMessageWithTimeout(id, cfg.imap, parsedMailbox, parsedUid)
        if (rawOutcome.kind === 'timeout') {
          logMail.warn(`Offline-mode raw download timed out (${IMAP_FETCH_TIMEOUT_MS}ms) for uid=${parsedUid}, returning cached headers`)
          const cached = getMessageByUid(id, parsedMailbox, parsedUid)
          const fallback = buildOfflineFallback(cached)
          if (fallback) {
            finalizer.finalize('imap_timeout', fallback)
            return fallback
          }
          const minimalFallback: MessageDetails = {
            uid: parsedUid,
            envelope: {},
            flags: [],
            offlineFallback: true,
          }
          finalizer.finalize('imap_timeout', minimalFallback)
          return minimalFallback
        }
        const raw = rawOutcome.raw
        if (raw) {
          const settings = getSettings()
          const maxBytes = (settings.offlineMaxSizeKB ?? 0) * 1024
          const maxTotalBytesMsg = (settings.offlineMaxTotalMB ?? 0) * 1024 * 1024
          const withinPerFileLimit = maxBytes <= 0 || raw.length <= maxBytes
          const withinTotalLimit = maxTotalBytesMsg <= 0 || emlCacheSizeBytes() < maxTotalBytesMsg
          if (withinPerFileLimit && withinTotalLimit) {
            saveEml(id, parsedMailbox, parsedUid, raw)
            setBodyDownloaded(id, parsedMailbox, parsedUid, true, raw.length)
          } else {
            // Remember the size so background sync doesn't try to download again.
            setBodyDownloaded(id, parsedMailbox, parsedUid, false, raw.length)
          }
          const parsedDetails = await parseEmlBuffer(parsedUid, raw)
          // §2.22 Wave A — same as the EML hit branch: re-scan the raw buffer
          // for a text/calendar part so the renderer's RSVP card lights up.
          const details = await enrichDetailsWithCalendarInvite(
            parsedDetails,
            { accountId: id, folder: parsedMailbox, uid: parsedUid },
            raw,
          )
          if (!hasBodyTextIndexed(id, parsedMailbox, parsedUid)) {
            updateMessageBodyText(id, parsedMailbox, parsedUid, getSearchableBodyText(details))
          }
          putDetailsInCache(id, parsedMailbox, parsedUid, details)
          try { setCachedDetail(id, parsedMailbox, parsedUid, JSON.stringify(details)) } catch { /* non-critical */ }
          finalizer.finalize('imap', details)
          return details
        }
      }

      // Normal mode — download body only (without attachments). §2.17 Phase 0:
      // wrap in a 10s budget so a stalled connection doesn't make the renderer
      // wait indefinitely on the headers-only fallback.
      const outcome = await fetchMessageDetailsWithTimeout(id, cfg.imap, parsedMailbox, parsedUid)
      if (outcome.kind === 'timeout') {
        logMail.warn(`IMAP fetch timed out (${IMAP_FETCH_TIMEOUT_MS}ms) for uid=${parsedUid}, returning cached headers`)
        const cached = getMessageByUid(id, parsedMailbox, parsedUid)
        const fallback = buildOfflineFallback(cached)
        if (fallback) {
          finalizer.finalize('imap_timeout', fallback)
          return fallback
        }
        // No cached headers either — give the renderer a structurally-valid
        // offline fallback envelope so the UI can show the retry button
        // instead of a generic error.
        const minimalFallback: MessageDetails = {
          uid: parsedUid,
          envelope: {},
          flags: [],
          offlineFallback: true,
        }
        finalizer.finalize('imap_timeout', minimalFallback)
        return minimalFallback
      }
      // §2.22 Wave A — `fetchMessageDetails` populates `calendarInviteRaw`
      // when the BODYSTRUCTURE walk found a text/calendar part; enrich it
      // into the parsed CalendarInvite (or strip the field if parsing fails).
      const details = await enrichDetailsWithCalendarInvite(
        outcome.details,
        { accountId: id, folder: parsedMailbox, uid: parsedUid },
      )
      if (!hasBodyTextIndexed(id, parsedMailbox, parsedUid)) {
        updateMessageBodyText(id, parsedMailbox, parsedUid, getSearchableBodyText(details))
      }
      putDetailsInCache(id, parsedMailbox, parsedUid, details)
      try { setCachedDetail(id, parsedMailbox, parsedUid, JSON.stringify(details)) } catch { /* non-critical */ }
      finalizer.finalize('imap', details)
      return details
    } catch (imapErr) {
      // IMAP unavailable — fall back to cached headers from DB
      const cached = getMessageByUid(id, parsedMailbox, parsedUid)
      const fallback = buildOfflineFallback(cached)
      if (fallback) {
        logMail.warn(`IMAP unavailable for message uid=${parsedUid}, falling back to cached headers`)
        finalizer.finalize('db', fallback)
        return fallback
      }
      // No cached data — rethrow original error
      finalizer.finalize('db', null)
      throw imapErr
    }
  } finally {
    // Belt-and-braces: if any branch above threw before its explicit
    // `finalizer.finalize(...)` ran, ensureClosed terminates the span and
    // emits the histogram with the `db` cache-tier (matching the
    // IMAP-error → DB-fallback convention; unexpected throws degrade to
    // the same dashboard slice). On the happy paths this is a no-op
    // because finalize was already called.
    finalizer.ensureClosed('db')
  }
})

handleIpc('net:saveAttachment', async (e, accountId: unknown, mailbox: unknown, uid: unknown, part: unknown, filename: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  const parsedUid = uidSchema.parse(uid)
  const parsedPart = z.string().min(1).parse(part)

  if (IS_E2E) {
    return { ok: true as const, path: '/tmp/e2e-attachment.bin' }
  }

  const suggestedRaw = z.string().optional().parse(filename) || 'attachment'
  // Attachment may contain a "path" in the filename, so we take only basename (for both / and \).
  const suggested = (suggestedRaw.split(/[\\/]/).pop() || '').trim() || 'attachment'

  const parent = BrowserWindow.fromWebContents(e.sender)
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, { defaultPath: suggested })
    : await dialog.showSaveDialog({ defaultPath: suggested })
  if (canceled || !filePath) return { ok: false as const, cancelled: true as const }

  // If the message is already downloaded as EML — we can save attachment offline.
  if (parsedPart.startsWith(EML_ATTACHMENT_PART_PREFIX)) {
    const localEml = readEml(id, parsedMailbox, parsedUid)
    if (!localEml) return { ok: false as const, error: 'Local EML not found' }
    const extracted = await extractEmlAttachment(localEml, parsedPart)
    if (!extracted) return { ok: false as const, error: 'Attachment not found in local EML' }
    fs.writeFileSync(filePath, extracted.content)
    shell.showItemInFolder(filePath)
    return { ok: true as const, path: filePath }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)

  const { content } = await downloadMessagePart(id, cfg.imap, parsedMailbox, parsedUid, parsedPart)
  if (!content) return { ok: false as const, error: 'Empty attachment content' }

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(filePath)
    const onErr = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)))
    out.on('error', onErr)
    content.on('error', onErr)
    out.on('finish', () => resolve())
    content.pipe(out)
  })

  // Safer than auto-open: just show the file in the file manager.
  shell.showItemInFolder(filePath)
  return { ok: true as const, path: filePath }
})

handleIpc('net:attachmentBase64', async (_e, accountId: unknown, mailbox: unknown, uid: unknown, part: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  const parsedUid = uidSchema.parse(uid)
  const parsedPart = partSchema.parse(part)

  if (IS_E2E) {
    return {
      ok: true as const,
      contentBase64: Buffer.from('e2e').toString('base64'),
      contentType: 'application/octet-stream',
    }
  }

  const MAX_BYTES = 10 * 1024 * 1024

  // If the message is already downloaded as EML — we can extract attachment offline.
  if (parsedPart.startsWith(EML_ATTACHMENT_PART_PREFIX)) {
    const localEml = readEml(id, parsedMailbox, parsedUid)
    if (!localEml) return { ok: false as const, error: 'Local EML not found' }
    const extracted = await extractEmlAttachment(localEml, parsedPart)
    if (!extracted) return { ok: false as const, error: 'Attachment not found in local EML' }
    return {
      ok: true as const,
      contentBase64: extracted.content.toString('base64'),
      contentType: extracted.contentType || 'application/octet-stream',
    }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)

  const { content } = await downloadMessagePart(id, cfg.imap, parsedMailbox, parsedUid, parsedPart)
  if (!content) return { ok: false as const, error: 'Empty attachment content' }

  const buf = await readStreamToBuffer(content, MAX_BYTES)
  return { ok: true as const, contentBase64: buf.toString('base64'), contentType: 'application/octet-stream' }
})

handleIpc('net:fetchExternalImage', async (_e, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false as const, error: 'invalid URL' }
  }

  const MAX_BYTES = 5 * 1024 * 1024
  const SAFE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']

  // PII hygiene: log only the origin, never path/query — query strings in tracking
  // pixels routinely carry per-recipient tokens that uniquely identify the user.
  const originForLog = (() => {
    try { return new URL(url).origin } catch { return '<invalid-url>' }
  })()

  try {
    const resp = await requestSafeRemoteBytes(url, MAX_BYTES, {
      method: 'GET',
      headers: { 'User-Agent': 'MailCopilot/1.0' },
      timeoutMs: 10_000,
      maxRedirects: 5,
    })
    if (resp.status < 200 || resp.status >= 300) return { ok: false as const, error: `HTTP ${resp.status}` }

    const contentTypeHeader = Array.isArray(resp.headers['content-type'])
      ? resp.headers['content-type'][0]
      : resp.headers['content-type']
    const ct = (contentTypeHeader || '').split(';')[0].trim().toLowerCase()
    if (!SAFE_IMAGE_TYPES.includes(ct)) return { ok: false as const, error: 'unsupported image type' }

    if (resp.body.length === 0) return { ok: false as const, error: 'empty' }

    return { ok: true as const, contentBase64: resp.body.toString('base64'), contentType: ct }
  } catch (e) {
    // Emit only origin — never the full URL (PII hygiene).
    logMail.debug('fetchExternalImage failed for %s: %s', originForLog, String(e))
    return { ok: false as const, error: String(e) }
  }
})

// --- §2.7: pending-move suppression registry --------------------------------
// In-memory only. Tracks UIDs that the renderer has optimistically moved out
// of a folder while the 5s undo bar is still visible — so concurrent
// `net:inboxSummaries` / `cache:inboxPage` fetches do not "resurrect" them in
// the UI before the deferred IMAP MOVE actually fires.
//
// Lifetime: each entry auto-expires 10s after addition (safety net for
// renderer crash between `pendingAdd` and `pendingRemove`/`pendingClear` —
// without auto-expire a stale uid would stay suppressed forever).
//
// Hotspot policy (electron/main.ts ~8k lines): kept as file-private helpers
// rather than a new module — registry lifetime is tied to main process and
// the IPC handlers are inline below.
const logPendingMove = createLogger('PendingMove')
const PENDING_MOVE_TTL_MS = 10_000

// account → folder → uid → expire-timer handle
const pendingMoveRegistry = new Map<number, Map<string, Map<number, NodeJS.Timeout>>>()

/**
 * Total uids tracked under an account (sum across all folders). Used by the
 * §2.7 iter3 registry cap check.
 */
function pendingMoveAccountSize(accountId: number): number {
  const byFolder = pendingMoveRegistry.get(accountId)
  if (!byFolder) return 0
  let total = 0
  for (const byUid of byFolder.values()) total += byUid.size
  return total
}

/**
 * Total uids tracked across ALL accounts (sum across every account+folder).
 * Used by the §2.7 iter4 global cap check — defense-in-depth against an
 * attacker spreading entries across many real-but-distinct account IDs to
 * sidestep the per-account cap.
 */
function pendingMoveRegistryTotalSize(): number {
  let total = 0
  for (const byFolder of pendingMoveRegistry.values()) {
    for (const byUid of byFolder.values()) total += byUid.size
  }
  return total
}

/**
 * §2.7 iter4 (codex security High): predicate used by `pendingMoveAdd` to
 * reject calls referencing an unknown accountId. Wired through `getAccountMeta`
 * (Zod-sanitized config-store lookup). Inlined into a function so the registry
 * helper stays a pure function of (accountId, folder, uids) instead of
 * pulling electron-store at module load time, and so tests of the mirror
 * class can substitute a custom predicate without touching production state.
 *
 * §2.19 iter2 fix: in IS_E2E mode the canonical account roster is `E2E_ACCOUNTS`
 * (not the config-store), mirroring the IS_E2E branches in `accounts:list` /
 * `accounts:get`. Without this branch the undo-move sync-race e2e
 * (tests/e2e/ui.extra.spec.ts:245) regresses because pendingAdd rejects every
 * accountId, so `filterPendingMoves` never suppresses the optimistically
 * archived UID and `net:inboxSummaries` resurrects it during the 5s window.
 */
function pendingMoveAccountExists(accountId: number): boolean {
  if (IS_E2E) return E2E_ACCOUNTS.some(a => a.id === accountId)
  try {
    return Boolean(getAccountMeta(accountId))
  } catch {
    // getAccountMeta normally cannot throw, but if the config store is in a
    // weird state we treat that as "unknown" — fail closed for the renderer
    // boundary check; legitimate flows are unaffected because pendingAdd is
    // only reached after a successful net:move:* preceding setup.
    return false
  }
}

/**
 * Add uids to the pending-move registry. Returns `false` if the input is
 * rejected (folder too long, would-exceed account cap) — caller surfaces
 * the rejection to the renderer. Returns `true` on success (including
 * legitimate no-op for empty uids).
 *
 * §2.7 iter3 (codex security High): folder length and per-account cap are
 * enforced here so any code path adding to the registry — not just the IPC
 * handler — gets the same defense.
 */
function pendingMoveAdd(accountId: number, folder: string, uids: number[]): boolean {
  // §2.7 iter5 (codex security High): folder length cap runs FIRST so an
  // attacker-controlled `folder` string can never be logged raw on any
  // rejection path (PII leak + log amplification). After the cap, only
  // `folder.length` is ever included in log payloads — never `folder` itself.
  if (folder.length > PENDING_MOVE_MAX_FOLDER_LEN) {
    logPendingMove.warn(
      'reject add: folder length %d exceeds cap %d (account=%d)',
      folder.length, PENDING_MOVE_MAX_FOLDER_LEN, accountId,
    )
    return false
  }
  // §2.7 iter4 (codex security High): reject unknown account IDs BEFORE any
  // mutation. Without this, a compromised renderer could call pendingAdd with
  // arbitrary IDs (1..N), each allocating a fresh per-account bucket up to
  // PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT — bypassing the per-account cap by
  // fanning out across fake accounts and reopening the DoS class. The
  // existence check uses `getAccountMeta()` (Zod-sanitized config-store
  // lookup), keeping this function pure of electron-store coupling.
  if (!pendingMoveAccountExists(accountId)) {
    logPendingMove.warn(
      'reject add: unknown accountId=%d (folderLen=%d, +%d uids)',
      accountId, folder.length, uids.length,
    )
    return false
  }
  // Per-call uid cap (defense in depth — same value as pendingMoveUidsSchema).
  // Function-level enforcement protects future callers that bypass the schema.
  if (uids.length > PENDING_MOVE_MAX_UIDS_PER_CALL) {
    logPendingMove.warn(
      'reject add: uids length %d exceeds per-call cap %d (account=%d, folderLen=%d)',
      uids.length, PENDING_MOVE_MAX_UIDS_PER_CALL, accountId, folder.length,
    )
    return false
  }
  // Cap is checked against the *would-be* total after this call so a
  // single huge call cannot bypass it. Empty uids are a no-op and pass.
  if (uids.length > 0) {
    const projected = pendingMoveAccountSize(accountId) + uids.length
    if (projected > PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT) {
      logPendingMove.warn(
        'reject add: registry size %d would exceed cap %d (account=%d, +%d, folderLen=%d)',
        projected, PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT, accountId, uids.length, folder.length,
      )
      return false
    }
    // §2.7 iter4 (codex security High): defense-in-depth global cap across
    // all accounts. Even if every accountId passes the existence check, a
    // hostile caller can still try to fan out across many real accounts to
    // exhaust main-process memory (one NodeJS.Timeout per uid, 10s TTL).
    const projectedGlobal = pendingMoveRegistryTotalSize() + uids.length
    if (projectedGlobal > PENDING_MOVE_MAX_REGISTRY_GLOBAL) {
      logPendingMove.warn(
        'reject add: global registry size %d would exceed cap %d (account=%d, +%d, folderLen=%d)',
        projectedGlobal, PENDING_MOVE_MAX_REGISTRY_GLOBAL, accountId, uids.length, folder.length,
      )
      return false
    }
  }
  let byFolder = pendingMoveRegistry.get(accountId)
  if (!byFolder) {
    byFolder = new Map()
    pendingMoveRegistry.set(accountId, byFolder)
  }
  let byUid = byFolder.get(folder)
  if (!byUid) {
    byUid = new Map()
    byFolder.set(folder, byUid)
  }
  for (const uid of uids) {
    const existing = byUid.get(uid)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      // Auto-expire: drop entry if still present.
      const f = pendingMoveRegistry.get(accountId)
      const u = f?.get(folder)
      if (u && u.get(uid) === timer) {
        u.delete(uid)
        if (u.size === 0) f!.delete(folder)
        const remaining = pendingMoveRegistry.get(accountId)
        if (remaining && remaining.size === 0) pendingMoveRegistry.delete(accountId)
        logPendingMove.debug('auto-expire account=%d folder=%s uid=%d', accountId, folder, uid)
      }
    }, PENDING_MOVE_TTL_MS)
    // Allow process to exit naturally even with pending timers.
    if (typeof timer.unref === 'function') timer.unref()
    byUid.set(uid, timer)
  }
  return true
}

function pendingMoveRemove(accountId: number, folder: string, uids: number[]): void {
  const byFolder = pendingMoveRegistry.get(accountId)
  const byUid = byFolder?.get(folder)
  if (!byUid) return
  for (const uid of uids) {
    const timer = byUid.get(uid)
    if (timer) {
      clearTimeout(timer)
      byUid.delete(uid)
    }
  }
  if (byUid.size === 0) byFolder!.delete(folder)
  if (byFolder && byFolder.size === 0) pendingMoveRegistry.delete(accountId)
}

function pendingMoveClear(accountId: number, folder: string): void {
  const byFolder = pendingMoveRegistry.get(accountId)
  const byUid = byFolder?.get(folder)
  if (!byUid) return
  for (const timer of byUid.values()) clearTimeout(timer)
  byFolder!.delete(folder)
  if (byFolder!.size === 0) pendingMoveRegistry.delete(accountId)
}

/**
 * Drop entries that are currently marked as "pending move" out of the result
 * of an inbox/folder fetch. Generic over any row that carries (accountId,
 * folder, uid) — same shape for `MailSummary` (net result) and `MessageRow`
 * (DB cache result), so a single helper covers both consumers.
 */
function filterPendingMoves<T extends { accountId: number; folder: string; uid: number }>(items: T[]): T[] {
  if (pendingMoveRegistry.size === 0) return items
  return items.filter(m => {
    const byUid = pendingMoveRegistry.get(m.accountId)?.get(m.folder)
    return !byUid?.has(m.uid)
  })
}

handleIpc('net:move:pendingAdd', async (_e, accountId: unknown, folder: unknown, uids: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  // §2.7 iter3 (codex security High): use the tighter pending-move schema with
  // a 10000-uid cap. Pending-move IPC is the only path that allocates per-uid
  // long-lived NodeJS.Timeout handles, so a separate stricter schema applies.
  // Folder length, per-account registry cap, accountId existence (§2.7 iter4)
  // and the global registry cap (§2.7 iter4) are enforced inside pendingMoveAdd
  // (see PENDING_MOVE_MAX_FOLDER_LEN / PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT /
  // PENDING_MOVE_MAX_REGISTRY_GLOBAL). Reject is logged via logPendingMove.warn;
  // renderer ignores the return.
  const parsedUids = pendingMoveUidsSchema.parse(uids)
  const accepted = pendingMoveAdd(id, parsedFolder, parsedUids)
  return accepted ? { ok: true as const } : { ok: false as const, reason: 'pending_cap_exceeded' as const }
})

handleIpc('net:move:pendingRemove', async (_e, accountId: unknown, folder: unknown, uids: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  // §2.7 iter3: same uid-array cap on the remove path. Removing is cheap (no
  // timer allocation) but iterating millions of entries is still wasteful and
  // a hostile renderer should not be able to send arbitrarily large arrays.
  const parsedUids = pendingMoveUidsSchema.parse(uids)
  pendingMoveRemove(id, parsedFolder, parsedUids)
  return { ok: true as const }
})

handleIpc('net:move:pendingClear', async (_e, accountId: unknown, folder: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  pendingMoveClear(id, parsedFolder)
  return { ok: true as const }
})

handleIpc('net:move', async (_e, accountId: unknown, fromMailbox: unknown, toMailbox: unknown, uids: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFrom = mailboxSchema.parse(fromMailbox)
  const parsedTo = mailboxSchema.parse(toMailbox)
  const parsedUids = uidsSchema.parse(uids)

  if (IS_E2E) {
    if (parsedFrom !== parsedTo) {
      const set = new Set(parsedUids)
      const fromBox = e2eBox(id, parsedFrom)
      const moving: E2EMail[] = []
      const remaining: E2EMail[] = []
      for (const m of fromBox) {
        if (set.has(m.uid)) moving.push(m)
        else remaining.push(m)
      }
      E2E_BOXES[id] = E2E_BOXES[id] ?? {}
      E2E_BOXES[id][parsedFrom] = remaining
      if (moving.length > 0) {
        const toBox = e2eBox(id, parsedTo)
        E2E_BOXES[id][parsedTo] = [...moving, ...toBox]
      }
      deleteMessages(id, parsedFrom, parsedUids)
      purgeVirtualFolderRefs(id, parsedFrom, parsedUids)
    }
    return { ok: true as const }
  }

  if (getSettings().workOffline) {
    // Move locally: copy to destination with temporary UIDs, then delete from source.
    // Temporary (negative) UIDs are placeholders until offline replay + folder sync
    // replaces them with real server UIDs (K-9 pattern: MessagingController.java:989).
    moveMessagesLocally(id, parsedFrom, parsedTo, parsedUids)
    deleteEmls(id, parsedFrom, parsedUids)
    purgeVirtualFolderRefs(id, parsedFrom, parsedUids)
    const uidVal = getSyncState(id, parsedFrom)?.uidValidity ?? null
    for (const uid of parsedUids) {
      upsertOfflineOp(id, parsedFrom, uid, 'move', { destFolder: parsedTo }, uidVal)
    }
    return { ok: true as const }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  try {
    await moveMessages(cfg.imap, parsedFrom, parsedTo, parsedUids, id)
  } catch (err) {
    // Transient network failure → queue via offline_ops instead of failing
    // the user's action (§2.14). Local state mirrors the workOffline branch
    // above so the UI shows the message in the destination immediately.
    if (isTransientNetworkError(err)) {
      logMail.warn(`net:move transient failure, queueing: ${err instanceof Error ? err.message : String(err)}`)
      moveMessagesLocally(id, parsedFrom, parsedTo, parsedUids)
      deleteEmls(id, parsedFrom, parsedUids)
      purgeVirtualFolderRefs(id, parsedFrom, parsedUids)
      const uidVal = getSyncState(id, parsedFrom)?.uidValidity ?? null
      for (const uid of parsedUids) {
        upsertOfflineOp(id, parsedFrom, uid, 'move', { destFolder: parsedTo }, uidVal)
      }
      return { ok: true as const, queued: true as const }
    }
    // Permanent errors (AUTHENTICATIONFAILED, UIDVALIDITY mismatch, NO) —
    // surface to user. Unwrap AggregateError so the message is readable.
    throw unwrapAggregate(err)
  }
  // Delete EML files from the old folder (UIDs change on move)
  deleteEmls(id, parsedFrom, parsedUids)
  purgeVirtualFolderRefs(id, parsedFrom, parsedUids)
  return { ok: true as const }
})

handleIpc('net:delete', async (_e, accountId: unknown, mailbox: unknown, uids: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  const parsedUids = uidsSchema.parse(uids)

  if (IS_E2E) {
    const set = new Set(parsedUids)
    E2E_BOXES[id] = E2E_BOXES[id] ?? {}
    E2E_BOXES[id][parsedMailbox] = e2eBox(id, parsedMailbox).filter(m => !set.has(m.uid))
    deleteMessages(id, parsedMailbox, parsedUids)
    purgeVirtualFolderRefs(id, parsedMailbox, parsedUids)
    return { ok: true as const }
  }

  if (getSettings().workOffline) {
    deleteMessages(id, parsedMailbox, parsedUids)
    deleteEmls(id, parsedMailbox, parsedUids)
    purgeVirtualFolderRefs(id, parsedMailbox, parsedUids)
    const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
    for (const uid of parsedUids) {
      upsertOfflineOp(id, parsedMailbox, uid, 'delete', undefined, uidVal)
    }
    return { ok: true as const }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  try {
    await deleteMessagesRemote(cfg.imap, parsedMailbox, parsedUids, id)
  } catch (err) {
    if (isTransientNetworkError(err)) {
      logMail.warn(`net:delete transient failure, queueing: ${err instanceof Error ? err.message : String(err)}`)
      deleteMessages(id, parsedMailbox, parsedUids)
      deleteEmls(id, parsedMailbox, parsedUids)
      purgeVirtualFolderRefs(id, parsedMailbox, parsedUids)
      const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
      for (const uid of parsedUids) {
        upsertOfflineOp(id, parsedMailbox, uid, 'delete', undefined, uidVal)
      }
      return { ok: true as const, queued: true as const }
    }
    throw unwrapAggregate(err)
  }
  deleteEmls(id, parsedMailbox, parsedUids)
  purgeVirtualFolderRefs(id, parsedMailbox, parsedUids)
  return { ok: true as const }
})

handleIpc('net:createMailbox', async (_e, accountId: unknown, folderPath: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedPath = mailboxSchema.parse(folderPath)

  if (IS_E2E) {
    return { ok: true as const }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  await createMailbox(id, cfg.imap, parsedPath)
  return { ok: true as const }
})

handleIpc('net:renameMailbox', async (_e, accountId: unknown, fromPath: unknown, toPath: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFrom = mailboxSchema.parse(fromPath)
  const parsedTo = mailboxSchema.parse(toPath)
  if (parsedFrom === parsedTo) return { ok: true as const }

  if (IS_E2E) {
    const boxes = E2E_BOXES[id] ?? {}
    const current = boxes[parsedFrom] ?? []
    boxes[parsedTo] = current
    delete boxes[parsedFrom]
    E2E_BOXES[id] = boxes
    return { ok: true as const }
  }

  const prevPref = getFolderPref(id, parsedFrom)
  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  await renameMailbox(id, cfg.imap, parsedFrom, parsedTo)
  try {
    if (prevPref) {
      upsertFolderPref(id, parsedTo, {
        visible: prevPref.visible,
        includeInBadges: prevPref.includeInBadges,
        headerSyncMode: prevPref.headerSyncMode,
        headerSyncDays: prevPref.headerSyncDays,
        offlineMode: prevPref.offlineMode,
        offlineDays: prevPref.offlineDays,
        icon: prevPref.icon,
      })
    }
    removeFolderPref(id, parsedFrom)
  } catch {
    // ignore
  }
  return { ok: true as const }
})

handleIpc('net:deleteMailbox', async (_e, accountId: unknown, folderPath: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedPath = mailboxSchema.parse(folderPath)

  if (IS_E2E) {
    const boxes = E2E_BOXES[id] ?? {}
    delete boxes[parsedPath]
    E2E_BOXES[id] = boxes
    return { ok: true as const }
  }

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)
  await deleteMailbox(id, cfg.imap, parsedPath)
  try { removeFolderPref(id, parsedPath) } catch { /* ignore */ }
  return { ok: true as const }
})

// --- IPC: cache ---
handleIpc('cache:inboxPage', async (_e, accountId: unknown, folder: unknown, limit: unknown, offset: unknown) => {
  const parsedId = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  const lim = z.number().int().positive().parse(limit)
  const beforeUid = beforeUidSchema.parse(offset)
  // §2.7: drop UIDs the renderer has optimistically moved out (undo window).
  return filterPendingMoves(getMessagesBeforeUid(parsedId, parsedFolder, lim, beforeUid))
})

handleIpc('cache:search', async (_e, accountId: unknown, folder: unknown, q: unknown, limit: unknown, offset: unknown, sort: unknown) => {
  const parsedId = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  const parsedQ = z.string().min(1).parse(q)
  const { limit: lim, offset: off } = paginationSchema.parse({ limit, offset })
  const parsedSort = z.enum(['relevance', 'date']).optional().parse(sort) ?? 'date'
  // NB: supersede flag is intentionally ignored. Terminating the worker mid-query wipes
  // the SQLite page cache and forces the next request to cold-start on a large corpus
  // (can be 10+ seconds) — which then itself gets superseded ad infinitum. Instead we
  // rely on seq-based result drops in the renderer; the old query keeps running and,
  // importantly, warms the page cache for the new one queued behind it. Hard cancellation
  // still happens on context switch via search:cancelInflight — that's a rare event.
  const t0 = Date.now()
  const qTrim = parsedQ.trim()
  const tokenCount = qTrim.split(/[^\p{L}\p{N}_]+/gu).filter(Boolean).length
  try {
    const rows = await searchWorkerClient.searchMessages(parsedId, parsedFolder, parsedQ, lim, off, parsedSort)
    const dt = Date.now() - t0
    recordHistogram('search.duration_ms', dt, {
      scope: 'folder',
      folder_role: folderRoleFromPath(parsedFolder),
      sort: parsedSort,
      pagination: off > 0,
      len_bucket: bucketQueryLen(qTrim.length),
      token_count: tokenCount,
      result_bucket: bucketResultCount(rows.length),
      duration_bucket: bucketDuration(dt),
      zero_results: rows.length === 0,
    })
    return rows
  } catch (err) {
    recordEvent('search.error', {
      scope: 'folder',
      kind: err instanceof Error && /cancelled/i.test(err.message) ? 'cancelled' : 'error',
    })
    throw err
  }
})

handleIpc('cache:messageByUid', async (_e, accountId: unknown, folder: unknown, uid: unknown) => {
  const parsedId = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  const parsedUid = uidSchema.parse(uid)
  return getMessageByUid(parsedId, parsedFolder, parsedUid) || null
})

handleIpc('cache:unifiedInboxPage', async (_e, accountIds: unknown, limit: unknown, cursor: unknown) => {
  const ids = accountIdsSchema.parse(accountIds)
  const lim = z.number().int().positive().parse(limit)
  const cursorSchema = z.object({
    date: z.string().min(1),
    accountId: accountIdSchema,
    uid: uidSchema,
  }).strict().optional()
  const cur = cursor ? cursorSchema.parse(cursor) : undefined
  // §2.7 iter2: same suppression contract as cache:inboxPage / net:inboxSummaries —
  // do not let the unified-inbox surface resurrect a UID that's mid-move during
  // the 5s undo window. filterPendingMoves keys per (accountId, folder, uid).
  return filterPendingMoves(getUnifiedInboxPage(ids, lim, cur))
})

handleIpc('cache:unifiedSearch', async (_e, accountIds: unknown, q: unknown, limit: unknown, offset: unknown, scope: unknown, sort: unknown) => {
  const ids = accountIdsSchema.parse(accountIds)
  const parsedQ = z.string().min(1).parse(q)
  const { limit: lim, offset: off } = paginationSchema.parse({ limit, offset })
  const parsedScope = z.enum(['inbox', 'all']).optional().parse(scope) ?? 'all'
  const parsedSort = z.enum(['relevance', 'date']).optional().parse(sort) ?? 'date'
  // See cache:search above — supersede intentionally ignored to keep worker warm.
  const t0 = Date.now()
  const qTrim = parsedQ.trim()
  const tokenCount = qTrim.split(/[^\p{L}\p{N}_]+/gu).filter(Boolean).length
  try {
    const rows = await searchWorkerClient.searchUnifiedInbox(ids, parsedQ, lim, off, parsedScope, parsedSort)
    const dt = Date.now() - t0
    recordHistogram('search.duration_ms', dt, {
      scope: parsedScope === 'inbox' ? 'unified_inbox' : 'unified_all',
      account_count: ids.length,
      sort: parsedSort,
      pagination: off > 0,
      len_bucket: bucketQueryLen(qTrim.length),
      token_count: tokenCount,
      result_bucket: bucketResultCount(rows.length),
      duration_bucket: bucketDuration(dt),
      zero_results: rows.length === 0,
    })
    return rows
  } catch (err) {
    recordEvent('search.error', {
      scope: parsedScope === 'inbox' ? 'unified_inbox' : 'unified_all',
      kind: err instanceof Error && /cancelled/i.test(err.message) ? 'cancelled' : 'error',
    })
    throw err
  }
})

handleIpc('search:cancelInflight', async () => {
  searchWorkerClient.cancelInflight()
  return { ok: true }
})

handleIpc('search:indexStats', async (_e, accountIds: unknown) => {
  const ids = accountIdsSchema.parse(accountIds)
  return searchWorkerClient.getSearchIndexStats(ids)
})

handleIpc('search:coverageStats', async (_e, accountIds: unknown) => {
  const ids = accountIdsSchema.parse(accountIds)
  return searchWorkerClient.getSearchCoverageStats(ids)
})

handleIpc('search:crawlStates', async (_e, accountIds: unknown) => {
  const ids = accountIdsSchema.parse(accountIds)
  return searchWorkerClient.listFolderCrawlStates(ids)
})

handleIpc('search:remoteSearch', async (_e, accountId: unknown, folder: unknown, q: unknown, limit: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedFolder = mailboxSchema.parse(folder)
  const parsedQ = z.string().min(1).parse(q)
  const lim = z.number().int().positive().max(200).optional().parse(limit) ?? 100

  if (getSettings().workOffline) return []
  if (IS_E2E) return []

  const { cfg } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap)

  // Parse the query to extract IMAP-compatible search criteria
  const parsed = parseSearchQuery(parsedQ)
  const criteria: {
    text?: string
    from?: string
    to?: string
    subject?: string
    before?: Date
    after?: Date
  } = {}

  // Use free text as body search
  if (parsed.text.length > 0) criteria.text = parsed.text.join(' ')
  if (parsed.from.length > 0) criteria.from = parsed.from[0]
  if (parsed.to.length > 0) criteria.to = parsed.to[0]
  if (parsed.subject.length > 0) criteria.subject = parsed.subject[0]
  if (parsed.before) {
    const d = new Date(parsed.before)
    if (Number.isFinite(d.getTime())) criteria.before = d
  }
  if (parsed.after) {
    const d = new Date(parsed.after)
    if (Number.isFinite(d.getTime())) criteria.after = d
  }

  if (Object.keys(criteria).length === 0) return []

  // Run IMAP SEARCH on the server
  const uids = await imapSearchFolder(id, cfg.imap, parsedFolder, criteria, lim)
  if (uids.length === 0) return []

  // Hydrate UIDs into full summaries (also upserts into local cache)
  const summaries = await fetchSummariesByUids(cfg.imap, parsedFolder, uids, id)
  return summaries
})

handleIpc('cache:folderRoles', () => {
  return getAllCachedFolderRoles()
})

handleIpc('cache:mailboxes', () => {
  return getAllCachedMailboxes()
})

handleIpc('cache:folderPrefs', () => {
  return getAllFolderPrefs()
})

/**
 * §2.15-ter: cache:bodyTrimPreview — peek at the impact of shrinking the
 * global body retention window before the user commits the change. Returns
 * the count of `.eml` files that would be deleted and an estimated total
 * size in bytes (sum of `messages.message_size`, which is populated lazily
 * by the body indexer; older rows may report 0).
 *
 * Only folders with `offlineMode='full'` are included — the global retention
 * setting governs those folders only; per-folder `offlineMode='period'` uses
 * its own `offlineDays` value.
 *
 * Validation: the days value must be one of the allowed enum members
 * (30/90/180/365/-1). `-1` means "forever" — preview returns `{0, 0}`.
 */
handleIpc('cache:bodyTrimPreview', (_e, days: unknown) => {
  const parsedDays = z.number().int().refine(
    v => (BODY_RETENTION_DAYS_VALUES as readonly number[]).includes(v),
    { message: `days must be one of ${BODY_RETENTION_DAYS_VALUES.join(', ')}` },
  ).parse(days)
  if (parsedDays === -1) return { count: 0, estimatedBytes: 0 }
  const cutoffIso = new Date(Date.now() - parsedDays * 86400000).toISOString()
  const { count, totalSize } = previewBodyRetentionImpact(cutoffIso)
  return { count, estimatedBytes: totalSize }
})

// --- IPC: settings ---
handleIpc('settings:get', () => getSettings())

handleIpc('settings:save', async (_e, s: unknown) => {
  const current = getSettings()
  // §3.10 P0: validate incoming renderer payload against the narrow writable
  // subset FIRST. `rendererWritableSettingsSchema` is `.strict()`, so any
  // main-only field (mcpEnableStdio, stdioApproved, mcpConnections) is
  // rejected with a zod `unrecognized_keys` issue. A compromised renderer
  // attempting to flip stdio MCP on via `settings:save` hits this path and
  // gets `{ ok: false, reason: 'forbidden_field' }` without mutating state.
  //
  // We audit-log the rejection so the attempt is visible even if the
  // response is swallowed. The raw forbidden field names are recorded — they
  // are not PII and are essential for incident triage.
  const rendererParsed = rendererWritableSettingsSchema.safeParse(s)
  if (!rendererParsed.success) {
    const forbidden = rendererParsed.error.issues
      .filter(issue => issue.code === 'unrecognized_keys')
      .flatMap(issue => {
        const keys = (issue as { keys?: unknown }).keys
        return Array.isArray(keys) ? (keys as string[]) : []
      })
    const mainOnlyHit = forbidden.some(k =>
      (MAIN_ONLY_SETTINGS_FIELDS as readonly string[]).includes(k),
    )
    if (mainOnlyHit) {
      logMcpStdio.warn('settings:save rejected: forbidden main-only field attempt', forbidden)
      appendMcpAuditEvent({
        eventType: 'settings.forbidden_field',
        reason: `fields:${forbidden.join(',')}`,
      })
      try {
        recordEvent('mcp.stdio.connect_blocked', { reason: 'forbidden_field' })
      } catch { /* telemetry must not block */ }
      return { ok: false as const, reason: 'forbidden_field' as const, fields: forbidden }
    }
    // Non-forbidden validation errors (bad enum, wrong type) fall through to
    // `.parse` below, which throws and produces a useful zod error. The
    // explicit `return` above is only for the §3.10 P0 gate path.
  }

  // Merge incoming payload with current settings so that fields absent from the
  // save payload (e.g. aiPrivacyConsent) retain their persisted value instead of
  // being reset to schema defaults.
  const merged = { ...current, ...(s as Record<string, unknown>) }
  // Force main-only fields back to their persisted values — defense-in-depth
  // against a spread that smuggled them past the schema check above (e.g. a
  // future regression that relaxes .strict()).
  for (const field of MAIN_ONLY_SETTINGS_FIELDS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (merged as any)[field] = (current as any)[field]
  }
  const parsed = settingsSchema.parse(merged)
  const next = { ...parsed, mcpConnections: current.mcpConnections }
  saveSettings(next)
  // Update Sentry state at runtime. Re-attach the identity if the user
  // is flipping the toggle back on — the reverse path (on → off) is
  // handled internally by setSentryUserEnabled via Sentry.setUser(null).
  const wasEnabled = current.sentryEnabled !== false
  const willBeEnabled = next.sentryEnabled !== false
  setSentryUserEnabled(willBeEnabled)
  if (!wasEnabled && willBeEnabled) {
    setSentryUserId(getInstallIdHash())
  }
  // Register/unregister as default mailto: handler based on user preference.
  if (next.defaultMailApp && !app.isDefaultProtocolClient('mailto')) {
    app.setAsDefaultProtocolClient('mailto')
  } else if (!next.defaultMailApp && app.isDefaultProtocolClient('mailto')) {
    app.removeAsDefaultProtocolClient('mailto')
  }
  // Notify all windows (main/settings etc.) about settings change so UI updates without restart.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings:changed', next)
  }
  // Trigger main-process reactions (offline replay, periodic sync restart)
  onSettingsChangedMain(next)
  return { ok: true as const }
})

handleIpc('e2e:localizeMails', (_e, language: unknown) => {
  assertE2EHandlerAllowed('e2e:localizeMails')
  const lang = e2eLanguageSchema.parse(language)
  E2E_LANGUAGE = lang
  E2E_UID_SEQ = 300
  E2E_DRAFT_UID_BY_ID.clear()
  E2E_BOXES = buildE2EBoxes(E2E_LANGUAGE)
  return { ok: true as const, language: E2E_LANGUAGE }
})

/**
 * §2.22 — E2E-only helper: inject a synthetic mail carrying a CalendarInvite
 * into account 1's INBOX so Playwright specs can open it and test the RSVP
 * card without a real IMAP server. Idempotent: replaces any existing mail
 * with the same UID.
 *
 * Only available when MAILCOPILOT_E2E=1 (IS_E2E guard). The channel is on the
 * preload whitelist (see `electron/preload.ts`) so e2e specs can call it via
 * `window.api.invoke` from the renderer; production builds reach the IS_E2E
 * guard first and reject the call (`MAILCOPILOT_E2E !== '1'`), so exposing the
 * channel in preload is safe by construction.
 */
handleIpc('e2e:injectCalendarMail', (_e, payload: unknown) => {
  assertE2EHandlerAllowed('e2e:injectCalendarMail')
  const p = z.object({
    accountId: z.number().int().positive().default(1),
    folder: z.string().default('INBOX'),
    uid: z.number().int().positive(),
    from: z.string(),
    to: z.string(),
    subject: z.string(),
    date: z.string(),
    text: z.string().optional(),
    calendarInvite: z.object({
      uid: z.string(),
      summary: z.string(),
      dtstart: z.string(),
      dtend: z.string().optional(),
      // §2.22 fix iter2A — allDay/tzid mirror the new CalendarInvitePublic
      // shape. Default to false/undefined so existing e2e fixtures keep
      // working without touching every spec.
      allDay: z.boolean().default(false),
      tzid: z.string().optional(),
      organizerEmail: z.string(),
      organizerName: z.string().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
      method: z.enum(['REQUEST', 'CANCEL', 'REPLY', 'PUBLISH', 'OTHER']),
      rawIcs: z.string(),
    }),
  }).parse(payload)
  const box = e2eBox(p.accountId, p.folder)
  const existing = box.findIndex(m => m.uid === p.uid)
  const mail: E2EMail = {
    uid: p.uid,
    from: p.from,
    to: p.to,
    subject: p.subject,
    date: p.date,
    unread: true,
    flagged: false,
    text: p.text ?? '',
    calendarInvite: p.calendarInvite as CalendarInvite,
  }
  if (existing >= 0) box[existing] = mail
  else box.unshift(mail)
  // Notify the renderer so it refreshes the message list without requiring a
  // folder click (force=true bypasses the count-delta guard; pattern matches
  // mail-action / move / flag callbacks that broadcast after mutating DB/box).
  broadcast('mail:exists', { accountId: p.accountId, path: p.folder, force: true })
  return { ok: true as const }
})

/**
 * §3.3.C-uiaudit.22 — E2E-only helper: inject a synthetic mail into any folder
 * for Playwright specs that need specific recipient counts, BCC rows, etc.
 * Mirrors the e2e:injectCalendarMail pattern (see above).
 *
 * Gated by `assertE2EHandlerAllowed`: requires both `MAILCOPILOT_E2E=1` AND
 * `!app.isPackaged` so env-injection on a shipped binary cannot reach this
 * code path. See the helper's JSDoc for the full rationale.
 */
handleIpc('e2e:injectMail', (_e, payload: unknown) => {
  assertE2EHandlerAllowed('e2e:injectMail')
  const p = z.object({
    accountId: z.number().int().positive().default(1),
    folder: z.string().default('INBOX'),
    uid: z.number().int().positive(),
    from: z.string(),
    to: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string(),
    date: z.string(),
    unread: z.boolean().default(false),
    flagged: z.boolean().default(false),
    text: z.string().optional(),
    html: z.string().optional(),
  }).parse(payload)
  const box = e2eBox(p.accountId, p.folder)
  const existing = box.findIndex(m => m.uid === p.uid)
  const mail: E2EMail = {
    uid: p.uid,
    from: p.from,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    date: p.date,
    unread: p.unread,
    flagged: p.flagged,
    text: p.text,
    html: p.html,
  }
  if (existing >= 0) box[existing] = mail
  else box.unshift(mail)
  broadcast('mail:exists', { accountId: p.accountId, path: p.folder, force: true })
  return { ok: true as const }
})

// --- IPC: UI ---
let settingsWin: BrowserWindow | null = null
let accountWin: BrowserWindow | null = null

// Window titles mirror translations from src/i18n/locales/*.json (i18next is unavailable in main process).
// When adding a new language — sync with src/i18n/locales/.
const WINDOW_TITLES: Record<string, Record<string, string>> = {
  en: { settings: 'Settings', account: 'Connect Email', compose: 'New Message', mailWindow: 'Message' },
  ru: { settings: 'Настройки', account: 'Подключение почты', compose: 'Новое письмо', mailWindow: 'Письмо' },
  fr: { settings: 'Parametres', account: 'Connexion e-mail', compose: 'Nouveau message', mailWindow: 'Message' },
  de: { settings: 'Einstellungen', account: 'E-Mail verbinden', compose: 'Neue Nachricht', mailWindow: 'Nachricht' },
  es: { settings: 'Configuracion', account: 'Conectar correo', compose: 'Nuevo mensaje', mailWindow: 'Mensaje' },
  it: { settings: 'Impostazioni', account: 'Collega e-mail', compose: 'Nuovo messaggio', mailWindow: 'Messaggio' },
}

type ChildWindowKind = 'settings' | 'account' | 'compose' | 'mailWindow'

function uiWindowTitle(kind: ChildWindowKind): string {
  const lang = getSettings().language ?? 'en'
  const titles = WINDOW_TITLES[lang] ?? WINDOW_TITLES.en
  return `${titles[kind]} — MailCopilot Beta`
}

/** Child window factory — eliminates BrowserWindow configuration duplication */
function createChildWindow(kind: ChildWindowKind, width: number, height: number, hash: string): BrowserWindow {
  const child = new BrowserWindow({
    width,
    height,
    frame: false,
    show: false,
    backgroundColor: themeBg(),
    title: uiWindowTitle(kind),
    icon: path.join(process.env.VITE_PUBLIC, 'icon.png'),
    parent: win ?? undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      additionalArguments: childBrowserArgs(),
    },
  })
  child.once('ready-to-show', () => child.show())
  child.on('maximize', () => { if (!child.isDestroyed()) child.webContents.send('win:maximizeChanged', true) })
  child.on('unmaximize', () => { if (!child.isDestroyed()) child.webContents.send('win:maximizeChanged', false) })
  configureExternalLinks(child)
  if (VITE_DEV_SERVER_URL) child.loadURL(VITE_DEV_SERVER_URL + '#' + hash)
  else child.loadFile(path.join(RENDERER_DIST, 'index.html'), { hash })
  return child
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return }
  settingsWin = createChildWindow('settings', 720, 640, '/settings')
  settingsWin.on('closed', () => { settingsWin = null })
}

handleIpc('ui:openSettings', () => openSettingsWindow())

function openAccountWindow(mode: 'new' | 'edit' = 'new', editId?: number) {
  // If window is open — close and reopen with new parameters
  if (accountWin && !accountWin.isDestroyed()) {
    accountWin.close()
    accountWin = null
  }
  const params = mode === 'edit' && editId != null ? `mode=edit&id=${editId}` : 'mode=new'
  accountWin = createChildWindow('account', 820, 640, `/account?${params}`)
  accountWin.on('closed', () => { accountWin = null })
}

handleIpc('ui:openAccount', (_e: unknown, mode?: string, editId?: number) => openAccountWindow((mode as 'new' | 'edit') || 'new', editId))

// --- Compose window ---
let composeWin: BrowserWindow | null = null
let composeCtx: { accountId: number; init: ComposeInit | null } | null = null

function openComposeWindow() {
  if (composeWin && !composeWin.isDestroyed()) { composeWin.focus(); return }
  composeWin = createChildWindow('compose', 720, 560, '/compose')
  composeWin.on('closed', () => { composeWin = null })
}

handleIpc('ui:openCompose', (_e, accountIdOrInit?: unknown, maybeInit?: unknown) => {
  const pickAccountId = (raw: unknown): number => {
    const id = accountIdSchema.safeParse(raw)
    if (id.success) return id.data
    // Fallback: current account from settings or the first account.
    if (IS_E2E) return E2E_CURRENT_ACCOUNT_ID
    return getSettings().currentAccountId ?? listAccounts()[0]?.id ?? 1
  }

  const accountId =
    (typeof accountIdOrInit === 'number')
      ? pickAccountId(accountIdOrInit)
      : pickAccountId(undefined)

  const parsedInit =
    (accountIdOrInit && typeof accountIdOrInit === 'object')
      ? composeInitSchema.parse(accountIdOrInit)
      : (maybeInit ? composeInitSchema.parse(maybeInit) : null)

  if (composeWin && !composeWin.isDestroyed()) {
    // Window already exists — always reset the form via compose:init.
    // If parsedInit === null — this is "Compose" (new empty message).
    // If the page is still loading (window just created) — wait for did-finish-load.
    composeWin.focus()
    const send = () => {
      if (composeWin && !composeWin.isDestroyed()) {
        composeWin.webContents.send('compose:init', { accountId, init: parsedInit })
      }
    }
    if (composeWin.webContents.isLoading()) {
      composeWin.webContents.once('did-finish-load', send)
    } else {
      send()
    }
    return
  }

  // New window — save init for compose:getInit (called on first render of Compose.tsx)
  composeCtx = { accountId, init: parsedInit }
  openComposeWindow()
})

handleIpc('ui:openExternal', async (_e, rawUrl: unknown) => {
  const url = z.string().min(1).parse(rawUrl)
  if (IS_E2E) return { ok: true as const }
  // Keep the explicit protocol rejection as the renderer-facing contract
  // (the renderer relies on the throw to surface a disallowed-link error).
  if (!isAllowedExternalUrl(url)) throw new Error('External URL protocol is not allowed')
  // Dispatch through the gate WITHOUT awaiting: reply { ok: true } as soon as
  // the open is handed off, so a hung xdg-open chain can never hold the
  // renderer's await hostage. Rate limiting/anomaly handling live in the gate.
  void openExternalGated(url, 'ui_ipc')
  return { ok: true as const }
})

handleIpc('ui:domainToUnicode', (_e, rawHost: unknown) => {
  const host = z.string().min(1).parse(rawHost)
  return { unicode: domainToUnicode(host), ascii: host }
})

handleIpc('compose:getInit', () => {
  const ctx = composeCtx
  composeCtx = null
  return ctx
})

// --- IPC: Mail-in-window (uiaudit.3 PR B4) ---
//
// Open a single message in a standalone BrowserWindow. Used by the
// "Open in window" toolbar button in the mail viewer (replaces the
// pre-PR-B4 "Open in account" button which broke unified-inbox flow by
// clearing the active mail). Useful for big mails / small screens /
// side-by-side review.
//
// Per CLAUDE.md §5 invariants the new window MUST run with
// sandbox: true + contextIsolation: true + the same preload whitelist;
// MailWindow.tsx fetches message details over the existing
// `net:messageDetails` IPC, so no main-process privileges leak through.
const MAIL_WINDOW_FOLDER_MAX_LEN = PENDING_MOVE_MAX_FOLDER_LEN
const MAIL_WINDOW_KEY_MAX_LEN = 256
const mailOpenInWindowSchema = z.object({
  accountId: accountIdSchema,
  folder: z.string().min(1).max(MAIL_WINDOW_FOLDER_MAX_LEN),
  uid: uidSchema,
  // mailKey is renderer-derived "${accountId}:${folder}:${uid}" and is
  // accepted for round-trip parity / future deduplication, but is not
  // load-bearing on the main side (we already have the canonical triple).
  mailKey: z.string().min(1).max(MAIL_WINDOW_KEY_MAX_LEN),
}).strict()

/** Position offset relative to the main window so the mail window does
 *  not exactly stack on top of it. Matches the Compose-window UX. */
function offsetFromMainWindow(width: number, height: number): { x?: number; y?: number } {
  if (!win || win.isDestroyed()) return {}
  const main = win.getBounds()
  // Try to position the mail window to the right of main. If it would
  // not fit on the same display, fall back to a small inset offset.
  const screens = screen.getAllDisplays()
  const display = screens.find(d => {
    const wa = d.workArea
    return main.x >= wa.x && main.y >= wa.y && main.x < wa.x + wa.width && main.y < wa.y + wa.height
  }) ?? screen.getPrimaryDisplay()
  const wa = display.workArea
  const inset = 40
  const candidateX = main.x + main.width + 8
  const x = candidateX + width <= wa.x + wa.width ? candidateX : main.x + inset
  const candidateY = main.y
  const y = candidateY + height <= wa.y + wa.height ? candidateY : Math.max(wa.y, wa.y + wa.height - height - inset)
  return { x, y }
}

/**
 * Per-message dedup map for `mail:openInWindow`. Keyed by the canonical
 * `${accountId}::${folder}::${uid}` triple so opening the same message twice
 * focuses the existing standalone window instead of spawning an unbounded
 * number of BrowserWindows.
 *
 * codex-security-review B4 LOW (rate-limit): a compromised / chatty renderer
 * could otherwise call this IPC in a loop and OOM the main process by
 * creating tens of thousands of BrowserWindows. With dedup the window count
 * is bounded by the number of distinct messages the user actually has open.
 *
 * Closed-window cleanup: each child registers a `closed` listener that
 * removes its entry from the map, so re-opening the same message after the
 * user has manually closed its window correctly creates a fresh window.
 */
const openMailWindows = new Map<string, BrowserWindow>()

handleIpc('mail:openInWindow', (_e, rawInput: unknown) => {
  const input = mailOpenInWindowSchema.parse(rawInput)
  // Reject opening a mail for an account that does not exist — keeps the
  // surface area of the IPC tight (accountIds from a compromised renderer
  // cannot conjure ghost windows).
  const account = listAccounts().find(a => a.id === input.accountId)
  if (!account) throw new Error('Unknown accountId')

  // Dedup: focus the existing window for this exact message if any, instead
  // of spawning a duplicate. See `openMailWindows` doc for rationale.
  const dedupKey = `${input.accountId}::${input.folder}::${input.uid}`
  const existing = openMailWindows.get(dedupKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return { ok: true as const }
  }

  const width = 800
  const height = 900
  const params = new URLSearchParams({
    accountId: String(input.accountId),
    folder: input.folder,
    uid: String(input.uid),
  })
  const hash = `/mail-window?${params.toString()}`

  const offset = offsetFromMainWindow(width, height)
  const child = new BrowserWindow({
    width,
    height,
    x: offset.x,
    y: offset.y,
    frame: false,
    show: false,
    backgroundColor: themeBg(),
    title: uiWindowTitle('mailWindow'),
    icon: path.join(process.env.VITE_PUBLIC, 'icon.png'),
    parent: win ?? undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      additionalArguments: childBrowserArgs(),
    },
  })
  child.once('ready-to-show', () => child.show())
  child.on('maximize', () => { if (!child.isDestroyed()) child.webContents.send('win:maximizeChanged', true) })
  child.on('unmaximize', () => { if (!child.isDestroyed()) child.webContents.send('win:maximizeChanged', false) })

  // §3.3.C-print.f1 (standalone mail window parity): mirror the main window's
  // Ctrl+P intercept so the standalone mail viewer also forwards the print
  // shortcut via `mail:print` instead of falling through to Chromium's
  // built-in `webContents.print()`, which would print the entire window
  // chrome (titlebar, padding) along with the message. The renderer scopes
  // printing to the iframe (`iframe.contentWindow.print()`) so only the
  // message body appears in the printout.
  child.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'p' && !input.shift && !input.alt) {
      event.preventDefault()
      if (!child.isDestroyed()) child.webContents.send('mail:print')
    }
  })

  child.on('closed', () => {
    // Always remove THIS specific window's entry — but only if the map still
    // points at us. A subsequent re-open before the close event fires would
    // have already replaced the entry; do not clobber that.
    if (openMailWindows.get(dedupKey) === child) openMailWindows.delete(dedupKey)
  })
  openMailWindows.set(dedupKey, child)
  configureExternalLinks(child)
  if (VITE_DEV_SERVER_URL) child.loadURL(VITE_DEV_SERVER_URL + '#' + hash)
  else child.loadFile(path.join(RENDERER_DIST, 'index.html'), { hash })
  return { ok: true as const }
})

// --- IPC: window management ---
handleIpc('win:minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize()
})

handleIpc('win:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
  return w.isMaximized()
})

handleIpc('win:isMaximized', (e) => {
  return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
})

handleIpc('win:close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close()
})

handleIpc('win:getPlatform', () => process.platform)

// --- IPC: frameless window resize for Linux (no WM resize handles) ---
let resizeState: { win: BrowserWindow; dir: string; startBounds: Electron.Rectangle; startCursor: Electron.Point } | null = null
let resizeTimer: ReturnType<typeof setInterval> | null = null
let resizeFailSafeTimer: ReturnType<typeof setTimeout> | null = null

function stopActiveResize() {
  resizeState = null
  if (resizeTimer) {
    clearInterval(resizeTimer)
    resizeTimer = null
  }
  if (resizeFailSafeTimer) {
    clearTimeout(resizeFailSafeTimer)
    resizeFailSafeTimer = null
  }
}

const VALID_RESIZE_DIRS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])

handleIpc('win:startResize', (e, direction: string) => {
  // Linux-only surface: the CSS-edge resize emulation exists because Linux
  // WMs provide no resize handles for frameless windows; macOS/Windows use
  // native edge handling and must not expose this channel
  // (codex-security-review MEDIUM: shrink the abusable surface).
  if (process.platform !== 'linux') return
  // Main window only — and only ITS OWN renderer may drive it. Without the
  // sender check any child window (Compose/Settings) could resize the main
  // window through this channel.
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
  if (BrowserWindow.fromWebContents(e.sender) !== win) return
  if (!VALID_RESIZE_DIRS.has(direction)) return
  const cursor = screen.getCursorScreenPoint()
  const wasActive = resizeState !== null
  resizeState = { win, dir: direction, startBounds: win.getBounds(), startCursor: cursor }
  if (resizeTimer) clearInterval(resizeTimer)
  // The 15s fail-safe deadline is armed only on the null→active transition:
  // repeated startResize calls must not extend it indefinitely, or a
  // misbehaving renderer could hold resizeState (and thereby suppress
  // window-rescue passes) forever.
  if (!wasActive) {
    if (resizeFailSafeTimer) clearTimeout(resizeFailSafeTimer)
    resizeFailSafeTimer = setTimeout(() => stopActiveResize(), 15_000)
  }
  resizeTimer = setInterval(() => {
    if (!resizeState || resizeState.win.isDestroyed() || resizeState.win.isMaximized() || resizeState.win.isFullScreen()) {
      stopActiveResize()
      return
    }
    const curr = screen.getCursorScreenPoint()
    const dx = curr.x - resizeState.startCursor.x
    const dy = curr.y - resizeState.startCursor.y
    const sb = resizeState.startBounds
    let { x, y, width, height } = sb
    const dir = resizeState.dir
    if (dir.includes('e')) width = sb.width + dx
    if (dir.includes('w')) { x = sb.x + dx; width = sb.width - dx }
    if (dir.includes('s')) height = sb.height + dy
    if (dir.includes('n')) { y = sb.y + dy; height = sb.height - dy }
    const [minW, minH] = resizeState.win.getMinimumSize()
    if (width < minW) { if (dir.includes('w')) x -= (minW - width); width = minW }
    if (height < minH) { if (dir.includes('n')) y -= (minH - height); height = minH }
    resizeState.win.setBounds({ x, y, width, height })
  }, 16)
})

handleIpc('win:stopResize', (e) => {
  // Same sender discipline as win:startResize — a child window must not be
  // able to cancel the user's active drag on the main window.
  if (win && !win.isDestroyed() && BrowserWindow.fromWebContents(e.sender) !== win) return
  stopActiveResize()
})

// --- IPC: AI assistant ---
import {
  aiChat,
  stopRequest as aiStopRequest,
  stopAll as aiStopAll,
  setUiContext,
  checkAuth as aiCheckAuth,
  setDraftCallback,
  setMailActionCallback,
  setUnsubscribeCallback,
  setSendEmailCallback,
  setListAttachmentsCallback,
  setDownloadAttachmentCallback,
  setSnoozeCallback,
  setUnsnoozeCallback,
  setFlagCallback,
  setMoveCallback,
  setFollowUpAddCallback,
  setFollowUpDismissCallback,
  setReadLaterCallback,
  saveApiKey as aiSaveApiKey,
  deleteApiKey as aiDeleteApiKey,
  type AiStreamEvent,
  type AiProvider,
  type ApiKeyProvider,
  type EmailContext,
  type MailActionApplyRequest,
  type UnsubscribeApplyRequest,
  type SendEmailApplyRequest,
  type SnoozeRequest,
  type UnsnoozeRequest,
  type FlagRequest,
  type MoveRequest,
  type FollowUpAddRequest,
  type FollowUpDismissRequest,
  type ReadLaterRequest,
  generateSessionTitle,
  aiChatSimple,
  aiChatSimpleOutcome,
  admitBudgetedCall,
  isLocalInferenceEndpoint,
  settleReservationUsd,
  releaseReservationNoSpend,
  clearPendingPreviews,
  selectSummaryProvider,
  generateQuickActionRewrite,
  generateInstantReplyDrafts,
  type QuickActionRewriteResult,
  type InstantReplyDraftsResult,
} from './services/ai'
import {
  generateThreadSummary,
  MIN_SUMMARY_MESSAGES,
  type ThreadSummaryDeps,
  type ThreadSummaryMessage,
} from './services/aiThreadSummary'
import type {
  ThreadSummaryGenerateRequest,
  ThreadSummaryResult,
} from '@mailcopilot/types'

// §3.10 P2: wire the internet-tool interceptor broadcaster. The renderer
// listens on `ai:internet-tool-pending` for the inline confirm UI in the AI
// panel; the gate calls `broadcaster(payload)` synchronously from
// `interceptInternetTool` whenever an internet-class tool is about to fire
// without per-turn consent. Sent only to the main window — child windows
// (Compose, Settings, Account) have no AI panel and dispatching there
// would be a no-op + extra IPC traffic.
import {
  setInternetToolPendingBroadcaster,
  resolveConsent as resolveInternetConsent,
} from './services/aiInternetGate'
setInternetToolPendingBroadcaster((payload) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ai:internet-tool-pending', payload)
  }
})

// On create_draft — open Compose
setDraftCallback((data) => {
  logAI.info(`draftCallback accountId=${data.accountId} to=${data.to} subject="${(data.subject || '').slice(0, 60)}"`)
  // Use existing flow: ui:openCompose with ComposeInit
  const init = { to: data.to, cc: data.cc, bcc: data.bcc, subject: data.subject, text: data.text }
  composeCtx = { accountId: data.accountId, init }
  openComposeWindow()
})

setMailActionCallback(async (input: MailActionApplyRequest) => {
  logAI.info(`mailActionCallback action=${input.action} fromFolder=${input.fromFolder} refs=${input.refs?.length ?? 0}`)
  if (!Array.isArray(input.refs) || input.refs.length === 0) {
    logAI.warn(`mailActionCallback → no messages for action`)
    return { ok: false as const, message: 'No messages for action', affected: 0 }
  }

  const grouped = new Map<string, { accountId: number; folder: string; uids: number[] }>()
  for (const ref of input.refs) {
    const key = `${ref.accountId}:${ref.folder}`
    const g = grouped.get(key) ?? { accountId: ref.accountId, folder: ref.folder, uids: [] }
    g.uids.push(ref.uid)
    grouped.set(key, g)
  }

  let affected = 0
  const affectedFolders: { accountId: number; folder: string }[] = []
  for (const group of grouped.values()) {
    const { id, meta, cfg } = await requireAccountConfig(group.accountId)
    assertImapAuth(id, cfg.imap)
    const uniqueUids = [...new Set(group.uids)].filter(u => Number.isFinite(u) && u > 0)
    if (uniqueUids.length === 0) continue

    if (input.action === 'mark_read') {
      logAI.info(`mailActionCallback mark_read accountId=${id} folder=${group.folder} uids=${uniqueUids.length}`)
      await setSeen(cfg.imap, group.folder, uniqueUids, true, id)
      affected += uniqueUids.length
      affectedFolders.push({ accountId: id, folder: group.folder })
      continue
    }

    const mailboxes = await listMailboxes(id, cfg.imap)
    const detected = detectFolderRoles(mailboxes)
    const roles = mergeRoles(mailboxes, detected, meta.folderRoles ?? {})
    const targetFolder = input.action === 'archive' ? roles.archive : roles.trash

    if (!targetFolder) {
      logAI.warn(`mailActionCallback → target folder not found for action=${input.action} accountId=${id}`)
      return {
        ok: false as const,
        message: input.action === 'archive'
          ? `Archive folder is not configured for account #${id}`
          : `Trash folder is not configured for account #${id}`,
        affected,
      }
    }
    if (targetFolder === group.folder) {
      affected += uniqueUids.length
      continue
    }

    logAI.info(`mailActionCallback ${input.action} accountId=${id} folder=${group.folder} → ${targetFolder} uids=${uniqueUids.length}`)
    await moveMessages(cfg.imap, group.folder, targetFolder, uniqueUids, id)
    deleteEmls(id, group.folder, uniqueUids)
    purgeVirtualFolderRefs(id, group.folder, uniqueUids)
    affected += uniqueUids.length
    affectedFolders.push({ accountId: id, folder: group.folder })
    affectedFolders.push({ accountId: id, folder: targetFolder })
  }

  // Notify renderer about changes to refresh the message list (force — skip count check)
  for (const af of affectedFolders) {
    broadcast('mail:exists', { accountId: af.accountId, path: af.folder, force: true })
  }

  logAI.info(`mailActionCallback → ok=true affected=${affected}`)
  return {
    ok: true as const,
    message: `Action "${input.action}" applied to ${affected} messages`,
    affected,
  }
})

setUnsubscribeCallback(async (input: UnsubscribeApplyRequest) => {
  logAI.info(`unsubscribeCallback fromFolder=${input.fromFolder} refs=${input.refs?.length ?? 0}`)
  if (!Array.isArray(input.refs) || input.refs.length === 0) {
    logAI.warn(`unsubscribeCallback → no messages for unsubscribe`)
    return { ok: false as const, message: 'No messages for unsubscribe', affected: 0 }
  }

  const cfgByAccount = new Map<number, AccountConfig>()
  const results: UnsubscribeAttemptResult[] = []

  for (const ref of input.refs) {
    let cfg = cfgByAccount.get(ref.accountId)
    if (!cfg) {
      const loaded = await requireAccountConfig(ref.accountId)
      assertImapAuth(loaded.id, loaded.cfg.imap)
      cfg = loaded.cfg
      cfgByAccount.set(ref.accountId, cfg)
    }

    let details
    try {
      details = await fetchMessageDetails(ref.accountId, cfg.imap, ref.folder, ref.uid)
    } catch {
      results.push({ ref, method: 'none', auto: false, ok: false, detail: 'Failed to fetch message details' })
      continue
    }

    const links = (details.listUnsubscribe || [])
      .map(l => String(l || '').trim())
      .filter(l => /^https?:\/\//i.test(l) || /^mailto:/i.test(l))

    if (links.length === 0) {
      // Fallback: extract unsubscribe links from HTML/text body
      const bodyLinks = extractUnsubLinksFromHtml(details.html || details.text || '')
      if (bodyLinks.length > 0) {
        logAI.info(`unsubscribeCallback → opening body link for uid=${ref.uid}`)
        // Dispatch through the central gate (rate-limited, fire-and-forget).
        // The returned boolean is the DISPATCH decision, not OS completion: if
        // the gate suppressed this open (e.g. it is the 6th link in a single
        // bulk apply batch and the untrusted bucket is spent), we must NOT
        // claim it was opened — report ok:false so the user can retry.
        const dispatched = await openExternalGated(bodyLinks[0], 'unsubscribe')
        results.push({
          ref, method: 'browser', auto: false, ok: dispatched,
          detail: dispatched
            ? 'No List-Unsubscribe header; opened unsubscribe link from email body'
            : 'Unsubscribe link suppressed by external-open rate limit — retry later',
        })
        continue
      }
      results.push({ ref, method: 'none', auto: false, ok: false, detail: 'No unsubscribe links found (header or body)' })
      continue
    }

    // Try automatic HTTP unsubscribe first (RFC 8058 POST → HTTP GET)
    const autoResult = await tryAutoUnsubscribe(links, details.listUnsubscribePost)

    if (autoResult?.ok) {
      logAI.info(`unsubscribeCallback → auto-unsubscribed uid=${ref.uid} method=${autoResult.method}`)
      results.push({
        ref, method: autoResult.method, auto: true, ok: true,
        httpStatus: autoResult.httpStatus, detail: autoResult.detail,
      })
      continue
    }

    // Fallback: open in browser. Dispatch the first link through the central
    // gate (rate-limited, fire-and-forget) and stop — one link per message is
    // enough. The returned boolean is the DISPATCH decision: true only when the
    // gate granted a token (the candidates already passed the http(s)/mailto
    // filter, so a false here is a gate suppression, not a protocol reject).
    // Reporting it honestly stops a suppressed open from being counted as
    // "opened in browser". Sanitized log: no raw URL.
    let browserOpened = false
    if (links.length > 0) {
      logAI.debug(`unsubscribeCallback → opening unsubscribe link in browser`)
      browserOpened = await openExternalGated(links[0], 'unsubscribe')
    }

    results.push({
      ref, method: 'browser', auto: false, ok: browserOpened,
      httpStatus: autoResult?.httpStatus,
      detail: browserOpened
        ? `Opened unsubscribe link in browser${autoResult ? ` (auto failed: ${autoResult.detail})` : ''}`
        : 'Unsubscribe link suppressed by external-open rate limit — retry later',
    })
  }

  const autoCount = results.filter(r => r.auto && r.ok).length
  const manualCount = results.filter(r => r.method === 'browser' && r.ok).length
  const noLinkCount = results.filter(r => r.method === 'none').length
  const affected = autoCount + manualCount

  const parts: string[] = []
  if (autoCount > 0) parts.push(`${autoCount} auto-unsubscribed`)
  if (manualCount > 0) parts.push(`${manualCount} opened in browser`)
  if (noLinkCount > 0) parts.push(`${noLinkCount} had no unsubscribe link`)

  logAI.info(`unsubscribeCallback → auto=${autoCount} manual=${manualCount} noLink=${noLinkCount}`)
  return {
    ok: affected > 0,
    message: parts.join(', ') || 'No unsubscribe actions performed',
    affected,
    results,
    autoCount,
    manualCount,
    noLinkCount,
  }
})

setSendEmailCallback(async (input: SendEmailApplyRequest) => {
  logAI.info(`sendEmailCallback accountId=${input.accountId} to=${input.to} subject="${(input.subject || '').slice(0, 60)}"`)
  try {
    const { meta, cfg } = await requireAccountConfig(input.accountId)
    assertSmtpAuth(input.accountId, cfg.smtp)

    const fromEmail = meta.email || cfg.smtp.user || cfg.imap.user
    // RFC 2822: if name contains special characters, wrap in quotes
    const fromName = meta.name && /[",<>@()[\]\\;:]/.test(meta.name)
      ? `"${meta.name.replace(/["\\]/g, '\\$&')}"`
      : meta.name
    const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail
    const parsedOptions = sendMailOptionsSchema.parse({
      from,
      to: input.to,
      cc: input.cc || undefined,
      bcc: input.bcc || undefined,
      subject: input.subject,
      text: input.body,
    })
    const result = await sendMailWithAccountConfig(input.accountId, parsedOptions)

    upsertContactsOutgoing([
      ...parseDisplayAddressList(input.to),
      ...parseDisplayAddressList(input.cc),
      ...parseDisplayAddressList(input.bcc),
    ].map(a => ({ email: a.address || '', name: a.name })))

    logAI.info(`sendEmailCallback → ok=true messageId=${result.messageId}`)
    return { ok: true, message: 'Email sent', messageId: result.messageId }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logAI.error(`sendEmailCallback → error: ${message}`)
    return { ok: false, message: `Send error: ${message}` }
  }
})

setListAttachmentsCallback(async (accountId, folder, uid) => {
  logAI.info(`listAttachmentsCallback accountId=${accountId} folder=${folder} uid=${uid}`)
  try {
    // First check local EML (offline)
    const localEml = readEml(accountId, folder, uid)
    if (localEml) {
      const details = await parseEmlBuffer(uid, localEml)
      return { ok: true as const, attachments: details.attachments || [] }
    }
    // Otherwise — from IMAP
    const { cfg } = await requireAccountConfig(accountId)
    const details = await fetchMessageDetails(accountId, cfg.imap, folder, uid)
    return { ok: true as const, attachments: details.attachments || [] }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logAI.error(`listAttachmentsCallback → ${message}`)
    return { ok: false as const, error: message }
  }
})

setDownloadAttachmentCallback(async (accountId, folder, uid, part) => {
  logAI.info(`downloadAttachmentCallback accountId=${accountId} folder=${folder} uid=${uid} part=${part}`)
  const MAX_BYTES = 10 * 1024 * 1024

  try {
    // If part starts with 'eml:' — extract from local EML
    if (part.startsWith(EML_ATTACHMENT_PART_PREFIX)) {
      const localEml = readEml(accountId, folder, uid)
      if (!localEml) return { ok: false as const, error: 'Local EML not found' }
      const extracted = await extractEmlAttachment(localEml, part)
      if (!extracted) return { ok: false as const, error: 'Attachment not found in EML' }
      return { ok: true as const, buffer: extracted.content, contentType: extracted.contentType, filename: extracted.filename }
    }

    // Download from IMAP
    const { cfg } = await requireAccountConfig(accountId)
    const { content } = await downloadMessagePart(accountId, cfg.imap, folder, uid, part)
    if (!content) return { ok: false as const, error: 'Empty attachment content' }
    const buffer = await readStreamToBuffer(content, MAX_BYTES)

    // Get attachment metadata (contentType, filename)
    const details = await fetchMessageDetails(accountId, cfg.imap, folder, uid)
    const attMeta = details.attachments?.find(a => a.part === part)

    return {
      ok: true as const,
      buffer,
      contentType: attMeta?.contentType || 'application/octet-stream',
      filename: attMeta?.filename,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logAI.error(`downloadAttachmentCallback → ${message}`)
    return { ok: false as const, error: message }
  }
})

// --- GTD callbacks ---

setSnoozeCallback(async (input: SnoozeRequest) => {
  logAI.info(`snoozeCallback accountId=${input.accountId} folder=${input.folder} uids=${input.uids.length} wakeAt=${input.wakeAt}`)
  try {
    const ids: number[] = []
    for (const uid of input.uids) {
      const row = getMessageByUid(input.accountId, input.folder, uid)
      const msgId = row?.messageId ?? null
      ids.push(insertSnooze(input.accountId, msgId, input.folder, uid, input.wakeAt))
    }
    notifySnoozeChanged(input.accountId)
    return { ok: true, message: `Snoozed ${ids.length} email(s) until ${input.wakeAt}`, ids }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAI.error(`snoozeCallback error: ${msg}`)
    return { ok: false, message: `Snooze error: ${msg}` }
  }
})

setUnsnoozeCallback(async (input: UnsnoozeRequest) => {
  logAI.info(`unsnoozeCallback ids=${input.snoozeIds.join(',')}`)
  let removed = 0
  for (const id of input.snoozeIds) {
    if (removeSnooze(id)) removed++
  }
  if (removed > 0) notifySnoozeChanged()
  return { ok: true, message: `Unsnoozed ${removed} email(s)`, removed }
})

setFlagCallback(async (input: FlagRequest) => {
  logAI.info(`flagCallback accountId=${input.accountId} folder=${input.folder} uids=${input.uids.length} flagged=${input.flagged}`)
  try {
    const { cfg } = await requireAccountConfig(input.accountId)
    assertImapAuth(input.accountId, cfg.imap)
    await setFlagged(cfg.imap, input.folder, input.uids, input.flagged, input.accountId)
    broadcast('mail:exists', { accountId: input.accountId, path: input.folder, force: true })
    return { ok: true, message: `${input.flagged ? 'Starred' : 'Unstarred'} ${input.uids.length} email(s)`, affected: input.uids.length }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAI.error(`flagCallback error: ${msg}`)
    return { ok: false, message: `Flag error: ${msg}`, affected: 0 }
  }
})

setMoveCallback(async (input: MoveRequest) => {
  logAI.info(`moveCallback accountId=${input.accountId} from=${input.fromFolder} to=${input.toFolder} uids=${input.uids.length}`)
  try {
    const { cfg } = await requireAccountConfig(input.accountId)
    assertImapAuth(input.accountId, cfg.imap)
    await moveMessages(cfg.imap, input.fromFolder, input.toFolder, input.uids, input.accountId)
    deleteEmls(input.accountId, input.fromFolder, input.uids)
    purgeVirtualFolderRefs(input.accountId, input.fromFolder, input.uids)
    broadcast('mail:exists', { accountId: input.accountId, path: input.fromFolder, force: true })
    return { ok: true, message: `Moved ${input.uids.length} email(s) to ${input.toFolder}`, affected: input.uids.length }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAI.error(`moveCallback error: ${msg}`)
    return { ok: false, message: `Move error: ${msg}`, affected: 0 }
  }
})

setFollowUpAddCallback(async (input: FollowUpAddRequest) => {
  logAI.info(`followUpAddCallback accountId=${input.accountId} folder=${input.folder} uid=${input.uid} toAddr=${input.toAddr} remindAt=${input.remindAt}`)
  try {
    const sentMessageId = `ai-followup-${input.accountId}-${input.uid}-${Date.now()}`
    const id = insertFollowUp(input.accountId, sentMessageId, input.folder, input.uid, input.toAddr, input.subject, input.remindAt)
    return { ok: true, message: `Follow-up reminder set for ${input.remindAt}`, id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAI.error(`followUpAddCallback error: ${msg}`)
    return { ok: false, message: `Follow-up error: ${msg}` }
  }
})

setFollowUpDismissCallback(async (input: FollowUpDismissRequest) => {
  logAI.info(`followUpDismissCallback id=${input.followUpId}`)
  const ok = dismissFollowUp(input.followUpId)
  return { ok, message: ok ? 'Follow-up dismissed' : 'Follow-up not found' }
})

setReadLaterCallback(async (input: ReadLaterRequest) => {
  logAI.info(`readLaterCallback accountId=${input.accountId} folder=${input.folder} uids=${input.uids.length} add=${input.add}`)
  try {
    if (input.add) {
      for (const uid of input.uids) {
        insertReadLater(input.accountId, input.folder, uid)
      }
    } else {
      for (const uid of input.uids) {
        removeReadLaterByUid(input.accountId, input.folder, uid)
      }
    }
    notifyReadLaterChanged(input.accountId)
    return { ok: true, message: `${input.add ? 'Added' : 'Removed'} ${input.uids.length} email(s) ${input.add ? 'to' : 'from'} Read Later` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAI.error(`readLaterCallback error: ${msg}`)
    return { ok: false, message: `Read Later error: ${msg}` }
  }
})

handleIpc('ai:chat', async (_e, requestId: unknown, prompt: unknown, context?: unknown, sessionId?: unknown, aiProvider?: unknown, perRequestEgressConsent?: unknown) => {
  const reqId = z.string().min(1).parse(requestId)
  const p = z.string().min(1).parse(prompt)
  const ctx = context ? (context as EmailContext) : undefined
  const sid = typeof sessionId === 'string' ? sessionId : undefined
  const provider = z.enum(['subscription', 'anthropic-api', 'openai-api', 'gemini-api']).optional().parse(
    typeof aiProvider === 'string' ? aiProvider : undefined
  ) as AiProvider | undefined
  // §3.10 P1: optional per-turn override of `Settings.aiEgressPolicy`. Coerced
  // strictly to boolean so a malformed renderer payload cannot inject truthy
  // strings. Transient — never persisted.
  const perTurnConsent = perRequestEgressConsent === true

  if (IS_E2E) {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const mockText = [
      `Quick summary for: "${p}"`,
      '',
      '- Priority: reply today',
      '- Action: confirm deadline and attach the latest document',
      '- Draft hint: keep response short and specific',
      '',
      'Sources: accountId=1, folder=INBOX, uid=101',
    ].join('\n')
    const chunks = mockText.match(/.{1,42}/g) ?? [mockText]

    ;(async () => {
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send('ai:stream', { type: 'status', requestId: reqId, status: 'thinking' } satisfies AiStreamEvent)
        }
        await wait(120)

        if (win && !win.isDestroyed()) {
          win.webContents.send('ai:stream', {
            type: 'tool_use_start',
            requestId: reqId,
            toolName: 'mcp__mailcopilot__get_email',
            toolInput: ctx ?? { accountId: 1, folder: 'INBOX', uid: 101 },
          } satisfies AiStreamEvent)
        }
        await wait(100)

        if (win && !win.isDestroyed()) {
          win.webContents.send('ai:stream', {
            type: 'tool_use_end',
            requestId: reqId,
            toolName: 'mcp__mailcopilot__get_email',
            result: '{"ok":true}',
          } satisfies AiStreamEvent)
        }

        for (const chunk of chunks) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('ai:stream', { type: 'status', requestId: reqId, status: 'streaming' } satisfies AiStreamEvent)
            win.webContents.send('ai:stream', { type: 'text_delta', requestId: reqId, text: chunk } satisfies AiStreamEvent)
          }
          await wait(40)
        }

        if (win && !win.isDestroyed()) {
          const source = (() => {
            if (!ctx || typeof ctx !== 'object') return undefined
            const data = (ctx as { data?: unknown }).data
            if (!data || typeof data !== 'object') return undefined
            const ref = data as { accountId?: unknown; folder?: unknown; uid?: unknown }
            if (typeof ref.accountId !== 'number' || typeof ref.folder !== 'string' || typeof ref.uid !== 'number') return undefined
            return [{ ref: { accountId: ref.accountId, folder: ref.folder, uid: ref.uid }, reason: 'mock' }]
          })()
          win.webContents.send('ai:stream', {
            type: 'result',
            requestId: reqId,
            text: mockText,
            sessionId: sid || 'e2e-session',
            costUsd: 0,
            sources: source,
          } satisfies AiStreamEvent)
          win.webContents.send('ai:stream', { type: 'status', requestId: reqId, status: 'done' } satisfies AiStreamEvent)
        }
      } catch {
        if (win && !win.isDestroyed()) {
          win.webContents.send('ai:stream', {
            type: 'error',
            requestId: reqId,
            message: 'E2E mock AI error',
          } satisfies AiStreamEvent)
        }
      }
    })()

    return { ok: true as const }
  }

  logAI.info(`ai:chat requestId=${reqId} provider=${provider || 'auto'} prompt="${p.slice(0, 80)}"`)

  // Load conversation history for multi-turn (OpenAI/Gemini) or map Claude sessionId
  let history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined
  let effectiveSid = sid
  if (sid) {
    const effectiveProvider = provider || getSettings().aiProvider
    if (effectiveProvider === 'openai-api' || effectiveProvider === 'gemini-api') {
      const msgs = getLastAiMessages(sid, 40)
      if (msgs.length > 0) history = msgs.map(m => ({ role: m.role, content: m.content }))
    }
    if (effectiveProvider === 'subscription' || effectiveProvider === 'anthropic-api') {
      const session = getAiSession(sid)
      if (session?.claudeSessionId) effectiveSid = session.claudeSessionId
    }
  }

  // Start streaming in background, send events only to the main window
  void (async () => {
    let eventCount = 0
    try {
      for await (const event of aiChat({ requestId: reqId, prompt: p, context: ctx, sessionId: effectiveSid, aiProvider: provider, history, perRequestEgressConsent: perTurnConsent })) {
        eventCount++
        if (event.type === 'text_delta') {
          logAI.debug(`  stream #${eventCount} text_delta len=${(event as { text: string }).text.length}`)
        } else {
          logAI.debug(`  stream #${eventCount} type=${event.type}`)
        }
        // Save Claude session ID for resume support
        if (event.type === 'result' && event.sessionId && sid) {
          updateAiSessionClaudeId(sid, event.sessionId)
        }
        if (win && !win.isDestroyed()) win.webContents.send('ai:stream', event)
      }
      logAI.info(`ai:chat done requestId=${reqId} totalEvents=${eventCount}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logAI.error(`ai:chat error requestId=${reqId}: ${message}`)
      if (win && !win.isDestroyed()) win.webContents.send('ai:stream', { type: 'error', requestId: reqId, message } satisfies AiStreamEvent)
    }
  })()

  return { ok: true as const }
})

handleIpc('ai:stop', (_e, requestId: unknown) => {
  const reqId = z.string().min(1).parse(requestId)
  aiStopRequest(reqId)
  return { ok: true as const }
})

handleIpc('ai:newSession', () => {
  // HIGH (codex wave 3): clear the global pending-action registry on
  // session boundary. Otherwise an unconfirmed preview from chat session N
  // leaks into session N+1 — the next prompt build sees a stale
  // `confirmation_token` + "USER CONFIRMED" hint via
  // describePendingPreviews(), letting the AI in a fresh session act on a
  // request the user issued in a different conversation. clearPendingPreviews()
  // also resets the register-side rate limiter, which is the right behavior
  // when the user explicitly starts over.
  //
  // HIGH (codex wave 5): the renderer fires `ai:newSession` and a
  // possibly-still-running ai:chat stream is fire-and-forget on both sides.
  // Without aborting first, a tool_use_end event already in flight on the
  // main side could call registerPendingAction() AFTER clearPendingPreviews()
  // returns — re-populating the cleared registry with a preview the user
  // never sees, owned by the abandoned session. stopAll() aborts every
  // active LLM AbortController synchronously, so by the time
  // clearPendingPreviews() runs there is no longer an active stream that
  // could race a new register past the clear. There is a microscopic
  // residual race (one event-loop tick between abort() being called and
  // the SDK noticing the signal) — defence-in-depth via a per-session
  // generation counter is tracked as a follow-up but not added here to
  // keep the blast radius minimal for the §3.10 P0 closure wave.
  aiStopAll()
  clearPendingPreviews()
  return { ok: true as const }
})

handleIpc('ai:quickAction', async (_e, requestId: unknown, action: unknown, context?: unknown) => {
  const reqId = z.string().min(1).parse(requestId)
  const act = z.string().min(1).parse(action)
  const ctx = context ? (context as EmailContext) : undefined

  // Quick action — a regular ai:chat with a preset prompt
  logAI.info(`ai:quickAction requestId=${reqId} action="${act.slice(0, 80)}"`)
  ;(async () => {
    let eventCount = 0
    try {
      for await (const event of aiChat({ requestId: reqId, prompt: act, context: ctx })) {
        eventCount++
        if (win && !win.isDestroyed()) win.webContents.send('ai:stream', event)
      }
      logAI.info(`ai:quickAction done requestId=${reqId} totalEvents=${eventCount}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logAI.error(`ai:quickAction error requestId=${reqId}: ${message}`)
      if (win && !win.isDestroyed()) win.webContents.send('ai:stream', { type: 'error', requestId: reqId, message } satisfies AiStreamEvent)
    }
  })()

  return { ok: true as const }
})

handleIpc('ai:setContext', (_e, context: unknown) => {
  setUiContext(context ? (context as EmailContext) : null)
  return { ok: true as const }
})

// §3.10 P0: renderer-driven user-confirmation gate. Issuing a confirmation
// token is the structural barrier between AI proposing a mutation and the
// underlying callback firing. Without a token returned from this handler,
// no apply_* MCP tool can mutate state.
handleIpc('ai:action:apply', async (_e, previewIdRaw: unknown) => {
  const previewId = z.string().min(1).max(200).parse(previewIdRaw)
  const { consumePendingAction, summarizePending } = await import('./services/aiPendingActions')
  const result = consumePendingAction(previewId)
  if (!result) {
    return {
      ok: false as const,
      reason: 'preview_not_found_or_already_consumed' as const,
    }
  }
  return {
    ok: true as const,
    confirmationToken: result.confirmationToken,
    summary: summarizePending(result.entry),
  }
})

handleIpc('ai:action:cancel', async (_e, previewIdRaw: unknown) => {
  const previewId = z.string().min(1).max(200).parse(previewIdRaw)
  const { cancelPendingAction } = await import('./services/aiPendingActions')
  const ok = cancelPendingAction(previewId)
  return ok ? { ok: true as const } : { ok: false as const, reason: 'not_found' as const }
})

handleIpc('ai:action:list', async () => {
  const { listPendingActions, summarizePending } = await import('./services/aiPendingActions')
  const entries = listPendingActions()
  return entries.map(e => ({
    ...summarizePending(e),
    confirmed: Boolean(e.confirmationToken),
  }))
})

// §3.10 P2: renderer-driven approve/deny for internet-tool consent prompts.
// The renderer receives `ai:internet-tool-pending` events with a
// `requestId`, surfaces inline confirm UI, and calls one of these two
// handlers with the same `requestId`. Main resolves the matching pending
// promise inside the AI request's `interceptInternetTool` call and the
// tool either dispatches normally or returns the denial payload.
//
// Both handlers validate the requestId shape (uuid-like, max 200 chars)
// before passing it to the gate. A bad id resolves nothing and the IPC
// returns `{ ok: false, reason: 'not_found' }` — this happens naturally
// for stale requests (user clicks Approve after the 30s timeout already
// auto-denied) and is not a security event.
handleIpc('ai:internet-tool-approve', (_e, requestIdRaw: unknown) => {
  const requestId = z.string().min(1).max(200).parse(requestIdRaw)
  const ok = resolveInternetConsent(requestId, 'approved')
  return ok ? { ok: true as const } : { ok: false as const, reason: 'not_found' as const }
})

handleIpc('ai:internet-tool-deny', (_e, requestIdRaw: unknown) => {
  const requestId = z.string().min(1).max(200).parse(requestIdRaw)
  const ok = resolveInternetConsent(requestId, 'denied')
  return ok ? { ok: true as const } : { ok: false as const, reason: 'not_found' as const }
})

handleIpc('ai:checkAuth', async (_e, providerOverride?: unknown, settingsOverrides?: unknown) => {
  const parsedProvider = z.enum(['subscription', 'anthropic-api', 'openai-api', 'gemini-api']).optional().parse(
    typeof providerOverride === 'string' ? providerOverride : undefined
  ) as AiProvider | undefined

  // Optional settings overrides (proxy, aiOpenAiBaseUrl) not yet saved
  const overrides = z.object({
    aiProxyUrl: z.string().trim().optional(),
    aiOpenAiBaseUrl: z.string().trim().optional(),
  }).optional().parse(typeof settingsOverrides === 'object' && settingsOverrides ? settingsOverrides : undefined)

  if (IS_E2E) {
    const settings = getSettings()
    const provider = parsedProvider || settings.aiProvider
    if (!provider) return { status: 'not_configured' as const }
    return { status: 'authenticated' as const, email: 'e2e@mock.local' }
  }

  const settings = { ...getSettings(), ...overrides }
  // If renderer passes a provider — use it (saves from race condition during save)
  if (parsedProvider) {
    return aiCheckAuth({ ...settings, aiProvider: parsedProvider })
  }
  return aiCheckAuth(settings)
})

handleIpc('ai:openProviderSetup', () => {
  // Open settings window on the AI tab
  openSettingsWindow()
  return { ok: true as const }
})

handleIpc('ai:saveApiKey', async (_e, key: unknown, provider?: unknown) => {
  const k = z.string().min(1).parse(key)
  const p = z.enum(['anthropic-api', 'openai-api', 'gemini-api']).optional().parse(
    typeof provider === 'string' ? provider : undefined
  ) as ApiKeyProvider | undefined
  await aiSaveApiKey(k, p)
  return { ok: true as const }
})

handleIpc('ai:deleteApiKey', async (_e, provider?: unknown) => {
  const p = z.enum(['anthropic-api', 'openai-api', 'gemini-api']).optional().parse(
    typeof provider === 'string' ? provider : undefined
  ) as ApiKeyProvider | undefined
  await aiDeleteApiKey(p)
  return { ok: true as const }
})

handleIpc('ai:memoryRead', async () => {
  const { readMemory } = await import('./services/ai')
  return { content: readMemory() }
})

handleIpc('ai:memoryWrite', async (_e, content: unknown) => {
  const text = z.string().max(4000).parse(content)
  const { writeMemory } = await import('./services/ai')
  writeMemory(text)
  return { ok: true }
})

// --- IPC: §3.3 B2 Thread AI Summary ------------------------------------------
//
// One renderer-facing channel backing the thread-summary strip in the reading
// pane:
//   ai:threadSummary:generate — cache-or-generate; honours the per-account
//                               opt-in gate, budget cap (structured refusal),
//                               and wraps every body in wrapUntrusted().
//
// (The former cache-only `ai:threadSummary:get` channel was removed: the
// renderer never used it and it was unauthenticated by account — a dead,
// cross-account-readable surface. The generate handler is cache-first anyway,
// so a separate cache-only read is redundant.)
//
// The generator itself lives in services/aiThreadSummary.ts (ai.ts is a
// hotspot — CLAUDE.md §5). Main only: (1) validates the payload, (2) enforces
// the per-account opt-in, (3) fetches canonical bodies from the local SQLite
// cache (never trusting renderer-supplied body text OR a renderer-supplied
// identity/hash), (4) selects the provider (local-preferred hook) and assembles
// the injected deps, (5) records the span, (6) wires the §2.51 atomic budget
// admission (reserve before the call, settle/release after) into the ledger.

const logAiSummary = createLogger('AiThreadSummary')

/** Max message refs accepted in one summary request — bounds prompt/token cost
 *  and DoS surface. A thread larger than this is capped to the newest refs. */
const AI_SUMMARY_MAX_MESSAGES = 50

// A message ref the renderer supplies. Only (folder, uid) are read — the
// identity token, body, and thread hash are ALL derived from trusted, DB-sourced
// data. A renderer-supplied `messageId` is intentionally NOT in the schema: zod
// strips unknown keys, so even if the renderer still sends one it is dropped here
// and never influences the identity/hash (cross-thread cache-poisoning defense,
// CLAUDE.md §5). The identity token comes from the DB row's Message-ID or a
// synthetic `account:folder:uid` fallback — never from the renderer.
const threadSummaryMessageRefSchema = z.object({
  folder: z.string().min(1).max(1024),
  uid: z.number().int().positive(),
})

const threadSummaryGenerateSchema = z.object({
  accountId: accountIdSchema,
  messages: z.array(threadSummaryMessageRefSchema).min(1).max(AI_SUMMARY_MAX_MESSAGES),
})

/** Whether the per-account Thread AI Summary opt-in is ON for `accountId`.
 *  Default OFF (missing/false entry) per §3.3 B2. The Settings toggle writes
 *  the same `aiThreadSummaryEnabled[accountId]` key (renderer-writable). */
function isThreadSummaryEnabledForAccount(accountId: number): boolean {
  return getSettings().aiThreadSummaryEnabled?.[String(accountId)] === true
}

// §2.51.f2 fix-wave (High-3) — the local `threadSummaryReservationUsd` helper is
// gone: the summary reservation is now priced by `conservativeReservationUsd`
// INSIDE the shared `admitBudgetedCall`, which is the same model-aware
// `nullUsageReservationUsd` floor it computed here. One admission path means one
// place where the reserved amount is decided.

/** Assemble the injected dependency bundle for the extracted generator. Mirrors
 *  buildAiRulesDeps: every collaborator is a real main-process function; the
 *  generator never reaches into main.ts state directly. `provider` is the
 *  ALREADY-SELECTED summary provider, so the budget reservation is attributed to
 *  exactly the provider that will run the call. */
function buildThreadSummaryDeps(accountId: string, provider: string): ThreadSummaryDeps {
  // §2.51.f2 iteration 7 (High-3) — ONE settings snapshot for the whole
  // generation, taken BEFORE admission and used through to settlement.
  //
  // The three stages used to read settings independently: admission called
  // `getSettings()`, the provider helper re-read them because no snapshot was
  // passed, and the cost estimator called `getSettings()` again AFTER the answer
  // came back. A user toggling the base URL mid-request could therefore have a
  // PAID call settled at 0 (remote → local between admit and settle), or a local
  // one charged a fabricated floor (local → remote). Same class as the pricing
  // snapshot fixed on the title path: price, execute and settle must all describe
  // the same endpoint.
  //
  // The locality verdict is resolved once here and frozen for the same reason —
  // it decides money, so it must not be recomputed against a newer snapshot.
  const settings = getSettings()
  const allowFabrication = !isLocalInferenceEndpoint(provider, settings)
  return {
    allowFabrication,
    // Account-scoped cache read: (accountId, threadHash) — never returns another
    // account's row even on a colliding hash (CLAUDE.md §5).
    getCached: (acct, hash) => getThreadSummary(acct, hash),
    upsert: (row) => upsertThreadSummary(row),
    // Pin the completion to the SELECTED provider so the provider recorded as
    // used is the one that actually ran (no independent settings re-read).
    //
    // §2.51.f2 — the UN-COLLAPSED billing verdict (`aiChatSimpleOutcome`), not
    // `aiChatSimple`'s lossy `null`: the generator holds a budget reservation
    // across this call and may only release it when nothing was PROVABLY
    // billed. `null` would merge that with an ambiguous post-dispatch transport
    // failure, which the provider may already have generated and charged for.
    //
    // The PINNED snapshot goes with it (§2.51.f2 iteration 7): without it the
    // helper re-reads `getSettings()`, so the request could run against a
    // different base URL and model than the one admission priced and the one the
    // locality verdict above describes.
    chat: (provider, systemPrompt, userPrompt) =>
      aiChatSimpleOutcome(systemPrompt, userPrompt, provider as AiProvider, { settings }),
    // §2.51 — ATOMIC, FAIL-CLOSED budget admission. The projected cap check and
    // the reservation insert run inside ONE `BEGIN IMMEDIATE` transaction, so
    // concurrent summaries (or a summary racing a chat / quick action / instant
    // reply) can no longer all read an under-cap total and all spend. Only the
    // generator's paid path reaches here: subscription is refused upstream, so
    // no reservation is ever booked for a provider that reports no cost.
    //
    // The reservation is attributed to `accountId` — the String(numericAccountId)
    // form the handler already normalised, the same scoping deleteAccountData
    // binds on cleanup (matches the mail_rules/ai_rules TEXT-account precedent).
    // It lands in the SAME hidden cost-ledger session the daily/monthly sum
    // reads, so summary spend survives chat-clear and counts against the cap.
    // §2.51.f2 fix-wave (High-3) — admitted through the SHARED `admitBudgetedCall`
    // instead of calling `admitAiReservation` directly. The direct call skipped
    // that helper's `flushPendingSettlements()` guard, so after a summary settle
    // failed while UNDER-counting the cap, the next summary was still admitted
    // against a ledger already known to understate spend — while every other paid
    // surface was denied. Unifying the settle path without unifying the admission
    // path only closed half the hole.
    //
    // The helper reserves the identical amount (`conservativeReservationUsd`, the
    // same `nullUsageReservationUsd` floor this path used) against the identical
    // `budgetWindows(settings)` math, so the enforced cap is unchanged — only the
    // pre-flight ledger-trust check is added.
    //
    // Denial mapping: the generator's dep contract wants `{ ok:false, reason }`
    // for an ordinary refusal and treats a THROW as a fail-closed deny. The shared
    // helper never throws — it collapses over-cap and broken-meter into
    // `{ ok:false }` and reports the meter failure to Sentry itself (source
    // `ai.budget.reserve`, replacing this path's own `ai.threadSummary.budget.reserve`
    // tag). Both still surface to the user as the structured `budget` refusal.
    admitBudget: () => {
      const admission = admitBudgetedCall(settings, accountId, provider, settings.aiModel || '')
      if (admission.ok) return admission
      return { ok: false as const, reason: 'over-cap' as const }
    },
    // Settle the hold with the ACTUAL cost — an in-place replace, so the ledger
    // carries exactly ONE net charge per generation (no double count).
    //
    // §2.51.f2 fix-wave (High-3) — routed through the SHARED `settleReservationUsd`
    // rather than calling `reconcileAiReservation` directly. The direct call had no
    // failure discipline: the generator swallowed the throw and left the floor
    // standing, so a settle whose ACTUAL exceeded that floor understated the ledger
    // permanently, with no retry and nothing blocking the next admission — fail-OPEN
    // on the one surface that did not use the shared helper. The helper retries an
    // under-counting failure on the next admission and denies admissions until it
    // clears, which is what the chat / quick-action / instant-reply paths already do.
    settleBudget: (reservation: AiCostReservation, actualUsd: number) => {
      settleReservationUsd(reservation, actualUsd)
    },
    // No billable completion → reconcile to 0 so the conservative hold is freed.
    // Same shared-helper reasoning; a release can only ever over-count on failure,
    // so this one is about having a single release path, not about retry.
    releaseBudget: (reservation: AiCostReservation) => {
      releaseReservationNoSpend(reservation)
    },
    // Price a paid completion from real usage via the SINGLE core pricing table;
    // when usage is unknown, fall back to the conservative model-aware
    // reservation rather than 0 so an unpriceable-by-usage paid call still counts.
    estimateCost: (model, usage) => {
      const priced = estimateAiRuleCostUsd(model, usage)
      if (typeof priced === 'number' && Number.isFinite(priced) && priced > 0) return priced
      // §2.51.f2 iteration 6 — an unpriceable completion against SELF-HOSTED
      // inference costs nothing: there is no provider to bill, so returning 0
      // (the generator's "provably free" value) settles the hold to zero instead
      // of inventing a floor. Every other paid surface already behaves this way;
      // this was the last one still charging local models. The signal is the
      // ENDPOINT ADDRESS, never "this server did not report usage" — a paid cloud
      // API that omits usage still gets the conservative floor below.
      //
      // Iteration 7 (High-3): read from the FROZEN verdict, not a fresh
      // `getSettings()`. Re-reading here meant a base-URL change mid-request could
      // settle a paid call at 0.
      if (!allowFabrication) return 0
      // No usable per-usage price → conservative model-aware reservation.
      const reserved = nullUsageReservationUsd(model)
      return Number.isFinite(reserved) && reserved > 0 ? reserved : undefined
    },
    appendAudit: (entry) => { appendAiActionLog(entry) },
    recordSpan: (attrs) => {
      // Fire-and-forget span; wrapped so a broken sink never blocks generation.
      try {
        const span = startMetricSpan('ai.thread_summary.generate', {
          provider: (['subscription', 'anthropic-api', 'openai-api', 'gemini-api', 'local'] as const)
            .includes(attrs.provider as never) ? attrs.provider : 'unknown',
          was_local: attrs.wasLocal,
          tokens_in: attrs.tokensIn ?? 0,
          tokens_out: attrs.tokensOut ?? 0,
          latency_ms: attrs.latencyMs,
          error_class: attrs.errorClass,
        })
        span.end()
      } catch { /* telemetry must never break generation */ }
    },
    now: () => Date.now(),
    log: {
      info: (msg) => logAiSummary.info(msg),
      warn: (msg) => logAiSummary.warn(msg),
      error: (msg, err) => logAiSummary.error(msg, err),
    },
  }
}

// Per-account single-flight for `ai:threadSummary:generate`. NOT a
// dedup/coalesce: distinct summary requests carry distinct message sets →
// distinct thread hashes → distinct cache misses, so they must each run their
// OWN provider call and cannot share a promise. Instead we SERIALIZE per
// account: at most one generation is in flight per account, and a concurrent
// second request for the same account waits for the in-flight one to settle
// before it runs its own admission + provider call.
//
// BUDGET-CAP note (§2.51): the check-then-act TOCTOU this wrapper used to
// compensate for is GONE. The cap is now enforced by an ATOMIC admission —
// `admitBudget` (→ `admitAiReservation`) does the projected cap check AND books
// the reservation inside one `BEGIN IMMEDIATE` transaction BEFORE the provider
// call, and a meter failure DENIES (fail-closed) instead of passing through
// unmetered. That is the same contract the other three paid surfaces use
// (`admitBudgetedCall` / `settleReservation` / `releaseReservationNoSpend` in
// electron/services/ai.ts). What the cap deliberately does NOT bound is the
// settled cost of ALREADY-ADMITTED in-flight calls (the reservation is a
// conservative FLOOR), so the residual exposure is the bounded N-call overshoot
// documented in the §2.51 HARD-CAP SEMANTICS block in ai.ts — not a bypass.
// Single-flight now serves latency/duplicate-work containment and cuts this
// surface's contribution to that N to ~1 per account. Keyed PER ACCOUNT so
// unrelated accounts are never blocked by each other.
const threadSummaryInFlight = new Map<number, Promise<unknown>>()

handleIpc('ai:threadSummary:generate', async (_e, payload: unknown): Promise<ThreadSummaryResult> => {
  const req: ThreadSummaryGenerateRequest = threadSummaryGenerateSchema.parse(payload)

  // Chain this request after any in-flight generation for the SAME account so
  // at most one runs at a time. We settle the predecessor with `.catch()` BEFORE
  // chaining so a failure in one request cannot reject/poison the chain for the
  // next — every waiter runs its own body regardless of the predecessor outcome.
  const accountId = req.accountId
  const predecessor = threadSummaryInFlight.get(accountId)
  const gated = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve())
    .then(() => runThreadSummaryGenerate(req))

  threadSummaryInFlight.set(accountId, gated)
  // Clean up only if the map still points at THIS run — a newer request may have
  // already chained itself as the tail; deleting then would drop a live entry.
  gated
    .catch(() => undefined)
    .finally(() => {
      if (threadSummaryInFlight.get(accountId) === gated) {
        threadSummaryInFlight.delete(accountId)
      }
    })
    .catch(() => { /* swallow — the real result/rejection propagates via `gated` */ })

  return gated
})

/** The `ai:threadSummary:generate` handler body, wrapped by the per-account
 *  single-flight above. Logic is unchanged from the pre-hardening handler —
 *  only the serialization wrapper was added around it. */
async function runThreadSummaryGenerate(
  req: ThreadSummaryGenerateRequest,
): Promise<ThreadSummaryResult> {
  // Per-account opt-in gate — refuse without generating when OFF (§3.3 B2).
  if (!isThreadSummaryEnabledForAccount(req.accountId)) {
    return { ok: false, reason: 'opt_out' }
  }

  // TEXT account id used for BOTH the cache scope AND the budget reservation,
  // matching the String(id) form deleteAccountData binds — so per-account cache
  // scoping and deletion cleanup line up (mail_rules/ai_rules TEXT-account
  // precedent).
  const acctId = String(req.accountId)

  // Fetch canonical bodies from the local cache. The renderer supplies only
  // (folder, uid) refs — never body text, and never an identity/hash — so the
  // untrusted-boundary wrap AND the thread-identity hash are computed only from
  // trusted, cache-sourced data. The identity token is the DB row's Message-ID
  // or a synthetic account:folder:uid fallback; a renderer-supplied messageId is
  // never trusted (it is not even in the schema — zod strips it).
  const cap = req.messages.slice(-AI_SUMMARY_MAX_MESSAGES)
  const messages: ThreadSummaryMessage[] = []
  // Dedupe by RESOLVED identity so only DISTINCT messages count toward the MIN
  // gate. The renderer could repeat the same (folder, uid) ref three times; each
  // resolves the same DB row → the same identityToken. Without dedup the loop
  // would push three copies of ONE message and pass the ≥3 gate, even though
  // computeThreadHash later collapses the identity SET back to one — so a single
  // real message would masquerade as a 3-message thread. Deduping here (before
  // the MIN check) makes a thread of one message repeated correctly refuse
  // too_short. The identityToken is DB-derived (Message-ID or synthetic
  // account:folder:uid), so distinctness is on trusted identity, not on the
  // renderer-supplied ref shape.
  const seenIdentities = new Set<string>()
  for (const ref of cap) {
    const row = getMessageByUid(req.accountId, ref.folder, ref.uid)
    if (!row) continue
    // Skip refs whose body is not loaded (partial / offline cache). A
    // headers-only message contributes nothing to summarize; letting empty
    // bodies pass the ≥3 gate would build — and permanently CACHE — a summary
    // from no content. The generator applies the same filter defensively.
    const body = typeof row.bodyText === 'string' ? row.bodyText : ''
    if (body.trim().length === 0) continue
    const identityToken =
      (typeof row.messageId === 'string' && row.messageId.trim().length > 0)
        ? row.messageId.trim()
        // Synthetic, non-content stable key when no Message-ID is available.
        : `${req.accountId}:${ref.folder}:${ref.uid}`
    // Distinct-message gate: a repeated identity (same Message-ID or same
    // synthetic key) is counted once. This is the same identity set
    // computeThreadHash keys on, so the MIN check now measures the SAME notion
    // of "distinct message" the hash does.
    if (seenIdentities.has(identityToken)) continue
    seenIdentities.add(identityToken)
    messages.push({
      identityToken,
      from: row.from ?? '',
      subject: row.subject ?? '',
      date: row.date ?? '',
      body,
    })
  }

  // Require MIN_SUMMARY_MESSAGES DISTINCT messages WITH real content (empty-body
  // and duplicate-identity refs were already dropped above). Never generate/cache
  // a summary from headers-only or from one message masquerading as many.
  if (messages.length < MIN_SUMMARY_MESSAGES) {
    return { ok: false, reason: 'too_short' }
  }

  // Local-preferred provider selection (T2.5 Ollama unshipped → remote).
  const { provider, wasLocal } = selectSummaryProvider(getSettings())

  // The deps bundle is built with the SELECTED provider so the budget
  // reservation is attributed to the provider that actually runs the call.
  const outcome = await generateThreadSummary(buildThreadSummaryDeps(acctId, provider ?? ''), {
    accountId: acctId,
    provider: provider ?? '',
    wasLocal,
    messages,
  })
  return outcome
}

// --- IPC: §3.3 B4 Compose Quick Actions + Instant Reply ----------------------
//
// Two renderer-facing channels backing the Compose toolbar rewrite presets and
// the reading-pane instant-reply strip:
//   ai:quickAction:rewrite   — rewrite the RAW draft text under one of four
//                              presets (improve/shorter/formal/grammar).
//   ai:instantReply:generate — generate 2–3 reply-draft options for one email,
//                              identified ONLY by a cache-derived (accountId,
//                              folder, uid) ref.
//
// These handlers are intentionally THIN (CLAUDE.md §5 hotspot policy): main only
// (1) validates the payload with zod and (2) forwards to the extracted generator
// in services/ai.ts, returning its discriminated-union result VERBATIM. All
// budget/audit/span/single-flight/wrapUntrusted logic lives inside the generator
// — main re-implements none of it.

// `quickActionRewriteSchema` and `instantReplyGenerateSchema` are defined in
// `electron/ipcSchemas.ts` (imported above) so the exact schemas registered
// here are unit-testable without importing the Electron module graph. See that
// module for the per-field rationale (raw-draft `text`, cache-poisoning
// `messageId` strip). The runtime contract is unchanged from the former inline
// definitions.

handleIpc('ai:quickAction:rewrite', async (_e, payload: unknown): Promise<QuickActionRewriteResult> => {
  const req = quickActionRewriteSchema.parse(payload)
  // Forward verbatim — the generator owns the empty-input / no-provider / budget
  // / provider-error refusal set and returns the same discriminated union the
  // renderer branches on.
  return generateQuickActionRewrite(req)
})

handleIpc('ai:instantReply:generate', async (_e, payload: unknown): Promise<InstantReplyDraftsResult> => {
  // Parse strips the renderer's `messageId` (not in the shape). Only the
  // cache-derived (accountId, folder, uid) triple reaches the generator, which
  // also enforces the per-account aiInstantReplyEnabled opt-in (fail-closed OFF).
  const req = instantReplyGenerateSchema.parse(payload)
  return generateInstantReplyDrafts(req)
})

// --- IPC: §3.3 B1 Privacy Audit Panel ----------------------------------------
//
// Five renderer-facing channels backing the AiPrivacyPanel in Settings → AI:
//   ai:auditLog:list       — paginated reverse-chronological list view
//   ai:auditLog:aggregate  — per-provider aggregate for the period header
//   ai:auditLog:softDelete — soft-delete a single row (no user-facing hard-delete)
//   ai:auditLog:export     — return JSON or CSV string + writeOut to disk
//   ai:auditLog:clear      — soft-delete every live row
// The audit log has no user-facing hard-delete path; background row-count
// rotation (cap: AI_ACTION_LOG_MAX_ROWS = 10,000) in `packages/db/index.ts`
// removes the oldest physical rows once the cap is reached. Main only
// translates IPC payloads to those calls and wraps the export handler with
// the standard dialog.showSaveDialog flow.

const aiAuditListSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  provider: z.string().min(1).max(64).optional(),
  from: z.string().min(1).max(64).optional(),
  to: z.string().min(1).max(64).optional(),
}).optional()

handleIpc('ai:auditLog:list', (_e, opts: unknown) => {
  const parsed = aiAuditListSchema.parse(opts) ?? {}
  return listAiActionLog(parsed)
})

const aiAuditAggregateSchema = z.object({
  period: z.enum(['today', 'week', 'month']),
})

handleIpc('ai:auditLog:aggregate', (_e, opts: unknown) => {
  const parsed = aiAuditAggregateSchema.parse(opts)
  return aggregateAiUsage(parsed.period)
})

const aiAuditSoftDeleteSchema = z.object({
  id: z.number().int().positive(),
})

handleIpc('ai:auditLog:softDelete', (_e, opts: unknown) => {
  const parsed = aiAuditSoftDeleteSchema.parse(opts)
  const ok = softDeleteAiActionEntry(parsed.id)
  try {
    recordEvent('ai.audit.entry_deleted', { scope: 'single' })
  } catch { /* telemetry must never break user-visible behaviour */ }
  return { deleted: ok }
})

handleIpc('ai:auditLog:clear', async (e) => {
  // §3.3.B1.f1 — Trusted-confirmation gate. The audit log is the only
  // forensic record of AI actions; erasing it must require a confirmation
  // the renderer cannot forge. A renderer-only window.confirm guard would
  // be bypassable from a compromised renderer (XSS via email content,
  // prompt injection, rogue MCP tool). Gate the destructive call behind
  // a native dialog.showMessageBox so the decision lives in main.
  if (!IS_E2E) {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const result = parent
      ? await dialog.showMessageBox(parent, {
          type: 'warning',
          title: 'Clear AI audit log',
          message: 'Delete all AI audit log entries?',
          detail:
            'This soft-deletes every entry from the audit log view. ' +
            'Underlying records remain in the local database until ' +
            'automatic rotation removes the oldest (default cap: 10,000 ' +
            'entries). Export the audit log first if you need long-term ' +
            'retention. This action cannot be undone from the UI.',
          buttons: ['Cancel', 'Delete All'],
          defaultId: 0,
          cancelId: 0,
        })
      : await dialog.showMessageBox({
          type: 'warning',
          title: 'Clear AI audit log',
          message: 'Delete all AI audit log entries?',
          detail:
            'This soft-deletes every entry from the audit log view. ' +
            'Underlying records remain in the local database until ' +
            'automatic rotation removes the oldest (default cap: 10,000 ' +
            'entries). Export the audit log first if you need long-term ' +
            'retention. This action cannot be undone from the UI.',
          buttons: ['Cancel', 'Delete All'],
          defaultId: 0,
          cancelId: 0,
        })
    if (result.response !== 1) {
      return { ok: false as const, cancelled: true as const, deleted: 0 }
    }
  }
  const deleted = clearAiActionLog()
  try {
    recordEvent('ai.audit.entry_deleted', { scope: 'all' })
  } catch { /* telemetry must never break user-visible behaviour */ }
  return { ok: true as const, deleted }
})

const aiAuditExportSchema = z.object({
  format: z.enum(['json', 'csv']),
})

handleIpc('ai:auditLog:export', async (e, opts: unknown) => {
  const parsed = aiAuditExportSchema.parse(opts)
  const payload = exportAiActionLog(parsed.format)
  try {
    recordEvent('ai.audit.export_requested', { format: parsed.format })
  } catch { /* telemetry must never break user-visible behaviour */ }
  // In e2e short-circuit so the harness never has to drive a native dialog.
  if (IS_E2E) {
    return { ok: true as const, path: `/tmp/e2e-ai-audit.${parsed.format}`, payload }
  }
  const suggested = `mailcopilot-ai-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.${parsed.format}`
  const parent = BrowserWindow.fromWebContents(e.sender)
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, { defaultPath: suggested })
    : await dialog.showSaveDialog({ defaultPath: suggested })
  if (canceled || !filePath) {
    return { ok: false as const, cancelled: true as const, payload }
  }
  try {
    fs.writeFileSync(filePath, payload, 'utf8')
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err), payload }
  }
  return { ok: true as const, path: filePath, payload }
})

// --- IPC: AI Chat Sessions ---

const aiSessionIdSchema = z.string().min(1)

handleIpc('aiSession:create', (_e, data: unknown) => {
  const parsed = z.object({ id: z.string().min(1), provider: z.string().min(1) }).parse(data)
  return createAiSession(parsed.id, parsed.provider)
})

handleIpc('aiSession:list', () => {
  return listAiSessions()
})

handleIpc('aiSession:get', (_e, id: unknown) => {
  const sid = aiSessionIdSchema.parse(id)
  return getAiSession(sid) ?? null
})

handleIpc('aiSession:updateTitle', (_e, id: unknown, title: unknown) => {
  const sid = aiSessionIdSchema.parse(id)
  const t = z.string().max(200).parse(title)
  updateAiSessionTitle(sid, t)
  return { ok: true }
})

handleIpc('aiSession:delete', (_e, id: unknown) => {
  const sid = aiSessionIdSchema.parse(id)
  return { deleted: deleteAiSession(sid) }
})

handleIpc('aiSession:deleteAll', () => {
  return { deleted: deleteAllAiSessions() }
})

handleIpc('aiSession:messages', (_e, id: unknown) => {
  const sid = aiSessionIdSchema.parse(id)
  return listAiMessages(sid)
})

handleIpc('aiSession:addMessage', (_e, data: unknown) => {
  const parsed = z.object({
    sessionId: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    costUsd: z.number().optional(),
  }).parse(data)
  return insertAiMessage(parsed.sessionId, parsed.role, parsed.content, parsed.costUsd)
})

handleIpc('aiSession:generateTitle', async (_e, sessionId: unknown, userMsg: unknown, assistantMsg: unknown) => {
  const sid = aiSessionIdSchema.parse(sessionId)
  const user = z.string().min(1).max(2000).parse(userMsg)
  const assistant = z.string().min(1).parse(assistantMsg)
  const title = await generateSessionTitle(user, assistant, getSettings())
  if (title) updateAiSessionTitle(sid, title)
  return { title }
})

// --- Offline: background message body sync ---

let offlineSyncing = false

/**
 * §2.15-ter (codex iteration 4): valid offline modes that participate in
 * background body sync. Anything else (including legacy `null` or unknown
 * strings written before the current migration) defaults to off-equivalent.
 */
const OFFLINE_SYNC_MODES = new Set(['period', 'full'] as const)
type OfflineSyncMode = 'period' | 'full'

/**
 * Resolves the list of offline-enabled folders for an account based on folder preferences.
 *
 * §2.15-ter (codex iteration 4): explicit allowlist of `period` and `full`
 * — previously any value !== 'off' (NULL, empty string, unknown future
 * mode) was treated as offline-enabled and triggered a full sync. The
 * stricter check matches the column's enum and is fail-closed: corrupt
 * or migration-skewed rows now default to no-offline-sync, which is
 * always safe (the user just doesn't get bodies cached for that folder).
 */
function resolveOfflineFolders(accountId: number): Array<{ folderPath: string; offlineMode: OfflineSyncMode; offlineDays?: number }> {
  return listFolderPrefs(accountId)
    .filter((p): p is typeof p & { offlineMode: OfflineSyncMode } =>
      OFFLINE_SYNC_MODES.has(p.offlineMode as OfflineSyncMode))
    .map(p => ({ folderPath: p.folderPath, offlineMode: p.offlineMode, offlineDays: p.offlineDays ?? undefined }))
}

/** Background download of message bodies (EML) for offline access — parallel per account */
async function syncOfflineBodies() {
  if (shuttingDown) return
  if (offlineSyncing || IS_E2E || getSettings().workOffline || isHeaderSyncActive()) return
  offlineSyncing = true
  logSync.info('Offline sync started')

  try {
    const settings = getSettings()
    const maxSizeBytes = (settings.offlineMaxSizeKB ?? 0) * 1024
    const maxTotalBytes = (settings.offlineMaxTotalMB ?? 0) * 1024 * 1024
    // §2.15-ter (codex iteration 4): align offline body sync with the
    // global body retention cutoff used by pruneOldEmls. Without this,
    // `offlineMode=full` would re-download the same old bodies that
    // pruneOldEmls just deleted, creating a prune→download loop.
    const globalRetention = typeof settings.bodyRetentionDays === 'number'
      ? settings.bodyRetentionDays
      : DEFAULT_BODY_RETENTION_DAYS

    // Skip sync if total EML cache already exceeds the configured limit
    if (maxTotalBytes > 0 && emlCacheSizeBytes() >= maxTotalBytes) {
      logSync.info(`EML cache size (${emlCacheSizeBytes()} bytes) exceeds limit (${maxTotalBytes} bytes), skipping sync`)
      offlineSyncing = false
      return
    }

    const accounts = listAccounts()
    let totalDownloaded = 0

    // Parallel download per account via per-account IMAP pool
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        let cfg: AccountConfig
        try {
          const result = await requireAccountConfig(account.id)
          cfg = result.cfg
          assertImapAuth(account.id, cfg.imap)
        } catch (e) {
          logSync.debug(`Skipping account ${account.id}: ${e instanceof Error ? e.message : 'config error'}`)
          return // Skip account on configuration error
        }

        // Use per-folder offline preferences as the source of truth
        const offlineFolders = resolveOfflineFolders(account.id)
        for (const pref of offlineFolders) {

          const sinceDate = computeOfflineSinceDate(pref.offlineMode, pref.offlineDays, globalRetention)

          const uids = getUidsWithoutBody(account.id, pref.folderPath, 100, sinceDate, maxSizeBytes)
          if (uids.length === 0) continue

          logSync.info(`Downloading ${uids.length} EMLs for account ${account.id} ${pref.folderPath}`)

          for (const uid of uids) {
            // Check total cache size before each download
            if (maxTotalBytes > 0 && emlCacheSizeBytes() >= maxTotalBytes) {
              logSync.info(`EML cache limit reached during sync, stopping folder ${pref.folderPath}`)
              break
            }
            try {
              // Use main connection to avoid deadlocking per-account pool with header sync
              const raw = await downloadRawMessage(account.id, cfg.imap, pref.folderPath, uid)
              if (raw) {
                if (maxSizeBytes <= 0 || raw.length <= maxSizeBytes) {
                  saveEml(account.id, pref.folderPath, uid, raw)
                  setBodyDownloaded(account.id, pref.folderPath, uid, true, raw.length)
                  totalDownloaded++
                } else {
                  // Mark the size to avoid retry
                  setBodyDownloaded(account.id, pref.folderPath, uid, false, raw.length)
                  logSync.debug(`Skipped uid=${uid} (${raw.length} bytes > ${maxSizeBytes} limit)`)
                }
              }
            } catch (e) {
              logSync.warn(`Download error uid=${uid} from ${pref.folderPath} (account ${account.id}):`, e instanceof Error ? e.message : e)
              break // On network error — stop current folder
            }
          }

          const stats = countBodiesDownloaded(account.id, pref.folderPath)
          broadcast('offline:progress', { accountId: account.id, folder: pref.folderPath, ...stats })
        }
      })
    )

    // Log errors for individual accounts
    for (const r of results) {
      if (r.status === 'rejected') {
        logSync.warn('Account sync error:', r.reason instanceof Error ? r.reason.message : r.reason)
      }
    }

    logSync.info(`Offline sync complete: ${totalDownloaded} EMLs downloaded`)

    // Close per-account connections after completion
    await disconnectAllPerAccount()
  } catch (e) {
    logSync.warn('Sync error:', e instanceof Error ? e.message : e)
  } finally {
    offlineSyncing = false
  }
}

/**
 * Deletes local EMLs older than the configured retention threshold.
 *
 * §2.15-ter — two-tier retention:
 *   - `offlineMode='period'`: per-folder `offlineDays` decides the cutoff
 *     (per-folder takes priority — that's the explicit user intent).
 *   - `offlineMode='full'`: global `bodyRetentionDays` from Settings applies
 *     unless it's -1 (forever), in which case nothing is pruned.
 *   - `offlineMode='off'`: never gets here; bodies were never downloaded.
 */
function pruneOldEmls() {
  // pruneOldEmls touches messages.body_downloaded via setBodyDownloaded(),
  // so it IS a DB writer despite the name suggesting "just EML files".
  // Guard on shutdown so it cannot commit after WAL checkpoint.
  if (shuttingDown) return
  try {
    const accounts = IS_E2E ? [] : listAccounts()
    const settings = getSettings()
    const globalRetention = typeof settings.bodyRetentionDays === 'number'
      ? settings.bodyRetentionDays
      : DEFAULT_BODY_RETENTION_DAYS
    let totalPruned = 0
    let totalFreedBytes = 0

    for (const account of accounts) {
      const prefs = listFolderPrefs(account.id)
      for (const pref of prefs) {
        let cutoffDays: number
        if (pref.offlineMode === 'period') {
          cutoffDays = pref.offlineDays ?? 30
        } else if (pref.offlineMode === 'full') {
          // -1 = forever; skip pruning entirely.
          if (globalRetention === -1) continue
          cutoffDays = globalRetention
        } else {
          // 'off' — bodies are not downloaded, nothing to prune.
          continue
        }
        if (cutoffDays <= 0) continue

        const cutoffDate = new Date(Date.now() - cutoffDays * 86400000).toISOString()
        const oldUids = getUidsOlderThan(account.id, pref.folderPath, cutoffDate)
        if (oldUids.length === 0) continue

        // Best-effort byte accounting before delete: sum message_size for the
        // UIDs we're about to drop. Failures fall through silently — the
        // metric value is informational, not authoritative.
        try {
          totalFreedBytes += sumMessageSizes(account.id, pref.folderPath, oldUids)
        } catch { /* informational */ }

        deleteEmls(account.id, pref.folderPath, oldUids)
        for (const uid of oldUids) {
          setBodyDownloaded(account.id, pref.folderPath, uid, false)
        }
        totalPruned += oldUids.length
      }
    }

    if (totalPruned > 0) {
      recordEvent('cache.eml_pruned', {
        count_bucket: bucketCount(totalPruned),
        freed_bytes_bucket: bucketFreedBytes(totalFreedBytes),
      })
    }
  } catch (e) {
    logSync.warn('Old EML cleanup error:', e instanceof Error ? e.message : e)
  }
}

// Start background sync every 5 minutes
const OFFLINE_SYNC_INTERVAL_MS = 2 * 60 * 1000
const SEND_QUEUE_POLL_INTERVAL_MS = 1_000
const SNOOZE_POLL_INTERVAL_MS = 60_000

// Handles for DB-writing background intervals. Stored at module scope so
// the before-quit handler can clearInterval() them before WAL checkpoint,
// preventing a tick from committing AFTER TRUNCATE and re-growing the WAL
// (Codex §2.15 wave-3 High). The shutdownDbWritingTimers() helper below
// centralises the teardown. `pruneOldEmls` (writes messages.body_downloaded)
// and FTS optimize (writes via `INSERT INTO messages_fts(messages_fts)
// VALUES('optimize')`) are also DB writers — wave-4 codex flagged both.
// They use `.unref()` and ad-hoc `if (shuttingDown) return` guards instead
// of being stored here, because their timers are optimize/prune semantics
// (safe to skip on exit) whereas the five intervals below must be cleared
// even if they fired just now.
let sendQueueTimer: ReturnType<typeof setInterval> | null = null
let snoozeTimer: ReturnType<typeof setInterval> | null = null
let followUpTimer: ReturnType<typeof setInterval> | null = null
let offlineSyncTimer: ReturnType<typeof setInterval> | null = null
let aiRuleTimer: ReturnType<typeof setInterval> | null = null
// §2.15-bis: periodic PASSIVE WAL checkpoint. Runs every 60s while the app
// is live so the WAL never grows unboundedly between session starts. PASSIVE
// is non-blocking for readers/writers — safe on a live timer. Cleared in
// shutdownDbWritingTimers() BEFORE the shutdown TRUNCATE so a tick cannot
// race with TRUNCATE and silently no-op it.
let walPassiveCheckpointTimer: ReturnType<typeof setInterval> | null = null

const WAL_PASSIVE_CHECKPOINT_INTERVAL_MS = 60_000

function shutdownDbWritingTimers() {
  for (const [name, handle] of [
    ['sendQueue', sendQueueTimer],
    ['snooze', snoozeTimer],
    ['followUp', followUpTimer],
    ['offlineSync', offlineSyncTimer],
    ['aiRule', aiRuleTimer],
    ['walPassiveCheckpoint', walPassiveCheckpointTimer],
  ] as const) {
    if (handle) {
      try { clearInterval(handle) } catch { /* ignore */ }
    }
    // Null out the captured handle so double-clear is a no-op.
    switch (name) {
      case 'sendQueue': sendQueueTimer = null; break
      case 'snooze': snoozeTimer = null; break
      case 'followUp': followUpTimer = null; break
      case 'offlineSync': offlineSyncTimer = null; break
      case 'aiRule': aiRuleTimer = null; break
      case 'walPassiveCheckpoint': walPassiveCheckpointTimer = null; break
    }
  }
}

app.whenReady().then(() => {
  // Process send queue almost immediately after startup.
  setTimeout(() => {
    void processSendQueue()
  }, 2_000)
  sendQueueTimer = setInterval(() => {
    void processSendQueue()
  }, SEND_QUEUE_POLL_INTERVAL_MS)

  // Snooze polling: check for due snoozes every 60 sec
  setTimeout(() => processSnoozed(), 5_000)
  snoozeTimer = setInterval(() => processSnoozed(), SNOOZE_POLL_INTERVAL_MS)

  // Follow-up polling: check for due follow-up reminders every 60 sec
  setTimeout(() => processFollowUps(), 7_000)
  followUpTimer = setInterval(() => processFollowUps(), FOLLOWUP_POLL_INTERVAL_MS)

  // First sync 30 sec after startup (don't block startup)
  setTimeout(() => {
    void syncOfflineBodies()
    pruneOldEmls()
  }, 30_000)

  offlineSyncTimer = setInterval(() => {
    void syncOfflineBodies()
  }, OFFLINE_SYNC_INTERVAL_MS)

  // Cleanup once a day
  setInterval(() => {
    pruneOldEmls()
  }, 24 * 60 * 60 * 1000)

  // AI Rules batch processing every 30 sec
  aiRuleTimer = setInterval(() => void processAiRuleBatch(), AI_RULE_BATCH_INTERVAL)

  // §2.15-bis: periodic PASSIVE WAL checkpoint. Drains committed-but-not-yet-
  // checkpointed pages from `.db-wal` into the main DB file every 60s without
  // blocking readers or writers. Protects against abrupt shutdown (SIGKILL,
  // OOM kill, OS crash, power loss) where `before-quit` never fires and the
  // shutdown TRUNCATE checkpoint is skipped. PASSIVE skips frames held by
  // active read snapshots, so observed `busy > 0` is normal during heavy
  // search/sync — log at debug only.
  walPassiveCheckpointTimer = setInterval(() => {
    if (shuttingDown) return
    const r = checkpointWalPassive()
    if (r.busy > 0 || r.checkpointed < r.log) {
      logShutdown.debug(
        `WAL checkpoint(PASSIVE): busy=${r.busy} checkpointed=${r.checkpointed}/${r.log}`
      )
    }
  }, WAL_PASSIVE_CHECKPOINT_INTERVAL_MS)
  // .unref() so this timer never keeps the Node event loop alive past
  // window-close. Defensive — `before-quit` already clears this handle in
  // shutdownDbWritingTimers(), but Codex §2.15-bis review iteration 2 Low #1
  // flagged the missing .unref() and the brief required it for consistency
  // with other defensive timers in this file (FTS optimize, EML prune).
  walPassiveCheckpointTimer.unref()

  // FTS5 segment merge: prevents bloat from accumulating one segment per upsert.
  // Runs once shortly after startup and then every 6 hours. Idempotent and fast
  // on tens of thousands of rows; only matters for cold-start search latency.
  if (!IS_E2E) {
    const runOptimize = () => {
      // FTS optimize issues `INSERT INTO messages_fts(messages_fts)
      // VALUES('optimize')` which writes SQLite state. Guard against
      // shutdown so it doesn't run after WAL checkpoint.
      if (shuttingDown) return
      try {
        const r = optimizeFts()
        if (r.ok) {
          const before = r.segmentsBefore != null ? r.segmentsBefore : '?'
          const after = r.segmentsAfter != null ? r.segmentsAfter : '?'
          logMain.info(`FTS optimize: ${before} → ${after} segments in ${r.durationMs}ms`)
          recordHistogram('fts.optimize.duration_ms', r.durationMs, {
            segments_before: r.segmentsBefore,
            segments_after: r.segmentsAfter,
            reduction: r.segmentsBefore != null && r.segmentsAfter != null
              ? r.segmentsBefore - r.segmentsAfter
              : undefined,
          })
        } else {
          recordEvent('fts.optimize.failed')
        }
      } catch (e) {
        logMain.warn(`FTS optimize failed: ${e instanceof Error ? e.message : String(e)}`)
        recordEvent('fts.optimize.failed', { reason: e instanceof Error ? e.name : 'unknown' })
      }
    }
    setTimeout(runOptimize, 30_000).unref()
    setInterval(runOptimize, 6 * 60 * 60 * 1000).unref()
  }

  // Background body indexer for Search Excellence
  if (!IS_E2E) {
    const fetchBodyForIndexer: FetchBodyFn = async (accountId, folder, uid) => {
      try {
        const { cfg } = await requireAccountConfig(accountId)
        // Dedicated connection — not main singleton (blocks message open) or per-account pool (deadlocks header sync).
        // Each body fetch creates its own short-lived connection, like Thunderbird's background body download.
        return await fetchMessageBody(accountId, cfg.imap, folder, uid)
      } catch (e) {
        const msg = String((e as Error)?.message || e)
        if (msg.includes('not found') || msg.includes('Could not load config')) return null
        throw e
      }
    }
    startBodyIndexer({
      fetchBody: fetchBodyForIndexer,
      isOffline: () => getSettings().workOffline === true,
      // Body indexer uses per-account connection pool (connectImapPerAccount),
      // not the main singleton or dedicated connections used by header sync.
      // No deadlock risk — safe to run concurrently with header sync.
    })
  }
})

// --- IPC: offline ---

handleIpc('offline:syncNow', async () => {
  if (IS_E2E) return { ok: true as const }
  // Start sync in background
  void syncOfflineBodies()
  return { ok: true as const }
})

handleIpc('offline:status', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const prefs = listFolderPrefs(id)

  const folderStats: Record<string, { downloaded: number; total: number }> = {}
  let hasAnyOffline = false
  for (const pref of prefs) {
    if (pref.offlineMode === 'off') continue
    hasAnyOffline = true
    folderStats[pref.folderPath] = countBodiesDownloaded(id, pref.folderPath)
  }

  return {
    enabled: hasAnyOffline,
    syncing: offlineSyncing,
    folders: folderStats,
  }
})

// --- IPC: Snooze ---

handleIpc('mail:snoozeAdd', async (_e, accountId: unknown, folder: unknown, uids: unknown, wakeAt: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const f = mailboxSchema.parse(folder)
  const parsedUids = snoozeUidsSchema.parse(uids)
  const wake = snoozeWakeAtSchema.parse(wakeAt)

  const ids: number[] = []
  for (const uid of parsedUids) {
    const row = getMessageByUid(id, f, uid)
    const msgId = row?.messageId ?? null
    ids.push(insertSnooze(id, msgId, f, uid, wake))
  }
  logSnooze.info(`Snoozed ${parsedUids.length} message(s) in ${f} until ${wake}`)
  notifySnoozeChanged(id)
  markFeatureUsed('snooze')
  return { ids }
})

handleIpc('mail:snoozeRemove', async (_e, id: unknown) => {
  const snoozeId = snoozeIdSchema.parse(id)
  const removed = removeSnooze(snoozeId)
  if (removed) notifySnoozeChanged()
  return { removed }
})

handleIpc('mail:snoozeList', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  return listSnoozed(id)
})

handleIpc('mail:snoozedUids', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  return listAllSnoozedUids(id)
})

// --- IPC: Follow-up Reminders ---

const followUpIdSchema = z.number().int().min(1)
const followUpAddSchema = z.object({
  accountId: accountIdSchema,
  sentMessageId: z.string().min(1),
  folder: z.string().min(1),
  uid: z.number().nullable().default(null),
  toAddr: z.string().min(1),
  subject: z.string().optional(),
  remindAt: z.string().datetime(),
}).strict()

handleIpc('followup:add', async (_e, payload: unknown) => {
  const p = followUpAddSchema.parse(payload)
  const id = insertFollowUp(p.accountId, p.sentMessageId, p.folder, p.uid, p.toAddr, p.subject, p.remindAt)
  logFollowUp.info(`Follow-up added: id=${id} account=${p.accountId} to=${p.toAddr} remindAt=${p.remindAt}`)
  return { id }
})

handleIpc('followup:list', async (_e, accountId?: unknown) => {
  const aId = accountId != null ? accountIdSchema.parse(accountId) : undefined
  return listFollowUps(aId)
})

handleIpc('followup:dismiss', async (_e, id: unknown) => {
  const fId = followUpIdSchema.parse(id)
  dismissFollowUp(fId)
  logFollowUp.info(`Follow-up dismissed: id=${fId}`)
  return { ok: true }
})

handleIpc('followup:remove', async (_e, id: unknown) => {
  const fId = followUpIdSchema.parse(id)
  removeFollowUp(fId)
  logFollowUp.info(`Follow-up removed: id=${fId}`)
  return { ok: true }
})

// --- IPC: Notification Center ---

const logNotif = createLogger('Notifications')

const notifIdSchema = z.number().int().min(1)

handleIpc('notifications:list', async (_e, limit?: unknown) => {
  const l = limit != null ? z.number().int().min(1).max(200).parse(limit) : 50
  return listNotifications(l)
})

handleIpc('notifications:unreadCount', async () => {
  return countUnreadNotifications()
})

handleIpc('notifications:markRead', async (_e, id: unknown) => {
  const nId = notifIdSchema.parse(id)
  markNotificationRead(nId)
  broadcast('notifications:changed', {})
  return { ok: true }
})

handleIpc('notifications:markAllRead', async () => {
  const count = markAllNotificationsRead()
  if (count > 0) broadcast('notifications:changed', {})
  return { ok: true, count }
})

handleIpc('notifications:delete', async (_e, id: unknown) => {
  const nId = notifIdSchema.parse(id)
  deleteNotification(nId)
  broadcast('notifications:changed', {})
  return { ok: true }
})

/** Create a notification and broadcast the change to renderer. */
function addNotification(type: string, title: string, body: string, refId?: string): number {
  const id = insertNotification(type, title, body, refId)
  logNotif.info(`Notification created: id=${id} type=${type}`)
  broadcast('notifications:changed', {})
  return id
}

// Purge old notifications on startup (after 30 days)
app.whenReady().then(() => {
  try { purgeOldNotifications(30) } catch { /* ignore */ }
})

// --- IPC: Read Later ---

function notifyReadLaterChanged(accountId?: number) {
  broadcast('mail:readLaterChanged', {
    accountId: typeof accountId === 'number' ? accountId : null,
    at: new Date().toISOString(),
  })
}

handleIpc('mail:readLaterAdd', async (_e, accountId: unknown, folder: unknown, uids: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const f = mailboxSchema.parse(folder)
  const parsedUids = readLaterUidsSchema.parse(uids)
  const ids: number[] = []
  for (const uid of parsedUids) {
    ids.push(insertReadLater(id, f, uid))
  }
  logReadLater.info(`Added ${ids.length} message(s) to Read Later in ${f}`)
  notifyReadLaterChanged(id)
  markFeatureUsed('read_later')
  return { ids }
})

handleIpc('mail:readLaterRemove', async (_e, id: unknown, accountId: unknown) => {
  const readLaterId = readLaterIdSchema.parse(id)
  const accId = accountIdSchema.parse(accountId)
  const removed = removeReadLater(readLaterId)
  if (removed) notifyReadLaterChanged(accId)
  logReadLater.info(`Removed Read Later id=${readLaterId} removed=${removed}`)
  return { removed }
})

handleIpc('mail:readLaterList', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  return listReadLater(id)
})

handleIpc('mail:readLaterUids', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  return listAllReadLaterUids(id)
})

// --- IPC: Templates ---

handleIpc('templates:list', async () => {
  return listTemplates()
})

handleIpc('templates:create', async (_e, data: unknown) => {
  const parsed = templateCreateSchema.parse(data)
  return createTemplate(parsed.name, parsed.subject, parsed.body, parsed.shortcut)
})

handleIpc('templates:update', async (_e, id: unknown, data: unknown) => {
  const tid = templateIdSchema.parse(id)
  const patch = templateUpdateSchema.parse(data)
  return updateTemplate(tid, patch)
})

handleIpc('templates:delete', async (_e, id: unknown) => {
  const tid = templateIdSchema.parse(id)
  return { deleted: deleteTemplate(tid) }
})

// --- IPC: Mail Rules (B2.22) ---

handleIpc('rules:list', async (_e, accountId: unknown) => {
  const aid = accountId != null ? z.string().parse(accountId) : undefined
  return listMailRules(aid)
})

handleIpc('rules:create', async (_e, data: unknown) => {
  const parsed = mailRuleCreateSchema.parse(data)
  const result = createMailRule(parsed)
  markFeatureUsed('rules')
  return result
})

handleIpc('rules:update', async (_e, id: unknown, data: unknown) => {
  const rid = mailRuleIdSchema.parse(id)
  const patch = mailRuleUpdateSchema.parse(data)
  return updateMailRule(rid, patch)
})

handleIpc('rules:delete', async (_e, id: unknown) => {
  const rid = mailRuleIdSchema.parse(id)
  return { deleted: deleteMailRule(rid) }
})

handleIpc('rules:log', async (_e, limit: unknown, ruleId: unknown) => {
  const lim = limit != null ? z.number().int().min(1).max(500).parse(limit) : 50
  const rid = ruleId != null ? z.string().parse(ruleId) : undefined
  return listRuleLog(lim, rid)
})

handleIpc('rules:test', async (_e, data: unknown) => {
  const parsed = z.object({
    conditions: z.string(),
    accountId: z.string().nullable().optional(),
  }).parse(data)

  let conditions: RuleCondition[]
  try {
    conditions = JSON.parse(parsed.conditions) as RuleCondition[]
  } catch {
    return []
  }

  const testRule: MailRule = {
    id: 'test',
    accountId: parsed.accountId ?? null,
    name: 'test',
    enabled: true,
    priority: 0,
    conditions,
    actions: [],
    stopProcessing: false,
  }

  const messages = getMessagesForRuleTest(
    parsed.accountId ? Number(parsed.accountId) : undefined
  )

  const matches: Array<{ uid: number; subject: string; from: string; folder: string }> = []
  for (const msg of messages) {
    const context: MailContext = {
      from: msg.from,
      fromAddr: msg.fromAddr,
      to: msg.toAddr || '',
      subject: msg.subject,
      hasAttachments: msg.hasAttachments,
      accountId: msg.accountId,
    }
    if (matchRule(testRule, context)) {
      matches.push({
        uid: msg.uid,
        subject: msg.subject,
        from: msg.fromAddr || msg.from,
        folder: msg.folder,
      })
    }
    if (matches.length >= 100) break
  }

  return matches
})

handleIpc('rules:applyToFolder', async (_e, ruleId: unknown) => {
  const rid = z.string().uuid().parse(ruleId)
  const ruleRow = listMailRules().find(r => r.id === rid)
  if (!ruleRow) return { applied: 0 }

  const rule: MailRule = {
    id: ruleRow.id,
    accountId: ruleRow.accountId,
    name: ruleRow.name,
    enabled: true,
    priority: ruleRow.priority,
    conditions: JSON.parse(ruleRow.conditions),
    actions: JSON.parse(ruleRow.actions),
    stopProcessing: ruleRow.stopProcessing,
  }

  const messages = getMessagesForRuleTest(
    ruleRow.accountId ? Number(ruleRow.accountId) : undefined,
    1000
  )

  let applied = 0
  for (const msg of messages) {
    const context: MailContext = {
      from: msg.from,
      fromAddr: msg.fromAddr,
      to: msg.toAddr || '',
      subject: msg.subject,
      hasAttachments: msg.hasAttachments,
      accountId: msg.accountId,
    }
    if (matchRule(rule, context)) {
      const actions = rule.actions as RuleAction[]
      for (const action of actions) {
        try {
          await executeRuleAction(msg.accountId, msg.folder, msg.uid, action)
          insertRuleLog({
            ruleId: rule.id,
            ruleName: rule.name,
            accountId: msg.accountId,
            folder: msg.folder,
            uid: msg.uid,
            subject: msg.subject,
            fromAddr: msg.fromAddr,
            actionTaken: JSON.stringify(action),
          })
          applied++
        } catch (err) {
          logRules.error(`applyToFolder action failed uid=${msg.uid}:`, err)
        }
      }
    }
  }

  return { applied }
})

// --- IPC: AI Rules (B2.23) ---

handleIpc('aiRules:list', async (_e, accountId: unknown) => {
  const aid = accountId != null ? z.string().parse(accountId) : undefined
  return listAiRules(aid)
})

handleIpc('aiRules:create', async (_e, data: unknown) => {
  const parsed = aiRuleCreateSchema.parse(data)
  return createAiRule(parsed)
})

handleIpc('aiRules:update', async (_e, id: unknown, data: unknown) => {
  const rid = aiRuleIdSchema.parse(id)
  const patch = aiRuleUpdateSchema.parse(data)
  return updateAiRule(rid, patch)
})

handleIpc('aiRules:delete', async (_e, id: unknown) => {
  const rid = aiRuleIdSchema.parse(id)
  return { deleted: deleteAiRule(rid) }
})

handleIpc('aiRules:log', async (_e, limit: unknown) => {
  const lim = limit != null ? aiRuleLogLimitSchema.parse(limit) : 50
  return listAiRuleLog(lim)
})

// --- IPC: Pin Emails (B2.24) ---

handleIpc('mail:togglePin', async (_e, accountId: unknown, folder: unknown, uid: unknown, pinned: unknown) => {
  const aid = z.number().int().min(1).parse(accountId)
  const f = z.string().min(1).parse(folder)
  const u = z.number().int().min(1).parse(uid)
  const p = z.boolean().parse(pinned)
  setPinned(aid, f, u, p)
  return { ok: true }
})

// --- IPC: MCP Export Server ---

let mcpExportServer: import('./services/mcpExport').McpExportServer | null = null

async function ensureMcpExportServer() {
  if (!mcpExportServer) {
    const { McpExportServer } = await import('./services/mcpExport')
    mcpExportServer = new McpExportServer()
  }
  return mcpExportServer
}

handleIpc('mcpExport:start', async (_e, portInput?: unknown, whitelistInput?: unknown) => {
  const port = typeof portInput === 'number' ? portInput : (getSettings().mcpExportPort ?? 23847)
  const whitelist = Array.isArray(whitelistInput) ? whitelistInput as string[] : getSettings().mcpExportWhitelist
  const server = await ensureMcpExportServer()
  if (server.status === 'running') await server.stop()
  await server.start(port, whitelist ?? undefined)
  return { ok: true, port: server.port, token: server.token }
})

handleIpc('mcpExport:stop', async () => {
  if (mcpExportServer?.status === 'running') await mcpExportServer.stop()
  return { ok: true }
})

handleIpc('mcpExport:status', async () => {
  return {
    status: mcpExportServer?.status ?? 'stopped',
    port: mcpExportServer?.port ?? (getSettings().mcpExportPort ?? 23847),
    token: mcpExportServer?.token ?? '',
  }
})

// --- MCP Client (external MCP server connections) ---

let mcpClientManager: import('./services/mcpClient').McpClientManager | null = null

async function ensureMcpClientManager() {
  if (!mcpClientManager) {
    const { McpClientManager } = await import('./services/mcpClient')
    const { setMcpClientManager } = await import('./services/ai')
    mcpClientManager = new McpClientManager()
    setMcpClientManager(mcpClientManager)
  }
  return mcpClientManager
}

// IPC-level zod shape. Layered on top of mcpSaveConnectionObjectSchema so
// callers hit the accept-and-ignore approvedSource contract from
// `packages/net/config` plus the main-process-only `.url()` validation and
// `.strict()` behaviour. We `.extend()` the raw object (not the refined
// version) because zod `.superRefine()` returns a `ZodEffects` which does not
// expose `.extend()` — so the env-key denylist refinement is re-attached here
// as the terminal composition step. That refinement is the §3.10 wave 2
// defense that rejects loader-hook env vars (NODE_OPTIONS, PYTHONSTARTUP,
// LD_PRELOAD, PATH, …) smuggled through the per-connection `env` record.
const mcpConnectionConfigSchema = mcpSaveConnectionObjectSchema.extend({
  url: z.string().url().optional(),
}).superRefine((value, ctx) => {
  const hits = findForbiddenMcpStdioEnvKeys(value.env)
  for (const key of hits) {
    ctx.addIssue({
      code: 'custom',
      message: `env key "${key}" is not allowed in stdio MCP connections (loader-hook / PATH-shadowing risk)`,
      path: ['env', key],
    })
  }
})

function requireSavedMcpConnection(id: string) {
  const config = getMcpConnection(id)
  if (!config) throw new Error(`MCP connection "${id}" not found`)
  return config
}

/**
 * §3.10 P0: current running app version. Pinned to `stdioApproved` grants so
 * an approval given in one version does not silently carry across a major
 * upgrade. `app.getVersion()` reads `package.json.version` at runtime.
 */
function getCurrentAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

handleIpc('mcp:saveConnection', async (_e, configInput?: unknown) => {
  // §3.10 P0 wave 2 reinforcement: check env-key denylist BEFORE surfacing
  // any other error so the renderer gets a precise `forbidden_env_key`
  // response and we can audit-log the attempt independently of whatever
  // else might be wrong with the payload. `mcpConnectionConfigSchema`
  // also enforces this via `.superRefine()`, but we need the structured
  // early-return path rather than a zod throw so the UI can render the
  // offending key inline next to the env row.
  if (configInput && typeof configInput === 'object') {
    const maybeEnv = (configInput as { env?: unknown }).env
    if (maybeEnv && typeof maybeEnv === 'object' && !Array.isArray(maybeEnv)) {
      const forbiddenEnvKeys = findForbiddenMcpStdioEnvKeys(maybeEnv as Record<string, string>)
      if (forbiddenEnvKeys.length > 0) {
        logMcpStdio.warn(
          `mcp:saveConnection rejected: forbidden env keys [${forbiddenEnvKeys.join(', ')}]`,
        )
        appendMcpAuditEvent({
          eventType: 'settings.forbidden_env_key',
          reason: `keys:${forbiddenEnvKeys.join(',')}`,
        })
        try {
          recordEvent('mcp.stdio.connect_blocked', { reason: 'forbidden_env_key' })
        } catch { /* telemetry must not block */ }
        return {
          ok: false as const,
          reason: 'forbidden_env_key' as const,
          keys: forbiddenEnvKeys,
        }
      }
    }
  }

  const parsed = mcpConnectionConfigSchema.parse(configInput)
  const { assertTrustedMcpConnectionConfig, hashStdioCommand } = await import('./services/mcpClient')

  // §3.10 P0 requirement #4: stdio commands must be in the built-in
  // allowlist. Reject early with a precise reason so the renderer can show a
  // dedicated UI path ("this command is not in the built-in list — please
  // contact support") instead of a generic zod error.
  if (parsed.transport === 'stdio') {
    if (!parsed.command) {
      // Let the transport-layer schema produce the canonical "stdio
      // transport requires a command" error — don't duplicate it here.
      // We still log + telemetry because an empty command from a renderer
      // save is unusual.
      logMcpStdio.warn('mcp:saveConnection rejected: stdio without command')
    } else if (!isAllowedMcpStdioCommand(parsed.command)) {
      const commandHash = hashStdioCommand(parsed.command, parsed.args)
      logMcpStdio.warn(
        `mcp:saveConnection rejected: command not in allowlist (hash=${commandHash.slice(0, 12)}…)`,
      )
      appendMcpAuditEvent({
        eventType: 'stdio.connect_blocked',
        commandHash,
        reason: 'unapproved_command',
      })
      try {
        recordEvent('mcp.stdio.connect_blocked', { reason: 'unapproved_command' })
      } catch { /* telemetry must not block */ }
      return {
        ok: false as const,
        reason: 'unapproved_command' as const,
        allowlist: DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST,
      }
    }
  }

  // §3.10 P0 requirement #3: drop any renderer-seeded approvedSource. The
  // save path never mints an approval; that happens only via
  // `mcp:approveStdioConnection`. Preserve a prior stored approval when the
  // command/args/env remain identical (common case: user is toggling the
  // autoConnect flag on a pre-approved connection — they should not have to
  // re-approve). If command, args, OR env differ, treat it as a fresh
  // connection and clear the approval — the previously-approved subprocess
  // spawn surface is no longer the one about to be launched. The env
  // comparison closes the wave 2 MEDIUM-1 data-exfiltration variant: post-
  // approval mutation of env (e.g. inserting `PROXY=attacker-server`) now
  // invalidates the prior native-confirm, forcing a fresh dialog that will
  // render the new env entries under the command+args line.
  //
  // Env is compared via a canonicalised JSON (sorted keys) so the order a
  // renderer serialises entries in does not churn the approval marker. The
  // approval is about the SET of spawn-surface env pairs, not their
  // iteration order.
  const canonicalEnv = (env: Record<string, string> | undefined): string => {
    const entries = Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b))
    return JSON.stringify(entries)
  }
  const existingConn = getMcpConnection(parsed.id)
  let preservedApproval: 'env' | 'native-confirm' | null = null
  if (
    existingConn
    && existingConn.transport === 'stdio'
    && parsed.transport === 'stdio'
    && existingConn.approvedSource === 'native-confirm'
    && existingConn.command === parsed.command
    && JSON.stringify(existingConn.args ?? []) === JSON.stringify(parsed.args ?? [])
    && canonicalEnv(existingConn.env) === canonicalEnv(parsed.env)
  ) {
    preservedApproval = 'native-confirm'
  }

  const config = {
    ...parsed,
    approvedSource: preservedApproval,
  }
  assertTrustedMcpConnectionConfig(config)
  saveMcpConnection(config)
  return { ok: true as const, id: config.id }
})

handleIpc('mcp:removeConnection', async (_e, idInput?: unknown) => {
  const id = z.string().min(1).parse(idInput)
  deleteMcpConnection(id)
  if (mcpClientManager) await mcpClientManager.disconnect(id)
  return { ok: true as const }
})

handleIpc('mcp:connect', async (_e, idInput?: unknown) => {
  const id = z.string().min(1).parse(idInput)
  const config = requireSavedMcpConnection(id)
  const { resolveConnectionApproval, hashStdioCommand } = await import('./services/mcpClient')
  const approval = resolveConnectionApproval(config, getCurrentAppVersion())
  if (!approval.approved) {
    const commandHash = config.transport === 'stdio' && config.command
      ? hashStdioCommand(config.command, config.args)
      : undefined
    const reason = approval.reason ?? 'not_approved'
    logMcpStdio.warn(
      `mcp:connect blocked for "${config.name}": ${reason} (hash=${commandHash?.slice(0, 12) ?? 'n/a'}…)`,
    )
    appendMcpAuditEvent({
      eventType: 'stdio.connect_blocked',
      commandHash,
      reason,
    })
    try {
      recordEvent('mcp.stdio.connect_blocked', { reason })
    } catch { /* telemetry must not block */ }
    return { ok: false as const, reason }
  }

  // Connect-attempted audit fires BEFORE the actual connect — so even if the
  // subprocess crashes immediately we still know the gate let it through.
  if (config.transport === 'stdio' && config.command) {
    const commandHash = hashStdioCommand(config.command, config.args)
    appendMcpAuditEvent({
      eventType: 'stdio.connect_attempted',
      commandHash,
      approvedSource: approval.source,
    })
    try {
      recordEvent('mcp.stdio.connect_attempted', { approved_source: approval.source ?? 'unknown' })
    } catch { /* telemetry must not block */ }
  }

  const mgr = await ensureMcpClientManager()
  // When approval came from env, stamp the in-memory config with
  // approvedSource: 'env' so the transport layer's secondary gate
  // (isStdioMcpEnabled) and any downstream readers see a consistent marker.
  const effectiveConfig = approval.source === 'env'
    ? { ...config, approvedSource: 'env' as const }
    : config
  await mgr.connect(effectiveConfig)
  return { ok: true }
})

handleIpc('mcp:disconnect', async (_e, idInput?: unknown) => {
  const id = z.string().min(1).parse(idInput)
  const mgr = await ensureMcpClientManager()
  await mgr.disconnect(id)
  return { ok: true }
})

handleIpc('mcp:testConnection', async (_e, idInput?: unknown) => {
  const id = z.string().min(1).parse(idInput)
  const config = requireSavedMcpConnection(id)
  // Test-connect MUST honour the §3.10 P0 approval gate. Otherwise a
  // compromised renderer could use `mcp:testConnection` to launch an
  // unapproved stdio subprocess as a side-effect.
  const { McpClientManager, resolveConnectionApproval } = await import('./services/mcpClient')
  const approval = resolveConnectionApproval(config, getCurrentAppVersion())
  if (!approval.approved) {
    return { ok: false as const, reason: approval.reason ?? 'not_approved' }
  }
  const effectiveConfig = approval.source === 'env'
    ? { ...config, approvedSource: 'env' as const }
    : config
  const testMgr = new McpClientManager()
  try {
    await testMgr.connect(effectiveConfig)
    const info = testMgr.getStatus(config.id)
    await testMgr.disconnectAll()
    return { ok: true, toolCount: info.toolCount }
  } catch (err) {
    await testMgr.disconnectAll()
    throw err
  }
})

/**
 * §3.10 P0 requirement #2: production power-user flow for enabling stdio
 * MCP. The renderer calls this via `mcp:requestStdioEnable`; main pops a
 * native warning dialog ("Launching local processes is dangerous — only
 * enable this if you trust every MCP server you've configured") and
 * persists `stdioApproved` on confirmation. Env-mode skips this dialog.
 */
handleIpc('mcp:requestStdioEnable', async () => {
  // Dev / CI mode: stdio is already enabled via env flag. Tell the renderer
  // so the UI can show "stdio is enabled by MAILCOPILOT_ENABLE_STDIO_MCP".
  if (process.env.MAILCOPILOT_ENABLE_STDIO_MCP === '1') {
    return { ok: true as const, source: 'env' as const }
  }

  // Production flow: native dialog with a strongly-worded warning. `detail`
  // is the long-form explanation; `message` is the one-line summary. Button
  // order: cancel first, enable second — deliberate to make "enable" the
  // non-default action even though we set `defaultId: 0`.
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Enable stdio MCP transport',
    message: 'Allow MailCopilot to launch local processes for MCP?',
    detail:
      'Stdio MCP servers are child processes running with your user privileges. '
      + 'They can read files, access the network, and execute further commands. '
      + 'Only enable this if you understand and trust every MCP server you configure.\n\n'
      + 'You can disable stdio MCP at any time in Settings.',
    buttons: ['Cancel', 'Enable stdio MCP'],
    defaultId: 0,
    cancelId: 0,
  })
  if (result.response !== 1) {
    return { ok: false as const, reason: 'cancelled' as const }
  }

  const current = getSettings()
  saveSettings({
    ...current,
    mcpEnableStdio: true,
    stdioApproved: {
      source: 'native-confirm',
      approvedAt: new Date().toISOString(),
      appVersion: getCurrentAppVersion(),
    },
  })

  appendMcpAuditEvent({
    eventType: 'stdio.approved',
    approvedSource: 'native-confirm',
    reason: 'global_enable',
  })
  try {
    recordEvent('mcp.stdio.approval_granted', { source: 'native-confirm', scope: 'global' })
  } catch { /* telemetry must not block */ }
  logMcpStdio.info('stdio MCP globally enabled via native-confirm')

  // Broadcast the new settings so open windows pick up the enable without a restart.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings:changed', getSettings())
  }

  return { ok: true as const, source: 'native-confirm' as const }
})

/**
 * §3.10 P0 requirement #3: per-connection approval. The renderer calls this
 * with the id of a saved stdio connection; main shows a native dialog with
 * the exact command and args about to be spawned and asks for explicit
 * confirmation. On OK, the connection's `approvedSource` is persisted as
 * `'native-confirm'`.
 */
handleIpc('mcp:approveStdioConnection', async (_e, idInput?: unknown) => {
  const id = z.string().min(1).parse(idInput)
  const config = requireSavedMcpConnection(id)
  if (config.transport !== 'stdio') {
    return { ok: false as const, reason: 'not_stdio' as const }
  }
  if (!config.command) {
    return { ok: false as const, reason: 'invalid_config' as const }
  }

  // §3.10 P0 wave 2 HIGH-1 defense-in-depth: re-verify the command against
  // the current built-in allowlist BEFORE showing the approval dialog. The
  // save handler (`mcp:saveConnection`) already enforces this at write
  // time, but the allowlist can legitimately shrink between app versions
  // (e.g. a deprecated runtime is removed). Without this re-check, a user
  // would still be able to re-approve a persisted connection whose command
  // is no longer in the allowlist — and the `mcp:connect` allowlist check
  // in the transport layer would then surface as a late, opaque error. By
  // re-checking here we reject early with the same structured
  // `unapproved_command` shape the save handler uses, so the renderer can
  // reuse the same UX branch.
  if (!isAllowedMcpStdioCommand(config.command)) {
    const { hashStdioCommand } = await import('./services/mcpClient')
    const commandHash = hashStdioCommand(config.command, config.args)
    logMcpStdio.warn(
      `mcp:approveStdioConnection rejected: command not in allowlist (hash=${commandHash.slice(0, 12)}…)`,
    )
    appendMcpAuditEvent({
      eventType: 'stdio.connect_blocked',
      commandHash,
      reason: 'unapproved_command',
    })
    try {
      recordEvent('mcp.stdio.connect_blocked', { reason: 'unapproved_command' })
    } catch { /* telemetry must not block */ }
    return {
      ok: false as const,
      reason: 'unapproved_command' as const,
      allowlist: DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST,
    }
  }

  // If stdio is globally enabled via env, auto-approve the connection —
  // env mode trusts the developer. (Persisted approval still makes sense so
  // subsequent non-env sessions don't re-prompt — but only if stdio is also
  // globally enabled via native-confirm; we don't want to persist an
  // approval that silently survives the env flag going away.)
  if (process.env.MAILCOPILOT_ENABLE_STDIO_MCP === '1') {
    appendMcpAuditEvent({
      eventType: 'stdio.approved',
      commandHash: (await import('./services/mcpClient')).hashStdioCommand(config.command, config.args),
      approvedSource: 'env',
      reason: 'connection_env',
    })
    try {
      recordEvent('mcp.stdio.approval_granted', { source: 'env', scope: 'connection' })
    } catch { /* telemetry must not block */ }
    return { ok: true as const, source: 'env' as const }
  }

  // Production flow: show command, args AND env in the dialog verbatim.
  // §3.10 P0 wave 2 BLOCKER-2: env entries MUST be rendered here so the
  // user sees the full subprocess-launch surface before consenting. A
  // prior iteration showed only command+args, which let a compromised
  // renderer inject `NODE_OPTIONS=--require /tmp/evil.js` and get RCE
  // under a "node ./server.js" approval that looked clean. The env-key
  // denylist in `mcp:saveConnection` blocks the worst loader-hook keys,
  // but rendering env keeps the user's eyes on the full spawn surface
  // for anything that slips through a future relaxation of the denylist
  // or for benign-looking keys (e.g. `PROXY=http://attacker/`) that the
  // denylist does not know about.
  //
  // Sanitize the user-supplied connection name, command, args, AND env
  // key/value pairs before injecting into dialog strings: strip control
  // chars and truncate to a reasonable length so a compromised renderer
  // that crafted a malicious connection name / env value cannot embed
  // misleading text into our warning dialog (e.g.
  // "legitimate\n\nACTUAL WARNING: click Approve to cancel").
  const sanitizeForDialog = (raw: string, maxLen = 120): string => {
    // eslint-disable-next-line no-control-regex
    const noControl = raw.replace(/[\x00-\x1f\x7f]+/g, ' ')
    return noControl.length > maxLen ? noControl.slice(0, maxLen) + '…' : noControl
  }
  const safeName = sanitizeForDialog(config.name, 80)
  const safeCommand = sanitizeForDialog(config.command, 120)
  const safeArgs = config.args && config.args.length > 0
    ? ' ' + config.args.map(a => sanitizeForDialog(a, 80)).join(' ')
    : ''
  // Build env block only when there are entries — keep the dialog clean
  // in the common case where the connection declares no per-connection env.
  const envEntries = config.env ? Object.entries(config.env) : []
  const safeEnvBlock = envEntries.length > 0
    ? '\n\nWith the following environment variables:\n\n'
      + envEntries
        .map(([k, v]) => `    ${sanitizeForDialog(k, 80)}=${sanitizeForDialog(v, 80)}`)
        .join('\n')
    : ''
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Approve stdio MCP connection',
    message: `Approve launching the MCP connection "${safeName}"?`,
    detail:
      `This will launch the following local command when the connection is started:\n\n`
      + `    ${safeCommand}${safeArgs}`
      + safeEnvBlock
      + '\n\n'
      + 'Only approve if you recognize this command and trust the server it starts. '
      + 'Approval stays until you delete the connection, edit its command, arguments, or environment, '
      + 'or upgrade MailCopilot.',
    buttons: ['Cancel', 'Approve'],
    defaultId: 0,
    cancelId: 0,
  })
  if (result.response !== 1) {
    return { ok: false as const, reason: 'cancelled' as const }
  }

  const { hashStdioCommand } = await import('./services/mcpClient')
  const commandHash = hashStdioCommand(config.command, config.args)
  saveMcpConnection({
    ...config,
    approvedSource: 'native-confirm',
  })
  appendMcpAuditEvent({
    eventType: 'stdio.approved',
    commandHash,
    approvedSource: 'native-confirm',
    reason: 'connection_approve',
  })
  try {
    recordEvent('mcp.stdio.approval_granted', { source: 'native-confirm', scope: 'connection' })
  } catch { /* telemetry must not block */ }
  logMcpStdio.info(`stdio connection "${config.name}" approved via native-confirm (hash=${commandHash.slice(0, 12)}…)`)

  // Broadcast new settings so the Settings window refreshes the "Needs approval" badge.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings:changed', getSettings())
  }

  return { ok: true as const, source: 'native-confirm' as const }
})

handleIpc('mcp:status', async () => {
  if (!mcpClientManager) return {}
  return mcpClientManager.getAllStatuses()
})

handleIpc('mcp:listTools', async (_e, serverIdInput?: unknown) => {
  const mgr = await ensureMcpClientManager()
  if (typeof serverIdInput === 'string') {
    const info = mgr.getStatus(serverIdInput)
    if (info.status !== 'connected') return []
  }
  return mgr.listAllTools()
})

// --- Offline ops replay ---

const logReplay = createLogger('OfflineReplay')
const logPeriodic = createLogger('PeriodicSync')

/** Resolve IMAP config for an account (used by replay service) */
async function getImapConfigForReplay(accountId: number) {
  const { cfg } = await requireAccountConfig(accountId)
  assertImapAuth(accountId, cfg.imap)
  return cfg.imap
}

/** Replay offline ops for all accounts that have pending operations */
async function replayAllOfflineOps(): Promise<void> {
  const ops = getOfflineOps()
  if (ops.length === 0) return
  const accountIds = [...new Set(ops.map(op => op.accountId))]
  for (const aid of accountIds) {
    try {
      await replayOfflineOps(aid, getImapConfigForReplay)
    } catch (err) {
      logReplay.error(`Replay failed for account #${aid}:`, err)
    }
  }
}

// Trigger replay when going back online (workOffline: true → false)
let prevWorkOffline = getSettings().workOffline ?? false
// §2.15-ter: cache the last seen body retention so we can detect a shrink
// (or "forever → finite") and trigger an eager prune. Both -1 and a finite
// value coexist on this variable; the comparison logic in the handler
// distinguishes them.
let prevBodyRetentionDays: number = (getSettings().bodyRetentionDays ?? DEFAULT_BODY_RETENTION_DAYS)

/** Called from settings:save handler when settings change (main-process side). */
function onSettingsChangedMain(next: { workOffline?: boolean; periodicSyncIntervalMin?: number; bodyRetentionDays?: number; autoUpdateEnabled?: boolean }): void {
  const nowOffline = next.workOffline ?? false
  if (prevWorkOffline && !nowOffline) {
    logReplay.info('Went back online — replaying offline ops')
    void replayAllOfflineOps()
  }
  prevWorkOffline = nowOffline

  // §2.19 — runtime auto-download toggle. Apply without restart so the
  // checkbox in Settings → About takes effect immediately. Skip in
  // dev/e2e — autoUpdater is not initialised there and writing to the
  // module-level singleton has no benefit.
  // §2.19 iter3 — gate by updateCanSelfUpdate. Read-only installs (admin
  // /opt, system package) cannot self-update; forcing autoDownload=false
  // here keeps runtime behaviour aligned with the disabled checkbox in
  // Settings → About (see SystemInfo.canSelfUpdate). Without this, a
  // persisted autoUpdateEnabled=true would silently keep auto-downloading
  // updates that can never be applied.
  if (app.isPackaged && !IS_E2E) {
    const wantAutoDownload = next.autoUpdateEnabled === true && updateCanSelfUpdate
    if (autoUpdater.autoDownload !== wantAutoDownload) {
      autoUpdater.autoDownload = wantAutoDownload
      logUpdate.info(`autoDownload toggled at runtime: ${wantAutoDownload}`)
    }
  }

  // Restart periodic sync timer if interval changed
  const newInterval = next.periodicSyncIntervalMin
  if (typeof newInterval === 'number' && newInterval !== currentPeriodicInterval) {
    restartPeriodicSync(newInterval)
  }

  // §2.15-ter: trigger an immediate body retention sweep when the user
  // shrinks the global window (e.g. 365 → 90 days, or "forever" → 365).
  // Increasing the window or staying the same is a no-op — old bodies
  // stay deleted, future bodies live longer.
  const nextRetention = typeof next.bodyRetentionDays === 'number'
    ? next.bodyRetentionDays
    : DEFAULT_BODY_RETENTION_DAYS
  // "shrink" means: previous value was forever (-1) and new value is finite,
  // OR both are finite and the new one is strictly smaller.
  const prevForever = prevBodyRetentionDays === -1
  const nextForever = nextRetention === -1
  const isShrink = (prevForever && !nextForever) || (!prevForever && !nextForever && nextRetention < prevBodyRetentionDays)
  if (isShrink) {
    // pruneOldEmls is best-effort and self-guarded against shutdown; fire
    // and forget so the IPC reply isn't blocked on disk I/O.
    setTimeout(() => pruneOldEmls(), 0).unref()
  }
  prevBodyRetentionDays = nextRetention
}

// --- Periodic folder sync timer ---

let periodicSyncTimer: ReturnType<typeof setInterval> | null = null
let currentPeriodicInterval = getSettings().periodicSyncIntervalMin ?? 5
/**
 * §2.24 PR1 — per-account run guard. Replaces the old global
 * `periodicSyncRunning` boolean. An accountId is present here while its
 * own per-account sync pass is in flight. A timer tick only starts a pass
 * for accounts NOT currently in the set — so one hung account (e.g. an
 * IMAP server behind DPI throttling that never sends a greeting) no longer
 * skips the entire periodic-sync cycle for the remaining healthy accounts.
 */
const periodicSyncInFlight = new Set<number>()

/**
 * §2.24 PR1 — per-account timeout budget. Worst-case observed on the
 * 2026-05-13 incident: 6 folders × ~80s per folder ≈ 8 min for a single
 * throttled account. If an account's whole pass (all its folders) exceeds
 * this, we stop starting new folders for it, release its in-flight slot,
 * and let the other accounts continue unaffected. The folder already
 * mid-fetch is allowed to finish (fetchAllFolderHeaders has no
 * AbortController), but no new folder starts.
 */
const PERIODIC_SYNC_ACCOUNT_BUDGET_MS = 8 * 60_000

/**
 * §2.24 PR1 — sync a single account's folders. Folders within the account
 * stay strictly sequential (`await` in the loop) to avoid IMAP connection
 * storms (CLAUDE.md §5 — per-account IMAP pool with semaphore). The
 * `isTimedOut` callback lets the per-account timeout budget interrupt the
 * loop between folders without threading an AbortController through
 * fetchAllFolderHeaders.
 */
async function syncOneAccountFolders(aid: number, isTimedOut: () => boolean): Promise<void> {
  // Replay pending offline ops first
  try {
    await replayOfflineOps(aid, getImapConfigForReplay)
  } catch (err) {
    logReplay.error(`Pre-sync replay failed for account #${aid}:`, err)
  }

  // Sync folders with headerSyncMode 'full' or 'period'
  const prefs = listFolderPrefs(aid)
  const foldersToSync = prefs
    .filter(p => p.headerSyncMode === 'full' || p.headerSyncMode === 'period')
    .map(p => p.folderPath)

  if (foldersToSync.length === 0) return

  let cfg
  try {
    const result = await requireAccountConfig(aid)
    cfg = result.cfg
    assertImapAuth(aid, cfg.imap)
  } catch (err) {
    logPeriodic.warn(`Cannot get config for account #${aid}, skipping:`, err)
    return
  }

  logPeriodic.info(`Periodic sync for account #${aid}: ${foldersToSync.length} folders`)

  // Sequential sync within account (avoid IMAP connection storms)
  for (const folder of foldersToSync) {
    if (getSettings().workOffline) break
    if (isTimedOut()) break // per-account budget exhausted — stop starting new folders
    try {
      const priorCrawl = getFolderCrawlState(aid, folder)
      const priorSync = getSyncState(aid, folder)
      const result = await fetchAllFolderHeaders(
        cfg.imap,
        folder,
        aid,
        (batch) => {
          // Persist fetched headers to DB (without this, new messages are lost).
          // Atomic boundary (2026-04-21 P0 data-loss fix): use the transaction
          // helper so the batch upsert stays within a single commit. The
          // periodic sync path does not touch folder_crawl_state mid-batch
          // so the state arg is null.
          applyFolderSyncBatch(
            aid,
            folder,
            batch.map(m => ({
              uid: m.uid, subject: m.subject, fromAddr: m.fromAddr || '', fromName: m.fromName,
              toAddr: m.toAddr, date: m.date, unread: m.unread, flagged: m.flagged,
              hasAttachments: m.hasAttachments, messageId: m.messageId,
              inReplyTo: m.inReplyTo, references: m.references,
              attachmentFilenames: m.attachmentFilenames,
            })),
            null,
          )
        },
        {
          batchSize: 500,
          knownModseq: priorCrawl?.highestModseq ?? undefined,
          knownUidValidity: priorSync?.uidValidity ?? undefined,
        },
      )
      // Update sync state with latest modseq/uidValidity
      if (!result.skipped) {
        try {
          upsertSyncState(aid, folder, result.highestModseq, result.uidValidity)
          const totalCrawled = getAccountMessageCount(aid, folder)
          // Same atomic final-commit pattern as the main sync path.
          applyFolderSyncBatch(aid, folder, [], {
            status: 'covered_full',
            watermarkUid: getMaxUidForFolder(aid, folder) || (priorCrawl?.watermarkUid ?? null),
            totalExists: result.exists,
            crawledCount: totalCrawled,
            highestModseq: result.highestModseq ?? priorCrawl?.highestModseq ?? null,
            lastAttemptAt: new Date().toISOString(),
            completedAt: priorCrawl?.completedAt ?? new Date().toISOString(),
            error: null,
          })
        } catch { /* non-critical */ }
      }
    } catch (err) {
      logPeriodic.warn(`Periodic sync failed for folder "${folder}" account #${aid}:`, err)
    }
  }
}

/**
 * §2.24 PR1 — run one account's full sync pass under a SOFT timeout budget
 * and the per-account in-flight guard.
 *
 * The budget is intentionally soft: the timer only flips the `timedOut`
 * flag, which `syncOneAccountFolders` checks between folders to stop
 * starting NEW folders. It does NOT abort a folder fetch already in flight
 * (fetchAllFolderHeaders has no AbortController). We always `await` the
 * real work to its natural completion — never abandon it as an un-awaited
 * promise. Abandoning it would let `waitForPeriodicSyncIdle()` (which polls
 * `periodicSyncInFlight.size`) report idle while a DB batch is still being
 * written, and would let the next timer tick re-start the same account
 * concurrently (codex §2.24 wave-2 HIGH-1).
 *
 * Consequence: the account's in-flight slot is held until its sync truly
 * settles. Worst-case wall time for one account = (folders finished before
 * the deadline) + (one in-flight folder draining, up to ~120s). Other
 * accounts are unaffected — `runPeriodicSync` drives them concurrently via
 * Promise.allSettled, so account #1 holding its own slot for 8min+~120s
 * blocks nobody else.
 */
async function runOneAccountPeriodicSync(aid: number): Promise<void> {
  periodicSyncInFlight.add(aid)
  const startedAt = Date.now()
  let timedOut = false
  let budgetTimer: ReturnType<typeof setTimeout> | null = null
  try {
    budgetTimer = setTimeout(() => {
      timedOut = true
    }, PERIODIC_SYNC_ACCOUNT_BUDGET_MS)
    // Always await the real work — no Promise.race against the budget. The
    // budget timer only flips `timedOut` so the folder loop stops starting
    // new folders; the current folder is allowed to drain.
    await syncOneAccountFolders(aid, () => timedOut)
    const elapsedMs = Date.now() - startedAt
    if (timedOut) {
      logPeriodic.warn(`Periodic sync for account #${aid} exceeded ${PERIODIC_SYNC_ACCOUNT_BUDGET_MS}ms soft budget (settled after ${elapsedMs}ms) — stopped starting new folders, other accounts unaffected`)
      captureException(new Error('periodicSync account soft-budget overrun'), {
        source: 'periodicSync:accountTimeout',
        accountId: aid,
        elapsedMs,
      })
    } else {
      logPeriodic.info(`Periodic sync for account #${aid} finished in ${elapsedMs}ms`)
    }
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer)
    periodicSyncInFlight.delete(aid)
    // A certificate trusted mid-pass needs a pass that actually uses the new
    // trust anchor — this one was built with the pre-pin config.
    drainPendingPostTrustResync(aid)
  }
}

/**
 * §2.24 PR1 — periodic sync entry point. Accounts run concurrently via
 * Promise.allSettled; only accounts not already in flight are started, so
 * a single stuck account never blocks the rest of the cycle. Folders
 * within each account remain sequential (see syncOneAccountFolders).
 */
async function runPeriodicSync(): Promise<void> {
  if (shuttingDown) return
  if (getSettings().workOffline || isHeaderSyncActive() || IS_E2E) return
  const accounts = listAccounts()
  const toStart = accounts
    .map(acct => acct.id)
    .filter(aid => !periodicSyncInFlight.has(aid))
  if (toStart.length === 0) return
  // §2.24 PR1 — accounts run concurrently. Promise.allSettled never throws,
  // so a rejection from runOneAccountPeriodicSync (e.g. listFolderPrefs() or
  // a DB failure before the per-folder catch) would otherwise vanish with
  // only the Set cleanup running. Surface each rejection explicitly,
  // correlating result↔accountId by index (codex §2.24 wave-2 MEDIUM-1).
  const results = await Promise.allSettled(toStart.map(aid => runOneAccountPeriodicSync(aid)))
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const accountId = toStart[i]
      logPeriodic.warn(`Periodic sync pass for account #${accountId} rejected:`, result.reason)
      captureException(result.reason, { source: 'periodicSync:accountFailed', accountId })
    }
  })
}

function restartPeriodicSync(intervalMin: number) {
  if (periodicSyncTimer) clearInterval(periodicSyncTimer)
  currentPeriodicInterval = intervalMin
  const ms = intervalMin * 60_000
  periodicSyncTimer = setInterval(() => void runPeriodicSync(), ms)
  logPeriodic.info(`Periodic sync timer set to ${intervalMin} min`)
}

/**
 * Wait for any in-flight runPeriodicSync() to finish before returning.
 * Polls `periodicSyncInFlight.size` every 50ms up to `timeoutMs`. Used
 * during shutdown so WAL checkpoint does not race against a commit from an
 * already-started sync batch. See Codex §2.15 wave-2 High. §2.24 PR1:
 * the global boolean was replaced by a per-account in-flight set — idle
 * now means no account is mid-pass.
 */
async function waitForPeriodicSyncIdle(timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now()
  while (periodicSyncInFlight.size > 0) {
    if (Date.now() - start >= timeoutMs) return false
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return true
}

// Start periodic sync with 60s delay after app ready
app.whenReady().then(() => {
  if (IS_E2E) return
  setTimeout(() => {
    restartPeriodicSync(currentPeriodicInterval)
    // Run first sync immediately after startup delay
    void runPeriodicSync()
  }, 60_000)
})

app.on('before-quit', () => {
  if (periodicSyncTimer) {
    clearInterval(periodicSyncTimer)
    periodicSyncTimer = null
  }
})
