import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Save, Loader2, X, Settings as SettingsIcon, Gauge, Folder, FileText, LayoutTemplate, Download, Users, Plus, Trash2, Pencil, CheckCircle, Sparkles, Shield, Info, ExternalLink, MessageSquare, Send, Palette, Type, Image, Globe, Filter, UserCircle } from 'lucide-react'
import {
  AI_RULE_MAX_ENABLED_PER_ACCOUNT,
  ERROR_PRESENTATION_I18N_KEYS,
  decodeErrorPresentation,
  stripErrorPresentation,
} from '@mailcopilot/core'
import { useTranslation } from 'react-i18next'
import i18n, { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type Language } from '../i18n'
import { sendFeedback, captureException } from '../sentry'
import type { AccountMeta, FolderPreference, FolderRoles, Identity, Mailbox } from '../../packages/net/types'
import { formatBytes, getFolderRole, getInitials, AVATAR_COLORS } from '../utils/mail'
import AccountAvatar from '../components/AccountAvatar'
import Select from '../components/Select'
import IdentitiesTab, { type IdentityDraft } from '../components/IdentitiesTab'
import SystemInfo from '../components/Settings/SystemInfo'
import AiPrivacyPanel from '../components/Settings/AiPrivacyPanel'
import AiDestinationRejectionNotice from '../components/Settings/AiDestinationRejectionNotice'
import { useAiDestinationRejection } from '../hooks/useAiDestinationRejection'
import { buildAccountSavePayloadPatch, buildAvatarSavePayloadPatch } from '../utils/accountSavePayload'
import WindowTitlebar from '../components/WindowTitlebar'
import { useTelemetryConsentNeeded } from '../hooks/useTelemetryConsent'
import { AVATAR_ICONS, getAvatarIcon } from '../utils/avatarIcons'
import { parseShellArgs } from '../utils/parseShellArgs'
import { singleFlightInvoke } from '../utils/ipcSingleFlight'
import {
  deleteAiApiKeyForProvider,
  isAiKeyFieldMasked,
  type ApiKeyProviderId,
} from '../utils/aiApiKey'
import type { SortMode } from '../hooks/useMailListView'

type AiProviderId = 'subscription' | 'anthropic-api' | 'openai-api' | 'gemini-api'
type VisibleAiProviderId = 'subscription' | 'anthropic-api' | 'openai-api' | 'gemini-api'

function isVisibleAiProvider(value: unknown): value is VisibleAiProviderId {
  return value === 'subscription' || value === 'anthropic-api' || value === 'openai-api' || value === 'gemini-api'
}

/**
 * §2.122 — "Check connection" used to print the raw machine verdict
 * (`invalid_key`) into the UI, and the two new verdicts (`no_key`,
 * `store_unavailable`) would have leaked the same way. Known verdicts get the
 * same sentence the assistant panel shows; anything unknown still falls back to
 * the adapter's own message.
 */
const AI_AUTH_STATUS_MESSAGE_KEYS: Record<string, string> = {
  not_configured: 'ai.errors.notConfigured',
  no_key: 'ai.errors.noKey',
  store_unavailable: 'ai.errors.storeUnavailable',
  invalid_key: 'ai.errors.invalidKey',
  no_subscription: 'ai.errors.noSubscription',
}

/** Badge in the TLS pin list telling a full trust anchor apart from a
 *  fingerprint-only pin. Inline (no new CSS) and theme-variable driven so it
 *  follows dark mode like the rest of the section. */
const TLS_PIN_BADGE_STYLE = {
  display: 'inline-block',
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 4,
  padding: '2px 7px',
  whiteSpace: 'nowrap',
  border: '1px solid',
} as const
const TLS_PIN_ANCHOR_BADGE_STYLE = {
  ...TLS_PIN_BADGE_STYLE,
  color: 'var(--muted)',
  borderColor: 'var(--mailcopilot-border)',
} as const
const TLS_PIN_FINGERPRINT_ONLY_BADGE_STYLE = {
  ...TLS_PIN_BADGE_STYLE,
  background: 'var(--warn-bg)',
  color: 'var(--warn-fg)',
  borderColor: 'var(--warn-border)',
} as const

type SettingsData = {
  theme: 'light' | 'dark'
  /** §2.15-ter — deprecated, kept on the type only for older settings:save replies. Not used by the UI anymore. */
  cacheDays?: number
  bodyRetentionDays?: number
  language?: Language
  notificationsEnabled?: boolean
  imapIdleEnabled?: boolean
  syncIntervalMinutes?: number
  periodicSyncIntervalMin?: number
  draftSyncEnabled?: boolean
  hiddenUnreadFolders?: string[]
  darkModeEmails?: boolean
  alwaysLoadImages?: boolean
  gravatarInMail?: boolean
  groupConversations?: boolean
  sortMode?: SortMode
  autoAdvance?: 'off' | 'newer' | 'older' | 'back_to_list'
  conversationOrder?: 'newest-top' | 'oldest-top'
  hotkeysPreset?: 'gmail' | 'outlook'
  sendDelaySeconds?: number
  offlineMaxSizeKB?: number
  aiProvider?: AiProviderId
  /**
   * §2.122 — main-process record of "we wrote a key for this provider". Read
   * only: it is absent from `rendererWritableSettingsSchema`, and it is used
   * here for presentation (whether the key field starts masked) — never as a
   * substitute for reading the store, and never to block or trigger anything.
   */
  aiApiKeySaved?: Partial<Record<ApiKeyProviderId, boolean>>
  aiModel?: string
  aiPrivacyConsent?: boolean
  aiSendOnEnter?: boolean
  aiOpenAiBaseUrl?: string
  aiProxyUrl?: string
  aiLocale?: 'auto' | 'ru' | 'en'
  aiShowSources?: boolean
  aiDailyBudgetUsd?: number
  aiMonthlyBudgetUsd?: number
  aiMaxTurns?: number
  aiMaxBudgetPerRequest?: number
  aiEgressPolicy?: 'default-deny' | 'ask' | 'allow'
  /**
   * §3.3 B2 Thread AI Summary — per-account opt-in, keyed by stringified
   * accountId. Default OFF (missing/false). Renderer-writable via settings:save.
   */
  aiThreadSummaryEnabled?: Record<string, boolean>
  /**
   * §3.3 B4 Instant Reply — per-account opt-in, keyed by stringified accountId.
   * Default OFF (missing/false). Renderer-writable via settings:save.
   */
  aiInstantReplyEnabled?: Record<string, boolean>
  debugLogging?: boolean
  sentryEnabled?: boolean
  /** §2.19 — opt-in auto-download for updates. Default false. */
  autoUpdateEnabled?: boolean
  mcpExportEnabled?: boolean
  mcpExportPort?: number
  mcpExportWhitelist?: string[]
  mcpEnableStdio?: boolean
  mcpConnections?: McpConnectionConfig[]
  trustedDomains?: string
  defaultMailApp?: boolean
}

type McpConnectionConfig = {
  id: string
  name: string
  transport: 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
  autoConnect: boolean
  /**
   * §3.10 P0 approval marker — main-only writable. Renderer reads it to show
   * the "Needs approval" badge and hide the Connect button for unapproved
   * stdio connections; it MUST NOT attempt to seed this field on save (the
   * main-side IPC schema drops any incoming approvedSource anyway).
   */
  approvedSource?: 'env' | 'native-confirm' | null
}
type MailboxesAndRoles = { mailboxes: Mailbox[]; detected: FolderRoles; roles: FolderRoles; prefs?: Record<string, FolderPreference> }
type Tab = 'accounts' | 'general' | 'productivity' | 'folders' | 'identities' | 'signature' | 'templates' | 'rules' | 'ai' | 'about'

const ROLE_LABELS: { key: keyof FolderRoles; labelKey: string }[] = [
  { key: 'archive', labelKey: 'folders.archive' },
  { key: 'trash', labelKey: 'folders.trash' },
  { key: 'sent', labelKey: 'folders.sent' },
  { key: 'drafts', labelKey: 'folders.drafts' },
  { key: 'junk', labelKey: 'folders.junk' },
]

const DEFAULT_ROLE_PATH: Record<keyof FolderRoles, string> = {
  archive: 'Archive',
  trash: 'Trash',
  sent: 'Sent',
  drafts: 'Drafts',
  junk: 'Junk',
}

const TABS: { id: Tab; icon: typeof SettingsIcon; labelKey: string }[] = [
  { id: 'accounts', icon: Users, labelKey: 'settings.tabs.accounts' },
  { id: 'general', icon: SettingsIcon, labelKey: 'settings.tabs.general' },
  { id: 'productivity', icon: Gauge, labelKey: 'settings.tabs.productivity' },
  { id: 'folders', icon: Folder, labelKey: 'settings.tabs.folders' },
  { id: 'identities', icon: UserCircle, labelKey: 'settings.identities.tabLabel' },
  { id: 'signature', icon: FileText, labelKey: 'settings.tabs.signature' },
  { id: 'templates', icon: LayoutTemplate, labelKey: 'settings.tabs.templates' },
  { id: 'rules', icon: Filter, labelKey: 'settings.tabs.rules' },
  { id: 'ai', icon: Sparkles, labelKey: 'ai.settings.tab' },
  { id: 'about', icon: Info, labelKey: 'settings.tabs.about' },
]

function defaultFolderPref(role: string | null): Pick<FolderPreference, 'visible' | 'includeInBadges' | 'headerSyncMode' | 'headerSyncDays' | 'offlineMode' | 'offlineDays'> {
  if (role === '\\Inbox') {
    return {
      visible: true,
      includeInBadges: true,
      headerSyncMode: 'full',
      offlineMode: 'period',
      offlineDays: 30,
    }
  }
  if (role === '\\Sent' || role === '\\Drafts' || role === '\\Trash' || role === '\\Junk' || role === '\\Archive') {
    return {
      visible: true,
      includeInBadges: false,
      headerSyncMode: 'on_open',
      offlineMode: 'off',
    }
  }
  return {
    visible: false,
    includeInBadges: false,
    headerSyncMode: 'off',
    headerSyncDays: 30,
    offlineMode: 'off',
    offlineDays: 30,
  }
}

