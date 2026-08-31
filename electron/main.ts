// Sentry is initialized as early as possible, with the persisted telemetry
// CONSENT verdict already applied, so session envelopes and early events
// cannot precede the user's answer. The verdict is not "the About switch is
// not off" — it requires an active consent record for the current disclosure
// version (§2.82, electron/telemetryConsent.ts); an install that has never
// been asked reads as `false` and stays silent. The preflight reader uses only
// electron + fs + path so we don't drag config.ts (better-sqlite3, keytar,
// zod, electron-store) in front of this call.
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
// the recorded consent decision. The same call also arms the collection
// gate (electron/telemetryGate.ts), so nothing ACCUMULATES before the
// answer either.
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
// §2.82 iter4 (security finding 2): this seam is the PII boundary for network
// errors, not a pass-through. Every string inside `err` is written by the mail
// server (ImapFlow keeps the server's free text in `responseText` and the
// executed command — including the MAILBOX NAME — in `executedCommand`), and a
// folder name has no shape that the event-level scrub could recognise. The
// service drops transient conditions against the raw error, then transmits a
// synthetic exception carrying only a closed error class plus allowlisted
// context; the raw error stays in the local log. See netErrorTelemetry.ts.
import { reportSanitizedNetError } from './services/netErrorTelemetry'
setNetErrorReporter((source, err, context) => {
  reportSanitizedNetError(source, err, context)
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
// have already executed against the default sink. That default SPAN sink
// still carries a bounded buffer that drains on installation, but read the
// consent paragraph below before assuming it catches any of that: retention
// is gated, the gate is injected by the statement below, and no DB work
// happens between that statement and the real sink — so the cold-start round
// it was written for is NOT captured today. The buffer only becomes load
// bearing if bootstrap is ever split in two (gate first, `await import()` the
// rest). Error reports raised before the reporter below exists are simply
// dropped — nothing buffers them, by design.
// packages/db itself never imports Sentry.
//
// §2.82: buffering is COLLECTION, so it obeys the consent gate like every
// other accumulator. packages/db cannot import electron/telemetryGate, so the
// gate is injected here and the reset hook registered, exactly as metrics.ts
// and featureReach.ts do for their own buckets. Fail-closed by construction:
// this statement runs after the hoisted imports above, so during import-time
// migrations no gate exists and nothing is retained at all.
import { setDbTelemetrySink, setDbErrorReporter, setDbEventReporter, setDbTelemetryCollectionGate, resetDbTelemetryBuffer } from '../packages/db/telemetry'
import { isTelemetryCollectionAllowed, registerTelemetryCollectionResetHook } from './telemetryGate'
setDbTelemetryCollectionGate(isTelemetryCollectionAllowed)
registerTelemetryCollectionResetHook(resetDbTelemetryBuffer)
import { takeSlowSqlSamples } from '../packages/db/sqlTiming'
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
import { buildChildWindowOptions, centerOverRect, isStandaloneWindowKind, type ChildWindowKind } from './childWindowOptions'
import { computeIsE2E } from './e2eFlag'
import { buildFolderCountsResponse } from './folderCountsResponse'
// §2.145 — whether a stored details row may be served; see that module for why
// the threshold is the SERVER-DIRECT writer's bound and not the EML soft cap.
import { isServableCachedDetail, isServableCachedDetailJson } from './cachedDetailGuard'
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
// §2.82 — the telemetry session clock. Re-origins on a consent transition, so
// `app.session_ended` never reports a period the user had not agreed to.
import { telemetryCollectionStartedAtMs } from './telemetryGate'

// Single Instance Lock: prevent multiple app instances sharing the same DB.
// Disabled in E2E mode — tests run multiple isolated instances in parallel.
const gotSingleInstanceLock = process.env.MAILCOPILOT_E2E === '1' || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  process.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    // §2.99 — relaunching from the launcher is the way back on Linux/Windows:
    // the first instance may be minimized, hidden by close-to-tray, or running
    // with no window at all. All three repairs (and the create-if-absent case)
    // belong to `showMainWindow()`, which is also what the tray's Open item and
    // the macOS `activate` handler call — one implementation, so the routes
    // back cannot drift apart. The hand-inlined copy this replaces additionally
    // picked the FIRST live window rather than the main one, so a relaunch with
    // a Compose or Settings window open raised the wrong window.
    showMainWindow()
    // Handle mailto: URL passed from second instance (Linux/Windows). Unrelated
    // to bringing the app back — a relaunch carrying a mailto: does both.
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
  // No `replyRef` on a mailto: there is no correspondent's message to read, so
  // there is nothing to suggest (§3.3 B6 draft side).
  composeCtx = { accountId, init, suggestion: null }
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
import type { OAuthConnectStage, OAuthProgress } from '@mailcopilot/types'
import { requireGoogleOAuthCredentials } from './googleOAuthConfig'
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
  parseEmlHeaderFacts,
  extractEmlAttachment,
  EML_ATTACHMENT_PART_PREFIX,
  // §2.145 wave 2.1 — the acquisition ceiling and the counter it feeds.
  MAX_EML_PARSE_BYTES,
  recordHardParseCapTrip,
  downloadRawMessage,
  saveEml,
  readEml,
  readEmlBounded,
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
  withImapPriority,
} from '../packages/net/index'
import { requestSafeRemoteBytes } from '../packages/net/safeRemoteFetch'
// §2.172 — every e2e fixture seeding site splits the raw `From:` header here,
// so the seeded rows carry the same address/name split production writes.
import { senderPartsFromHeader } from './e2eSenderParts'
// §2.33 PR2a: setSecretBackend is exported from packages/net/config but is NOT
// re-exported from packages/net/index — import it directly from the config
// module (same style as electron/services/ai.ts), keeping scope to main.ts.
// `getRawPersistedSettings` is deliberately in the same bucket: it bypasses the
// schema (defaults and all), so keeping it off the public index makes it hard
// to reach for by accident. Its only two callers are the §2.82 consent
// migration and the `settings:save` clamp-preservation below.
import { setSecretBackend, getRawPersistedSettings, ACCOUNT_KEYED_CONSENT_FIELDS } from '../packages/net/config'
// §1.26.f2 — `settings:save` may not persist an AI consent for a mailbox that
// no longer exists. Pure functions; the handler keeps the registry read and the
// ordering. See the module header for what the rule does and does not cover.
import { pruneUnknownAccountConsents, keepStoredConsents } from './accountKeyedConsents'
import type { AccountConfig, AccountMeta, AttachmentMeta, CalendarInvite, ComposeInit, FolderRoles, FolderPreference, ImapConfig, Mailbox, MessageDetails, UnsubscribeAttemptResult } from '../packages/net/types'
import { queueItemToComposeInit } from './queueComposeBridge'
import { quickActionRewriteSchema, instantReplyGenerateSchema, proofreadCheckSchema, translateDraftSchema } from './ipcSchemas'
import { translateMessageSchema, translateMessage, forgetAccountTranslations } from './services/aiTranslate'
import {
  createComposeOpenSequence,
  deliverIfStillCurrent,
  settleTargetLangSuggestion,
  startTargetLangSuggestion,
  translateDraft,
  type PendingTargetLangSuggestion,
} from './services/composeTranslate'
// §2.167 — the `settings:save` verdict split (whole-payload refusal vs
// per-field refusal). Pure functions; the handler keeps the IO and the order.
import {
  partitionRendererSettingsIssues,
  stripRefusedFields,
  dropErasingUndefined,
  type RefusedSettingsField,
} from './settingsSaveRefusal'
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
  listFolderCrawlStates,
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
  getMailRule,
  createMailRule,
  updateMailRule,
  deleteMailRule,
  getMessagesForRuleTest,
  getMailRulesState,
  setMailRulesState,
  getUidsForRulesSince,
  seedMailRulesStateFromCache,
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
  mergeFtsIndexStep,
  ftsSegmentCount,
  appendMcpAuditEvent,
  listAiActionLog,
  aggregateAiUsage,
  softDeleteAiActionEntry,
  clearAiActionLog,
  exportAiActionLog,
} from '../packages/db'
import type { TlsPinRow, AiCostReservation } from '../packages/db'
import { matchRule, parseSearchQuery, findEncodedMailRuleRefusal, mailRuleRefusalError, formatMailRuleRefusal, parseMailRuleParts, type MailRule, type MailContext, type MailRuleRefusal, type RuleAction } from '../packages/core'
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
import {
  runMailRules,
  type MailRulesRunnerDeps,
} from './services/mailRulesRunner'
import { startBodyIndexer, stopBodyIndexer, resetBodyIndexerBackoff, waitForIdle as waitForBodyIndexerIdle, type FetchBodyFn } from './services/bodyIndexer'
import { startFtsMaintenance } from './services/ftsMaintenance'
import { replayOfflineOps } from './services/offlineReplay'
import { searchWorkerClient } from './services/searchWorkerClient'
import { resolveSelfUpdateSupport, decideUpdateIpcGate, classifyUpdateError, detectUpdateChannel, type SystemInfo } from './services/updateCheck'
import { computeOfflineSinceDate } from './services/offlineRetention'
import { reportSentCopyAppendFailure, buildSentCopyAppendDiag } from './services/sentCopyFailure'
import { getOutlookAccessToken, getOutlookGraphSendAccessToken, clearOutlookTokenCache, forceRefreshOutlookAccessToken, connectOutlookAccount, registerMissingCredentialsReporter } from './services/outlookOAuthService'
import { secretStore } from './services/secretStore'
import { sendMailViaGraph } from '../packages/net/graphSend'
import { registerAuthErrorHandler, unregisterAuthErrorHandler, registerCertErrorHandler, unregisterCertErrorHandler, classifyImapError, registerConnectionOutcomeHandler, registerAccountGenerationProvider } from '../packages/net/imap'
import { verifyCertTrust } from '../packages/net/tls'
import { initCertRecovery } from './services/certRecovery'
import { initAccountAuthState, imapAuthNotConfiguredError, authNotConfiguredError } from './services/accountAuthState'
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

// §2.82 — telemetry consent. Decision logic is pure (electron/telemetryConsent.ts);
// persistence, migration and the two IPC channels live in the service.
import { applyAboutToggleFromOrigin, isTelemetryAllowed, clampTelemetryForRenderer } from './telemetryConsent'
import { initTelemetryConsent } from './services/telemetryConsentService'
import { attachContextMenu } from './services/contextMenu'
// §2.103 — spell checking. Every decision about the Chromium spellchecker
// (which languages, whether it is armed at all, and whether a dictionary may be
// fetched from a third-party CDN) lives in the service — it is the single
// writer of that state, the way windowRescue.ts is for window geometry. main
// only wires it: at startup, per window, on save (hotspot policy).
import {
  initSpellcheck, applySpellcheckToWindow, reapplySpellcheck,
  ensureSpellcheckDictionariesApproved, applySpellcheckDecision,
  normalizeSpellcheckLanguages, spellcheckDeclinedMessage,
} from './services/spellcheck'
// §2.99 — tray, background operation and main-process new-mail notifications.
// Every decision lives in these services; main only wires them (hotspot policy).
import {
  initBackgroundMail, initTrayIntegration, applyTrayEnabled, syncLaunchAtLogin,
  shouldKeepRunningInBackground, noteHiddenToTray, noteFolderSynced, invalidateUnreadBadge,
  forgetAccountBackgroundState,
} from './services/backgroundMail'
import { disarmTray, shutdownTray } from './services/tray'
import type { MailRef } from './services/desktopNotifications'
// §2.119 — human confirmation before the address AI requests (and with them
// the user's API key) are sent to changes. Both renderer routes that can move
// it — `settings:save` and the `ai:checkAuth` overrides — go through this.
import {
  ensureAiDestinationApproved,
  aiDestinationRejectionMessage,
} from './services/aiDestinationGuard'
import {
  aiDestinationOverridesSchema,
  resolveRequestedAiDestination,
  applyAiDestinationOverrides,
  applyAiDestinationDecision,
  withEffectiveProvider,
} from './services/aiDestination'

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
    // §2.82: the About switch alone is not permission — an active consent
    // record for the current disclosure version must back it.
    setSentryUserEnabled(isTelemetryAllowed(s))
    // Attach the stable pseudonymous install identity as soon as settings
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
startMainLoopFreezeWatchdog({ drainSlowSql: takeSlowSqlSamples })

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
/**
 * §2.145 — options of one `net:messageDetails` call.
 *
 * Deliberately an OPTION on the existing channel rather than a channel of its
 * own: "show the rest of this message" is the same read, at a raised body
 * limit, and a second whitelisted channel would widen the preload surface for
 * nothing (CLAUDE.md §5 — the IPC whitelist is a security boundary).
 *
 * `full` is the raised SOFT tier, and only that. It cannot lift the hard cap:
 * that decision is taken in packages/net/eml.ts before any dispatch and takes
 * no option from anybody, so a compromised renderer setting `full: true` on
 * every open buys a bigger body on messages it could already read and nothing
 * at all on the ones the hard cap refused. `.strict()` so a future field cannot
 * arrive unnoticed, `.optional()` so every existing three-argument call site
 * keeps working unchanged.
 */
const messageDetailsOptionsSchema = z
  .object({ full: z.boolean().optional() })
  .strict()
  .optional()
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

/**
 * The e2e opt-in. Derived by `computeIsE2E` — env flag AND unpackaged build,
 * never the env flag alone; see `electron/e2eFlag.ts` for the threat model and
 * `electron/e2eFlag.test.ts` for the truth table.
 *
 * Consequence worth stating once, because ~60 branches below depend on it: on
 * a packaged build this is `false` no matter what the environment says, so a
 * shipped app always takes the production path — real accounts, real IMAP,
 * real confirmation dialogs, auto-updater configured. Nothing here needs to
 * re-check `app.isPackaged` for that guarantee.
 */
const IS_E2E = computeIsE2E(process.env, app.isPackaged)

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
 * The explicit `app.isPackaged` branch is kept even though `IS_E2E` now folds
 * the same condition in (see `computeIsE2E`): it is what distinguishes "shipped
 * build was asked for a fixture channel" — the anomaly worth a Sentry event —
 * from the ordinary dev-without-opt-in refusal, and it keeps this guard correct
 * on its own terms rather than by reference to how the flag happens to be
 * derived today.
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
  /**
   * §2.145 — this fixture has real RFC822 bytes on disk (written by
   * `e2e:injectMail` through `saveEml`), so `net:messageDetails` must serve it
   * from the PRODUCTION pipeline instead of synthesising a body. Set by the
   * injection handler only; there is no way to set it from a payload field, so
   * a fixture can never claim to be EML-backed without bytes having been
   * written for it.
   */
  emlFixture?: true
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
  /** §2.128 e2e coverage — a message whose real-attachment count crosses the
   *  collapse ceiling (ATTACHMENT_COLLAPSED_LIMIT = 4), so the toggle/expand
   *  path is exercised end-to-end and not just at the unit level. */
  manyAttachmentsSubject: string
  manyAttachmentsBody: string
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
    manyAttachmentsSubject: 'E2E1: many attachments',
    manyAttachmentsBody: 'E2E test email with six real attachments for the collapse/expand check (account 1).',
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
    manyAttachmentsSubject: 'E2E1: письмо с множеством вложений',
    manyAttachmentsBody: 'Тестовое письмо с шестью настоящими вложениями для проверки сворачивания/раскрытия списка (аккаунт 1).',
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
    manyAttachmentsSubject: 'E2E1: nombreuses pieces jointes',
    manyAttachmentsBody: "E-mail de test E2E avec six pieces jointes reelles pour verifier le pliage/depliage (compte 1).",
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
    manyAttachmentsSubject: 'E2E1: viele Anhaenge',
    manyAttachmentsBody: 'E2E-Test-E-Mail mit sechs echten Anhaengen fuer den Einklapp-/Ausklapp-Test (Konto 1).',
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
    manyAttachmentsSubject: 'E2E1: muchos adjuntos',
    manyAttachmentsBody: 'Correo de prueba E2E con seis adjuntos reales para comprobar el plegado/despliegue (cuenta 1).',
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
    manyAttachmentsSubject: 'E2E1: molti allegati',
    manyAttachmentsBody: 'Email di test E2E con sei allegati reali per verificare il collasso/espansione (account 1).',
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
          // §2.128 e2e coverage — six real attachments cross the collapse
          // ceiling (ATTACHMENT_COLLAPSED_LIMIT = 4 in
          // src/utils/attachmentList.ts), so this fixture proves the block
          // stays capped, the body stays readable, and expand reveals all six
          // through a real IPC round trip — not just the unit-level model.
          uid: 105,
          from: 'dave@example.test',
          to: 'e2e1@example.test',
          subject: t.manyAttachmentsSubject,
          // NOTE: this date does NOT control e2e list ordering. The real
          // `net:inboxSummaries`/`net:folderPage` handlers below query the DB,
          // which does sort `ORDER BY date DESC` (packages/db/index.ts), but
          // the IS_E2E branch of those same handlers builds the list straight
          // from this in-memory array sorted by `uid DESC` — date is stored
          // for display only and never consulted for order. So this fixture
          // sorts by uid (105) relative to the other account-1 messages
          // regardless of what date it carries. Tests that need to open a
          // specific fixture message must select it by subject (see
          // attachment-list.spec.ts, print.spec.ts) rather than relying on
          // position in the list.
          date: '2026-02-07T23:50:00.000Z',
          unread: false,
          flagged: false,
          hasAttachments: true,
          text: t.manyAttachmentsBody,
          attachments: [
            { part: '2', disposition: 'attachment', contentType: 'application/pdf', cid: undefined, filename: 'invoice-01.pdf', size: 10240 },
            { part: '3', disposition: 'attachment', contentType: 'application/pdf', cid: undefined, filename: 'invoice-02.pdf', size: 20480 },
            { part: '4', disposition: 'attachment', contentType: 'image/jpeg', cid: undefined, filename: 'photo-01.jpg', size: 51200 },
            { part: '5', disposition: 'attachment', contentType: 'image/jpeg', cid: undefined, filename: 'photo-02.jpg', size: 61440 },
            { part: '6', disposition: 'attachment', contentType: 'application/zip', cid: undefined, filename: 'archive.zip', size: 102400 },
            { part: '7', disposition: 'attachment', contentType: 'text/plain', cid: undefined, filename: 'notes.txt', size: 512 },
          ],
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

/**
 * §2.145 — bounds on an EML-backed e2e fixture.
 *
 * `E2E_MAX_FIXTURE_EML_BYTES` stands ABOVE `MAX_EML_PARSE_BYTES` (100 MiB) on
 * purpose: a spec has to be able to express a message on either side of the
 * hard cap, including the boundary itself. It is bounded all the same, because
 * "test scaffolding" is not a reason to let a caller ask for an unbounded write
 * — see the security note on `writeE2EFixtureEml`.
 *
 * The base64 bound is stated in CHARACTERS because that is what the schema
 * measures; 8 MiB of characters is ~6 MiB of bytes, far above any fixture whose
 * exact CONTENT matters (a specific MIME shape), and a size-only fixture uses
 * `emlPadToBytes`, which moves no bytes across IPC at all.
 */
const E2E_MAX_FIXTURE_EML_BYTES = 200 * 1024 * 1024
const E2E_MAX_FIXTURE_EML_BASE64_CHARS = 8 * 1024 * 1024

/**
 * Write the raw bytes of an EML-backed e2e fixture to the message cache.
 *
 * SECURITY — the whole reason this is shaped the way it is. The renderer
 * supplies CONTENT and an identity (accountId / folder / uid); it never
 * supplies a PATH. The path is derived main-side by `saveEml`, under the app's
 * own mail directory. The one place renderer input reaches the filesystem is
 * the folder segment, so `.` and `..` are refused outright: `saveEml` encodes
 * the folder with `encodeURIComponent`, which turns `/` into `%2F` and so
 * cannot produce a nested path, but leaves those two literals alone — a bounded
 * one-level move within the mail directory rather than an escape, and still not
 * something this handler has any reason to allow.
 *
 * The rest of the exposure is the same as every other `e2e:*` handler and is
 * governed by `assertE2EHandlerAllowed`: unreachable in a packaged build (which
 * also reports the attempt to Sentry) and unreachable in an unpackaged build
 * without the opt-in env var. In a dev or e2e build a compromised renderer can
 * use it to write bounded attacker-chosen bytes into the EML cache for a
 * message id of its choosing — which is strictly less than `e2e:injectMail`
 * already grants (making arbitrary mail appear in the UI as if it came from the
 * server), and both are confined to a build the user is not running.
 */
function writeE2EFixtureEml(
  accountId: number,
  folder: string,
  uid: number,
  mail: E2EMail,
  base64?: string,
  padToBytes?: number,
): void {
  if (folder === '.' || folder === '..') {
    throw new Error('e2e:injectMail: folder must not be a path segment')
  }
  const raw = base64 !== undefined
    ? Buffer.from(base64, 'base64')
    : buildE2EFixtureEml(mail, padToBytes ?? 0)
  saveEml(accountId, folder, uid, raw)
}

/**
 * Synthesise a valid RFC822 message of EXACTLY `targetBytes`.
 *
 * Exact, not approximate: a cap spec's whole point is which side of a limit the
 * message falls on, and "about 100 MiB" cannot express the boundary case. The
 * arithmetic is therefore trivial by construction — headers, then a pad of
 * `targetBytes - headers.length`.
 *
 * CONTRACT: a target smaller than the header block is REFUSED, not rounded up.
 * There is no valid message shorter than its own headers, so the honest answers
 * are "refuse" or "return something larger than you asked for" — and the second
 * is the worse one here, because the only reason to name an exact size is to
 * sit on a specific side of a cap. A spec that asks for 40 bytes and silently
 * receives 130 would be testing a message it did not describe.
 *
 * Header values are stripped of CR and LF: they come from the fixture payload,
 * and a stray newline would silently terminate the header block early, leaving
 * the spec debugging a message that is malformed for a reason nothing states.
 */
function buildE2EFixtureEml(mail: E2EMail, targetBytes: number): Buffer {
  const clean = (v: string | undefined) => (v ?? '').replace(/[\r\n]/g, ' ')
  const headers = Buffer.from([
    `From: ${clean(mail.from)}`,
    `To: ${clean(mail.to)}`,
    `Subject: ${clean(mail.subject)}`,
    `Date: ${clean(mail.date)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    '',
  ].join('\r\n'), 'utf8')
  if (targetBytes < headers.length) {
    throw new Error(
      `e2e:injectMail: emlPadToBytes must be at least ${headers.length} for this fixture's headers`,
    )
  }
  if (targetBytes === headers.length) return headers
  // Single-byte ASCII, so the byte count and the decoded character count agree
  // — a spec reasoning about the soft cap should not also have to reason about
  // UTF-8 expansion.
  return Buffer.concat([headers, Buffer.alloc(targetBytes - headers.length, 0x78)])
}

function e2eFindInAnyBox(accountId: number, uid: number): E2EMail | undefined {
  for (const box of Object.values(e2eBoxes(accountId))) {
    const found = box.find(m => m.uid === uid)
    if (found) return found
  }
  return undefined
}

/**
 * Recipient-side display parsing for e2e fixtures. NOT for senders: the sender
 * split goes through `senderPartsFromHeader` (electron/e2eSenderParts.ts), which
 * delegates the "what may become an address" verdict to the production parser.
 * The `includes('@')` fallback below stays only because a recipient list is not
 * an identity an attacker steers rules with — see §2.172 followup.
 */
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

