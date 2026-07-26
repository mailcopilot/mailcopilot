export { substituteVars } from './templateVars'

export { buildThreadRows, type ThreadRow } from './threading'

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
  normalizeExternalUrl,
  buildRoutedMailLink,
  isRoutedMailLink,
} from './mailLinks'

export {
  matchCondition,
  matchRule,
  evaluateRules,
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

export {
  isKeychainUnavailableError,
  KEYCHAIN_UNAVAILABLE_RE,
  DBUS_SESSION_UNAVAILABLE_RE,
} from './keychainErrors'

export {
  collapseQuotedText,
  type CollapseOptions,
} from './quotedText'