export default function Settings() {
  const { t } = useTranslation()
  // `t` gets a new identity on every language change. Callbacks that only need
  // it inside a catch block read it through this ref so switching the UI
  // language does not invalidate them — `refreshFolders` in particular sits in
  // an effect dependency list and would re-hit IMAP for the folder list.
  const tRef = useRef(t)
  tRef.current = t
  const [tab, setTab] = useState<Tab>('general')
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [language, setLanguage] = useState<Language>(DEFAULT_LANGUAGE)
  // §2.15-ter: global retention for downloaded message bodies (.eml files).
  // Allowed values: 30/90/180/365 days, or -1 = forever. Default 365 (1y).
  // Per-folder retention (offlineMode='period' + offlineDays) takes
  // priority for folders that opt into period sync; this slider only
  // governs folders configured for offlineMode='full'.
  const [bodyRetentionDays, setBodyRetentionDays] = useState<number>(365)
  // Snapshot of body retention at load time so we can detect a SHRINK at
  // save and pop a confirmation dialog with the impact. Increases (or
  // switching to "forever") never delete data, so they save without prompt.
  const prevBodyRetentionRef = useRef<number | null>(null)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [imapIdleEnabled, setImapIdleEnabled] = useState(true)
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(1)
  const [periodicSyncIntervalMin, setPeriodicSyncIntervalMin] = useState(5)
  const [draftSyncEnabled, setDraftSyncEnabled] = useState(true)
  const [defaultMailApp, setDefaultMailApp] = useState(false)
  const [darkModeEmails, setDarkModeEmails] = useState(true)
  const [alwaysLoadImages, setAlwaysLoadImages] = useState(false)
  const [gravatarInMail, setGravatarInMail] = useState(true)
  const [groupConversations, setGroupConversations] = useState(true)
  const [sortMode, setSortMode] = useState<SortMode>('date')
  const [autoAdvance, setAutoAdvance] = useState<'off' | 'newer' | 'older' | 'back_to_list'>('older')
  const [conversationOrder, setConversationOrder] = useState<'newest-top' | 'oldest-top'>('newest-top')
  const [hotkeysPreset, setHotkeysPreset] = useState<'gmail' | 'outlook'>('gmail')
  const [sendDelaySeconds, setSendDelaySeconds] = useState(0)
  const [accounts, setAccounts] = useState<AccountMeta[]>([])
  const [accountId, setAccountId] = useState<number | null>(null)
  const [avatarEditId, setAvatarEditId] = useState<number | null>(null)
  const [gravatarFailed, setGravatarFailed] = useState<Set<number>>(new Set())
  const [folderRoles, setFolderRoles] = useState<FolderRoles>({})
  const [autoRoles, setAutoRoles] = useState<FolderRoles>({})
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [folderPrefs, setFolderPrefs] = useState<Record<string, FolderPreference>>({})
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [foldersError, setFoldersError] = useState('')
  const [creatingRole, setCreatingRole] = useState<keyof FolderRoles | null>(null)
  const [createFolderDialog, setCreateFolderDialog] = useState<{ role: keyof FolderRoles; name: string } | null>(null)
  const [signature, setSignature] = useState('')
  // 2.3-B: per-account identities editing state. `identitiesDirty` drives
  // whether save() posts the current list to `accounts:save`; when false we
  // leave the account untouched so avatar/folderRoles saves don't
  // accidentally rewrite a pristine identities[] with a narrow view of it.
  const [identities, setIdentities] = useState<Identity[]>([])
  const [identitiesDirty, setIdentitiesDirty] = useState(false)
  const [identitiesSaveError, setIdentitiesSaveError] = useState('')
  const [hiddenUnreadFolders, setHiddenUnreadFolders] = useState<string[]>([])

  // Offline mode (per-folder settings are in folder_prefs; only global maxSizeKB remains here)
  const [offlineMaxSizeKB, setOfflineMaxSizeKB] = useState(0)
  const [offlineSyncing, setOfflineSyncing] = useState(false)
  const [offlineSyncStatus, setOfflineSyncStatus] = useState('')

  // AI
  const [aiProvider, setAiProvider] = useState<AiProviderId | ''>('')
  // Provider loaded from DB — for determining locked state
  const [savedAiProvider, setSavedAiProvider] = useState<AiProviderId | ''>('')
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiModel, setAiModel] = useState('claude-sonnet-4-5-20250929')
  const [aiSendOnEnter, setAiSendOnEnter] = useState(true)
  const [aiOpenAiBaseUrl, setAiOpenAiBaseUrl] = useState('')
  const [aiProxyUrl, setAiProxyUrl] = useState('')
  const [aiLocale, setAiLocale] = useState<'auto' | 'ru' | 'en'>('auto')
  const [aiShowSources, setAiShowSources] = useState(true)
  const [aiDailyBudgetUsd, setAiDailyBudgetUsd] = useState(5)
  const [aiMonthlyBudgetUsd, setAiMonthlyBudgetUsd] = useState(100)
  const [aiMaxTurns, setAiMaxTurns] = useState(30)
  const [aiMaxBudgetPerRequest, setAiMaxBudgetPerRequest] = useState(2)
  // §3.10 P1: outbound egress policy. Default 'default-deny' matches
  // `aiEgressPolicy.ts::defaultEgressPolicy()` and the zod schema in
  // `packages/net/config.ts`.
  const [aiEgressPolicy, setAiEgressPolicy] = useState<'default-deny' | 'ask' | 'allow'>('default-deny')
  // §3.3 B2 Thread AI Summary — per-account opt-in, keyed by stringified
  // accountId. Default OFF. The toggle in the AI tab reads/writes the entry
  // for the currently selected `accountId`; the whole Record is persisted via
  // settings:save (the main-side generate handler refuses with 'opt_out' when
  // an account's entry is not `true`).
  const [aiThreadSummaryEnabled, setAiThreadSummaryEnabled] = useState<Record<string, boolean>>({})
  // §3.3 B4 Instant Reply — per-account opt-in, same shape/semantics as the
  // Thread Summary opt-in above; the main-side generate handler refuses when an
  // account's entry is not `true`.
  const [aiInstantReplyEnabled, setAiInstantReplyEnabled] = useState<Record<string, boolean>>({})
  const [sentryEnabled, setSentryEnabled] = useState(true)
  // §2.82 — while no consent record exists, main clamps `sentryEnabled` to
  // false on save (applyAboutToggle), so an enabled switch here would silently
  // bounce back. Render the reason instead of a dead control.
  const telemetryConsentNeeded = useTelemetryConsentNeeded()
  const [debugLogging, setDebugLogging] = useState(false)
  // §2.19 — auto-update opt-in. Default false (the schema default) so users
  // see every download surface in the UI before installing. Persisted via
  // settings:save alongside the other About checkboxes.
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false)
  const [showFeedbackForm, setShowFeedbackForm] = useState(false)
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackEmail, setFeedbackEmail] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [aiConnectionStatus, setAiConnectionStatus] = useState<'' | 'checking' | 'ok' | 'error'>('')
  const [aiConnectionError, setAiConnectionError] = useState('')
  const [aiKeyMasked, setAiKeyMasked] = useState(false)
  const [aiMemory, setAiMemory] = useState('')
  const [aiMemoryDirty, setAiMemoryDirty] = useState(false)
  // §2.119 — a `settings:save` whose AI-destination change main refused comes
  // back `{ ok: true }` with the refusal attached. The window must not close on
  // one: closing is this window's only "saved" signal.
  const { aiDestinationRejection, recordSettingsSaveResult } = useAiDestinationRejection()

  // MCP Export
  const [mcpExportEnabled, setMcpExportEnabled] = useState(false)
  const [mcpExportPort, setMcpExportPort] = useState(23847)
  const [mcpExportWhitelist, setMcpExportWhitelist] = useState<string[]>([])
  const [mcpExportStatus, setMcpExportStatus] = useState<'running' | 'stopped' | 'error'>('stopped')
  const [mcpExportToken, setMcpExportToken] = useState('')

  // MCP Client Connections
  const [mcpEnableStdio, setMcpEnableStdio] = useState(false)
  const [mcpConnections, setMcpConnections] = useState<McpConnectionConfig[]>([])
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, { status: string; error?: string; toolCount: number }>>({})
  const [mcpAddingNew, setMcpAddingNew] = useState(false)
  const [mcpEditId, setMcpEditId] = useState<string | null>(null)
  const [mcpForm, setMcpForm] = useState({ name: '', transport: 'sse' as 'sse' | 'stdio', url: '', command: '', args: '', env: '', autoConnect: true })
  const [mcpTesting, setMcpTesting] = useState(false)
  // mcpTestResult carries an explicit success flag so the UI banner does
  // not have to infer success from string parsing. Prior to the wave-3
  // fix the banner decided success vs error by `msg.startsWith('OK')`,
  // which broke under i18n (localized "OK" prefixes won't match) and
  // also misclassified any error message that happened to begin with
  // the literal string "OK".
  const [mcpTestResult, setMcpTestResult] = useState<{ message: string; success: boolean } | null>(null)

  // Tracking unsaved changes — initialSnapshot is captured from settingsSnapshot once after load
  const settingsLoadedRef = useRef(false)
  const [initialSnapshot, setInitialSnapshot] = useState('')
  const savedRef = useRef(false)

  // Templates
  type TemplateItem = { id: number; name: string; subject: string; body: string; shortcut: string | null }
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [editingTemplate, setEditingTemplate] = useState<TemplateItem | null>(null)
  const [templateForm, setTemplateForm] = useState({ name: '', subject: '', body: '', shortcut: '' })

  // Mail rules
  type MailRuleUI = {
    id: string
    accountId: string | null
    name: string
    enabled: boolean
    priority: number
    conditions: Array<{ field: string; op: string; value: string }>
    actions: Array<{ type: string; folder?: string }>
    stopProcessing: boolean
  }
  const [mailRules, setMailRules] = useState<MailRuleUI[]>([])
  const [editingRule, setEditingRule] = useState<MailRuleUI | null>(null)
  const [testResults, setTestResults] = useState<Array<{ uid: number; subject: string; from: string }> | null>(null)
  const [applyToExisting, setApplyToExisting] = useState(false)

  // AI Rules
  type AiRuleUI = {
    id: string
    accountId: string | null
    name: string
    enabled: boolean
    prompt: string
    allowedActions: string[]
    budgetPerDayUsd: number
  }
  const [aiRules, setAiRules] = useState<AiRuleUI[]>([])
  const [editingAiRule, setEditingAiRule] = useState<AiRuleUI | null>(null)
  const [aiRuleLog, setAiRuleLog] = useState<Array<{ id: number; actionTaken: string; reasoning: string | null; createdAt: string; uid: number; folder: string }>>([])
  // §2.39 — surfaced when enabling/creating a rule would exceed the per-account
  // enabled-rule cap (the storage layer throws an AI_RULE_ENABLED_LIMIT error).
  const [aiRuleError, setAiRuleError] = useState<string | null>(null)

  // Trusted domains
  const [trustedDomains, setTrustedDomains] = useState('')

  // TLS pins
  /** `hasCertPem` mirrors the projection main applies in `toPinDto`: true when
   *  the pin stores the certificate body and can therefore act as a trust
   *  anchor. Manually added pins only carry the fingerprint. */
  type TlsPin = {
    id: number; accountId: number; host: string; port: number
    fingerprintSha256: string; createdAt: string; hasCertPem: boolean
  }
  const [tlsPins, setTlsPins] = useState<TlsPin[]>([])
  const [showTlsPinDialog, setShowTlsPinDialog] = useState(false)
  const [tlsPinHost, setTlsPinHost] = useState('')
  const [tlsPinPort, setTlsPinPort] = useState(993)
  const [tlsFetching, setTlsFetching] = useState(false)
  const [tlsFetchError, setTlsFetchError] = useState('')

  const loadTemplates = useCallback(async () => {
    try {
      const raw = await window.api.invoke('templates:list') as Array<Record<string, unknown>>
      setTemplates((Array.isArray(raw) ? raw : []).map(r => ({
        id: typeof r.id === 'number' ? r.id : 0,
        name: typeof r.name === 'string' ? r.name : '',
        subject: typeof r.subject === 'string' ? r.subject : '',
        body: typeof r.body === 'string' ? r.body : '',
        shortcut: typeof r.shortcut === 'string' ? r.shortcut : null,
      })))
    } catch (err) {
      captureException(err, { source: 'Settings.loadTemplates' })
    }
  }, [])

  useEffect(() => {
    if (tab === 'templates') void loadTemplates()
  }, [tab, loadTemplates])

  const loadMailRules = useCallback(async () => {
    try {
      const raw = await window.api.invoke('rules:list') as Array<Record<string, unknown>>
      setMailRules((Array.isArray(raw) ? raw : []).map(r => ({
        id: typeof r.id === 'string' ? r.id : '',
        accountId: typeof r.accountId === 'string' ? r.accountId : null,
        name: typeof r.name === 'string' ? r.name : '',
        enabled: r.enabled === true,
        priority: typeof r.priority === 'number' ? r.priority : 0,
        conditions: (() => { try { return JSON.parse(typeof r.conditions === 'string' ? r.conditions : '[]') } catch { return [] } })(),
        actions: (() => { try { return JSON.parse(typeof r.actions === 'string' ? r.actions : '[]') } catch { return [] } })(),
        stopProcessing: r.stopProcessing === true,
      })))
    } catch (err) {
      captureException(err, { source: 'Settings.loadMailRules' })
    }
  }, [])

  useEffect(() => {
    if (tab === 'rules') void loadMailRules()
  }, [tab, loadMailRules])

  const loadAiRules = useCallback(async () => {
    try {
      const raw = await window.api.invoke('aiRules:list') as Array<Record<string, unknown>>
      setAiRules((Array.isArray(raw) ? raw : []).map(r => ({
        id: typeof r.id === 'string' ? r.id : '',
        accountId: typeof r.accountId === 'string' ? r.accountId : null,
        name: typeof r.name === 'string' ? r.name : '',
        enabled: r.enabled === true,
        prompt: typeof r.prompt === 'string' ? r.prompt : '',
        allowedActions: (() => { try { return JSON.parse(typeof r.allowedActions === 'string' ? r.allowedActions : '[]') } catch { return [] } })(),
        budgetPerDayUsd: typeof r.budgetPerDayUsd === 'number' ? r.budgetPerDayUsd : 0.5,
      })))
    } catch { /* ignore */ }
  }, [])

  const loadAiRuleLog = useCallback(async () => {
    try {
      const raw = await window.api.invoke('aiRules:log', 20) as Array<Record<string, unknown>>
      setAiRuleLog((Array.isArray(raw) ? raw : []).map(r => ({
        id: typeof r.id === 'number' ? r.id : 0,
        actionTaken: typeof r.actionTaken === 'string' ? r.actionTaken : '',
        reasoning: typeof r.reasoning === 'string' ? r.reasoning : null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
        uid: typeof r.uid === 'number' ? r.uid : 0,
        folder: typeof r.folder === 'string' ? r.folder : '',
      })))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (tab === 'ai' || tab === 'rules') {
      void loadAiRules()
      void loadAiRuleLog()
    }
  }, [tab, loadAiRules, loadAiRuleLog])

  const loadTlsPins = useCallback(async (accId: number) => {
    try {
      const raw = await window.api.invoke('tls:listPins', accId) as Array<Record<string, unknown>>
      setTlsPins((Array.isArray(raw) ? raw : []).map(r => ({
        id: typeof r.id === 'number' ? r.id : 0,
        accountId: typeof r.accountId === 'number' ? r.accountId : accId,
        host: typeof r.host === 'string' ? r.host : '',
        port: typeof r.port === 'number' ? r.port : 0,
        fingerprintSha256: typeof r.fingerprintSha256 === 'string' ? r.fingerprintSha256 : '',
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
        hasCertPem: r.hasCertPem === true,
      })))
    } catch {
      setTlsPins([])
    }
  }, [])

  const selectableMailboxes = useMemo(
    () => mailboxes.filter(m => m.path !== 'INBOX'),
    [mailboxes],
  )

  const isApiProvider = aiProvider === 'anthropic-api' || aiProvider === 'openai-api' || aiProvider === 'gemini-api'

  const aiModelOptions = useMemo(() => {
    if (aiProvider === 'openai-api') {
      return [
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        { value: 'gpt-4o', label: 'GPT-4o' },
        { value: 'gpt-4.1', label: 'GPT-4.1' },
      ]
    }
    return [
      { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ]
  }, [aiProvider])

  /** Shared AI connection check logic — used in both wizard and saved modes */
  const checkAiConnection = useCallback(async () => {
    setAiConnectionStatus('checking')
    setAiConnectionError('')
    try {
      if (aiProvider !== 'subscription' && aiApiKey && !aiKeyMasked) {
        await window.api.invoke('ai:saveApiKey', aiApiKey, aiProvider)
      }
      // Pass current (not yet saved) proxy and aiOpenAiBaseUrl values
      const overrides: Record<string, string | undefined> = {}
      if (aiProxyUrl) overrides.aiProxyUrl = aiProxyUrl
      if (aiOpenAiBaseUrl) overrides.aiOpenAiBaseUrl = aiOpenAiBaseUrl
      // User-initiated verification via the "Check connection" button — bypass
      // the result cache so each click issues a fresh IPC (single-flight still
      // joins any background call already in flight).
      const result = await singleFlightInvoke<{ status: string; message?: string }>(
        'ai:checkAuth',
        [aiProvider, Object.keys(overrides).length ? overrides : undefined],
        { source: 'user' },
      )
      if (result.status === 'authenticated') {
        setAiConnectionStatus('ok')
      } else {
        setAiConnectionStatus('error')
        const messageKey = AI_AUTH_STATUS_MESSAGE_KEYS[result.status]
        setAiConnectionError(messageKey ? t(messageKey) : (result.message || result.status))
      }
    } catch (e) {
      setAiConnectionStatus('error')
      // Connection *test*: the provider's own words ("401 Unauthorized",
      // "model not found") are the point of pressing the button, so the text
      // stays — only the machine tag the IPC funnel prepends is removed
      // (§2.127).
      setAiConnectionError(stripErrorPresentation(String(e)))
    }
  }, [aiApiKey, aiKeyMasked, aiProvider, aiProxyUrl, aiOpenAiBaseUrl, t])

  const refreshFolders = useCallback(async (id: number) => {
    setLoadingFolders(true)
    setFoldersError('')
    try {
      const res = await window.api.invoke('net:mailboxesAndRoles', id) as MailboxesAndRoles
      setMailboxes(res.mailboxes)
      setAutoRoles(res.detected)
      setFolderPrefs(res.prefs ?? {})
    } catch (e) {
      // Listing mailboxes fails for exactly the reasons the vocabulary covers
      // (no connection / timeout / rejected credentials); the raw text was
      // "Error invoking remote method 'net:mailboxesAndRoles': …" and told the
      // user nothing. §2.127.
      setFoldersError(tRef.current(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(e)]))
    } finally {
      setLoadingFolders(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await window.api.invoke('settings:get') as SettingsData | undefined
        if (cancelled) return
        if (s) {
          setTheme(s.theme)
          // §2.15-ter: bodyRetentionDays replaces the old cacheDays input.
          // Schema-side default is 365 (1 year); we mirror it client-side
          // so freshly persisted configs from older versions don't land
          // the dropdown on a "Forever" surprise.
          const retention = typeof s.bodyRetentionDays === 'number' ? s.bodyRetentionDays : 365
          setBodyRetentionDays(retention)
          prevBodyRetentionRef.current = retention
          setLanguage((SUPPORTED_LANGUAGES as readonly string[]).includes(s.language ?? '') ? s.language as Language : DEFAULT_LANGUAGE)
          setNotificationsEnabled(s.notificationsEnabled ?? true)
          setImapIdleEnabled(s.imapIdleEnabled ?? true)
          setSyncIntervalMinutes(typeof s.syncIntervalMinutes === 'number' ? s.syncIntervalMinutes : 1)
          setPeriodicSyncIntervalMin(typeof s.periodicSyncIntervalMin === 'number' ? s.periodicSyncIntervalMin : 5)
          setDraftSyncEnabled(s.draftSyncEnabled ?? true)
          setDefaultMailApp(s.defaultMailApp ?? false)
          setDarkModeEmails(s.darkModeEmails ?? true)
          setAlwaysLoadImages(s.alwaysLoadImages ?? false)
          setGravatarInMail(s.gravatarInMail ?? true)
          setGroupConversations(s.groupConversations ?? true)
          if (s.sortMode === 'date' || s.sortMode === 'from' || s.sortMode === 'subject') setSortMode(s.sortMode)
          if (s.autoAdvance === 'off' || s.autoAdvance === 'newer' || s.autoAdvance === 'older' || s.autoAdvance === 'back_to_list') setAutoAdvance(s.autoAdvance)
          if (s.conversationOrder === 'newest-top' || s.conversationOrder === 'oldest-top') setConversationOrder(s.conversationOrder)
          setHotkeysPreset((s.hotkeysPreset === 'outlook' ? 'outlook' : 'gmail') satisfies 'gmail' | 'outlook')
          setSendDelaySeconds(typeof s.sendDelaySeconds === 'number' ? s.sendDelaySeconds : 0)
          if (s.hiddenUnreadFolders) {
            setHiddenUnreadFolders(s.hiddenUnreadFolders)
          }
          setOfflineMaxSizeKB(s.offlineMaxSizeKB ?? 0)
          if (isVisibleAiProvider(s.aiProvider)) {
            setAiProvider(s.aiProvider)
            setSavedAiProvider(s.aiProvider)
          } else {
            setAiProvider('')
            setSavedAiProvider('')
          }
          if (s.aiModel) setAiModel(s.aiModel)
          setAiSendOnEnter(s.aiSendOnEnter ?? true)
          setAiOpenAiBaseUrl(s.aiOpenAiBaseUrl ?? '')
          setAiProxyUrl(s.aiProxyUrl ?? '')
          setAiLocale((s.aiLocale === 'ru' || s.aiLocale === 'en' || s.aiLocale === 'auto') ? s.aiLocale : 'auto')
          setAiShowSources(s.aiShowSources ?? true)
          setAiDailyBudgetUsd(typeof s.aiDailyBudgetUsd === 'number' ? s.aiDailyBudgetUsd : 5)
          setAiMonthlyBudgetUsd(typeof s.aiMonthlyBudgetUsd === 'number' ? s.aiMonthlyBudgetUsd : 100)
          setAiMaxTurns(typeof s.aiMaxTurns === 'number' ? s.aiMaxTurns : 30)
          setAiMaxBudgetPerRequest(typeof s.aiMaxBudgetPerRequest === 'number' ? s.aiMaxBudgetPerRequest : 2)
          setAiEgressPolicy(
            s.aiEgressPolicy === 'default-deny' || s.aiEgressPolicy === 'ask' || s.aiEgressPolicy === 'allow'
              ? s.aiEgressPolicy
              : 'default-deny',
          )
          // §3.3 B2: normalize the per-account opt-in Record defensively; only
          // strictly-true entries count as opted in.
          if (s.aiThreadSummaryEnabled && typeof s.aiThreadSummaryEnabled === 'object') {
            const raw = s.aiThreadSummaryEnabled as Record<string, unknown>
            const next: Record<string, boolean> = {}
            for (const [k, v] of Object.entries(raw)) next[k] = v === true
            setAiThreadSummaryEnabled(next)
          } else {
            setAiThreadSummaryEnabled({})
          }
          // §3.3 B4: same normalization for the Instant Reply per-account opt-in.
          if (s.aiInstantReplyEnabled && typeof s.aiInstantReplyEnabled === 'object') {
            const raw = s.aiInstantReplyEnabled as Record<string, unknown>
            const next: Record<string, boolean> = {}
            for (const [k, v] of Object.entries(raw)) next[k] = v === true
            setAiInstantReplyEnabled(next)
          } else {
            setAiInstantReplyEnabled({})
          }
          // §2.122 — mask on the fact that a key exists, not on the provider's
          // name. The old condition listed two providers by hand, so a stored
          // Gemini key was never masked at all, and a provider with no key
          // still showed dots. `aiApiKeySaved` is the main process's own record
          // of having written one — presentation only: the field unmasks on
          // focus, so a stale marker can never stop anyone entering a key, and
          // nothing here is treated as proof that the store holds it.
          setAiKeyMasked(isAiKeyFieldMasked(s.aiProvider, s.aiApiKeySaved))
          setSentryEnabled(s.sentryEnabled ?? true)
          setDebugLogging(s.debugLogging ?? false)
          setAutoUpdateEnabled(s.autoUpdateEnabled === true)
          setMcpExportEnabled(s.mcpExportEnabled ?? false)
          setMcpExportPort(typeof s.mcpExportPort === 'number' ? s.mcpExportPort : 23847)
          setMcpExportWhitelist(Array.isArray(s.mcpExportWhitelist) ? s.mcpExportWhitelist : [])
          setMcpEnableStdio(s.mcpEnableStdio ?? false)
          setMcpConnections(Array.isArray(s.mcpConnections) ? s.mcpConnections : [])
          setTrustedDomains(typeof s.trustedDomains === 'string' ? s.trustedDomains : '')
          settingsLoadedRef.current = true
        }
      } catch {
        // ignore
      }

      // Load MCP export server status
      try {
        const st = await window.api.invoke('mcpExport:status') as { status: 'running' | 'stopped' | 'error'; token?: string }
        if (!cancelled) {
          setMcpExportStatus(st.status)
          if (st.token) setMcpExportToken(st.token)
        }
      } catch {
        // ignore
      }

      // Load MCP client statuses
      try {
        const st = await window.api.invoke('mcp:status') as Record<string, { status: string; error?: string; toolCount: number }>
        if (!cancelled) setMcpStatuses(st)
      } catch {
        // ignore
      }

      try {
        const list = await window.api.invoke('accounts:list') as AccountMeta[]
        if (cancelled) return
        setAccounts(list)
        if (list.length === 0) {
          setAccountId(null)
          return
        }
        const cur = await window.api.invoke('accounts:getCurrent') as number | undefined
        if (cancelled) return
        const chosen = (typeof cur === 'number' && list.some(a => a.id === cur)) ? cur : list[0].id
        setAccountId(chosen)
      } catch {
        // ignore
      }
    })()

    /* Update account list on changes (add/remove from another window) */
    const onAccountsChanged = async () => {
      try {
        const list = await window.api.invoke('accounts:list') as AccountMeta[]
        if (cancelled) return
        setAccounts(list)
      } catch { /* ignore */ }
    }
    window.api?.on('accounts:changed', onAccountsChanged)

    return () => {
      cancelled = true
      window.api?.off('accounts:changed', onAccountsChanged)
    }
  }, [])

  const parseMcpEnv = (raw: string): Record<string, string> | undefined => {
    const env: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return Object.keys(env).length > 0 ? env : undefined
  }

  const buildMcpConfig = (): McpConnectionConfig => ({
    id: mcpEditId ?? crypto.randomUUID(),
    name: mcpForm.name,
    transport: mcpForm.transport,
    url: mcpForm.transport === 'sse' ? mcpForm.url : undefined,
    command: mcpForm.transport === 'stdio' ? mcpForm.command : undefined,
    args: mcpForm.transport === 'stdio' && mcpForm.args ? parseShellArgs(mcpForm.args) : undefined,
    env: mcpForm.transport === 'stdio' ? parseMcpEnv(mcpForm.env) : undefined,
    enabled: true,
    autoConnect: mcpForm.autoConnect,
  })

  const upsertMcpConnectionState = useCallback((config: McpConnectionConfig) => {
    setMcpConnections(prev => {
      const exists = prev.findIndex(c => c.id === config.id)
      if (exists >= 0) {
        const next = [...prev]
        next[exists] = config
        return next
      }
      return [...prev, config]
    })
  }, [])

  // Typed IPC result shapes. `mcp:saveConnection` and `mcp:testConnection`
  // return structured `{ ok: true | false, ... }` envelopes; the renderer
  // MUST branch on `.ok` instead of blindly await-ing the promise. Prior
  // to this fix the renderer treated `{ ok: false, reason }` as a success
  // (it doesn't throw), updated its optimistic state, and the UI showed a
  // fake-saved connection that the main process actually rejected.
  //
  // Reasons enumerated here match the main-side IPC handlers; an unknown
  // reason string falls back to a generic localized error message below.
  //
  // NOTE: the failure branch uses a single permissive shape with optional
  // `keys` / `allowlist` rather than a discriminated union over
  // `reason`. A discriminated union plus a catch-all `{ reason: string }`
  // confuses TS narrowing — `reason: 'forbidden_env_key'` collapses into
  // the generic branch and `keys` becomes unreachable. A single shape
  // with optional fields and runtime narrowing on the reason string is
  // clearer and still type-safe.
  type McpSaveConnectionResult =
    | { ok: true; id: string }
    | { ok: false; reason: string; keys?: string[]; allowlist?: readonly string[] }

  type McpTestConnectionResult =
    | { ok: true; toolCount: number }
    | { ok: false; reason: string }

  /**
   * Translate a structured `mcp:saveConnection` failure reason into a
   * localized, user-facing message. Falls back to the generic string when
   * the reason is not specifically translated.
   */
  const formatMcpSaveError = useCallback((result: Extract<McpSaveConnectionResult, { ok: false }>): string => {
    if (result.reason === 'forbidden_env_key') {
      const keys = (result.keys ?? []).join(', ')
      return t('mcpClient.saveError.forbiddenEnvKey', { keys })
    }
    if (result.reason === 'unapproved_command') {
      return t('mcpClient.saveError.unapprovedCommand')
    }
    return t('mcpClient.saveError.generic', { reason: result.reason })
  }, [t])

  /**
   * Translate a structured `mcp:testConnection` failure reason into a
   * localized, user-facing message. Test-connect returns the same reason
   * vocabulary as `mcp:connect` gate rejections.
   */
  const formatMcpTestError = useCallback((reason: string): string => {
    switch (reason) {
      case 'not_approved':
        return t('mcpClient.testError.notApproved')
      case 'env_disabled':
        return t('mcpClient.testError.envDisabled')
      default:
        return t('mcpClient.testError.generic', { reason })
    }
  }, [t])

  const persistMcpConnection = useCallback(async (config: McpConnectionConfig) => {
    const result = (await window.api.invoke('mcp:saveConnection', config)) as McpSaveConnectionResult
    if (!result.ok) {
      // Do NOT upsert optimistic state — the main process rejected the save.
      throw new Error(formatMcpSaveError(result))
    }
    upsertMcpConnectionState(config)
  }, [upsertMcpConnectionState, formatMcpSaveError])

  const removeSavedMcpConnection = useCallback(async (id: string) => {
    await window.api.invoke('mcp:disconnect', id).catch(() => {})
    await window.api.invoke('mcp:removeConnection', id)
    setMcpConnections(prev => prev.filter(conn => conn.id !== id))
    setMcpStatuses(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  // Snapshot of current settings for detecting unsaved changes
  const settingsSnapshot = JSON.stringify({
    theme, language, bodyRetentionDays, notificationsEnabled, imapIdleEnabled,
    syncIntervalMinutes, periodicSyncIntervalMin, draftSyncEnabled, defaultMailApp, darkModeEmails, alwaysLoadImages, gravatarInMail,
    groupConversations, sortMode, autoAdvance, conversationOrder, hotkeysPreset, sendDelaySeconds, hiddenUnreadFolders,
    offlineMaxSizeKB,
    aiProvider, aiModel, aiSendOnEnter, aiOpenAiBaseUrl, aiProxyUrl, aiLocale,
    aiShowSources, aiDailyBudgetUsd, aiMonthlyBudgetUsd, aiMaxTurns,
    aiMaxBudgetPerRequest, aiEgressPolicy, aiThreadSummaryEnabled, aiInstantReplyEnabled, sentryEnabled, debugLogging, autoUpdateEnabled,
    mcpExportEnabled, mcpExportPort, mcpExportWhitelist, mcpEnableStdio,
    trustedDomains,
  })

  // Capture initial snapshot exactly once after settings are loaded into state.
  // This avoids duplicating the field list — settingsSnapshot is the single source of truth.
  useEffect(() => {
    if (settingsLoadedRef.current && initialSnapshot === '') {
      setInitialSnapshot(settingsSnapshot)
      settingsLoadedRef.current = false
    }
  }, [settingsSnapshot, initialSnapshot])

  const hasUnsavedChanges = (initialSnapshot !== ''
    && !savedRef.current
    && settingsSnapshot !== initialSnapshot)
    || (identitiesDirty && !savedRef.current)

  // 2.3 wave 4: track the last accountId the effect synced state for, so we
  // can distinguish "user switched account (full reset)" from "accounts list
  // updated for the same account (partial sync, preserve local dirty edits)".
  // Ref-based — we don't want a re-render when this changes.
  const lastSyncedAccountIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof accountId !== 'number') {
      setMailboxes([])
      setAutoRoles({})
      setFolderPrefs({})
      setTlsPins([])
      lastSyncedAccountIdRef.current = null
      return
    }
    const meta = accounts.find(a => a.id === accountId)
    const accountChanged = lastSyncedAccountIdRef.current !== accountId
    setFolderRoles(meta?.folderRoles ?? {})
    // Preserve local unsaved edits in the Identities tab when the accounts
    // list churns for reasons unrelated to the user switching accounts
    // (e.g. our own avatar save broadcasting `accounts:changed`, or another
    // Settings window saving). Without this guard a refresh of `accounts`
    // silently wipes pending identity edits. On actual account switch we
    // still want a clean slate.
    if (accountChanged || !identitiesDirty) {
      setSignature(meta?.signature ?? '')
      setIdentities(meta?.identities ?? [])
      setIdentitiesDirty(false)
      setIdentitiesSaveError('')
    }
    lastSyncedAccountIdRef.current = accountId
    void refreshFolders(accountId)
    void loadTlsPins(accountId)
  }, [accountId, accounts, identitiesDirty, refreshFolders, loadTlsPins])

  useEffect(() => {
    if (tab === 'ai') {
      window.api.invoke('ai:memoryRead').then((res) => {
        const data = res as { content: string }
        setAiMemory(data.content || '')
        setAiMemoryDirty(false)
      }).catch(() => {})
    }
  }, [tab])

  const setRole = useCallback((role: keyof FolderRoles, value: string) => {
    setFolderRoles(prev => ({ ...prev, [role]: value || undefined }))
  }, [])

  /**
   * Handle identity list updates from IdentitiesTab. Accepts the draft shape
   * (no server-assigned ids for fresh rows) and preserves existing ids for
   * unchanged rows so React keys stay stable between re-renders. We don't
   * persist on each change — bulk save runs via save() below, which posts the
   * full account payload through `accounts:save`.
   */
  const handleIdentitiesChange = useCallback((next: IdentityDraft[]) => {
    setIdentities(() => next.map(d => ({
      id: d.id ?? '',
      displayName: d.displayName,
      email: d.email,
      signature: d.signature,
      defaultBcc: d.defaultBcc,
      isDefault: d.isDefault,
    })))
    setIdentitiesDirty(true)
    setIdentitiesSaveError('')
  }, [])

  const createRoleMailbox = useCallback(async (role: keyof FolderRoles, customPath?: string) => {
    if (typeof accountId !== 'number') return
    const path = customPath || DEFAULT_ROLE_PATH[role]
    setCreatingRole(role)
    setFoldersError('')
    try {
      await window.api.invoke('net:createMailbox', accountId, path)
      await refreshFolders(accountId)
      setRole(role, path)
    } catch (e) {
      // Unlike the folder listing above, CREATE fails for reasons only the
      // server can explain ("Mailbox already exists", namespace/quota
      // refusals), so the text is kept and only the §2.127 tag is stripped.
      setFoldersError(stripErrorPresentation(String(e)))
    } finally {
      setCreatingRole(null)
      setCreateFolderDialog(null)
    }
  }, [accountId, refreshFolders, setRole])

  const resolveFolderRole = useCallback((mailbox: Mailbox): string | null => {
    const mergedRoles: FolderRoles = { ...autoRoles, ...folderRoles }
    return getFolderRole(mailbox.path, mailbox.specialUse, mergedRoles)
  }, [autoRoles, folderRoles])

  const getFolderPrefView = useCallback((mailbox: Mailbox) => {
    const role = resolveFolderRole(mailbox)
    const defaults = defaultFolderPref(role)
    const saved = folderPrefs[mailbox.path]
    const visible = saved?.visible ?? defaults.visible
    const includeInBadges = visible ? (saved?.includeInBadges ?? defaults.includeInBadges) : false
    const headerSyncModeRaw = saved?.headerSyncMode ?? defaults.headerSyncMode
    const headerSyncMode = visible
      ? (headerSyncModeRaw === 'off' ? (mailbox.path.toUpperCase() === 'INBOX' ? 'full' : 'on_open') : headerSyncModeRaw)
      : 'off'
    const offlineMode = visible ? (saved?.offlineMode ?? defaults.offlineMode) : 'off'
    return {
      role,
      visible,
      includeInBadges,
      headerSyncMode,
      headerSyncDays: saved?.headerSyncDays ?? defaults.headerSyncDays ?? 30,
      offlineMode,
      offlineDays: saved?.offlineDays ?? defaults.offlineDays ?? 30,
      icon: saved?.icon ?? '',
    }
  }, [folderPrefs, resolveFolderRole])

  const updateFolderPref = useCallback(async (folderPath: string, patch: Partial<FolderPreference>) => {
    if (typeof accountId !== 'number') return
    const res = await window.api.invoke('folder:prefs:upsert', accountId, folderPath, patch) as { ok?: boolean; pref?: FolderPreference }
    if (!res?.ok || !res.pref) return
    const nextPref = res.pref
    setFolderPrefs(prev => ({ ...prev, [folderPath]: nextPref }))
    if (nextPref.headerSyncMode === 'full' || nextPref.headerSyncMode === 'period') {
      void window.api.invoke(
        'net:syncFolderHeaders',
        accountId,
        folderPath,
        nextPref.headerSyncMode === 'period'
          ? { mode: 'period', days: Math.max(1, nextPref.headerSyncDays ?? 30) }
          : { mode: 'full' },
      ).catch(() => {})
    }
  }, [accountId])

  const openAccountNew = useCallback(() => {
    void window.api.invoke('ui:openAccount', 'new')
  }, [])

  const openAccountEdit = useCallback((id: number) => {
    void window.api.invoke('ui:openAccount', 'edit', id)
  }, [])

  const setCurrentAccount = useCallback(async (id: number) => {
    await window.api.invoke('accounts:setCurrent', id)
    setAccountId(id)
  }, [])

  const removeAccount = useCallback(async (id: number) => {
    const meta = accounts.find(a => a.id === id)
    const label = (meta?.name || meta?.imap.user || `#${id}`).trim() || `#${id}`
    let messageCount = 0
    let localDataBytes = 0
    try {
      const preview = await window.api.invoke('accounts:removePreview', id) as { messageCount?: number; localDataBytes?: number }
      messageCount = Number(preview?.messageCount) || 0
      localDataBytes = Number(preview?.localDataBytes) || 0
    } catch {
      // ignore
    }
    const ok = window.confirm(t('account.confirm.removeDetailed', {
      label,
      count: messageCount,
      size: formatBytes(localDataBytes) || '0 B',
    }))
    if (!ok) return
    await window.api.invoke('accounts:remove', id)
    const next = accounts.filter(a => a.id !== id)
    setAccounts(next)
    if (accountId === id) {
      const nextId = next[0]?.id ?? null
      setAccountId(nextId)
      if (typeof nextId === 'number') {
        try { await window.api.invoke('accounts:setCurrent', nextId) } catch { /* ignore */ }
      }
    }
  }, [accountId, accounts, t])

  const saveAvatarSettings = useCallback(async (id: number, patch: { colorIndex?: number; avatarInitials?: string; avatarIcon?: string; avatarMode?: 'initials' | 'icon' | 'gravatar' }) => {
    const acc = accounts.find(a => a.id === id)
    if (!acc) return
    try {
      // 2.3 wave 4: when the avatar save targets the account whose identities
      // the user is currently editing, piggy-back the dirty identity list onto
      // the save. Without this, `accounts:save` broadcasts `accounts:changed`
      // → renderer reloads accounts → the sync effect (below) wipes the
      // pending identity edits with the (now-stale) server state. The helper
      // delegates to `buildAccountSavePayloadPatch` so avatar saves and the
      // main Save button emit identical signature/identities shapes.
      const isEditingThisAccount = accountId === id
      const signaturePatch = buildAvatarSavePayloadPatch({
        targetAccountId: id,
        editorAccountId: accountId,
        savedAccountSignature: acc.signature,
        editorSignature: signature,
        editorIdentities: identities,
        editorIdentitiesDirty: identitiesDirty,
      })
      const payload = {
        id: acc.id,
        name: acc.name,
        email: acc.email,
        colorIndex: patch.colorIndex ?? acc.colorIndex,
        avatarInitials: patch.avatarInitials ?? acc.avatarInitials,
        avatarIcon: patch.avatarIcon ?? acc.avatarIcon,
        avatarMode: patch.avatarMode ?? acc.avatarMode,
        authType: acc.authType ?? 'password',
        imap: { ...acc.imap, pass: undefined, tlsPinsSha256: undefined },
        smtp: { ...acc.smtp, pass: undefined, tlsPinsSha256: undefined },
        folderRoles: acc.folderRoles,
        ...signaturePatch,
      }
      await window.api.invoke('accounts:save', payload)
      const updated = { ...acc, ...patch }
      setAccounts(prev => prev.map(a => a.id === id ? updated : a))
      if (isEditingThisAccount && identitiesDirty) {
        // Identities were just persisted as part of the avatar save — clear
        // the dirty flag so the `accounts:changed`-driven sync effect can
        // re-seed the editor from the canonical server state without the
        // local-dirty guard treating stale edits as still-pending.
        setIdentitiesDirty(false)
        setIdentitiesSaveError('')
      }
    } catch (e) {
      // Verdict, never the value: renderer console output is a Sentry
      // breadcrumb source (default integrations, src/sentry.ts), and the text
      // after `[mcerr:*]` is third-party prose left raw on purpose. See the
      // note in src/utils/errorPresentation.ts. `accounts:save` reaches IMAP
      // validation, so this catch does see server text.
      console.error('saveAvatarSettings failed:', decodeErrorPresentation(e))
    }
  }, [accountId, accounts, identities, identitiesDirty, signature])

  const save = useCallback(async () => {
    // In wizard mode (new provider, not yet saved) require a successful connection check
    if (aiProvider && !savedAiProvider && aiConnectionStatus !== 'ok') {
      setAiConnectionError(t('ai.settings.checkRequired'))
      setAiConnectionStatus('error')
      return
    }
    // §2.15-ter: shrinking body retention can delete user data. Run a
    // preview against the new value first, and only proceed past the
    // window.confirm if the user accepts the impact. Increases or "forever"
    // never destroy data, so they save unprompted.
    //
    // §2.15-ter (codex iteration 4): on preview IPC failure abort the
    // save with an explicit confirm. Previously the catch block fell
    // through silently and the destructive shrink would commit without
    // any user acknowledgement — fail-closed is safer.
    const prevRetention = prevBodyRetentionRef.current
    if (typeof prevRetention === 'number') {
      const prevForever = prevRetention === -1
      const nextForever = bodyRetentionDays === -1
      const isShrink = (prevForever && !nextForever) || (!prevForever && !nextForever && bodyRetentionDays < prevRetention)
      if (isShrink) {
        let previewOk = false
        let previewCount = 0
        let previewBytes = 0
        try {
          const preview = await window.api.invoke('cache:bodyTrimPreview', bodyRetentionDays) as { count: number; estimatedBytes: number }
          previewOk = true
          previewCount = preview?.count ?? 0
          previewBytes = preview?.estimatedBytes ?? 0
        } catch {
          previewOk = false
        }

        if (!previewOk) {
          // Preview failed — we don't know the impact. Confirm before destroying.
          const fallbackMsg = t('settings.bodyRetentionDays.confirmShrinkUnknown')
          if (!window.confirm(fallbackMsg)) {
            return
          }
        } else if (previewCount > 0) {
          const mb = Math.max(1, Math.round(previewBytes / (1024 * 1024)))
          const msg = t('settings.bodyRetentionDays.confirmShrink', { count: previewCount, mb })
          if (!window.confirm(msg)) {
            return
          }
        }
      }
    }

    const saveResult = await window.api.invoke('settings:save', {
      theme,
      bodyRetentionDays,
      language,
      notificationsEnabled,
      imapIdleEnabled,
      syncIntervalMinutes,
      periodicSyncIntervalMin,
      draftSyncEnabled,
      defaultMailApp,
      hiddenUnreadFolders,
      darkModeEmails,
      alwaysLoadImages,
      gravatarInMail,
      groupConversations,
      sortMode,
      autoAdvance,
      conversationOrder,
      hotkeysPreset,
      sendDelaySeconds,
      offlineMaxSizeKB,
      aiProvider: aiProvider || undefined,
      aiModel,
      aiSendOnEnter,
      aiOpenAiBaseUrl: aiOpenAiBaseUrl || undefined,
      aiProxyUrl: aiProxyUrl || undefined,
      aiLocale,
      aiShowSources,
      aiDailyBudgetUsd,
      aiMonthlyBudgetUsd,
      aiMaxTurns,
      aiMaxBudgetPerRequest,
      aiEgressPolicy,
      aiThreadSummaryEnabled,
      aiInstantReplyEnabled,
      sentryEnabled,
      debugLogging,
      autoUpdateEnabled,
      mcpExportEnabled,
      mcpExportPort,
      mcpExportWhitelist: mcpExportWhitelist.length > 0 ? mcpExportWhitelist : undefined,
      // §3.10 P0: mcpEnableStdio is main-only — the settings:save payload
      // must not carry it. Renderer flips stdio on via the separate
      // `mcp:requestStdioEnable` IPC, which pops a native confirm dialog.
      // Including it here would be rejected with `{ ok: false, reason: 'forbidden_field' }`.
      trustedDomains: trustedDomains || undefined,
    })
    // §2.119 — read the reply BEFORE the rest of the save runs, but act on it
    // at the very end. Main applies every non-destination edit even when it
    // refuses the address, so the remaining steps below (API key, folder roles,
    // identities) must still run: the person changed several things and only
    // one of them was held back. What the refusal costs is the CLOSE, nothing
    // else.
    const aiDestinationApplied = recordSettingsSaveResult(saveResult)
    // Save the API key via keytar for API providers.
    if (aiProvider && aiProvider !== 'subscription' && aiApiKey && !aiKeyMasked) {
      await window.api.invoke('ai:saveApiKey', aiApiKey, aiProvider)
    }
    if (typeof accountId === 'number') {
      // folderRoles are stored in the account (account-scoped), not in settings.
      const meta = await window.api.invoke('accounts:get', accountId) as AccountMeta | undefined
      if (meta) {
        try {
          // 2.3 wave 3: identities[] is the sole source of truth for the
          // default identity's signature when the user has touched the
          // Identities tab. Emitting a parallel top-level `signature` in that
          // branch lets the save-path's legacy mirror resurrect a value the
          // user just cleared. When identities aren't being submitted (legacy
          // Signature tab edit only), pass `signature` through verbatim —
          // including explicit `''` on clear, distinct from `undefined`
          // ("keep existing"). See `buildAccountSavePayloadPatch` contract.
          const signaturePatch = buildAccountSavePayloadPatch({
            signature,
            identities,
            identitiesDirty,
          })
          await window.api.invoke('accounts:save', {
            id: accountId,
            name: meta.name,
            imap: { ...meta.imap },
            smtp: { ...meta.smtp },
            folderRoles,
            ...signaturePatch,
          })
          setIdentitiesDirty(false)
          setIdentitiesSaveError('')
        } catch (e) {
          // A failed `accounts:save` has no server-side story to tell — the
          // old text was the raw IPC wrapper. §2.127 vocabulary instead.
          setIdentitiesSaveError(t(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(e)]))
          return
        }
      }
    }
    // §2.15-ter: cache trim no longer runs from the renderer. Body retention
    // is enforced by the periodic pruneOldEmls() task in main, which the
    // settings:save handler kicks immediately on shrink.
    prevBodyRetentionRef.current = bodyRetentionDays
    // §2.119 — the address the user asked for is not the one in use. Leave the
    // window open with the notice `recordSettingsSaveResult` just raised, and
    // leave `savedRef` alone so the unsaved-changes guard still fires on close:
    // there IS an unsaved change, namely the field on screen.
    if (!aiDestinationApplied) return
    savedRef.current = true
    window.close()
    // Note: `mcpEnableStdio` intentionally not in the dep array — it's no
    // longer emitted through this settings:save path (§3.10 P0). The state
    // still mirrors the main-side flag for UI rendering, but flipping it
    // goes through `mcp:requestStdioEnable` which has its own side-effect path.
  }, [accountId, aiApiKey, aiConnectionStatus, aiDailyBudgetUsd, aiEgressPolicy, aiKeyMasked, aiLocale, aiMaxBudgetPerRequest, aiMaxTurns, aiModel, aiMonthlyBudgetUsd, aiOpenAiBaseUrl, aiProvider, aiProxyUrl, aiSendOnEnter, aiShowSources, aiThreadSummaryEnabled, aiInstantReplyEnabled, alwaysLoadImages, autoAdvance, autoUpdateEnabled, bodyRetentionDays, conversationOrder, darkModeEmails, debugLogging, defaultMailApp, draftSyncEnabled, folderRoles, gravatarInMail, groupConversations, hiddenUnreadFolders, hotkeysPreset, identities, identitiesDirty, imapIdleEnabled, language, mcpExportEnabled, mcpExportPort, mcpExportWhitelist, notificationsEnabled, offlineMaxSizeKB, periodicSyncIntervalMin, recordSettingsSaveResult, savedAiProvider, sendDelaySeconds, sentryEnabled, signature, sortMode, syncIntervalMinutes, t, theme, trustedDomains])

  // Account selector — shared across Folders and Signature tabs
  const accountSelector = accounts.length > 1 && (
    <div className="setting-row">
      <label>{t('settings.folders.account')}:</label>
      <Select
        testId="settings-folders-account"
        value={String(accountId ?? '')}
        onChange={v => setAccountId(Number(v))}
        ariaLabel={t('settings.folders.account')}
        options={accounts.map(a => {
          const name = (a.name || '').trim()
          const email = a.email || a.imap.user || ''
          const label = name ? `${name} (${email})` : email || `#${a.id}`
          return { value: String(a.id), label }
        })}
      />
    </div>
  )

  return (
    <>
    {/* Custom titlebar for frameless window. Close keeps the unsaved-changes
        guard, hence the explicit handler. */}
    <WindowTitlebar
      title={t('settings.title')}
      onClose={() => {
        if (hasUnsavedChanges && !window.confirm(t('settings.unsavedWarning'))) return
        window.close()
      }}
    />
    <div className="settings-layout">
      {/* Vertical tabs */}
      <nav className="settings-tabs">
        {TABS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            className={`settings-tab${tab === id ? ' settings-tab-active' : ''}`}
            data-testid={`settings-tab-${id}`}
            onClick={() => setTab(id)}
          >
            <Icon size={16} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <div className={`settings-content${tab === 'folders' ? ' settings-content-folders' : ''}`}>
        {tab === 'accounts' && (
          <>
          <section className="form-section">
            <h3>{t('settings.accounts.title')}</h3>
            <p className="hint">{t('settings.accounts.hint')}</p>

            {accounts.length === 0 ? (
              <div className="form-status-inline">{t('settings.accounts.empty')}</div>
            ) : (
              <div className="badges-list">
                {accounts.map(a => {
                  const email = (a.smtp.user || a.imap.user || '').trim()
                  const label = (a.name || email || `#${a.id}`).trim()
                  const isCurrent = accountId === a.id
                  const isEditing = avatarEditId === a.id
                  return (
                    <div key={a.id}>
                      <div className="role-row account-row">
                        <AccountAvatar account={a} size={28} />
                        <div style={{ flex: 1, minWidth: 0, marginLeft: 8 }}>
                          <div style={{ fontWeight: 600 }}>{label}</div>
                          {email && <div className="hint">{email}</div>}
                        </div>
                        {isCurrent && <span className="hint">{t('settings.accounts.current')}</span>}
                        {!isCurrent && (
                          <button type="button" onClick={() => void setCurrentAccount(a.id)} title={t('settings.accounts.makeCurrent')}>
                            <CheckCircle size={14} />
                          </button>
                        )}
                        <button type="button" onClick={() => setAvatarEditId(isEditing ? null : a.id)} title={t('settings.accounts.customizeAvatar')}>
                          <Palette size={14} />
                        </button>
                        <button type="button" onClick={() => openAccountEdit(a.id)} title={t('settings.accounts.edit')}>
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => void removeAccount(a.id)}
                          title={t('settings.accounts.remove')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {isEditing && (
                        <div className="avatar-editor">
                          {/* Display mode */}
                          <div className="avatar-editor-section">
                            <label className="hint">{t('settings.accounts.avatarMode')}</label>
                            <div className="avatar-mode-toggle">
                              <button
                                type="button"
                                className={(!a.avatarMode || a.avatarMode === 'initials') ? 'active' : ''}
                                onClick={() => void saveAvatarSettings(a.id, { avatarMode: 'initials' })}
                              >
                                <Type size={14} /> {t('settings.accounts.avatarInitials')}
                              </button>
                              <button
                                type="button"
                                className={a.avatarMode === 'icon' ? 'active' : ''}
                                onClick={() => void saveAvatarSettings(a.id, { avatarMode: 'icon', avatarIcon: a.avatarIcon || 'mail' })}
                              >
                                <Image size={14} /> {t('settings.accounts.avatarIcon')}
                              </button>
                              <button
                                type="button"
                                className={a.avatarMode === 'gravatar' ? 'active' : ''}
                                onClick={() => { setGravatarFailed(prev => { const s = new Set(prev); s.delete(a.id); return s }); void saveAvatarSettings(a.id, { avatarMode: 'gravatar' }) }}
                              >
                                <Globe size={14} /> Gravatar
                              </button>
                            </div>
                          </div>

                          {/* Custom initials (initials mode only) */}
                          {(!a.avatarMode || a.avatarMode === 'initials') && (
                            <div className="avatar-editor-section">
                              <label className="hint">{t('settings.accounts.avatarInitialsLabel')}</label>
                              <input
                                type="text"
                                maxLength={2}
                                value={a.avatarInitials || ''}
                                placeholder={getInitials(label)}
                                className="avatar-initials-input"
                                onChange={e => {
                                  const val = e.target.value.toUpperCase()
                                  void saveAvatarSettings(a.id, { avatarInitials: val || undefined })
                                }}
                              />
                              <span className="hint">{t('settings.accounts.avatarInitialsHint')}</span>
                            </div>
                          )}

                          {/* Icon picker (icon mode only) */}
                          {a.avatarMode === 'icon' && (
                            <div className="avatar-editor-section">
                              <label className="hint">{t('settings.accounts.avatarIconLabel')}</label>
                              <div className="avatar-icon-grid">
                                {AVATAR_ICONS.map(name => {
                                  const Icon = getAvatarIcon(name)
                                  return (
                                    <button
                                      key={name}
                                      type="button"
                                      className={`avatar-icon-btn${a.avatarIcon === name ? ' active' : ''}`}
                                      onClick={() => void saveAvatarSettings(a.id, { avatarIcon: name })}
                                    >
                                      <Icon size={18} />
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}

                          {/* Gravatar hint */}
                          {a.avatarMode === 'gravatar' && (
                            <div className="avatar-editor-section">
                              <span className="hint">
                                {t('settings.accounts.gravatarHint', { email: a.email || a.imap.user || '' })}
                              </span>
                            </div>
                          )}

                          {/* Color palette (not for gravatar) */}
                          {a.avatarMode !== 'gravatar' && (
                            <div className="avatar-editor-section">
                              <label className="hint">{t('settings.accounts.avatarColor')}</label>
                              <div className="avatar-color-palette">
                                {AVATAR_COLORS.map((color, idx) => (
                                  <button
                                    key={color}
                                    type="button"
                                    className={`avatar-color-btn${a.colorIndex === idx ? ' active' : ''}`}
                                    style={{ background: color }}
                                    onClick={() => void saveAvatarSettings(a.id, { colorIndex: idx })}
                                  />
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Preview */}
                          <div className="avatar-editor-section">
                            <label className="hint">{t('settings.accounts.avatarPreview')}</label>
                            <AccountAvatar
                              account={a}
                              size={48}
                              onGravatarFailed={() => setGravatarFailed(prev => new Set(prev).add(a.id))}
                            />
                            {a.avatarMode === 'gravatar' && gravatarFailed.has(a.id) && (
                              <span className="hint" style={{ color: 'var(--color-danger, #ef4444)', marginTop: 4 }}>
                                {t('settings.accounts.gravatarNotFound', { email: a.email || a.imap.user || '' })}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="form-actions" style={{ marginTop: 12 }}>
              <button type="button" onClick={openAccountNew}>
                <Plus size={14} /> {t('settings.accounts.add')}
              </button>
            </div>
          </section>

          {/* TLS Certificate Pinning */}
          {typeof accountId === 'number' && (
            <section className="form-section" style={{ marginTop: 16 }}>
              <h3><Shield size={16} style={{ marginRight: 6, verticalAlign: -2 }} />{t('account.tls.title')}</h3>
              <p className="hint">{t('account.tls.hint')}</p>

              {tlsPins.length === 0 ? (
                <div className="form-status-inline">{t('account.tls.noPins')}</div>
              ) : (
                <table className="tls-pins-table">
                  <thead>
                    <tr>
                      <th>{t('account.tls.host')}</th>
                      <th>{t('account.tls.port')}</th>
                      <th>{t('account.tls.fingerprint')}</th>
                      <th>{t('account.tls.trustAnchor')}</th>
                      <th>{t('account.tls.created')}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tlsPins.map(pin => (
                      <tr key={pin.id}>
                        <td>{pin.host}</td>
                        <td>{pin.port}</td>
                        <td className="fingerprint-cell" title={pin.fingerprintSha256}>
                          {pin.fingerprintSha256.length > 20 ? pin.fingerprintSha256.slice(0, 20) + '...' : pin.fingerprintSha256}
                        </td>
                        <td>
                          {/* Only a pin that stored the certificate body works as
                              a trust anchor. Surfaced per row because the two
                              kinds behave differently on a self-signed server. */}
                          <span
                            data-testid="tls-pin-anchor-badge"
                            style={pin.hasCertPem ? TLS_PIN_ANCHOR_BADGE_STYLE : TLS_PIN_FINGERPRINT_ONLY_BADGE_STYLE}
                            title={pin.hasCertPem ? t('account.tls.anchorStoredHint') : t('account.tls.fingerprintOnlyHint')}
                          >
                            {pin.hasCertPem ? t('account.tls.anchorStored') : t('account.tls.fingerprintOnly')}
                          </span>
                        </td>
                        <td>{pin.createdAt ? new Date(pin.createdAt).toLocaleDateString() : ''}</td>
                        <td>
                          <button
                            type="button"
                            className="btn-danger"
                            title={t('settings.accounts.remove')}
                            onClick={async () => {
                              try {
                                await window.api.invoke('tls:removePin', pin.id)
                                setTlsPins(prev => prev.filter(p => p.id !== pin.id))
                              } catch { /* ignore */ }
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Answer "why does my self-signed server still not connect?"
                  before it is asked: a fingerprint-only pin is not enough. */}
              {tlsPins.some(p => !p.hasCertPem) && (
                <p className="hint" data-testid="tls-pin-fingerprint-only-note" style={{ marginTop: 8 }}>
                  {t('account.tls.fingerprintOnlyHint')}
                </p>
              )}

              <div className="form-actions" style={{ marginTop: 12 }}>
                <button type="button" onClick={() => {
                  setShowTlsPinDialog(true)
                  setTlsPinHost('')
                  setTlsPinPort(993)
                  setTlsFetchError('')
                }}>
                  <Plus size={14} /> {t('account.tls.addPin')}
                </button>
              </div>
            </section>
          )}

          {/* TLS pin add dialog */}
          {showTlsPinDialog && (
            <div className="modal-overlay" onClick={() => setShowTlsPinDialog(false)}>
              <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <h3>{t('account.tls.addPinTitle')}</h3>
                <p className="hint">{t('account.tls.addPinHint')}</p>
                {/* Set the expectation up front: a manual pin records the
                    fingerprint only, which does not make a self-signed server
                    trusted — that still goes through the certificate warning. */}
                <p className="hint" data-testid="tls-add-pin-anchor-warning">{t('account.tls.addPinAnchorWarning')}</p>
                <div className="setting-row">
                  <label>{t('account.tls.host')}:</label>
                  <input
                    autoFocus
                    type="text"
                    value={tlsPinHost}
                    onChange={e => setTlsPinHost(e.target.value)}
                    placeholder="mail.example.com"
                    style={{ flex: 1 }}
                  />
                </div>
                <div className="setting-row">
                  <label>{t('account.tls.port')}:</label>
                  <input
                    type="number"
                    value={tlsPinPort}
                    min={1}
                    max={65535}
                    onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 1) setTlsPinPort(v) }}
                    style={{ width: 80 }}
                  />
                </div>
                {tlsFetchError && <div className="status-err" style={{ marginBottom: 8 }}>{tlsFetchError}</div>}
                <div className="modal-actions">
                  <button type="button" onClick={() => setShowTlsPinDialog(false)}>
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!tlsPinHost.trim() || tlsFetching}
                    onClick={async () => {
                      if (typeof accountId !== 'number') return
                      setTlsFetching(true)
                      setTlsFetchError('')
                      try {
                        const cert = await window.api.invoke('tls:getServerCert', { host: tlsPinHost.trim(), port: tlsPinPort }) as {
                          fingerprintSha256: string; subject?: string; issuer?: string
                        }
                        const ok = window.confirm(
                          t('account.tls.pinConfirm', {
                            host: tlsPinHost.trim(),
                            port: String(tlsPinPort),
                            subject: cert.subject || t('account.tls.unknown'),
                            issuer: cert.issuer || t('account.tls.unknown'),
                            fingerprint: cert.fingerprintSha256,
                          }),
                        )
                        if (ok) {
                          await window.api.invoke('tls:addPin', { accountId, host: tlsPinHost.trim(), port: tlsPinPort, fingerprintSha256: cert.fingerprintSha256 })
                          void loadTlsPins(accountId)
                          setShowTlsPinDialog(false)
                        }
                      } catch (e) {
                        // Certificate probe: the transport-level reason
                        // ("self signed certificate", ENOTFOUND) is what the
                        // user came here to see. Keep it, drop the tag.
                        setTlsFetchError(t('account.tls.fetchError', { error: stripErrorPresentation(String(e)) }))
                      } finally {
                        setTlsFetching(false)
                      }
                    }}
                  >
                    {tlsFetching
                      ? <><Loader2 size={14} className="spin" /> {t('account.tls.fetchAndPin')}</>
                      : t('account.tls.fetchAndPin')
                    }
                  </button>
                </div>
              </div>
            </div>
          )}
          </>
        )}

        {tab === 'general' && (
          <section className="form-section">
            <h3>{t('settings.sections.general')}</h3>

            <div className="setting-row">
              <label>{t('settings.theme.label')}:</label>
              <Select
                testId="settings-theme"
                value={theme}
                onChange={v => {
                  const next = v as 'light' | 'dark'
                  setTheme(next)
                  document.documentElement.dataset.theme = next
                  document.documentElement.style.colorScheme = next
                }}
                ariaLabel={t('settings.theme.label')}
                options={[
                  { value: 'light', label: t('settings.theme.light') },
                  { value: 'dark', label: t('settings.theme.dark') },
                ]}
              />
            </div>

            <div className="setting-row">
              <label>{t('settings.language.label')}:</label>
              <Select
                value={language}
                onChange={v => {
                  const next = ((SUPPORTED_LANGUAGES as readonly string[]).includes(v) ? v : DEFAULT_LANGUAGE) as Language
                  setLanguage(next)
                  document.documentElement.lang = next
                  void i18n.changeLanguage(next)
                }}
                ariaLabel={t('settings.language.label')}
                options={SUPPORTED_LANGUAGES.map(lang => ({ value: lang, label: t(`settings.language.${lang}`) }))}
              />
            </div>

            <div className="setting-row">
              <label>{t('settings.bodyRetentionDays.label')}:</label>
              <Select<number>
                testId="settings-body-retention-days"
                value={bodyRetentionDays}
                onChange={v => {
                  // Restrict to the allowed enum values to keep the renderer
                  // payload identical to the schema expectations.
                  if (v === 30 || v === 90 || v === 180 || v === 365 || v === -1) {
                    setBodyRetentionDays(v)
                  }
                }}
                ariaLabel={t('settings.bodyRetentionDays.label')}
                options={[
                  { value: 30, label: t('settings.bodyRetentionDays.option30') },
                  { value: 90, label: t('settings.bodyRetentionDays.option90') },
                  { value: 180, label: t('settings.bodyRetentionDays.option180') },
                  { value: 365, label: t('settings.bodyRetentionDays.option365') },
                  { value: -1, label: t('settings.bodyRetentionDays.optionForever') },
                ]}
              />
            </div>
            <span className="hint">{t('settings.bodyRetentionDays.hint')}</span>

            <label className="setting-row setting-row-start">
              <input
                type="checkbox"
                checked={defaultMailApp}
                onChange={e => setDefaultMailApp(e.target.checked)}
              />
              {t('settings.general.defaultMailApp')}
            </label>
            <span className="hint">{t('settings.general.defaultMailAppHint')}</span>
          </section>
        )}

        {tab === 'productivity' && (
          <>
            <section className="form-section">
              <h3>{t('settings.productivity.title')}</h3>
              <p className="hint">{t('settings.productivity.hint')}</p>

              <label className="setting-row setting-row-start">
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  onChange={e => setNotificationsEnabled(e.target.checked)}
                />
                {t('settings.notifications.enabled')}
              </label>

              <label className="setting-row setting-row-start">
                <input
                  type="checkbox"
                  checked={imapIdleEnabled}
                  onChange={e => setImapIdleEnabled(e.target.checked)}
                />
                {t('settings.sync.imapIdle')}
              </label>

              <div className="setting-row">
                <label>{t('settings.sync.interval')}:</label>
                <Select<number>
                  value={syncIntervalMinutes}
                  onChange={v => setSyncIntervalMinutes(v || 1)}
                  ariaLabel={t('settings.sync.interval')}
                  options={[1, 2, 5, 10, 15, 30].map(v => ({ value: v, label: t('settings.sync.intervalMinutes', { count: v }) }))}
                />
              </div>

              <div className="setting-row">
                <label>{t('settings.sync.periodicSync')}:</label>
                <Select<number>
                  value={periodicSyncIntervalMin}
                  onChange={v => setPeriodicSyncIntervalMin(v || 5)}
                  ariaLabel={t('settings.sync.periodicSync')}
                  options={[1, 2, 5, 10, 15, 30, 60].map(v => ({ value: v, label: t('settings.sync.intervalMinutes', { count: v }) }))}
                />
              </div>
              <div className="setting-hint">{t('settings.sync.periodicSyncHint')}</div>

              <label className="setting-row setting-row-start">
                <input
                  type="checkbox"
                  checked={draftSyncEnabled}
                  onChange={e => setDraftSyncEnabled(e.target.checked)}
                />
                {t('settings.drafts.sync')}
              </label>

              <label className="setting-row setting-row-start">
                <input
                  type="checkbox"
                  checked={alwaysLoadImages}
                  onChange={e => setAlwaysLoadImages(e.target.checked)}
                />
                {t('settings.privacy.alwaysLoadImages')}
              </label>

              <label className="setting-row setting-row-start">
                <input
                  type="checkbox"
                  checked={gravatarInMail}
                  onChange={e => setGravatarInMail(e.target.checked)}
                />
                {t('settings.privacy.gravatarInMail')}
              </label>
              <span className="hint">{t('settings.privacy.gravatarInMailHint')}</span>

              <label className="setting-row setting-row-start">
                <input
                  type="checkbox"
                  checked={darkModeEmails}
                  onChange={e => setDarkModeEmails(e.target.checked)}
                />
                {t('settings.privacy.darkModeEmails')}
              </label>
              <span className="hint">{t('settings.privacy.darkModeEmailsHint')}</span>

              <label className="setting-row setting-row-start">
                <input
                  data-testid="settings-group-conversations"
                  type="checkbox"
                  checked={groupConversations}
                  onChange={e => setGroupConversations(e.target.checked)}
                />
                {t('settings.productivity.groupConversations')}
              </label>

              <div className="setting-row">
                <label>{t('settings.appearance.conversationOrder.label')}:</label>
                <Select
                  testId="settings-conversation-order"
                  value={conversationOrder}
                  onChange={v => {
                    if (v === 'newest-top' || v === 'oldest-top') setConversationOrder(v)
                  }}
                  ariaLabel={t('settings.appearance.conversationOrder.label')}
                  options={[
                    { value: 'newest-top', label: t('settings.appearance.conversationOrder.newestTop') },
                    { value: 'oldest-top', label: t('settings.appearance.conversationOrder.oldestTop') },
                  ]}
                />
              </div>

              <div className="setting-row">
                <label>{t('settings.productivity.sortMode')}:</label>
                <Select
                  testId="settings-sort-mode"
                  value={sortMode}
                  onChange={v => {
                    if (v === 'date' || v === 'from' || v === 'subject') setSortMode(v)
                  }}
                  ariaLabel={t('settings.productivity.sortMode')}
                  options={[
                    { value: 'date', label: t('mail.sort.date') },
                    { value: 'from', label: t('mail.sort.from') },
                    { value: 'subject', label: t('mail.sort.subject') },
                  ]}
                />
              </div>

              <div className="setting-row">
                <label>{t('settings.productivity.autoAdvance')}:</label>
                <Select
                  testId="settings-auto-advance"
                  value={autoAdvance}
                  onChange={v => {
                    if (v === 'off' || v === 'newer' || v === 'older' || v === 'back_to_list') setAutoAdvance(v)
                  }}
                  ariaLabel={t('settings.productivity.autoAdvance')}
                  options={[
                    { value: 'older', label: t('settings.productivity.autoAdvanceOlder') },
                    { value: 'newer', label: t('settings.productivity.autoAdvanceNewer') },
                    { value: 'back_to_list', label: t('settings.productivity.autoAdvanceBackToList') },
                    { value: 'off', label: t('settings.productivity.autoAdvanceOff') },
                  ]}
                />
              </div>

              <div className="setting-row">
                <label>{t('settings.hotkeys.preset')}:</label>
                <Select
                  value={hotkeysPreset}
                  onChange={v => setHotkeysPreset(v === 'outlook' ? 'outlook' : 'gmail')}
                  ariaLabel={t('settings.hotkeys.preset')}
                  options={[
                    { value: 'gmail', label: t('settings.hotkeys.gmail') },
                    { value: 'outlook', label: t('settings.hotkeys.outlook') },
                  ]}
                />
              </div>

              <div className="setting-row">
                <label>{t('settings.sendDelay.label')}:</label>
                <Select<number>
                  value={sendDelaySeconds}
                  onChange={v => setSendDelaySeconds(v || 0)}
                  ariaLabel={t('settings.sendDelay.label')}
                  options={[
                    { value: 0, label: t('settings.sendDelay.off') },
                    { value: 5, label: t('settings.sendDelay.seconds', { count: 5 }) },
                    { value: 10, label: t('settings.sendDelay.seconds', { count: 10 }) },
                    { value: 30, label: t('settings.sendDelay.seconds', { count: 30 }) },
                  ]}
                />
              </div>

              <div className="setting-row setting-row-start" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <label>{t('settings.productivity.trustedDomains')}:</label>
                <p className="hint" style={{ marginTop: 0 }}>{t('settings.productivity.trustedDomainsHint')}</p>
                <textarea
                  value={trustedDomains}
                  onChange={e => setTrustedDomains(e.target.value)}
                  rows={3}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                  placeholder={'example.com\ncompany.org'}
                />
              </div>
            </section>

            {/* Offline mode — per-folder settings are in the Folders tab */}
            <section className="form-section" style={{ marginTop: 16 }}>
              <h3><Download size={16} style={{ marginRight: 6, verticalAlign: -2 }} />{t('settings.offline.title')}</h3>
              <p className="hint">{t('settings.offline.perFolderHint')}</p>

              <div className="setting-row">
                <label>{t('settings.offline.maxSizeKB')}:</label>
                <input
                  type="number"
                  value={offlineMaxSizeKB}
                  min={0}
                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) setOfflineMaxSizeKB(v) }}
                  style={{ width: 80 }}
                />
                <span className="hint" style={{ marginLeft: 8 }}>{t('settings.offline.maxSizeHint')}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={offlineSyncing}
                  onClick={async () => {
                    setOfflineSyncing(true)
                    setOfflineSyncStatus('')
                    try {
                      await window.api.invoke('offline:syncNow')
                      setOfflineSyncStatus(t('settings.offline.syncStarted'))
                    } catch {
                      setOfflineSyncStatus(t('common.error'))
                    } finally {
                      setOfflineSyncing(false)
                    }
                  }}
                >
                  {offlineSyncing
                    ? <><Loader2 size={14} className="spin" /> {t('settings.offline.syncing')}</>
                    : <><Download size={14} /> {t('settings.offline.syncNow')}</>
                  }
                </button>
                {offlineSyncStatus && <span className="status-ok">{offlineSyncStatus}</span>}
              </div>
            </section>
          </>
        )}

        {tab === 'folders' && (
          <div className="settings-folders-tab">
            {accountSelector}

            <section className="form-section">
              <h3>{t('settings.folders.title')}</h3>
              <p className="hint">{t('settings.folders.hint')}</p>

              {accounts.length === 0 || typeof accountId !== 'number' ? (
                <div className="form-status-inline">{t('settings.folders.noAccount')}</div>
              ) : loadingFolders ? (
                <div className="form-status-inline">
                  <Loader2 size={14} className="spin" /> {t('settings.folders.loading')}
                </div>
              ) : foldersError ? (
                <div className="status-err">{t('settings.folders.loadFailed', { error: foldersError })}</div>
              ) : (
                <div className="folder-role-grid">
                  {selectableMailboxes.length === 0 && (
                    <div className="form-status-inline">{t('settings.folders.onlyInbox')}</div>
                  )}
                  {ROLE_LABELS.map(({ key, labelKey }) => (
                    <div className="folder-role-row" key={key}>
                      <label className="folder-role-label">{t(labelKey)}:</label>
                      <Select
                        testId={`settings-role-${key}`}
                        value={folderRoles[key] || ''}
                        onChange={val => {
                          if (val === '__create__') {
                            setCreateFolderDialog({ role: key, name: DEFAULT_ROLE_PATH[key] })
                          } else {
                            setRole(key, val)
                          }
                        }}
                        ariaLabel={t(labelKey)}
                        options={[
                          { value: '', label: autoRoles[key] ? t('settings.folders.auto', { path: autoRoles[key] }) : t('settings.folders.notSet') },
                          ...selectableMailboxes.map(m => ({ value: m.path, label: m.path })),
                          { value: '__create__', label: t('settings.folders.createNew') },
                        ]}
                      />
                      {creatingRole === key && <Loader2 size={14} className="spin" />}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {createFolderDialog && (
              <div className="modal-overlay" onClick={() => setCreateFolderDialog(null)}>
                <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                  <h3>{t('settings.folders.createNewTitle')}</h3>
                  <input
                    autoFocus
                    type="text"
                    value={createFolderDialog.name}
                    onChange={e => setCreateFolderDialog({ ...createFolderDialog, name: e.target.value })}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && createFolderDialog.name.trim()) {
                        void createRoleMailbox(createFolderDialog.role, createFolderDialog.name.trim())
                      } else if (e.key === 'Escape') {
                        setCreateFolderDialog(null)
                      }
                    }}
                    placeholder={t('settings.folders.folderNamePlaceholder')}
                    style={{ width: '100%' }}
                  />
                  {foldersError && <div className="status-err" style={{ marginTop: 8 }}>{foldersError}</div>}
                  <div className="modal-actions">
                    <button type="button" onClick={() => setCreateFolderDialog(null)}>
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={!createFolderDialog.name.trim() || creatingRole === createFolderDialog.role}
                      onClick={() => void createRoleMailbox(createFolderDialog.role, createFolderDialog.name.trim())}
                    >
                      {creatingRole === createFolderDialog.role
                        ? <><Loader2 size={14} className="spin" /> {t('settings.folders.creating')}</>
                        : t('common.ok')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {typeof accountId === 'number' && mailboxes.length > 0 && !loadingFolders && (
              <section className="form-section">
                <h3>{t('settings.folderPolicy.title')}</h3>
                <p className="hint">{t('settings.folderPolicy.hint')}</p>
                <div className={`folder-policy-list${mailboxes.length > 8 ? ' folder-policy-list-scroll' : ''}`}>
                  {mailboxes.map(m => {
                    const pref = getFolderPrefView(m)
                    return (
                      <div key={m.path} className="folder-policy-card">
                        <div className="folder-policy-head">
                          <div className="folder-policy-path">{m.path}</div>
                          {pref.role && <div className="hint folder-policy-role">{pref.role}</div>}
                        </div>

                        <div className="folder-policy-controls">
                          <label className="setting-row setting-row-start folder-policy-check">
                            <input
                              type="checkbox"
                              checked={pref.visible}
                              onChange={e => { void updateFolderPref(m.path, { visible: e.target.checked }) }}
                            />
                            {t('settings.folderPolicy.visible')}
                          </label>

                          {pref.visible ? (
                            <>
                              <label className="setting-row setting-row-start folder-policy-check">
                                <input
                                  type="checkbox"
                                  checked={pref.includeInBadges}
                                  onChange={e => { void updateFolderPref(m.path, { includeInBadges: e.target.checked }) }}
                                />
                                {t('settings.folderPolicy.badges')}
                              </label>

                              <div className="setting-row folder-policy-select">
                                <label>{t('settings.folderPolicy.headerSync')}:</label>
                                <Select
                                  value={pref.headerSyncMode}
                                  onChange={v => {
                                    void updateFolderPref(m.path, { headerSyncMode: v as FolderPreference['headerSyncMode'] })
                                  }}
                                  ariaLabel={t('settings.folderPolicy.headerSync')}
                                  options={[
                                    { value: 'full', label: t('settings.folderPolicy.syncFull') },
                                    { value: 'on_open', label: t('settings.folderPolicy.syncOnOpen') },
                                    { value: 'period', label: t('settings.folderPolicy.syncPeriod') },
                                  ]}
                                />
                              </div>

                              {pref.headerSyncMode === 'period' && (
                                <div className="setting-row folder-policy-select">
                                  <label>{t('settings.folderPolicy.days')}:</label>
                                  <input
                                    className="folder-policy-days-input"
                                    type="number"
                                    min={1}
                                    value={pref.headerSyncDays}
                                    onChange={e => {
                                      const v = Number(e.target.value)
                                      if (!Number.isFinite(v) || v < 1) return
                                      void updateFolderPref(m.path, { headerSyncDays: v })
                                    }}
                                  />
                                </div>
                              )}

                              <div className="setting-row folder-policy-select">
                                <label>{t('settings.folderPolicy.offline')}:</label>
                                <Select
                                  value={pref.offlineMode}
                                  onChange={v => {
                                    void updateFolderPref(m.path, { offlineMode: v as FolderPreference['offlineMode'] })
                                  }}
                                  ariaLabel={t('settings.folderPolicy.offline')}
                                  options={[
                                    { value: 'off', label: t('settings.folderPolicy.offlineOff') },
                                    { value: 'period', label: t('settings.folderPolicy.offlinePeriod') },
                                    { value: 'full', label: t('settings.folderPolicy.offlineFull') },
                                  ]}
                                />
                              </div>

                              {pref.offlineMode === 'period' && (
                                <div className="setting-row folder-policy-select">
                                  <label>{t('settings.folderPolicy.days')}:</label>
                                  <input
                                    className="folder-policy-days-input"
                                    type="number"
                                    min={1}
                                    value={pref.offlineDays}
                                    onChange={e => {
                                      const v = Number(e.target.value)
                                      if (!Number.isFinite(v) || v < 1) return
                                      void updateFolderPref(m.path, { offlineDays: v })
                                    }}
                                  />
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="folder-policy-hidden-note">
                              {t('settings.folderPolicy.hiddenNoSync')}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === 'identities' && (
          <>
            {accountSelector}

            {typeof accountId === 'number' && (
              <section className="form-section">
                <h3>{t('settings.identities.tabLabel')}</h3>
                <IdentitiesTab
                  identities={identities}
                  onChange={handleIdentitiesChange}
                  labels={{
                    tabLabel: t('settings.identities.tabLabel'),
                    empty: t('settings.identities.empty'),
                    add: t('settings.identities.add'),
                    edit: t('settings.identities.edit'),
                    delete: t('settings.identities.delete'),
                    setDefault: t('settings.identities.setDefault'),
                    defaultBadge: t('settings.identities.defaultBadge'),
                    displayNameLabel: t('settings.identities.displayNameLabel'),
                    emailLabel: t('settings.identities.emailLabel'),
                    signatureLabel: t('settings.identities.signatureLabel'),
                    defaultBccLabel: t('settings.identities.defaultBccLabel'),
                    cancel: t('common.cancel'),
                    save: t('common.save'),
                  }}
                />
                {identitiesSaveError && (
                  <p className="status-err" data-testid="settings-identities-save-error">
                    {t('settings.identities.saveError')}: {identitiesSaveError}
                  </p>
                )}
              </section>
            )}
          </>
        )}

        {tab === 'signature' && (
          <>
            {accountSelector}

            {typeof accountId === 'number' && (
              <section className="form-section">
                <h3>{t('settings.signature.title')}</h3>
                <p className="hint">{t('settings.signature.hint')}</p>
                <textarea
                  data-testid="settings-signature"
                  className="signature-textarea"
                  value={signature}
                  onChange={e => setSignature(e.target.value)}
                  placeholder={t('settings.signature.placeholder')}
                  rows={4}
                />
              </section>
            )}
          </>
        )}

        {tab === 'ai' && (
          <>
          <section className="form-section">
            <h3><Sparkles size={16} style={{ marginRight: 6, verticalAlign: -2 }} />{t('ai.settings.title')}</h3>
            <p className="hint">{t('ai.settings.hint')}</p>

            {/* State 1: Provider not selected — show selection buttons */}
            {!aiProvider && !savedAiProvider && (
              <div data-testid="settings-ai-provider">
                <p className="hint">{t('ai.settings.chooseProvider')}</p>
                <div className="ai-provider-buttons">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={async () => {
                      setAiConnectionStatus('checking')
                      setAiConnectionError('')
                      try {
                        // User click — bypass cache but join in-flight.
                        const result = await singleFlightInvoke<{ status: string; message?: string }>(
                          'ai:checkAuth',
                          ['subscription'],
                          { source: 'user' },
                        )
                        if (result.status === 'error') {
                          setAiConnectionStatus('error')
                          setAiConnectionError(result.message || 'CLI not found')
                          return
                        }
                      } catch (e) {
                        setAiConnectionStatus('error')
                        // Same reasoning as checkAiConnection: this is a probe,
                        // its output is diagnostic. Tag stripped (§2.127).
                        setAiConnectionError(stripErrorPresentation(String(e)))
                        return
                      }
                      setAiProvider('subscription')
                      setAiModel('claude-sonnet-4-5-20250929')
                      setAiConnectionStatus('')
                      setAiConnectionError('')
                    }}
                  >
                    <Sparkles size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
                    {t('ai.settings.providerSubscription')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setAiProvider('anthropic-api')
                      setAiModel('claude-sonnet-4-5-20250929')
                      setAiApiKey('')
                      setAiKeyMasked(false)
                      setAiConnectionStatus('')
                      setAiConnectionError('')
                    }}
                  >
                    {t('ai.settings.providerApi')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setAiProvider('openai-api')
                      setAiModel('gpt-4o-mini')
                      setAiApiKey('')
                      setAiKeyMasked(false)
                      setAiConnectionStatus('')
                      setAiConnectionError('')
                    }}
                  >
                    {t('ai.settings.providerOpenAI')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setAiProvider('gemini-api')
                      setAiModel('gemini-2.0-flash')
                      setAiApiKey('')
                      setAiKeyMasked(false)
                      setAiConnectionStatus('')
                      setAiConnectionError('')
                    }}
                  >
                    {t('ai.settings.providerGemini')}
                  </button>
                </div>
                {aiConnectionStatus === 'error' && (
                  <p className="status-err" style={{ marginTop: 8 }}>{aiConnectionError}</p>
                )}
              </div>
            )}

            {/* State 2: Provider selected but not yet saved — wizard setup */}
            {aiProvider && !savedAiProvider && (
              <>
                <div className="setting-row">
                  <label>{t('ai.settings.provider')}:</label>
                  <span className="ai-provider-label">
                    {aiProvider === 'subscription' ? t('ai.settings.providerSubscription')
                      : aiProvider === 'openai-api' ? t('ai.settings.providerOpenAI')
                      : aiProvider === 'gemini-api' ? t('ai.settings.providerGemini')
                      : t('ai.settings.providerApi')}
                  </span>
                  <button
                    type="button"
                    className="btn-link ai-back-link"
                    onClick={() => {
                      setAiProvider('')
                      setAiApiKey('')
                      setAiKeyMasked(false)
                      setAiOpenAiBaseUrl('')
                      setAiConnectionStatus('')
                      setAiConnectionError('')
                    }}
                  >
                    {t('ai.settings.back')}
                  </button>
                </div>

                {isApiProvider && (
                  <div className="setting-row">
                    <label>{t('ai.settings.apiKey')}:</label>
                    <input
                      data-testid="settings-ai-apikey"
                      type="password"
                      value={aiApiKey}
                      placeholder={aiProvider === 'openai-api' ? t('ai.settings.apiKeyPlaceholderOpenAI') : t('ai.settings.apiKeyPlaceholder')}
                      onChange={e => setAiApiKey(e.target.value)}
                      style={{ width: 260, fontFamily: 'monospace' }}
                    />
                  </div>
                )}

                {aiProvider === 'openai-api' && (
                  <>
                    <div className="setting-row">
                      <label>{t('ai.settings.openAiBaseUrl')}:</label>
                      <input
                        type="url"
                        value={aiOpenAiBaseUrl}
                        placeholder={t('ai.settings.openAiBaseUrlPlaceholder')}
                        onChange={e => setAiOpenAiBaseUrl(e.target.value)}
                        style={{ width: 300, fontFamily: 'monospace' }}
                      />
                      <span className="hint-inline">{t('ai.settings.openAiBaseUrlHint')}</span>
                    </div>
                    <div className="setting-row">
                      <label>{t('ai.settings.model')}:</label>
                      <input
                        type="text"
                        value={aiModel}
                        placeholder={t('ai.settings.customModelPlaceholder')}
                        onChange={e => setAiModel(e.target.value)}
                        style={{ width: 220, fontFamily: 'monospace' }}
                      />
                    </div>
                  </>
                )}

                {isApiProvider && (
                  <div className="setting-row">
                    <label>{t('ai.settings.proxyUrl')}:</label>
                    <input
                      type="url"
                      value={aiProxyUrl}
                      placeholder={t('ai.settings.proxyUrlPlaceholder')}
                      onChange={e => setAiProxyUrl(e.target.value)}
                      style={{ width: 300, fontFamily: 'monospace' }}
                    />
                    <span className="hint-inline">{t('ai.settings.proxyUrlHint')}</span>
                  </div>
                )}

                <div className="ai-check-row">
                  <button
                    type="button"
                    data-testid="settings-ai-check"
                    disabled={aiConnectionStatus === 'checking'}
                    onClick={checkAiConnection}
                  >
                    {aiConnectionStatus === 'checking'
                      ? <><Loader2 size={14} className="spin" /> {t('ai.settings.checkConnection')}</>
                      : t('ai.settings.checkConnection')
                    }
                  </button>
                  {aiConnectionStatus === 'ok' && (
                    <span className="status-ok">{t('ai.settings.connectionOk')}</span>
                  )}
                  {aiConnectionStatus === 'error' && (
                    <span className="status-err">{t('ai.settings.connectionFailed', { error: aiConnectionError })}</span>
                  )}
                </div>
              </>
            )}

            {/* State 3: Provider saved — locked view + settings */}
            {savedAiProvider && (
              <>
                <div className="setting-row">
                  <label>{t('ai.settings.provider')}:</label>
                  <span className="ai-provider-label">
                    {savedAiProvider === 'subscription' ? t('ai.settings.providerSubscription')
                      : savedAiProvider === 'openai-api' ? t('ai.settings.providerOpenAI')
                      : savedAiProvider === 'gemini-api' ? t('ai.settings.providerGemini')
                      : t('ai.settings.providerApi')}
                  </span>
                  <button
                    type="button"
                    className="btn-link ai-reset-link"
                    onClick={async () => {
                      if (!window.confirm(t('ai.settings.resetConfirm'))) return
                      try {
                        // §2.122 — the delete is ADDRESSED: it names the
                        // provider being reset, and it happens only for a
                        // provider that actually has a stored key. Calling the
                        // channel bare used to mean "delete all three"; it now
                        // fails zod validation in main, which is exactly why
                        // the argument cannot be left to chance here.
                        await deleteAiApiKeyForProvider(window.api.invoke, savedAiProvider)
                        // settings:save merges the payload into current settings
                        // server-side, so send ONLY the field we clear. Do NOT
                        // spread settings:get() — it carries main-only fields
                        // (e.g. mcpConnections) that the .strict()
                        // rendererWritableSettingsSchema rejects with
                        // { ok: false, reason: 'forbidden_field' }, which would
                        // silently no-op the disk write while the UI reset below
                        // fires anyway (provider-configured / key-missing skew).
                        const result = await window.api.invoke('settings:save', { aiProvider: undefined }) as { ok?: boolean; reason?: string }
                        if (result && result.ok === false) {
                          throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
                        }
                        setAiProvider('')
                        setSavedAiProvider('')
                        setAiApiKey('')
                        setAiKeyMasked(false)
                        setAiOpenAiBaseUrl('')
                        setAiConnectionStatus('')
                        setAiConnectionError('')
                      } catch (e) {
                        setAiConnectionStatus('error')
                        // "Reset provider" is a local settings write, not a
                        // probe — there is no diagnostic text worth showing,
                        // so this one takes the §2.127 vocabulary.
                        setAiConnectionError(t(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(e)]))
                      }
                    }}
                  >
                    {t('ai.settings.resetProvider')}
                  </button>
                </div>

                {isApiProvider && (
                  <div className="setting-row">
                    <label>{t('ai.settings.apiKey')}:</label>
                    <input
                      data-testid="settings-ai-apikey"
                      type="password"
                      value={aiKeyMasked ? '••••••••••••••••' : aiApiKey}
                      placeholder={savedAiProvider === 'openai-api' ? t('ai.settings.apiKeyPlaceholderOpenAI') : t('ai.settings.apiKeyPlaceholder')}
                      onFocus={() => {
                        if (aiKeyMasked) {
                          setAiKeyMasked(false)
                          setAiApiKey('')
                        }
                      }}
                      onChange={e => setAiApiKey(e.target.value)}
                      style={{ width: 260, fontFamily: 'monospace' }}
                    />
                  </div>
                )}

                {savedAiProvider === 'openai-api' && (
                  <div className="setting-row">
                    <label>{t('ai.settings.openAiBaseUrl')}:</label>
                    <input
                      type="url"
                      value={aiOpenAiBaseUrl}
                      placeholder={t('ai.settings.openAiBaseUrlPlaceholder')}
                      onChange={e => setAiOpenAiBaseUrl(e.target.value)}
                      style={{ width: 300, fontFamily: 'monospace' }}
                    />
                    <span className="hint-inline">{t('ai.settings.openAiBaseUrlHint')}</span>
                  </div>
                )}

                <div className="setting-row">
                  <label>{t('ai.settings.model')}:</label>
                  {savedAiProvider === 'openai-api' ? (
                    <input
                      data-testid="settings-ai-model"
                      type="text"
                      value={aiModel}
                      placeholder={t('ai.settings.customModelPlaceholder')}
                      onChange={e => setAiModel(e.target.value)}
                      style={{ width: 220, fontFamily: 'monospace' }}
                    />
                  ) : (
                  <Select
                    testId="settings-ai-model"
                    value={aiModel}
                    onChange={v => setAiModel(v)}
                    ariaLabel={t('ai.settings.model')}
                    options={aiModelOptions}
                  />
                  )}
                </div>

                <div className="setting-row">
                  <label>{t('ai.settings.sendKey')}:</label>
                  <Select
                    value={aiSendOnEnter ? 'enter' : 'ctrl-enter'}
                    onChange={v => setAiSendOnEnter(v === 'enter')}
                    ariaLabel={t('ai.settings.sendKey')}
                    options={[
                      { value: 'enter', label: t('ai.settings.sendKeyEnter') },
                      { value: 'ctrl-enter', label: t('ai.settings.sendKeyCtrlEnter') },
                    ]}
                  />
                </div>

                <div className="setting-row">
                  <label>{t('ai.settings.locale')}:</label>
                  <Select
                    value={aiLocale}
                    onChange={v => setAiLocale(v as 'auto' | 'ru' | 'en')}
                    ariaLabel={t('ai.settings.locale')}
                    options={[
                      { value: 'auto', label: t('ai.settings.localeAuto') },
                      { value: 'ru', label: t('ai.settings.localeRu') },
                      { value: 'en', label: t('ai.settings.localeEn') },
                    ]}
                  />
                </div>

                <div className="setting-row setting-row-checkbox">
                  <label>
                    <input
                      type="checkbox"
                      checked={aiShowSources}
                      onChange={e => setAiShowSources(e.target.checked)}
                    />{' '}
                    {t('ai.settings.showSources')}
                  </label>
                </div>

                {/* §3.10 P1: AI outbound egress policy picker. Drives whether
                    WebSearch / WebFetch / external MCP tools are stripped
                    from the toolset when email content is in scope. Default
                    'default-deny' matches the privacy-native invariant. */}
                <div className="setting-row" data-testid="settings-ai-egress-policy">
                  <label>{t('ai.egress.policy_label')}:</label>
                  <Select
                    value={aiEgressPolicy}
                    onChange={v => {
                      if (v === 'default-deny' || v === 'ask' || v === 'allow') setAiEgressPolicy(v)
                    }}
                    ariaLabel={t('ai.egress.policy_label')}
                    options={[
                      { value: 'default-deny', label: t('ai.egress.policy_deny') },
                      { value: 'ask', label: t('ai.egress.policy_ask') },
                      { value: 'allow', label: t('ai.egress.policy_allow') },
                    ]}
                  />
                  <span className="hint-inline">
                    {aiEgressPolicy === 'default-deny' && t('ai.egress.policy_deny_hint')}
                    {aiEgressPolicy === 'ask' && t('ai.egress.policy_ask_hint')}
                    {aiEgressPolicy === 'allow' && t('ai.egress.policy_allow_hint')}
                  </span>
                </div>
                {aiEgressPolicy === 'allow' && (
                  <div className="setting-row" data-testid="settings-ai-egress-warning">
                    <span className="status-err">{t('ai.egress.policy_allow_warning')}</span>
                  </div>
                )}

                <div className="setting-row">
                  <label>{t('ai.settings.dailyBudgetUsd')}:</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={aiDailyBudgetUsd}
                    onChange={e => setAiDailyBudgetUsd(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>

                <div className="setting-row">
                  <label>{t('ai.settings.monthlyBudgetUsd')}:</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={aiMonthlyBudgetUsd}
                    onChange={e => setAiMonthlyBudgetUsd(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>

                <div className="setting-row">
                  <label>{t('ai.settings.maxTurns')}:</label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    step={1}
                    value={aiMaxTurns}
                    onChange={e => setAiMaxTurns(Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 30))))}
                  />
                </div>

                {isApiProvider && (
                  <div className="setting-row">
                    <label>{t('ai.settings.maxBudgetPerRequest')}:</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={aiMaxBudgetPerRequest}
                      onChange={e => setAiMaxBudgetPerRequest(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    />
                  </div>
                )}

                <div className="setting-row">
                  <label>{t('ai.settings.proxyUrl')}:</label>
                  <input
                    type="url"
                    value={aiProxyUrl}
                    placeholder={t('ai.settings.proxyUrlPlaceholder')}
                    onChange={e => setAiProxyUrl(e.target.value)}
                    style={{ width: 300, fontFamily: 'monospace' }}
                  />
                  <span className="hint-inline">{t('ai.settings.proxyUrlHint')}</span>
                </div>

                <div className="ai-check-row">
                  <button
                    type="button"
                    data-testid="settings-ai-check"
                    disabled={aiConnectionStatus === 'checking'}
                    onClick={checkAiConnection}
                  >
                    {aiConnectionStatus === 'checking'
                      ? <><Loader2 size={14} className="spin" /> {t('ai.settings.checkConnection')}</>
                      : t('ai.settings.checkConnection')
                    }
                  </button>
                  {aiConnectionStatus === 'ok' && (
                    <span className="status-ok">{t('ai.settings.connectionOk')}</span>
                  )}
                  {aiConnectionStatus === 'error' && (
                    <span className="status-err">{t('ai.settings.connectionFailed', { error: aiConnectionError })}</span>
                  )}
                </div>
              </>
            )}
          </section>

          {/* §3.3 B2 Thread AI Summary — per-account opt-in. Default OFF. The
              toggle reads/writes the entry for the currently selected account
              in the aiThreadSummaryEnabled Record; the shared account selector
              scopes it when more than one account exists. */}
          <section className="form-section" data-testid="settings-ai-thread-summary">
            <h3>{t('ai.settings.threadSummary.title')}</h3>
            <p className="section-hint">{t('ai.settings.threadSummary.help')}</p>
            {accountSelector}
            <div className="setting-row setting-row-checkbox">
              <label>
                <input
                  type="checkbox"
                  data-testid="settings-ai-thread-summary-toggle"
                  disabled={typeof accountId !== 'number'}
                  checked={typeof accountId === 'number' && aiThreadSummaryEnabled[String(accountId)] === true}
                  onChange={e => {
                    if (typeof accountId !== 'number') return
                    const key = String(accountId)
                    const next = e.target.checked
                    setAiThreadSummaryEnabled(prev => ({ ...prev, [key]: next }))
                  }}
                />{' '}
                {t('ai.settings.threadSummary.label')}
              </label>
            </div>
          </section>

          {/* §3.3 B4 Instant Reply — per-account opt-in. Default OFF. Same
              account-scoped Record pattern as Thread Summary above. */}
          <section className="form-section" data-testid="settings-ai-instant-reply">
            <h3>{t('ai.settings.instantReply.title')}</h3>
            <p className="section-hint">{t('ai.settings.instantReply.help')}</p>
            {accountSelector}
            <div className="setting-row setting-row-checkbox">
              <label>
                <input
                  type="checkbox"
                  data-testid="settings-ai-instant-reply-toggle"
                  disabled={typeof accountId !== 'number'}
                  checked={typeof accountId === 'number' && aiInstantReplyEnabled[String(accountId)] === true}
                  onChange={e => {
                    if (typeof accountId !== 'number') return
                    const key = String(accountId)
                    const next = e.target.checked
                    setAiInstantReplyEnabled(prev => ({ ...prev, [key]: next }))
                  }}
                />{' '}
                {t('ai.settings.instantReply.label')}
              </label>
            </div>
          </section>

          <section className="form-section">
            <h3>{t('ai.settings.memory.title')}</h3>
            <p className="section-hint">{t('ai.settings.memory.hint')}</p>
            <textarea
              className="ai-memory-textarea"
              value={aiMemory}
              onChange={(e) => { setAiMemory(e.target.value); setAiMemoryDirty(true) }}
              placeholder={t('ai.settings.memory.placeholder')}
              rows={8}
              maxLength={4000}
            />
            <div className="ai-memory-footer">
              <span className="ai-memory-counter">{aiMemory.length} / 4000</span>
              <div className="ai-memory-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setAiMemory(''); setAiMemoryDirty(true) }}
                >
                  {t('ai.settings.memory.clear')}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!aiMemoryDirty}
                  onClick={async () => {
                    try {
                      await window.api.invoke('ai:memoryWrite', aiMemory)
                      setAiMemoryDirty(false)
                    } catch {
                      // AI memory save error — logged in main process via handleIpc
                    }
                  }}
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          </section>

          {/* MCP Server Export */}
          <section className="form-section">
            <h3>{t('mcpExport.title')}</h3>
            <p className="hint">{t('mcpExport.hint')}</p>

            <div className="setting-row">
              <label>
                <input
                  type="checkbox"
                  checked={mcpExportEnabled}
                  onChange={e => setMcpExportEnabled(e.target.checked)}
                />
                {t('mcpExport.enable')}
              </label>
            </div>

            {mcpExportEnabled && (
              <>
                <div className="setting-row">
                  <label>{t('mcpExport.port')}</label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={mcpExportPort}
                    onChange={e => setMcpExportPort(Number(e.target.value) || 23847)}
                    style={{ width: 80 }}
                  />
                </div>

                <div className="setting-row" style={{ gap: 8, alignItems: 'center' }}>
                  <label>{t('mcpExport.status')}</label>
                  <span style={{ color: mcpExportStatus === 'running' ? '#22c55e' : 'var(--muted)' }}>
                    {mcpExportStatus === 'running' ? `● ${t('mcpExport.running')}` : `○ ${t('mcpExport.stopped')}`}
                  </span>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={async () => {
                      try {
                        if (mcpExportStatus === 'running') {
                          await window.api.invoke('mcpExport:stop')
                          setMcpExportStatus('stopped')
                          setMcpExportToken('')
                        } else {
                          const res = await window.api.invoke('mcpExport:start', mcpExportPort, mcpExportWhitelist.length > 0 ? mcpExportWhitelist : undefined) as { token?: string }
                          setMcpExportStatus('running')
                          if (res?.token) setMcpExportToken(res.token)
                        }
                      } catch {
                        setMcpExportStatus('error')
                      }
                    }}
                  >
                    {mcpExportStatus === 'running' ? t('mcpExport.stop') : t('mcpExport.start')}
                  </button>
                </div>

                {mcpExportStatus === 'running' && mcpExportToken && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="setting-row" style={{ gap: 8, alignItems: 'center' }}>
                      <label>{t('mcpExport.url')}</label>
                      <code style={{ fontSize: 12, opacity: 0.8 }}>http://localhost:{mcpExportPort}/mcp</code>
                    </div>
                    <div className="setting-row" style={{ gap: 8, alignItems: 'center' }}>
                      <label>{t('mcpExport.token')}</label>
                      <code style={{ fontSize: 12, opacity: 0.8 }}>{mcpExportToken.slice(0, 8)}{'•'.repeat(8)}</code>
                    </div>
                    <div className="setting-row" style={{ gap: 8, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => {
                          const config = JSON.stringify({
                            url: `http://localhost:${mcpExportPort}/mcp`,
                            headers: { Authorization: `Bearer ${mcpExportToken}` },
                          }, null, 2)
                          void navigator.clipboard.writeText(config)
                        }}
                      >
                        {t('mcpExport.copyConfig')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {/* MCP Connections (external servers) */}
          <section className="form-section">
            <h3>{t('mcpClient.title')}</h3>
            <p className="hint">{t('mcpClient.hint')}</p>

            {/*
              §3.10 P0: stdio MCP can only be enabled from main via a native
              warning dialog. The renderer-side button triggers
              `mcp:requestStdioEnable`, which pops the dialog and (on
              confirmation) persists the approval. `mcpEnableStdio` is not
              writable from renderer — any attempt to include it in a
              `settings:save` payload is rejected with
              `{ ok: false, reason: 'forbidden_field' }`.
            */}
            <div className="setting-row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <strong style={{ display: 'block' }}>{t('mcpClient.enableStdio')}</strong>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  {mcpEnableStdio
                    ? t('mcpClient.stdioEnabled')
                    : t('mcpClient.stdioWarning')}
                </div>
              </div>
              {!mcpEnableStdio && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={async () => {
                    try {
                      const res = await window.api.invoke('mcp:requestStdioEnable') as { ok: boolean; source?: string; reason?: string }
                      if (res.ok) setMcpEnableStdio(true)
                    } catch (err) {
                      captureException(err, { source: 'Settings.mcpRequestStdioEnable' })
                    }
                  }}
                >
                  {t('mcpClient.requestStdioEnable')}
                </button>
              )}
            </div>

            {mcpConnections.map(conn => {
              const st = mcpStatuses[conn.id]
              const statusColor = st?.status === 'connected' ? '#22c55e' : st?.status === 'error' ? '#ef4444' : 'var(--muted)'
              const statusLabel = st?.status === 'connected' ? t('mcpClient.connected') : st?.status === 'connecting' ? t('mcpClient.connecting') : st?.status === 'error' ? t('mcpClient.error') : t('mcpClient.disconnected')
              // §3.10 P0: stdio connections without a non-null `approvedSource`
              // cannot be connected until the user approves them via the
              // per-connection native dialog. Unapproved stdio connections
              // still render so the user can review and either approve or
              // delete — not hiding them by design.
              const needsApproval = conn.transport === 'stdio' && (!conn.approvedSource || conn.approvedSource === null)
              return (
                <div key={conn.id} className="setting-row" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ flex: 1 }}>
                    <strong>{conn.name}</strong>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      {conn.transport === 'sse' ? `SSE · ${conn.url ?? ''}` : `stdio · ${conn.command ?? ''} ${(conn.args ?? []).join(' ')}`}
                    </div>
                    {conn.transport === 'stdio' && (
                      <div style={{ fontSize: 11, marginTop: 2 }}>
                        {needsApproval
                          ? <span style={{ color: '#f59e0b' }}>⚠ {t('mcpClient.needsApproval')}</span>
                          : <span style={{ color: '#22c55e' }}>✓ {t('mcpClient.approved')}</span>}
                      </div>
                    )}
                  </div>
                  <span style={{ color: statusColor, fontSize: 12 }}>
                    {st?.status === 'connected' ? '●' : st?.status === 'error' ? '●' : '○'} {statusLabel}
                    {st?.status === 'connected' && st.toolCount > 0 && ` (${st.toolCount})`}
                  </span>
                  {needsApproval && (
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      onClick={async () => {
                        try {
                          const res = await window.api.invoke('mcp:approveStdioConnection', conn.id) as { ok: boolean; source?: string }
                          if (res.ok) {
                            setMcpConnections(prev => prev.map(c => c.id === conn.id ? { ...c, approvedSource: (res.source as 'env' | 'native-confirm') ?? 'native-confirm' } : c))
                          }
                        } catch (err) {
                          captureException(err, { source: 'Settings.mcpApproveConnection', connId: conn.id })
                        }
                      }}
                    >
                      {t('mcpClient.approve')}
                    </button>
                  )}
                  {!needsApproval && (
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      onClick={async () => {
                        try {
                          if (st?.status === 'connected') {
                            await window.api.invoke('mcp:disconnect', conn.id)
                          } else {
                            await window.api.invoke('mcp:connect', conn.id)
                          }
                          const statuses = await window.api.invoke('mcp:status') as Record<string, { status: string; error?: string; toolCount: number }>
                          setMcpStatuses(statuses)
                        } catch (err) {
                          captureException(err, { source: 'Settings.mcpConnectToggle', connId: conn.id })
                        }
                      }}
                    >
                      {st?.status === 'connected' ? t('mcpClient.disconnect') : t('mcpClient.connect')}
                    </button>
                  )}
                  <button
                    type="button"
                    style={{ fontSize: 12, padding: '2px 8px', background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', borderRadius: 4, color: 'var(--fg)' }}
                    onClick={() => {
                      void removeSavedMcpConnection(conn.id).catch(() => {})
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}

            {!mcpAddingNew && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setMcpAddingNew(true)
                  setMcpEditId(null)
                  setMcpForm({ name: '', transport: 'sse', url: '', command: '', args: '', env: '', autoConnect: true })
                  setMcpTestResult(null)
                }}
              >
                {t('mcpClient.addConnection')}
              </button>
            )}

            {mcpAddingNew && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 8 }}>
                <div className="setting-row">
                  <label>{t('mcpClient.name')}</label>
                  <input
                    type="text"
                    value={mcpForm.name}
                    onChange={e => setMcpForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Obsidian, Calendar, etc."
                    style={{ flex: 1 }}
                  />
                </div>
                <div className="setting-row">
                  <label>{t('mcpClient.transport')}</label>
                  <Select
                    value={mcpForm.transport}
                    onChange={v => setMcpForm(f => ({ ...f, transport: v as 'sse' | 'stdio' }))}
                    ariaLabel={t('mcpClient.transport')}
                    options={[
                      { value: 'sse', label: 'SSE / HTTP' },
                      { value: 'stdio', label: 'stdio' },
                    ]}
                  />
                </div>
                {mcpForm.transport === 'sse' && (
                  <div className="setting-row">
                    <label>URL</label>
                    <input
                      type="text"
                      value={mcpForm.url}
                      onChange={e => setMcpForm(f => ({ ...f, url: e.target.value }))}
                      placeholder="http://localhost:27182"
                      style={{ flex: 1 }}
                    />
                  </div>
                )}
                {mcpForm.transport === 'stdio' && (
                  <>
                    <div className="setting-row">
                      <label>{t('mcpClient.command')}</label>
                      <input
                        type="text"
                        value={mcpForm.command}
                        onChange={e => setMcpForm(f => ({ ...f, command: e.target.value }))}
                        placeholder="npx"
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div className="setting-row">
                      <label>{t('mcpClient.args')}</label>
                      <input
                        type="text"
                        value={mcpForm.args}
                        onChange={e => setMcpForm(f => ({ ...f, args: e.target.value }))}
                        placeholder="-y @some/mcp-server"
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
                      <label>{t('mcpClient.env')}</label>
                      <textarea
                        value={mcpForm.env}
                        onChange={e => setMcpForm(f => ({ ...f, env: e.target.value }))}
                        placeholder={'KEY=value\nANOTHER_KEY=value'}
                        rows={3}
                        style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                      />
                    </div>
                  </>
                )}
                <div className="setting-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={mcpForm.autoConnect}
                      onChange={e => setMcpForm(f => ({ ...f, autoConnect: e.target.checked }))}
                    />
                    {t('mcpClient.autoConnect')}
                  </label>
                </div>
                {mcpTestResult && (
                  <p style={{ fontSize: 12, color: mcpTestResult.success ? '#22c55e' : '#ef4444' }}>{mcpTestResult.message}</p>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={mcpTesting}
                    onClick={async () => {
                      const config = buildMcpConfig()
                      setMcpTesting(true)
                      setMcpTestResult(null)
                      try {
                        await persistMcpConnection(config)
                        // MEDIUM-1 fix: the IPC result is a structured
                        // `{ ok: true | false, ... }` envelope. Do NOT
                        // treat a refused connection (approval gate /
                        // env_disabled) as a success by printing
                        // `toolCount=undefined tools`. Branch on `.ok`
                        // and surface a localized failure message.
                        const res = (await window.api.invoke('mcp:testConnection', config.id)) as McpTestConnectionResult
                        if (res.ok) {
                          setMcpTestResult({ message: t('mcpClient.testSuccess', { count: res.toolCount }), success: true })
                        } else {
                          setMcpTestResult({ message: formatMcpTestError(res.reason), success: false })
                        }
                      } catch (err) {
                        // Connection test: `persistMcpConnection` throws an
                        // already-localized message, and an MCP server's own
                        // refusal is the diagnostic the button exists for.
                        // Keep both; strip only the §2.127 tag.
                        setMcpTestResult({ message: stripErrorPresentation(err instanceof Error ? err.message : String(err)), success: false })
                      }
                      setMcpTesting(false)
                    }}
                  >
                    {mcpTesting ? '...' : t('mcpClient.testConnection')}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!mcpForm.name || (mcpForm.transport === 'sse' ? !mcpForm.url : !mcpForm.command)}
                    onClick={async () => {
                      const config = buildMcpConfig()
                      try {
                        await persistMcpConnection(config)
                        setMcpAddingNew(false)
                        setMcpTestResult(null)
                      } catch (err) {
                        // HIGH-2 fix: persistMcpConnection now throws a
                        // localized Error when main rejects the save
                        // (e.g. forbidden_env_key). Prior to the fix the
                        // `await` resolved with `{ ok: false }` and the
                        // UI optimistically added a phantom connection.
                        // That localized message must survive verbatim, so this
                        // site strips the §2.127 tag rather than replacing the
                        // text with the vocabulary.
                        setMcpTestResult({ message: stripErrorPresentation(err instanceof Error ? err.message : String(err)), success: false })
                      }
                    }}
                  >
                    {t('mcpClient.save')}
                  </button>
                  <button
                    type="button"
                    style={{ background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', borderRadius: 4, padding: '4px 12px', color: 'var(--fg)' }}
                    onClick={() => { setMcpAddingNew(false); setMcpTestResult(null) }}
                  >
                    {t('mcpClient.cancel')}
                  </button>
                </div>
              </div>
            )}
          </section>

          <AiPrivacyPanel />

          </>
        )}

        {tab === 'templates' && (
          <section className="settings-section">
            <h2>{t('settings.templates.title')}</h2>
            <p className="settings-hint">{t('settings.templates.hint')}</p>
            <p className="settings-hint">{t('settings.templates.variables')}</p>

            {/* Create/edit form */}
            <div className="settings-template-form">
              <label>{t('settings.templates.name')}</label>
              <input
                type="text"
                value={templateForm.name}
                onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))}
                maxLength={200}
                placeholder={t('settings.templates.namePlaceholder')}
              />
              <label>{t('settings.templates.subject')}</label>
              <input
                type="text"
                value={templateForm.subject}
                onChange={e => setTemplateForm(f => ({ ...f, subject: e.target.value }))}
                maxLength={500}
                placeholder={t('settings.templates.subjectPlaceholder')}
              />
              <label>{t('settings.templates.body')}</label>
              <textarea
                value={templateForm.body}
                onChange={e => setTemplateForm(f => ({ ...f, body: e.target.value }))}
                rows={5}
                maxLength={50000}
                placeholder={t('settings.templates.bodyPlaceholder')}
              />
              <label>{t('settings.templates.shortcut')}</label>
              <input
                type="text"
                value={templateForm.shortcut}
                onChange={e => setTemplateForm(f => ({ ...f, shortcut: e.target.value }))}
                maxLength={50}
                placeholder="/hello"
              />
              <div className="settings-template-form-actions">
                {editingTemplate ? (
                  <>
                    <button
                      className="btn-primary"
                      disabled={!templateForm.name.trim()}
                      onClick={async () => {
                        try {
                          await window.api.invoke('templates:update', editingTemplate.id, {
                            name: templateForm.name.trim(),
                            subject: templateForm.subject,
                            body: templateForm.body,
                            shortcut: templateForm.shortcut || null,
                          })
                          setEditingTemplate(null)
                          setTemplateForm({ name: '', subject: '', body: '', shortcut: '' })
                          void loadTemplates()
                        } catch { /* IPC error — ignore, form stays open */ }
                      }}
                    >
                      <Save size={14} /> {t('settings.templates.save')}
                    </button>
                    <button onClick={() => {
                      setEditingTemplate(null)
                      setTemplateForm({ name: '', subject: '', body: '', shortcut: '' })
                    }}>
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    className="btn-primary"
                    disabled={!templateForm.name.trim()}
                    onClick={async () => {
                      try {
                        await window.api.invoke('templates:create', {
                          name: templateForm.name.trim(),
                          subject: templateForm.subject,
                          body: templateForm.body,
                          shortcut: templateForm.shortcut || undefined,
                        })
                        setTemplateForm({ name: '', subject: '', body: '', shortcut: '' })
                        void loadTemplates()
                      } catch { /* IPC error — ignore */ }
                    }}
                  >
                    <Plus size={14} /> {t('settings.templates.add')}
                  </button>
                )}
              </div>
            </div>

            {/* Template list */}
            {templates.length === 0 ? (
              <p className="settings-hint">{t('settings.templates.empty')}</p>
            ) : (
              <div className="settings-template-list">
                {templates.map(tmpl => (
                  <div key={tmpl.id} className="settings-template-item">
                    <div className="settings-template-item-info">
                      <span className="settings-template-item-name">{tmpl.name}</span>
                      {tmpl.shortcut && <span className="settings-template-item-shortcut">{tmpl.shortcut}</span>}
                    </div>
                    <div className="settings-template-item-actions">
                      <button
                        title={t('settings.templates.edit')}
                        onClick={() => {
                          setEditingTemplate(tmpl)
                          setTemplateForm({ name: tmpl.name, subject: tmpl.subject, body: tmpl.body, shortcut: tmpl.shortcut ?? '' })
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        title={t('settings.templates.delete')}
                        onClick={async () => {
                          try {
                            await window.api.invoke('templates:delete', tmpl.id)
                            void loadTemplates()
                          } catch { /* IPC error — ignore */ }
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'rules' && (
          <>
            <section className="form-section">
              <h3>{t('settings.rules.title')}</h3>
              <p className="hint">{t('settings.rules.hint')}</p>

              {/* Rule list */}
              {mailRules.length === 0 && <p className="hint">{t('settings.rules.empty')}</p>}
              {mailRules.map(rule => (
                <div key={rule.id} className="rule-item" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--mailcopilot-border)' }}>
                  <input type="checkbox" checked={rule.enabled} onChange={async () => {
                    await window.api.invoke('rules:update', rule.id, { enabled: !rule.enabled })
                    void loadMailRules()
                  }} />
                  <span style={{ flex: 1 }}>{rule.name}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {rule.conditions.length} {t('settings.rules.conditions').toLowerCase()}, {rule.actions.length} {t('settings.rules.actions').toLowerCase()}
                  </span>
                  <button className="btn-icon" title="Edit" onClick={() => setEditingRule(rule)}>
                    <Pencil size={14} />
                  </button>
                  <button className="btn-icon" title="Delete" onClick={async () => {
                    if (window.confirm(t('settings.rules.deleteConfirm'))) {
                      await window.api.invoke('rules:delete', rule.id)
                      void loadMailRules()
                    }
                  }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              <button className="btn" style={{ marginTop: 12 }} onClick={() => setEditingRule({
                id: '',
                accountId: null,
                name: '',
                enabled: true,
                priority: mailRules.length,
                conditions: [{ field: 'from', op: 'contains', value: '' }],
                actions: [{ type: 'archive' }],
                stopProcessing: false,
              })}>
                + {t('settings.rules.add')}
              </button>
            </section>

            {/* Rule editor modal */}
            {editingRule && (
              <div className="modal-overlay" onClick={() => { setEditingRule(null); setTestResults(null); setApplyToExisting(false) }}>
                <div className="modal-dialog" style={{ maxWidth: 560, padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
                <div style={{ maxHeight: '80vh', overflowY: 'auto', padding: 24 }}>
                  <h3>{editingRule.id ? editingRule.name : t('settings.rules.add')}</h3>

                  <label className="setting-row">
                    {t('settings.rules.name')}:
                    <input type="text" value={editingRule.name} onChange={e => setEditingRule({ ...editingRule, name: e.target.value })} style={{ flex: 1, marginLeft: 8 }} />
                  </label>

                  <label className="setting-row">
                    {t('settings.rules.account')}:
                    <Select
                      value={editingRule.accountId ?? ''}
                      onChange={v => setEditingRule({ ...editingRule, accountId: v || null })}
                      style={{ marginLeft: 8, flex: 1 }}
                      ariaLabel={t('settings.rules.account')}
                      options={[
                        { value: '', label: t('settings.rules.allAccounts') },
                        ...accounts.map(a => ({ value: String(a.id), label: a.name || a.email || a.imap.user || String(a.id) })),
                      ]}
                    />
                  </label>

                  <h4 style={{ marginTop: 16 }}>{t('settings.rules.conditions')}</h4>
                  {editingRule.conditions.map((cond, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                      <Select
                        value={cond.field}
                        onChange={v => {
                          const c = [...editingRule.conditions]
                          c[i] = { ...c[i]!, field: v }
                          setEditingRule({ ...editingRule, conditions: c })
                          setTestResults(null)
                        }}
                        ariaLabel={t('settings.rules.conditionField')}
                        options={['from', 'to', 'cc', 'subject', 'has_attachment'].map(f => ({ value: f, label: t(`settings.rules.field.${f}`) }))}
                      />
                      {cond.field !== 'has_attachment' && (
                        <>
                          <Select
                            value={cond.op}
                            onChange={v => {
                              const c = [...editingRule.conditions]
                              c[i] = { ...c[i]!, op: v }
                              setEditingRule({ ...editingRule, conditions: c })
                              setTestResults(null)
                            }}
                            ariaLabel={t('settings.rules.conditionOp')}
                            options={['contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'matches_regex'].map(o => ({ value: o, label: t(`settings.rules.op.${o}`) }))}
                          />
                          <input type="text" value={cond.value} onChange={e => {
                            const c = [...editingRule.conditions]
                            c[i] = { ...c[i]!, value: e.target.value }
                            setEditingRule({ ...editingRule, conditions: c })
                            setTestResults(null)
                          }} style={{ flex: 1 }} />
                        </>
                      )}
                      <button className="btn-icon" onClick={() => {
                        const c = editingRule.conditions.filter((_, j) => j !== i)
                        setEditingRule({ ...editingRule, conditions: c })
                        setTestResults(null)
                      }}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button className="btn-sm" onClick={() => {
                    setEditingRule({
                      ...editingRule,
                      conditions: [...editingRule.conditions, { field: 'from', op: 'contains', value: '' }],
                    })
                    setTestResults(null)
                  }}>+ {t('settings.rules.addCondition')}</button>
                  <p className="hint" style={{ marginTop: 4, fontSize: 12 }}>
                    {t('settings.rules.andHint')}
                  </p>

                  <h4 style={{ marginTop: 16 }}>{t('settings.rules.actions')}</h4>
                  {editingRule.actions.map((act, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                      <Select
                        value={act.type}
                        onChange={v => {
                          const a = [...editingRule.actions]
                          a[i] = { type: v }
                          setEditingRule({ ...editingRule, actions: a })
                        }}
                        ariaLabel={t('settings.rules.actionType')}
                        options={['move', 'archive', 'trash', 'mark_read', 'mark_starred', 'mark_spam'].map(t2 => ({ value: t2, label: t(`settings.rules.action.${t2}`) }))}
                      />
                      {act.type === 'move' && (
                        <input type="text" placeholder={t('settings.rules.folderPlaceholder')} value={act.folder || ''} onChange={e => {
                          const a = [...editingRule.actions]
                          a[i] = { ...a[i]!, folder: e.target.value }
                          setEditingRule({ ...editingRule, actions: a })
                        }} style={{ flex: 1 }} />
                      )}
                      <button className="btn-icon" onClick={() => {
                        const a = editingRule.actions.filter((_, j) => j !== i)
                        setEditingRule({ ...editingRule, actions: a })
                      }}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button className="btn-sm" onClick={() => setEditingRule({
                    ...editingRule,
                    actions: [...editingRule.actions, { type: 'archive' }],
                  })}>+ {t('settings.rules.addAction')}</button>

                  <label className="setting-row" style={{ marginTop: 16 }}>
                    <input type="checkbox" checked={editingRule.stopProcessing} onChange={e => setEditingRule({ ...editingRule, stopProcessing: e.target.checked })} />
                    {t('settings.rules.stopProcessing')}
                  </label>

                  <label className="setting-row" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={applyToExisting} onChange={e => setApplyToExisting(e.target.checked)} />
                    {t('settings.rules.applyToExisting')}
                  </label>

                  <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
                    <button className="btn" onClick={() => { setEditingRule(null); setTestResults(null); setApplyToExisting(false) }}>{t('common.cancel')}</button>
                    <button className="btn" onClick={async () => {
                      try {
                        const results = await window.api.invoke('rules:test', {
                          conditions: JSON.stringify(editingRule.conditions),
                          accountId: editingRule.accountId,
                        }) as Array<{ uid: number; subject: string; from: string }>
                        setTestResults(results)
                      } catch { setTestResults([]) }
                    }} disabled={editingRule.conditions.length === 0 || editingRule.conditions.some(c => c.field !== 'has_attachment' && !c.value.trim())}>
                      {t('settings.rules.test')}
                    </button>
                    <button className="btn btn-primary" onClick={async () => {
                      try {
                        const data = {
                          name: editingRule.name,
                          conditions: JSON.stringify(editingRule.conditions),
                          actions: JSON.stringify(editingRule.actions),
                          priority: editingRule.priority,
                          stopProcessing: editingRule.stopProcessing,
                          accountId: editingRule.accountId,
                        }
                        let savedId = editingRule.id
                        if (editingRule.id) {
                          await window.api.invoke('rules:update', editingRule.id, data)
                        } else {
                          const created = await window.api.invoke('rules:create', data) as { id?: string } | undefined
                          if (created?.id) savedId = created.id
                        }
                        if (applyToExisting && savedId) {
                          await window.api.invoke('rules:applyToFolder', savedId)
                        }
                        setEditingRule(null)
                        setTestResults(null)
                        setApplyToExisting(false)
                        void loadMailRules()
                      } catch (err) {
                        // Verdict, never the value — same reason as
                        // `saveAvatarSettings` above. `rules:applyToFolder`
                        // runs the rule against a live mailbox, so a failure
                        // here can carry the server's own words.
                        console.error('Failed to save rule:', decodeErrorPresentation(err))
                        window.alert(t('settings.rules.saveFailed'))
                      }
                    }} disabled={!editingRule.name.trim()}>
                      {t('common.save')}
                    </button>
                  </div>

                  {testResults !== null && (
                    <div style={{ marginTop: 8, fontSize: 12, maxHeight: 150, overflow: 'auto', border: '1px solid var(--mailcopilot-border)', borderRadius: 6, padding: 8 }}>
                      {testResults.length === 0
                        ? <span style={{ color: 'var(--muted)' }}>{t('settings.rules.testNoMatch')}</span>
                        : <>
                            <strong>{t('settings.rules.testMatches', { count: testResults.length })}</strong>
                            {testResults.slice(0, 20).map((r, i) => (
                              <div key={i} style={{ padding: '2px 0' }}>
                                <span style={{ color: 'var(--muted)' }}>{r.from}</span>: {r.subject}
                              </div>
                            ))}
                          </>
                      }
                    </div>
                  )}
                </div>
                </div>
              </div>
            )}

            {/* AI Rules section — only shown when an AI provider is configured */}
            {(savedAiProvider || aiProvider) && (
              <>
              <hr style={{ margin: '24px 0', borderColor: 'var(--border)' }} />
              <section className="form-section">
                <h3><Sparkles size={16} style={{ marginRight: 6, verticalAlign: -2 }} />{t('settings.rules.aiSection')}</h3>
                <p className="hint">{t('settings.aiRules.hint')}</p>

                {aiRuleError && (
                  <p style={{ fontSize: 12, color: '#ef4444', margin: '4px 0' }} role="alert">{aiRuleError}</p>
                )}

                {aiRules.length === 0 && <p className="hint">{t('settings.aiRules.empty')}</p>}
                {aiRules.map(rule => (
                  <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--mailcopilot-border)' }}>
                    <input type="checkbox" checked={rule.enabled} onChange={async () => {
                      try {
                        await window.api.invoke('aiRules:update', rule.id, { enabled: !rule.enabled })
                        setAiRuleError(null)
                      } catch (err) {
                        // §2.39: enabling past the per-account cap is rejected by
                        // the storage layer with a machine-detectable code.
                        const msg = err instanceof Error ? err.message : String(err)
                        if (msg.includes('AI_RULE_ENABLED_LIMIT')) {
                          setAiRuleError(t('settings.aiRules.enabledLimit', { max: AI_RULE_MAX_ENABLED_PER_ACCOUNT }))
                        } else {
                          setAiRuleError(t('settings.rules.saveFailed'))
                        }
                      }
                      void loadAiRules()
                    }} />
                    <span style={{ flex: 1 }}>{rule.name}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>{t('settings.aiRules.budgetPerDay', { amount: rule.budgetPerDayUsd.toFixed(2) })}</span>
                    <button className="btn-icon" onClick={() => { setAiRuleError(null); setEditingAiRule(rule) }}><Pencil size={14} /></button>
                    <button className="btn-icon" onClick={async () => {
                      if (window.confirm(t('settings.aiRules.deleteConfirm'))) {
                        await window.api.invoke('aiRules:delete', rule.id)
                        void loadAiRules()
                      }
                    }}><Trash2 size={14} /></button>
                  </div>
                ))}

                <button className="btn" style={{ marginTop: 12 }} onClick={() => { setAiRuleError(null); setEditingAiRule({
                  id: '', accountId: null, name: '', enabled: false,
                  prompt: '', allowedActions: ['archive', 'move', 'mark_read'], budgetPerDayUsd: 0.50,
                }) }}>
                  + {t('settings.aiRules.add')}
                </button>

                {/* AI Rule log */}
                {aiRuleLog.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h4>{t('settings.aiRules.log')}</h4>
                    <div style={{ fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
                      {aiRuleLog.map(entry => (
                        <div key={entry.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--mailcopilot-border)' }}>
                          <span style={{ color: 'var(--muted)' }}>{new Date(entry.createdAt).toLocaleString()}</span>{' '}
                          uid:{entry.uid} in {entry.folder} → {entry.actionTaken}
                          {entry.reasoning && <span style={{ color: 'var(--muted)' }}> — {entry.reasoning}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {aiRuleLog.length === 0 && aiRules.length > 0 && (
                  <p className="hint" style={{ marginTop: 8 }}>{t('settings.aiRules.logEmpty')}</p>
                )}
              </section>
              </>
            )}

            {/* AI Rule editor modal */}
            {editingAiRule && (
              <div className="modal-overlay" onClick={() => { setAiRuleError(null); setEditingAiRule(null) }}>
                <div className="modal-dialog" style={{ maxWidth: 560, padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
                <div style={{ maxHeight: '80vh', overflowY: 'auto', padding: 24 }}>
                  <h3>{editingAiRule.id ? editingAiRule.name : t('settings.aiRules.add')}</h3>

                  <label className="setting-row">
                    {t('settings.aiRules.name')}:
                    <input type="text" value={editingAiRule.name} onChange={e => setEditingAiRule({ ...editingAiRule, name: e.target.value })} style={{ flex: 1, marginLeft: 8 }} />
                  </label>

                  <label className="setting-row">
                    {t('settings.rules.account')}:
                    <Select
                      value={editingAiRule.accountId ?? ''}
                      onChange={v => setEditingAiRule({ ...editingAiRule, accountId: v || null })}
                      style={{ marginLeft: 8, flex: 1 }}
                      ariaLabel={t('settings.rules.account')}
                      options={[
                        { value: '', label: t('settings.rules.allAccounts') },
                        ...accounts.map(a => ({ value: String(a.id), label: a.name || a.email || a.imap.user || String(a.id) })),
                      ]}
                    />
                  </label>

                  <label style={{ display: 'block', marginTop: 12 }}>
                    {t('settings.aiRules.prompt')}:
                    <textarea
                      value={editingAiRule.prompt}
                      onChange={e => setEditingAiRule({ ...editingAiRule, prompt: e.target.value })}
                      rows={5}
                      style={{ width: '100%', marginTop: 4, fontFamily: 'inherit', fontSize: 13 }}
                      placeholder={t('settings.aiRules.promptPlaceholder')}
                    />
                  </label>

                  <div style={{ marginTop: 12 }}>
                    <label>{t('settings.aiRules.allowedActions')}:</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                      {['archive', 'move', 'trash', 'mark_read', 'mark_starred', 'mark_spam'].map(action => (
                        <label key={action} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={editingAiRule.allowedActions.includes(action)}
                            onChange={e => {
                              const actions = e.target.checked
                                ? [...editingAiRule.allowedActions, action]
                                : editingAiRule.allowedActions.filter(a => a !== action)
                              setEditingAiRule({ ...editingAiRule, allowedActions: actions })
                            }}
                          />
                          {t(`settings.rules.action.${action}`)}
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="setting-row" style={{ marginTop: 12 }}>
                    {t('settings.aiRules.budget')}:
                    <input
                      type="number"
                      min="0" max="100" step="0.10"
                      value={editingAiRule.budgetPerDayUsd}
                      onChange={e => setEditingAiRule({ ...editingAiRule, budgetPerDayUsd: Number(e.target.value) || 0 })}
                      style={{ width: 80, marginLeft: 8 }}
                    />
                  </label>

                  {aiRuleError && (
                    <p style={{ fontSize: 12, color: '#ef4444', margin: '12px 0 0' }} role="alert">{aiRuleError}</p>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
                    <button className="btn" onClick={() => { setAiRuleError(null); setEditingAiRule(null) }}>{t('common.cancel')}</button>
                    <button className="btn btn-primary" onClick={async () => {
                      const data = {
                        name: editingAiRule.name,
                        prompt: editingAiRule.prompt,
                        allowedActions: JSON.stringify(editingAiRule.allowedActions),
                        budgetPerDayUsd: editingAiRule.budgetPerDayUsd,
                        accountId: editingAiRule.accountId,
                      }
                      try {
                        if (editingAiRule.id) {
                          await window.api.invoke('aiRules:update', editingAiRule.id, data)
                        } else {
                          await window.api.invoke('aiRules:create', data)
                        }
                        setAiRuleError(null)
                        setEditingAiRule(null)
                      } catch (err) {
                        // §2.39: create/edit that turns a rule ON past the
                        // per-account cap is rejected — keep the modal open and
                        // show a localized message instead of silently failing.
                        const msg = err instanceof Error ? err.message : String(err)
                        if (msg.includes('AI_RULE_ENABLED_LIMIT')) {
                          setAiRuleError(t('settings.aiRules.enabledLimit', { max: AI_RULE_MAX_ENABLED_PER_ACCOUNT }))
                        } else {
                          setAiRuleError(t('settings.rules.saveFailed'))
                        }
                      }
                      void loadAiRules()
                    }} disabled={!editingAiRule.name.trim() || !editingAiRule.prompt.trim()}>
                      {t('common.save')}
                    </button>
                  </div>
                </div>
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'about' && (
          <section className="form-section">
            <h3><Info size={16} style={{ marginRight: 6, verticalAlign: -2 }} />{t('settings.about.title')}</h3>

            {/* §2.19 — System info + auto-update controls. Owns its own */}
            {/* state machine for the check/download/install lifecycle; */}
            {/* the autoUpdateEnabled checkbox is controlled here so the */}
            {/* shared "Save" button persists it via settings:save. */}
            <SystemInfo
              autoUpdateEnabled={autoUpdateEnabled}
              onAutoUpdateEnabledChange={setAutoUpdateEnabled}
            />

            <hr style={{ margin: '16px 0', borderColor: 'var(--border)' }} />

            <div className="setting-row">
              <label>{t('settings.about.website')}:</label>
              <button
                className="btn-link"
                onClick={() => void window.api.invoke('ui:openExternal', 'https://mailcopilot.io')}
              >
                mailcopilot.io <ExternalLink size={12} style={{ verticalAlign: -1, marginLeft: 2 }} />
              </button>
            </div>

            <div className="setting-row">
              <label>{t('settings.about.docs')}:</label>
              <button
                className="btn-link"
                onClick={() => void window.api.invoke('ui:openExternal', 'https://docs.mailcopilot.io')}
              >
                docs.mailcopilot.io <ExternalLink size={12} style={{ verticalAlign: -1, marginLeft: 2 }} />
              </button>
            </div>

            <hr style={{ margin: '16px 0', borderColor: 'var(--border)' }} />

            <label className="setting-check">
              <input
                type="checkbox"
                data-testid="settings-about-sentry"
                checked={sentryEnabled && !telemetryConsentNeeded}
                disabled={telemetryConsentNeeded}
                onChange={e => setSentryEnabled(e.target.checked)}
              />
              {t('settings.about.sentryEnabled')}
            </label>
            <p className="hint">{t('settings.about.sentryHint')}</p>
            {telemetryConsentNeeded && (
              <p className="hint" data-testid="settings-about-consent-pending">
                {t('settings.about.sentryConsentPending')}
              </p>
            )}

            <label className="setting-check">
              <input
                type="checkbox"
                data-testid="settings-about-debug-logging"
                checked={debugLogging}
                onChange={e => setDebugLogging(e.target.checked)}
              />
              {t('settings.about.debugLogging')}
            </label>
            <p className="hint">{t('settings.about.debugLoggingHint')}</p>

            <hr style={{ margin: '16px 0', borderColor: 'var(--border)' }} />

            <h4 style={{ margin: '0 0 4px' }}><MessageSquare size={14} style={{ marginRight: 4, verticalAlign: -2 }} />{t('feedback.title')}</h4>
            <p className="hint">{t('feedback.hint')}</p>

            {!sentryEnabled ? (
              <div style={{ marginTop: 8 }}>
                <p className="hint">{t('feedback.disabledHint')}</p>
                <button
                  className="btn-link"
                  onClick={() => void window.api.invoke('ui:openExternal', 'https://mailcopilot.io')}
                >
                  mailcopilot.io <ExternalLink size={12} style={{ verticalAlign: -1, marginLeft: 2 }} />
                </button>
              </div>
            ) : feedbackSent ? (
              <p className="hint" style={{ color: 'var(--success, #22c55e)' }}>{t('feedback.thanks')}</p>
            ) : !showFeedbackForm ? (
              <button
                className="btn-secondary"
                data-testid="settings-about-feedback"
                style={{ marginTop: 8 }}
                onClick={() => setShowFeedbackForm(true)}
              >
                <MessageSquare size={14} /> {t('feedback.reportBug')}
              </button>
            ) : (
              <div style={{ marginTop: 8 }}>
                <textarea
                  className="settings-textarea"
                  data-testid="settings-about-feedback-message"
                  placeholder={t('feedback.placeholder')}
                  value={feedbackMessage}
                  onChange={e => setFeedbackMessage(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  style={{ width: '100%', resize: 'vertical', marginBottom: 8 }}
                />
                <input
                  type="email"
                  data-testid="settings-about-feedback-email"
                  placeholder={t('feedback.emailPlaceholder')}
                  value={feedbackEmail}
                  onChange={e => setFeedbackEmail(e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <button
                  className="btn-primary"
                  data-testid="settings-about-feedback-send"
                  disabled={!feedbackMessage.trim()}
                  onClick={() => {
                    if (!feedbackMessage.trim()) return
                    sendFeedback({ message: feedbackMessage.trim(), email: feedbackEmail.trim() || undefined })
                    setFeedbackSent(true)
                    setShowFeedbackForm(false)
                    setFeedbackMessage('')
                    setFeedbackEmail('')
                  }}
                >
                  <Send size={14} /> {t('feedback.send')}
                </button>
              </div>
            )}
          </section>
        )}

        {/* §2.119 — sits directly above Save, not inside the AI tab: the save
            is window-wide, so the answer to "did my save go through?" has to be
            where the person pressed the button, whatever tab they are on. */}
        <AiDestinationRejectionNotice
          rejection={aiDestinationRejection}
          onRetry={() => void save()}
        />

        <button data-testid="settings-save" className="btn-primary settings-save-btn" onClick={() => void save()}>
          <Save size={14} /> {t('common.save')}
        </button>
      </div>
    </div>
    </>
  )
}