// Linux: the GTK program class, used by the toolkit windows Chromium creates on
// our behalf (the legacy tray icon plug among them).
//
// It is NOT what associates our window with the launcher, despite what this
// comment used to claim: measured on Ubuntu GNOME 46 / X11, the main window's
// WM_CLASS ignored this switch entirely and followed `desktopName` from
// package.json instead — which is where that association is now pinned (see
// electron-builder.json5, `linux.syncDesktopName`). The value is derived from
// the same app name rather than spelled out again, so there is one name in the
// session and not two. Skip in E2E to avoid interfering with parallel test
// isolation.
if (process.platform === 'linux' && !IS_E2E) {
  app.commandLine.appendSwitch('class', app.getName())
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

/**
 * Per-window link routing + native context menu wiring.
 *
 * @param opts.routesMailLinks true only for windows whose renderer subscribes
 *   to `mail:link` (the main window via App.tsx and the standalone message
 *   window via MailWindow.tsx — both through `useMailLinkClick`). It gates the
 *   context menu's "open link in browser" item: on a surface with no consumer
 *   the item would be a silent no-op, and the honest answer is not to offer it
 *   rather than to open a second, unguarded route to the browser.
 */
function configureExternalLinks(w: BrowserWindow, opts: { routesMailLinks: boolean }) {
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

  // §2.93(a) — the app's ONLY native context menu (Electron draws none of its
  // own, and Menu.setApplicationMenu(null) removes the application menu too).
  // Wired here, and only here, because this is where the per-window
  // `mail:link` funnel is built: the menu's "open link in browser" hands the
  // link to `emitMailLink` — the same route a click takes — instead of
  // reaching shell.openExternal on a second path that would drift from it.
  // Menu construction and every routing decision live in the service; main
  // keeps the wiring only (CLAUDE.md §5 hotspot policy).
  attachContextMenu(w, {
    getLanguage: () => getSettings().language ?? 'en',
    emitMailLink: opts.routesMailLinks ? emitMailLink : undefined,
  })

  // §2.103 — the spellchecker policy is applied to this window's session too,
  // not only to the default session at startup. Today every window shares
  // `session.defaultSession`, so this is normally a repeat; the invariant being
  // held is that no window exists whose session was configured by nobody —
  // Chromium's own default there is "armed, OS locale, download the dictionary".
  applySpellcheckToWindow(w)
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
 * Pass the pseudonymous install-id hash into the renderer process via
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
 * Propagate the effective telemetry permission to the renderer before its
 * Sentry.init runs. Not the persisted `sentryEnabled` field: §2.82 requires an
 * active consent record for the current disclosure version behind it
 * (`isTelemetryAllowed`), so an install that has never been asked yields
 * `false` even though the settings schema defaults the field to `true`.
 * Without this argument there is a startup window in which the renderer uses
 * its own "enabled" default and can emit events (and attach the stable
 * pseudonymous install-id) before anyone has answered. The renderer reads the
 * flag synchronously from process.argv in preload.
 *
 * Tri-state so the renderer can apply symmetric fail-closed semantics:
 *   --sentry-enabled=true  → consent on record, send
 *   --sentry-enabled=false → refused, withdrawn, stale, or never asked
 *   (absent)               → unknown, renderer treats as off
 *
 * If getSettings() throws (store broken, corrupted JSON), we emit neither
 * token and let the renderer default to fail-closed. Same policy as
 * sentryPreflight.ts for the main process: prefer silent loss of events
 * over silent leakage when we cannot verify the user's decision.
 */
function sentryEnabledArgs(): string[] {
  try {
    return [isTelemetryAllowed(getSettings()) ? '--sentry-enabled=true' : '--sentry-enabled=false']
  } catch {
    return []
  }
}

function childBrowserArgs(): string[] {
  return [...themeArgs(), ...installIdArgs(), ...sentryEnabledArgs()]
}

/**
 * Corner shape for the frameless windows this app creates. **Linux only** —
 * on every other platform the key is deliberately absent so the platform
 * default applies. Do NOT "tidy" this back into an unconditional
 * `roundedCorners: false`; the asymmetry is the point.
 *
 * WHY LINUX OPTS OUT. Electron 43 flipped the `roundedCorners` default to
 * `true` and extended it to Linux (in 40 the option was `@platform
 * darwin,win32` and Linux frameless windows were always square). A `frame:
 * false` window gets no WM resize borders on Linux, so resizing is emulated in
 * the renderer by `src/components/ResizeEdges.tsx`: 5px edge strips plus 8x8px
 * corner squares pinned to the window's extreme corners. A client-side-
 * decoration corner radius (typically 8-12px) covers exactly that area, so the
 * diagonal `sw`/`se` handles would be clipped away on the one platform that
 * depends on them, and the edge strips would lose their ends. The square shape
 * is also what the window backgrounds in `src/App.css` and `themeBg()` are
 * drawn against.
 *
 * WHY macOS IS LEFT ALONE. Setting `roundedCorners: false` on a frameless
 * window there is not cosmetic: `NativeWindowMac` runs `SetBorderless(true)`,
 * which clears `NSWindowStyleMaskTitled` — the AppKit prerequisite for native
 * fullscreen. Electron's own docs said so outright until ~v25 ("Setting this
 * property to `false` will prevent the window from being fullscreenable"); the
 * sentence was dropped from the docs later, but the code path is unchanged in
 * 43.3.0. This app treats fullscreen as a valid window state — see
 * `electron/services/windowRescue.ts`, which no-ops on it — and macOS rounding
 * was the native appearance before this upgrade, causing no problem.
 * `ResizeEdges` is inert off Linux anyway (`if (!isLinux || maximized) return
 * null`), so there is nothing to win and a fullscreen regression to lose.
 *
 * WHY WINDOWS IS LEFT ALONE. Rounding there predates Electron 43 (Windows 11
 * build 22000+; older builds ignore the option) and is the native look.
 *
 * Rounding the Linux windows is a deliberate UI change that has to come with
 * reshaped resize handles (Track C), not a side effect of a version bump.
 */
function framelessCornerOptions(): Pick<Electron.BrowserWindowConstructorOptions, 'roundedCorners'> {
  return process.platform === 'linux' ? { roundedCorners: false } : {}
}

/**
 * §3.3.B4.f6 — windows created WITHOUT a WM parent (Compose, standalone
 * message windows; see `childWindowOptions.ts` for why).
 *
 * Electron closes a window's children when the window itself closes. Since
 * these two kinds no longer are children, that teardown has to happen here,
 * otherwise closing the main window would leave orphaned windows behind —
 * on Linux/Windows they would keep `window-all-closed` from firing and the
 * app would never quit; on macOS they would outlive the session the user
 * meant to end. Tearing them down explicitly keeps the pre-unparenting
 * lifetime.
 */
const standaloneChildWindows = new Set<BrowserWindow>()

function registerStandaloneChildWindow(child: BrowserWindow): void {
  standaloneChildWindows.add(child)
  child.on('closed', () => { standaloneChildWindows.delete(child) })
}

/**
 * Tear down every standalone window. Called when the main window closes, i.e.
 * at the end of the session.
 *
 * `destroy()`, not `close()`, and that is a security property rather than a
 * style choice. `close()` is a REQUEST: it runs the page's unload handlers and
 * a `beforeunload` handler can cancel it outright. The lifetime this function
 * exists to reproduce — Electron's own teardown of WM children — is not
 * cancellable, and neither is the guarantee the docs make ("standalone windows
 * are destroyed with the main window"). A window whose renderer has been
 * compromised (email-borne XSS, prompt injection, a rogue MCP tool) would
 * otherwise survive the session it belongs to, keeping a live preload bridge —
 * and on Linux/Windows keeping `window-all-closed` from firing, so the app
 * would never quit and the survivor would be invisible to the user.
 *
 * Nothing legitimate is lost: no window in this app registers `beforeunload`
 * or an unload-time flush, so an honest window cannot tell the two apart.
 * Compose persists its draft on a typing debounce (localStorage + `net:saveDraft`
 * in `src/windows/Compose.tsx`); `close()` would not have saved anything extra,
 * because there is no unload handler for it to run.
 *
 * `destroy()` still emits `closed`, so each window's registry entry is removed
 * exactly as on a normal close.
 */
function closeStandaloneChildWindows(): void {
  // Snapshot: teardown synchronously mutates the set via the `closed` listener.
  for (const child of [...standaloneChildWindows]) {
    // A window torn down through another path is already gone; calling into it
    // would throw and abandon the rest of the snapshot.
    if (!child.isDestroyed()) child.destroy()
  }
}

/**
 * Initial placement for a standalone window: centred over the main window and
 * clamped to its display's work area. The window manager did this for us while
 * these windows were transient children; a top-level window would otherwise
 * land on the platform-default display, which on a multi-monitor setup need
 * not be the one the main window is on. Creation-time placement only — bounds
 * corrections stay with the windowRescue single writer.
 *
 * THE ONLY placement path for standalone windows — Compose and the standalone
 * message window both go through it. The message window used to have its own
 * `offsetFromMainWindow()` (place to the right of main, else inset), which
 * picked the display by testing which work area contained the main window's
 * top-left corner and never clamped horizontally; a main window wider than the
 * work area therefore pushed the message window off screen. `screen
 * .getDisplayMatching()` picks by largest overlap instead, and `centerOverRect`
 * clamps on both axes.
 *
 * Successive windows cascade by a small diagonal step so several open message
 * windows do not land on the same pixel (they are deduplicated per message, not
 * globally). The step count is the number of standalone windows currently open,
 * which is exactly what `standaloneChildWindows` tracks — the registry is read
 * before the new window registers itself, so the first one is centred exactly.
 */
function centerOverMainWindow(width: number, height: number): { x?: number; y?: number } {
  if (!win || win.isDestroyed()) return {}
  const main = win.getBounds()
  const workArea = screen.getDisplayMatching(main).workArea
  return centerOverRect(main, workArea, { width, height }, standaloneChildWindows.size)
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
    ...framelessCornerOptions(),
    show: false,
    backgroundColor: themeBg(),
    title: 'MailCopilot',
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
  win.on('close', (event) => {
    if (win && !win.isDestroyed()) saveWindowState(win)
    // §2.99 — close to tray. Gated on the preference AND on the icon object
    // existing, and on nothing else: the §2.228 desktop-side confirmation was
    // removed because hiding is recoverable without any icon at all. There are
    // two routes back and between them they cover every platform we ship:
    // relaunching from the launcher on Linux/Windows (`second-instance` above)
    // and clicking the dock icon on macOS (`activate` below) — both go through
    // `showMainWindow()`, which shows and focuses a hidden window. The tray menu
    // carries Quit on top of that. `shuttingDown` keeps app.quit()/updater
    // teardown on the normal path.
    if (!shuttingDown && shouldKeepRunningInBackground() && win && !win.isDestroyed()) {
      event.preventDefault()
      win.hide()
      noteHiddenToTray()
    }
  })
  const rememberNormalBounds = () => {
    if (win && !win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) {
      (win as unknown as { _lastBounds?: Electron.Rectangle })._lastBounds = win.getBounds()
    }
  }
  win.on('resize', rememberNormalBounds)
  win.on('move', rememberNormalBounds)

  // §3.3.B4.f6 — Compose and standalone message windows are no longer WM
  // children of this window, so Electron does not tear them down with it.
  // Destroy them here to preserve the previous lifetime — unconditionally, the
  // way the WM teardown was (see `closeStandaloneChildWindows`).
  win.on('closed', () => { closeStandaloneChildWindows() })

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

  // Main window: App.tsx mounts useMailLinkClick, so `mail:link` has a
  // consumer and the context menu may offer "open link in browser".
  configureExternalLinks(win, { routesMailLinks: true })

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
  // §2.99 — same gate as the close handler: the preference plus a tray icon
  // object of ours. That icon is the immediate, visible thing a user who just
  // closed the window can reach for — it is NOT what makes the app recoverable.
  // Coming back is guaranteed behind it either way (relaunching on
  // Linux/Windows, dock activation on macOS, both via `showMainWindow()`), so
  // the icon is why hiding is not a surprise, not why it is reversible. Every
  // other path quits exactly as before.
  if (shouldKeepRunningInBackground()) {
    win = null
    return
  }
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

/**
 * Per-step deadlines for the quit drain below.
 *
 * These five steps used to be awaited with no deadline at all, so one
 * unreachable IMAP server, one wedged worker thread or one MCP session that
 * never closes hung the quit forever — while the comments and the tests claimed
 * a bounded drain. A deadline here is an upper bound on how long a step may
 * HOLD THE QUIT, never a claim that the step finished.
 *
 * The IMAP figure is the established mail-client practice, not a guess: a
 * client sends LOGOUT on every connection, waits about a second WITHOUT
 * listening for the response, and closes. The close packets reach the server
 * ~0.8-1.2s later, by which time it has begun processing the LOGOUT. LOGOUT is
 * a courtesy — servers handle abrupt closes fine — so cutting the server off
 * after that second is the normal answer, not a cost being traded away.
 */
const TEARDOWN_DEADLINE_MS = {
  /** IMAP LOGOUT courtesy window (IDLE connection and the per-account pool
   *  alike). The pool logs its connections out through Promise.allSettled, so
   *  one dead server does not serialise behind another inside this budget. */
  imapLogout: 1_000,
  /** Search worker exit. Deliberately SHORTER than the client's own 5s exit
   *  wait: the worker is a read-only FTS query thread holding nothing
   *  un-persisted, so its 5s would dominate the drain budget for a thread whose
   *  loss costs exactly nothing — process exit reaps it either way. */
  searchWorker: 2_000,
  /** MCP export server. `http.Server.close()` resolves only once every open
   *  connection has ended, and a single idle SSE session on loopback holds one
   *  open indefinitely; the listening socket is released at process exit. */
  mcpExportStop: 1_000,
  /** MCP client transports (child processes / SSE). Killing a child that will
   *  not close politely is process exit's job, not the drain's. */
  mcpClientDisconnect: 1_000,
} as const

/**
 * Run one teardown step under a hard deadline. Never throws and never rejects:
 * everything after it in the drain — the WAL checkpoint, the tray release, the
 * exit — must stay reachable whatever a socket, a worker thread or a child
 * process decides to do.
 *
 * `Promise.race` does not cancel the loser; it only stops us waiting for it.
 * That is exactly the "send the courtesy, then close" model above.
 *
 * Logs carry the step label (ours) and never third-party text.
 */
async function drainStep(
  label: string,
  deadlineMs: number,
  run: () => Promise<unknown>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), deadlineMs)
      timer.unref?.()
    })
    const started = run().then(() => 'done' as const, () => 'failed' as const)
    const outcome = await Promise.race([started, deadline])
    if (outcome === 'timeout') {
      logMain.warn('shutdown step exceeded its deadline — abandoning it and continuing the drain', { step: label, deadlineMs })
    } else if (outcome === 'failed') {
      logMain.warn('shutdown step failed', { step: label })
    }
  } catch {
    // `run()` threw synchronously before producing a promise.
    logMain.warn('shutdown step failed', { step: label })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Guard flag so before-quit runs its async shutdown exactly once. The
// handler defers the real quit with event.preventDefault(), drains the
// background services, flushes telemetry + Sentry and then calls
// `app.exit(0)` — NOT app.quit(). The difference is the whole point of this
// gate: app.exit skips before-quit entirely, so the terminal call cannot
// re-enter this handler, while a second app.quit() would (and the re-entry
// branch below correctly preventDefaults it, which would defer the quit
// forever). The flag covers the OTHER way in: an external quit or a second
// SIGTERM arriving while the first drain is still in flight.
let shuttingDown = false
app.on('before-quit', (event) => {
  // §2.99 — DISARM here, DESTROY at the very end of the drain below.
  //
  // Review L1's guarantee is disarming, not destroying: `disarmTray()` closes
  // the unread-refresh gate so a sync pass still draining cannot re-arm the
  // debounce and paint into a half-torn-down app. The icon itself now survives
  // the whole drain (bounded at ~28s of explicit deadlines, plus one
  // synchronous local-disk WAL checkpoint) wearing a "quitting" tooltip —
  // destroying it here made Exit look like it had only removed the icon while
  // the window sat there.
  //
  // That ~28s is the sum of every awaited deadline below and nothing else:
  // 2×1s IMAP logout + 2s search worker + 1s MCP export + 1s MCP clients
  // (TEARDOWN_DEADLINE_MS) + 10s body indexer + 10s periodic sync + 150ms
  // post-idle drain + 1.5s Sentry flush = 27.65s. Every `await` in this handler
  // is one of those; `main.backgroundMail.test.ts` fails if a new unbounded one
  // appears or if this figure stops matching the constants.
  //
  // Placed above the re-entrancy guard and above the first `await` on purpose:
  // the disarm then happens in the same synchronous turn as the quit itself, so
  // nothing depends on which of this file's two `before-quit` listeners Electron
  // calls first, and no timer callback can interleave ahead of it. Idempotent.
  disarmTray()
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
      // §2.82: measured from the telemetry session origin, not from process
      // start. For a user who consented mid-session those differ, and
      // reporting full uptime would describe a period they had not agreed to
      // be measured over. Identical to `sessionStartedAtMs` when consent was
      // already on record at launch.
      const durMs = Date.now() - telemetryCollectionStartedAtMs()
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
    // Bounded teardown of the network- and process-facing services. Every one
    // of these can wait on something outside this process, so every one of them
    // gets a deadline (TEARDOWN_DEADLINE_MS, justified there). `drainStep`
    // never throws, so a step that fails or overruns costs its budget and
    // nothing else.
    //
    // Try to stop background IMAP IDLE connection.
    await drainStep('imap-idle-logout', TEARDOWN_DEADLINE_MS.imapLogout, () => stopIdle())
    // Close per-account IMAP connections (offline sync).
    await drainStep('imap-pool-logout', TEARDOWN_DEADLINE_MS.imapLogout, () => disconnectAllPerAccount())
    // Stop background search worker.
    await drainStep('search-worker-shutdown', TEARDOWN_DEADLINE_MS.searchWorker, () => searchWorkerClient.shutdown())
    // Stop MCP export server if running.
    const exportServer = mcpExportServer
    if (exportServer?.status === 'running') {
      await drainStep('mcp-export-stop', TEARDOWN_DEADLINE_MS.mcpExportStop, () => exportServer.stop())
    }
    // Disconnect all MCP client connections.
    const clientManager = mcpClientManager
    if (clientManager) {
      await drainStep('mcp-clients-disconnect', TEARDOWN_DEADLINE_MS.mcpClientDisconnect, () => clientManager.disconnectAll())
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
    // Wrapped: everything after this point — the drain, the checkpoint and the
    // tray release — is unreachable if this throws, and the promise would
    // simply reject, leaving the app running with no visible progress at all.
    try { shutdownDbWritingTimers() } catch { /* ignore */ }
    // Await in-flight body indexer + periodic sync. Individual 10s cap:
    // IMAP socket timeout is 30s and a stuck fetch on one path should not
    // deny the other its drain budget. These two together are ~20s worst
    // case — the bound on the WHOLE drain is stated at the top of this
    // handler. If either exceeds the cap we log and fall through — SQLite auto-replays
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
    // Short post-idle drain: enough for a short single-statement write that
    // fired just before shutdownDbWritingTimers() (a snooze/follow-up tick that
    // only touches the DB) to reach its commit.
    //
    // What it deliberately does NOT wait for: an in-flight send. The send-queue
    // callback is `void processSendQueue()` — fire-and-forget — and inside it
    // `sendMailWithAccountConfig()` awaits SMTP, so a send in progress here can
    // still be seconds from `markSendQueueSent()`. We do not await it and do not
    // give it a deadline of its own: the row is already claimed as `sending` and
    // is durable in SQLite, `listDueSendQueue` in packages/db returns rows stuck
    // in `sending` for over two minutes back to `queued`, and the queue is
    // processed at startup. Quitting mid-send therefore costs a delay, not the
    // message — the ordinary outbox model. (The residual is at-least-once
    // delivery if the server accepted a message we never marked sent; that
    // predates this handler and is out of its scope.)
    //
    // 150ms, i.e. a bounded courtesy, not a guarantee.
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
    // Ordered after stopIdle/disconnectAllPerAccount/searchWorkerClient so that
    // as much as possible has already committed — wal_checkpoint returns busy=1
    // if a reader holds a snapshot, and a checkpoint that reclaims nothing is
    // the failure mode we are avoiding.
    //
    // It is NOT true that no other writer can be running by now, and the code
    // must not be read as if it were: `drainStep` races a deadline and does not
    // cancel the loser, so a step that timed out is still executing, and a send
    // or a body-indexer pass that overran its cap likewise keeps going. What we
    // rely on instead:
    //   - Those writers cannot interleave WITH the checkpoint. Their DB work is
    //     synchronous better-sqlite3 on this same main thread; the checkpoint is
    //     one synchronous call. Whatever they do lands strictly before or after
    //     it, never inside it, so no transaction is torn.
    //   - A commit that lands AFTER the checkpoint simply appends frames to a
    //     freshly truncated WAL. That is a normal, recoverable state: SQLite
    //     replays those frames on next open. It costs us reclamation, not data.
    //   - Work terminated by `app.exit(0)` before its commit stays uncommitted,
    //     which is the same outcome as a power loss at that instant and is what
    //     the queue tables are designed for (see the send-queue note above).
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
    // §2.99 — the last visible act. The icon was kept alive through the whole
    // drain so that "the icon is there" kept meaning "the app is still doing
    // something". It is released now because everything we said we would wait
    // for has been waited for, each within its own deadline — not because
    // nothing is left running: a `drainStep` loser that overran its cap, or a
    // send still awaiting SMTP, is knowingly abandoned and will be terminated
    // by `app.exit(0)` on the next line (why that is acceptable: the checkpoint
    // note above, and the send-queue note further up). Keeping the icon past
    // that point would be the icon lying in the other direction.
    //
    // This is the only place it can be released on this path: `app.exit(0)`
    // below emits no further lifecycle events, and no other exit route creates
    // a tray in the first place (the single-instance-lock `process.exit(0)`
    // runs before any icon).
    shutdownTray()
    // app.exit(0) — bypasses before-quit. The drain above is complete; we
    // just want process exit. Using app.quit() here would re-enter the
    // before-quit handler whose re-entry guard (Codex §2.15-bis review
    // iteration 2 Medium #1) correctly preventDefaults a second entry,
    // creating an infinite-defer loop where the real quit is canceled.
    app.exit(0)
  })()
})

// §2.99 — macOS route back, and the reason it must NOT be the stock recipe.
//
// On macOS a relaunch of a running app raises `activate` (dock icon, Spotlight,
// `open -a`); `second-instance` never fires there at all. The boilerplate this
// replaces — `if (BrowserWindow.getAllWindows().length === 0) createWindow()` —
// is exactly wrong for close-to-tray: a window hidden by it still EXISTS, so
// the count is 1, the condition is false, and clicking the dock icon did
// nothing whatsoever. The window was unreachable, which is the premise the
// removal of the §2.228 close gate rests on.
//
// `showMainWindow()` covers both cases the count was standing in for (create
// when there is no window) and the one it missed (restore/show/focus the one
// there is), and is the same helper `second-instance` and the tray Open item
// use.
app.on('activate', () => {
  showMainWindow()
})

// Session start time. featureReach lives in its own module so both the
// main-side recordEvent/recordHistogram path (via metrics.ts) and the
// IPC-bridged renderer events write to the same bitmap.
const sessionStartedAtMs = Date.now()
let startupRecorded = false

