export * from './types'
export {
  testImapConnection,
  connectImap,
  forceDisconnectImap,
  listMailboxes,
  fetchInboxSummaries,
  fetchFolderSummariesPage,
  fetchAllFolderHeaders,
  syncFolderFlagsOnly,
  getMailboxMessageCount,
  getMailboxStatus,
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
  disconnectPerAccount,
  isIdleActive,
  imapSearchFolder,
  fetchSummariesByUids,
  senderFromEnvelope,
} from './imap'
// §2.17 Phase 1 — the tier tag that decides who enters an IMAP lock first.
// Entry points (IPC handlers, indexer callback, periodic timers) wrap their
// work in `withImapPriority`; every net call underneath inherits it.
export { withImapPriority, currentImapPriority } from './imapScheduler'
export type { ImapPoolRequester } from './imapScheduler'
export { testSmtpConnection, sendMail, buildRawMessage, classifySmtpError, SMTP_RETRY_DELAYS_MS } from './smtp'
export {
  listAccounts,
  getAccountMeta,
  getAccountConfig,
  getOauthRefreshToken,
  getOauthRefreshTokenWithSource,
  setOauthRefreshToken,
  deleteLegacyGoogleRefreshToken,
  lookupOauthRefreshToken,
  lookupOauthRefreshTokenWithSource,
  oauthRefreshSecretKey,
  legacyGoogleRefreshSecretKey,
  saveAccount,
  deleteAccount,
  listMcpConnections,
  getMcpConnection,
  saveMcpConnection,
  deleteMcpConnection,
  accountSchema,
  accountSaveSchema,
  imapSchema,
  smtpSchema,
  folderRolesSchema,
  mcpConnectionSchema,
  mcpConnectionObjectSchema,
  mcpSaveConnectionSchema,
  mcpSaveConnectionObjectSchema,
  settingsSchema,
  rendererWritableSettingsSchema,
  MAIN_ONLY_SETTINGS_FIELDS,
  BODY_RETENTION_DAYS_VALUES,
  DEFAULT_BODY_RETENTION_DAYS,
  DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST,
  isAllowedMcpStdioCommand,
  FORBIDDEN_MCP_STDIO_ENV_KEYS,
  isForbiddenMcpStdioEnvKey,
  findForbiddenMcpStdioEnvKeys,
  sanitizeMcpConnectionsEnv,
  setMcpEnvSanitizationListener,
  getSettings,
  saveSettings,
} from './config'
export type { RendererWritableSettings, MainOnlySettingsField, SanitizeMcpConnectionsEnvResult, McpEnvSanitizationListener } from './config'
export { fetchMessageDetails, fetchMessageBody, fetchMessageBodyViaMain, downloadMessagePart, downloadRawMessage, downloadRawMessagePerAccount } from './message'
export {
  parseEmlBuffer,
  parseEmlBufferInline,
  parseEmlHeaderFacts,
  extractEmlAttachment,
  // §2.145 wave 2.1 — acquisition boundaries report through the same counter.
  recordHardParseCapTrip,
  EML_ATTACHMENT_PART_PREFIX,
  // §2.145 — two-tier parse caps.
  MAX_EML_PARSE_BYTES,
  EML_BODY_SOFT_CAP_BYTES,
  EML_BODY_FULL_CAP_BYTES,
} from './eml'
export { EML_WORKER_MIN_BYTES } from './emlWorkerClient'
export { saveEml, readEml, readEmlBounded, emlExists, deleteEml, deleteEmls, deleteAccountEmls, emlCacheSizeBytes } from './mailStore'
export type { ReadEmlResult } from './mailStore'
export { autoconfig } from './autoconfig'
export { normalizeFingerprintSha256, buildTlsOptions } from './tls'
export { tryAutoUnsubscribe, tryRfc8058Post, tryHttpGetUnsubscribe, pickHttpsUrl, extractUnsubLinksFromHtml } from './unsubscribe'
export type { HttpUnsubscribeResult } from './unsubscribe'
