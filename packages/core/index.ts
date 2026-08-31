export { substituteVars } from './templateVars'

export {
  buildThreadRows,
  countSelectedRows,
  firstSelectedRow,
  leadKeyOfRowContaining,
  pickThreadOpenTarget,
  rowContaining,
  rowIsSelected,
  rowLeadKeyFor,
  singleMessageRow,
  toggleRowSelection,
  type RowSelectionToggle,
  type ThreadRow,
} from './threading'

export { resolveThreadItems, expandBulkToThreads } from './threadActions'

export { normalizeMailrefs } from './normalizeMailrefs'

export {
  sha256hex,
  getGravatarUrl,
  precomputeGravatarHash,
  markGravatarNotFound,
  clearGravatarCache,
} from './gravatar'

export {
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
  defaultCustomScheduleValue,
  nextHalfHour,
  tomorrowMorning,
  mondayMorning,
} from './schedule'

export {
  parseSearchQuery,
  isAdvancedSearch,
  type ParsedSearchQuery,
} from './searchParser'

export {
  addrToString,
  addrListToString,
  addrTooltip,
  addrDisplayName,
  extractEmails,
  uniqEmails,
  prefixSubject,
  quoteText,
  normalizeCid,
  replaceCidImages,
  formatBytes,
  formatSmartDate,
  getInitials,
  getAvatarColor,
  AVATAR_COLORS,
  getPaletteColor,
  sortFolders,
  getFolderRole,
  folderLabel,
} from './mail'

export {
  extractImageSrcCids,
  selectCidPartsToInline,
  selectPartsToHide,
  MAX_INLINE_CID_PARTS,
} from './cidRefs'
export type { InlineCidCandidate, ResolvedCidPart } from './cidRefs'

export {
  normalizeExternalUrl,
  buildRoutedMailLink,
  isRoutedMailLink,
} from './mailLinks'

export {
  matchCondition,
  matchRule,
  evaluateRules,
  findMailRuleRefusal,
  findEncodedMailRuleRefusal,
  parseMailRuleParts,
  RULE_OPS,
  RULE_ACTION_TYPES,
  formatMailRuleRefusal,
  parseMailRuleRefusal,
  mailRuleRefusalError,
  MAIL_RULE_REFUSED_ERROR,
  type MailRuleRefusal,
  type MailRuleRefusalReason,
  type RuleField,
  type RuleOp,
  type RuleCondition,
  type RuleActionType,
  type RuleAction,
  type MailRule,
  type MailContext,
} from './mailRules'

export {
  DATA_BOUNDARY_START,
  DATA_BOUNDARY_END,
  neutralizeBoundaryMarkers,
  wrapUntrusted,
} from './untrustedBoundary';

export {
  AI_RULE_DATA_BOUNDARY_START,
  AI_RULE_DATA_BOUNDARY_END,
  AI_RULE_QUEUE_MAX,
  AI_RULE_BATCH_SIZE,
  AI_RULE_MAX_CALLS_PER_HOUR,
  AI_RULE_MAX_ENABLED_PER_ACCOUNT,
  AI_RULE_ENABLED_LIMIT_ERROR,
  AI_RULE_NULL_USAGE_COST_FLOOR,
  AI_RULE_REVERSIBLE_ACTIONS,
  AI_RULE_DESTRUCTIVE_ACTIONS,
  isDestructiveAiRuleAction,
  isReversibleAiRuleAction,
  groupBatchByAccount,
  rulesForAccount,
  canEnableAiRule,
  wrapUntrustedAiRule,
  buildAiRulePrompt,
  parseAiRuleResponse,
  validateDecisionFolder,
  dedupeAiRuleActions,
  estimateAiRuleCostUsd,
  nullUsageReservationUsd,
  type AiRulePendingItem,
  type AiRuleSpec,
  type AiRuleDecision,
  type AiRuleParseResult,
  type AiRuleParseFailure,
  type ResolvedAiRuleAction,
  type AiRuleUsage,
  type AiRuleEnabledScope,
} from './aiRules'

export {
  checkMisdirection,
  extractDomain,
  type Recipient,
  type MisdirectionWarning,
} from './misdirection'

export {
  isTransientNetworkError,
  isLinuxInstallerError,
} from './transientErrors'

// §2.127 — user-facing error presentation. Only the RENDERER half of
// errorPresentation.ts is re-exported here: the renderer decodes the tag the
// main-process funnel embedded and picks a sentence from a closed vocabulary.
// The encoder side (`presentedIpcMessage`, `describeErrorForLog`) is
// main-process-only and stays on the deep path `@mailcopilot/core/errorPresentation`,
// so a renderer file cannot reach for it by autocomplete.
export {
  ERROR_PRESENTATION_KEYS,
  ERROR_PRESENTATION_I18N_KEYS,
  isErrorPresentationKey,
  classifyErrorPresentation,
  decodeErrorPresentation,
  stripErrorPresentation,
  type ErrorPresentationKey,
} from './errorPresentation'

export {
  isKeychainUnavailableError,
  KEYCHAIN_UNAVAILABLE_RE,
  DBUS_SESSION_UNAVAILABLE_RE,
} from './keychainErrors'

export {
  collapseQuotedText,
  type CollapseOptions,
} from './quotedText'

export {
  analyzeTableReferences,
  type SqlTableReferences,
  type SqlGuardRefusalReason,
} from './sqlGuard'

export {
  scrubUserPathsShape,
  scrubEmailAddressesShape,
  scrubEventPiiWith,
  scrubLogPiiWith,
  type ScrubbableEvent,
  type ScrubbableLog,
} from './piiScrub'

export {
  splitComposeBody,
  joinComposeBody,
  type ComposeBodySplit,
} from './composeBody'

// §3.3.B4.f5 — segmentation of an AI rewrite for the Compose review panel.
// Pure and DOM-free on purpose: the same functions back the per-edit corrector
// (B7), which has no panel of its own.
export {
  diffComposeText,
  segmentComposeEdit,
  applyComposeDiff,
  changedBlockIds,
  summarizeEqualBlock,
  COMPOSE_DIFF_COLLAPSE_MIN_CHARS,
  COMPOSE_DIFF_COLLAPSE_MIN_LINES,
  type ComposeDiffBlock,
  type ComposeDiffBlockKind,
  type ComposeDiffOp,
  type ComposeDiffResult,
  type ComposeDiffSegment,
  type ComposeDiffEqualSummary,
  // §3.3 B7 — span-addressed edits. Identity is a span in the draft, never a
  // position in a list (§2.251), so a per-edit acceptance survives a
  // regeneration of the preview it was made in.
  composeEditId,
  resolveComposeEdits,
  applyComposeEdits,
  COMPOSE_EDIT_MAX_SPAN_CHARS,
  type ComposeEditSpan,
  type ComposeEditProposal,
  type ResolvedComposeEdit,
} from './composeDiff'

// §2.99 — one badge-inclusion policy for the in-app badge and the OS badge.
export {
  isFolderCountedInBadges,
  sumBadgeUnread,
  type FolderBadgePref,
  type BadgeUnreadRow,
  type BadgeFolderContext,
} from './unreadBadgePolicy'