app.whenReady().then(() => {
  // §2.103 — BEFORE the first window loads content, and that order is the
  // whole point: Electron populates an empty spellchecker language list from
  // the OS locale on launch, and the hunspell dictionary for it is fetched from
  // a third-party CDN the moment a field is checked. Arriving after the window
  // would leave exactly the silent request this feature exists to remove.
  initSpellcheck({
    getSettings,
    saveSettings,
    getLanguage: () => getSettings().language ?? 'en',
    // The harness never arms the checker: a test must not make the machine
    // fetch dictionaries from a third party, and no spec can assert Chromium's
    // own suggestion quality anyway. Settings, consent and the menu plan still
    // run under e2e — only the session application is withheld.
    isE2E: () => IS_E2E,
  })
}).then(createWindow).then(() => {
  // Single writer for window-geometry corrections (CLAUDE.md §5 "Window
  // management"). Rescue passes are deferred while the user drags the
  // custom frameless edge-resize (resizeState is the module-level state
  // behind win:startResize below); a flag stuck past the deferral cap is
  // force-stopped so its 16ms interval cannot race the rescue writer.
  initWindowRescue({
    isInteractiveOperationActive: () => resizeState !== null,
    stopInteractiveOperation: () => stopActiveResize(),
  })
  // §2.99 — tray + autostart. A no-op under e2e (no tray host in the test
  // display, and close-to-tray must not change how specs close windows).
  initTrayIntegration({
    iconPath: path.join(process.env.VITE_PUBLIC, 'icon.png'),
    onOpen: () => showMainWindow(),
    onCompose: () => openComposeWindow(),
    onCheckMail: () => { void runPeriodicSync() },
    getMainWindow: () => (win && !win.isDestroyed() ? win : null),
  })
  // Emit app.session_started. It is one of only three events that carry the
  // install_id_hash TAG (with session_ended and session_summary) — a
  // cardinality rule, not an unlinkability one: the same hash is attached
  // SDK-wide as the Sentry user.id. See electron/installId.ts.
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
// §2.19 — module-level self-update capability, resolved once at startup so
// the `update:systemInfo` / `update:check` IPC handlers can return it
// without re-probing the filesystem per call. Constant for the lifetime of
// the process — neither the install path nor APPIMAGE changes at runtime.
//
// §2.58 — the predicate used to be `canWriteAppDir(process.execPath)`, which
// is the wrong question on Linux: on an AppImage `execPath` points inside the
// read-only `/tmp/.mount_*` FUSE mount (so self-update was permanently off on
// our main Linux artifact), and on .deb/.rpm the updater elevates via pkexec
// (so an admin-owned install dir is not a refusal we get to make). The target
// resolution lives in services/updateCheck.ts — main.ts only applies it.
const updateSelfUpdate = resolveSelfUpdateSupport({
  platform: process.platform,
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  env: process.env,
})
const updateCanSelfUpdate = updateSelfUpdate.canSelfUpdate

// §2.19 — track which trigger started the in-flight download so the
// `update.download_completed` / `download_failed` events carry the right
// `source` tag. Reset on every start; null between downloads.
let updateDownloadSource: 'auto' | 'manual' | null = null

// §2.19 — track whether we've already emitted update.download_started for
// the current download. electron-updater can fire `download-progress`
// many times per download but we only want to record `started` once.
let updateDownloadStartedEmitted = false

if (app.isPackaged && !IS_E2E) {
  // §2.19 — initial autoDownload state mirrors the persisted setting, but
  // only where an update can actually be applied in place. §2.58 — "can be
  // applied" is now the target-directory verdict above, not a probe of
  // process.execPath. Without this gate a persisted autoUpdateEnabled=true
  // would keep downloading artifacts that are KNOWN to be uninstallable (the
  // verdict is advisory, never a proof — see `isDirWritable`);
  // Settings → About shows the reason as a warning (the checkbox itself
  // stays operable, so the user is never locked out of the preference).
  // Runtime toggle via Settings → About is handled in onSettingsChangedMain.
  autoUpdater.autoDownload = getSettings().autoUpdateEnabled === true && updateCanSelfUpdate
  autoUpdater.autoInstallOnAppQuit = true
  // WARNING: secrets must not be stored in source code. If the update feed requires
  // headers (e.g., private GitLab), set the token via environment variable.
  const updateToken = process.env.MAILCOPILOT_UPDATE_TOKEN
  if (updateToken) autoUpdater.requestHeaders = { 'PRIVATE-TOKEN': updateToken }

  if (!updateCanSelfUpdate) {
    // §2.58 — log the enum pair only. `updateSelfUpdate.targetDir` is a user
    // path (`~/Applications/...`) and must not reach the local log file.
    logUpdate.info(`In-place self-update unavailable target=${updateSelfUpdate.kind} reason=${updateSelfUpdate.blockedReason ?? 'none'}`)
    // §2.19 iter3 — one-shot warning when the persisted setting is true but
    // in-place update is impossible. Helps diagnose user reports of
    // "update never applies": their setting says yes, but reality says no.
    if (getSettings().autoUpdateEnabled === true) {
      logUpdate.warn(`autoUpdateEnabled=true but self-update is unavailable (reason=${updateSelfUpdate.blockedReason ?? 'none'}) — autoDownload forced to false`)
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
  // §2.19 iter4 / §2.58 — refuse where in-place self-update is *known*
  // impossible. Policy, threat model and the reason .deb/.rpm is not gated
  // here live in `decideUpdateIpcGate` (services/updateCheck.ts); main.ts only
  // applies the decision.
  const downloadGate = decideUpdateIpcGate({ isPackaged: app.isPackaged, canSelfUpdate: updateCanSelfUpdate })
  if (!downloadGate.allowed) return downloadGate.reject
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
 * once on Settings open.
 *
 * PRIVACY — `installPath` (`process.execPath`) is intentionally a
 * machine-local path. On a user-local install (per-user Windows setup, an
 * `.app` under `~/Applications`, a build run from source, an unpacked tree in
 * $HOME) it contains the home directory and therefore the account name. On an
 * AppImage it does not: `execPath` resolves inside the read-only
 * `/tmp/.mount_*` FUSE mount, and the user-owned path lives in
 * `process.env.APPIMAGE`, which this payload never exposes. Showing the
 * running binary is the feature — the panel exists so the user can see which
 * one it is.
 *
 * The invariant is directional: this value only ever reaches the user's own
 * Settings renderer. It is never sent to Sentry, never put into telemetry and
 * never written to the local file log (update logging emits the bucketed
 * `error_class`, plus `err.code` on an install failure — a short updater/OS
 * code that stays in the file log and the native dialog). No second path is
 * exposed either: `updateSelfUpdate.targetDir` stays in main; only its boolean
 * verdict and the `blockedReason` enum cross the boundary. See the
 * `SystemInfo` doc in services/updateCheck.ts before adding a field.
 *
 * §2.58 iter2 — "only the Settings renderer" is now ENFORCED, not merely
 * intended: the panel that consumes this payload is rendered exclusively by
 * the settings window (`src/Root.tsx` routes `#/settings` → `Settings` →
 * `SystemInfo`), so any other sender asking for it is either a bug or a
 * compromised renderer harvesting `process.execPath`. Fail-closed, same
 * predicate and same direction as the About telemetry switch in
 * `settings:save`. The refusal is `null` rather than a rejection: the
 * renderer's fetch already treats a missing payload as "show the static
 * version only" (SystemInfo.tsx keeps `info === null`), so a denied caller
 * degrades instead of breaking, and a policy refusal does not manufacture a
 * synthetic Sentry event through the `handleIpc` error funnel.
 */
handleIpc('update:systemInfo', (event): SystemInfo | null => {
  if (!isSettingsWindowSender(event?.sender)) {
    // No sender identity, no payload echo — both are renderer-derived (CLAUDE.md §8).
    logUpdate.warn('update:systemInfo refused — sender is not the settings window')
    return null
  }
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
    // §2.58 — "writable" now means the directory the updater would write to
    // (the AppImage's own directory, not the /tmp mount). Distro packages
    // report true: elevation, not the current user's rights, decides there.
    installPathWritable: updateSelfUpdate.blockedReason !== 'target-dir-readonly',
    canSelfUpdate: app.isPackaged && updateCanSelfUpdate,
    selfUpdateBlockedReason: updateSelfUpdate.blockedReason,
    isPackaged: app.isPackaged,
  }
})

handleIpc('update:install', async () => {
  if (!app.isPackaged) return { ok: true as const }
  // §2.19 iter4 — same gate as update:download, symmetric by design: a
  // compromised renderer must not be able to invoke quitAndInstall where
  // in-place update is known impossible (no-op at best, dialog spam at worst).
  // §2.58 narrowed the predicate; on .deb/.rpm the real gate is the elevation
  // prompt the user answers. See `decideUpdateIpcGate` for the full rationale.
  const installGate = decideUpdateIpcGate({ isPackaged: app.isPackaged, canSelfUpdate: updateCanSelfUpdate })
  if (!installGate.allowed) return installGate.reject
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
    // §2.58 iter2 — this line also prints `err.code`, which is third-party
    // text (dpkg / pkexec / electron-updater), not one of our enums. It is
    // allowed HERE and in the dialog below because both are local-only: the
    // file log has no Sentry bridge (CLAUDE.md §8) and the dialog is rendered
    // by main. It must not travel further — the telemetry event and the IPC
    // reply below carry `error_class` alone. If a future change routes
    // `err.code` into Sentry, telemetry or the renderer, it needs a closed
    // dictionary first (see services/netErrorTelemetry.ts).
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
/**
 * §2.82 — the ONE way a settings record reaches a renderer window.
 *
 * Every copy that leaves main goes through `clampTelemetryForRenderer`, which
 * replaces the raw persisted `sentryEnabled` with the effective permission.
 * The renderer starts its own Sentry client from that field alone, so a raw
 * `true` with no consent record behind it (the schema default on a clean
 * profile) would start renderer envelopes for a user who was never asked. Use
 * this helper, never `broadcast('settings:changed', …)` directly.
 */
function broadcastSettingsChanged(settings: ReturnType<typeof getSettings>): number {
  return broadcast('settings:changed', clampTelemetryForRenderer(settings))
}

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

// Google OAuth (Desktop app, PKCE). Credentials come from the environment
// first and from the build-time `define` second — never from a source literal.
// Resolution happens per call, not at module load, so that a build without
// credentials still starts and only Gmail sign-in is unavailable.
// See electron/googleOAuthConfig.ts.

type GoogleTokenCacheEntry = { accessToken: string; expiresAt: number }
const GOOGLE_TOKEN_CACHE = new Map<number, GoogleTokenCacheEntry>()
const GOOGLE_TOKEN_REFRESH_INFLIGHT = new Map<number, Promise<GoogleTokenCacheEntry>>()
let googleOAuthBusy = false

/** Broadcasts an `oauth:progress` stage. Advisory only — a failure here must
 *  never abort the connect flow the user is waiting on. */
function emitOAuthProgress(provider: OAuthProgress['provider'], stage: OAuthConnectStage): void {
  try {
    broadcast('oauth:progress', { provider, stage } satisfies OAuthProgress)
  } catch {
    /* progress is advisory */
  }
}

async function doGoogleOAuthFlow() {
  const creds = requireGoogleOAuthCredentials()
  if (googleOAuthBusy) throw new Error('Google OAuth is already running in another window')
  googleOAuthBusy = true
  try {
    return await runGoogleOAuthFlow({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret || undefined,
      openExternal: (url) => { void openExternalGated(url, 'oauth') },
      onStage: (stage) => emitOAuthProgress('gmail', stage),
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

  // §2.165 fix wave 5 — the stamp, read HERE. Everything above it in this call
  // is synchronous, so this is the generation the id holds when the token fetch
  // starts. The discovery below happens only AFTER the secret-store await, and
  // ids are reused ("max + 1"): a mailbox deleted inside that window hands its
  // id to the next account created, and an unstamped report would raise the
  // badge on that brand-new, perfectly healthy mailbox. Read at report time it
  // would always match and prove nothing — the read has to precede the await.
  const accountGeneration = accountAuthState.currentGeneration(accountId)

  const p = (async () => {
    const found = await getOauthRefreshTokenWithSource('gmail', accountId)
    if (!found) {
      // §2.165 fix wave 4 — an OAuth account with no stored refresh token
      // cannot log in and cannot be repaired without the user signing in again,
      // yet until now it was the one broken mailbox that never showed the
      // badge: this rejection happens while BUILDING the config, before
      // `assertImapAuth` looks at the credentials and before any wrapped
      // operation exists, so neither the precondition report nor the connection
      // boundary ever fired and the account simply went quiet.
      //
      // Raised here, before the throw, for the same reason `assertImapAuth`
      // does it: the rejection fans out to every caller that wanted a token and
      // most of them only log it. The error carries OUR discriminator (not a
      // match on any provider's response text, and not a second classifier), so
      // the verdict is still correct on the paths where it does travel to the
      // service through the boundary.
      accountAuthState.noteMissingCredentials(accountId, accountGeneration)
      throw authNotConfiguredError(`Google refresh token for account #${accountId} not found (re-authorization required)`)
    }
    const refreshToken = found.token

    const creds = requireGoogleOAuthCredentials()
    const result = await refreshGoogleAccessToken({ clientId: creds.clientId, clientSecret: creds.clientSecret || undefined, refreshToken })
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
 * Collapse a certificate name attribute to a single display string.
 *
 * A relative distinguished name may repeat, and Node surfaces repeated values
 * as an array. These two fields are shown to the user and never compared
 * against anything, so joining is safe — but dropping the extra values would
 * hide part of the identity the user is being asked to look at.
 */
function certCommonName(cn: string | string[] | undefined): string | undefined {
  if (cn === undefined) return undefined
  return Array.isArray(cn) ? cn.join(', ') : cn
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
          subject: certCommonName(cert?.subject?.CN),
          issuer: certCommonName(cert?.issuer?.CN),
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

// §2.157 — pull side of the "this mailbox needs signing in again" state. The
// push side is the `accounts:authStateChanged` broadcast; this channel exists
// because a window that opens AFTER the flag was raised (app start with a
// stale credential, a reopened Settings window) would otherwise never learn
// about it. Read-only, ids only — see AccountAuthStatePayload.
handleIpc('accounts:authState', () => accountAuthState.snapshot())

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

/**
 * Has the account record actually left the store?
 *
 * §2.165 fix wave 5 — the question `accounts:remove` has to answer on a
 * REJECTED deletion, and the reason it is answered by looking at the store
 * rather than at the error: `deleteAccount` removes the account record first and
 * then does more work that can fail (secret cleanup, the settings write that
 * moves `currentAccountId` off the deleted account). A rejection therefore says
 * nothing about whether the record survived, and the error itself says even
 * less — matching on its text would be a classifier of somebody else's strings,
 * which this project does not do (CLAUDE.md §5).
 *
 * Fail-CLOSED: an unreadable store answers "still present", so the teardown
 * runs only when the disappearance is positively observed. The cost of a wrong
 * "gone" is tearing down a live mailbox's auth-refresh handler and cert
 * subscription — the exact damage the strict ordering above was introduced to
 * prevent. The cost of a wrong "present" is the state we already have today.
 *
 * Uses the same lookup as the service's `accountExists` dependency, so both
 * halves of the feature agree on what "this id addresses a live account" means.
 */
function accountRecordIsGone(id: number): boolean {
  try {
    return getAccountMeta(id) === undefined
  } catch (err) {
    logMain.warn('account lookup failed while finishing a removal', { accountId: id, code: errCodeOf(err) })
    // Synthetic, code only: a store read failure carries a filesystem path (the
    // user's home directory) and whatever the validator chose to quote back
    // (CLAUDE.md §8 — no third-party free text leaves the process).
    captureException(new Error(`accounts_remove_lookup_failed: ${errCodeOf(err)}`), {
      source: 'accounts_remove',
      step: 'account_record_is_gone',
    })
    return false
  }
}

/**
 * Everything that must happen once an account record is gone, in the order the
 * teardown requires.
 *
 * Extracted (§2.165 fix wave 5) because there are now TWO ways for a record to
 * disappear — a deletion that resolved, and a deletion that rejected after
 * removing the record — and both owe the process exactly the same cleanup. The
 * one that must never be skipped is `forget`: it bumps the generation, and the
 * generation is what keeps verdicts of the vanished mailbox from landing on the
 * next account created, since ids are reused ("max + 1"). A record that is gone
 * with its generation left behind is the worst combination available — the id
 * is free for reuse while every stale verdict still matches.
 *
 * Callers must have established that the record is gone (`accountRecordIsGone`)
 * before calling this. Nothing here needs a config that no longer loads: both
 * registries are keyed by account id.
 */
function completeAccountRemoval(id: number): void {
  // The original reason for these two is unchanged: the closures hold
  // references to token caches and must not outlive a deletion that happened.
  unregisterAuthErrorHandler(id)
  // Phase A2: drop the cert-error subscription alongside the auth handler.
  certRecovery.unregisterAccount(id)
  // §2.157: a deleted account must not leave a "needs sign-in" flag behind.
  // The renderer filters the broadcast against its account list, so a stale id
  // is invisible — but the flag would still be sitting in main's set, and
  // nothing would ever clear it (the account can no longer sync).
  accountAuthState.forget(id)
  GOOGLE_TOKEN_CACHE.delete(id)
  GOOGLE_TOKEN_REFRESH_INFLIGHT.delete(id)
  clearOutlookTokenCache(id)
  deleteAccountEmls(id)
  // The list really did change, whether or not the deletion as a whole
  // succeeded, so every window has to stop showing the mailbox.
  broadcast('accounts:changed', { kind: 'removed', id })
  // §2.99 (round-2 HIGH-3) — and its unread mail must stop counting towards the
  // badge. This function is the single teardown owner for a removed account
  // (see its doc above), so the recount rides with the rest of the cleanup.
  invalidateUnreadBadge()
  // §2.99 (security review MEDIUM-2) — same reason `forget` above exists: ids
  // are reused, so the notifier's watermark and any queued toast for this
  // account must go with the account, not outlive it under a new owner.
  forgetAccountBackgroundState(id)
  // §3.3.B6 (security review MEDIUM) — the in-memory translation tier holds text
  // derived from this mailbox's mail, and both ARCHITECTURE.md and CLAUDE.md §5
  // say deleting an account deletes its translations. The durable rows go with
  // the account; this drops the tier that sits over them.
  forgetAccountTranslations(id)
}

handleIpc('accounts:remove', async (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  if (IS_E2E) {
    // In e2e we don't support real account deletion: a stable list is sufficient.
    broadcast('accounts:changed', { kind: 'removed', id })
    return { ok: true as const }
  }
  // If removing an account with an active IDLE, stop the push connection.
  try { await stopIdle() } catch { /* ignore */ }
  // §2.165 — teardown happens strictly AFTER the deletion, and only for an
  // account that is actually gone. Both halves of that sentence are load-bearing
  // and they are NOT the same condition (fix wave 5).
  //
  // Ordering: `deleteAccount` can reject, and this handler then propagates the
  // rejection. Tearing down first left a SURVIVING account without a
  // token-refresh handler — condemned to auth failures that nothing was left to
  // repair — without a cert-error subscription, so a TLS interception on it
  // would pass in silence, and without its "needs sign-in" flag, the only
  // warning the user had that the mailbox is broken.
  //
  // Condition: "the promise resolved" is not the same as "the account is gone".
  // `deleteAccount` removes the record before work that can fail, so a rejection
  // can leave the record deleted with none of the teardown done — and the
  // generation un-bumped, which is what makes the reused id inherit the dead
  // mailbox's verdicts. So the failure path asks the store, and finishes the
  // cleanup when the record has in fact gone.
  //
  // The rejection is re-thrown either way: the deletion did NOT complete, and
  // the caller is entitled to know that whatever else we tidied up.
  try {
    await deleteAccount(id)
  } catch (err) {
    if (accountRecordIsGone(id)) {
      logMain.warn('account deletion failed after the record was removed; finishing teardown', {
        accountId: id,
        code: errCodeOf(err),
      })
      // Synthetic, same reason as in `accountRecordIsGone`: this rejection
      // comes from the secret backend or the settings writer and its message
      // quotes paths and stored values.
      captureException(new Error(`accounts_remove_partial_delete: ${errCodeOf(err)}`), {
        source: 'accounts_remove',
        step: 'partial_delete',
      })
      completeAccountRemoval(id)
    }
    throw err
  }
  completeAccountRemoval(id)
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
  emitOAuthProgress('gmail', 'imap')
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
  emitOAuthProgress('gmail', 'smtp')
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

  emitOAuthProgress('gmail', 'saving')

  const { id } = await saveAccount({
    id: existingId,
    // A re-authorization must not overwrite a name the user has edited; the
    // profile name fills in only where the record has none.
    //
    // Deliberately `||`, not `??`: the read schema accepts `name: ''` while
    // the write schema requires a non-empty name, so a legacy record with a
    // blank name would otherwise carry that blank through and make the save
    // fail outright (codex-bg-review, 2026-08-02).
    name: existingMeta?.name?.trim() || tokens.displayName || undefined,
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
  // §2.165 — a completed re-authorization is the one moment the badge must
  // disappear at once, and the only credentials proof that does NOT travel
  // through the connection boundary: `testImapConnection` above opened a
  // throwaway connection with no account id attached. Gated on that test
  // having actually passed — `tlsCertImap` set means the login was never
  // reached, only the TLS handshake failed, and the account is saved anyway so
  // the user can accept the certificate.
  if (!tlsCertImap) accountAuthState.noteSignedIn(id)
  broadcast('accounts:changed', { kind: 'saved', id })
  const tlsCertRequired = (tlsCertImap || tlsCertSmtp) ? { imap: tlsCertImap, smtp: tlsCertSmtp } : undefined
  return { ok: true as const, id, email: tokens.email, tlsCertRequired }
})

// Microsoft 365 / Outlook.com OAuth — delegated to electron/services/outlookOAuthService.ts
handleIpc('oauth:microsoft:connect', async (_e, existingAccountId: unknown) => {
  const res = await connectOutlookAccount({
    existingAccountId,
    openExternal: (url) => { void openExternalGated(url, 'oauth') },
    broadcast,
    isE2E: IS_E2E,
  })
  // §2.165 — same as the Google flow: the service verified IMAP with the fresh
  // token on a throwaway connection the boundary never saw, so the cleared
  // badge has to be reported from here. `tlsCertRequired.imap` is exactly the
  // "saved despite an unusable IMAP endpoint" case — the login was never
  // reached, so nothing was proven.
  if (!res.tlsCertRequired?.imap) accountAuthState.noteSignedIn(res.id)
  return res
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

// --- §2.157 Expired-credentials surfacing -----------------------------------
// Before this, an account whose password changed elsewhere (or whose OAuth
// refresh token was revoked) failed every background sync and left nothing but
// a `logPeriodic.warn` line — the mailbox went quiet for hours with no sign in
// the window. Policy and state live in electron/services/accountAuthState.ts
// (hotspot policy — main.ts only wires dependencies).
//
// `classifyImapError` is passed in rather than re-derived: it is the single
// classifier for IMAP failures (CLAUDE.md §5), and 'cert' failures in
// particular must reach certRecovery's dialog, not a "sign in again" badge.
const accountAuthState = initAccountAuthState({
  classifyError: classifyImapError,
  broadcast,
  // §2.165 — lets the service drop a verdict reported by an operation that was
  // in flight when the account was deleted, which would otherwise resurrect a
  // badge nothing can ever clear, or leave a stray failure behind for the next
  // account to be issued that id (ids are reused). Consulted only where the
  // service creates per-account state, never per failure.
  // Mirrors the `accounts:list` handler so the stubbed e2e account list is the
  // authority in e2e, exactly as it is for every other account lookup.
  accountExists: (id) => (IS_E2E
    ? E2E_ACCOUNTS.some(a => a.id === id)
    : getAccountMeta(id) !== undefined),
})

// §2.165 (fix wave 4) — the identity half of the wiring, and it MUST come
// first.
//
// Account ids are reused ("max + 1"), so an id alone does not say which mailbox
// a verdict is about; the pair (id, generation) does. The service mints the
// generation and bumps it on deletion, packages/net stamps every outcome with
// the generation read at the START of the operation, and the service acts on a
// verdict only while the stamp still matches. An unstamped verdict (`null`) is
// discarded, which is exactly why this registration precedes the subscriber
// below: the boundary reads the provider at operation start, so a subscriber
// installed first would receive the session's first verdicts unattributed and
// drop them. Both are plain module-scope statements, so nothing can run between
// them — the order is pinned by a test
// (`electron/main.accountAuthStateWiring.test.ts`) to keep it that way.
registerAccountGenerationProvider((id) => accountAuthState.currentGeneration(id))

// §2.165 — THE single writer of the flag.
//
// The connection/retry boundary in packages/net/imap reports the verdict of
// every outward IMAP operation; no caller reports outcomes of its own. (One
// caller escalates a verdict the boundary already reported — see
// `noteIdleLoginRejected` below — which is a transition, not a second
// outcome.) The predecessor
// wiring called `noteSuccess` from three chosen sync paths — all of them header
// fetches — which left a mailbox with every folder on manual sync unable to
// ever clear a raised badge, and made a repaired login wait up to a full
// periodic cycle to be noticed while the user was already reading mail through
// half a dozen other paths that each proved the credentials work.
//
// Registered at module scope, i.e. before `app.whenReady` and therefore before
// the first sync or IDLE can start: an outcome produced while no subscriber is
// installed is dropped silently by the boundary, and the failures worth seeing
// are exactly the ones that happen on the first pass after launch.
//
// The boundary hands over the ORIGINAL error object; classification is the
// service's job and uses the one classifier this project has. Nothing derived
// from it is logged here — an IMAP server's response text echoes the user name
// and host (CLAUDE.md §8).
registerConnectionOutcomeHandler((outcome) => {
  if (outcome.ok) accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)
  else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)
})

// §2.165 fix wave 4 — the Outlook token provider discovers "this account has no
// stored refresh token" while building a config, i.e. before any wrapped
// operation exists for the boundary to report on. It lives in a service that
// cannot import main.ts, so it holds the slot and main.ts fills it. The Gmail
// provider is inside this file and calls the service directly
// (`getGoogleAccessToken`).
//
// Fix wave 5 — the slot carries BOTH halves of the stamped contract. The report
// is separated from its discovery by the secret-store await, so the service
// hands over the stamp source as well: the provider reads the generation before
// that await and the service drops the verdict if the id changed hands in
// between. A slot with only the report would be the unstamped path all over
// again.
registerMissingCredentialsReporter({
  currentGeneration: (id) => accountAuthState.currentGeneration(id),
  noteMissingCredentials: (id, generation) => accountAuthState.noteMissingCredentials(id, generation),
})

/**
 * §2.165 (fix wave 2) — the one failure the counting rule can never see twice.
 *
 * The subscriber above feeds a threshold of two: a single auth failure is not
 * yet a verdict, because the stream normally keeps producing evidence. IDLE's
 * connect/authenticate/select prologue breaks that assumption. It is a full
 * login, the boundary reports it as one failure, and then `startIdle` throws
 * and stops — there is no retry inside it and no loop to produce a second
 * observation. For a mailbox with every folder on manual sync the prologue is
 * the ONLY outward connection, so under plain counting a refused login would
 * never raise the badge at all: the mirror image of the defect §2.165 closes.
 *
 * So the rejection is escalated rather than re-reported. `noteLoginRejected`
 * performs the raise transition and touches no counter, and the transition is
 * edge-triggered — one refused login yields one badge, one broadcast and one
 * telemetry record no matter that the boundary already counted the same error.
 * Classification stays with the service (and therefore with the project's one
 * IMAP classifier): a transient network failure here is weather, not a revoked
 * password, and must not raise anything.
 *
 * Lives here, next to the rest of the wiring, rather than inside the IPC
 * handler: main.ts is a hotspot and holds no policy of its own (CLAUDE.md §5),
 * and the handler must keep re-throwing the original error untouched.
 *
 * §2.165 fix wave 4 — `accountGeneration` is the stamp the handler took BEFORE
 * the login attempt started, exactly like the boundary takes one before every
 * operation it wraps. Without it this would be the only raise-on-sight path
 * that could flag a mailbox on the strength of a login begun for the mailbox
 * that held the id before it.
 */
function noteIdleLoginRejected(accountId: number, accountGeneration: number | null, err: unknown): void {
  accountAuthState.noteLoginRejected(accountId, accountGeneration, err)
}

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
 * certificate itself can (`buildTlsOptions` builds this body into the shared
 * `SecureContext` it hands the transport, so OpenSSL treats it as a root).
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
  // The e2e short-circuit is ALSO gated on the build being unpackaged. That is
  // redundant today — `IS_E2E` is `computeIsE2E(process.env, app.isPackaged)`
  // and already false on any packaged build — and it stays here on purpose: a
  // consent gate that an env var switches off is not a consent gate, so this
  // one does not want its correctness to depend on how a flag defined 3000
  // lines up happens to be derived. Cost is one boolean; the failure it guards
  // against is a shipped build accepting an attacker's certificate with no
  // human ever seeing the dialog. Same reasoning as `assertE2EHandlerAllowed`
  // above; see its comment for the full threat model.
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

/**
 * §2.99 (round-2 HIGH-3) — main-side OWNERS of folder-preference writes.
 *
 * `visible` and `includeInBadges` are inputs to the shared badge policy
 * (packages/core/unreadBadgePolicy.ts), so every write of a preference row can
 * change the unread total even though no message moved. Enumerating the IPC
 * exits that happen to write prefs today is exactly the mistake this replaces:
 * the next writer would have to remember the list. Routing every main-side
 * write through these three wrappers means a new caller inherits the
 * invalidation by construction.
 */
function writeFolderPref(accountId: number, folderPath: string, patch: Parameters<typeof upsertFolderPref>[2]) {
  const pref = upsertFolderPref(accountId, folderPath, patch)
  invalidateUnreadBadge()
  return pref
}

function dropFolderPref(accountId: number, folderPath: string): boolean {
  const removed = removeFolderPref(accountId, folderPath)
  if (removed) invalidateUnreadBadge()
  return removed
}

function dropStaleFolderPrefs(accountId: number, stalePaths: string[]): void {
  if (stalePaths.length === 0) return
  deleteStaleFolderPrefs(accountId, stalePaths)
  invalidateUnreadBadge()
}

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
  const pref = writeFolderPref(id, pathValue, parsedPatch)
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
  return { ok: true as const, removed: dropFolderPref(id, pathValue) }
})

/**
 * Unread counts from SQLite cache (without IMAP requests).
 *
 * The reply names the folders it speaks for: `listFolderStats` alone omits
 * every folder with no rows, and the renderer cannot tell "cache says zero"
 * from "cache knows nothing" (an `on_open` folder never opened has no rows
 * either, and its badge legitimately carries the server LIST-STATUS number).
 * `buildFolderCountsResponse` resolves that ambiguity here, where the crawl
 * state is visible — see `electron/folderCountsResponse.ts` for the rule.
 */
handleIpc('folder:refreshCounts', (_e, accountId: unknown) => {
  const id = accountIdSchema.parse(accountId)
  return buildFolderCountsResponse({
    accountId: id,
    stats: listFolderStats(id),
    crawlStates: listFolderCrawlStates([id]),
  })
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

/**
 * A loaded account config plus the identity stamp of the mailbox it was loaded
 * for (§2.165 fix wave 5).
 *
 * `accountGeneration` is read before this loader's first await and travels with
 * the config, because everything derived from that config is a statement about
 * the mailbox as it was AT LOAD TIME. Account ids are reused, so a deletion
 * during the load (or during the operation the caller then runs) hands the id
 * to the next account created; a verdict derived from the stale config must not
 * land on that new mailbox. The only consumer today is `assertImapAuth`, and
 * the parameter is required there so a new call site cannot forget it.
 */
type LoadedAccountConfig = {
  id: number
  meta: AccountMeta
  cfg: AccountConfig
  accountGeneration: number | null
}

async function requireAccountConfig(accountIdRaw: unknown): Promise<LoadedAccountConfig> {
  const id = accountIdSchema.parse(accountIdRaw)
  const meta = getAccountMeta(id)
  if (!meta) throw new Error(`Account #${id} not found`)
  // Read before the first await below, for the reason in the type's JSDoc.
  const accountGeneration = accountAuthState.currentGeneration(id)
  // Phase A2: subscribe this account to TLS cert-error notifications from the
  // packages/net retry wrappers. Idempotent (service-side registry), so the
  // call is safe on every config load; placing it here guarantees the
  // handler exists before any IMAP operation that could hit a cert failure.
  certRecovery.ensureAccountRegistered(id)
  const base = await getAccountConfig(id)
  if (!base) throw new Error(`Could not load config for account #${id}`)
  const imapPins = listTlsPinsForEndpoint(id, base.imap.host, base.imap.port)
  const smtpPins = listTlsPinsForEndpoint(id, base.smtp.host, base.smtp.port)
  // Pinned certificate bodies travel with the pins: `buildTlsOptions` folds
  // them into the trust set the connection's shared `SecureContext` is built
  // from, i.e. they become explicit trust anchors. That is what lets a
  // self-signed or private-CA server verify WITHOUT weakening
  // `rejectUnauthorized`.
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
      accountGeneration,
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
    accountGeneration,
    cfg: {
      imap: { ...base.imap, tlsPinsSha256: imapPins, tlsPinnedCertsPem: imapPinCerts },
      smtp: { ...base.smtp, tlsPinsSha256: smtpPins, tlsPinnedCertsPem: smtpPinCerts },
    },
  }
}

function assertImapAuth(accountId: number, cfg: AccountConfig['imap'], accountGeneration: number | null) {
  if (cfg.pass || cfg.accessToken) return
  // §2.165 — the one credentials verdict the connection boundary can never
  // report: this check rejects BEFORE a connection is attempted, so no wrapped
  // operation ever runs and no outcome is produced. Without this call an
  // account that cannot even try to log in is the only kind that never shows
  // the "sign in again" badge — precisely the account that needs it most.
  //
  // Reported directly rather than by letting the thrown error travel to the
  // service: the throw fans out to ~28 call sites, most of which log it and
  // move on, and the raise must not depend on which of them caught it. The
  // error still carries the discriminator so the report is correct in the one
  // case where the check DOES run inside an already-wrapped operation.
  //
  // §2.165 fix wave 5 — `accountGeneration` comes from `requireAccountConfig`
  // (the sole source of every `cfg` passed here) and was read before that
  // loader's first await. The verdict is a statement about the record that load
  // produced, and the id can change hands between the load and this check:
  // ids are reused, so an unstamped raise puts the badge on whichever mailbox
  // was created next. Required rather than optional so the compiler, not a
  // reviewer, is what stops the next call site from omitting it.
  accountAuthState.noteMissingCredentials(accountId, accountGeneration)
  throw imapAuthNotConfiguredError(accountId)
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

  const { meta, cfg, accountGeneration } = await requireAccountConfig(accountId)

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
    assertImapAuth(accountId, cfg.imap, accountGeneration)
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
    //
    // §2.82 iter2 (finding 1) — the diagnostics are built by the service, which
    // owns the PII boundary for this failure. The previous inline object put the
    // Sent folder NAME, the Message-ID and up to 500 chars of raw server
    // response into Sentry, contradicting the consent screen's unqualified
    // promise about folder names and addresses. Both sinks below now take the
    // SAME sanitized object, so a field cannot be added to one and not the other.
    const diag = buildSentCopyAppendDiag(e, {
      accountId,
      providerId: meta.providerId,
      sentFolder: sentFolderForDiag ?? null,
      rawSize: rawSizeForDiag ?? null,
      messageId: result.messageId ?? null,
    })
    logMail.warn('Could not save copy to Sent (diag):', diag)
    // Synthetic exception, not `e`: an ImapFlow rejection message inlines the
    // mailbox it failed on and whatever prose the server chose to attach.
    const appendErr = new Error(`sent_copy_append_failed: ${diag.reason}`)
    appendErr.name = 'SentCopyAppendError'
    captureException(appendErr, { source: 'sendMail:appendToSent', ...diag })
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

/**
 * The owner of "snooze state changed" — every add / remove / wake path already
 * ends here, which is why §2.99 (round-2 HIGH-3) hangs the badge invalidation
 * off it rather than off the individual handlers and AI callbacks. A snoozed
 * message is excluded from the unread aggregate (`countUnreadByFolder`), so
 * both directions move the badge.
 */
function notifySnoozeChanged(accountId?: number) {
  broadcast('mail:snoozeChanged', {
    accountId: typeof accountId === 'number' ? accountId : null,
    at: new Date().toISOString(),
  })
  invalidateUnreadBadge()
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
      // §2.99 — a woken message re-enters the unread count; the badge follows
      // through the snooze owner above.
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
            const { cfg, accountGeneration } = await requireAccountConfig(ref.accountId)
            assertImapAuth(ref.accountId, cfg.imap, accountGeneration)
            await imapBackground(() => moveMessages(cfg.imap, ref.folder, ref.archiveFolder, [ref.uid], ref.accountId))
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)

  // §2.165: the outcome of the prologue is reported by `startIdle` itself, at
  // the boundary that owns the connection — including the outcomes of its own
  // reconnect cycle, which this handler never sees. What the boundary cannot
  // know is that a rejected prologue is TERMINAL: it throws here and the loop
  // never starts, so no second failure will ever arrive to satisfy the
  // threshold. That is what the escalation below adds, and all it adds — the
  // error is re-thrown unchanged (the renderer caller swallows it, but the
  // handler contract stays the same).
  //
  // The stamp is read HERE, before the attempt starts, for the same reason the
  // boundary reads its own before awaiting anything: a prologue that is still
  // running while the account is deleted (and its id re-issued) must report the
  // incarnation it was started for, so the escalation is discarded instead of
  // landing on the new mailbox.
  const idleGeneration = accountAuthState.currentGeneration(id)
  try {
    await startIdle(id, cfg.imap, parsedMailbox, (data) => {
      // Forward the event to the renderer, which drives the sync. Deciding
      // WHAT to announce is main's job since §2.99 (services/mailNotifier.ts) —
      // the renderer no longer raises notifications.
      const delivered = broadcast('mail:exists', { accountId: id, ...data })
      // §2.99 — nobody is listening (the app is running in the tray with its
      // window closed), so the event would be dropped and the mailbox would sit
      // unsynced until the periodic timer. Drive the existing per-account pass
      // instead — same in-flight gate, same offline/shutdown guards. Moving
      // IDLE ownership into main is the real fix and is out of scope here.
      if (delivered === 0) triggerAccountResync(id)
    })
  } catch (err) {
    noteIdleLoginRejected(id, idleGeneration, err)
    throw err
  }
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
    dropStaleFolderPrefs(accountId, stalePaths)
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
      const created = writeFolderPref(accountId, box.path, defaults)
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
        const updated = writeFolderPref(accountId, box.path, { headerSyncMode: 'full' })
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

  const { meta, cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)

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
        ...senderPartsFromHeader(m.from),
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)

  const result = await fetchInboxSummaries(cfg.imap, parsedFolder, 50, id, isLightweight)

  // Evaluate mail rules on anything the pipeline has not seen (fire-and-forget).
  processMailRules(id, parsedFolder).catch(err =>
    logRules.error('Background processMailRules (inboxSummaries) failed:', err)
  )
  noteFolderSynced(id, parsedFolder)

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
      ...senderPartsFromHeader(m.from),
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
  // §2.17 Phase 1 — the tier is honest (a person is scrolling), but INERT here
  // and knowingly so: `fetchFolderSummariesPage` runs on a dedicated connection
  // (`withDedicatedImapRetry`), which bypasses both op locks and the pool
  // semaphore, so there is no queue for a tier to order. Kept rather than
  // deleted because the connection family is a property of the net function,
  // not of this call: `fetchSummariesByUids` and `imapSearchFolder` — the same
  // kind of user-facing read — do go through the singleton lock, and if
  // pagination ever joins them the tag must already be right. A bare call here
  // would read as "pagination is deliberately not interactive", which is the
  // opposite of true.
  const page = await imapInteractive(() => fetchFolderSummariesPage(cfg.imap, parsedFolder, lim, beforeUid, id))

  // This path persists headers too (fetchFolderSummariesPage → upsertMessages),
  // so it used to raise `MAX(uid)` above messages the rule pipeline had never
  // seen — one of the leaks fixed on 2026-07-30 (§2.86). Now that discovery is
  // watermark-based, triggering a pass here is cheap and closes the hole.
  processMailRules(id, parsedFolder).catch(err =>
    logRules.error('Background processMailRules (folderPage) failed:', err)
  )

  // §2.7: drop UIDs the renderer has optimistically moved out (undo window).
  return filterPendingMoves(page)
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
  // §2.99 (review H3) — mail left this folder locally (move / archive / delete
  // / trash). This is the one place every such path passes through, and the
  // unread total must follow without waiting for the next sync.
  invalidateUnreadBadge()
}

// --- Static mail rules ---

// Give every folder this install already knows about — cached mail, prefs,
// crawl state or sync state, empty ones included — a rule-pipeline starting
// point, BEFORE anything can sync. This is module scope on purpose: it must
// happen ahead of the first `net:*` IPC call (windows open in `whenReady`) and
// ahead of the periodic-sync timer, both of which persist messages.
//
// The runner's own lazy baseline cannot carry this job: the runner is invoked
// AFTER a fetch has persisted its batch, so on the first launch of this build
// `MAX(uid)` would already include mail that had just arrived — and that mail
// would be declared old forever, which is precisely the §2.86 defect
// re-created at the moment the fix ships. Idempotent: a second call leaves
// existing rows alone (§2.86 iter2, review finding 2).
try {
  const seeded = seedMailRulesStateFromCache()
  if (seeded > 0) logRules.info(`Seeded rule watermarks for ${seeded} known folder(s)`)
} catch (err) {
  // Never block startup on this: a folder that missed the seed still gets the
  // runner's lazy baseline, which is the pre-fix behaviour, not a crash.
  logRules.error('Seeding rule watermarks failed:', err)
  captureException(err, { source: 'seedMailRulesStateFromCache' })
}

// --- §2.99 tray / background operation / new-mail notifications -------------
//
// Everything below the window handles lives in services/backgroundMail.ts: the
// adapters onto the cache, the settings store and the OS are its job, this is
// the wiring main.ts alone can provide.

/** Bring the app back into view, creating the window if it is running headless. */
function showMainWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    return
  }
  createWindow()
}

/**
 * A new-mail notification was clicked. The renderer receives IDENTIFIERS only
 * (`mail:openRef`) and looks the message up in the local cache itself — the
 * subject the OS toast displayed never crosses the bridge.
 */
function openMailRef(ref: MailRef): void {
  showMainWindow()
  const target = win
  if (!target || target.isDestroyed()) return
  const send = () => { if (!target.isDestroyed()) target.webContents.send('mail:openRef', ref) }
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send)
  else send()
}

initBackgroundMail({
  isE2E: IS_E2E,
  onNotificationActivated: openMailRef,
  // Round 3 — `launchAtLoginStatus` is written by the service AFTER this
  // handler's own `settings:changed` has gone out (and at startup, outside any
  // save), so the service pushes the settings again once the outcome is
  // recorded. Fresh from the store, never the payload that triggered it.
  broadcastSettings: () => { broadcastSettingsChanged(getSettings()) },
})

/**
 * Execute a single rule action on a message via IMAP.
 * Folder-role based actions (archive, trash, spam) resolve target folder from cached roles.
 */
async function executeRuleAction(accountId: number, folder: string, uid: number, action: RuleAction): Promise<void> {
  // §2.17 Phase 1 — static rules fire from the sync pipeline on newly arrived
  // mail, not from a click. Background tier: the rule must run, but a rule pass
  // over a fresh batch must not delay the message being opened right now.
  //
  // The scope wraps the body in place rather than delegating to a second
  // function: the refusal branches below are pinned by a source-mirror test
  // that slices THIS function, and moving them out of it would satisfy the
  // slice while leaving the guarantee untested.
  return imapBackground(async () => {
  const { cfg, accountGeneration } = await requireAccountConfig(accountId)
  assertImapAuth(accountId, cfg.imap, accountGeneration)
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
      // Depth for a row written before `parseMailRuleParts` required the
      // target (§2.162). A blank target used to fall straight through to
      // `break`, so the executor reported success and the caller logged the
      // move as applied — the same "the log says work that never happened"
      // defect as an unknown action type, and refused the same way.
      if (!action.folder || !action.folder.trim()) {
        throw new Error('mail rule move action has no target folder')
      }
      if (action.folder !== folder) {
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
    default: {
      // Unreachable for a rule stored since `parseMailRuleParts` began checking
      // the action type (§2.162), and reachable only for a row written before
      // it. Falling through silently is what made this worth closing: the
      // callers log a `rule_log` row after this resolves, so an action nobody
      // performed was recorded as applied — an audit trail that reports work
      // that never happened. Throwing keeps the case distinguishable from
      // success: the runner counts it as a failed action (bounded retries, then
      // a synthetic PII-free report) and `rules:applyToFolder` does not count
      // it as applied. The value is not interpolated — it is stored text, and
      // the rule id is already in the caller's log line.
      throw new Error('unsupported mail rule action type')
    }
  }
  })
}

/**
 * In-flight guard for the rule runner, keyed `${accountId}:${folder}`.
 * The pass is triggered from several sync paths and they do overlap.
 */
const mailRulesInflight = new Set<string>()

/**
 * Triggers that arrived while a pass held the key (same key shape). The running
 * pass consumes this before releasing the slot, so a message persisted after
 * that pass sampled its UID list is not left waiting for an unrelated trigger
 * (§2.86 iter2 — lost wake-up).
 */
const mailRulesPendingRerun = new Set<string>()

/**
 * Consecutive action failures keyed `${accountId}:${folder}:${uid}`. Lives for
 * the process lifetime: a restart deliberately grants a fresh retry budget,
 * because a dead IMAP connection is exactly what a restart fixes.
 */
const mailRulesActionAttempts = new Map<string, number>()

/** Wire the extracted runner to the real DB / IMAP / telemetry collaborators. */
function buildMailRulesDeps(): MailRulesRunnerDeps {
  return {
    inFlight: mailRulesInflight,
    pendingRerun: mailRulesPendingRerun,
    actionAttempts: mailRulesActionAttempts,
    listMailRules,
    getMailRulesState,
    setMailRulesState,
    getUidValidity: (accountId, folder) => getSyncState(accountId, folder)?.uidValidity ?? null,
    getMaxUidForFolder,
    getUidsForRulesSince,
    getMessageByUid,
    executeRuleAction,
    insertRuleLog,
    enqueueForAiRules,
    log: {
      info: (msg) => logRules.info(msg),
      warn: (msg) => logRules.warn(msg),
      error: (msg, err) => logRules.error(msg, err),
    },
    captureException,
  }
}

/**
 * Evaluate static mail rules for everything in `folder` the pipeline has not
 * looked at yet.
 *
 * Deliberately takes no UID list: the caller's idea of "new" (`uid > MAX(uid)`
 * sampled before its own fetch) is what lost messages before 2026-07-30 — see
 * the header of `services/mailRulesRunner.ts`. Discovery now lives inside the
 * runner, against a watermark only the runner writes, so this is safe (and
 * cheap) to call from any sync path.
 */
async function processMailRules(accountId: number, folder: string): Promise<void> {
  try {
    // §2.17 Phase 1 — this pass is started DETACHED (`processMailRules(...).catch()`)
    // from every sync path, and one of those paths (the periodic timer) runs
    // inside an ambient `sync` scope. A detached child inherits the ambient tier
    // and keeps it after the parent scope settles, so without this line the same
    // rule pass would be `sync` when the timer noticed the mail and `other` when
    // an IPC handler did — a tier decided by who happened to be first, not by
    // what the work is. Stated here, at the child's own boundary, which is the
    // rule for detached work (imapScheduler header, "What a scope does NOT
    // promise"). `executeRuleAction` states the same tier again at the leaf,
    // deliberately: it is also reached from the follow-up path, which has no
    // scope of its own. Today the two agree, so this is a guarantee, not a
    // behaviour change.
    await imapBackground(() => runMailRules(accountId, folder, buildMailRulesDeps()))
  } catch (err) {
    logRules.error(`processMailRules error for ${folder}:`, err)
    // No folder name in the Sentry payload — a mailbox name is user data and
    // has no recognisable shape for the event-level scrub to catch
    // (ARCHITECTURE.md, "Свободный текст третьей стороны не передаётся").
    // Errors that reach here are our own (DB / wiring); per-message IMAP
    // failures are handled and reported inside the runner.
    captureException(err, { source: 'processMailRules' })
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
    // §2.165: no credentials verdict is reported from here — the IMAP calls
    // inside `runSyncFolderHeaders` report their own, at the boundary.
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
      // §2.172 — the same split every other seeding site uses. This branch used
      // to write the raw `From:` string into `from_addr` (and clear `from_name`),
      // and `upsertMessages` overwrites both columns unconditionally, so running
      // a header sync after a summaries fetch silently replaced a correct split
      // with a display string. `from_address` rules then matched on data the
      // production parser cannot produce.
      ...senderPartsFromHeader(m.from),
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)

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
    // Same gate, other failure mode: the inner fetch ran but could not store
    // every header it pulled. This branch is the third `fetchAllFolderHeaders`
    // call site, and one of the two whose 'covered_full' write has no
    // crawled-vs-exists check to fall back on (the periodic background loop is
    // the other; only the interactive path below derives its status from
    // `trulyComplete`). So the flag has to be read here explicitly.
    let newResultHeadersIncomplete = false
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
            newResultHeadersIncomplete = Boolean(newResult.headersIncomplete)
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
          //   3. The inner fetch stored only part of what it pulled
          //      (`headersIncomplete`). The write below pins
          //      watermark = getMaxUidForFolder, i.e. the highest UID that
          //      LANDED — above the one that did not. This branch survives
          //      that because `newUids` is rediscovered from the cache diff
          //      each run, but the watermark it leaves is read as `sinceUid`
          //      by the full-sync path whenever this branch is not taken
          //      (FLAGS-only sync throws → fallthrough below; or the server
          //      starts advertising CONDSTORE), and there the hole is filtered
          //      for good. 'covered_full' would also be a false claim to
          //      search coverage while the message is absent.
          const stateAdvanceSafe = !flagResult.stalewipeGuardTripped
            && !(flagResult.newUids.length > 0 && newResultWasSkipped)
            && !newResultHeadersIncomplete
          completed = stateAdvanceSafe
          broadcast('sync:folderProgress', { accountId: id, account: syncAccountEmail, folder: parsedFolder, fetched, total: serverTotal, done: true })
          if (!stateAdvanceSafe) {
            const reason = newResultHeadersIncomplete ? 'a header response carried no usable UID' : 'new-UIDs fetch returned skipped'
            logSync.warn(`Header sync ${parsedFolder} account ${id}: ${reason} — NOT advancing crawl state`)
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
          // This branch returns before the shared rule tail at the bottom of the
          // function, so messages fetched here were never evaluated by static
          // rules on non-CONDSTORE servers (2026-07-30 leak #1).
          processMailRules(id, parsedFolder).catch(err =>
            logRules.error('Background processMailRules (FLAGS-only sync) failed:', err)
          )
          // Flags changed on the server (another device read something) — the
          // unread surfaces must follow even though no mail arrived.
          noteFolderSynced(id, parsedFolder)
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
    // A run that could not store every header it fetched is not a completed
    // crawl either. `completed` is what promotes the folder to 'covered_full',
    // and that status makes the next sync pass `sinceUid = maxUid` — which
    // filters out exactly the UID that failed to land, since a neighbour with
    // a higher UID stored fine and carried the watermark past it. Staying on
    // 'covered_recent' keeps the descent (beforeUid, no sinceUid) that
    // re-requests it.
    completed = !stalewipeSuspect && !result.headersIncomplete
    if (result.headersIncomplete) {
      logSync.warn(`Header sync ${parsedFolder} account ${id}: a header response carried no usable UID — NOT advancing crawl state to covered_full`)
    }
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
  } finally {
    // Evaluate static mail rules on anything the pipeline has not seen
    // (fire-and-forget). In `finally`, not at the tail of the `try`: a sync
    // that throws after committing batches took the `catch` above and
    // rethrew, so the tail never ran even though messages were already in the
    // cache (§2.86 iter2, review finding 6). It also covers the FLAGS-only
    // branch's early `return` — that branch keeps its own explicit call so the
    // structural wiring test can pin it, and the duplicate costs one indexed
    // query (the second call is folded into the first pass's rerun).
    processMailRules(id, parsedFolder).catch(err =>
      logRules.error('Background processMailRules failed:', err)
    )
    noteFolderSynced(id, parsedFolder)
    // §2.115 — tell the body indexer its idle backoff is stale.
    //
    // The indexer stretches its tick 2s → … → 2min while it finds nothing to
    // do. Rows we just committed carry no body_text, so they are exactly the
    // work that curve was backing away from; without this the ramp keeps
    // climbing and a body that just landed can stay unsearchable for minutes.
    //
    // Guarded by `fetched > 0`, NOT by "a sync ran": an incremental sync that
    // matched no new UIDs, and the FLAGS-only branch (which changes flags on
    // already-indexed rows and leaves `fetched` at 0), must not reset the
    // curve — resetting on every sync tick is how the backoff gets defeated.
    // `fetched` is assigned as batches are committed, so it is also correct on
    // the path that throws afterwards, which is why this sits in `finally`
    // alongside the rule trigger.
    //
    // try/catch because a sync must never fail on account of a scheduling
    // hint (same contract as `certRecovery.noteSyncSuccess` below). The call
    // re-arms the indexer's pending timeout (clearTimeout + setTimeout): no
    // I/O, no await, nothing to queue.
    if (fetched > 0) {
      try { resetBodyIndexerBackoff() } catch { /* never break sync */ }
    }
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
      // §2.165: the "credentials still work" verdict is NOT reported here. The
      // fetches this function performed already reported it at the connection
      // boundary — and did so for every account, not only for the ones whose
      // folders are on automatic sync.
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

  // §2.99 (review H3) — every branch below that reaches the cache changes what
  // is unread, so the badge is recounted from one place at the end rather than
  // per branch. Debounced in the tray service.
  if (getSettings().workOffline) {
    setUnread(id, parsedMailbox, parsedUids, !parsedSeen)
    const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
    for (const uid of parsedUids) {
      upsertOfflineOp(id, parsedMailbox, uid, 'flag_seen', { seen: parsedSeen }, uidVal)
    }
    invalidateUnreadBadge()
    return { ok: true as const }
  }

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
  try {
    await imapInteractive(() => setSeen(cfg.imap, parsedMailbox, parsedUids, parsedSeen, id))
  } catch (err) {
    if (isTransientNetworkError(err)) {
      logMail.warn(`net:setSeen transient failure, queueing: ${err instanceof Error ? err.message : String(err)}`)
      setUnread(id, parsedMailbox, parsedUids, !parsedSeen)
      const uidVal = getSyncState(id, parsedMailbox)?.uidValidity ?? null
      for (const uid of parsedUids) {
        upsertOfflineOp(id, parsedMailbox, uid, 'flag_seen', { seen: parsedSeen }, uidVal)
      }
      invalidateUnreadBadge()
      return { ok: true as const, queued: true as const }
    }
    throw unwrapAggregate(err)
  }
  invalidateUnreadBadge()
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
  try {
    await imapInteractive(() => setFlagged(cfg.imap, parsedMailbox, parsedUids, parsedFlagged, id))
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
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

/**
 * §2.17 Phase 1 — tier helpers for the IMAP locks.
 *
 * The tier is a property of WHY the work is happening, which is known here, at
 * the entry point, and nowhere below it. Everything the callback touches — the
 * net function, its retry wrapper, the lock it queues on — inherits the tag
 * through AsyncLocalStorage, so no signature in between has to carry it.
 *
 * `imapInteractive` means "a person is looking at this right now". Use it only
 * for work a user is actually waiting on; tagging bulk work interactive is how
 * a priority scheme quietly degrades back into FIFO.
 *
 * Two limits of the mechanism, spelled out because assuming the opposite is
 * cheap and finding out is not (full statement in packages/net/imapScheduler):
 *
 *  1. A scope is a CONTEXT, not a wrapper around one awaited call. It may span a
 *     whole pass, and anything detached inside it (`void f()`, `f().catch(...)`)
 *     inherits the tier and keeps it after the scope settles. A detached child
 *     that should not take its caller's tier must state its own — which is why
 *     `processMailRules` pins itself to `background` instead of inheriting
 *     `sync` from the periodic pass and `other` from the IPC handlers.
 *  2. A scope around a DEDICATED-connection call is inert: dedicated connections
 *     take no op lock and no pool slot, so there is no queue to order. Such call
 *     sites are marked at the call site, not left to look effective.
 */
function imapInteractive<T>(fn: () => Promise<T>): Promise<T> {
  return withImapPriority('interactive', fn)
}

/** §2.17 Phase 1 — periodic / queue-driven work nobody is watching land. */
function imapBackground<T>(fn: () => Promise<T>): Promise<T> {
  return withImapPriority('background', fn)
}

/** §2.17 Phase 1 — cache catch-up: header sync, offline body sync, replay. */
function imapSync<T>(fn: () => Promise<T>): Promise<T> {
  return withImapPriority('sync', fn)
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
    // §2.17 Phase 1 — the open path is the interactive tier by definition:
    // this budget expiring on our own queue is the defect the phase exists to
    // fix (a 10 941 ms `net:setSeen` behind an offline-sync EML burst).
    const fetchPromise = imapInteractive(() => fetchMessageDetails(accountId, cfg, mailbox, uid, ac.signal))
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
  // §2.145 wave 2.1 — the message was refused mid-stream for exceeding the
  // hard ceiling. Distinct from 'timeout' (the network was too slow) and from
  // 'ok' with a null raw (the server had nothing): here the server has plenty
  // and we declined to hold it. `bytesSeen` is a lower bound on the true size.
  | { kind: 'over_limit'; bytesSeen: number }

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
    // §2.17 Phase 1 — same tier as the body path: this is the per-folder
    // offline-mode branch of the SAME user-initiated open.
    const fetchPromise = imapInteractive(() => downloadRawMessage(accountId, cfg, mailbox, uid, ac.signal))
      .then((result): RawMessageOutcome => (
        result.kind === 'over_limit'
          ? { kind: 'over_limit', bytesSeen: result.bytesSeen }
          : { kind: 'ok', raw: result.kind === 'ok' ? result.raw : null }
      ))
      .catch((err): RawMessageOutcome => {
        if (err instanceof Error && err.name === 'AbortError') return { kind: 'timeout' }
        throw err
      })
    return await Promise.race([fetchPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * §2.145 wave 2.1 — the hard-cap placeholder for a message we never held.
 *
 * The parser-entry path builds this from the message's own header block
 * (`parseEmlHeaderFacts`). Here there are no bytes at all: the download was
 * refused mid-stream precisely so nothing would be allocated, and re-fetching
 * a prefix to pretty up a placeholder would hand back part of the primitive we
 * just removed. So the facts come from the row header sync already wrote —
 * subject, sender and date are in `messages` for every message the folder has
 * synced, which is every message that can be opened this way.
 *
 * `bytesSeen` is a LOWER BOUND — what we had counted when we stopped consuming,
 * not the message's true size — and it is what the placeholder reports, because
 * `messages` carries no size column to prefer over it. The renderer shows it as
 * the message's size, so it under-reports by at most one chunk beyond the
 * ceiling; against a number already past 100 MiB that is not a distinction the
 * user can act on, and the alternative (fetching the real size) means going
 * back to the server for a cosmetic figure.
 *
 * Shape is identical to the parser-entry placeholder, deliberately: the
 * renderer must not be able to tell which doorway refused the message.
 */
function buildHardCapPlaceholder(
  accountId: number,
  folder: string,
  uid: number,
  bytesSeen: number,
): MessageDetails {
  const cached = getMessageByUid(accountId, folder, uid)
  return {
    uid,
    envelope: {
      subject: cached?.subject ?? undefined,
      date: cached?.date ?? undefined,
      from: cached?.fromAddr
        ? [{ name: cached.fromName ?? undefined, address: cached.fromAddr }]
        : undefined,
      to: cached?.toAddr ? cached.toAddr.split(',').map(a => ({ address: a.trim() })) : undefined,
      messageId: cached?.messageId ?? undefined,
    },
    internalDate: cached?.date ?? undefined,
    flags: [
      ...(cached?.unread ? [] : ['Seen']),
      ...(cached?.flagged ? ['Flagged'] : []),
    ],
    parseCap: {
      kind: 'hard',
      rawBytes: bytesSeen,
      limitBytes: MAX_EML_PARSE_BYTES,
    },
  }
}

/** Build the offline-fallback envelope from cached headers. Used both by the
 *  workOffline branch and the IMAP-timeout / IMAP-error branches so the
 *  renderer sees one consistent shape.
 *
 *  §2.17 Phase 1 — `reason` is REQUIRED at every call site rather than
 *  defaulting to `'offline'`. The default is exactly what produced the lie: a
 *  branch that knows perfectly well the budget expired would keep silently
 *  emitting "offline" simply by not mentioning it. Making the parameter
 *  mandatory means a new fallback branch cannot be added without deciding what
 *  to tell the user. */
function buildOfflineFallback(
  cached: ReturnType<typeof getMessageByUid>,
  reason: NonNullable<MessageDetails['offlineFallbackReason']>,
): MessageDetails | null {
  if (!cached) return null
  return {
    offlineFallbackReason: reason,
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
/**
 * §2.145 — the details cache is the one way a capped build can still serve an
 * uncapped body, and `electron/cachedDetailGuard.ts` is where the decision
 * lives (extracted so it can be unit-tested against real rows, and to keep this
 * file from growing another predicate — CLAUDE.md §5 hotspot policy).
 *
 * Read that module for the derivation. The two things the CALLER is responsible
 * for, both of them ordering properties that a test pins:
 *
 *  - the serialized gate runs BEFORE `JSON.parse`, and both gates run BEFORE
 *    `putDetailsInCache`, so a refused row can neither cost an unbounded parse
 *    nor be laundered into the in-memory LRU and served from there all session;
 *  - a refused row is INVALIDATED on the spot. Falling through alone was not
 *    enough: it self-heals only where something rewrites the row, and the
 *    offline branch returns header facts WITHOUT writing the cache — so a
 *    legacy 50 MB row would have been re-parsed, and re-refused, on every open
 *    for as long as the user stayed offline. Emptying the column costs nothing
 *    real (it is a cache, and the message still exists on the server or in the
 *    on-disk EML) and makes the pathological parse a one-time event rather than
 *    a recurring one.
 */

/**
 * Drop a cached-detail row we have refused to serve.
 *
 * Writing the empty string rather than adding a delete to `packages/db`:
 * `getCachedDetail` returns the column verbatim and the read branch treats a
 * falsy value as "no row", so this is exactly "absent" to every reader, in one
 * statement, with no schema surface added for a cache eviction. Failure is
 * swallowed — being unable to tidy a cache row must not turn into a failed
 * message open; the row simply gets refused again, which is the state we were
 * already in.
 */
function invalidateCachedDetail(accountId: number, folder: string, uid: number): void {
  try { setCachedDetail(accountId, folder, uid, '') } catch { /* cache tidy-up is best-effort */ }
}

/**
 * §2.145 — the shared tail of the two EML branches of `net:messageDetails`:
 * index the body text, then cache the result. One helper because the two
 * branches had drifted-by-copy code that has to make the same decisions, and
 * getting any of them wrong is silent.
 *
 * WHAT IS WITHHELD, AND WHAT IS NOT (fix wave 0.1 — the first version of this
 * helper withheld the body text for BOTH caps, on a premise that turned out to
 * be false; the reasoning is written out because the false version was
 * plausible):
 *
 *  - A SOFT-capped result IS indexed, exactly like an uncapped one. The
 *    withheld version argued that the first megabyte of a body must not be
 *    stored as if it were the whole one — but `updateMessageBodyText`
 *    (packages/db/index.ts) has always sliced every body to 200 000 characters
 *    before storing it, and the soft cap is 1 MiB of BYTES, i.e. at least
 *    262 144 characters even for 4-byte UTF-8. For any message with a
 *    text/plain part the withheld row would therefore have been byte-identical
 *    to the uncapped one: the withholding bought nothing and cost real
 *    behaviour (see below).
 *
 *    The one narrow window where the two differ, stated honestly rather than
 *    waved away: an HTML-ONLY message whose markup-to-text ratio exceeds about
 *    5:1, where 1 MiB of HTML can reduce to fewer than 200 000 characters of
 *    plain text and the row then holds slightly less than an uncapped parse
 *    would have produced. That is a smaller version of a cliff that already
 *    exists — the body indexer's own IMAP path caps each part at 2 MiB
 *    (`MAX_BODY_BYTES`, packages/net/message.ts) — so this is not a new class
 *    of loss, only the same one 2x sooner on a path that also shows the user a
 *    banner saying the body was clipped.
 *
 *    What the withholding actually cost, and why it is gone: only these two EML
 *    branches route through this helper, so whether a large message was
 *    searchable NOW or only after the next indexer pass depended on a per-folder
 *    offlineMode toggle; in a folder excluded from search (Spam, Trash) the
 *    indexer never drains the row at all (`listFoldersWithPendingBodies`
 *    filters by `getIndexInSearchCached`), so `body_text` would have stayed NULL
 *    forever — instant reply refusing with `no_provider` and `query_db` seeing
 *    NULL, permanently; and in an offline-mode folder the full EML sits on disk
 *    precisely so the message works without the network, while its body stayed
 *    unsearchable until IMAP came back.
 *
 *  - A HARD-capped result is NOT indexed, for a much simpler reason than the
 *    one above: there is nothing to write. No body was decoded, so
 *    `getSearchableBodyText` returns null, and the row correctly stays NULL and
 *    therefore stays in the body indexer's queue. Skipping the call also avoids
 *    firing the FTS trigger for a write that would change nothing. The hard
 *    capped RESULT is still cached — the placeholder is the correct answer for
 *    that message, and re-deriving it means re-reading the header block off
 *    disk.
 *
 *  - A `full` re-parse is not written to either DETAILS cache (the in-memory
 *    LRU or `messages.cached_detail`). It exists for one click; persisting it
 *    would hand the raised-tier body to every later open of that message, and
 *    write it to disk, quietly making a one-off cost permanent. The clipped
 *    entry stays, so the next ordinary open is still a cache hit.
 *
 *    It MAY, deliberately, seed `body_text` — the indexing branch stands above
 *    the `wantFull` return. That is the good outcome and the contract is stated
 *    here rather than left to the reader: the user asked for the fuller parse,
 *    we already have it in hand, and letting it fill a NULL row takes the
 *    message out of the indexer queue with better content than the first tier
 *    would have supplied. Only ever a fill, never an overwrite —
 *    `hasBodyTextIndexed` still gates it.
 */
function cacheMessageDetails(
  accountId: number,
  folder: string,
  uid: number,
  details: MessageDetails,
  wantFull: boolean,
): void {
  if (details.parseCap?.kind !== 'hard' && !hasBodyTextIndexed(accountId, folder, uid)) {
    updateMessageBodyText(accountId, folder, uid, getSearchableBodyText(details))
  }
  if (wantFull) return
  putDetailsInCache(accountId, folder, uid, details)
  try { setCachedDetail(accountId, folder, uid, JSON.stringify(details)) } catch { /* non-critical */ }
}

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

handleIpc('net:messageDetails', async (_e, accountId: unknown, mailbox: unknown, uid: unknown, options: unknown) => {
  const id = accountIdSchema.parse(accountId)
  const parsedMailbox = mailboxSchema.parse(mailbox)
  const parsedUid = uidSchema.parse(uid)
  // §2.145 — an explicit "show full message" click, and nothing else, sets
  // this. Two consequences, both deliberate: the caches are BYPASSED on the way
  // in (they hold the clipped result, which is the thing the user is asking to
  // get past) and NOT WRITTEN on the way out (a cache entry holding a body up
  // to the raised tier would silently hand that body to every later open,
  // turning a one-off request into a persistent cost — and would persist it to
  // SQLite besides). The clipped entry therefore survives the click, which is
  // what makes the next ordinary open cheap again.
  const wantFull = messageDetailsOptionsSchema.parse(options)?.full === true

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
    const cached = wantFull ? null : getDetailsFromCache(id, parsedMailbox, parsedUid)
    if (cached) {
      logMail.info(`messageDetails memory cache hit: uid=${parsedUid} ${Date.now() - t0}ms`)
      finalizer.finalize('memory', cached)
      return cached
    }

    // Check DB cache — survives app restarts, avoids re-parsing large EML files
    try {
      const dbJson = wantFull ? null : getCachedDetail(id, parsedMailbox, parsedUid)
      if (dbJson && isServableCachedDetailJson(dbJson)) {
        const details = JSON.parse(dbJson) as MessageDetails
        if (isServableCachedDetail(details)) {
          putDetailsInCache(id, parsedMailbox, parsedUid, details)
          logMail.info(`messageDetails DB cache hit: uid=${parsedUid} ${Date.now() - t0}ms`)
          finalizer.finalize('db', details)
          return details
        }
        logMail.info(`messageDetails DB cache row refused (pre-cap body): uid=${parsedUid}`)
        invalidateCachedDetail(id, parsedMailbox, parsedUid)
      } else if (dbJson) {
        logMail.info(`messageDetails DB cache row refused (oversized row): uid=${parsedUid}`)
        invalidateCachedDetail(id, parsedMailbox, parsedUid)
      }
    } catch { /* corrupted cache — fall through to normal path */ }

    // §2.145 — an EML-BACKED e2e fixture deliberately does NOT take the
    // synthetic branch below.
    //
    // The synthetic branch answers from `E2E_BOXES` before `readEml()` is ever
    // reached, so under `IS_E2E` the whole parse pipeline — readEml,
    // parseEmlBuffer, the hard/soft caps, `cacheMessageDetails` — is
    // unreachable, and the parse-cap viewer had no end-to-end coverage at all.
    // A fixture injected WITH raw bytes (`e2e:injectMail` + `emlBase64` /
    // `emlPadToBytes`, which writes them through `saveEml`) therefore falls
    // through to the production path below and is served by the real code,
    // `{ full: wantFull }` passthrough included.
    //
    // Opt-in per fixture, never global: every existing spec keeps the synthetic
    // branch, because a fixture that was never given bytes has no `.eml` on
    // disk and would fall through to an IMAP fetch that does not exist here.
    // The discriminator is the marker set at injection time, not "is there a
    // file" — a missing file is then a loud failure in the spec that asked for
    // this path, rather than a silent switch back to synthetic content.
    const e2eFixture = IS_E2E
      ? (e2eBox(id, parsedMailbox).find(m => m.uid === parsedUid) ?? e2eFindInAnyBox(id, parsedUid))
      : undefined
    if (IS_E2E && !e2eFixture?.emlFixture) {
      const msg = e2eFixture
      const acc = E2E_ACCOUNTS.find(a => a.id === id)

      const addrList = (raw?: string) => {
        const emails = (raw || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        return emails.length > 0 ? emails.map(address => ({ address })) : undefined
      }

      // §2.172 — one verdict for the whole fixture: the envelope address handed
      // to the renderer is the exact `fromAddr` the list rows were seeded with.
      const sender = senderPartsFromHeader(msg?.from || 'alice@example.test')

      const details: MessageDetails = {
        uid: parsedUid,
        envelope: {
          subject: msg?.subject || 'E2E',
          date: msg?.date || new Date().toISOString(),
          from: [{ name: sender.fromName, address: sender.fromAddr || undefined }],
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
    //
    // §2.145 wave 2.1 — bounded: an oversized file is stat'd, never loaded, and
    // answered with a placeholder built from its header window alone. The
    // unbounded `readFileSync` this replaces meant the parse-entry cap was
    // being handed bytes that were already resident — the check ran, correctly,
    // after the allocation it was supposed to prevent.
    const emlRead = readEmlBounded(id, parsedMailbox, parsedUid)
    if (emlRead.kind === 'over_limit') {
      logMail.info(`EML over hard cap on disk: uid=${parsedUid} size=${emlRead.bytes}`)
      recordHardParseCapTrip(emlRead.bytes)
      // The prefix is the header window; `emlRead.bytes` is the file's true
      // size, which is what the placeholder must report — not the prefix's.
      const placeholder = await parseEmlHeaderFacts(parsedUid, emlRead.prefix, emlRead.bytes)
      cacheMessageDetails(id, parsedMailbox, parsedUid, placeholder, wantFull)
      finalizer.finalize('eml', placeholder)
      return placeholder
    }
    const localEml = emlRead.kind === 'ok' ? emlRead.raw : null
    if (localEml) {
      const t1 = Date.now()
      const parsedDetails = await parseEmlBuffer(parsedUid, localEml, { full: wantFull })
      // §2.22 Wave A — parseEmlBuffer skips attachment content for speed, so
      // recover any text/calendar payload from the raw buffer here. Cheap
      // (one mailparser pass on the bytes already in memory).
      const details = await enrichDetailsWithCalendarInvite(
        parsedDetails,
        { accountId: id, folder: parsedMailbox, uid: parsedUid },
        localEml,
      )
      logMail.info(`EML hit: uid=${parsedUid} size=${localEml.length} parse=${Date.now() - t1}ms total=${Date.now() - t0}ms`)
      cacheMessageDetails(id, parsedMailbox, parsedUid, details, wantFull)
      finalizer.finalize('eml', details)
      return details
    }
    logMail.debug(`EML miss: account=${id} folder=${parsedMailbox} uid=${parsedUid}`)

    // 1b. In workOffline mode, skip IMAP entirely — use cached headers
    if (getSettings().workOffline) {
      const cached = getMessageByUid(id, parsedMailbox, parsedUid)
      if (cached) {
        logMail.info(`Work-offline fallback for uid=${parsedUid}`)
        const fallback = buildOfflineFallback(cached, 'offline')
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
      const { cfg, accountGeneration } = await requireAccountConfig(id)
      assertImapAuth(id, cfg.imap, accountGeneration)

      // If per-folder offline mode is enabled — download full EML and cache on disk
      const folderPref = getFolderPref(id, parsedMailbox)
      if (folderPref && folderPref.offlineMode !== 'off') {
        const rawOutcome = await downloadRawMessageWithTimeout(id, cfg.imap, parsedMailbox, parsedUid)
        if (rawOutcome.kind === 'timeout') {
          logMail.warn(`Offline-mode raw download timed out (${IMAP_FETCH_TIMEOUT_MS}ms) for uid=${parsedUid}, returning cached headers`)
          const cached = getMessageByUid(id, parsedMailbox, parsedUid)
          const fallback = buildOfflineFallback(cached, 'timeout')
          if (fallback) {
            finalizer.finalize('imap_timeout', fallback)
            return fallback
          }
          const minimalFallback: MessageDetails = {
            uid: parsedUid,
            envelope: {},
            flags: [],
            offlineFallback: true,
            offlineFallbackReason: 'timeout',
          }
          finalizer.finalize('imap_timeout', minimalFallback)
          return minimalFallback
        }
        if (rawOutcome.kind === 'over_limit') {
          // §2.145 wave 2.1 — the message was never held, so the placeholder is
          // built from what header sync already put in the database rather than
          // from bytes. Same `MessageParseCap` shape the parser-entry path
          // produces, so the renderer needs no knowledge of where the refusal
          // happened.
          logMail.info(`Offline-mode raw download over hard cap for uid=${parsedUid} (stopped at ${rawOutcome.bytesSeen})`)
          recordHardParseCapTrip(rawOutcome.bytesSeen)
          const placeholder = buildHardCapPlaceholder(id, parsedMailbox, parsedUid, rawOutcome.bytesSeen)
          cacheMessageDetails(id, parsedMailbox, parsedUid, placeholder, wantFull)
          finalizer.finalize('imap', placeholder)
          return placeholder
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
          const parsedDetails = await parseEmlBuffer(parsedUid, raw, { full: wantFull })
          // §2.22 Wave A — same as the EML hit branch: re-scan the raw buffer
          // for a text/calendar part so the renderer's RSVP card lights up.
          const details = await enrichDetailsWithCalendarInvite(
            parsedDetails,
            { accountId: id, folder: parsedMailbox, uid: parsedUid },
            raw,
          )
          cacheMessageDetails(id, parsedMailbox, parsedUid, details, wantFull)
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
        const fallback = buildOfflineFallback(cached, 'timeout')
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
          offlineFallbackReason: 'timeout',
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
    } catch (bodyLoadErr) {
      // Loading the body failed — fall back to cached headers from DB.
      const cached = getMessageByUid(id, parsedMailbox, parsedUid)
      // §2.17 Phase 1 fix wave — 'unavailable', NOT 'offline'. Everything the
      // try block can throw arrives here: a rejected password, a TLS trust
      // failure, a mailbox that no longer exists, `assertImapAuth` refusing
      // before a socket was ever opened, and a genuinely dead network. Only
      // the last of those makes "you are offline / only headers are cached"
      // true, and telling the other four that story is the same lie this task
      // exists to remove — most visibly for the expired-password case, where
      // the §2.165 "sign in again" badge and a "you are offline" placeholder
      // would contradict each other on one screen.
      //
      // The block is also WIDER than the transport, and the wording has to
      // survive that: everything after the bytes arrive is inside the same
      // try — saveEml, setBodyDownloaded, parseEmlBuffer, the invite
      // enrichment, updateMessageBodyText, putDetailsInCache. A full disk is
      // the ordinary way to reach this catch with the message already in hand,
      // so neither the reason nor the sentence may say the server was at
      // fault; both say only that the body could not be LOADED, which stays
      // true whichever half failed. (Narrowing the catch to the transport
      // calls is a behaviour change — a save failure would then escape to the
      // renderer as a hard error instead of a headers-only placeholder — and
      // is deliberately NOT done here; it needs its own decision.)
      //
      // Why ONE reason rather than one per class of `classifyImapError`:
      //  - 'network' is that classifier's DEFAULT bucket (an unrecognised
      //    error is 'network'), so it cannot carry a positive claim about the
      //    network without inventing one;
      //  - the local `assertImapAuth` refusal is deliberately kept OUT of the
      //    classifier (it is a precondition, tagged with
      //    IMAP_AUTH_NOT_CONFIGURED_CODE — see accountAuthState.ts), and would
      //    be misfiled as 'network' if routed through it here;
      //  - 'auth' and 'cert' already own more authoritative surfaces — the
      //    re-auth badge, raised by the retry boundary only after
      //    AUTH_FAILURE_THRESHOLD consecutive failures, and the
      //    `cert:recoveryRequired` trust dialog. A per-message verdict off a
      //    single classification would be a second, weaker source of truth
      //    about the same fact, free to contradict the first.
      // The classification is still useful for DIAGNOSIS, where a misfile
      // costs nothing, so it goes in the log line below and nowhere else.
      const fallback = buildOfflineFallback(cached, 'unavailable')
      if (fallback) {
        logMail.warn(`Body load failed for message uid=${parsedUid} (class=${classifyImapError(bodyLoadErr)}), falling back to cached headers`)
        finalizer.finalize('db', fallback)
        return fallback
      }
      // No cached data — rethrow original error
      finalizer.finalize('db', null)
      throw bodyLoadErr
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)

  const { content } = await imapInteractive(() => downloadMessagePart(id, cfg.imap, parsedMailbox, parsedUid, parsedPart))
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)

  const { content } = await imapInteractive(() => downloadMessagePart(id, cfg.imap, parsedMailbox, parsedUid, parsedPart))
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
  try {
    await imapInteractive(() => moveMessages(cfg.imap, parsedFrom, parsedTo, parsedUids, id))
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
  try {
    await imapInteractive(() => deleteMessagesRemote(cfg.imap, parsedMailbox, parsedUids, id))
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
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
  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
  await renameMailbox(id, cfg.imap, parsedFrom, parsedTo)
  try {
    if (prevPref) {
      writeFolderPref(id, parsedTo, {
        visible: prevPref.visible,
        includeInBadges: prevPref.includeInBadges,
        headerSyncMode: prevPref.headerSyncMode,
        headerSyncDays: prevPref.headerSyncDays,
        offlineMode: prevPref.offlineMode,
        offlineDays: prevPref.offlineDays,
        icon: prevPref.icon,
      })
    }
    dropFolderPref(id, parsedFrom)
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)
  await deleteMailbox(id, cfg.imap, parsedPath)
  try { dropFolderPref(id, parsedPath) } catch { /* ignore */ }
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

  const { cfg, accountGeneration } = await requireAccountConfig(id)
  assertImapAuth(id, cfg.imap, accountGeneration)

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
  const uids = await imapInteractive(() => imapSearchFolder(id, cfg.imap, parsedFolder, criteria, lim))
  if (uids.length === 0) return []

  // Hydrate UIDs into full summaries (also upserts into local cache)
  const summaries = await imapInteractive(() => fetchSummariesByUids(cfg.imap, parsedFolder, uids, id))

  // §2.86 iter2, review finding 7: hydration persists messages, so this is a
  // message-persisting exit like the sync paths and owes the rule pipeline a
  // trigger. Fire-and-forget — search latency must not wait on rule actions.
  processMailRules(id, parsedFolder).catch(err =>
    logRules.error('Background processMailRules (remoteSearch) failed:', err)
  )

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
// §2.82: `sentryEnabled` is clamped to the effective permission on the way out
// — see `clampTelemetryForRenderer`. The renderer must never see a `true` that
// is merely the schema default with no consent record behind it.
handleIpc('settings:get', () => clampTelemetryForRenderer(getSettings()))

handleIpc('settings:save', async (event, s: unknown) => {
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
  //
  // §2.167 — the SAME safeParse now feeds two different verdicts, and the
  // order between them is the invariant: this gate (whole payload dies) runs
  // first and unchanged, per-field refusal only on the path it did not take.
  //
  // §2.167 branch C (codex, medium) — the gate is a STRICT PREFIX of the
  // handler: nothing at all runs before it, `getSettings()` included. That read
  // used to be the first line for the §2.119 reason quoted at its new position,
  // and it is not the pure lookup the name suggests — it runs
  // `ensureMigratedSingleAccountToAccounts()`, and on a legacy record it
  // sanitizes forbidden `mcpConnections[].env` keys, WRITES the store back and
  // raises an audit notification, while an unrescuable record makes it THROW.
  // A payload reaching for a main-only field therefore used to drive a
  // migration, a disk write and a telemetry-carrying audit before being
  // refused, and on the throwing path it lost the refusal — and its audit row —
  // to an exception. The gate answers from the payload alone, so it needs no
  // persisted state to answer with.
  const rendererParsed = rendererWritableSettingsSchema.safeParse(s)
  //
  // The payload is handed over so a per-field refusal can NAME the entries it
  // refused (`values`). They go back to the window that submitted them and
  // nowhere else — see the log and telemetry calls below, which stay on the
  // closed `field`/`code` vocabulary.
  const { forbidden, refusedFields, unhandledFields } = partitionRendererSettingsIssues(
    rendererParsed.success ? [] : rendererParsed.error.issues,
    s,
  )
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

  // §2.218.f2 — THE WHOLE-SAVE REFUSAL IS STATED HERE, not inherited from the
  // persisted schema further down.
  //
  // A known renderer-writable field whose VALUE failed the strict schema, and
  // which is not on the §2.167 refusal allowlist, kills the entire save. That
  // was always the documented contract, but it used to happen by accident: the
  // payload was merged and handed to `settingsSchema.parse`, which threw only
  // because the persisted schema rejected the same value. The two schemas exist
  // for different reasons, so that agreement was never guaranteed — and it
  // broke. `aiProvider` gained `.catch(undefined)` on the persisted side so a
  // removed provider sitting on DISK could not brick the settings load (§2.218);
  // the side effect was that a renderer PAYLOAD carrying the same removed value
  // stopped throwing and started silently resolving to "unset". Net effect
  // before this gate: a stale or compromised window could send
  // `aiProvider: 'subscription'`, CLEAR the user's configured provider, land
  // every other field of the payload and receive `{ ok: true }`.
  //
  // Placed after the §3.10 P0 main-only gate (which owns its own audit row and
  // reason code) and before ANY merge or write, so a refusal here leaves the
  // stored settings untouched.
  //
  // Deliberately a THROW rather than a new `reason` code or a per-field refusal:
  // `handleIpc` already turns a throw into a logged, PII-free-reported, tagged
  // rejection, and this is the behaviour every such payload had before the
  // coupling broke. Adding `aiProvider` to `REFUSABLE_FIELDS` was the tempting
  // alternative and is wrong: that list is an enumerated set of failures we have
  // reasoned about individually, and partial application is a courtesy to an
  // honest renderer — not something to extend to a payload naming a provider
  // this build does not have.
  //
  // Only field NAMES are logged (they come from our own schema); the offending
  // values never leave the payload (CLAUDE.md §8).
  if (unhandledFields.length > 0 && !rendererParsed.success) {
    logMain.warn(
      `settings:save rejected: unsupported value for renderer-writable field(s): ${unhandledFields.join(',')}`,
    )
    throw rendererParsed.error
  }

  // §2.167 — per-field refusal, and ONLY once the gate above found nothing.
  // A payload reaching for a main-only field is refused whole (above); a
  // payload whose single field carries an out-of-domain value (an export tool
  // name this build no longer exports, round-tripped out of the persisted
  // settings) loses that field and keeps the rest.
  //
  // Stripping happens BEFORE the merge below, which is what makes the refusal
  // non-destructive in both directions: `{ ...current, ...payload }` keeps the
  // PERSISTED value (no reset to a schema default), and the submitted value is
  // never activated. See electron/settingsSaveRefusal.ts for why the set of
  // refusable failures is an allowlist.
  //
  // Everything downstream reads `accepted`, not `s` — including the §2.119
  // destination resolution, so there is no path on which the raw payload can
  // reintroduce a field this handler decided to drop.
  //
  // §2.167 branch C (codex, high) — and a key that is PRESENT with `undefined`
  // is read as omitted for the fields whose absence widens a surface. Without
  // that, "leave the stored whitelist alone" spelled as `{ mcpExportWhitelist:
  // undefined }` erased it: the field is optional, so the schema is happy, the
  // merge below writes the `undefined` over the persisted array, and the export
  // server reads a nullish value as "no preference expressed" and serves its
  // DEFAULT set. See dropErasingUndefined in electron/settingsSaveRefusal.ts
  // for why this is an allowlist of two-line reach rather than a blanket
  // "drop every undefined" — an explicit `undefined` is load-bearing on this
  // same channel for the fields a save is supposed to be able to CLEAR.
  const accepted = dropErasingUndefined(stripRefusedFields(s, refusedFields))
  // The refusal is REPORTED (log + telemetry) only once the save below has
  // actually happened — see the emission site after `saveSettings`. Stripping
  // here and announcing there is deliberate: a payload can carry an unknown
  // export tool name AND a second field this handler still refuses whole
  // (`settingsSchema.parse` throws), in which case nothing is written at all
  // and "rest of the payload applied" would be a lie told to the log file and
  // counted in Sentry.
  //
  // Validation errors that are neither of the two above (bad enum on another
  // field, wrong type) still fall through to `.parse` below, which throws and
  // produces a useful zod error.

  // §2.119 — moving `aiOpenAiBaseUrl` / `aiProxyUrl` moves the address the
  // user's AI API key is delivered to, and this channel is one of the two
  // routes a renderer can do that through (the other is the `ai:checkAuth`
  // override — same guard, see below). The gate runs BEFORE anything is
  // merged or written: the guard only answers, it never writes settings, so a
  // refusal leaves the stored address exactly as it was.
  //
  // The values judged are the EFFECTIVE post-merge ones: a payload that omits
  // a field keeps the persisted value (so no prompt), a payload that carries
  // it — including an explicit `undefined`, which the settings window sends
  // for a cleared input — is a request to move to that value. `accepted` keeps
  // that distinction: neither address field is in `UNERASABLE_SETTINGS_FIELDS`
  // (pinned by a test), so the normalisation above cannot turn a clear into a
  // no-op here.
  //
  // §2.119 — `let`, not `const`: the AI-destination gate below can block on a
  // native dialog, and everything after it must merge onto a snapshot taken
  // AFTER that wait rather than one from before it. Read HERE rather than at
  // the top of the handler: see the §3.10 P0 gate above, which must be able to
  // refuse a payload without touching the persisted store at all.
  let current = getSettings()
  const requestedDestination = resolveRequestedAiDestination(accepted, current)
  const destinationVerdict = await ensureAiDestinationApproved(requestedDestination, event?.sender)
  // §2.103 — the same construction, one field over: a language whose
  // dictionary would have to be fetched from a third-party CDN needs a human,
  // and the gate is a native dialog main draws. It reads the consent record
  // itself (inside the service) rather than from `current`, so the decision is
  // never made against a baseline this handler read before an earlier dialog.
  //
  // The gate WRITES NOTHING — it answers. What it approves is folded into the
  // save below by `applySpellcheckDecision`, which is also what makes a refusal
  // non-destructive: the stored language list and the stored consent record are
  // untouched on every path through here.
  //
  // A payload that carries no `spellcheckLanguages` key asks for no change, and
  // the service short-circuits on an empty request — so an ordinary save (a
  // theme flip, an account edit) never raises a dialog.
  //
  // `undefined` (no key) and `[]` ("check nothing") are DIFFERENT requests, and
  // only the first one leaves the persisted list alone. Deriving the request
  // from the merged object instead would re-decide the stored list on every
  // unrelated save, and an unreadable availability list would then quietly
  // erase the user's dictionaries — a fail-closed answer is right for ARMING
  // the checker, never for rewriting what they chose.
  const requestedSpellcheckLanguages =
    Array.isArray((accepted as { spellcheckLanguages?: unknown }).spellcheckLanguages)
      ? (accepted as { spellcheckLanguages: string[] }).spellcheckLanguages
      : undefined
  const spellcheckVerdict = await ensureSpellcheckDictionariesApproved(
    requestedSpellcheckLanguages,
    event?.sender,
  )
  // Re-read unconditionally: the gate may have blocked on a native dialog the
  // user spent a minute on (whichever way they answered), and merging onto the
  // pre-dialog snapshot would resurrect whatever another window saved
  // meanwhile. When nothing was asked this is the same object contents.
  current = getSettings()

  // Merge incoming payload with current settings so that fields absent from the
  // save payload (e.g. aiPrivacyConsent) retain their persisted value instead of
  // being reset to schema defaults.
  //
  // §2.119 — refusal is non-destructive and partial: `applyAiDestinationDecision`
  // puts the two address fields back to what is stored, and everything else in
  // this save is still applied. Dropping the user's unrelated edits because
  // they declined one prompt would be a second, self-inflicted failure. The
  // renderer is told about the refusal in the return value below.
  //
  // The two address fields of the object about to be written are (re)written by
  // `applyAiDestinationOverrides`, i.e. by the same `resolveRequestedAiDestination`
  // rule that produced the values the guard judged. It is the plain spread's
  // own result today — that is the point: the equality is now held by shared
  // code instead of by two places agreeing, which is how `ai:checkAuth` drifted.
  // The rule is what is pinned, not the baseline: `current` was re-read after
  // the dialog, so a field this payload omits can carry a value another window
  // saved meanwhile (which needed its own confirmation to move) — see the same
  // note on `ai:checkAuth`.
  const merged = applyAiDestinationDecision(
    applyAiDestinationOverrides({ ...current, ...(accepted as Record<string, unknown>) }, accepted),
    current,
    destinationVerdict.ok,
  )
  // Force main-only fields back to their persisted values — defense-in-depth
  // against a spread that smuggled them past the schema check above (e.g. a
  // future regression that relaxes .strict()).
  for (const field of MAIN_ONLY_SETTINGS_FIELDS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (merged as any)[field] = (current as any)[field]
  }
  // §1.26.f2 — an AI consent may only name a mailbox that exists.
  //
  // The four per-account opt-ins are keyed by stringified account id, and the
  // settings window loads them ONCE (a `[]`-dependency effect) and sends all
  // four back whole on every save. Deleting an account purges its entries from
  // the store (`forgetAccountAiConsents`), but a window that was open across
  // that deletion still holds them, so its next ordinary save merges the purged
  // `true` back in — and ids are reused (`max + 1`), so a later mailbox can
  // inherit a grant its owner never gave.
  //
  // The registry is read HERE, after the post-dialog re-read of `current`, so
  // the list and the settings snapshot are of the same moment: a deletion that
  // landed while a native prompt was open is already visible in both.
  //
  // Runs over `merged`, not over the payload, so the same pass also clears
  // entries an older build persisted. What it cannot reach is the READ side —
  // the AI services read `getSettings()` directly, so such an entry survives
  // until the next save of any kind. See electron/accountKeyedConsents.ts.
  //
  // The roster consulted is the one `accounts:list` serves, which under
  // `MAILCOPILOT_E2E=1` in an unpackaged build is the in-memory `E2E_ACCOUNTS`
  // fixture — the same branch as `mail:openInWindow` and
  // `pendingMoveAccountExists`. Reading the config store here instead would
  // make this the one account lookup in main that disagrees with the rest of
  // the app: in e2e it reports NO accounts, so every consent the renderer can
  // legitimately hold would be pruned as belonging to nobody. Not a weaker
  // check — the accepted ids are exactly the ones the renderer was given.
  const knownAccountIds = (() => {
    try {
      const roster = IS_E2E ? E2E_ACCOUNTS : listAccounts()
      return new Set(roster.map(a => a.id))
    } catch { return null }
  })()
  const consentScope = knownAccountIds
    ? pruneUnknownAccountConsents(merged, ACCOUNT_KEYED_CONSENT_FIELDS, knownAccountIds)
    : keepStoredConsents(merged, current, ACCOUNT_KEYED_CONSENT_FIELDS)
  if (consentScope.changedFields.length > 0) {
    // Closed vocabulary only: the field names are our own constants and the
    // rest are counts. The account ids that were dropped are not named
    // (CLAUDE.md §8) — the count answers "did this happen", which is what a log
    // line is for here.
    logMain.warn('settings:save: account-keyed consent scoped to existing mailboxes', {
      fields: consentScope.changedFields.join(','),
      droppedEntries: consentScope.droppedEntries,
      mode: knownAccountIds ? 'pruned' : 'kept_stored',
    })
  }
  const parsed = settingsSchema.parse(consentScope.settings)
  // §2.82: the About switch is the GDPR art. 7(3) withdrawal path, so a flip
  // here moves the stored consent record too, and `sentryEnabled` is clamped to
  // that record (a switch cannot be "on" without consent — see applyAboutToggle).
  //
  // iter2 (finding 3): the RAW persisted flag is handed in so that a save made
  // while the consent answer is still pending preserves it instead of writing
  // the clamped `false` the renderer echoed back. Raw, not `current.*`, for the
  // same reason the consent migration reads raw: the parsed value cannot tell
  // "never written" from "explicitly false" once a schema default fills it in.
  //
  // iter3 (finding 5): the failure branch falls back to the PARSED current
  // value, not to `undefined`. `applyAboutToggle` reads anything other than
  // `false` as "no expressed refusal on disk" and writes `true`, so an
  // unreadable raw store used to promote a stored `false` — a real opt-out —
  // into `true` on the next unrelated save, and the user would be asked again.
  // `current.sentryEnabled` is the same value seen through the schema: it can
  // only differ from the raw one when the key is ABSENT (default fills it in),
  // and absent already means "not a refusal", so the substitution cannot invent
  // one either.
  const persistedSentryEnabled = (() => {
    try { return getRawPersistedSettings()?.sentryEnabled } catch { return current.sentryEnabled }
  })()
  // iter4 (security finding 1): the SENDER decides whether a value that turns
  // telemetry ON counts as an answer at all. Only the settings window shows
  // the switch and its disclosure, so only it can carry a "yes"; turning it
  // OFF stays accepted from every window (GDPR art. 7(3) — withdrawal must not
  // be harder than consent). See `applyAboutToggleFromOrigin`.
  const requestedSentryEnabled = parsed.sentryEnabled !== false
  const aboutToggleOrigin = isSettingsWindowSender(event?.sender) ? 'settings-window' : 'other-window'
  if (requestedSentryEnabled && !isTelemetryAllowed(current) && aboutToggleOrigin !== 'settings-window') {
    // No sender identity, no payload echo — both are renderer-derived (CLAUDE.md §8).
    logMain.warn('settings:save: telemetry enable ignored — sender is not the settings window')
  }
  // §2.103 — fold the consent answer in AFTER the main-only fields were forced
  // back: `spellcheckDictionaryConsent` is one of them, and the loop above
  // (rightly) restores the persisted value, so a grant written before it would
  // be discarded. The pure half decides what the two fields become —
  // approved-or-already-granted languages only, and a grant record that is a
  // UNION with what was granted before.
  const spellcheckDecision = requestedSpellcheckLanguages === undefined
    ? {}
    : applySpellcheckDecision({
      requested: normalizeSpellcheckLanguages(
        requestedSpellcheckLanguages,
        spellcheckVerdict.availability.languages,
      ),
      approvedNow: spellcheckVerdict.approved,
      previousConsent: current.spellcheckDictionaryConsent,
      platformOwned: spellcheckVerdict.availability.platformOwned,
      now: new Date().toISOString(),
    })
  const next = {
    ...parsed,
    mcpConnections: current.mcpConnections,
    ...spellcheckDecision,
    ...applyAboutToggleFromOrigin(
      current,
      requestedSentryEnabled,
      new Date().toISOString(),
      persistedSentryEnabled,
      aboutToggleOrigin,
    ),
  }
  saveSettings(next)
  // Update Sentry state at runtime. Re-attach the identity if the user
  // is flipping the toggle back on — the reverse path (on → off) is
  // handled internally by setSentryUserEnabled via Sentry.setUser(null).
  const wasEnabled = isTelemetryAllowed(current)
  const willBeEnabled = isTelemetryAllowed(next)
  setSentryUserEnabled(willBeEnabled)
  if (!wasEnabled && willBeEnabled) {
    setSentryUserId(getInstallIdHash())
  }
  // §2.167 — the refusal is announced HERE, after `saveSettings` returned:
  // "rest of the payload applied" is a claim about a write that has happened,
  // and everything between the strip above and this point can still end the
  // handler by throwing (`settingsSchema.parse` on a second, non-refusable bad
  // field is the reachable case). Emitting at strip time meant a compromised
  // renderer could pair an unknown export tool name with any other invalid
  // field and have main log — and count in Sentry — a save that never landed.
  //
  // Runs once per request, on the single path that reaches it: both success
  // returns below are downstream of this line, so neither can double-count.
  // After `setSentryUserEnabled`, so the event obeys the consent state THIS
  // save just wrote rather than the one it replaced (§2.82 — the gate stops
  // collection, not just delivery).
  for (const refused of refusedFields) {
    // CLAUDE.md §8: both values come from our own closed vocabulary
    // (settingsSaveRefusal.ts) — no renderer input, no zod message text.
    logMain.warn('settings:save: field refused, rest of the payload applied', {
      field: refused.field,
      code: refused.code,
    })
    // Usage counter for the refusal itself — how often installs carry a value
    // this build cannot accept. Fire-and-forget and swallowed: telemetry may
    // not decide whether a save completes.
    try {
      recordEvent('settings.field_refused', { field: refused.field, code: refused.code })
    } catch { /* telemetry must not block */ }
  }
  // Register/unregister as default mailto: handler based on user preference.
  if (next.defaultMailApp && !app.isDefaultProtocolClient('mailto')) {
    app.setAsDefaultProtocolClient('mailto')
  } else if (!next.defaultMailApp && app.isDefaultProtocolClient('mailto')) {
    app.removeAsDefaultProtocolClient('mailto')
  }
  // Notify all windows (main/settings etc.) about settings change so UI updates without restart.
  broadcastSettingsChanged(next)
  // Trigger main-process reactions (offline replay, periodic sync restart)
  onSettingsChangedMain(next)
  // §2.167 — `ok: true`, because the save DID happen: everything except the
  // named field was written. What the renderer must not do is treat this like
  // a plain success, so the refusal travels alongside: our own machine codes
  // plus the offending entries of the array the renderer just sent — no
  // sentence, no zod text. The values are what lets the settings window drop
  // the stale tool names from what it sends next without holding a copy of the
  // export ceiling; rendering the refusal is the renderer's half of this item.
  const refusal: { refused?: RefusedSettingsField[] } = refusedFields.length > 0
    ? { refused: refusedFields }
    : {}
  // §2.103 — the dictionary download was declined (or could not be asked
  // about), so those languages were not enabled. Say so instead of reporting a
  // plain success the window would render as "saved": the person picked a
  // language and it is not on. Only a COUNT travels — the language codes stay
  // out of the reply for the same reason they stay out of telemetry, and the
  // authoritative list has already been pushed to every window by
  // `broadcastSettingsChanged` above, which is what the picker re-renders from.
  //
  // Spread into BOTH success replies below, like `refusal`: the two gates are
  // independent, and a save can lose the address move AND a dictionary in the
  // same round trip.
  const spellcheckRejected = spellcheckVerdict.declined.length > 0
    ? {
      spellcheckDeclined: {
        count: spellcheckVerdict.declined.length,
        message: spellcheckDeclinedMessage(next.language),
      },
    }
    : {}
  // §2.119 — the address change was NOT applied: say so rather than reporting
  // a plain success the renderer would render as "saved". `message` is already
  // localized (main reads the same locale resources as the renderer — see
  // electron/services/aiDestinationGuard.ts), and `broadcastSettingsChanged`
  // above has already pushed the unchanged address back to every window.
  if (!destinationVerdict.ok) {
    return {
      ok: true as const,
      aiDestinationRejected: {
        reason: destinationVerdict.reason,
        fields: destinationVerdict.fields,
        message: aiDestinationRejectionMessage(destinationVerdict.reason, next.language),
      },
      ...refusal,
      ...spellcheckRejected,
    }
  }
  return { ok: true as const, ...refusal, ...spellcheckRejected }
})

// §2.82 — seed the consent record for installs that had already opted out, then
// register `telemetry:consentState` / `telemetry:setConsent`. Everything else
// about consent (state, persistence, e2e bypass, the grant metric) lives in the
// service; main only wires it.
initTelemetryConsent({
  broadcastSettings: settings => { broadcastSettingsChanged(settings) },
  // §2.82 iter3 — the consent screen renders in the main window only, so a
  // write from any other WebContents cannot be a click on it. Evaluated
  // lazily: this runs at module scope, before `win` exists.
  isMainWindowSender: sender =>
    !!win && !win.isDestroyed() && sender === win.webContents,
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
    // §2.145 — EML-backed fixture, the two ways to ask for one. Either gives
    // the message real bytes on disk and makes `net:messageDetails` serve it
    // from the production parse pipeline; neither is reachable outside e2e
    // (`assertE2EHandlerAllowed` above).
    //
    // `emlBase64` — exact bytes, for a fixture whose CONTENT matters (a
    // specific MIME shape, an attachment, a known body). Bounded so the payload
    // itself cannot be the resource exhaustion.
    emlBase64: z.string().max(E2E_MAX_FIXTURE_EML_BASE64_CHARS).optional(),
    // `emlPadToBytes` — a valid message of an exact SIZE, synthesised in main.
    // This is how a cap fixture is expressed: a soft-cap spec wants a body past
    // 1 MiB and a hard-cap spec wants a message past 100 MiB, and neither is
    // something to move across an IPC boundary as base64.
    emlPadToBytes: z.number().int().positive().max(E2E_MAX_FIXTURE_EML_BYTES).optional(),
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
  // §2.145 — give the fixture real bytes on disk, so the message-open path
  // exercises readEml → parseEmlBuffer → the caps → cacheMessageDetails rather
  // than the synthetic branch. See `writeE2EFixtureEml`.
  if (p.emlBase64 !== undefined || p.emlPadToBytes !== undefined) {
    writeE2EFixtureEml(p.accountId, p.folder, p.uid, mail, p.emlBase64, p.emlPadToBytes)
    mail.emlFixture = true
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

function uiWindowTitle(kind: ChildWindowKind): string {
  const lang = getSettings().language ?? 'en'
  const titles = WINDOW_TITLES[lang] ?? WINDOW_TITLES.en
  return `${titles[kind]} — MailCopilot`
}

/**
 * Child window factory — eliminates BrowserWindow configuration duplication.
 *
 * The option shape (including whether this kind gets a WM `parent`) is built
 * by the pure `buildChildWindowOptions()`; see `childWindowOptions.ts` for the
 * Compose/message-window unparenting rationale (§3.3.B4.f6). Standalone kinds
 * additionally get explicit placement over the main window and join the
 * registry that reproduces the parent-teardown lifetime.
 */
function createChildWindow(kind: ChildWindowKind, width: number, height: number, hash: string): BrowserWindow {
  const standalone = isStandaloneWindowKind(kind)
  const placement = standalone ? centerOverMainWindow(width, height) : {}
  const child = new BrowserWindow(buildChildWindowOptions<BrowserWindow>({
    kind,
    width,
    height,
    x: placement.x,
    y: placement.y,
    title: uiWindowTitle(kind),
    backgroundColor: themeBg(),
    iconPath: path.join(process.env.VITE_PUBLIC, 'icon.png'),
    preloadPath: path.join(__dirname, 'preload.mjs'),
    additionalArguments: childBrowserArgs(),
    cornerOptions: framelessCornerOptions(),
    parent: win,
  }))
  if (standalone) registerStandaloneChildWindow(child)
  child.once('ready-to-show', () => child.show())
  child.on('maximize', () => { if (!child.isDestroyed()) child.webContents.send('win:maximizeChanged', true) })
  child.on('unmaximize', () => { if (!child.isDestroyed()) child.webContents.send('win:maximizeChanged', false) })
  // Settings / Account / Compose: no `mail:link` subscriber (useMailLinkClick
  // lives in App.tsx and MailWindow.tsx only), so the context menu there
  // offers editing and "copy link address" but not "open link in browser".
  configureExternalLinks(child, { routesMailLinks: false })
  if (VITE_DEV_SERVER_URL) child.loadURL(VITE_DEV_SERVER_URL + '#' + hash)
  else child.loadFile(path.join(RENDERER_DIST, 'index.html'), { hash })
  return child
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return }
  settingsWin = createChildWindow('settings', 720, 640, '/settings')
  settingsWin.on('closed', () => { settingsWin = null })
}

/**
 * §2.82 iter4 — is this `IpcMainInvokeEvent.sender` the SETTINGS window?
 *
 * Sibling of the `isMainWindowSender` predicate handed to the consent service,
 * and built the same way: identity against the live `BrowserWindow` handle,
 * evaluated per call (the window does not exist at handler-registration time),
 * fail-closed on every uncertainty. It deliberately does NOT reuse
 * `isMainWindowSender` — the About switch lives in this CHILD window, so the
 * main-window predicate would reject the one sender that is allowed to turn
 * telemetry on and leave the user unable to consent after a refusal.
 *
 * The single `settingsWin` handle above is the existing bookkeeping for this
 * window (`openSettingsWindow` focuses it instead of opening a second one, and
 * `closed` clears it), so there is no parallel window registry here.
 */
function isSettingsWindowSender(sender: unknown): boolean {
  return !!settingsWin && !settingsWin.isDestroyed() && sender === settingsWin.webContents
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
/**
 * §3.3 B6 (draft side): the compose context carries a PENDING suggestion, not a
 * value. `ui:openCompose` must stay synchronous — opening the window may not
 * wait on an advisory caption — so it STARTS the detection and parks the promise
 * here; both delivery paths settle it through the one helper
 * (`settleTargetLangSuggestion`), which gives up after a ceiling and hands over
 * `null`. Losing the suggestion costs an empty target picker and nothing else.
 */
let composeCtx: {
  accountId: number
  init: ComposeInit | null
  suggestion: PendingTargetLangSuggestion
} | null = null
/**
 * §3.3.B6.f2: the ticket every `ui:openCompose` claims, so a delivery that had
 * to wait for a suggestion can tell whether the user has since opened something
 * else. The rule and the reason it exists live in `createComposeOpenSequence`
 * (services/composeTranslate.ts); this is the wiring.
 */
const composeOpenSeq = createComposeOpenSequence()

/** Attach a settled suggestion to an init payload. Absent init (a blank new
 *  message) stays absent — there is no reply whose language could be read. */
function withSuggestedTargetLang(
  init: ComposeInit | null,
  suggested: TranslateLanguageCode | null,
): ComposeInit | null {
  return init ? { ...init, suggestedTargetLang: suggested } : init
}

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

  // §3.3 B6 (draft side): start the local language detection now, deliver it
  // later. `parsedInit.suggestedTargetLang` cannot arrive from the renderer —
  // the schema above is `.strict()` and does not name the field, so a renderer
  // that sends one gets this whole request rejected rather than having the value
  // stripped. Main is the only minter.
  const suggestion = startTargetLangSuggestion(parsedInit?.replyRef ?? null)
  // Claimed AFTER the parse (a rejected request supersedes nothing) and BEFORE
  // any await, which is what makes the check inside `deliverIfStillCurrent`
  // mean anything.
  const openTicket = composeOpenSeq.next()

  if (composeWin && !composeWin.isDestroyed()) {
    // Window already exists — always reset the form via compose:init.
    // If parsedInit === null — this is "Compose" (new empty message).
    // If the page is still loading (window just created) — wait for did-finish-load.
    composeWin.focus()
    // The SAME ceiling as the `compose:getInit` path, and the supersession check
    // this path needs and that one does not (§3.3.B6.f2 — see
    // `createComposeOpenSequence`): the arrival of a reused window's new init is
    // what resets the remembered target language, so it must carry the new
    // letter's suggestion with it, and it must not arrive after a newer letter's.
    const send = () => deliverIfStillCurrent(
      composeOpenSeq,
      openTicket,
      suggestion,
      (suggested) => {
        if (composeWin && !composeWin.isDestroyed()) {
          composeWin.webContents.send('compose:init', {
            accountId,
            init: withSuggestedTargetLang(parsedInit, suggested),
          })
        }
      },
    )
    if (composeWin.webContents.isLoading()) {
      composeWin.webContents.once('did-finish-load', () => { void send() })
    } else {
      void send()
    }
    return
  }

  // New window — save init for compose:getInit (called on first render of Compose.tsx)
  composeCtx = { accountId, init: parsedInit, suggestion }
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

handleIpc('compose:getInit', async () => {
  const ctx = composeCtx
  composeCtx = null
  if (!ctx) return ctx
  // Bounded wait, then `null` — see `composeCtx`. The renderer sees the same
  // shape it always did, with one more optional field on `init`.
  const suggested = await settleTargetLangSuggestion(ctx.suggestion)
  return { accountId: ctx.accountId, init: withSuggestedTargetLang(ctx.init, suggested) }
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
  //
  // The roster consulted is the same one `accounts:list` serves, which under
  // `MAILCOPILOT_E2E=1` is the in-memory `E2E_ACCOUNTS` fixture (mirroring
  // `pendingMoveAccountExists` and the `accountExists` predicate wired into
  // `initAccountAuthState`). Checking the config store instead made this the
  // only account lookup in main.ts that disagreed with the rest of the app: in
  // e2e the guard rejected every id the renderer could legitimately hold, so
  // the handler never created a window and its behaviour was untestable
  // end-to-end. The check is not weakened — the accepted ids are exactly the
  // ones the renderer already receives from `accounts:list`.
  const accountKnown = IS_E2E
    ? E2E_ACCOUNTS.some(a => a.id === input.accountId)
    : listAccounts().some(a => a.id === input.accountId)
  if (!accountKnown) throw new Error('Unknown accountId')

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

  // §3.3.B4.f6 — 'mailWindow' is a standalone kind: buildChildWindowOptions
  // attaches no `parent`, so GNOME/Mutter keeps the maximize function on this
  // window (a transient window is a dialog and cannot be maximized). Being
  // standalone it also owns its placement, and it uses the same policy as
  // Compose — see `centerOverMainWindow`, which superseded this handler's own
  // `offsetFromMainWindow()` (unclamped horizontally, wrong display pick).
  const placement = centerOverMainWindow(width, height)
  const child = new BrowserWindow(buildChildWindowOptions<BrowserWindow>({
    kind: 'mailWindow',
    width,
    height,
    x: placement.x,
    y: placement.y,
    title: uiWindowTitle('mailWindow'),
    backgroundColor: themeBg(),
    iconPath: path.join(process.env.VITE_PUBLIC, 'icon.png'),
    preloadPath: path.join(__dirname, 'preload.mjs'),
    additionalArguments: childBrowserArgs(),
    cornerOptions: framelessCornerOptions(),
    parent: win,
  }))
  registerStandaloneChildWindow(child)
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
  // Standalone message window: MailWindow.tsx mounts useMailLinkClick, so
  // `mail:link` has a consumer here too.
  configureExternalLinks(child, { routesMailLinks: true })
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
  generateProofreadCheck,
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
  ProofreadResult,
  TranslateMessageResult,
  TranslateDraftResult,
  TranslateLanguageCode,
} from '@mailcopilot/types'

/**
 * §2.218 — THE ONE PLACE main.ts spells the AI provider set.
 *
 * Every IPC entry point that accepts a provider from the renderer parses
 * against this schema: `ai:chat`, `ai:checkAuth`, `ai:saveApiKey`,
 * `ai:deleteApiKey` and `aiSession:create`. It was five hand-written copies of
 * the same `z.enum([...])` literal, which is exactly the shape that lets a
 * removed member survive in one forgotten call site — `aiSession:create` was
 * the forgotten one, and it took `z.string().min(1)`, so a stale or
 * compromised renderer could keep minting NEW session rows labelled with the
 * removed `subscription` provider long after the provider itself was gone.
 *
 * WRITERS ONLY. Historical READS stay opaque strings by design: the
 * append-only audit log, the cost ledger and persisted session rows
 * legitimately carry ids that are no longer selectable, and validating that
 * history against this enum would blank the user's own records (see
 * `AiPrivacyPanel` and `aggregateAiUsage`). The asymmetry is the contract —
 * strict on the way in, opaque on the way out.
 */
const aiProviderSchema = z.enum(['anthropic-api', 'openai-api', 'gemini-api'])

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
  // No `replyRef` on an AI-authored draft either — nothing to suggest.
  composeCtx = { accountId: data.accountId, init, suggestion: null }
  openComposeWindow()
})

// §2.17 Phase 1 — the scope covers the WHOLE callback, not the two net calls
// inside it. This runs only from an `mail_action_apply` the user just confirmed
// in the chat, so the tier belongs to the REASON — a person is waiting on the
// answer — and every IMAP call the callback makes on the way there deserves it,
// including `listMailboxes`, which is not a leaf anybody would think to tag.
// The inner `imapInteractive` calls are gone: the ambient tier already covers
// them, and leaving them would suggest the untagged calls between them are
// deliberately lower.
setMailActionCallback(async (input: MailActionApplyRequest) => imapInteractive(async () => {
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
    const { id, meta, cfg, accountGeneration } = await requireAccountConfig(group.accountId)
    assertImapAuth(id, cfg.imap, accountGeneration)
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
}))

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
      assertImapAuth(loaded.id, loaded.cfg.imap, loaded.accountGeneration)
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

// §2.17 Phase 1 — a person asked the assistant about this message and is waiting
// on the reply, so the whole callback is interactive. Scoping the callback rather
// than the `fetchMessageDetails` line inside it is the point: the tier is a
// property of the reason, and the local-EML branch above may yet grow an IMAP
// call of its own.
setListAttachmentsCallback(async (accountId, folder, uid) => imapInteractive(async () => {
  logAI.info(`listAttachmentsCallback accountId=${accountId} folder=${folder} uid=${uid}`)
  try {
    // First check local EML (offline)
    const localEml = readEml(accountId, folder, uid)
    if (localEml) {
      const details = await parseEmlBuffer(uid, localEml)
      // §2.145 — forward the cap verdict. `details.attachments` is `undefined`
      // both for a message with no attachments and for a hard-capped message
      // that was never decoded; without `parseCap` the AI layer cannot tell the
      // two apart and would assert "no attachments" about a message nobody
      // opened. See `AttachmentListResult` in services/ai.ts.
      return { ok: true as const, attachments: details.attachments || [], parseCap: details.parseCap }
    }
    // Otherwise — from IMAP. This path walks BODYSTRUCTURE and knows no parse
    // caps, so an empty list here really does mean "none".
    const { cfg } = await requireAccountConfig(accountId)
    const details = await fetchMessageDetails(accountId, cfg.imap, folder, uid)
    return { ok: true as const, attachments: details.attachments || [] }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logAI.error(`listAttachmentsCallback → ${message}`)
    return { ok: false as const, error: message }
  }
}))

// §2.17 Phase 1 — same reason as `listAttachmentsCallback`, and here the scope
// earns its keep twice over: the callback makes TWO pooled IMAP calls
// (`downloadMessagePart` then `fetchMessageDetails` for the metadata), and only
// the first one used to carry the tier. The second inherits it now instead of
// entering as `other`, which is what made a person's own download queue behind
// bulk work halfway through. The inner `imapInteractive` is dropped as redundant.
setDownloadAttachmentCallback(async (accountId, folder, uid, part) => imapInteractive(async () => {
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
}))

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
    const { cfg, accountGeneration } = await requireAccountConfig(input.accountId)
    assertImapAuth(input.accountId, cfg.imap, accountGeneration)
    await imapInteractive(() => setFlagged(cfg.imap, input.folder, input.uids, input.flagged, input.accountId))
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
    const { cfg, accountGeneration } = await requireAccountConfig(input.accountId)
    assertImapAuth(input.accountId, cfg.imap, accountGeneration)
    await imapInteractive(() => moveMessages(cfg.imap, input.fromFolder, input.toFolder, input.uids, input.accountId))
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
  const provider = aiProviderSchema.optional().parse(
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
  //
  // §2.218 — BOTH branches below are POSITIVE equality checks against live
  // providers, and that is what makes a legacy session safe. After the
  // `subscription` provider was removed, an affected user's `aiProvider` is
  // dropped from settings on load, so `effectiveProvider` resolves to
  // `undefined` and NEITHER branch fires: no history is loaded and, critically,
  // the session's stored `claudeSessionId` is never substituted into
  // `effectiveSid`. The turn then fails cleanly with "AI provider not
  // configured" from `aiChat`. Note the decision reads the SETTINGS provider,
  // never the session row's own `provider` column — a row labelled with a
  // removed provider cannot steer this. Do not rewrite either check as a
  // negative (`!== 'openai-api'`): that would make an unknown/legacy provider
  // fall INTO a branch instead of out of all of them.
  let history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined
  let effectiveSid = sid
  if (sid) {
    const effectiveProvider = provider || getSettings().aiProvider
    if (effectiveProvider === 'openai-api' || effectiveProvider === 'gemini-api') {
      const msgs = getLastAiMessages(sid, 40)
      if (msgs.length > 0) history = msgs.map(m => ({ role: m.role, content: m.content }))
    }
    if (effectiveProvider === 'anthropic-api') {
      const session = getAiSession(sid)
      // §2.218.f2 — THE ROW'S OWN PROVIDER MUST MATCH before its resume material
      // is consumed. `claude_session_id` is provider-specific state minted by
      // whichever provider created the row, and the removed `subscription`
      // provider minted it against the user's CONSUMER Claude session. Gating on
      // the CURRENT provider alone let that id cross into an `anthropic-api`
      // request — reached by an honest user simply reopening an old chat, or by
      // a compromised renderer passing an explicit provider override for a
      // session it did not create. Resume material is not fungible across
      // providers, so a mismatch starts a FRESH session instead: `effectiveSid`
      // stays the app-level id and the SDK is given no `resume`.
      //
      // Compared as an opaque string on purpose. The row is HISTORY and may name
      // a provider that no longer exists (that is the whole point here), so it
      // must not be validated against the live provider union — only compared to
      // the provider about to run. A row with no provider recorded fails the
      // comparison and therefore does not resume, which is the safe direction.
      if (session?.claudeSessionId && session.provider === effectiveProvider) {
        effectiveSid = session.claudeSessionId
      } else if (session?.claudeSessionId) {
        logAI.info(
          `ai:chat resume skipped: session provider does not match the provider for this turn (requestId=${reqId})`,
        )
      }
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

handleIpc('ai:checkAuth', async (event, providerOverride?: unknown, settingsOverrides?: unknown) => {
  const parsedProvider = aiProviderSchema.optional().parse(
    typeof providerOverride === 'string' ? providerOverride : undefined
  ) as AiProvider | undefined

  // Optional settings overrides (proxy, aiOpenAiBaseUrl) not yet saved.
  // The schema lives next to the merge rule that consumes it — see
  // electron/services/aiDestination.ts.
  const overrides = aiDestinationOverridesSchema.parse(
    typeof settingsOverrides === 'object' && settingsOverrides ? settingsOverrides : undefined
  )

  if (IS_E2E) {
    const settings = getSettings()
    const provider = parsedProvider || settings.aiProvider
    if (!provider) return { status: 'not_configured' as const }
    return { status: 'authenticated' as const, email: 'e2e@mock.local' }
  }

  // §2.119 — THE SECOND WRITE PATH. These overrides are never persisted, but
  // persistence was never what mattered: the OpenAI check does
  // `GET ${base}/v1/models` with `Authorization: Bearer <the user's key>`, so
  // an unguarded endpoint override hands the key to an attacker-chosen host on
  // one IPC call — without leaving a trace in the settings the user could
  // inspect afterwards — and a proxy override puts a chosen party on the path
  // of every AI request. Same guard, same comparison as `settings:save`; a
  // destination already confirmed there (or here) is not asked about twice.
  //
  // ONE MERGE RULE, and it is a shared function rather than a rule written
  // twice: `resolveRequestedAiDestination` produces the values judged here AND
  // (through `applyAiDestinationOverrides`) the values the request below is
  // built from. This path previously composed its own `overrides?.x ?? persisted.x`,
  // which silently disagreed with the spread that followed it: zod keeps a key
  // sent as an explicit `undefined` as an own property, so `??` read a CLEAR as
  // "unchanged" while the spread performed it — the endpoint reverted to the
  // vendor default, carrying the key, with no dialog. Judged and used must be
  // the same code.
  //
  // `withEffectiveProvider` carries the provider this call will actually run
  // under — it arrives as a separate argument, and the request below uses it —
  // because the warning text describes a composite state (provider × endpoint
  // scheme × proxy). Without it the dialog would describe the stored provider
  // while the request tests another one.
  const persisted = getSettings()
  const requestedDestination = withEffectiveProvider(
    resolveRequestedAiDestination(overrides, persisted),
    parsedProvider,
  )
  const destinationVerdict = await ensureAiDestinationApproved(requestedDestination, event?.sender)
  if (!destinationVerdict.ok) {
    // Not "authenticated", and not a verdict about the key either: the check
    // simply did not run. Falling back to the persisted address instead would
    // report success for an endpoint the user never asked about.
    return {
      status: 'error' as const,
      message: aiDestinationRejectionMessage(destinationVerdict.reason, persisted.language),
    }
  }

  // Re-read: the gate above can block on a native dialog. Any settings save
  // that landed meanwhile either left the address alone or was itself refused
  // while a confirmation was open, so the fresh values cannot carry a
  // destination this call did not have confirmed.
  //
  // The overrides are applied by the SAME resolver the verdict was formed
  // from, so the MERGE RULE can no longer be a source of divergence.
  //
  // What that does NOT guarantee, stated plainly because an overstated comment
  // is worse than none: the baseline underneath it can still move. A
  // `settings:save` that lands during the dialog can change a field this
  // payload omits, and the pair used below is then not literally the pair the
  // dialog named. The guarantee is narrower — every address in that pair was
  // approved by a human: the field this payload asked for, just now, and the
  // omitted one on its own save path (a save that moved it during an open
  // dialog is refused as `busy`, so it either predates this call or carried
  // its own confirmation). No unapproved recipient can appear; an approved
  // combination the user was not shown as a combination can.
  const settings = applyAiDestinationOverrides(getSettings(), overrides)
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

// §2.122 — the provider is REQUIRED here for the same reason it is on
// `ai:deleteApiKey`: an argument-less call must fail, not be reinterpreted.
// This handler used to default a missing provider to Anthropic, so a caller
// that simply forgot the argument — a compromised renderer, but far more
// likely an honest maintenance slip — silently OVERWROTE the Anthropic key
// with a key belonging to some other provider. The zod parse below is
// non-optional, so such a call now rejects instead of destroying a credential.
handleIpc('ai:saveApiKey', async (_e, key: unknown, provider?: unknown) => {
  const k = z.string().min(1).parse(key)
  const p = aiProviderSchema.parse(
    typeof provider === 'string' ? provider : undefined
  ) as ApiKeyProvider
  await aiSaveApiKey(k, p)
  // §2.122 — saveApiKey stamps the non-secret "a key was saved" marker in
  // settings; push the fresh record to the windows so their copy does not
  // stay stale until the next restart.
  broadcastSettingsChanged(getSettings())
  return { ok: true as const }
})

// §2.122 — the provider is REQUIRED here, and a call without one is rejected
// rather than reinterpreted. The renderer used to invoke this channel with no
// argument at all, and the service read that as "delete every provider's key":
// one click on "change provider" destroyed three keys. The zod parse below is
// non-optional, so the same call now fails loudly instead of destroying data.
handleIpc('ai:deleteApiKey', async (_e, provider?: unknown) => {
  const p = aiProviderSchema.parse(
    typeof provider === 'string' ? provider : undefined
  ) as ApiKeyProvider
  await aiDeleteApiKey(p)
  broadcastSettingsChanged(getSettings())
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
    // generator's paid path reaches here: a missing provider is refused upstream,
    // so no reservation is ever booked for a call that will not be made.
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
          provider: (['anthropic-api', 'openai-api', 'gemini-api', 'local'] as const)
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

// §3.3 B7 AI Proofread — same thin shape: validate, forward, return the
// discriminated union verbatim. The generator (services/composeAi.ts, wired
// through services/ai.ts) owns the opt-in gate, the §2.78 re-split, the
// untrusted wrap, budget, audit, span and the whole refusal ladder. Note what
// is deliberately absent: nothing in the send path (`mail:send`, the send
// queue, Compose) consults this handler or its result — the corrector is
// informational and can never block sending (§3.3 B7 AC-f).
handleIpc('ai:proofread:check', async (_e, payload: unknown): Promise<ProofreadResult> => {
  const req = proofreadCheckSchema.parse(payload)
  return generateProofreadCheck(req)
})

// §3.3 B6 AI Translate — the same thin shape: validate, forward, return the
// discriminated union verbatim. The generator (services/aiTranslate.ts) owns the
// per-account opt-in gate, the cache-sourced message text, the local language
// detection, the untrusted wrap, budget, cache, audit, span and the whole
// refusal ladder. Note what is deliberately absent here: no automatic call on
// message open — a translation only ever happens because the user asked for one.
handleIpc('ai:translate:message', async (_e, payload: unknown): Promise<TranslateMessageResult> => {
  // Parse drops anything the shape does not name; there is no free-text field
  // on this channel at all, so no message body can arrive from the renderer.
  const req = translateMessageSchema.parse(payload)
  return translateMessage(req)
})

// §3.3 B6 AI Translate, DRAFT side — same thin shape. The generator
// (services/composeTranslate.ts) owns the opt-in gate, the §2.78 re-split, the
// untrusted wrap, budget, audit, span and the whole refusal ladder. Note what is
// deliberately absent: nothing calls this on window open, on the suggested
// language arriving, or on the user changing it — a draft translation only ever
// happens because the user pressed the button.
handleIpc('ai:translate:draft', async (_e, payload: unknown): Promise<TranslateDraftResult> => {
  // Parse drops anything the shape does not name; the only free text on this
  // channel is the draft itself, which the generator re-splits and wraps.
  const req = translateDraftSchema.parse(payload)
  return translateDraft(req)
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

// §2.218 — the provider is validated against the live set, not merely required
// to be a non-empty string. This was the one renderer-reachable WRITER that
// still took free text, so it could mint NEW rows labelled with the removed
// `subscription` provider — a stale Settings window mid-upgrade would do it by
// accident, and a compromised renderer on purpose. Reading such rows stays
// tolerant (see `aiProviderSchema`); creating them does not.
handleIpc('aiSession:create', (_e, data: unknown) => {
  const parsed = z.object({ id: z.string().min(1), provider: aiProviderSchema }).parse(data)
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
          assertImapAuth(account.id, cfg.imap, result.accountGeneration)
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
              //
              // §2.145 wave 2.1 — the budget goes DOWN to the download, which
              // stops consuming when it is exceeded. Previously the whole
              // message was buffered and only then measured, so this loop was
              // an unbounded allocation primitive a remote sender could aim at
              // any offline-mode folder. Note which budget: the folder's own
              // limit when it has one, and the hard ceiling when it does not —
              // `maxSizeBytes <= 0` means "no per-file limit", which used to
              // mean "no limit at all" and let an oversized message be written
              // to disk.
              const budget = maxSizeBytes > 0 ? Math.min(maxSizeBytes, MAX_EML_PARSE_BYTES) : MAX_EML_PARSE_BYTES
              // §2.17 Phase 1 — THE call site from the incident: this loop takes
              // the singleton lock once per EML (31 of them in the logged
              // window), which is what an interactive open and a `net:setSeen`
              // were queued behind. Sync tier — it yields to the open, and the
              // overtake counter still guarantees it drains.
              const outcome = await imapSync(() => downloadRawMessage(account.id, cfg.imap, pref.folderPath, uid, undefined, budget))
              if (outcome.kind === 'over_limit') {
                // Same bookkeeping as the old oversize branch — record a size
                // so this uid is not retried on every sync — but reached
                // WITHOUT ever holding the message. `bytesSeen` is a lower
                // bound on the true size, which is all this row needs: it only
                // has to exceed the limit that rejected it.
                setBodyDownloaded(account.id, pref.folderPath, uid, false, outcome.bytesSeen)
                logSync.debug(`Skipped uid=${uid} (over ${budget} byte budget, stopped at ${outcome.bytesSeen})`)
                if (outcome.bytesSeen > MAX_EML_PARSE_BYTES) recordHardParseCapTrip(outcome.bytesSeen)
              } else if (outcome.kind === 'ok') {
                const raw = outcome.raw
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

  // FTS5 index maintenance: keeps segments from accumulating without ever
  // holding the event loop. §2.156 replaced the blocking `optimize` pass that
  // used to live here (4.3 s per call on a 110 MB index, eight times a
  // session) with an incremental merge cycle; scheduling, budgets and the
  // pause between steps live in electron/services/ftsMaintenance.ts.
  if (!IS_E2E) {
    startFtsMaintenance({
      mergeStep: mergeFtsIndexStep,
      segmentCount: ftsSegmentCount,
      // The merge writes SQLite state, so it must not run after the shutdown
      // WAL checkpoint — the cycle re-checks this between every step.
      shouldStop: () => shuttingDown,
    })
  }

  // Background body indexer for Search Excellence
  if (!IS_E2E) {
    const fetchBodyForIndexer: FetchBodyFn = async (accountId, folder, uid) => {
      try {
        const { cfg } = await requireAccountConfig(accountId)
        // Per-account pool (`withImapRetryPerAccount` + `connectImapPerAccount`,
        // bounded by MAX_CONNECTIONS_PER_ACCOUNT=3) — deliberately NOT the main
        // singleton, which interactive message open uses and which a background
        // body fetch would block.
        //
        // The previous comment here claimed this call opened "its own
        // short-lived dedicated connection"; it does not, and has not since
        // fetchMessageBody was routed through the pool. Corrected because the
        // isPaused decision below turns on which connection family this uses.
        // §2.17 Phase 1 — the indexer is the lowest tier there is: it produces
        // search coverage nobody is waiting on, and it is the single biggest
        // producer of pool work (30 bodies per batch). It never overtakes an
        // open, and the overtake counter in ./imapScheduler still bounds how
        // long it can be held back.
        return await withImapPriority('indexer', () => fetchMessageBody(accountId, cfg.imap, folder, uid))
      } catch (e) {
        const msg = String((e as Error)?.message || e)
        if (msg.includes('not found') || msg.includes('Could not load config')) return null
        throw e
      }
    }
    startBodyIndexer({
      fetchBody: fetchBodyForIndexer,
      // Live reads, not values captured at start: both toggles must take
      // effect at runtime without a restart.
      isOffline: () => getSettings().workOffline === true,
      // §2.115 — pause while a header sync is running.
      //
      // This was previously left unwired, on the reasoning that the indexer
      // borrows from the per-account pool while header sync opens dedicated
      // connections (`withDedicatedImapRetry`), so the two cannot deadlock on
      // each other. That reasoning is still correct — it just answers a
      // different question. Pausing is not a deadlock guard, it is a
      // contention guard, and dropping it left the indexer competing for IMAP
      // and main-thread time with the one operation the user is actually
      // waiting on. `isHeaderSyncActive()` is already the gate `syncOfflineBodies`
      // and `runPeriodicSync` use for exactly this; the indexer was the odd
      // one out.
      //
      // Wiring it can only REDUCE what the indexer does — it takes no lock by
      // pausing — so it cannot reintroduce the hazard the old comment named.
      // Starvation is bounded: `activeHeaderSyncs` counts only
      // `runSyncFolderHeaders` calls, each decremented in an outer `finally`,
      // and periodic sync neither increments it nor starts while it is set.
      //
      // Useful side effect: a paused tick is treated as "not now", so it
      // re-arms at the base interval instead of backing off. A sync therefore
      // leaves the indexer at ~2s cadence, and rows it just committed get
      // picked up promptly rather than after the idle curve's ceiling.
      isPaused: () => isHeaderSyncActive(),
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

/**
 * §2.162 — refuse to store a rule whose firing cannot be justified.
 *
 * The whole decision (which fields, which actions) lives in
 * `findEncodedMailRuleRefusal` in packages/core; everything here is the throw.
 * The other save path — the MCP rule tools in services/ai.ts — calls that same
 * core function rather than re-listing fields, so there is one list to keep
 * right and one to get wrong.
 */
function assertMailRuleAllowed(conditionsJson: string, actionsJson: string): void {
  const refusal = findEncodedMailRuleRefusal(conditionsJson, actionsJson)
  // The error is built in core, not here: storage refuses the same rules as a
  // last line (§2.162), and one factory is what keeps the two layers from
  // producing two differently-worded refusals for one case. The code carries
  // the offending field so the renderer can name it in the user's language.
  if (refusal) throw mailRuleRefusalError(refusal)
}

handleIpc('rules:create', async (_e, data: unknown) => {
  const parsed = mailRuleCreateSchema.parse(data)
  assertMailRuleAllowed(parsed.conditions, parsed.actions)
  const result = createMailRule(parsed)
  markFeatureUsed('rules')
  return result
})

handleIpc('rules:update', async (_e, id: unknown, data: unknown) => {
  const rid = mailRuleIdSchema.parse(id)
  const patch = mailRuleUpdateSchema.parse(data)
  // Validate the rule as it will be AFTER the patch, not the patch alone: a
  // patch that only swaps the actions to `trash` leaves the stored `from`
  // condition in place, and checking the submitted half on its own would wave
  // that through. A patch that touches neither half is left alone on purpose —
  // renaming or DISABLING a rule stored before this check existed must stay
  // possible, and neither makes it more dangerous.
  if (patch.conditions !== undefined || patch.actions !== undefined) {
    const existing = getMailRule(rid)
    assertMailRuleAllowed(
      patch.conditions ?? existing?.conditions ?? '[]',
      patch.actions ?? existing?.actions ?? '[]',
    )
  }
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

  // Structural parse, not a cast: this is a dry run over cached mail, and a
  // condition array that is not one (or whose entries lack operands) used to
  // reach `matchRule` and throw. No matches is the honest answer for a rule
  // that cannot be evaluated.
  const parts = parseMailRuleParts(parsed.conditions, '[]')
  if (!parts) return []

  const testRule: MailRule = {
    id: 'test',
    accountId: parsed.accountId ?? null,
    name: 'test',
    enabled: true,
    priority: 0,
    conditions: parts.conditions,
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

  // §2.162 — retroactive application is the most destructive path there is (it
  // sweeps up to 1000 cached messages at once), so it asks the same core
  // verdict the runner and the save paths ask, shape included: a stored row is
  // JSON of unknown quality, and casting it here is what let a structurally
  // broken rule reach `matchRule`. A rule stored before this check existed is
  // refused rather than migrated.
  const refuse = (refusal: MailRuleRefusal) => {
    logRules.warn(`applyToFolder refused for rule ${ruleRow.id}: ${formatMailRuleRefusal(refusal)}`)
    return { applied: 0, refused: refusal }
  }

  const refusal = findEncodedMailRuleRefusal(ruleRow.conditions, ruleRow.actions)
  if (refusal) return refuse(refusal)
  const parts = parseMailRuleParts(ruleRow.conditions, ruleRow.actions)
  // Belt and braces: the call above already refuses everything this rejects.
  if (!parts) return refuse({ reason: 'malformed_rule', field: 'unknown' })

  const rule: MailRule = {
    id: ruleRow.id,
    accountId: ruleRow.accountId,
    name: ruleRow.name,
    enabled: true,
    priority: ruleRow.priority,
    conditions: parts.conditions,
    actions: parts.actions,
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
  broadcastSettingsChanged(getSettings())

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
  broadcastSettingsChanged(getSettings())

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
  const { cfg, accountGeneration } = await requireAccountConfig(accountId)
  assertImapAuth(accountId, cfg.imap, accountGeneration)
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
  // §2.99 (review H3) — queued flag/move/delete ops just landed; recount.
  invalidateUnreadBadge()
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
  // §2.19 iter3 — gate by updateCanSelfUpdate: don't background-download
  // artifacts we KNOW cannot be applied (an advisory verdict, not a proof —
  // see `isDirWritable`). §2.58 — the user keeps the
  // checkbox (it is no longer disabled in Settings → About), so this gate no
  // longer traps a persisted `true`; it only suppresses the pointless
  // download while the warning explains why.
  if (app.isPackaged && !IS_E2E) {
    const wantAutoDownload = next.autoUpdateEnabled === true && updateCanSelfUpdate
    if (autoUpdater.autoDownload !== wantAutoDownload) {
      autoUpdater.autoDownload = wantAutoDownload
      logUpdate.info(`autoDownload toggled at runtime: ${wantAutoDownload}`)
    }
  }

  // §2.99 — tray and autostart follow the settings with no restart. Creating
  // or destroying the icon also rebuilds its menu, which is what picks up a
  // language change. Read from the STORE, not from the payload: the payload is
  // whatever one window chose to send, the store is what was persisted.
  const persisted = getSettings()
  applyTrayEnabled(persisted.trayEnabled !== false)
  // §2.99 (review H4 / round-2 HIGH-2) — edge-triggering and the retry rule
  // both belong to the service, which is the only place that learns whether the
  // registration actually happened. main just reports the desired state.
  syncLaunchAtLogin(persisted.launchAtLogin === true)

  // §2.103 — spellchecker follows the settings with no restart, from the STORE
  // for the same reason as the two above: the payload is whatever one window
  // chose to send, the store is what was persisted (and what the consent gate
  // just filtered). The service re-applies to every live window's session.
  reapplySpellcheck()

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
    assertImapAuth(aid, cfg.imap, result.accountGeneration)
  } catch (err) {
    logPeriodic.warn(`Cannot get config for account #${aid}, skipping:`, err)
    return
  }

  logPeriodic.info(`Periodic sync for account #${aid}: ${foldersToSync.length} folders`)

  // Sequential sync within account (avoid IMAP connection storms)
  for (const folder of foldersToSync) {
    if (getSettings().workOffline) break
    if (isTimedOut()) break // per-account budget exhausted — stop starting new folders
    // Rows this folder actually committed this pass. The periodic loop has no
    // `fetched` counter of its own (unlike `runSyncFolderHeaders`), so we count
    // in the batch callback — the single place where rows reach the cache.
    let committedRows = 0
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
          // Counted AFTER the commit returns: applyFolderSyncBatch is the
          // transaction boundary, so a throw here means these rows are not in
          // the cache and must not be reported as new indexer work.
          committedRows += batch.length
        },
        {
          batchSize: 500,
          knownModseq: priorCrawl?.highestModseq ?? undefined,
          knownUidValidity: priorSync?.uidValidity ?? undefined,
        },
      )
      // §2.165: `fetchAllFolderHeaders` reported this outcome at the
      // connection boundary already — including the case where it threw, which
      // this loop only logs.
      // Update sync state with latest modseq/uidValidity.
      //
      // `headersIncomplete` bars this block for the same reason it bars the
      // interactive path: it pins 'covered_full' with a watermark taken from
      // the highest UID that LANDED, and the UID that failed to land is below
      // it — the next incremental sync would filter it out permanently.
      // Leaving modseq unwritten too is deliberate: persisting it would let
      // the next CONDSTORE pass skip the folder outright.
      if (!result.skipped && !result.headersIncomplete) {
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
      // §2.165: the failure verdict is not reported from here. The IMAP
      // operation that failed reported it at the connection boundary, which
      // sees the same failure plus every other one this loop never runs — and
      // reports them for accounts whose folders this loop skips entirely.
    } finally {
      // §2.86 iter2, review finding 1: this loop is a SEPARATE sync path from
      // the `net:syncFolderHeaders` handler, it runs with no user present, and
      // it commits batches through the callback above. Without this call a user
      // who never opens a folder in the UI got no static rules at all.
      // In `finally` because a `fetchAllFolderHeaders` that throws may already
      // have committed batches. The pass is idempotent and costs one indexed
      // query when there is nothing to do.
      processMailRules(aid, folder).catch(err =>
        logRules.error('Background processMailRules (periodic sync) failed:', err)
      )
      // §2.99 — the path that runs with no user present: this is where mail
      // that arrived while the app sat in the tray becomes a notification.
      noteFolderSynced(aid, folder)
      // §2.115 — same backoff hint as the `net:syncFolderHeaders` path, for
      // the same reason: this loop commits rows with no body_text while no
      // user is present, and it is the path by which mail that arrived
      // overnight reaches the cache.
      //
      // Guarded by rows actually committed, not by "the pass visited this
      // folder": a periodic pass walks every full/period folder on a fixed
      // timer, so resetting per visit would peg the indexer near the periodic
      // interval forever and undo §2.115. A folder with no changes produces no
      // batches (CONDSTORE skip), so it does not reset anything.
      //
      // The counter can overstate — a CONDSTORE batch may carry only flag
      // changes on rows that already have bodies. That asymmetry is deliberate:
      // a false reset costs a few sub-millisecond ticks while the ramp
      // re-climbs, a missed one costs minutes of unsearchable mail.
      //
      // In `finally` with the rule trigger: a fetch that threw may already have
      // committed batches, and `committedRows` reflects them.
      if (committedRows > 0) {
        try { resetBodyIndexerBackoff() } catch { /* never break sync */ }
      }
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
  // §2.17 Phase 1 — timer-driven catch-up: `sync` is the tier for everything
  // below. Tagging the TRIGGER rather than the helper is the point — the tier
  // is a property of why the work runs, and only this frame knows that.
  //
  // Honest accounting of what the scope reaches TODAY, because the wrapper
  // looks more effective than it is:
  //   - `fetchAllFolderHeaders` (the bulk of the pass) runs on a DEDICATED
  //     connection, which takes neither op lock nor pool slot — the tier is
  //     inert there, by construction, not by oversight.
  //   - `replayOfflineOps` does take the real locks, but sets `sync` itself at
  //     its own boundary (services/offlineReplay.ts) and does not rely on this.
  //   - the detached `processMailRules` below pins itself to `background`.
  // So the scope currently decides nothing. It is kept, not deleted, for the
  // direction of the failure it prevents: this is a multi-call pass that grows,
  // and a pooled call added inside it without a scope would enter as `other` —
  // rank 1, just behind `interactive` — which is exactly the wrong default for
  // work a timer started. Deleting the scope makes that mistake silent; keeping
  // it makes the correct tier the one you get for free.
  return imapSync(() => runOneAccountPeriodicSyncPass(aid))
}

async function runOneAccountPeriodicSyncPass(aid: number): Promise<void> {
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
  // §2.99 — the tray is NOT touched here any more. Stopping unread refreshes
  // (the L1 gate: a sync pass still draining must not re-arm the debounce
  // mid-shutdown) and releasing the icon are now two separate acts owned by the
  // draining `before-quit` handler above — `disarmTray()` as its first
  // statement, `shutdownTray()` as its last. Doing either from here would put
  // the outcome at the mercy of listener order.
})
