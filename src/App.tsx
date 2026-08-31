import { Fragment, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setSentryUserEnabled, setSentryUserId, startManualSpan } from './sentry'
import { folderRoleFromPath } from './utils/metrics'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useTranslation } from 'react-i18next'
import type { AccountMeta, AttachmentMeta, ComposeInit, FolderPreference, FolderRoles, Mailbox, MailSummary, MessageDetails } from '../packages/net/types'
import {
  RefreshCw, Settings, Trash2, Archive, Search,
  Inbox, AlertTriangle, Mail, Clock3, AlarmClock, Bell,
  Minus, Square, Copy, X, PenSquare, Loader2,
  Reply, ReplyAll, Forward, MailOpen, MailCheck, Paperclip, ShieldAlert, Star, Pencil,
  Layers, ChevronsRight, ChevronsLeft, ExternalLink, Sparkles, BookOpen, Wifi, WifiOff, CheckCircle2,
  Pin, Printer, Globe, FolderSearch,
} from 'lucide-react'
import {
  getAvatarColor, getPaletteColor,
  getFolderRole, folderLabel, addrListToString, extractEmails,
  uniqEmails, computeReplyRecipients, prefixSubject, htmlToText, quoteText, formatSmartDate, sortFolders,
  deriveIsSentByMe,
} from './utils/mail'
import { isFolderCountedInBadges } from '@mailcopilot/core'
import { TranslatedError, presentedError } from './utils/errorPresentation'
import { useMailLinkClick } from './hooks/useMailLinkClick'
import { useMailOpenRef } from './hooks/useMailOpenRef'
import { useCertRecovery } from './hooks/useCertRecovery'
import { useAccountAuthState } from './hooks/useAccountAuthState'
import LinkWarningDialog from './components/LinkWarningDialog'
import CertRecoveryDialog from './components/CertRecoveryDialog'
import AccountAuthBadge from './components/AccountAuthBadge'
import SentCopyFailedToast from './components/SentCopyFailedToast'
import { resolveThreadItems, expandBulkToThreads } from './utils/threadActions'
// §2.238 — per-message folder derivation for every destructive set operation.
// Deep path into the same module `./utils/threadActions` re-exports; the
// wrapper's export list was outside this change's file scope.
import {
  dragSelectionRefs,
  groupByAccountFolder,
  parseMailRefs,
  planMarkSeenGroups,
  planMoveToFolder,
  planRoleMove,
  resolveKnownRefs,
  serializeMailRefs,
  soleGroup,
  type FolderGroup,
  type MailRef,
  type RoleMovePlan,
} from '@mailcopilot/core/threadActions'
import {
  countSelectedRows,
  leadKeyOfRowContaining,
  pickThreadOpenTarget,
  rowContaining,
  rowIsSelected,
  rowLeadKeyFor,
  toggleRowSelection,
  type ThreadRow,
} from './utils/threading'
import { isThreadMode as computeIsThreadMode, pickLatestMail, pickReplyTarget, countThreadUnread } from './utils/threadToolbar'
import { findNextAfterRemoval } from './utils/autoAdvanceNav'
import AccountAvatar from './components/AccountAvatar'
import MailAvatar from './components/MailAvatar'
import { useUnreadPending, type MailboxesAndRoles } from './hooks/useUnreadPending'
import { useMailListView, type SortMode } from './hooks/useMailListView'
import { useUndoSystem } from './hooks/useUndoSystem'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import FolderIcon from './components/FolderIcon'
import ContextMenu from './components/ContextMenu'
import SnoozeDropdown from './components/SnoozeDropdown'
import { useInboxZeroCounter } from './hooks/useInboxZeroCounter'
import { useMaximized } from './hooks/useMaximized'
import { useTooltipDelegation } from './hooks/useTooltipDelegation'
import { useRefreshFolderCounts } from './hooks/useRefreshFolderCounts'
import { useSidebarCompactMode } from './hooks/useSidebarCompactMode'
import { useMailIframeDoc } from './hooks/useMailIframeDoc'
import { useAccountIdentities } from './hooks/useAccountIdentities'
import { useShowFullMessage } from './hooks/useShowFullMessage'
import { startColdStartSpan } from './utils/ipcSingleFlight'
import { prettyFolderName } from './utils/folderDisplay'
import type { ContextMenuState } from './components/ContextMenu'
import FolderContextMenu from './components/FolderContextMenu'
import type { FolderContextMenuState } from './components/FolderContextMenu'
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal'
import AiPanel from './components/AiPanel'
import NotificationCenter from './components/NotificationCenter'
import ResizeEdges from './components/ResizeEdges'
import ThreadView from './components/ThreadView'
import MailBodyContent from './components/MailBodyContent'
import { SingleMessageInstantReply } from './components/SingleMessageInstantReply'
import { isAiFeatureEnabledForAccount } from './utils/aiAccountGate'
import { useMailTranslation } from './hooks/useMailTranslation'
import './App.css'

const PAGE_SIZE = 50

// Detects search queries that include any operator the FTS path can't handle.
// Must mirror the operators recognized by parseSearchQuery in @mailcopilot/core.
const ADVANCED_QUERY_RE = /(?:^|\s)(?:-\S|from:|to:|subject:|body:|filename:|is:|has:|in:|before:|after:|uid:)/i
function isAdvancedQuery(query: string): boolean {
  return ADVANCED_QUERY_RE.test(query)
}
const OUTBOX_FOLDER = '__OUTBOX__'
const SNOOZED_FOLDER = '__SNOOZED__'
const FOLLOWUP_FOLDER = '__FOLLOWUP__'
const READLATER_FOLDER = '__READLATER__'
const SIDEBAR_STORAGE_KEY = 'mailcopilot:sidebar'
// §2.238 — the payload carries full message refs (account, folder, uid). The
// previous `…-uids` type carried bare UIDs, which address a message only inside
// the mailbox they were read from; the MIME type was renamed together with the
// shape so a payload of the old form cannot be misread as the new one.
const DRAG_MAILREFS_MIME = 'application/x-mailcopilot-mailrefs'

type MailKey = string
type FollowUpDisplayItem = { id: number; accountId: number; toAddr: string; subject: string | null; remindAt: string; sentMessageId: string }
type ReadLaterDisplayItem = { id: number; accountId: number; folder: string; uid: number; subject: string; from: string; date: string }

function mailKey(m: { accountId: number; folder: string; uid: number }): MailKey {
  return `${m.accountId}:${m.folder}:${m.uid}`
}

/**
 * §2.17 Phase 0 — body-size bucket for the renderer 'mail.open' Sentry span.
 * Mirrors `bucketBodySize` boundaries in electron/metricsBuckets.ts so a
 * dashboard cross-referencing the renderer span and the main-side
 * 'net.message_details.wall_ms' histogram sees a consistent vocabulary.
 * Renderer cannot import from electron/* so the boundaries are duplicated
 * intentionally — keep them in sync if the canonical helper changes.
 */
function bucketBodySizeRenderer(details: MessageDetails | null | undefined): string {
  if (!details) return '<1KB'
  const bytes = Math.max(details.html?.length ?? 0, details.text?.length ?? 0)
  if (bytes < 1024) return '<1KB'
  if (bytes < 10 * 1024) return '1-10KB'
  if (bytes < 100 * 1024) return '10-100KB'
  if (bytes < 1024 * 1024) return '100KB-1MB'
  return '1MB+'
}

type UnifiedCursor = { date: string; accountId: number; uid: number }
type MessageRef = { accountId: number; folder: string; uid: number }
type OutboxItem = {
  id: string
  accountId: number
  sendAt: string
  status: 'queued' | 'sending' | 'failed'
  lastError?: string | null
  attemptCount: number
  messageData: ComposeInit
}
type PaletteCommand = {
  id: string
  label: string
  shortcut?: string
  keywords?: string[]
  run: () => void
}

export type AuthRecoveryKind = 'google' | 'outlook' | 'password'

/**
 * Returns true when the account uses OAuth2 (Google or Microsoft). Legacy
 * records stored with older literals are normalised to 'oauth2' on read in
 * packages/net/config.ts, so the renderer only needs to match the canonical
 * value. Historical name retained for call-site compatibility; routing to
 * provider-specific flows is decided by `providerId` in
 * detectAuthRecoveryKind.
 */
function isGmailOAuthType(authType: AccountMeta['authType'] | undefined): boolean {
  return authType === 'oauth2'
}

/**
 * Classifies an error message into a recovery flow branch.
 *
 * Provider routing is based on `providerId` (canonical source of truth on
 * AccountMeta), not error-message heuristics:
 *  - oauth2 + providerId='gmail'   -> 'google'   (routes to oauth:google:connect)
 *  - oauth2 + providerId='outlook' -> 'outlook'  (routes to oauth:microsoft:connect)
 *  - non-oauth auth failure        -> 'password' (opens account window)
 *  - no auth signal                -> null       (not an auth problem)
 *
 * Returning null means this error is not an auth issue — caller should
 * surface it through the regular error path.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function detectAuthRecoveryKind(
  errorMessageRaw: string,
  authType: AccountMeta['authType'] | undefined,
  providerId: AccountMeta['providerId'] | undefined,
): AuthRecoveryKind | null {
  const message = (errorMessageRaw || '').toLowerCase()
  const isOAuth = isGmailOAuthType(authType)
  const oauthReauth =
    message.includes('google refresh token')
    || message.includes('нужна переавторизация')
    || message.includes('invalid_grant')
    || message.includes('token has been expired')
    || message.includes('oauth')
    // Microsoft / AAD specific OAuth failure codes. Keep additions small and
    // match only things that unambiguously indicate a broken OAuth session.
    || message.includes('aadsts')
    || message.includes('interaction_required')
    || message.includes('consent_required')

  if (isOAuth && oauthReauth) {
    return providerId === 'outlook' ? 'outlook' : 'google'
  }

  const authMissing =
    message.includes('imap аутентификация')
    || message.includes('smtp аутентификация')
    || message.includes('authentication')
    || message.includes('invalid credentials')
    || message.includes('auth failed')
    || message.includes('username and password not accepted')
    || message.includes('login failed')
    || message.includes('535 ')

  if (authMissing) {
    if (isOAuth) return providerId === 'outlook' ? 'outlook' : 'google'
    return 'password'
  }
  return null
}

export default function App() {
  const { t, i18n } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  const [accounts, setAccounts] = useState<AccountMeta[]>([])
  const [currentAccountId, setCurrentAccountId] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<'account' | 'unified'>('account')
  const [unifiedAccountFilter, setUnifiedAccountFilter] = useState<number | 'all'>('all')
  const [error, setError] = useState('')
  const [mails, setMails] = useState<MailSummary[]>([])
  const [active, setActive] = useState<MailSummary | null>(null)
  // selectedKeys, selectionAnchorKey — in useMailListView
  const [details, setDetails] = useState<MessageDetails | null>(null)
  const mailIframeRef = useRef<HTMLIFrameElement | null>(null)
  const printMailIframe = useCallback(() => {
    mailIframeRef.current?.contentWindow?.print()
  }, [])
  const [hotkeysPreset, setHotkeysPreset] = useState<'gmail' | 'outlook'>('gmail')
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )
  const [darkModeEmails, setDarkModeEmails] = useState(true)
  const [alwaysLoadImages, setAlwaysLoadImages] = useState(false)
  const [gravatarInMail, setGravatarInMail] = useState(true)
  const [showExternalImages, setShowExternalImages] = useState(false)
  const [q, setQ] = useState('')
  const [searchScope, setSearchScope] = useState<'folder' | 'account' | 'all'>('account')
  const [searchSort, setSearchSort] = useState<'relevance' | 'date'>('date')
  const [searching, setSearching] = useState(false)
  const [paginatingSearch, setPaginatingSearch] = useState(false)
  // Generation counter — incremented on every new search request so that
  // stale worker responses (a slower previous query) cannot clobber newer results.
  const searchSeqRef = useRef(0)
  // Snapshot of the active search so loadPage knows how to paginate forward.
  // null when no search is active. `kind` distinguishes single-folder from unified.
  const activeSearchRef = useRef<
    | null
    | {
        kind: 'folder'
        accountId: number
        folder: string
        query: string
        sort: 'relevance' | 'date'
        offset: number
        /** Keys (accountId:folder:uid) of rows injected by remote IMAP SEARCH
         *  fallback. Tracked so paginated local BM25 pages can be spliced
         *  *before* the remote tail when sort='relevance'; otherwise remote
         *  rows (which lack BM25 ordering) would sit above later local rows. */
        remoteKeys?: Set<string>
      }
    | {
        kind: 'unified'
        accountIds: number[]
        scope: 'inbox' | 'all'
        query: string
        sort: 'relevance' | 'date'
        offset: number
        remoteKeys?: Set<string>
      }
  >(null)
  // Global indexing/coverage health for the statusbar. Refreshed on a 30s timer
  // across ALL accounts. Search flows must NOT write here — they would replace the
  // global numbers with scope-filtered ones and `resetSearchLifecycle()` would blank
  // the statusbar for up to 30s on every context switch.
  const [globalCoverageStats, setGlobalCoverageStats] = useState<{
    totalMessages: number; bodyIndexed: number; filenamesIndexed: number;
    folderCoverage?: { total: number; coveredFull: number; coveredRecent: number; crawling: number; notStarted: number; error: number };
  } | null>(null)
  const [remoteResultCount, setRemoteResultCount] = useState(0)
  const [syncFolderProgress, setSyncFolderProgress] = useState<{ account: string; folder: string; fetched: number; total: number | null } | null>(null)
  const [groupConversations, setGroupConversations] = useState(true)
  const [sortMode, setSortMode] = useState<SortMode>('date')
  const [autoAdvance, setAutoAdvance] = useState<'off' | 'newer' | 'older' | 'back_to_list'>('older')
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const [folders, setFolders] = useState<Mailbox[]>([])
  const [roles, setRoles] = useState<FolderRoles>({})
  const [currentFolder, setCurrentFolder] = useState('INBOX')
  // filterMode — in useMailListView
  const [workOffline, setWorkOffline] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [loadingBody, setLoadingBody] = useState(false)
  const [listWidth, setListWidth] = useState(380)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [folderCtxMenu, setFolderCtxMenu] = useState<FolderContextMenuState | null>(null)
  const [savingAttachment, setSavingAttachment] = useState<string | null>(null)
  const [imapIdleEnabled, setImapIdleEnabled] = useState(true)
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(1)
  const [hiddenUnreadFolders, setHiddenUnreadFolders] = useState<string[]>([])
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY)
    // Default to expanded for new users (no preference saved yet).
    if (saved === null) return true
    return saved === '1'
  })
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<Map<number, 'ok' | 'error' | 'syncing'>>(new Map())
  // AI panel
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiPanelWidth, setAiPanelWidth] = useState(350)
  const [aiProvider, setAiProvider] = useState<string | undefined>(undefined)
  const [aiPrivacyConsent, setAiPrivacyConsent] = useState(false)
  const [aiSendOnEnter, setAiSendOnEnter] = useState(true)
  const [aiShowSources, setAiShowSources] = useState(true)
  // §3.10 P1: outbound egress policy. Source of truth is `Settings`; this
  // mirrors the value into the AI panel so the chip can render the correct
  // state (hidden when 'allow', visible/blocked otherwise). Default
  // 'default-deny' matches `aiEgressPolicy.ts::defaultEgressPolicy()`.
  const [aiEgressPolicy, setAiEgressPolicy] = useState<'default-deny' | 'ask' | 'allow'>('default-deny')
  // §3.3 B2 Thread AI Summary — per-account opt-in, keyed by stringified
  // accountId. Default OFF (missing/false). Written from Settings via
  // settings:save; mirrored here only to gate whether ThreadView renders the
  // summary strip for the active thread's account.
  const [aiThreadSummaryEnabled, setAiThreadSummaryEnabled] = useState<Record<string, boolean>>({})
  // §3.3 B4: per-account Instant Reply opt-in, mirrored from settings only to
  // gate whether ThreadView renders the Instant Reply strip on the active card.
  const [aiInstantReplyEnabled, setAiInstantReplyEnabled] = useState<Record<string, boolean>>({})
  // §3.3 B6 AI Translate — per-account opt-in, same shape/semantics as the two
  // opt-ins above. Default OFF; main refuses with `opt_out` when an account's
  // entry is not `true`.
  const [aiTranslateEnabled, setAiTranslateEnabled] = useState<Record<string, boolean>>({})
  const [aiQuickPrompt, setAiQuickPrompt] = useState<string | null>(null)
  // pendingGoRef, pendingGoTimer — in useKeyboardShortcuts
  const alwaysLoadImagesRef = useRef(alwaysLoadImages)
  alwaysLoadImagesRef.current = alwaysLoadImages

  // Inbox Zero counter
  const { count: inboxZeroCount, increment: inboxZeroIncrement, decrement: inboxZeroDecrement } = useInboxZeroCounter()

  const maximized = useMaximized()
  // uiaudit.14: compact sidebar for narrow viewports (innerHeight < 720px)
  const compactSidebar = useSidebarCompactMode()

  // Undo bar — state, timers and effects in useUndoSystem
  // §2.7 iter2: epoch counter incremented on every pending-move state change.
  // Owned here (not inside useUndoSystem) because list-fetch call sites below
  // need synchronous read access via .current and many of them run earlier in
  // this component than the useUndoSystem hook is invoked. The hook receives
  // the ref as a param and bumps it from moveWithUndo / flushUndo / handleUndo
  // / 5s auto-fire.
  const pendingMoveEpochRef = useRef(0)
  const [outboxItems, setOutboxItems] = useState<OutboxItem[]>([])
  const [outboxLoading, setOutboxLoading] = useState(false)
  const [outboxActionId, setOutboxActionId] = useState<string | null>(null)

  // Snooze
  type SnoozedDisplayItem = { id: number; accountId: number; folder: string; uid: number | null; wakeAt: string; subject: string; from: string; date: string; unread: boolean }
  const [snoozedItems, setSnoozedItems] = useState<SnoozedDisplayItem[]>([])
  const [snoozeAnchor, setSnoozeAnchor] = useState<{ mail: MailSummary; rect: DOMRect } | null>(null)
  const snoozeLoadSeq = useRef(0)

  /** Set of keys "accountId:folder:uid" for fast filtering of snoozed messages from IMAP results */
  const snoozedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const item of snoozedItems) {
      if (item.uid) keys.add(`${item.accountId}:${item.folder}:${item.uid}`)
    }
    return keys
  }, [snoozedItems])

  /** Filters snoozed messages from the list (for direct IMAP loads where SQL does not apply) */
  const filterSnoozedRef = useRef((list: MailSummary[]) => list)
  filterSnoozedRef.current = (list: MailSummary[]) => {
    if (snoozedKeys.size === 0) return list
    return list.filter(m => !snoozedKeys.has(`${m.accountId}:${m.folder}:${m.uid}`))
  }
  const filterSnoozed = useCallback((list: MailSummary[]) => filterSnoozedRef.current(list), [])

  /** Snoozed items for the current account (for display in the virtual folder) */
  const filteredSnoozedItems = useMemo(
    () => snoozedItems.filter(item => item.accountId === currentAccountId),
    [snoozedItems, currentAccountId],
  )

  // Follow-up Reminders
  const [followUpItems, setFollowUpItems] = useState<FollowUpDisplayItem[]>([])
  const followUpLoadSeq = useRef(0)

  // Read Later
  const [readLaterItems, setReadLaterItems] = useState<ReadLaterDisplayItem[]>([])
  const readLaterLoadSeq = useRef(0)

  // Auto-update
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [canSelfUpdate, setCanSelfUpdate] = useState(true)

  // Confirm permanent deletion from trash
  // §2.238 — the pending permanent deletion is a LIST of (account, folder)
  // groups, not one folder plus a flat UID list: a conversation may sit in more
  // than one folder, and a UID is only addressable inside its own mailbox.
  const [confirmDelete, setConfirmDelete] = useState<{ groups: FolderGroup<MailRef>[]; bulk: boolean } | null>(null)

  // Thread-level action confirmation
  type ThreadActionConfirm = { action: 'archive' | 'delete' | 'spam'; msgs: MailSummary[] }
  const [threadConfirm, setThreadConfirm] = useState<ThreadActionConfirm | null>(null)

  // Cursor pagination: UID before which to load the next page (older messages).
  const cursorBeforeUid = useRef<number | undefined>(undefined)
  // Cursor for Unified Inbox (keyset on (date, accountId, uid) in descending order).
  const unifiedCursor = useRef<UnifiedCursor | undefined>(undefined)
  const hasMore = useRef(true)
  const [hasMoreState, setHasMoreState] = useState(true)
  const setHasMore = useCallback((v: boolean) => {
    hasMore.current = v
    setHasMoreState(v)
  }, [])
  const loading = useRef(false)
  const syncingRef = useRef(false)
  const syncOpSeq = useRef(0)
  const ctxSeq = useRef(0)
  const openSeq = useRef(0)
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const detailsRef = useRef(details)
  detailsRef.current = details
  const currentAccountIdRef = useRef<number | null>(null)
  currentAccountIdRef.current = currentAccountId
  const currentFolderRef = useRef(currentFolder)
  currentFolderRef.current = currentFolder
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const qRef = useRef(q)
  qRef.current = q
  const headerSyncInFlight = useRef(new Map<string, Promise<unknown>>())
  const idleRefreshTimer = useRef<number | null>(null)
  const searchDebounceRef = useRef<number | null>(null)
  const authRecoveryCooldownUntil = useRef(new Map<number, number>())
  const authRecoveryInFlight = useRef(new Set<number>())
  const [initDone, setInitDone] = useState(false)
  const { tooltipState, containerRef: tooltipContainerRef, handleMouseOver: handleTooltipOver, handleMouseOut: handleTooltipOut } = useTooltipDelegation()
  const foldersByAccount = useRef(new Map<number, Mailbox[]>())
  const rolesByAccount = useRef(new Map<number, FolderRoles>())
  const folderPrefsByAccount = useRef(new Map<number, Record<string, FolderPreference>>())
  /** Tracks which accounts already had their background folder sync triggered (once per session). */
  const bgFolderSyncDone = useRef(new Set<number>())
  const bgFolderRetryTimers = useRef(new Map<number, ReturnType<typeof setInterval>>())
  // Global sequential queue for background folder sync (Thunderbird pattern: one folder at a time).
  // Multiple accounts on same IMAP server (e.g. Yandex) would throttle parallel connections.
  // Per-folder timeout (5 min) prevents one stuck folder from blocking the entire queue.
  const bgSyncQueue = useRef(Promise.resolve())

  // The live account set is the boundary of every per-account unread store:
  // the hook drops (and refuses) keys of accounts that are no longer here, so
  // a deleted account cannot be resurrected by an in-flight answer, and no
  // explicit cleanup call has to be remembered at the deletion sites.
  const accountIds = useMemo(() => accounts.map(a => a.id), [accounts])

  const {
    folderUnreadPending,
    bump: bumpFolderUnreadPending,
    record: recordPendingUnread,
    clear: clearPendingUnread,
    applyOverrides: applyUnreadOverrides,
    reset: resetLocalPending,
    ackMailboxes,
  } = useUnreadPending(accountIds)

  const {
    filterMode, setFilterMode,
    selectedKeys, setSelectedKeys,
    selectionAnchorKey,
    threadRows, activeThread,
    selectedCount, hasMultiSelection,
    viewMailsRef, threadRowsRef,
  } = useMailListView({ mails, active, groupConversations, sortMode })

  const hasAccount = accounts.length > 0 && typeof currentAccountId === 'number'
  const isOutboxFolder = viewMode === 'account' && currentFolder === OUTBOX_FOLDER
  const isSnoozedFolder = viewMode === 'account' && currentFolder === SNOOZED_FOLDER
  const isFollowUpFolder = viewMode === 'account' && currentFolder === FOLLOWUP_FOLDER
  const isReadLaterFolder = viewMode === 'account' && currentFolder === READLATER_FOLDER
  const filteredReadLaterItems = useMemo(
    () => readLaterItems.filter(item => item.accountId === currentAccountId),
    [readLaterItems, currentAccountId],
  )
  const activeKey = active ? mailKey(active) : ''

  // §3.3 B6 AI Translate — wiring only; the whole state machine (target
  // language, in-flight token, refusals, original/translation switch and the
  // per-message reset) lives in `useMailTranslation` so App.tsx does not grow
  // another feature (CLAUDE.md §5 hotspot policy). Nothing here can reach a
  // provider: the hook only calls IPC from an explicit user click.
  const mailTranslation = useMailTranslation({
    message: active
      ? { accountId: active.accountId, folder: active.folder, uid: active.uid }
      : null,
    enabled: isAiFeatureEnabledForAccount(aiTranslateEnabled, active?.accountId),
    uiLocale: i18n.language,
  })

  const accountsById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  const currentAccount = useMemo(
    () => (typeof currentAccountId === 'number' ? accountsById.get(currentAccountId) : undefined),
    [accountsById, currentAccountId],
  )

  // §2.22 fix iter2B: AccountMeta for the message currently open in the viewer.
  // Used to build a normalized identity list for InviteCard organizer-self check.
  const activeAccountMeta = useMemo(
    () => (active ? accountsById.get(active.accountId) : undefined),
    [active, accountsById],
  )
  const accountIdentities = useAccountIdentities(activeAccountMeta)

  const maybeRecoverAuthIssue = useCallback(async (accountId: number, errorRaw: unknown): Promise<boolean> => {
    const account = accountsById.get(accountId)
    if (!account) return false

    const errorMessage = String(errorRaw || '')
    const kind = detectAuthRecoveryKind(errorMessage, account.authType, account.providerId)
    if (!kind) return false

    const now = Date.now()
    const cooldownUntil = authRecoveryCooldownUntil.current.get(accountId) ?? 0
    if (cooldownUntil > now) return true
    if (authRecoveryInFlight.current.has(accountId)) return true

    authRecoveryInFlight.current.add(accountId)
    const accountLabel = (account.name || account.imap.user || '').trim() || `#${accountId}`
    try {
      if (kind === 'google' || kind === 'outlook') {
        const channel: 'oauth:google:connect' | 'oauth:microsoft:connect' =
          kind === 'outlook' ? 'oauth:microsoft:connect' : 'oauth:google:connect'
        const promptKey = kind === 'outlook' ? 'app.authRecovery.outlookPrompt' : 'app.authRecovery.googlePrompt'
        const requiredKey = kind === 'outlook' ? 'app.authRecovery.outlookRequired' : 'app.authRecovery.googleRequired'
        const startingKey = kind === 'outlook' ? 'app.authRecovery.outlookStarting' : 'app.authRecovery.googleStarting'
        const successKey = kind === 'outlook' ? 'app.authRecovery.outlookSuccess' : 'app.authRecovery.googleSuccess'
        const failedHelpKey = kind === 'outlook' ? 'app.authRecovery.outlookFailedHelp' : 'app.authRecovery.googleFailedHelp'

        const confirmReauth = window.confirm(t(promptKey, { account: accountLabel }))
        if (!confirmReauth) {
          authRecoveryCooldownUntil.current.set(accountId, now + 5 * 60_000)
          setError(t(requiredKey, { account: accountLabel }))
          return true
        }
        setError(t(startingKey, { account: accountLabel }))
        try {
          const result = await window.api.invoke(channel, accountId) as { ok?: boolean }
          // TranslatedError, not Error: this branch throws so the catch below
          // owns the cooldown + reopen-account cleanup once, and its message is
          // already our own translated copy. `presentedError` passes it through
          // instead of collapsing it into the generic sentence.
          if (!result?.ok) throw new TranslatedError(t('common.error'))
          authRecoveryCooldownUntil.current.delete(accountId)
          setError(t(successKey, { account: accountLabel }))
          void window.setTimeout(() => {
            setError('')
          }, 2500)
          return true
        } catch (oauthErr) {
          authRecoveryCooldownUntil.current.set(accountId, Date.now() + 5 * 60_000)
          try {
            await window.api.invoke('accounts:setCurrent', accountId)
          } catch {
            // ignore
          }
          try {
            await window.api.invoke('ui:openAccount', 'edit', accountId)
          } catch {
            // ignore
          }
          setError(t(failedHelpKey, { error: presentedError(t, oauthErr) }))
          return true
        }
      }

      const confirmPassword = window.confirm(t('app.authRecovery.passwordPrompt', { account: accountLabel }))
      if (!confirmPassword) {
        authRecoveryCooldownUntil.current.set(accountId, now + 5 * 60_000)
        setError(t('app.authRecovery.passwordRequired', { account: accountLabel }))
        return true
      }

      try {
        await window.api.invoke('accounts:setCurrent', accountId)
      } catch {
        // ignore
      }
      await window.api.invoke('ui:openAccount', 'edit', accountId)
      authRecoveryCooldownUntil.current.set(accountId, Date.now() + 30_000)
      setError(t('app.authRecovery.passwordOpen', { account: accountLabel }))
      return true
    } finally {
      authRecoveryInFlight.current.delete(accountId)
    }
  }, [accountsById, t])

  const applyAccountMailboxesAndRoles = useCallback((accountId: number, res: MailboxesAndRoles, opts?: { setCurrent?: boolean }) => {
    // Ack server counts (for instant UI without "rollback").
    ackMailboxes(accountId, res.mailboxes)

    const sorted = sortFolders(res.mailboxes, res.roles)
    rolesByAccount.current.set(accountId, res.roles)
    foldersByAccount.current.set(accountId, sorted)
    folderPrefsByAccount.current.set(accountId, res.prefs || {})

    // If this is the current account — update visible folders/roles.
    const shouldSetCurrent = opts?.setCurrent ?? (accountId === currentAccountId)
    if (shouldSetCurrent) {
      setRoles(res.roles)
      setFolders(sorted)
    }
  }, [ackMailboxes, currentAccountId])

  // Ref for use in init effect (to avoid restarting the load when currentAccountId changes).
  const applyMbRolesRef = useRef(applyAccountMailboxesAndRoles)
  applyMbRolesRef.current = applyAccountMailboxesAndRoles

  /** Updates only unread counts from the SQLite cache without requesting the IMAP folder list. */
  const refreshCachedFolderCounts = useCallback(async (accountId: number) => {
    const counts = await window.api.invoke('folder:refreshCounts', accountId) as Record<string, { unread: number; total: number }>
    const cached = foldersByAccount.current.get(accountId)
    if (!cached) return
    const updated = cached.map(f => {
      const c = counts[f.path]
      return c ? { ...f, unread: c.unread } : f
    })
    ackMailboxes(accountId, updated)
    foldersByAccount.current.set(accountId, updated)
    if (accountId === currentAccountId) {
      setFolders(updated)
    }
  }, [ackMailboxes, currentAccountId])

  const refreshCachedFolderCountsRef = useRef(refreshCachedFolderCounts)
  refreshCachedFolderCountsRef.current = refreshCachedFolderCounts

  // §1.4 cold-start IPC stampede fix (renderer side): three sequential
  // control-flow paths fire `folder:refreshCounts` per account within ~1-2s
  // at boot (init DB-apply → post-IMAP sync → mail:exists IDLE). Each call
  // is legitimate individually, but the combined storm hammers better-sqlite3
  // inside the main event loop. Per-account debounce coalesces them into one
  // effective call per account within a 500ms window. Hook is transport-
  // agnostic — we hand it the existing runner via ref so the closure always
  // sees the latest callback without re-subscribing the timers.
  const refreshCounts = useRefreshFolderCounts(
    useCallback((id: number) => refreshCachedFolderCountsRef.current(id), []),
  )
  const refreshCountsRef = useRef(refreshCounts)
  refreshCountsRef.current = refreshCounts

  // Start the renderer cold-start IPC telemetry span exactly once per process.
  // The span closes itself after ~12s and records how many duplicate IPC calls
  // were coalesced during the boot window.
  useEffect(() => {
    startColdStartSpan()
  }, [])

  const invalidateContext = useCallback(() => {
    ctxSeq.current += 1
  }, [])

  const loadOutbox = useCallback(async (accountIdOverride?: number) => {
    const aid = typeof accountIdOverride === 'number' ? accountIdOverride : currentAccountId
    if (typeof aid !== 'number') {
      setOutboxItems([])
      return
    }
    try {
      setOutboxLoading(true)
      const raw = await window.api.invoke('mail:queueList', aid) as Array<{
        id?: unknown
        accountId?: unknown
        sendAt?: unknown
        status?: unknown
        lastError?: unknown
        attemptCount?: unknown
        messageData?: unknown
      }>
      const list = Array.isArray(raw) ? raw : []
      const mapped: OutboxItem[] = []
      for (const row of list) {
        const id = typeof row.id === 'string' ? row.id : ''
        const accountId = typeof row.accountId === 'number' ? row.accountId : aid
        const sendAt = typeof row.sendAt === 'string' ? row.sendAt : ''
        const status = row.status === 'failed' || row.status === 'sending' || row.status === 'queued' ? row.status : null
        if (!id || !sendAt || !status) continue
        const messageData = (row.messageData && typeof row.messageData === 'object') ? (row.messageData as ComposeInit) : {}
        mapped.push({
          id,
          accountId,
          sendAt,
          status,
          lastError: typeof row.lastError === 'string' ? row.lastError : null,
          attemptCount: typeof row.attemptCount === 'number' ? row.attemptCount : 0,
          messageData,
        })
      }
      setOutboxItems(mapped)
    } catch (e) {
      setError(t('app.errors.load', { error: presentedError(t, e) }))
    } finally {
      setOutboxLoading(false)
    }
  }, [currentAccountId, t])

  const loadSnoozed = useCallback(async () => {
    if (accounts.length === 0) {
      setSnoozedItems([])
      return
    }
    const seq = ++snoozeLoadSeq.current
    const allItems: SnoozedDisplayItem[] = []
    for (const acct of accounts) {
      const aid = acct.id
      try {
        const raw = await window.api.invoke('mail:snoozeList', aid) as Array<Record<string, unknown>>
        if (snoozeLoadSeq.current !== seq) return // stale request
        const list = Array.isArray(raw) ? raw : []
        for (const r of list) {
          const id = typeof r.id === 'number' ? r.id : 0
          const folder = typeof r.folder === 'string' ? r.folder : ''
          const uid = typeof r.uid === 'number' ? r.uid : null
          const wakeAt = typeof r.wakeAt === 'string' ? r.wakeAt : ''
          if (!id || !wakeAt) continue
          let subject = ''
          let from = ''
          let date = ''
          let unread = false
          if (uid) {
            try {
              const cached = await window.api.invoke('cache:messageByUid', aid, folder, uid) as Record<string, unknown> | null
              if (snoozeLoadSeq.current !== seq) return // stale request
              if (cached) {
                subject = typeof cached.subject === 'string' ? cached.subject : ''
                from = typeof cached.from === 'string' ? cached.from : ''
                date = typeof cached.date === 'string' ? cached.date : ''
                unread = cached.unread === true || cached.unread === 1
              }
            } catch { /* cache may be empty */ }
          }
          allItems.push({ id, accountId: aid, folder, uid, wakeAt, subject, from, date, unread })
        }
      } catch { /* ignore */ }
    }
    if (snoozeLoadSeq.current !== seq) return // stale request
    setSnoozedItems(allItems)
  }, [accounts])

  const loadFollowUps = useCallback(async (accountIdOverride?: number) => {
    const aid = typeof accountIdOverride === 'number' ? accountIdOverride : currentAccountId
    if (typeof aid !== 'number') {
      setFollowUpItems([])
      return
    }
    const seq = ++followUpLoadSeq.current
    try {
      const raw = await window.api.invoke('followup:list', aid) as Array<Record<string, unknown>>
      if (followUpLoadSeq.current !== seq) return
      const list = Array.isArray(raw) ? raw : []
      const items: FollowUpDisplayItem[] = []
      for (const r of list) {
        const id = typeof r.id === 'number' ? r.id : 0
        const toAddr = typeof r.toAddr === 'string' ? r.toAddr : ''
        const subject = typeof r.subject === 'string' ? r.subject : null
        const remindAt = typeof r.remindAt === 'string' ? r.remindAt : ''
        const sentMessageId = typeof r.sentMessageId === 'string' ? r.sentMessageId : ''
        const accountId = typeof r.accountId === 'number' ? r.accountId : aid
        if (!id || !remindAt) continue
        items.push({ id, accountId, toAddr, subject, remindAt, sentMessageId })
      }
      if (followUpLoadSeq.current !== seq) return
      setFollowUpItems(items)
    } catch { /* ignore */ }
  }, [currentAccountId])

  const loadReadLater = useCallback(async () => {
    if (accounts.length === 0) {
      setReadLaterItems([])
      return
    }
    const seq = ++readLaterLoadSeq.current
    const allItems: ReadLaterDisplayItem[] = []
    for (const acct of accounts) {
      const aid = acct.id
      try {
        const raw = await window.api.invoke('mail:readLaterList', aid) as Array<Record<string, unknown>>
        if (readLaterLoadSeq.current !== seq) return
        const list = Array.isArray(raw) ? raw : []
        for (const r of list) {
          const id = typeof r.id === 'number' ? r.id : 0
          const folder = typeof r.folder === 'string' ? r.folder : ''
          const uid = typeof r.uid === 'number' ? r.uid : 0
          if (!id || !uid) continue
          let subject = ''
          let from = ''
          let date = ''
          try {
            const cached = await window.api.invoke('cache:messageByUid', aid, folder, uid) as Record<string, unknown> | null
            if (readLaterLoadSeq.current !== seq) return
            if (cached) {
              subject = typeof cached.subject === 'string' ? cached.subject : ''
              from = typeof cached.from === 'string' ? cached.from : ''
              date = typeof cached.date === 'string' ? cached.date : ''
            }
          } catch { /* cache may be empty */ }
          allItems.push({ id, accountId: aid, folder, uid, subject, from, date })
        }
      } catch { /* ignore */ }
    }
    if (readLaterLoadSeq.current !== seq) return
    setReadLaterItems(allItems)
  }, [accounts])

  useEffect(() => {
    syncingRef.current = syncing
  }, [syncing])

  // §2.99: new-mail OS notifications moved to the main process, which owns them
  // even while every window is closed. The renderer deliberately raises none —
  // a second source here would double every toast.

  // Load settings (IMAP IDLE, appearance, AI) and subscribe to changes.
  useEffect(() => {
    let cancelled = false

    const apply = (s: {
      theme?: unknown
      imapIdleEnabled?: unknown
      syncIntervalMinutes?: unknown
      hiddenUnreadFolders?: unknown
      darkModeEmails?: unknown
      alwaysLoadImages?: unknown
      gravatarInMail?: unknown
      hotkeysPreset?: unknown
      groupConversations?: unknown
      sortMode?: unknown
      autoAdvance?: unknown
      aiProvider?: unknown
      aiPrivacyConsent?: unknown
      aiPanelOpen?: unknown
      aiPanelWidth?: unknown
      aiSendOnEnter?: unknown
      aiShowSources?: unknown
      aiEgressPolicy?: unknown
      aiThreadSummaryEnabled?: unknown
      aiInstantReplyEnabled?: unknown
      aiTranslateEnabled?: unknown
      sentryEnabled?: unknown
      workOffline?: unknown
    } | undefined) => {
      if (!s) return
      const sentryNow = s.sentryEnabled !== false
      setSentryUserEnabled(sentryNow)
      // Re-attach the pseudonymous install-id if the user toggles Sentry back
      // on (setSentryUserEnabled handles the off → null path internally).
      if (sentryNow && window.api?.installIdHash) {
        setSentryUserId(window.api.installIdHash)
      }
      setTheme(s.theme === 'dark' ? 'dark' : 'light')
      setImapIdleEnabled(Boolean(s.imapIdleEnabled ?? true))
      if (typeof s.syncIntervalMinutes === 'number') setSyncIntervalMinutes(s.syncIntervalMinutes)
      if (Array.isArray(s.hiddenUnreadFolders)) setHiddenUnreadFolders(s.hiddenUnreadFolders as string[])
      setDarkModeEmails(Boolean(s.darkModeEmails ?? true))
      setAlwaysLoadImages(Boolean(s.alwaysLoadImages ?? false))
      setGravatarInMail(Boolean(s.gravatarInMail ?? true))
      setHotkeysPreset(s.hotkeysPreset === 'outlook' ? 'outlook' : 'gmail')
      setGroupConversations(Boolean(s.groupConversations ?? true))
      if (s.sortMode === 'date' || s.sortMode === 'from' || s.sortMode === 'subject') setSortMode(s.sortMode)
      if (s.autoAdvance === 'off' || s.autoAdvance === 'newer' || s.autoAdvance === 'older' || s.autoAdvance === 'back_to_list') setAutoAdvance(s.autoAdvance)
      if (typeof s.aiProvider === 'string') setAiProvider(s.aiProvider)
      setAiPrivacyConsent(Boolean(s.aiPrivacyConsent ?? false))
      if (typeof s.aiPanelOpen === 'boolean') setAiPanelOpen(s.aiPanelOpen)
      if (typeof s.aiPanelWidth === 'number') setAiPanelWidth(s.aiPanelWidth)
      setAiSendOnEnter(Boolean(s.aiSendOnEnter ?? true))
      setAiShowSources(Boolean(s.aiShowSources ?? true))
      if (s.aiEgressPolicy === 'default-deny' || s.aiEgressPolicy === 'ask' || s.aiEgressPolicy === 'allow') {
        setAiEgressPolicy(s.aiEgressPolicy)
      } else {
        setAiEgressPolicy('default-deny')
      }
      // §3.3 B2: normalize to a plain Record<string, boolean>; ignore
      // non-boolean/legacy shapes defensively (default OFF).
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
      // §3.3 B6: same normalization for the AI Translate per-account opt-in.
      if (s.aiTranslateEnabled && typeof s.aiTranslateEnabled === 'object') {
        const raw = s.aiTranslateEnabled as Record<string, unknown>
        const next: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(raw)) next[k] = v === true
        setAiTranslateEnabled(next)
      } else {
        setAiTranslateEnabled({})
      }
      setWorkOffline(Boolean(s.workOffline ?? false))
    }

    const fetchAndApply = async () => {
      try {
        const s = await window.api.invoke('settings:get') as {
          theme?: unknown
          imapIdleEnabled?: unknown
          syncIntervalMinutes?: unknown
          hiddenUnreadFolders?: unknown
          darkModeEmails?: unknown
          alwaysLoadImages?: unknown
          gravatarInMail?: unknown
          hotkeysPreset?: unknown
          groupConversations?: unknown
          sortMode?: unknown
          autoAdvance?: unknown
          aiProvider?: unknown
          aiPrivacyConsent?: unknown
          aiPanelOpen?: unknown
          aiPanelWidth?: unknown
          aiSendOnEnter?: unknown
          aiShowSources?: unknown
          aiEgressPolicy?: unknown
          aiThreadSummaryEnabled?: unknown
          aiInstantReplyEnabled?: unknown
          aiTranslateEnabled?: unknown
          sentryEnabled?: unknown
        } | undefined
        if (!cancelled) apply(s)
      } catch {
        // ignore
      }
    }

    void fetchAndApply()

    const onSettingsChanged = (s: unknown) => {
      if (s && typeof s === 'object') apply(s as {
        theme?: unknown
        imapIdleEnabled?: unknown
        syncIntervalMinutes?: unknown
        hiddenUnreadFolders?: unknown
        darkModeEmails?: unknown
        alwaysLoadImages?: unknown
        gravatarInMail?: unknown
        hotkeysPreset?: unknown
        groupConversations?: unknown
        sortMode?: unknown
        autoAdvance?: unknown
        aiProvider?: unknown
        aiPrivacyConsent?: unknown
        aiPanelOpen?: unknown
        aiPanelWidth?: unknown
        aiSendOnEnter?: unknown
        aiShowSources?: unknown
        aiEgressPolicy?: unknown
        aiThreadSummaryEnabled?: unknown
        aiInstantReplyEnabled?: unknown
        aiTranslateEnabled?: unknown
        sentryEnabled?: unknown
      })
      else void fetchAndApply()
    }

    window.api?.on('settings:changed', onSettingsChanged)
    return () => {
      cancelled = true
      window.api?.off('settings:changed', onSettingsChanged)
    }
  }, [])

  // Phishing-aware link-click pipeline (IDN/http/mismatch/unsafeBypass checks).
  // mail:link IPC listener is attached and cleaned up inside the hook.
  const { linkPrompt, dismissPrompt, approvePrompt } = useMailLinkClick(
    (errMsg) => setError(tRef.current('app.errors.openExternal', { error: presentedError(tRef.current, errMsg) })),
  )

  // TLS trust rework Phase A3 — cert-recovery dialog + interception notices.
  // All logic (queue, re-probe, net:trustCert / cert:dismiss invoke) lives in
  // the hook; App only renders the dialog and notice banners.
  const {
    dialog: certDialog,
    notices: certNotices,
    trust: trustCert,
    dismiss: dismissCert,
    dismissNotice: dismissCertNotice,
  } = useCertRecovery()

  // §2.157 — accounts whose credentials main saw fail repeatedly. State and
  // IPC live in the hook; App only turns ids into labelled strips.
  const { needsReauth: accountsNeedingReauth, openAccountSettings: openAccountForReauth } =
    useAccountAuthState()

  // When opening a new message: reset local view states (banner/modals).
  useEffect(() => {
    if (!activeKey) return
    dismissPrompt()
    setShowExternalImages(alwaysLoadImagesRef.current)
  }, [activeKey, dismissPrompt])

  // If the user enabled "Always load images" — show images immediately.
  useEffect(() => {
    if (alwaysLoadImages) setShowExternalImages(true)
  }, [alwaysLoadImages])

  // Build a safe srcdoc for the message — full pipeline (sanitize → cid:
  // inline → external-image extract/fetch/replace → CSP wrap) lives in
  // useMailIframeDoc to keep App.tsx from growing the §3.10 security
  // pipeline inline (hotspot policy, CLAUDE.md §5).
  const {
    doc: mailIframeDoc,
    hasExternalImages: mailHasExternalImages,
    // §2.128: the parts whose chip the list drops. Passed straight to
    // MailBodyContent — one decision, one owner (the hook that substituted
    // their bytes).
    hiddenAttachments: mailHiddenAttachments,
  } = useMailIframeDoc({
    active,
    details,
    alwaysLoadImages,
    showExternalImages,
    darkModeEmails,
    theme,
    quotedTextLabel: t('mail.thread.showQuoted'),
  })

  // Handle Ctrl+P shortcut forwarded from main process — trigger iframe print.
  useEffect(() => {
    window.api?.on('mail:print', printMailIframe)
    return () => { window.api?.off('mail:print', printMailIframe) }
  }, [printMailIframe])

  // Subscribe to auto-update events
  useEffect(() => {
    const onAvailable = (payload: unknown) => {
      const data = payload as { version?: string; canSelfUpdate?: boolean }
      setUpdateVersion(String(data.version ?? payload))
      setCanSelfUpdate(data.canSelfUpdate !== false)
      setUpdateReady(false)
      setUpdateDownloading(false)
    }
    const onDownloaded = () => {
      setUpdateReady(true)
      setUpdateDownloading(false)
    }
    window.api?.on('update:available', onAvailable)
    window.api?.on('update:downloaded', onDownloaded)
    return () => {
      window.api?.off('update:available', onAvailable)
      window.api?.off('update:downloaded', onDownloaded)
    }
  }, [])

  // IMAP IDLE: start/stop push updates for INBOX.
  useEffect(() => {
    if (!imapIdleEnabled || typeof currentAccountId !== 'number') {
      void window.api.invoke('net:idleStop').catch(() => {})
      return
    }
    void window.api.invoke('net:idleStart', currentAccountId, 'INBOX').catch(() => {})
    return () => { void window.api.invoke('net:idleStop').catch(() => {}) }
  }, [currentAccountId, imapIdleEnabled])

  // Push events from the main process: update counts and (if needed) fetch INBOX.
  useEffect(() => {
    const onExists = (payload: unknown) => {
      const data = payload as { accountId?: unknown; path?: unknown; count?: unknown; prevCount?: unknown; force?: unknown }
      const accountId = typeof data.accountId === 'number' ? data.accountId : NaN
      const path = typeof data.path === 'string' ? data.path : ''
      const count = typeof data.count === 'number' ? data.count : 0
      const prevCount = typeof data.prevCount === 'number' ? data.prevCount : 0
      const force = data.force === true
      if (!Number.isFinite(accountId) || accountId <= 0) return
      if (!path || (!force && count <= prevCount)) return

      if (idleRefreshTimer.current) window.clearTimeout(idleRefreshTimer.current)
      idleRefreshTimer.current = window.setTimeout(() => {
        void (async () => {
          try {
            // §2.7 iter2: snapshot pending-move epoch BEFORE the await so we
            // can drop a stale list response that was filtered against an
            // older pending-move set than the renderer currently believes is
            // active (e.g. user undid a move while this fetch was in flight).
            const epochBefore = pendingMoveEpochRef.current
            const raw = await window.api.invoke('net:inboxSummaries', accountId, path) as MailSummary[]
            if (pendingMoveEpochRef.current !== epochBefore) return
            const list = filterSnoozed(applyUnreadOverrides(accountId, path, raw, 'remote'))

            // If this is the current folder of the selected account and we are not searching — update the message list.
            const isCurrent =
              viewMode === 'account' &&
              accountId === currentAccountId &&
              path === currentFolder
            if (isCurrent && !q) {
              setMails(list)
              cursorBeforeUid.current = list.length > 0 ? list[list.length - 1].uid : undefined
              setHasMore(list.length >= PAGE_SIZE)
            }
          } catch { /* ignore */ }

          // Update folder counts from SQLite (without IMAP folder list request).
          // Scheduled through the debounced hook — coalesces with any cold-
          // start init/sync refresh already pending for this account. Fire-
          // and-forget: this path does not need to block on completion.
          refreshCountsRef.current.schedule(accountId)
        })()
      }, 600)
    }

    window.api?.on('mail:exists', onExists)
    return () => {
      window.api?.off('mail:exists', onExists)
      if (idleRefreshTimer.current) {
        window.clearTimeout(idleRefreshTimer.current)
        idleRefreshTimer.current = null
      }
    }
  }, [applyUnreadOverrides, currentAccountId, currentFolder, filterSnoozed, q, setHasMore, viewMode])

  // clearSendUndo — from useUndoSystem

  useEffect(() => {
    const onQueueChanged = (payload: unknown) => {
      const data = payload as { accountId?: unknown } | undefined
      const changedAccountId = (data && typeof data.accountId === 'number') ? data.accountId : null
      if (typeof currentAccountId !== 'number') return
      if (changedAccountId !== null && changedAccountId !== currentAccountId) return
      void loadOutbox(currentAccountId)
    }
    window.api?.on('mail:queueChanged', onQueueChanged)
    return () => {
      window.api?.off('mail:queueChanged', onQueueChanged)
    }
  }, [currentAccountId, loadOutbox])

  useEffect(() => {
    if (!isOutboxFolder) return
    void loadOutbox()
  }, [isOutboxFolder, loadOutbox])

  useEffect(() => {
    if (typeof currentAccountId !== 'number') {
      setOutboxItems([])
      return
    }
    void loadOutbox(currentAccountId)
  }, [currentAccountId, loadOutbox])

  // Snooze: subscribe to events and load data
  useEffect(() => {
    const onSnoozeChanged = () => {
      // Reload data for all accounts for correct badges
      void loadSnoozed()
    }
    const onSnoozeWake = (payload: unknown) => {
      const data = payload as { uid?: unknown; folder?: unknown } | undefined
      if (data) {
        const n = new Notification(t('snooze.wakeNotification'), { body: String(data.folder ?? '') })
        n.onclick = () => { window.focus() }
      }
      void loadSnoozed()
    }
    window.api?.on('mail:snoozeChanged', onSnoozeChanged)
    window.api?.on('mail:snoozeWake', onSnoozeWake)
    return () => {
      window.api?.off('mail:snoozeChanged', onSnoozeChanged)
      window.api?.off('mail:snoozeWake', onSnoozeWake)
    }
  }, [loadSnoozed, t])

  useEffect(() => {
    if (!isSnoozedFolder) return
    void loadSnoozed()
  }, [isSnoozedFolder, loadSnoozed])

  // Load snooze data for all accounts (for correct badges and filtering)
  useEffect(() => {
    void loadSnoozed()
  }, [loadSnoozed])

  // Follow-up: subscribe to events and load data
  useEffect(() => {
    const onFollowUpDue = (payload: unknown) => {
      const data = payload as { toAddr?: unknown; subject?: unknown } | undefined
      if (data) {
        const addr = typeof data.toAddr === 'string' ? data.toAddr : ''
        const subj = typeof data.subject === 'string' ? data.subject : ''
        const n = new Notification(t('followUp.notificationTitle'), {
          body: t('followUp.notificationBody', { address: addr, subject: subj }),
        })
        n.onclick = () => { window.focus() }
      }
      if (typeof currentAccountId === 'number') void loadFollowUps(currentAccountId)
    }
    window.api?.on('mail:followUpDue', onFollowUpDue)
    return () => {
      window.api?.off('mail:followUpDue', onFollowUpDue)
    }
  }, [currentAccountId, loadFollowUps, t])

  // Notification about background send failure (when Compose is already closed).
  useEffect(() => {
    const onSendFailed = (payload: unknown) => {
      const data = payload as { error?: string; subject?: string } | undefined
      const subject = data?.subject || t('compose.title')
      const error = data?.error || 'Unknown error'
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(t('notifications.sendFailed'), {
            body: `${subject}: ${error}`,
          })
        } catch { /* ignore */ }
      }
      setError(t('notifications.sendFailed') + ': ' + error)
    }
    window.api?.on('mail:sendFailed', onSendFailed)
    return () => { window.api?.off('mail:sendFailed', onSendFailed) }
  }, [t])

  // Sync folder progress — live updates for statusbar.
  // Auto-clear after 90s of no updates to prevent stale progress when sync stalls.
  useEffect(() => {
    let staleTimer: ReturnType<typeof setTimeout> | null = null
    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => setSyncFolderProgress(null), 15_000)
    }
    const onProgress = (payload: unknown) => {
      const d = payload as { account?: string; folder?: string; fetched?: number; total?: number | null; done?: boolean } | undefined
      if (!d) return
      if (d.done) {
        setSyncFolderProgress(prev => {
          if (prev && prev.folder === d.folder) return null
          return prev
        })
      } else {
        const total = typeof d.total === 'number' ? d.total : null
        if (total != null && total <= 50) return
        setSyncFolderProgress({
          account: typeof d.account === 'string' ? d.account : '',
          folder: typeof d.folder === 'string' ? d.folder : '',
          fetched: typeof d.fetched === 'number' ? d.fetched : 0,
          total,
        })
        resetStaleTimer()
      }
    }
    window.api?.on('sync:folderProgress', onProgress)
    return () => {
      window.api?.off('sync:folderProgress', onProgress)
      if (staleTimer) clearTimeout(staleTimer)
    }
  }, [])

  useEffect(() => {
    if (!isFollowUpFolder) return
    void loadFollowUps()
  }, [isFollowUpFolder, loadFollowUps])

  useEffect(() => {
    if (typeof currentAccountId !== 'number') {
      setFollowUpItems([])
      return
    }
    void loadFollowUps(currentAccountId)
  }, [currentAccountId, loadFollowUps])

  // Read Later: subscribe to events and load data
  useEffect(() => {
    const onReadLaterChanged = () => { void loadReadLater() }
    window.api?.on('mail:readLaterChanged', onReadLaterChanged)
    return () => { window.api?.off('mail:readLaterChanged', onReadLaterChanged) }
  }, [loadReadLater])

  useEffect(() => {
    if (!isReadLaterFolder) return
    void loadReadLater()
  }, [isReadLaterFolder, loadReadLater])

  useEffect(() => {
    void loadReadLater()
  }, [loadReadLater])

  // Load accounts, folders and initial UI initialization
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        setInitDone(false)
        setError('')
        const list = await window.api.invoke('accounts:list') as AccountMeta[]
        if (cancelled) return

        setAccounts(list)
        if (list.length === 0) {
          await window.api.invoke('ui:openAccount')
          return
        }

        const cur = await window.api.invoke('accounts:getCurrent') as number | undefined
        if (cancelled) return
        const chosen = (typeof cur === 'number' && list.some(a => a.id === cur)) ? cur : list[0].id
        setCurrentAccountId(chosen)
        if (cur !== chosen) {
          void window.api.invoke('accounts:setCurrent', chosen).catch(() => {})
        }

        // Reset local "pending" unread tracking so a cold start does not carry
        // optimistic deltas from the previous session into the folder badges.
        invalidateContext()
        resetLocalPending()
        console.debug('[active→null] init-load')
        setActive(null)
        setSelectedKeys(new Set())
        selectionAnchorKey.current = null
        setDetails(null)
        setQ('')

        // Entry point: open INBOX of the selected account.
        // Important: do this before any await in this effect, otherwise parallel auto-sync
        // may fill the message list, and we would then overwrite it with `setMails([])`.
        setViewMode('account')
        setUnifiedAccountFilter('all')
        setCurrentFolder('INBOX')
        setMails([])
        cursorBeforeUid.current = undefined
        unifiedCursor.current = undefined
        setHasMore(true)

        // Quick start: immediately show INBOX cache of the selected account.
        try {
          // §2.7 iter2: epoch guard — discard if pending-move set changed
          // mid-flight (user moved/undid during this fetch).
          const epochBefore = pendingMoveEpochRef.current
          const cachedRaw = await window.api.invoke('cache:inboxPage', chosen, 'INBOX', PAGE_SIZE, undefined) as MailSummary[]
          if (pendingMoveEpochRef.current !== epochBefore) {
            // Stale: skip — a fresher fetch will be triggered by whatever
            // moved the pending registry.
          } else if (!cancelled) {
            const cached = applyUnreadOverrides(chosen, 'INBOX', cachedRaw, 'cache')
            setMails(cached)
            cursorBeforeUid.current = cached.length > 0 ? cached[cached.length - 1].uid : undefined
            setHasMore(cached.length >= PAGE_SIZE)
          }
        } catch {
          // ignore
        }

        // Instant loading of cached roles from SQLite (stale-while-revalidate).
        // Allows archiving/deleting messages immediately without waiting for IMAP.
        try {
          const cachedRolesMap = await window.api.invoke('cache:folderRoles') as Record<number, Record<string, string | undefined>> | null
          if (cachedRolesMap && !cancelled) {
            for (const [accountIdStr, cachedRoles] of Object.entries(cachedRolesMap)) {
              const aid = Number(accountIdStr)
              if (Number.isFinite(aid) && cachedRoles) {
                rolesByAccount.current.set(aid, cachedRoles as FolderRoles)
                if (aid === chosen) setRoles(cachedRoles as FolderRoles)
              }
            }
          }
        } catch {
          // Cache unavailable — not critical, roles will be loaded from IMAP below.
        }

        // Instant loading of cached folder_prefs (visible, includeInBadges, etc.).
        // Without this, the sidebar would show ALL folders until IMAP sync completes.
        try {
          const cachedPrefsMap = await window.api.invoke('cache:folderPrefs') as Record<number, FolderPreference[]> | null
          if (cachedPrefsMap && !cancelled) {
            for (const [accountIdStr, prefsList] of Object.entries(cachedPrefsMap)) {
              const aid = Number(accountIdStr)
              if (Number.isFinite(aid) && Array.isArray(prefsList)) {
                const prefsMap: Record<string, FolderPreference> = {}
                for (const p of prefsList) prefsMap[p.folderPath] = p
                folderPrefsByAccount.current.set(aid, prefsMap)
              }
            }
          }
        } catch {
          // Cache unavailable — not critical, prefs will be loaded after IMAP sync.
        }

        // Instant loading of cached mailboxes from SQLite (stale-while-revalidate).
        // Allows showing the sidebar with folders immediately without waiting for IMAP.
        try {
          const cachedMbMap = await window.api.invoke('cache:mailboxes') as Record<number, Mailbox[]> | null
          if (cachedMbMap && !cancelled) {
            for (const [accountIdStr, mailboxes] of Object.entries(cachedMbMap)) {
              const aid = Number(accountIdStr)
              if (Number.isFinite(aid) && Array.isArray(mailboxes)) {
                const cachedRoles = rolesByAccount.current.get(aid) ?? {} as FolderRoles
                const sorted = sortFolders(mailboxes, cachedRoles)
                foldersByAccount.current.set(aid, sorted)
                if (aid === chosen) setFolders(sorted)
              }
            }
          }
        } catch {
          // Cache unavailable — not critical, mailboxes will be loaded from IMAP below.
        }

        // Apply DB-based unread counts to cached mailboxes (instant badges before IMAP sync).
        // §1.4: schedule via the per-account debounce hook so the post-IMAP
        // sync below and the mail:exists IDLE handler coalesce into one
        // effective call per account during the cold-start boot window.
        for (const a of list) {
          refreshCountsRef.current.schedule(a.id)
        }

        // Initialization complete — allow auto-sync.
        // Cached roles+mailboxes+INBOX already loaded, sidebar and mail list are displayed.
        // IMAP folder/mail refresh happens below in the background.
        setInitDone(true)

        // Background sync of all accounts on startup:
        // 0) refresh folders/roles from IMAP (stale-while-revalidate — cache already shown),
        // 1) full/periodic backfill of INBOX headers (per prefs),
        // 2) refresh latest 50 messages and counters.
        void (async () => {
          for (const a of list) {
            if (cancelled) return
            setConnectionStatus(prev => {
              const next = new Map(prev)
              next.set(a.id, 'syncing')
              return next
            })
            try {
              // Refresh folders/roles from IMAP (cache already shown in sidebar).
              try {
                const res = await window.api.invoke('net:mailboxesAndRoles', a.id) as MailboxesAndRoles
                if (cancelled) return
                applyMbRolesRef.current(a.id, res, { setCurrent: a.id === currentAccountIdRef.current })
              } catch {
                // IMAP unavailable — sidebar shows cache, not critical.
              }

              // Sync INBOX headers — wrapped in try/catch so badge refresh always runs.
              try {
                const inboxPref = (folderPrefsByAccount.current.get(a.id) ?? {}).INBOX
                const mode = inboxPref?.headerSyncMode ?? 'full'
                const days = inboxPref?.headerSyncDays ?? 30
                if (mode === 'full' || mode === 'period') {
                  await window.api.invoke(
                    'net:syncFolderHeaders',
                    a.id,
                    'INBOX',
                    mode === 'period'
                      ? { mode: 'period', days: Math.max(1, days) }
                      : { mode: 'full' },
                  )
                }
              } catch {
                // IMAP unavailable for header sync — not critical, cache already shown.
              }

              // Fetch latest INBOX summaries — wrapped in try/catch so badge refresh always runs.
              try {
                const raw = await window.api.invoke('net:inboxSummaries', a.id, 'INBOX') as MailSummary[]
                if (cancelled) return
                // The result is intentionally unused: on a 'remote' list this
                // call reconciles optimistic unread overrides against the fresh
                // server flags and drops the ones the server has caught up
                // with. Dropping it would strand pending deltas and desync the
                // folder badges.
                applyUnreadOverrides(a.id, 'INBOX', raw, 'remote')
              } catch {
                // IMAP unavailable for inbox summaries — not critical.
              }

              // Refresh counters from DB — ALWAYS runs even if IMAP is offline.
              // §1.4: scheduled via the debounce hook to coalesce with the
              // init DB-apply above (fires at t≈0) and the mail:exists IDLE
              // handler. Not awaited — the block below that rehydrates the
              // visible INBOX reads from cache:inboxPage, which does not
              // depend on folder:refreshCounts completion.
              if (!cancelled) refreshCountsRef.current.schedule(a.id)

              if (
                a.id === currentAccountIdRef.current
                && currentFolderRef.current === 'INBOX'
                && viewModeRef.current === 'account'
                && !qRef.current
              ) {
                // §2.7 iter2: epoch guard — see IDLE refresh handler above.
                const epochBefore = pendingMoveEpochRef.current
                const refreshedRaw = await window.api.invoke('cache:inboxPage', a.id, 'INBOX', PAGE_SIZE, undefined) as MailSummary[]
                if (cancelled) return
                if (pendingMoveEpochRef.current !== epochBefore) {
                  // Pending-move state shifted — drop this stale page; the
                  // transition that bumped the epoch will trigger its own
                  // refresh.
                } else {
                  const refreshed = applyUnreadOverrides(a.id, 'INBOX', refreshedRaw, 'cache')
                  setMails(refreshed)
                  cursorBeforeUid.current = refreshed.length > 0 ? refreshed[refreshed.length - 1].uid : undefined
                  setHasMore(refreshed.length >= PAGE_SIZE)
                }
              }

              // Background: sync headers for non-INBOX folders sequentially WITHIN account.
              // Each account has its own queue — accounts sync in parallel, folders sequential.
              if (!bgFolderSyncDone.current.has(a.id)) {
                bgFolderSyncDone.current.add(a.id)
                const accountPrefs = folderPrefsByAccount.current.get(a.id) ?? {}
                const aid = a.id
                const foldersToSync = Object.entries(accountPrefs)
                  .filter(([fp, pref]) => fp !== 'INBOX' && pref.headerSyncMode !== 'off')
                bgSyncQueue.current = bgSyncQueue.current.then(async () => {
                  for (const [folderPath, pref] of foldersToSync) {
                    if (cancelled) break
                    try {
                      const BG_FOLDER_SYNC_TIMEOUT = 10 * 60_000
                      await Promise.race([
                        window.api.invoke(
                          'net:syncFolderHeaders', aid, folderPath,
                          pref.headerSyncMode === 'period'
                            ? { mode: 'period', days: Math.max(1, pref.headerSyncDays ?? 30) }
                            : { mode: 'full' },
                        ),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('folder sync timeout')), BG_FOLDER_SYNC_TIMEOUT)),
                      ])
                    } catch {
                      // Folder failed or timed out — skip to next folder
                    }
                  }
                }).catch(() => {})
              }

              // Periodic retry for error/partial folders (every 2 minutes)
              if (!bgFolderRetryTimers.current.has(a.id)) {
                const aid = a.id
                const timer = setInterval(() => {
                  if (cancelled) return
                  window.api.invoke('search:crawlStates', [aid]).then((states) => {
                    const rows = states as Array<{ accountId: number; folderPath: string; status: string }> | undefined
                    if (!Array.isArray(rows)) return
                    const retryFolders = rows.filter(r => r.status === 'error' || r.status === 'covered_recent')
                    if (retryFolders.length === 0) return
                    bgSyncQueue.current = bgSyncQueue.current.then(async () => {
                      for (const ef of retryFolders) {
                        if (cancelled) break
                        const accountPrefs = folderPrefsByAccount.current.get(aid) ?? {}
                        const pref = accountPrefs[ef.folderPath]
                        const syncMode = pref?.headerSyncMode ?? 'full'
                        if (syncMode === 'off') continue
                        try {
                          const BG_FOLDER_SYNC_TIMEOUT = 10 * 60_000
                          await Promise.race([
                            window.api.invoke(
                              'net:syncFolderHeaders', aid, ef.folderPath,
                              syncMode === 'period'
                                ? { mode: 'period', days: Math.max(1, pref?.headerSyncDays ?? 30) }
                                : { mode: 'full' },
                            ),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('folder sync timeout')), BG_FOLDER_SYNC_TIMEOUT)),
                          ])
                        } catch {
                          // Skip to next folder on error/timeout
                        }
                      }
                    }).catch(() => {})
                  }).catch(() => {})
                }, 2 * 60 * 1000)
                bgFolderRetryTimers.current.set(a.id, timer)
              }

              setConnectionStatus(prev => {
                const next = new Map(prev)
                next.set(a.id, 'ok')
                return next
              })
            } catch {
              setConnectionStatus(prev => {
                const next = new Map(prev)
                next.set(a.id, 'error')
                return next
              })
            }
          }
        })()
      } catch (e) {
        if (!cancelled) setError(tRef.current('app.errors.load', { error: presentedError(tRef.current, e) }))
      }
    }

    void load()

    const onAccountsChanged = (payload?: unknown) => {
      const data = payload as { kind?: unknown; id?: unknown } | undefined
      const kind = (data && typeof data === 'object' && typeof data.kind === 'string') ? data.kind : ''
      const id = (data && typeof data === 'object' && typeof data.id === 'number') ? data.id : NaN

      // Current account switch may come from another window (Account).
      // In that case, switch locally without a full reload(),
      // otherwise we may clear the mail list `setMails([])` and skip auto-sync.
      if (kind === 'current' && Number.isFinite(id) && id > 0) {
        if (currentAccountIdRef.current === id) return
        setCurrentAccountId(id)

        // Refresh visible folders/roles from local cache (no IMAP).
        // Always reset — otherwise stale folders from previous account may remain if cache is empty.
        const cachedRoles = rolesByAccount.current.get(id)
        const cachedFolders = foldersByAccount.current.get(id)
        setRoles(cachedRoles ?? {} as FolderRoles)
        setFolders(cachedFolders ?? [])

        if (viewModeRef.current === 'account') {
          invalidateContext()
          setQ('')
          setCurrentFolder('INBOX')
          console.debug('[active→null] accounts-changed-current')
          setActive(null)
          setSelectedKeys(new Set())
          selectionAnchorKey.current = null
          setDetails(null)
          setLoadingBody(false)
          setMails([])
          cursorBeforeUid.current = undefined
          unifiedCursor.current = undefined
          setHasMore(true)
        }
        return
      }

      // Account settings saved: refresh metadata and prefs from DB
      // without reloading folder list from IMAP (prevents flickering).
      if (kind === 'saved' && Number.isFinite(id) && id > 0) {
        void (async () => {
          try {
            const list = await window.api.invoke('accounts:list') as AccountMeta[]
            setAccounts(list)
            // Refresh folder prefs from DB (may have changed in settings).
            const res = await window.api.invoke('folder:prefs:list', id) as FolderPreference[]
            const prefsMap: Record<string, FolderPreference> = {}
            for (const p of res) prefsMap[p.folderPath] = p
            folderPrefsByAccount.current.set(id, prefsMap)
            // Refresh counters from DB. User just saved account settings —
            // runNow cancels any pending debounced background refresh for
            // this account and fires immediately so the new prefs are
            // reflected in the sidebar without waiting for the 500ms tail.
            await refreshCountsRef.current.runNow(id)
            // Refresh roles and folders from IMAP — folderRoles may have changed in settings
            // (e.g., user assigned Archive to "All Mail").
            const mbRes = await window.api.invoke('net:mailboxesAndRoles', id) as MailboxesAndRoles
            applyMbRolesRef.current(id, mbRes, { setCurrent: id === currentAccountIdRef.current })
          } catch { /* ignore */ }
        })()
        return
      }

      console.debug('[active→null] accounts-changed-fallback-reload kind=', kind)
      void load()
    }
    window.api?.on('accounts:changed', onAccountsChanged)
    const retryTimers = bgFolderRetryTimers.current
    return () => {
      cancelled = true
      window.api?.off('accounts:changed', onAccountsChanged)
      for (const t of retryTimers.values()) clearInterval(t)
      retryTimers.clear()
    }
  }, [applyUnreadOverrides, invalidateContext, resetLocalPending, selectionAnchorKey, setHasMore, setSelectedKeys])

  const syncFolder = useCallback(async (folder?: string, opts?: { force?: boolean; skipCache?: boolean; ignoreFolderPolicy?: boolean; lightweight?: boolean }) => {
    const f = folder || currentFolder
    if (typeof currentAccountId !== 'number') return
    if (viewMode !== 'account' && !opts?.force) return
    if (f === OUTBOX_FOLDER) {
      await loadOutbox(currentAccountId)
      return
    }
    if (f === SNOOZED_FOLDER) {
      await loadSnoozed()
      return
    }
    if (f === FOLLOWUP_FOLDER) {
      await loadFollowUps(currentAccountId)
      return
    }
    if (f === READLATER_FOLDER) {
      await loadReadLater()
      return
    }
    invalidateContext()
    const aid = currentAccountId
    const mySync = ++syncOpSeq.current
    try {
      setError('')
      setSyncing(true)
      setConnectionStatus(prev => { const m = new Map(prev); m.set(aid, 'syncing'); return m })
      const pref = (folderPrefsByAccount.current.get(aid) ?? {})[f]
      const folderVisible = pref?.visible ?? true
      const headerSyncMode = pref?.headerSyncMode ?? (f === 'INBOX' ? 'full' : 'on_open')
      const headerSyncDays = pref?.headerSyncDays ?? 30

      if (!folderVisible && !opts?.ignoreFolderPolicy) {
        setConnectionStatus(prev => { const m = new Map(prev); m.set(aid, 'ok'); return m })
        return
      }

      if (!opts?.skipCache) {
        try {
          // §2.7 iter2: epoch guard — drop stale list response if pending-move
          // set changed mid-flight.
          const epochBefore = pendingMoveEpochRef.current
          const cachedRaw = await window.api.invoke('cache:inboxPage', aid, f, PAGE_SIZE, undefined) as MailSummary[]
          if (
            pendingMoveEpochRef.current === epochBefore
            && currentAccountIdRef.current === aid
            && currentFolderRef.current === f
            && viewModeRef.current === 'account'
          ) {
            const cached = applyUnreadOverrides(aid, f, cachedRaw, 'cache')
            setMails(cached)
            cursorBeforeUid.current = cached.length > 0 ? cached[cached.length - 1].uid : undefined
            setHasMore(cached.length >= PAGE_SIZE)
          }
        } catch {
          // ignore
        }
      }

      if (headerSyncMode === 'full' || headerSyncMode === 'period') {
        const syncKey = `${aid}:${f}:${headerSyncMode}:${headerSyncDays}`
        if (!headerSyncInFlight.current.has(syncKey)) {
          const promise = window.api
            .invoke(
              'net:syncFolderHeaders',
              aid,
              f,
              headerSyncMode === 'period'
                ? { mode: 'period', days: Math.max(1, headerSyncDays) }
                : { mode: 'full' },
            )
            .then(async () => {
              if (currentAccountIdRef.current !== aid || currentFolderRef.current !== f || viewModeRef.current !== 'account' || qRef.current) return
              // §2.7 iter2: epoch guard — see cache:inboxPage above.
              const epochBefore = pendingMoveEpochRef.current
              const refreshedRaw = await window.api.invoke('cache:inboxPage', aid, f, PAGE_SIZE, undefined) as MailSummary[]
              if (pendingMoveEpochRef.current !== epochBefore) return
              const refreshed = applyUnreadOverrides(aid, f, refreshedRaw, 'cache')
              setMails(refreshed)
              cursorBeforeUid.current = refreshed.length > 0 ? refreshed[refreshed.length - 1].uid : undefined
              setHasMore(refreshed.length >= PAGE_SIZE)
            })
            .catch(() => {})
            .finally(() => {
              headerSyncInFlight.current.delete(syncKey)
            })
          headerSyncInFlight.current.set(syncKey, promise)
        }
      }

      if (headerSyncMode === 'off' && !opts?.ignoreFolderPolicy) {
        setConnectionStatus(prev => { const m = new Map(prev); m.set(aid, 'ok'); return m })
        return
      }

      // §2.7 iter2: epoch guard — drop stale list if pending-move set
      // changed mid-flight (concurrent moveWithUndo / handleUndo / 5s fire).
      const epochBefore = pendingMoveEpochRef.current
      const raw = await window.api.invoke('net:inboxSummaries', aid, f, opts?.lightweight) as MailSummary[]
      // Apply result only if user is still in this account/folder and no active search.
      if (currentAccountIdRef.current !== aid || currentFolderRef.current !== f || viewModeRef.current !== 'account' || qRef.current) return
      if (pendingMoveEpochRef.current !== epochBefore) return
      const list = filterSnoozed(applyUnreadOverrides(aid, f, raw, 'remote'))
      setMails(list)
      cursorBeforeUid.current = list.length > 0 ? list[list.length - 1].uid : undefined
      setHasMore(list.length >= PAGE_SIZE)
      setConnectionStatus(prev => { const m = new Map(prev); m.set(aid, 'ok'); return m })
      // Refresh only counters from SQLite cache (no IMAP folder list request).
      // runNow cancels any pending debounced refresh for this account and
      // fires immediately — syncFolder runs after a visible IMAP fetch and
      // its caller awaits completion for UI coherence.
      try {
        await refreshCountsRef.current.runNow(aid)
      } catch { /* ignore */ }
    } catch (e) {
      const handled = await maybeRecoverAuthIssue(aid, e)
      if (!handled && currentAccountIdRef.current === aid && viewModeRef.current === 'account') {
        setError(t('app.errors.sync', { error: presentedError(t, e) }))
      }
      setConnectionStatus(prev => { const m = new Map(prev); m.set(aid, 'error'); return m })
    } finally {
      if (syncOpSeq.current === mySync) setSyncing(false)
    }
  }, [applyUnreadOverrides, currentAccountId, currentFolder, filterSnoozed, invalidateContext, loadFollowUps, loadOutbox, loadReadLater, loadSnoozed, maybeRecoverAuthIssue, setHasMore, t, viewMode])

  // Drops any in-flight search request and clears the search lifecycle so
  // a stale worker response cannot clobber the new view, and infinite-scroll
  // cannot keep paginating the previous query in a different folder/account.
  // Must be called from every context-switch path (switchFolder, switchToUnified, selectAccount).
  const resetSearchLifecycle = useCallback(() => {
    // Cancel any pending debounced search so a stale val captured by setTimeout
    // can't fire onSearch in the new context after navigation.
    if (searchDebounceRef.current) {
      window.clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = null
    }
    searchSeqRef.current++
    activeSearchRef.current = null
    setSearching(false)
    setPaginatingSearch(false)
    // Don't touch globalCoverageStats — it's owned by the 30s statusbar refresh.
    setRemoteResultCount(0)
    void window.api.invoke('search:cancelInflight').catch(() => { /* best effort */ })
  }, [])

  const switchFolder = useCallback((folder: string) => {
    if (viewMode === 'account' && folder === currentFolder) return
    invalidateContext()
    resetSearchLifecycle()
    setQ('')
    if (viewMode !== 'account') setViewMode('account')
    setCurrentFolder(folder)
    // Log the folder's ROLE, never its path: renderer console output becomes a
    // Sentry breadcrumb (src/sentry.ts), and folder names are server-controlled
    // text the consent screen promises we do not collect.
    console.debug('[active→null] switchFolder', folderRoleFromPath(folder))
    setActive(null)
    setSelectedKeys(new Set())
    selectionAnchorKey.current = null
    setDetails(null)
    setLoadingBody(false)
    setMails([])
    cursorBeforeUid.current = undefined
    setHasMore(folder === OUTBOX_FOLDER || folder === SNOOZED_FOLDER || folder === FOLLOWUP_FOLDER || folder === READLATER_FOLDER ? false : true)
  }, [currentFolder, invalidateContext, resetSearchLifecycle, selectionAnchorKey, setHasMore, setSelectedKeys, viewMode])

  const toggleSidebar = useCallback(() => {
    setSidebarExpanded(prev => {
      const next = !prev
      localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  const upsertFolderPref = useCallback(async (accountId: number, folderPath: string, patch: {
    visible?: boolean
    includeInBadges?: boolean
    headerSyncMode?: 'full' | 'on_open' | 'period' | 'off'
    headerSyncDays?: number
    offlineMode?: 'off' | 'period' | 'full'
    offlineDays?: number
    icon?: string
    // §2.15-ter (codex iteration 4): per-folder search-index gate.
    indexInSearch?: boolean
  }) => {
    const res = await window.api.invoke('folder:prefs:upsert', accountId, folderPath, patch) as { ok: boolean; pref?: FolderPreference }
    if (!res?.ok || !res.pref) return
    const byPath = { ...(folderPrefsByAccount.current.get(accountId) ?? {}) }
    byPath[folderPath] = res.pref
    folderPrefsByAccount.current.set(accountId, byPath)
  }, [])

  // Auto-sync on account/folder change (skip during search).
  // Skip until init effect completes to prevent IMAP connection races.
  useEffect(() => {
    if (!initDone) return
    if (viewMode !== 'account') return
    if (typeof currentAccountId !== 'number') return
    if (q) return
    void syncFolder(undefined, { force: true })
  }, [currentAccountId, currentFolder, initDone, q, syncFolder, viewMode])

  const applyUnreadOverridesForMixedList = useCallback((list: MailSummary[], source: 'remote' | 'cache') => {
    if (list.length === 0) return list
    const grouped = new Map<string, { accountId: number; folder: string; items: MailSummary[] }>()
    for (const m of list) {
      const k = `${m.accountId}:${m.folder}`
      const g = grouped.get(k)
      if (g) g.items.push(m)
      else grouped.set(k, { accountId: m.accountId, folder: m.folder, items: [m] })
    }

    const byKey = new Map<MailKey, MailSummary>()
    for (const g of grouped.values()) {
      const patched = applyUnreadOverrides(g.accountId, g.folder, g.items, source)
      for (const m of patched) byKey.set(mailKey(m), m)
    }

    // Preserve original list order (by date, etc.)
    return list.map(m => byKey.get(mailKey(m)) ?? m)
  }, [applyUnreadOverrides])

  // Stable refs for callbacks used inside the unified-load effect.
  // Prevents the effect from re-running when `t` or the override helpers get new references
  // (e.g. on window focus → i18n.changeLanguage → new `t` → cascading re-creation).
  const applyUnreadOverridesRef = useRef(applyUnreadOverrides)
  applyUnreadOverridesRef.current = applyUnreadOverrides
  const applyUnreadOverridesForMixedListRef = useRef(applyUnreadOverridesForMixedList)
  applyUnreadOverridesForMixedListRef.current = applyUnreadOverridesForMixedList

  // Load Unified Inbox (first page) when entering unified mode and/or when account filter changes.
  useEffect(() => {
    if (viewMode !== 'unified') return
    if (q) return // don't overwrite search results with auto-load

    const idsRaw = unifiedAccountFilter === 'all'
      ? accounts.map(a => a.id)
      : [unifiedAccountFilter]
    const validIds = idsRaw.filter(id => accounts.some(a => a.id === id))
    const ids = validIds.length > 0 ? validIds : accounts.map(a => a.id)
    if (ids.length === 0) return

    // If selected account disappeared — reset filter to "all".
    if (unifiedAccountFilter !== 'all' && validIds.length === 0) setUnifiedAccountFilter('all')

    invalidateContext()
    const seq = ctxSeq.current
    setError('')
    unifiedCursor.current = undefined
    setHasMore(true)
    setMails([])
    console.debug('[active→null] unified-load')
    setActive(null)
    setSelectedKeys(new Set())
    selectionAnchorKey.current = null
    setDetails(null)
    setLoadingBody(false)
    setSyncing(true)

    void (async () => {
      try {
        try {
          // 1) Quickly show cache (if incomplete — catch up with sync below).
          // §2.7 iter2: epoch guard — drop stale unified-inbox response if
          // pending-move set changed mid-flight.
          const epochBefore = pendingMoveEpochRef.current
          const raw = await window.api.invoke('cache:unifiedInboxPage', ids, PAGE_SIZE, undefined) as MailSummary[]
          if (ctxSeq.current !== seq) return
          if (pendingMoveEpochRef.current !== epochBefore) return
          const list = applyUnreadOverridesForMixedListRef.current(raw, 'cache')
          setMails(list)
          unifiedCursor.current = list.length > 0
            ? { date: list[list.length - 1].date, accountId: list[list.length - 1].accountId, uid: list[list.length - 1].uid }
            : undefined
          setHasMore(list.length >= PAGE_SIZE)
        } catch (e) {
          if (ctxSeq.current === seq) setError(tRef.current('app.errors.load', { error: presentedError(tRef.current, e) }))
        }

        // 2) On entering unified, sync INBOX of selected accounts so the aggregate is complete.
        try {
          for (const id of ids) {
            try {
              const raw = await window.api.invoke('net:inboxSummaries', id, 'INBOX') as MailSummary[]
              if (ctxSeq.current !== seq) return
              // Result unused on purpose — see the reconciliation note above.
              applyUnreadOverridesRef.current(id, 'INBOX', raw, 'remote')
            } catch {
              // ignore
            }
          }

          // Refresh folder counters from DB (no IMAP folder list request).
          // runNow per account — unified view reloads below awaits the
          // counters settled state for correct badges across accounts.
          for (const id of ids) {
            try {
              if (ctxSeq.current !== seq) return
              await refreshCountsRef.current.runNow(id)
            } catch {
              // ignore
            }
          }

          unifiedCursor.current = undefined
          // §2.7 iter2: epoch guard — see switchToUnified cache:unifiedInboxPage above.
          const epochBefore = pendingMoveEpochRef.current
          const raw = await window.api.invoke('cache:unifiedInboxPage', ids, PAGE_SIZE, undefined) as MailSummary[]
          if (ctxSeq.current !== seq) return
          if (pendingMoveEpochRef.current !== epochBefore) return
          const list = applyUnreadOverridesForMixedListRef.current(raw, 'cache')
          setMails(list)
          unifiedCursor.current = list.length > 0
            ? { date: list[list.length - 1].date, accountId: list[list.length - 1].accountId, uid: list[list.length - 1].uid }
            : undefined
          setHasMore(list.length >= PAGE_SIZE)
        } catch (e) {
          if (ctxSeq.current === seq) setError(tRef.current('app.errors.sync', { error: presentedError(tRef.current, e) }))
        }
      } finally {
        if (ctxSeq.current === seq) setSyncing(false)
      }
    })()
  // Callbacks used inside are accessed via refs to avoid re-running on reference changes
  // (e.g. `t` changes on window focus → cascades through the callbacks → effect re-runs
  // → setActive(null) → email disappears).  Only true data deps trigger a reload.
  }, [
    accounts,
    invalidateContext,
    q,
    selectionAnchorKey,
    setHasMore,
    setSelectedKeys,
    unifiedAccountFilter,
    viewMode,
  ])

  const switchToUnified = useCallback(() => {
    if (!hasAccount) return
    if (viewMode === 'unified') return
    invalidateContext()
    resetSearchLifecycle()
    setQ('')
    setSearchScope('all')
    setViewMode('unified')
    // The rest of the state reset is handled by the useEffect above (which loads the first page).
  }, [hasAccount, invalidateContext, resetSearchLifecycle, viewMode])

  const selectAccount = useCallback((accountId: number, folder?: string) => {
    if (!accountsById.has(accountId)) return
    invalidateContext()
    resetSearchLifecycle()
    setQ('')
    setSearchScope('account')
    setViewMode('account')
    setCurrentAccountId(accountId)
    void window.api.invoke('accounts:setCurrent', accountId).catch(() => {})
    setCurrentFolder(folder || 'INBOX')
    console.debug('[active→null] switchToAccount', accountId)
    setActive(null)
    setSelectedKeys(new Set())
    selectionAnchorKey.current = null
    setDetails(null)
    setLoadingBody(false)
    setMails([])
    cursorBeforeUid.current = undefined
    unifiedCursor.current = undefined
    setHasMore(true)

    // Update UI from local folder/role cache (no IMAP call).
    // Always reset — otherwise stale folders from previous account may remain if cache is empty.
    const cachedRoles = rolesByAccount.current.get(accountId)
    const cachedFolders = foldersByAccount.current.get(accountId)
    setRoles(cachedRoles ?? {} as FolderRoles)
    setFolders(cachedFolders ?? [])

    // If folders are not loaded (IMAP was unavailable) — try to fetch in the background.
    if (!cachedFolders) {
      void (async () => {
        try {
          const res = await window.api.invoke('net:mailboxesAndRoles', accountId) as MailboxesAndRoles
          applyMbRolesRef.current(accountId, res, { setCurrent: true })
        } catch {
          // IMAP still unavailable — sidebar will remain empty.
        }
      })()
    }
  }, [accountsById, invalidateContext, resetSearchLifecycle, selectionAnchorKey, setHasMore, setSelectedKeys])

  const loadPage = useCallback(async () => {
    if (loading.current || !hasMore.current) return
    if (isOutboxFolder || isSnoozedFolder) return
    const seq = ctxSeq.current
    loading.current = true
    try {
      // Search pagination: continue the active query at the next offset.
      const search = activeSearchRef.current
      if (search) {
        const searchSeq = searchSeqRef.current
        setPaginatingSearch(true)
        // Dedup against rows already in the list — applies to BOTH sort modes because
        // remote IMAP fallback can have merged results into either, and a later local
        // page from cache may include the same UIDs.
        // For sort=date: re-sort the merged list; remote dates are valid.
        // For sort=relevance: splice new local BM25-ordered rows BEFORE any rows
        //   injected by remote fallback, so ordering stays (local_page_1, local_page_2,
        //   …, remote_tail). Without this, remote rows — which have no BM25 rank — sit
        //   above subsequent local pages and break relevance order.
        const mergeRows = (prev: MailSummary[], rows: MailSummary[]): MailSummary[] => {
          const seen = new Set(prev.map(m => `${m.accountId}:${m.folder}:${m.uid}`))
          const fresh = rows.filter(m => !seen.has(`${m.accountId}:${m.folder}:${m.uid}`))
          if (fresh.length === 0) return prev
          if (search.sort === 'date') {
            return [...prev, ...fresh].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          }
          const remoteKeys = search.remoteKeys
          if (!remoteKeys || remoteKeys.size === 0) return [...prev, ...fresh]
          // Partition prev into [localPart, remotePart]. Remote rows are always
          // appended to the tail in reverse-date order by the remote fallback,
          // so the remote block is contiguous at the end; but we scan explicitly
          // to stay correct even if that invariant ever shifts.
          const localPart: MailSummary[] = []
          const remotePart: MailSummary[] = []
          for (const m of prev) {
            const key = `${m.accountId}:${m.folder}:${m.uid}`
            if (remoteKeys.has(key)) remotePart.push(m)
            else localPart.push(m)
          }
          return [...localPart, ...fresh, ...remotePart]
        }
        if (search.kind === 'unified') {
          const raw = await window.api.invoke(
            'cache:unifiedSearch',
            search.accountIds,
            search.query,
            PAGE_SIZE,
            search.offset,
            search.scope,
            search.sort,
          ) as MailSummary[]
          if (ctxSeq.current !== seq || searchSeqRef.current !== searchSeq || activeSearchRef.current !== search) return
          const rows = applyUnreadOverridesForMixedList(raw, 'cache')
          if (rows.length > 0) {
            setMails(prev => mergeRows(prev, rows))
            search.offset += rows.length
          }
          if (rows.length < PAGE_SIZE) setHasMore(false)
        } else {
          const raw = await window.api.invoke(
            'cache:search',
            search.accountId,
            search.folder,
            search.query,
            PAGE_SIZE,
            search.offset,
            search.sort,
          ) as MailSummary[]
          if (ctxSeq.current !== seq || searchSeqRef.current !== searchSeq || activeSearchRef.current !== search) return
          const rows = applyUnreadOverrides(search.accountId, search.folder, raw, 'cache')
          if (rows.length > 0) {
            setMails(prev => mergeRows(prev, rows))
            search.offset += rows.length
          }
          if (rows.length < PAGE_SIZE) setHasMore(false)
        }
        return
      }

      if (viewMode === 'unified') {
        const ids = unifiedAccountFilter === 'all'
          ? accounts.map(a => a.id)
          : [unifiedAccountFilter]
        if (ids.length === 0) { setHasMore(false); return }

        // §2.7 iter2: epoch guard — drop stale append page if pending-move
        // set changed mid-flight (would let a moved UID appear in older
        // pages even though its first page already excluded it).
        const epochBefore = pendingMoveEpochRef.current
        const cachedRaw = await window.api.invoke('cache:unifiedInboxPage', ids, PAGE_SIZE, unifiedCursor.current) as MailSummary[]
        if (ctxSeq.current !== seq) return
        if (pendingMoveEpochRef.current !== epochBefore) return
        const cached = applyUnreadOverridesForMixedList(cachedRaw, 'cache')
        if (cached.length > 0) {
          setMails(prev => [...prev, ...cached])
          const last = cached[cached.length - 1]
          unifiedCursor.current = { date: last.date, accountId: last.accountId, uid: last.uid }
        }
        if (cached.length < PAGE_SIZE) setHasMore(false)
        return
      }

      if (typeof currentAccountId !== 'number') { setHasMore(false); return }

      // Paginate backwards (older messages): fetch mails with UID < cursorBeforeUid.
      const beforeUid = cursorBeforeUid.current

      // 1) First try from local cache
      // §2.7 iter2: epoch guard — see unified path above.
      const epochBeforeCache = pendingMoveEpochRef.current
      const cachedRaw = await window.api.invoke('cache:inboxPage', currentAccountId, currentFolder, PAGE_SIZE, beforeUid) as MailSummary[]
      if (ctxSeq.current !== seq) return
      if (pendingMoveEpochRef.current !== epochBeforeCache) return
      const cached = applyUnreadOverrides(currentAccountId, currentFolder, cachedRaw, 'cache')
      if (cached.length > 0) {
        setMails(prev => [...prev, ...cached])
        cursorBeforeUid.current = cached[cached.length - 1].uid
      }

      // 2) If cache is insufficient — fetch from IMAP and append to UI immediately
      if (cached.length < PAGE_SIZE) {
        const pref = (folderPrefsByAccount.current.get(currentAccountId) ?? {})[currentFolder]
        const folderVisible = pref?.visible ?? true
        if (!folderVisible) {
          setHasMore(false)
          return
        }
        const headerSyncMode = pref?.headerSyncMode ?? (currentFolder === 'INBOX' ? 'full' : 'on_open')
        if (headerSyncMode === 'off') {
          setHasMore(false)
          return
        }
        const remaining = PAGE_SIZE - cached.length
        const remoteBeforeUid = cached.length > 0 ? cached[cached.length - 1].uid : beforeUid
        // §2.7 iter2: epoch guard — see unified path above.
        const epochBeforeRemote = pendingMoveEpochRef.current
        const remoteRaw = await window.api.invoke('net:folderPage', currentAccountId, currentFolder, remaining, remoteBeforeUid) as MailSummary[]
        if (ctxSeq.current !== seq) return
        if (pendingMoveEpochRef.current !== epochBeforeRemote) return
        const remote = filterSnoozed(applyUnreadOverrides(currentAccountId, currentFolder, remoteRaw, 'remote'))
        if (remote.length > 0) {
          setMails(prev => [...prev, ...remote])
          cursorBeforeUid.current = remote[remote.length - 1].uid
        }
        if (remote.length < remaining) setHasMore(false)
      }
    } catch (e) {
      // Search pagination can be cancelled mid-flight when the user types a new query;
      // that's expected, not an error worth surfacing.
      // `msg` is for the cancellation probe only — the presentation tag is a
      // prefix, so substring matching is unaffected — and never for display.
      const msg = e instanceof Error ? e.message : String(e)
      if (/Search request cancelled/i.test(msg)) return
      if (ctxSeq.current === seq) setError(t('app.errors.load', { error: presentedError(t, e) }))
    } finally {
      loading.current = false
      setPaginatingSearch(false)
    }
  }, [accounts, applyUnreadOverrides, applyUnreadOverridesForMixedList, currentAccountId, currentFolder, filterSnoozed, isOutboxFolder, isSnoozedFolder, setHasMore, t, unifiedAccountFilter, viewMode])

  const syncCurrentView = useCallback(async (opts?: { lightweight?: boolean }) => {
    if (!hasAccount) return

    if (viewMode === 'unified') {
      const idsRaw = unifiedAccountFilter === 'all'
        ? accounts.map(a => a.id)
        : [unifiedAccountFilter]
      const validIds = idsRaw.filter(id => accounts.some(a => a.id === id))
      const ids = validIds.length > 0 ? validIds : accounts.map(a => a.id)
      if (ids.length === 0) return

      invalidateContext()
      const seq = ctxSeq.current
      try {
        setError('')
        setSyncing(true)

        for (const id of ids) {
          setConnectionStatus(prev => { const m = new Map(prev); m.set(id, 'syncing'); return m })
          try {
            const raw = await window.api.invoke('net:inboxSummaries', id, 'INBOX', opts?.lightweight) as MailSummary[]
            if (ctxSeq.current !== seq) return
            // Result unused on purpose — see the reconciliation note above.
            applyUnreadOverrides(id, 'INBOX', raw, 'remote')
            setConnectionStatus(prev => { const m = new Map(prev); m.set(id, 'ok'); return m })
          } catch {
            setConnectionStatus(prev => { const m = new Map(prev); m.set(id, 'error'); return m })
          }
        }

        // Refresh folder counters from DB (no IMAP folder list request).
        // runNow — unified view awaits counters settled state for accurate
        // aggregate badges.
        for (const id of ids) {
          try {
            if (ctxSeq.current !== seq) return
            await refreshCountsRef.current.runNow(id)
          } catch {
            // ignore
          }
        }

        // If user is not searching — redraw unified from cache.
        if (!q) {
          unifiedCursor.current = undefined
          // §2.7 iter2: epoch guard — drop stale unified-inbox response if
          // pending-move set changed mid-flight.
          const epochBefore = pendingMoveEpochRef.current
          const raw = await window.api.invoke('cache:unifiedInboxPage', ids, PAGE_SIZE, undefined) as MailSummary[]
          if (ctxSeq.current !== seq) return
          if (pendingMoveEpochRef.current !== epochBefore) return
          const list = applyUnreadOverridesForMixedList(raw, 'cache')
          setMails(list)
          unifiedCursor.current = list.length > 0
            ? { date: list[list.length - 1].date, accountId: list[list.length - 1].accountId, uid: list[list.length - 1].uid }
            : undefined
          setHasMore(list.length >= PAGE_SIZE)
        }
      } catch (e) {
        if (ctxSeq.current === seq) setError(t('app.errors.sync', { error: presentedError(t, e) }))
      } finally {
        if (ctxSeq.current === seq) setSyncing(false)
      }
      return
    }

    await syncFolder(undefined, { force: true, ignoreFolderPolicy: true, lightweight: opts?.lightweight })
  }, [
    accounts,
    applyUnreadOverrides,
    applyUnreadOverridesForMixedList,
    hasAccount,
    invalidateContext,
    q,
    setHasMore,
    syncFolder,
    t,
    unifiedAccountFilter,
    viewMode,
  ])

  // Background sync (polling): don't touch search results and don't run in parallel with manual sync.
  useEffect(() => {
    if (!hasAccount) return
    const id = window.setInterval(() => {
      if (syncingRef.current) return
      if (document.visibilityState !== 'visible') return
      if (q) return // don't overwrite search results
      void syncCurrentView({ lightweight: true })
    }, syncIntervalMinutes * 60_000)
    return () => window.clearInterval(id)
  }, [hasAccount, q, syncCurrentView, syncIntervalMinutes])

  const openMail = useCallback(async (m: MailSummary) => {
    const seq = ctxSeq.current
    const myOpen = ++openSeq.current
    setActive(m)
    // The opened message stands for its row in the selection, whichever message
    // of the row it is — selection is a row property and every consumer resolves
    // membership through `row.items` (`rowIsSelected`). No mapping here: `m` may
    // arrive before its row exists (notification, assistant link, snooze
    // wake-up), and mapping what the list does not hold yet is what turned this
    // into a deferred-reconciliation problem. See `rowLeadKeyFor`'s doc comment.
    const selKey = mailKey(m)
    setSelectedKeys(new Set([selKey]))
    selectionAnchorKey.current = selKey
    setDetails(null)
    setLoadingBody(true)
    // §2.17 Phase 0 — renderer Sentry span around the full open path.
    // Gives end-to-end (click → details rendered) wall time including IPC
    // round-trip; pairs with the main-side histogram
    // 'net.message_details.wall_ms' which carries cache_hit_level. Span is
    // null when telemetry is disabled by the user — see startManualSpan.
    const openSpan = startManualSpan({
      name: 'mail.open',
      op: 'mail.open',
    })
    let openSpanEnded = false
    const endOpenSpan = (
      attrs?: { body_size_bucket?: string; attachments_count?: number; offline_fallback?: boolean },
    ) => {
      if (openSpanEnded || !openSpan) return
      openSpanEnded = true
      try {
        if (attrs?.body_size_bucket !== undefined) openSpan.setAttribute('body_size_bucket', attrs.body_size_bucket)
        if (attrs?.attachments_count !== undefined) openSpan.setAttribute('attachments_count', attrs.attachments_count)
        if (attrs?.offline_fallback !== undefined) openSpan.setAttribute('offline_fallback', attrs.offline_fallback)
      } catch { /* telemetry must never throw */ }
      openSpan.end()
    }
    try {
      const d = await window.api.invoke('net:messageDetails', m.accountId, m.folder, m.uid) as MessageDetails
      if (ctxSeq.current !== seq || openSeq.current !== myOpen) {
        endOpenSpan()
        return
      }

      setDetails(d)
      setLoadingBody(false)
      endOpenSpan({
        body_size_bucket: bucketBodySizeRenderer(d),
        attachments_count: d.attachments?.length ?? 0,
        offline_fallback: d.offlineFallback === true,
      })

      // Auto-mark as read on open — optimistic UI update, then IMAP in background.
      if (m.unread) {
        // Optimistic: update UI immediately
        setMails(prev => prev.map(x => (
          x.accountId === m.accountId && x.folder === m.folder && x.uid === m.uid ? { ...x, unread: false } : x
        )))
        setActive(sel => (
          sel && sel.accountId === m.accountId && sel.folder === m.folder && sel.uid === m.uid ? { ...sel, unread: false } : sel
        ))
        bumpFolderUnreadPending(m.accountId, m.folder, -1)
        recordPendingUnread(m.accountId, m.folder, m.uid, false)
        // IMAP sync in background (fire-and-forget)
        void window.api.invoke('net:setSeen', m.accountId, m.folder, [m.uid], true).catch(() => {})
      }
    } catch (e) {
      if (ctxSeq.current === seq && openSeq.current === myOpen) setError(t('app.errors.loadMessage', { error: presentedError(t, e) }))
      endOpenSpan()
    } finally {
      if (ctxSeq.current === seq && openSeq.current === myOpen) setLoadingBody(false)
      // Cover the cancellation path where setDetails was never called.
      endOpenSpan()
    }
  }, [bumpFolderUnreadPending, recordPendingUnread, selectionAnchorKey, setSelectedKeys, t])

  // §2.145 — "show full message" for a soft-capped body. Owns its own in-flight
  // flag and drops a result whose message is no longer the open one; see the
  // hook. Feeds `setDetails` directly because the re-parse returns the SAME
  // message, only less clipped.
  const { loadingFull, requestFullMessage } = useShowFullMessage(
    active ? { accountId: active.accountId, folder: active.folder, uid: active.uid } : null,
    setDetails,
  )

  // Ref for auto-focus: allows calling openMail from removeFromUi/removeManyFromUi without circular dependencies.
  const openMailRef = useRef(openMail)
  openMailRef.current = openMail

  // `m` is always the row lead (the Virtuoso row renders `row.lead`), and this is
  // where selection is brought onto leads — the moment of a user action, when the
  // rows certainly exist. `row` also steers the plain-click OPEN target: a bold
  // row must open the message that makes it bold (see `pickThreadOpenTarget`),
  // otherwise the click leaves the folder counter untouched and the row bold
  // forever.
  const onMailClick = useCallback((e: React.MouseEvent, m: MailSummary, row?: ThreadRow) => {
    const k = mailKey(m)
    // Multi-select: Ctrl/Cmd toggles, Shift selects range.
    if (e.shiftKey) {
      const anchor = selectionAnchorKey.current
      const list = viewMailsRef.current
      if (!anchor) {
        setSelectedKeys(new Set([k]))
        selectionAnchorKey.current = k
        return
      }
      let aIdx = list.findIndex(x => mailKey(x) === anchor)
      if (aIdx < 0) {
        // The anchor is whatever message was last selected, and opening leaves a
        // mid-thread one there routinely. `list` holds row leads only, so map the
        // anchor through its row now — at click time the rows are loaded, which
        // is exactly why this is done here and not when the anchor was set.
        const anchorLead = leadKeyOfRowContaining(threadRowsRef.current, anchor)
        if (anchorLead !== null) aIdx = list.findIndex(x => mailKey(x) === anchorLead)
      }
      const bIdx = list.findIndex(x => mailKey(x) === k)
      if (aIdx < 0 || bIdx < 0) {
        setSelectedKeys(new Set([k]))
        selectionAnchorKey.current = k
        return
      }
      const start = Math.min(aIdx, bIdx)
      const end = Math.max(aIdx, bIdx)
      setSelectedKeys(new Set(list.slice(start, end + 1).map(x => mailKey(x))))
      return
    }

    if (e.ctrlKey || e.metaKey) {
      // Toggling the ROW, not the lead key: the row may be selected through any
      // of its messages, so `toggleRowSelection` owns the whole rule.
      const next = toggleRowSelection(row ?? rowContaining(threadRowsRef.current, m), selectedKeys)
      setSelectedKeys(next.keys)
      selectionAnchorKey.current = next.anchorKey
      return
    }

    void openMail(row ? pickThreadOpenTarget(row) : m)
  }, [openMail, selectedKeys, selectionAnchorKey, setSelectedKeys, threadRowsRef, viewMailsRef])

  const onDragStartMail = useCallback((e: React.DragEvent, m: MailSummary) => {
    if (viewMode !== 'account') return
    // Dragging a selected row drags every MESSAGE of every selected row, each
    // with the folder it was read from (§2.238) — the lead's UID alone dropped
    // the rest of the conversation and travelled without its mailbox.
    // Membership is asked through `rowIsSelected` / `row.items`, never through
    // `selectedKeys.has(leadKey)` (CLAUDE.md §5).
    const refs = dragSelectionRefs(threadRowsRef.current, m, selectedKeys)
    e.dataTransfer.setData(DRAG_MAILREFS_MIME, serializeMailRefs(refs))
    e.dataTransfer.effectAllowed = 'move'
  }, [selectedKeys, threadRowsRef, viewMode])

  // --- Mail actions ---

  const removeFromUi = useCallback((target: { accountId: number; folder: string; uid: number }) => {
    const k = `${target.accountId}:${target.folder}:${target.uid}`
    const isRemovingActive = active && mailKey(active) === k

    setMails(ms => ms.filter(m => mailKey(m) !== k))

    // Auto-advance: if removing active mail — navigate based on autoAdvance setting.
    if (isRemovingActive) {
      const list = viewMailsRef.current
      // `list` holds row leads only, while the active message is routinely a
      // mid-thread one — looking its own key up here would miss and disable
      // auto-advance entirely. Locate the ROW that contains it instead.
      const leadKey = rowLeadKeyFor(threadRowsRef.current, target)
      const idx = list.findIndex(m => mailKey(m) === leadKey)
      const next = findNextAfterRemoval(list, idx, autoAdvance, new Set([k]), mailKey)
      if (next) {
        void openMailRef.current(next)
      } else {
        console.debug('[active→null] removeFromUi-noNext')
        setActive(null)
        setDetails(null)
      }
    }

    setSelectedKeys(prev => {
      if (!prev.has(k)) return prev
      const next = new Set(prev)
      next.delete(k)
      return next
    })
    if (selectionAnchorKey.current === k) selectionAnchorKey.current = null
  }, [active, autoAdvance, selectionAnchorKey, setSelectedKeys, threadRowsRef, viewMailsRef])

  const setSeenForMail = useCallback(async (m: MailSummary, seen: boolean) => {
    const seq = ctxSeq.current
    const beforeUnread = m.unread
    const afterUnread = !seen
    const delta = (afterUnread ? 1 : 0) - (beforeUnread ? 1 : 0)
    try {
      await window.api.invoke('net:setSeen', m.accountId, m.folder, [m.uid], seen)
      if (ctxSeq.current !== seq) return
      setMails(prev => prev.map(x => (
        x.accountId === m.accountId && x.folder === m.folder && x.uid === m.uid ? { ...x, unread: afterUnread } : x
      )))
      setActive(sel => (
        sel && sel.accountId === m.accountId && sel.folder === m.folder && sel.uid === m.uid ? { ...sel, unread: afterUnread } : sel
      ))
      if (delta !== 0) bumpFolderUnreadPending(m.accountId, m.folder, delta)
      if (beforeUnread !== afterUnread) recordPendingUnread(m.accountId, m.folder, m.uid, afterUnread)
    } catch (e) {
      if (ctxSeq.current === seq) setError(t('app.errors.markSeen', { error: presentedError(t, e) }))
    }
  }, [bumpFolderUnreadPending, recordPendingUnread, t])

  const setFlaggedForMail = useCallback(async (m: MailSummary, flagged: boolean) => {
    const seq = ctxSeq.current
    try {
      await window.api.invoke('net:setFlagged', m.accountId, m.folder, [m.uid], flagged)
      if (ctxSeq.current !== seq) return
      setMails(prev => prev.map(x => (
        x.accountId === m.accountId && x.folder === m.folder && x.uid === m.uid ? { ...x, flagged } : x
      )))
      setActive(sel => (
        sel && sel.accountId === m.accountId && sel.folder === m.folder && sel.uid === m.uid ? { ...sel, flagged } : sel
      ))
    } catch (e) {
      if (ctxSeq.current === seq) setError(t('app.errors.flag', { error: presentedError(t, e) }))
    }
  }, [t])

  const togglePin = useCallback(async (m: MailSummary) => {
    const newPinned = !m.pinned
    try {
      await window.api.invoke('mail:togglePin', m.accountId, m.folder, m.uid, newPinned)
      setMails(prev => prev.map(mail =>
        mail.accountId === m.accountId && mail.folder === m.folder && mail.uid === m.uid
          ? { ...mail, pinned: newPinned }
          : mail,
      ))
      setActive(sel => (
        sel && sel.accountId === m.accountId && sel.folder === m.folder && sel.uid === m.uid ? { ...sel, pinned: newPinned } : sel
      ))
    } catch (e) {
      setError(t('app.errors.pin', { error: presentedError(t, e) }))
    }
  }, [t])

  const removeManyFromUi = useCallback((msgs: { accountId: number; folder: string; uid: number }[]) => {
    if (msgs.length === 0) return
    const keys = new Set(msgs.map(m => `${m.accountId}:${m.folder}:${m.uid}`))
    const isRemovingActive = active && keys.has(mailKey(active))

    setMails(ms => ms.filter(m => !keys.has(mailKey(m))))

    // Auto-advance: if removing active mail — navigate based on autoAdvance setting.
    if (isRemovingActive) {
      const list = viewMailsRef.current
      // Same as in removeFromUi: `list` is row leads, the active message may sit
      // mid-thread, so index by the lead of the row that contains it.
      const leadKey = rowLeadKeyFor(threadRowsRef.current, active!)
      const idx = list.findIndex(m => mailKey(m) === leadKey)
      const next = findNextAfterRemoval(list, idx, autoAdvance, keys, mailKey)
      if (next) {
        void openMailRef.current(next)
      } else {
        console.debug('[active→null] removeManyFromUi-noNext')
        setActive(null)
        setDetails(null)
      }
    }

    setSelectedKeys(prev => {
      if (prev.size === 0) return prev
      const next = new Set(prev)
      for (const k of keys) next.delete(k)
      return next
    })
    if (selectionAnchorKey.current && keys.has(selectionAnchorKey.current)) selectionAnchorKey.current = null
  }, [active, autoAdvance, selectionAnchorKey, setSelectedKeys, threadRowsRef, viewMailsRef])

  // Background archive notification (Send & Archive via queue)
  useEffect(() => {
    const onBackgroundArchived = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const data = payload as Record<string, unknown>
      const accountId = typeof data.accountId === 'number' ? data.accountId : undefined
      const folder = typeof data.folder === 'string' ? data.folder : undefined
      const uids = Array.isArray(data.uids) && data.uids.every((u: unknown) => typeof u === 'number') ? data.uids as number[] : undefined
      if (!accountId || !folder || !uids) return
      removeManyFromUi(uids.map(uid => ({ accountId, folder, uid })))
    }
    window.api?.on('mail:backgroundArchived', onBackgroundArchived)
    return () => { window.api?.off('mail:backgroundArchived', onBackgroundArchived) }
  }, [removeManyFromUi])

  // --- Undo: state, timers and effects in useUndoSystem ---
  const {
    undoInfo, undoCountdown,
    sendUndoInfo, sendUndoCountdown,
    undoInfoRef,
    moveWithUndo: rawMoveWithUndo, handleUndo,
    handleSendUndo, clearSendUndo, scheduleSendUndo,
  } = useUndoSystem({
    currentFolder,
    currentAccountIdRef,
    removeManyFromUi,
    bumpFolderUnreadPending,
    clearPendingUnread,
    setMails,
    setError,
    loadOutbox,
    t,
    pendingMoveEpochRef,
  })

  // Wrap moveWithUndo to also increment Inbox Zero counter
  const moveWithUndo = useCallback((...args: Parameters<typeof rawMoveWithUndo>) => {
    rawMoveWithUndo(...args)
    inboxZeroIncrement(args[1].length)
  }, [rawMoveWithUndo, inboxZeroIncrement])

  // mail:queued subscription effect — must come after useUndoSystem (clearSendUndo, scheduleSendUndo).
  useEffect(() => {
    const onQueued = (payload: unknown) => {
      const data = payload as { id?: unknown; accountId?: unknown; sendAt?: unknown; source?: unknown } | undefined
      const id = (data && typeof data.id === 'string') ? data.id : ''
      const accountId = (data && typeof data.accountId === 'number') ? data.accountId : NaN
      const sendAt = (data && typeof data.sendAt === 'string') ? data.sendAt : ''
      const source = (data && typeof data.source === 'string') ? data.source : ''
      if (!id || !Number.isFinite(accountId) || accountId <= 0 || !sendAt) return
      if (source !== 'delay') return

      const sendAtMs = new Date(sendAt).getTime()
      if (!Number.isFinite(sendAtMs)) return

      scheduleSendUndo({ id, accountId, sendAt })
    }

    window.api?.on('mail:queued', onQueued)
    return () => {
      window.api?.off('mail:queued', onQueued)
      clearSendUndo()
    }
  }, [clearSendUndo, scheduleSendUndo])

  const setSeenForMany = useCallback(async (seen: boolean) => {
    const selected = expandBulkToThreads(selectedKeys, mails, threadRows, groupConversations)
    if (selected.length === 0) return

    const seq = ctxSeq.current
    const afterUnread = !seen
    const keySet = new Set(selected.map(m => mailKey(m)))

    const groups = new Map<string, { accountId: number; folder: string; uids: number[]; delta: number }>()
    for (const m of selected) {
      const k = `${m.accountId}:${m.folder}`
      const g = groups.get(k) ?? { accountId: m.accountId, folder: m.folder, uids: [], delta: 0 }
      g.uids.push(m.uid)
      g.delta += (afterUnread ? 1 : 0) - (m.unread ? 1 : 0)
      groups.set(k, g)
    }

    try {
      for (const g of groups.values()) {
        await window.api.invoke('net:setSeen', g.accountId, g.folder, g.uids, seen)
      }
      if (ctxSeq.current !== seq) return
      setMails(prev => prev.map(x => (keySet.has(mailKey(x)) ? { ...x, unread: afterUnread } : x)))
      setActive(sel => (sel && keySet.has(mailKey(sel)) ? { ...sel, unread: afterUnread } : sel))
      for (const g of groups.values()) {
        if (g.delta !== 0) bumpFolderUnreadPending(g.accountId, g.folder, g.delta)
      }
      for (const m of selected) recordPendingUnread(m.accountId, m.folder, m.uid, afterUnread)
    } catch (e) {
      if (ctxSeq.current === seq) setError(t('app.errors.markSeen', { error: presentedError(t, e) }))
    }
  }, [bumpFolderUnreadPending, groupConversations, mails, recordPendingUnread, selectedKeys, t, threadRows])

  /**
   * §2.238 — moves a set of messages into `toFolder`, dispatching one `net:move`
   * per (account, source folder) group. The source is never `currentFolder` for
   * the whole set: an all-folders search fills the list with rows from several
   * mailboxes, and a UID sent with a foreign folder name addresses whatever
   * message carries that UID there.
   */
  const moveMessagesToFolder = useCallback(async (refs: MailRef[], toFolder: string) => {
    if (viewMode !== 'account') return
    if (typeof currentAccountId !== 'number') return
    if (!toFolder) return

    const plan = planMoveToFolder(refs, { accountId: currentAccountId, folder: toFolder })
    if (plan.groups.length === 0) return

    const seq = ctxSeq.current
    try {
      for (const g of plan.groups) {
        await window.api.invoke('net:move', g.accountId, g.folder, toFolder, g.uids)
        if (ctxSeq.current !== seq) return

        const movedSet = new Set(g.uids)
        const movedMsgs = mails.filter(m => (
          m.accountId === g.accountId && m.folder === g.folder && movedSet.has(m.uid)
        ))
        const unreadMoved = movedMsgs.filter(m => m.unread).length
        if (unreadMoved) {
          bumpFolderUnreadPending(g.accountId, g.folder, -unreadMoved)
          bumpFolderUnreadPending(g.accountId, toFolder, +unreadMoved)
        }
        for (const uid of g.uids) clearPendingUnread(g.accountId, g.folder, uid)
        removeManyFromUi(movedMsgs)
      }
    } catch (e) {
      if (ctxSeq.current === seq) setError(t('app.errors.move', { error: presentedError(t, e) }))
    }
  }, [bumpFolderUnreadPending, clearPendingUnread, currentAccountId, mails, removeManyFromUi, t, viewMode])

  const bulkMove = useCallback(async (toFolder: string) => {
    if (viewMode !== 'account') return
    const msgs = expandBulkToThreads(selectedKeys, mails, threadRows, groupConversations)
    await moveMessagesToFolder(msgs, toFolder)
  }, [groupConversations, mails, moveMessagesToFolder, selectedKeys, threadRows, viewMode])

  /**
   * The folder an account uses for a role. Roles are a property of the ACCOUNT,
   * so they are looked up per account id; the `roles` state is the same map for
   * the current account and stands in until its entry is cached.
   */
  const roleFolderFor = useCallback((accountId: number, role: 'archive' | 'junk' | 'trash'): string | undefined => (
    (rolesByAccount.current.get(accountId) ?? (accountId === currentAccountId ? roles : {}))[role]
  ), [currentAccountId, roles])

  const roleNotFoundLabel = useCallback((role: 'archive' | 'junk' | 'trash'): string => (
    role === 'archive' ? t('mail.actions.archiveNotFound')
      : role === 'junk' ? t('mail.actions.junkNotFound')
        : t('mail.actions.trashNotFound')
  ), [t])

  // Unified-mode helper: group messages by (accountId, folder) and move each group to the target role folder.
  const bulkMoveByRole = useCallback(async (role: 'archive' | 'junk' | 'trash') => {
    const msgs = expandBulkToThreads(selectedKeys, mails, threadRows, groupConversations)
    if (msgs.length === 0) {
      // Silent no-op, matching the account-mode siblings (bulkArchive /
      // bulkSpam / bulkDelete all `return` on an empty expansion). This used to
      // raise an English banner with internal counters in it — hardcoded copy
      // the user cannot act on, and inconsistent with the same gesture in the
      // other view mode. The counters stay, in the console, where they help.
      console.warn('[bulkMoveByRole] empty expansion', {
        role,
        // Both numbers: they differ when rows merged behind the set.
        selectedKeys: selectedKeys.size,
        selectedRows: countSelectedRows(threadRows, selectedKeys),
        mails: mails.length,
      })
      return
    }

    // Group by (accountId, folder) and validate targets before starting.
    // §2.238 — this is the shape every destructive set operation now uses.
    const { groups, missingRole } = planRoleMove(msgs, id => roleFolderFor(id, role))

    if (groups.length === 0) {
      if (missingRole) setError(roleNotFoundLabel(role))
      return
    }

    // Optimistic UI: remove messages immediately, then execute IMAP moves in background.
    // Save snapshot of current mails for rollback on failure.
    const allMsgs = groups.flatMap(g => g.msgs)
    const rollbackSnapshot = mails.filter(m =>
      allMsgs.some(rm => rm.accountId === m.accountId && rm.folder === m.folder && rm.uid === m.uid),
    )
    removeManyFromUi(allMsgs)
    inboxZeroIncrement(allMsgs.length)

    // Fire-and-forget IMAP moves (parallel per group)
    for (const g of groups) {
      window.api.invoke('net:move', g.accountId, g.folder, g.targetFolder, g.uids).then(() => {
        const unreadDelta = g.msgs.filter(m => m.unread).length
        if (unreadDelta) {
          bumpFolderUnreadPending(g.accountId, g.folder, -unreadDelta)
          bumpFolderUnreadPending(g.accountId, g.targetFolder, +unreadDelta)
        }
        for (const uid of g.uids) clearPendingUnread(g.accountId, g.folder, uid)
      }).catch((e) => {
        // Rollback: restore optimistically removed messages and compensate counter
        const keysToRestore = new Set(g.msgs.map(m => `${m.accountId}:${m.folder}:${m.uid}`))
        const restoreMsgs = rollbackSnapshot.filter(m => keysToRestore.has(`${m.accountId}:${m.folder}:${m.uid}`))
        if (restoreMsgs.length > 0) {
          setMails(prev => {
            const existing = new Set(prev.map(m => `${m.accountId}:${m.folder}:${m.uid}`))
            const toAdd = restoreMsgs.filter(m => !existing.has(`${m.accountId}:${m.folder}:${m.uid}`))
            return toAdd.length > 0 ? [...prev, ...toAdd].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')) : prev
          })
          inboxZeroDecrement(restoreMsgs.length)
        }
        setError(t('app.errors.move', { error: presentedError(t, e) }))
      })
    }

    if (missingRole) setError(roleNotFoundLabel(role))
  }, [bumpFolderUnreadPending, clearPendingUnread, groupConversations, inboxZeroDecrement, inboxZeroIncrement, mails, removeManyFromUi, roleFolderFor, roleNotFoundLabel, selectedKeys, setError, setMails, t, threadRows])

  const moveMailToFolder = useCallback(async (m: MailSummary, toFolder: string) => {
    if (!toFolder || toFolder === m.folder) return
    const seq = ctxSeq.current
    // Optimistic UI update: remove from list immediately before IMAP call
    if (m.unread) {
      bumpFolderUnreadPending(m.accountId, m.folder, -1)
      bumpFolderUnreadPending(m.accountId, toFolder, +1)
    }
    clearPendingUnread(m.accountId, m.folder, m.uid)
    removeFromUi({ accountId: m.accountId, folder: m.folder, uid: m.uid })
    inboxZeroIncrement(1)
    try {
      await window.api.invoke('net:move', m.accountId, m.folder, toFolder, [m.uid])
    } catch (e) {
      if (ctxSeq.current === seq) setError(t('app.errors.move', { error: presentedError(t, e) }))
    }
  }, [bumpFolderUnreadPending, clearPendingUnread, inboxZeroIncrement, removeFromUi, t])

  /**
   * §2.238 — sends a role-move plan out as one unawaited `moveMailToFolder` per
   * MESSAGE, each carrying that message's OWN source folder (`m.folder`).
   *
   * That per-message shape is what keeps the §2.238 invariant — a UID never
   * travels with a folder it does not belong to — but it is deliberately not
   * described as a batched per-group move, because it is not one. The calls are
   * independent and optimistic: each removes its row from the list before its
   * `net:move` returns and reports its own failure, so a set that fails halfway
   * leaves the successful part moved with NO rollback. Collapsing a group into a
   * single `net:move` would change the partial-failure semantics (all-or-nothing
   * per group, and a rollback story for the optimistic UI), which is a behaviour
   * change rather than a comment fix.
   *
   * Undo is offered only when the plan has a SINGLE group and that group is the
   * folder currently open: the undo bar replays exactly one (account, folder)
   * pair, so a set spanning two source folders would come back into one of them
   * — most of it foreign there. The affordance is withheld rather than faked
   * (the move itself still happens, per group, immediately).
   */
  const dispatchRoleMove = useCallback((plan: RoleMovePlan<MailSummary>, undoLabel: string) => {
    if (plan.groups.length === 0) return
    const sole = soleGroup(plan.groups)
    if (sole && viewMode === 'account' && sole.accountId === currentAccountId && sole.folder === currentFolder) {
      moveWithUndo(sole.accountId, sole.msgs, sole.folder, sole.targetFolder, undoLabel)
      return
    }
    for (const g of plan.groups) {
      for (const m of g.msgs) void moveMailToFolder(m, g.targetFolder)
    }
  }, [currentAccountId, currentFolder, moveMailToFolder, moveWithUndo, viewMode])

  /**
   * §2.238 — deletion of a set. Groups that can go to their account's trash are
   * moved there per source folder; groups already in trash (or whose account has
   * no trash folder) are the irreversible remainder and go behind the
   * confirmation dialog, each with its own folder. The old code picked one
   * branch for the whole set from the head message's folder.
   */
  const dispatchDelete = useCallback((msgs: MailSummary[], bulk: boolean) => {
    if (msgs.length === 0) return
    const plan = planRoleMove(msgs, id => roleFolderFor(id, 'trash'))
    const movable = new Set(plan.groups.flatMap(g => g.msgs.map(m => mailKey(m))))
    const permanent = groupByAccountFolder(msgs.filter(m => !movable.has(mailKey(m))))
    dispatchRoleMove(plan, t('app.undo.deleted'))
    if (permanent.length > 0) setConfirmDelete({ groups: permanent, bulk })
  }, [dispatchRoleMove, roleFolderFor, t])

  const bulkArchive = useCallback(() => {
    if (viewMode !== 'account') { void bulkMoveByRole('archive'); return }
    const msgs = expandBulkToThreads(selectedKeys, mails, threadRows, groupConversations)
    if (msgs.length === 0) return
    const plan = planRoleMove(msgs, id => roleFolderFor(id, 'archive'))
    if (plan.groups.length === 0) {
      if (plan.missingRole) setError(t('mail.actions.archiveNotFound'))
      return
    }
    dispatchRoleMove(plan, t('app.undo.archived'))
  }, [bulkMoveByRole, dispatchRoleMove, groupConversations, mails, roleFolderFor, selectedKeys, t, threadRows, viewMode])

  const bulkSpam = useCallback(() => {
    if (viewMode !== 'account') { void bulkMoveByRole('junk'); return }
    const msgs = expandBulkToThreads(selectedKeys, mails, threadRows, groupConversations)
    if (msgs.length === 0) return
    const plan = planRoleMove(msgs, id => roleFolderFor(id, 'junk'))
    if (plan.groups.length === 0) {
      if (plan.missingRole) setError(t('mail.actions.junkNotFound'))
      return
    }
    dispatchRoleMove(plan, t('app.undo.spammed'))
  }, [bulkMoveByRole, dispatchRoleMove, groupConversations, mails, roleFolderFor, selectedKeys, t, threadRows, viewMode])

  const bulkDelete = useCallback(() => {
    if (viewMode !== 'account') { void bulkMoveByRole('trash'); return }
    const msgs = expandBulkToThreads(selectedKeys, mails, threadRows, groupConversations)
    if (msgs.length === 0) return
    dispatchDelete(msgs, true)
  }, [bulkMoveByRole, dispatchDelete, groupConversations, mails, selectedKeys, threadRows, viewMode])

  const archiveMailTarget = useCallback((m: MailSummary) => {
    const r = rolesByAccount.current.get(m.accountId) ?? (m.accountId === currentAccountId ? roles : {})
    if (!r.archive) { setError(t('mail.actions.archiveNotFound')); return }
    const items = resolveThreadItems(m, threadRows, groupConversations)
    if (items.length > 1) { setThreadConfirm({ action: 'archive', msgs: items }); return }
    if (viewMode === 'account' && m.accountId === currentAccountId && m.folder === currentFolder) {
      moveWithUndo(m.accountId, [m], m.folder, r.archive, t('app.undo.archived'))
    } else {
      void moveMailToFolder(m, r.archive)
    }
  }, [currentAccountId, currentFolder, groupConversations, moveMailToFolder, moveWithUndo, roles, t, threadRows, viewMode])

  const spamMailTarget = useCallback((m: MailSummary) => {
    const r = rolesByAccount.current.get(m.accountId) ?? (m.accountId === currentAccountId ? roles : {})
    if (!r.junk) { setError(t('mail.actions.junkNotFound')); return }
    const items = resolveThreadItems(m, threadRows, groupConversations)
    if (items.length > 1) { setThreadConfirm({ action: 'spam', msgs: items }); return }
    if (viewMode === 'account' && m.accountId === currentAccountId && m.folder === currentFolder) {
      moveWithUndo(m.accountId, [m], m.folder, r.junk, t('app.undo.spammed'))
    } else {
      void moveMailToFolder(m, r.junk)
    }
  }, [currentAccountId, currentFolder, groupConversations, moveMailToFolder, moveWithUndo, roles, t, threadRows, viewMode])

  const deleteMailTarget = useCallback(async (m: MailSummary) => {
    const r = rolesByAccount.current.get(m.accountId) ?? (m.accountId === currentAccountId ? roles : {})
    const items = resolveThreadItems(m, threadRows, groupConversations)
    if (items.length > 1) { setThreadConfirm({ action: 'delete', msgs: items }); return }
    if (r.trash && m.folder !== r.trash) {
      // Move to trash: in account mode — with undo, otherwise — immediately.
      if (viewMode === 'account' && m.accountId === currentAccountId && m.folder === currentFolder) {
        moveWithUndo(m.accountId, [m], m.folder, r.trash, t('app.undo.deleted'))
      } else {
        await moveMailToFolder(m, r.trash)
      }
      return
    }

    // Permanently from trash — confirm. One message, so one group, but it still
    // carries its own folder rather than the folder the list is showing.
    setConfirmDelete({ groups: groupByAccountFolder([m]), bulk: false })
  }, [currentAccountId, currentFolder, groupConversations, moveMailToFolder, moveWithUndo, roles, t, threadRows, viewMode])

  const executeForeverDelete = useCallback(async (accountId: number, folder: string, uids: number[]) => {
    const uniq = Array.from(new Set(uids))
    if (uniq.length === 0) return

    const seq = ctxSeq.current
    const set = new Set(uniq)
    const removedMsgs = mails.filter(m => m.accountId === accountId && m.folder === folder && set.has(m.uid))
    const unreadRemoved = removedMsgs.filter(m => m.unread).length
    try {
      await window.api.invoke('net:delete', accountId, folder, uniq)
      if (ctxSeq.current !== seq) return
      if (unreadRemoved) bumpFolderUnreadPending(accountId, folder, -unreadRemoved)
      for (const uid of uniq) clearPendingUnread(accountId, folder, uid)
      removeManyFromUi(removedMsgs)
    } catch (e) {
      if (ctxSeq.current === seq) setError(t('app.errors.delete', { error: presentedError(t, e) }))
    }
  }, [bumpFolderUnreadPending, clearPendingUnread, mails, removeManyFromUi, t])

  const confirmDeleteAction = useCallback(async () => {
    if (!confirmDelete) return
    // One `net:delete` per (account, folder) group — see §2.238. The dialog may
    // stand for messages of a conversation that live in more than one folder.
    for (const g of confirmDelete.groups) {
      await executeForeverDelete(g.accountId, g.folder, g.uids)
    }
    setConfirmDelete(null)
  }, [confirmDelete, executeForeverDelete])

  // Execute confirmed thread-level action
  const executeThreadAction = useCallback(() => {
    if (!threadConfirm) return
    const { action, msgs } = threadConfirm
    setThreadConfirm(null)

    if (action === 'delete') { dispatchDelete(msgs, true); return }

    const role = action === 'archive' ? 'archive' : 'junk'
    const plan = planRoleMove(msgs, id => roleFolderFor(id, role))
    if (plan.groups.length === 0) {
      if (plan.missingRole) setError(roleNotFoundLabel(role))
      return
    }
    dispatchRoleMove(plan, action === 'archive' ? t('app.undo.archived') : t('app.undo.spammed'))
  }, [dispatchDelete, dispatchRoleMove, roleFolderFor, roleNotFoundLabel, t, threadConfirm])

  const snoozeMessage = useCallback(async (mail: MailSummary, wakeAt: Date) => {
    const items = resolveThreadItems(mail, threadRows, groupConversations)
    // §2.238 — one call per source folder: the conversation may span folders,
    // and `mail:snoozeAdd` addresses UIDs inside the folder it is given.
    const groups = groupByAccountFolder(items.filter(m => m.uid))
    if (groups.length === 0) return
    try {
      for (const g of groups) {
        await window.api.invoke('mail:snoozeAdd', g.accountId, g.folder, g.uids, wakeAt.toISOString())
        const unreadCount = g.msgs.filter(m => m.unread).length
        if (unreadCount > 0) bumpFolderUnreadPending(g.accountId, g.folder, -unreadCount)
        removeManyFromUi(g.msgs)
        inboxZeroIncrement(g.msgs.length)
      }
    } catch (e) {
      setError(t('app.errors.move', { error: presentedError(t, e) }))
    }
  }, [bumpFolderUnreadPending, groupConversations, inboxZeroIncrement, removeManyFromUi, t, threadRows])

  // --- Thread-level actions (buttons in thread strip) ---

  const markReadThread = useCallback(async () => {
    if (!activeThread || activeThread.count <= 1) return
    // §2.238 — `\Seen` is written per message, inside the folder that message
    // was read from. The conversation is our local derivative and may span
    // folders, so the head's folder does not stand for the rest.
    const groups = planMarkSeenGroups(activeThread.items)
    if (groups.length === 0) return
    try {
      for (const g of groups) {
        await window.api.invoke('net:setSeen', g.accountId, g.folder, g.uids, true)
        const uidSet = new Set(g.uids)
        setMails(prev => prev.map(m => (
          m.accountId === g.accountId && m.folder === g.folder && uidSet.has(m.uid)
            ? { ...m, unread: false }
            : m
        )))
        bumpFolderUnreadPending(g.accountId, g.folder, -g.uids.length)
      }
    } catch (e) {
      setError(t('app.errors.markSeen', { error: presentedError(t, e) }))
    }
  }, [activeThread, bumpFolderUnreadPending, t])

  const archiveThread = useCallback(() => {
    if (!activeThread || activeThread.count <= 1) return
    const plan = planRoleMove(activeThread.items, id => roleFolderFor(id, 'archive'))
    if (plan.groups.length === 0) {
      if (plan.missingRole) setError(t('mail.actions.archiveNotFound'))
      return
    }
    dispatchRoleMove(plan, t('app.undo.archived'))
  }, [activeThread, dispatchRoleMove, roleFolderFor, t])

  const deleteThread = useCallback(async () => {
    if (!activeThread || activeThread.count <= 1) return
    dispatchDelete(activeThread.items, true)
  }, [activeThread, dispatchDelete])

  const deleteMail = useCallback(async () => {
    if (!active) return
    await deleteMailTarget(active)
  }, [active, deleteMailTarget])

  const archiveMail = useCallback(() => {
    if (!active) return
    archiveMailTarget(active)
  }, [active, archiveMailTarget])

  const spamMail = useCallback(() => {
    if (!active) return
    spamMailTarget(active)
  }, [active, spamMailTarget])

  const replyMail = useCallback(async (m: MailSummary, mode: 'reply' | 'replyAll' | 'forward') => {
    try {
      setError('')
      const cached = detailsRef.current
      const d = cached && active && active.accountId === m.accountId && active.folder === m.folder && cached.uid === m.uid
        ? cached
        : await window.api.invoke('net:messageDetails', m.accountId, m.folder, m.uid) as MessageDetails
      const env = d.envelope

      const subj = (env?.subject || m.subject || '').trim()
      const dateIso = env?.date || m.date
      const dateStr = dateIso ? new Date(dateIso).toLocaleString() : ''
      const fromStr = env?.from ? addrListToString(env.from) : m.from
      const toStr = env?.to ? addrListToString(env.to) : ''
      const bodyText = (d.text || (d.html ? htmlToText(d.html) : '') || '').trim()
      const safeFrom = fromStr || t('compose.templates.unknownSender')
      const safeDate = dateStr || t('compose.templates.unknownDate')

      let init: ComposeInit
      if (mode === 'forward') {
        // Download original attachments to include in forwarded message
        const fwdAttachments: ComposeInit['attachments'] = []
        if (d.attachments && d.attachments.length > 0) {
          const results = await Promise.allSettled(
            d.attachments
              .filter(a => !a.cid) // skip inline images (CID attachments)
              .map(async (a) => {
                const res = await window.api.invoke('net:attachmentBase64', m.accountId, m.folder, m.uid, a.part) as
                  { ok: true; contentBase64: string; contentType?: string } | { ok: false; error: string }
                if (res.ok) {
                  fwdAttachments.push({
                    filename: a.filename || 'attachment',
                    contentBase64: res.contentBase64,
                    contentType: res.contentType || a.contentType || 'application/octet-stream',
                  })
                }
              })
          )
          void results // errors are silently skipped — partial forward is better than no forward
        }
        init = {
          to: '',
          subject: prefixSubject('Fwd', subj),
          text: [
            '', '',
            t('compose.templates.forwardHeader'),
            t('compose.templates.forwardFrom', { from: safeFrom }),
            t('compose.templates.forwardDate', { date: safeDate }),
            t('compose.templates.forwardSubject', { subject: subj }),
            t('compose.templates.forwardTo', { to: toStr }),
            '', bodyText,
          ].join('\n'),
          attachments: fwdAttachments.length > 0 ? fwdAttachments : undefined,
          source: 'forward',
        }
      } else {
        // Reply / Reply All — recipient computation lives in the pure core
        // helper `computeReplyRecipients` so it is unit-tested outside
        // jsdom. Bug reported 2026-04-21 (d767639): Reply-All must include
        // env.from in the CC pool when Reply-To != From; otherwise the
        // original sender is dropped. uniqEmails() inside the helper
        // de-dupes the common Reply-To == From case.
        const meta = accountsById.get(m.accountId)
        const me = (meta?.smtp.user || meta?.imap.user || '').toLowerCase()
        const { to: replyTo, cc, originalRecipients } = computeReplyRecipients(env, mode, me)
        const replyIntro = dateStr
          ? t('compose.templates.replyIntro', { date: safeDate, from: safeFrom })
          : t('compose.templates.replyIntroNoDate', { from: safeFrom })
        init = {
          to: replyTo,
          cc,
          subject: prefixSubject('Re', subj),
          text: ['', '', replyIntro, quoteText(bodyText)].join('\n'),
          replyRef: { accountId: m.accountId, folder: m.folder, uid: m.uid },
          originalRecipients,
          source: mode === 'replyAll' ? 'reply_all' : 'reply',
        }
      }

      await window.api.invoke('ui:openCompose', m.accountId, init)
    } catch (e) {
      setError(t('app.errors.compose', { error: presentedError(t, e) }))
    }
  }, [active, accountsById, t])

  // §3.3 B4 Instant Reply: the user picked one of the AI-generated draft
  // options on the active card. Prefill a NEW Compose with the draft body via
  // the existing openCompose mechanism — computing proper Reply recipients /
  // subject / quoted original the same way `replyMail('reply')` does, then
  // OVERRIDING the body with the chosen draft. Nothing is ever sent
  // automatically (no-auto-send invariant): the user still presses Send.
  const instantReplyPick = useCallback(async (
    ref: { accountId: number; folder: string; uid: number },
    draft: { text: string; tone?: string },
  ) => {
    try {
      setError('')
      const cached = detailsRef.current
      // uid is only unique WITHIN a mailbox, so validating the cached details by
      // uid alone can hand back stale details from another account/folder after
      // a fast switch (wrong recipients/subject on the new Compose). Match the
      // full (accountId, folder, uid) against the active message — same guard as
      // editDraft — before trusting the cache; otherwise fetch canonical details.
      const d = cached && active && active.accountId === ref.accountId && active.folder === ref.folder && cached.uid === ref.uid
        ? cached
        : await window.api.invoke('net:messageDetails', ref.accountId, ref.folder, ref.uid) as MessageDetails
      const env = d.envelope
      const subj = (env?.subject || '').trim()
      const meta = accountsById.get(ref.accountId)
      const me = (meta?.smtp.user || meta?.imap.user || '').toLowerCase()
      const { to: replyTo, cc, originalRecipients } = computeReplyRecipients(env, 'reply', me)
      const init: ComposeInit = {
        to: replyTo,
        cc,
        subject: prefixSubject('Re', subj),
        // The draft body IS the message — no quoted original prepended, matching
        // the Instant Reply UX (a ready-to-send short reply, editable before Send).
        text: draft.text,
        replyRef: { accountId: ref.accountId, folder: ref.folder, uid: ref.uid },
        originalRecipients,
        source: 'ai_chip',
      }
      await window.api.invoke('ui:openCompose', ref.accountId, init)
    } catch (e) {
      setError(t('app.errors.compose', { error: presentedError(t, e) }))
    }
  }, [active, accountsById, t])

  const editDraft = useCallback(async (m: MailSummary) => {
    try {
      setError('')
      const cached = detailsRef.current
      const d = cached && active && active.accountId === m.accountId && active.folder === m.folder && cached.uid === m.uid
        ? cached
        : await window.api.invoke('net:messageDetails', m.accountId, m.folder, m.uid) as MessageDetails
      const env = d.envelope
      const to = uniqEmails(extractEmails(env?.to)).join(', ')
      const cc = uniqEmails(extractEmails(env?.cc)).join(', ')
      const bcc = uniqEmails(extractEmails(env?.bcc)).join(', ')
      const text = (d.text || (d.html ? htmlToText(d.html) : '') || '').trim()
      const draftId = d.draftId || `imap:${m.folder}:${m.uid}`
      await window.api.invoke('ui:openCompose', m.accountId, {
        draftId,
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject: (env?.subject || m.subject || '').trim(),
        text,
        source: 'draft',
      } satisfies ComposeInit)
    } catch (e) {
      setError(t('app.errors.compose', { error: presentedError(t, e) }))
    }
  }, [active, t])

  const sendQueuedNow = useCallback(async (item: OutboxItem) => {
    setOutboxActionId(item.id)
    try {
      await window.api.invoke('mail:queueSendNow', item.id)
      await loadOutbox(item.accountId)
    } catch (e) {
      setError(t('app.errors.queue', { error: presentedError(t, e) }))
    } finally {
      setOutboxActionId(null)
    }
  }, [loadOutbox, t])

  const cancelQueuedSend = useCallback(async (item: OutboxItem, opts?: { edit?: boolean }) => {
    setOutboxActionId(item.id)
    try {
      const res = await window.api.invoke('mail:cancelSend', item.id) as { accountId?: number; messageData?: ComposeInit } | undefined
      const aid = typeof res?.accountId === 'number' ? res.accountId : item.accountId
      if (opts?.edit) {
        await window.api.invoke('ui:openCompose', aid, (res?.messageData || item.messageData || {}) satisfies ComposeInit)
      }
      await loadOutbox(aid)
    } catch (e) {
      setError(t('app.errors.queue', { error: presentedError(t, e) }))
    } finally {
      setOutboxActionId(null)
    }
  }, [loadOutbox, t])

  const postponeQueuedSend = useCallback(async (item: OutboxItem, minutes = 15) => {
    setOutboxActionId(item.id)
    try {
      const at = new Date(Date.now() + Math.max(1, minutes) * 60_000).toISOString()
      await window.api.invoke('mail:queueReschedule', item.id, at)
      await loadOutbox(item.accountId)
    } catch (e) {
      setError(t('app.errors.queue', { error: presentedError(t, e) }))
    } finally {
      setOutboxActionId(null)
    }
  }, [loadOutbox, t])

  // --- Context menu ---

  const openContextMenu = useCallback((e: React.MouseEvent, m: MailSummary) => {
    e.preventDefault()
    e.stopPropagation()
    const k = mailKey(m)
    // If the ROW is already selected — keep the multi-selection, otherwise switch
    // to single. Asked through `row.items`: a row selected through a mid-thread
    // key (what opening leaves behind) would otherwise read as unselected here,
    // and right-clicking it would throw the rest of the multi-selection away.
    if (!rowIsSelected(rowContaining(threadRowsRef.current, m), selectedKeys)) {
      setSelectedKeys(new Set([k]))
      selectionAnchorKey.current = k
    }
    const MENU_W = 260
    const MENU_H = 360
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8)
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8)
    setCtxMenu({ x: Math.max(8, x), y: Math.max(8, y), mail: m, moveOpen: false })
  }, [selectionAnchorKey, selectedKeys, setSelectedKeys, threadRowsRef])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])
  const closeFolderCtxMenu = useCallback(() => setFolderCtxMenu(null), [])

  const toggleCtxMoveOpen = useCallback(() => {
    setCtxMenu(prev => (prev ? { ...prev, moveOpen: !prev.moveOpen } : prev))
  }, [])

  const openFolderContextMenu = useCallback((e: React.MouseEvent, accountId: number, folderPath: string, folderTitle: string, role: string | null) => {
    e.preventDefault()
    e.stopPropagation()
    const MENU_W = 280
    const MENU_H = 340
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8)
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8)
    setFolderCtxMenu({
      x: Math.max(8, x),
      y: Math.max(8, y),
      accountId,
      folderPath,
      folderLabel: folderTitle,
      role,
    })
  }, [])

  const renameFolderFromMenu = useCallback(async (menu: FolderContextMenuState) => {
    const nextName = window.prompt(t('folders.menu.renamePrompt', { current: menu.folderPath }), menu.folderPath)?.trim()
    if (!nextName || nextName === menu.folderPath) return
    try {
      await window.api.invoke('net:renameMailbox', menu.accountId, menu.folderPath, nextName)
      const res = await window.api.invoke('net:mailboxesAndRoles', menu.accountId) as MailboxesAndRoles
      applyAccountMailboxesAndRoles(menu.accountId, res, { setCurrent: menu.accountId === currentAccountIdRef.current })
      if (menu.accountId === currentAccountIdRef.current && currentFolderRef.current === menu.folderPath) {
        switchFolder(nextName)
      }
    } catch (e) {
      setError(t('app.errors.sync', { error: presentedError(t, e) }))
    }
  }, [applyAccountMailboxesAndRoles, switchFolder, t])

  const deleteFolderFromMenu = useCallback(async (menu: FolderContextMenuState) => {
    const ok = window.confirm(t('folders.menu.deleteConfirm', { folder: menu.folderPath }))
    if (!ok) return
    try {
      await window.api.invoke('net:deleteMailbox', menu.accountId, menu.folderPath)
      const res = await window.api.invoke('net:mailboxesAndRoles', menu.accountId) as MailboxesAndRoles
      applyAccountMailboxesAndRoles(menu.accountId, res, { setCurrent: menu.accountId === currentAccountIdRef.current })
      if (menu.accountId === currentAccountIdRef.current && currentFolderRef.current === menu.folderPath) {
        switchFolder('INBOX')
      }
    } catch (e) {
      setError(t('app.errors.sync', { error: presentedError(t, e) }))
    }
  }, [applyAccountMailboxesAndRoles, switchFolder, t])

  const setFolderSyncModeFromMenu = useCallback(async (menu: FolderContextMenuState, mode: 'full' | 'on_open') => {
    try {
      await upsertFolderPref(menu.accountId, menu.folderPath, { headerSyncMode: mode })
      if (mode === 'full') {
        void window.api.invoke('net:syncFolderHeaders', menu.accountId, menu.folderPath, { mode: 'full' }).catch(() => {})
      }
    } catch (e) {
      setError(t('app.errors.sync', { error: presentedError(t, e) }))
    }
  }, [t, upsertFolderPref])

  const changeFolderIconFromMenu = useCallback(async (menu: FolderContextMenuState) => {
    const value = window.prompt(t('folders.menu.iconPrompt'), '') ?? ''
    const icon = value.trim().slice(0, 8)
    try {
      await upsertFolderPref(menu.accountId, menu.folderPath, { icon })
    } catch (e) {
      setError(t('app.errors.sync', { error: presentedError(t, e) }))
    }
  }, [t, upsertFolderPref])

  const toggleFolderBadgeFromMenu = useCallback(async (menu: FolderContextMenuState) => {
    const current = folderPrefsByAccount.current.get(menu.accountId)?.[menu.folderPath]?.includeInBadges ?? (menu.role === '\\Inbox')
    try {
      await upsertFolderPref(menu.accountId, menu.folderPath, { includeInBadges: !current })
      setFolders(prev => [...prev])
    } catch (e) {
      setError(t('app.errors.sync', { error: presentedError(t, e) }))
    }
  }, [t, upsertFolderPref])

  const toggleFolderVisibilityFromMenu = useCallback(async (menu: FolderContextMenuState) => {
    const current = folderPrefsByAccount.current.get(menu.accountId)?.[menu.folderPath]?.visible ?? true
    try {
      await upsertFolderPref(menu.accountId, menu.folderPath, { visible: !current })
      if (menu.accountId === currentAccountIdRef.current && menu.folderPath === currentFolderRef.current && current) {
        switchFolder('INBOX')
      } else {
        setFolders(prev => [...prev])
      }
    } catch (e) {
      setError(t('app.errors.sync', { error: presentedError(t, e) }))
    }
  }, [switchFolder, t, upsertFolderPref])

  // §2.15-ter (codex iteration 4): toggle per-folder search-index gate from
  // the folder context menu. Mirrors toggleFolderBadgeFromMenu/visibility.
  // Default true matches the column DEFAULT — folders without an explicit
  // pref row are indexed.
  const toggleFolderIndexInSearchFromMenu = useCallback(async (menu: FolderContextMenuState) => {
    const current = folderPrefsByAccount.current.get(menu.accountId)?.[menu.folderPath]?.indexInSearch ?? true
    try {
      await upsertFolderPref(menu.accountId, menu.folderPath, { indexInSearch: !current })
      setFolders(prev => [...prev])
    } catch (e) {
      setError(t('app.errors.sync', { error: presentedError(t, e) }))
    }
  }, [t, upsertFolderPref])

  // --- Attachments ---

  const saveAttachment = useCallback(async (m: MailSummary, att: AttachmentMeta) => {
    const key = `${m.accountId}:${m.folder}:${m.uid}:${att.part}`
    setSavingAttachment(key)
    try {
      const res = await window.api.invoke(
        'net:saveAttachment', m.accountId, m.folder, m.uid, att.part, att.filename
      ) as { ok: boolean; path?: string; cancelled?: boolean; error?: string }
      if (!res.ok && !res.cancelled) {
        setError(t('app.errors.attachment', { error: res.error || t('common.error') }))
      }
    } catch (e) {
      setError(t('app.errors.attachment', { error: presentedError(t, e) }))
    } finally {
      setSavingAttachment(null)
    }
  }, [t])

  // --- Search ---

  const onSearch = useCallback(async (
    queryOverride?: string,
    scopeOverride?: 'folder' | 'account' | 'all',
    sortOverride?: 'relevance' | 'date',
  ) => {
    const query = typeof queryOverride === 'string' ? queryOverride : q
    // In unified mode 'folder' scope makes no sense — always use 'all'
    const rawScope = scopeOverride ?? searchScope
    const effectiveScope = viewMode === 'unified' ? 'all' : rawScope
    const requestedSort = sortOverride ?? searchSort
    // Relevance ranking is only meaningful on the FTS path (plain-text queries).
    // Advanced queries with operators bypass FTS entirely, so we silently force date sort
    // to keep behavior consistent with what the worker actually does.
    const effectiveSort = requestedSort === 'relevance' && isAdvancedQuery(query) ? 'date' : requestedSort
    if (viewMode === 'account' && (currentFolder === OUTBOX_FOLDER || currentFolder === SNOOZED_FOLDER || currentFolder === FOLLOWUP_FOLDER || currentFolder === READLATER_FOLDER)) {
      if (!query) {
        if (currentFolder === OUTBOX_FOLDER) await loadOutbox()
        else if (currentFolder === SNOOZED_FOLDER) await loadSnoozed()
        else if (currentFolder === FOLLOWUP_FOLDER) await loadFollowUps()
        else await loadReadLater()
      }
      return
    }
    if (!query) {
      // Empty query — full search teardown (drops inflight worker request, paginating flag,
      // remote-result badge, coverage stats, debounce timer) and reload the folder/inbox view.
      resetSearchLifecycle()
      invalidateContext()
      cursorBeforeUid.current = undefined
      unifiedCursor.current = undefined
      setHasMore(true)
      setMails([])

      if (viewMode === 'unified') {
        const ids = unifiedAccountFilter === 'all'
          ? accounts.map(a => a.id)
          : [unifiedAccountFilter]
        if (ids.length === 0) return
        try {
          // §2.7 iter2: epoch guard — drop stale unified-inbox response if
          // pending-move set changed mid-flight.
          const epochBefore = pendingMoveEpochRef.current
          const raw = await window.api.invoke('cache:unifiedInboxPage', ids, PAGE_SIZE, undefined) as MailSummary[]
          if (pendingMoveEpochRef.current !== epochBefore) return
          const list = applyUnreadOverridesForMixedList(raw, 'cache')
          setMails(list)
          unifiedCursor.current = list.length > 0
            ? { date: list[list.length - 1].date, accountId: list[list.length - 1].accountId, uid: list[list.length - 1].uid }
            : undefined
          setHasMore(list.length >= PAGE_SIZE)
        } catch (e) {
          setError(t('app.errors.search', { error: presentedError(t, e) }))
        }
        return
      }

      await syncFolder(undefined, { force: true, ignoreFolderPolicy: true })
      return
    }
    // Bump generation BEFORE awaiting so any in-flight previous search becomes stale.
    const seq = ++searchSeqRef.current
    try {
      setError('')
      setSearching(true)
      // Determine effective search scope:
      // - unified mode: always multi-account; scope controls folder breadth
      // - account mode with scope='all': use unified search with single account across all folders
      // - account mode with scope='account': use unified search with single account across all folders
      // - account mode with scope='folder': use single-folder search
      const useGlobal = viewMode === 'unified' || effectiveScope !== 'folder'

      if (useGlobal) {
        let ids: number[]
        if (viewMode === 'unified') {
          ids = unifiedAccountFilter === 'all'
            ? accounts.map(a => a.id)
            : [unifiedAccountFilter]
        } else if (effectiveScope === 'all') {
          ids = accounts.map(a => a.id)
        } else {
          ids = typeof currentAccountId === 'number' ? [currentAccountId] : []
        }
        if (ids.length === 0) return
        const scope = effectiveScope === 'folder' ? 'inbox' : 'all'
        // supersede=true → main process cancels any in-flight worker request before issuing this one.
        const raw = await window.api.invoke('cache:unifiedSearch', ids, query, PAGE_SIZE, 0, scope, effectiveSort, true) as MailSummary[]
        if (seq !== searchSeqRef.current) return
        const rows = applyUnreadOverridesForMixedList(raw, 'cache')
        // Mark the large list render as a transition so fast typing in the
        // search input stays responsive (keystrokes stay high-priority).
        startTransition(() => {
          setMails(rows)
          setHasMore(rows.length >= PAGE_SIZE)
          setRemoteResultCount(0)
        })
        unifiedCursor.current = undefined
        activeSearchRef.current = { kind: 'unified', accountIds: ids, scope, query, sort: effectiveSort, offset: rows.length }
      } else {
        if (typeof currentAccountId !== 'number') return
        const folderForSearch = currentFolder
        const accountForSearch = currentAccountId
        const raw = await window.api.invoke('cache:search', accountForSearch, folderForSearch, query, PAGE_SIZE, 0, effectiveSort, true) as MailSummary[]
        if (seq !== searchSeqRef.current) return
        const rows = applyUnreadOverrides(accountForSearch, folderForSearch, raw, 'cache')
        startTransition(() => {
          setMails(rows)
          setHasMore(rows.length >= PAGE_SIZE)
        })
        cursorBeforeUid.current = rows.length > 0 ? rows[rows.length - 1].uid : undefined
        activeSearchRef.current = { kind: 'folder', accountId: accountForSearch, folder: folderForSearch, query, sort: effectiveSort, offset: rows.length }

        // Remote IMAP SEARCH fallback for folder scope when local corpus may be incomplete.
        // Skip for queries with operators IMAP can't handle (body:, filename:, is:, has:, negations, uid:)
        // to avoid false positives from ignoring those constraints server-side.
        setRemoteResultCount(0)
        const hasUnsupportedOps = /(?:^|\s)(?:-\S|body:|filename:|is:|has:|in:|uid:)/i.test(query)
        if (!hasUnsupportedOps) {
          window.api.invoke('search:remoteSearch', accountForSearch, folderForSearch, query, 50).then((remote) => {
            if (seq !== searchSeqRef.current) return
            const remoteMails = remote as MailSummary[]
            if (!remoteMails || remoteMails.length === 0) return
            // Merge remote results that aren't already in local results.
            // For relevance sort: append remote at the bottom (BM25 ranking applies only to local FTS).
            // For date sort: re-sort the merged list by date.
            startTransition(() => {
              setMails(prev => {
                const existingUids = new Set(prev.map(m => `${m.accountId}:${m.folder}:${m.uid}`))
                const newRemote = remoteMails.filter(m => !existingUids.has(`${m.accountId}:${m.folder}:${m.uid}`))
                if (newRemote.length === 0) return prev
                setRemoteResultCount(newRemote.length)
                // Record remote-origin keys on the active search so subsequent
                // local BM25 pages can be spliced before them (see mergeRows in
                // loadPage). Always the most recent activeSearchRef because the
                // seq guard above ensures we're still on the same search run.
                const active = activeSearchRef.current
                if (active) {
                  const set = active.remoteKeys ?? new Set<string>()
                  for (const m of newRemote) set.add(`${m.accountId}:${m.folder}:${m.uid}`)
                  active.remoteKeys = set
                }
                if (effectiveSort === 'relevance') {
                  const remoteByDate = [...newRemote].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                  return [...prev, ...remoteByDate]
                }
                return [...prev, ...newRemote].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              })
            })
          }).catch(() => { /* non-critical — remote search is best-effort */ })
        }
      }
    } catch (e) {
      // Cancellation is expected when the user types fast and we supersede prior requests.
      // Probe only — see the note in the search-pagination catch above.
      const msg = e instanceof Error ? e.message : String(e)
      if (!/Search request cancelled/i.test(msg)) {
        setError(t('app.errors.search', { error: presentedError(t, e) }))
      }
    } finally {
      // Only the most recent request is allowed to clear the spinner;
      // a stale request finishing late must not flip it off while the new one is still running.
      if (seq === searchSeqRef.current) setSearching(false)
    }
  }, [
    accounts,
    applyUnreadOverrides,
    applyUnreadOverridesForMixedList,
    currentAccountId,
    currentFolder,
    invalidateContext,
    loadOutbox,
    loadFollowUps,
    loadReadLater,
    loadSnoozed,
    q,
    resetSearchLifecycle,
    searchScope,
    searchSort,
    setHasMore,
    syncFolder,
    t,
    unifiedAccountFilter,
    viewMode,
  ])
  const onSearchRef = useRef(onSearch)
  onSearchRef.current = onSearch

  // --- Periodic coverage stats refresh for statusbar ---
  useEffect(() => {
    if (!initDone) return
    const refresh = () => {
      const ids = accounts.map(a => a.id)
      if (ids.length === 0) return
      window.api.invoke('search:coverageStats', ids).then((stats) => {
        setGlobalCoverageStats(stats as typeof globalCoverageStats)
      }).catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 30_000)
    return () => clearInterval(interval)
  }, [initDone, accounts])

  // --- Column resizing ---

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = listWidth
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(240, Math.min(600, startWidth + ev.clientX - startX))
      setListWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
  }, [listWidth])

  // --- Computed values ---
  // viewMails, threadRows, visibleLeadMails, activeThread, selectedCount, hasMultiSelection — from useMailListView

  const canAutoPage = hasAccount && hasMoreState && (
    activeSearchRef.current !== null
      || (!q && filterMode === 'all' && sortMode === 'date')
  )
  const canManualPage = hasAccount && hasMoreState && !q && !canAutoPage

  // Footer is always defined (even as null) so the components prop has a stable
  // shape — passing { Footer: undefined } or `components={undefined}` makes
  // react-virtuoso read `.EmptyPlaceholder` off undefined and crash on init.
  const virtuosoComponents = useMemo(() => ({
    Footer: () => paginatingSearch ? (
      <div className="search-pagination-footer" data-testid="search-pagination-loading">
        <Loader2 size={16} className="spin" />
        <span>{t('app.search.loadingMore')}</span>
      </div>
    ) : null,
  }), [paginatingSearch, t])

  const hiddenUnreadPaths = useMemo(() => {
    // If user configured the list — use it, otherwise hide standard folders.
    if (hiddenUnreadFolders.length > 0) return new Set(hiddenUnreadFolders)
    const set = new Set<string>()
    if (roles.trash) set.add(roles.trash)
    if (roles.junk) set.add(roles.junk)
    if (roles.archive) set.add(roles.archive)
    if (roles.drafts) set.add(roles.drafts)
    return set
  }, [hiddenUnreadFolders, roles])

  // Unread count per account (for avatar badges).
  const accountUnread = useMemo(() => {
    const result = new Map<number, number>()
    for (const a of accounts) {
      const acFolders = foldersByAccount.current.get(a.id) ?? []
      const acRoles = rolesByAccount.current.get(a.id) ?? {}
      const prefs = folderPrefsByAccount.current.get(a.id) ?? {}
      let sum = 0
      for (const f of acFolders) {
        // §2.99 (review H2): the badge-inclusion rule is shared with the main
        // process (OS badge / tray tooltip) so the taskbar can never claim
        // unread mail this sidebar does not show. Do not re-inline it here.
        const role = getFolderRole(f.path, f.specialUse, acRoles)
        if (!isFolderCountedInBadges({ pref: prefs[f.path], role })) continue
        const base = typeof f.unread === 'number' ? f.unread : 0
        const pending = folderUnreadPending[`${a.id}:${f.path}`] ?? 0
        sum += Math.max(0, base + pending)
      }
      result.set(a.id, sum)
    }
    return result
  }, [accounts, folderUnreadPending])

  // Total unread across ALL accounts (for window title and titlebar badge).
  const globalUnread = useMemo(() => {
    let sum = 0
    for (const count of accountUnread.values()) sum += count
    return sum
  }, [accountUnread])

  const sidebarWidth = sidebarExpanded ? 180 : 56

  const activeFolder = active?.folder ?? currentFolder
  const activeRoles = active
    ? (rolesByAccount.current.get(active.accountId) ?? (active.accountId === currentAccountId ? roles : {}))
    : roles
  const isDraftsFolder = viewMode === 'account' && Boolean(active && activeRoles.drafts && activeFolder === activeRoles.drafts)
  const currentFolderMeta = folders.find(f => f.path === currentFolder)
  const visibleFolders = useMemo(() => {
    return folders.filter(f => {
      if (typeof currentAccountId !== 'number') return true
      const prefs = folderPrefsByAccount.current.get(currentAccountId) ?? {}
      const pref = prefs[f.path]
      return pref ? pref.visible !== false : true
    })
  }, [currentAccountId, folders])
  const hasVisibleInboxFolder = useMemo(
    () => visibleFolders.some(f => f.path === 'INBOX'),
    [visibleFolders],
  )
  const env = details?.envelope
  const metaFrom = active ? (env?.from ? addrListToString(env.from) : active.from) : ''
  // §3.3.C-uiaudit.22: pass raw MailAddress[] instead of pre-formatted strings
  // so RecipientList can render collapsible chips with per-chip tooltips.
  const metaTo = env?.to ?? []
  const metaCc = env?.cc ?? []
  const metaBcc = env?.bcc ?? []
  // §3.3.C-uiaudit.22: BCC privacy invariant — only show BCC when the message
  // lives in the Sent folder of its own account AND the From address matches a
  // known identity of that account (defense-in-depth against spoofed From in
  // Sent and cross-account scoping bugs). See deriveIsSentByMe in utils/mail.ts.
  const isSentByMe = deriveIsSentByMe(activeFolder, activeRoles, env?.from, accountIdentities)
  const metaDateIso = (env?.date || active?.date || '')
  const metaDate = metaDateIso ? new Date(metaDateIso).toLocaleString() : ''

  useEffect(() => {
    document.title = globalUnread > 0 ? `MailCopilot (${globalUnread})` : 'MailCopilot'
  }, [globalUnread])

  const focusSearchInput = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="search-input"]')
    input?.focus()
  }, [])

  const setGroupConversationsAndPersist = useCallback((next: boolean) => {
    setGroupConversations(next)
    void (async () => {
      try {
        // Send ONLY the changed field. Main re-reads the current settings and
        // merges the payload before persisting (electron/main.ts), so a
        // renderer-side read-modify-write is unnecessary — and actively
        // harmful: `settings:get` returns main-only fields
        // (launchAtLoginStatus, aiApiKeySaved, telemetryConsent,
        // mcpEnableStdio, spellcheckAvailable), and the §3.10 P0 gate refuses
        // the WHOLE request when it sees them. Measured on the Windows stand
        // 2026-08-27: "settings:save rejected: forbidden main-only field
        // attempt", and the write silently no-opped.
        //
        // The refusal was invisible because the handler RETURNS
        // `{ ok: false, reason: 'forbidden_field' }` rather than throwing, and
        // no caller here inspects the reply — the `catch` below never fired.
        // Sending one field removes the refusal; it does not add reply
        // checking, which none of these fire-and-forget writes do.
        //
        // Bonus: the old shape could also clobber a concurrent write with a
        // stale snapshot, since the whole object was echoed back.
        await window.api.invoke('settings:save', { groupConversations: next })
      } catch {
        // ignore
      }
    })()
  }, [])

  // --- AI panel ---
  const toggleAiPanel = useCallback(() => {
    setAiPanelOpen(prev => {
      const next = !prev
      void (async () => {
        try {
          // Only the changed field — see setGroupConversationsAndPersist.
          await window.api.invoke('settings:save', { aiPanelOpen: next })
        } catch { /* ignore */ }
      })()
      return next
    })
  }, [])

  const handleAiSettingsChange = useCallback((key: string, value: unknown) => {
    if (key === 'aiProvider') setAiProvider(value as string)
    if (key === 'aiPrivacyConsent') setAiPrivacyConsent(Boolean(value))
    if (key === 'aiSendOnEnter') setAiSendOnEnter(Boolean(value))
    if (key === 'aiShowSources') setAiShowSources(Boolean(value))
    if (key === 'aiEgressPolicy' && (value === 'default-deny' || value === 'ask' || value === 'allow')) {
      setAiEgressPolicy(value)
    }
    void (async () => {
      try {
        // Only the changed field — see setGroupConversationsAndPersist. This is
        // the worst of the four sites to get wrong: it is the AI panel's
        // onboarding provider pick, so a refused write left the panel asking
        // the user to choose a provider they had just chosen.
        await window.api.invoke('settings:save', { [key]: value })
      } catch { /* ignore */ }
    })()
  }, [])

  /**
   * Resolve a message reference (AI source link, new-mail notification) and
   * open it: cache first, IMAP as a fallback, then select the account/folder.
   *
   * `silentIfMissing` is for references the user did not type — a notification
   * click may land after the message was deleted or moved elsewhere, which is
   * ordinary rather than an error worth a banner. Those degrade to selecting
   * the referenced folder so the window still lands somewhere useful.
   */
  const openMessageRef = useCallback(async (ref: MessageRef, opts?: { silentIfMissing?: boolean }) => {
    const { accountId, folder, uid } = ref

    let summary = await window.api.invoke('cache:messageByUid', accountId, folder, uid) as MailSummary | null
    if (!summary) {
      try {
        const detailsByRef = await window.api.invoke('net:messageDetails', accountId, folder, uid) as MessageDetails
        const from0 = detailsByRef.envelope?.from?.[0]
        const fromAddr = (from0?.address || '').trim()
        const fromName = (from0?.name || '').trim()
        const flags = detailsByRef.flags || []
        summary = {
          accountId,
          folder,
          uid,
          from: fromName || fromAddr || `UID ${uid}`,
          fromAddr: fromAddr || undefined,
          fromName: fromName || undefined,
          subject: detailsByRef.envelope?.subject || `(uid:${uid})`,
          date: detailsByRef.envelope?.date || new Date().toISOString(),
          unread: !flags.includes('\\Seen'),
          flagged: flags.includes('\\Flagged'),
          hasAttachments: Boolean(detailsByRef.attachments && detailsByRef.attachments.length > 0),
          messageId: detailsByRef.envelope?.messageId,
          inReplyTo: detailsByRef.envelope?.inReplyTo,
          references: detailsByRef.envelope?.references,
        }
      } catch {
        summary = null
      }
    }

    const needsSelection =
      viewMode !== 'account' || currentAccountId !== accountId || currentFolder !== folder

    if (!summary) {
      if (opts?.silentIfMissing) {
        if (needsSelection) selectAccount(accountId, folder)
        return
      }
      setError(t('app.errors.loadMessage', { error: `Source not found: ${accountId}/${folder}/${uid}` }))
      return
    }

    if (needsSelection) selectAccount(accountId, folder)
    await openMail(summary)
  }, [currentAccountId, currentFolder, openMail, selectAccount, t, viewMode])

  const openAiSource = useCallback(
    (ref: MessageRef) => openMessageRef(ref),
    [openMessageRef],
  )

  // §2.99: a new-mail notification click arrives from main as identifiers only.
  // No memoization needed — the hook holds the handler in a ref.
  useMailOpenRef(ref => openMessageRef(ref, { silentIfMissing: true }))

  // Determine context type for AI
  const aiContextType = useMemo<'email' | 'thread' | 'folder' | 'multi-select' | null>(() => {
    // Rows, not raw keys: `selectedCount` is derived from the current rows.
    if (hasMultiSelection) return 'multi-select'
    if (active && details) return groupConversations ? 'thread' : 'email'
    if (hasAccount) return 'folder'
    return null
  }, [active, details, hasMultiSelection, hasAccount, groupConversations])

  const aiContextData = useMemo(() => {
    if (aiContextType === 'multi-select') {
      return { count: selectedCount, folder: currentFolder, viewMode }
    }
    if (aiContextType === 'email' || aiContextType === 'thread') {
      return active ? { accountId: active.accountId, folder: active.folder, uid: active.uid, subject: active.subject } : null
    }
    if (aiContextType === 'folder') {
      const addConnStatus = (a: typeof accounts[0]) => {
        const st = connectionStatus.get(a.id)
        return { id: a.id, email: a.email || a.imap.user, ...(st === 'error' ? { connError: true } : {}) }
      }
      if (viewMode === 'unified') {
        const accs = (unifiedAccountFilter === 'all' ? accounts : accounts.filter(a => a.id === unifiedAccountFilter))
          .map(addConnStatus)
        return { folder: currentFolder, viewMode, accounts: accs }
      }
      const allAccs = accounts.map(addConnStatus)
      return { folder: currentFolder, accountId: currentAccountId, viewMode, accounts: allAccs }
    }
    return null
  }, [aiContextType, active, accounts, connectionStatus, currentAccountId, currentFolder, selectedCount, unifiedAccountFilter, viewMode])

  const summarizeWithAi = useCallback(() => {
    const prompt =
      aiContextType === 'thread'
        ? t('ai.prompts.summarizeThread')
        : aiContextType === 'folder'
          ? t('ai.prompts.digest')
          : t('ai.prompts.summarize')
    setAiPanelOpen(true)
    setAiQuickPrompt(prompt)
  }, [aiContextType, t])

  // Send context to main process for AI with debounce
  useEffect(() => {
    if (!aiPanelOpen) return
    const timer = setTimeout(() => {
      window.api.invoke('ai:setContext', { type: aiContextType, data: aiContextData })
    }, 300)
    return () => clearTimeout(timer)
  }, [aiPanelOpen, aiContextType, aiContextData])

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      {
        id: 'compose',
        label: t('commandPalette.commands.compose'),
        shortcut: 'c',
        keywords: ['new', 'email', 'message'],
        run: () => { if (hasAccount) void window.api.invoke('ui:openCompose') },
      },
      {
        id: 'sync',
        label: t('commandPalette.commands.sync'),
        keywords: ['refresh', 'reload'],
        run: () => { void syncCurrentView() },
      },
      {
        id: 'focus-search',
        label: t('commandPalette.commands.focusSearch'),
        shortcut: '/',
        keywords: ['find', 'query'],
        run: () => focusSearchInput(),
      },
      {
        id: 'open-settings',
        label: t('commandPalette.commands.openSettings'),
        keywords: ['preferences', 'config'],
        run: () => { void window.api.invoke('ui:openSettings') },
      },
      {
        id: 'go-inbox',
        label: t('commandPalette.commands.goInbox'),
        shortcut: 'g i',
        keywords: ['folder', 'inbox'],
        run: () => switchFolder('INBOX'),
      },
      {
        id: 'go-sent',
        label: t('commandPalette.commands.goSent'),
        shortcut: 'g s',
        keywords: ['folder', 'sent'],
        run: () => { if (roles.sent) switchFolder(roles.sent) },
      },
      {
        id: 'go-drafts',
        label: t('commandPalette.commands.goDrafts'),
        shortcut: 'g d',
        keywords: ['folder', 'drafts'],
        run: () => { if (roles.drafts) switchFolder(roles.drafts) },
      },
      {
        id: 'go-outbox',
        label: t('commandPalette.commands.goOutbox'),
        keywords: ['queue', 'scheduled'],
        run: () => switchFolder(OUTBOX_FOLDER),
      },
      {
        id: 'go-snoozed',
        label: t('commandPalette.commands.goSnoozed'),
        keywords: ['snooze', 'postpone', 'remind'],
        run: () => switchFolder(SNOOZED_FOLDER),
      },
      {
        id: 'go-followups',
        label: t('commandPalette.commands.goFollowUps'),
        keywords: ['followup', 'follow-up', 'remind', 'pending'],
        run: () => switchFolder(FOLLOWUP_FOLDER),
      },
      {
        id: 'go-readlater',
        label: t('commandPalette.commands.goReadLater'),
        shortcut: 'g r',
        keywords: ['read', 'later', 'bookmark', 'save'],
        run: () => switchFolder(READLATER_FOLDER),
      },
      {
        id: 'go-starred',
        label: t('commandPalette.commands.goStarred'),
        shortcut: 'g *',
        keywords: ['flagged', 'important'],
        run: () => setFilterMode('flagged'),
      },
      {
        id: 'toggle-threads',
        label: groupConversations
          ? t('commandPalette.commands.disableThreads')
          : t('commandPalette.commands.enableThreads'),
        keywords: ['conversation', 'threading', 'group'],
        run: () => setGroupConversationsAndPersist(!groupConversations),
      },
      {
        id: 'go-unified',
        label: t('commandPalette.commands.goUnified'),
        keywords: ['all accounts', 'unified'],
        run: () => { if (accounts.length > 1) switchToUnified() },
      },
    ]

    for (const a of accounts) {
      const label = (a.name || a.imap.user || '').trim() || `#${a.id}`
      cmds.push({
        id: `account-${a.id}`,
        label: t('commandPalette.commands.switchAccount', { account: label }),
        keywords: ['account', label],
        run: () => selectAccount(a.id),
      })
    }

    // AI commands
    cmds.push(
      {
        id: 'ai-open',
        label: t('commandPalette.commands.aiOpenPanel'),
        shortcut: 'Ctrl+Shift+A',
        keywords: ['ai', 'assistant', 'panel'],
        run: () => toggleAiPanel(),
      },
      {
        id: 'ai-summarize',
        label: t('commandPalette.commands.aiSummarize'),
        shortcut: 'Ctrl+Shift+S',
        keywords: ['ai', 'assistant', 'summary', 'summarize'],
        run: () => summarizeWithAi(),
      },
      {
        id: 'ai-new-chat',
        label: t('commandPalette.commands.aiNewChat'),
        keywords: ['ai', 'chat', 'new'],
        run: () => { setAiPanelOpen(true); void window.api.invoke('ai:newSession') },
      },
    )

    return cmds
  }, [
    accounts,
    focusSearchInput,
    groupConversations,
    hasAccount,
    roles.drafts,
    roles.sent,
    selectAccount,
    setFilterMode,
    setGroupConversationsAndPersist,
    switchFolder,
    switchToUnified,
    syncCurrentView,
    summarizeWithAi,
    t,
    toggleAiPanel,
  ])

  const filteredPaletteCommands = useMemo(() => {
    const qn = commandQuery.trim().toLowerCase()
    if (!qn) return paletteCommands
    const tokens = qn.split(/\s+/g).filter(Boolean)
    return paletteCommands.filter(cmd => {
      const hay = [cmd.label, ...(cmd.keywords || [])].join(' ').toLowerCase()
      return tokens.every(tok => hay.includes(tok))
    })
  }, [commandQuery, paletteCommands])

  const runPaletteCommand = useCallback((cmd: PaletteCommand) => {
    setShowCommandPalette(false)
    setCommandQuery('')
    setCommandIndex(0)
    cmd.run()
  }, [])

  useEffect(() => {
    if (!showCommandPalette) return
    setCommandIndex(0)
  }, [commandQuery, showCommandPalette])

  // Hotkeys — in useKeyboardShortcuts
  useKeyboardShortcuts({
    active, activeThread, hasAccount, hasMultiSelection,
    hotkeysPreset, selectedKeys, showCommandPalette,
    sidebarWidth, currentAccountId,
    undoInfoRef, qRef, viewMailsRef, threadRowsRef, selectionAnchorKey,
    rolesByAccount, virtuosoRef, onSearchRef,
    openMail, replyMail,
    archiveMail, deleteMail, spamMail,
    bulkArchive, bulkDelete, bulkSpam, handleUndo,
    setSeenForMail, setSeenForMany, setFlaggedForMail, togglePin,
    focusSearchInput, switchFolder, toggleAiPanel, summarizeWithAi,
    setShowCommandPalette, setCommandQuery, setActive, setDetails,
    setSelectedKeys, setFilterMode, setShowShortcuts, setQ, setCtxMenu,
    searchDebounceRef,
  })

  return (
    <div className="mailcopilot-root">
      <ResizeEdges />
      {/* Custom title bar */}
      <div className="titlebar">
        <span className="titlebar-title">
          <img src="icon.svg" alt="" className="titlebar-icon" draggable={false} />
          MailCopilot
          {globalUnread > 0 && <span className="titlebar-badge">{globalUnread}</span>}
        </span>
        <div className="titlebar-controls">
          <button className="titlebar-btn" onClick={() => void window.api.invoke('win:minimize')}>
            <Minus size={14} />
          </button>
          <button className="titlebar-btn" onClick={() => void window.api.invoke('win:maximize')}>
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button className="titlebar-btn titlebar-btn-close" onClick={() => void window.api.invoke('win:close')}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div ref={tooltipContainerRef} className="mailcopilot-app" style={{ gridTemplateColumns: `${sidebarWidth}px ${listWidth}px 4px minmax(200px, 1fr)${aiPanelOpen ? ` 4px ${aiPanelWidth}px` : ''}` }} onMouseOver={handleTooltipOver} onMouseOut={handleTooltipOut}>
        {/* Sidebar */}
        <aside className={`mailcopilot-sidebar${sidebarExpanded ? ' sidebar-expanded' : ''}${compactSidebar ? ' sidebar-compact' : ''}`}>
          <button
            className="sidebar-compose-btn"
            data-testid="sidebar-compose"
            data-tooltip={sidebarExpanded ? undefined : t('app.sidebar.compose')}
            onClick={() => void window.api.invoke('ui:openCompose')}
            disabled={!hasAccount}
          >
            <PenSquare size={20} />
            <span className="sidebar-label">{t('app.sidebar.compose')}</span>
          </button>

          <div className="sidebar-divider" />

          {/* Accounts */}
          {accounts.length > 1 && (
            <div className="account-section">
              <button
                className={`unified-btn${viewMode === 'unified' ? ' account-active' : ''}`}
                data-testid="folder-unified"
                data-tooltip={sidebarExpanded ? undefined : t('app.sidebar.unifiedInbox')}
                onClick={switchToUnified}
                disabled={!hasAccount}
              >
                <Layers size={18} />
                <span className="sidebar-label">{t('app.sidebar.unifiedInbox')}</span>
              </button>

              {accounts.map(a => {
                const displayName = (a.name || '').trim()
                const email = a.email || a.imap.user || ''
                const label = displayName || email || `#${a.id}`
                const isActive = viewMode === 'account' && a.id === currentAccountId
                const unread = accountUnread.get(a.id) ?? 0
                const connSt = connectionStatus.get(a.id)
                const tooltip = displayName && email ? `${displayName}\n${email}` : label
                if (sidebarExpanded) {
                  return (
                    <div
                      key={a.id}
                      className={`account-avatar-row${isActive ? ' account-active' : ''}`}
                      data-testid={`account-${a.id}`}
                      title={tooltip}
                      onClick={() => selectAccount(a.id)}
                    >
                      <AccountAvatar
                        account={a}
                        unread={unread}
                        connStatus={connSt}
                        className={isActive ? 'account-active' : undefined}
                      />
                      <div className="sidebar-label-group">
                        <span className="sidebar-label">{label}</span>
                        {displayName && email && <span className="sidebar-email">{email}</span>}
                      </div>
                    </div>
                  )
                }
                return (
                  <AccountAvatar
                    key={a.id}
                    account={a}
                    unread={unread}
                    connStatus={connSt}
                    className={isActive ? 'account-active' : undefined}
                    style={{ cursor: 'pointer' }}
                    data-testid={`account-${a.id}`}
                    data-tooltip={tooltip}
                    onClick={() => selectAccount(a.id)}
                  />
                )
              })}

              <div className="sidebar-divider" />
            </div>
          )}

          {/* Folders (scrollable) */}
          <div className="sidebar-folders">
          {visibleFolders.map(f => {
            const role = getFolderRole(f.path, f.specialUse, roles)
            const pref = (typeof currentAccountId === 'number')
              ? (folderPrefsByAccount.current.get(currentAccountId) ?? {})[f.path]
              : undefined
            const title = folderLabel(f.name, role, t)
            const baseUnread = typeof f.unread === 'number' ? f.unread : undefined
            const pending = (typeof currentAccountId === 'number')
              ? (folderUnreadPending[`${currentAccountId}:${f.path}`] ?? 0)
              : 0
            const displayUnread = typeof baseUnread === 'number' ? Math.max(0, baseUnread + pending) : undefined
            const allowBadgeForHidden = role === '\\Drafts' // In Drafts show draft count as a separate badge.
            const hasExplicitBadgePref = typeof pref?.includeInBadges === 'boolean'
            const showBadge = pref?.includeInBadges ?? (role === '\\Inbox')
            const hiddenByLegacySetting = !hasExplicitBadgePref && hiddenUnreadPaths.has(f.path) && !allowBadgeForHidden
            return (
              <Fragment key={f.path}>
                <button
                  className={`folder-btn ${(viewMode === 'account' && currentFolder === f.path) ? 'folder-active' : ''}`}
                  data-testid={`folder-${encodeURIComponent(f.path)}`}
                  data-tooltip={sidebarExpanded ? undefined : title}
                  onClick={() => switchFolder(f.path)}
                  onContextMenu={(e) => {
                    if (typeof currentAccountId !== 'number') return
                    openFolderContextMenu(e, currentAccountId, f.path, title, role)
                  }}
                  onDragOver={(e) => {
                    if (!hasAccount || viewMode !== 'account') return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    if (!hasAccount || viewMode !== 'account') return
                    e.preventDefault()
                    // Refs, not bare UIDs (§2.238): each moves out of the folder
                    // it was read from. `parseMailRefs` is fail-closed — a
                    // payload it cannot fully understand yields no move at all.
                    // The payload then SELECTS among the messages this renderer
                    // holds; it never addresses one on its own, so a ref naming
                    // a mailbox the user never loaded resolves to nothing and
                    // moves nothing. Nothing resolved => do nothing at all (no
                    // fallback to the open folder — that was the §2.238 bug).
                    const dropped = resolveKnownRefs(
                      parseMailRefs(e.dataTransfer.getData(DRAG_MAILREFS_MIME)),
                      threadRowsRef.current,
                    )
                    if (dropped.length === 0) return
                    void moveMessagesToFolder(dropped, f.path)
                  }}
                >
                  <FolderIcon role={role} customIcon={pref?.icon} />
                  <span className="sidebar-label">{title}</span>
                  {typeof displayUnread === 'number' && displayUnread > 0 && showBadge && !hiddenByLegacySetting && (
                    <span className="folder-badge" data-testid={`folder-badge-${encodeURIComponent(f.path)}`}>{displayUnread}</span>
                  )}
                </button>
                {f.path === 'INBOX' && (
                  <>
                    <button
                      className={`folder-btn ${(viewMode === 'account' && currentFolder === OUTBOX_FOLDER) ? 'folder-active' : ''}`}
                      data-testid="folder-Outbox"
                      data-tooltip={sidebarExpanded ? undefined : t('folders.outbox')}
                      onClick={() => switchFolder(OUTBOX_FOLDER)}
                      disabled={!hasAccount}
                    >
                      <Clock3 size={18} />
                      <span className="sidebar-label">{t('folders.outbox')}</span>
                      {outboxItems.length > 0 && <span className="folder-badge">{outboxItems.length}</span>}
                    </button>
                    <button
                      className={`folder-btn ${isSnoozedFolder ? 'folder-active' : ''}`}
                      data-testid="folder-Snoozed"
                      data-tooltip={sidebarExpanded ? undefined : t('folders.snoozed')}
                      onClick={() => switchFolder(SNOOZED_FOLDER)}
                      disabled={!hasAccount}
                    >
                      <AlarmClock size={18} />
                      <span className="sidebar-label">{t('folders.snoozed')}</span>
                      {filteredSnoozedItems.length > 0 && <span className="folder-badge">{filteredSnoozedItems.length}</span>}
                    </button>
                    <button
                      className={`folder-btn ${isFollowUpFolder ? 'folder-active' : ''}`}
                      data-testid="folder-FollowUp"
                      data-tooltip={sidebarExpanded ? undefined : t('folders.followUp')}
                      onClick={() => switchFolder(FOLLOWUP_FOLDER)}
                      disabled={!hasAccount}
                    >
                      <Bell size={18} />
                      <span className="sidebar-label">{t('folders.followUp')}</span>
                      {followUpItems.length > 0 && <span className="folder-badge">{followUpItems.length}</span>}
                    </button>
                    <button
                      className={`folder-btn ${isReadLaterFolder ? 'folder-active' : ''}`}
                      data-testid="folder-ReadLater"
                      data-tooltip={sidebarExpanded ? undefined : t('folders.readLater')}
                      onClick={() => switchFolder(READLATER_FOLDER)}
                      disabled={!hasAccount}
                    >
                      <BookOpen size={18} />
                      <span className="sidebar-label">{t('folders.readLater')}</span>
                      {filteredReadLaterItems.length > 0 && <span className="folder-badge">{filteredReadLaterItems.length}</span>}
                    </button>
                  </>
                )}
              </Fragment>
            )
          })}
          {!hasVisibleInboxFolder && (
            <>
              <button
                className={`folder-btn ${(viewMode === 'account' && currentFolder === OUTBOX_FOLDER) ? 'folder-active' : ''}`}
                data-testid="folder-Outbox"
                data-tooltip={sidebarExpanded ? undefined : t('folders.outbox')}
                onClick={() => switchFolder(OUTBOX_FOLDER)}
                disabled={!hasAccount}
              >
                <Clock3 size={18} />
                <span className="sidebar-label">{t('folders.outbox')}</span>
                {outboxItems.length > 0 && <span className="folder-badge">{outboxItems.length}</span>}
              </button>
              <button
                className={`folder-btn ${isSnoozedFolder ? 'folder-active' : ''}`}
                data-testid="folder-Snoozed"
                data-tooltip={sidebarExpanded ? undefined : t('folders.snoozed')}
                onClick={() => switchFolder(SNOOZED_FOLDER)}
                disabled={!hasAccount}
              >
                <AlarmClock size={18} />
                <span className="sidebar-label">{t('folders.snoozed')}</span>
                {filteredSnoozedItems.length > 0 && <span className="folder-badge">{filteredSnoozedItems.length}</span>}
              </button>
              <button
                className={`folder-btn ${isFollowUpFolder ? 'folder-active' : ''}`}
                data-testid="folder-FollowUp"
                data-tooltip={sidebarExpanded ? undefined : t('folders.followUp')}
                onClick={() => switchFolder(FOLLOWUP_FOLDER)}
                disabled={!hasAccount}
              >
                <Bell size={18} />
                <span className="sidebar-label">{t('folders.followUp')}</span>
                {followUpItems.length > 0 && <span className="folder-badge">{followUpItems.length}</span>}
              </button>
              <button
                className={`folder-btn ${isReadLaterFolder ? 'folder-active' : ''}`}
                data-testid="folder-ReadLater"
                data-tooltip={sidebarExpanded ? undefined : t('folders.readLater')}
                onClick={() => switchFolder(READLATER_FOLDER)}
                disabled={!hasAccount}
              >
                <BookOpen size={18} />
                <span className="sidebar-label">{t('folders.readLater')}</span>
                {filteredReadLaterItems.length > 0 && <span className="folder-badge">{filteredReadLaterItems.length}</span>}
              </button>
            </>
          )}
          </div>

          {/* Bottom actions */}
          <button
            className="sidebar-bottom-btn"
            data-testid="sidebar-sync"
            data-tooltip={sidebarExpanded ? undefined : t('app.sidebar.sync')}
            onClick={() => void syncCurrentView()}
            disabled={!hasAccount || syncing}
          >
            <RefreshCw size={18} className={syncing ? 'spin' : ''} />
            <span className="sidebar-label">{t('app.sidebar.sync')}</span>
          </button>
          <button
            className={`sidebar-bottom-btn${aiPanelOpen ? ' sidebar-btn-active' : ''}`}
            data-testid="sidebar-ai"
            data-tooltip={sidebarExpanded ? undefined : t('ai.sidebar.ai')}
            onClick={toggleAiPanel}
          >
            <Sparkles size={18} />
            <span className="sidebar-label">{t('ai.sidebar.ai')}</span>
          </button>
          <button
            className={`sidebar-bottom-btn${workOffline ? ' sidebar-btn-active' : ''}`}
            data-testid="sidebar-work-offline"
            data-tooltip={sidebarExpanded ? undefined : t('app.sidebar.workOffline')}
            onClick={async () => {
              const next = !workOffline
              setWorkOffline(next)
              // Only the changed field — see setGroupConversationsAndPersist.
              await window.api.invoke('settings:save', { workOffline: next })
            }}
          >
            {workOffline ? <WifiOff size={18} /> : <Wifi size={18} />}
            <span className="sidebar-label">{t('app.sidebar.workOffline')}</span>
          </button>
          <button
            className="sidebar-bottom-btn"
            data-testid="open-settings"
            data-tooltip={sidebarExpanded ? undefined : t('app.sidebar.settings')}
            onClick={() => void window.api.invoke('ui:openSettings')}
          >
            <Settings size={18} />
            <span className="sidebar-label">{t('app.sidebar.settings')}</span>
          </button>
          <button
            className="sidebar-toggle-btn"
            onClick={toggleSidebar}
            data-tooltip={sidebarExpanded ? undefined : t('app.sidebar.expand')}
          >
            {sidebarExpanded ? <ChevronsLeft size={16} /> : <ChevronsRight size={16} />}
            <span className="sidebar-label">{t('app.sidebar.collapse')}</span>
          </button>
        </aside>

        {/* Mail list */}
        <section className="mail-list" data-testid="inbox-list">
          {/* §2.157 — mailboxes whose sign-in expired. Rendered above the list
              header (not as a modal): the failure is not urgent but it is
              open-ended, so it has to stay visible until it is fixed. Driven
              off `accounts`, so a flag for an account that no longer exists
              renders nothing. */}
          {accounts
            .filter(a => accountsNeedingReauth.has(a.id))
            .map(a => (
              <AccountAuthBadge
                key={a.id}
                accountId={a.id}
                accountLabel={(a.name || a.email || a.imap.user || '').trim()}
                onFix={openAccountForReauth}
              />
            ))}
          <div className="mail-list-header">
            <div className="mail-list-top-row">
              <span className="mail-list-title">
                {viewMode === 'unified'
                  ? t('unified.title')
                  : (currentFolder === OUTBOX_FOLDER
                      ? t('folders.outbox')
                      : currentFolder === FOLLOWUP_FOLDER
                        ? t('folders.followUp')
                        : folderLabel(currentFolderMeta?.name ?? currentFolder, getFolderRole(currentFolder, currentFolderMeta?.specialUse || null, roles), t))}
                {viewMode === 'account' && currentAccount && (
                  <span className="mail-list-account">
                    {(currentAccount.name || currentAccount.imap.user || '').trim()}
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                {syncing && (
                  <span className="sync-indicator">
                    <Loader2 size={12} className="spin" /> {t('app.syncing')}
                  </span>
                )}
                <NotificationCenter
                  labels={{
                    title: t('notificationCenter.title'),
                    markAllRead: t('notificationCenter.markAllRead'),
                    empty: t('notificationCenter.empty'),
                    followUpDue: t('notificationCenter.followUpDue'),
                    sendFailed: t('notificationCenter.sendFailed'),
                    dismiss: t('notificationCenter.dismiss'),
                  }}
                  onFollowUpClick={() => switchFolder(FOLLOWUP_FOLDER)}
                />
              </span>
            </div>
            <div className={`search-bar${q ? ' search-active' : ''}${searching || paginatingSearch ? ' search-loading' : ''}`}>
              {searching || paginatingSearch ? <Loader2 size={14} className="search-icon spin" /> : <Search size={14} className="search-icon" />}
              <input
                data-testid="search-input"
                placeholder={t('app.search.placeholder')}
                value={q}
                disabled={isOutboxFolder}
                onChange={e => {
                  const val = e.target.value
                  setQ(val)
                  if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current)
                  // Only auto-search with 3+ chars to avoid expensive queries on short input.
                  // Empty string triggers immediately (clears search).
                  if (val === '' || val.trim().length >= 3) {
                    searchDebounceRef.current = window.setTimeout(() => { void onSearchRef.current(val) }, val === '' ? 0 : 600)
                  } else if (activeSearchRef.current !== null || searching) {
                    // 1-2 chars: don't dispatch a new search yet, but fully tear down the
                    // previous query AND reload the base folder/inbox view so the list
                    // doesn't keep showing stale results of the prior 3+-char query.
                    // onSearch('') bumps seq, cancels in-flight worker, clears spinners,
                    // resets cursors and repopulates mails.
                    searchDebounceRef.current = window.setTimeout(() => { void onSearchRef.current('') }, 0)
                  }
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current)
                    void onSearchRef.current((e.target as HTMLInputElement).value)
                  }
                }}
              />
            {q && (
              <button
                className="search-clear"
                onClick={() => {
                  if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current)
                  setQ('')
                  // Don't touch globalCoverageStats — it's owned by the 30s timer.
                  // onSearchRef will fire after re-render with q=''
                  searchDebounceRef.current = window.setTimeout(() => { void onSearchRef.current('') }, 0)
                }}
                aria-label={t('app.search.clear')}
              >
                <X size={14} />
              </button>
            )}
          </div>

            {/* Search scope selector */}
            {q && !isOutboxFolder && (
              <div className="search-scope-bar" data-testid="search-scope-bar">
                <div className="search-scope-buttons">
                  {viewMode === 'account' && (
                    <button
                      type="button"
                      data-testid="search-scope-folder"
                      className={`scope-chip${searchScope === 'folder' ? ' scope-active' : ''}`}
                      onClick={() => { setSearchScope('folder'); void onSearchRef.current(undefined, 'folder') }}
                      title={t('app.search.scopeFolder')}
                    >
                      <FolderSearch size={12} /> {t('app.search.scopeFolder')}
                    </button>
                  )}
                  {viewMode === 'account' && (
                    <button
                      type="button"
                      data-testid="search-scope-account"
                      className={`scope-chip${searchScope === 'account' ? ' scope-active' : ''}`}
                      onClick={() => { setSearchScope('account'); void onSearchRef.current(undefined, 'account') }}
                      title={t('app.search.scopeAccount')}
                    >
                      <Mail size={12} /> {t('app.search.scopeAccount')}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="search-scope-all"
                    className={`scope-chip${searchScope === 'all' || viewMode === 'unified' ? ' scope-active' : ''}`}
                    onClick={() => { setSearchScope('all'); void onSearchRef.current(undefined, 'all') }}
                    title={t('app.search.scopeAll')}
                  >
                    <Globe size={12} /> {t('app.search.scopeAll')}
                  </button>
                </div>
                <div className="search-scope-buttons">
                  {(() => {
                    // The chip "active" state must mirror what the worker is actually using:
                    // for advanced queries we silently downgrade relevance → date, so reflect that here.
                    const advanced = isAdvancedQuery(q)
                    const effectiveSortNow: 'relevance' | 'date' =
                      searchSort === 'relevance' && advanced ? 'date' : searchSort
                    return (
                      <>
                        <button
                          type="button"
                          data-testid="search-sort-date"
                          className={`scope-chip${effectiveSortNow === 'date' ? ' scope-active' : ''}`}
                          onClick={() => { setSearchSort('date'); void onSearchRef.current(undefined, undefined, 'date') }}
                          title={t('app.search.sortDate')}
                        >
                          <Clock3 size={12} /> {t('app.search.sortDate')}
                        </button>
                        <button
                          type="button"
                          data-testid="search-sort-relevance"
                          className={`scope-chip${effectiveSortNow === 'relevance' ? ' scope-active' : ''}`}
                          disabled={advanced}
                          onClick={() => { setSearchSort('relevance'); void onSearchRef.current(undefined, undefined, 'relevance') }}
                          title={advanced ? t('app.search.sortRelevanceUnavailable') : t('app.search.sortRelevance')}
                        >
                          <Sparkles size={12} /> {t('app.search.sortRelevance')}
                        </button>
                      </>
                    )
                  })()}
                </div>
              </div>
            )}

            {!isOutboxFolder && (
            <div className="quick-filter-toolbar">
              <button
                type="button"
                data-testid="filter-unread"
                className={`filter-chip${filterMode === 'unread' ? ' chip-on' : ''}`}
                onClick={() => setFilterMode(prev => (prev === 'unread' ? 'all' : 'unread'))}
                title={t('mail.filters.unread')}
              >
                {t('mail.filters.unread')}
              </button>
              <button
                type="button"
                data-testid="filter-attachments"
                className={`filter-chip${filterMode === 'attachments' ? ' chip-on' : ''}`}
                onClick={() => setFilterMode(prev => (prev === 'attachments' ? 'all' : 'attachments'))}
                title={t('mail.filters.attachments')}
              >
                {t('mail.filters.attachments')}
              </button>
              <button
                type="button"
                data-testid="filter-flagged"
                className={`filter-chip${filterMode === 'flagged' ? ' chip-on' : ''}`}
                onClick={() => setFilterMode(prev => (prev === 'flagged' ? 'all' : 'flagged'))}
                title={t('mail.filters.flagged')}
              >
                {t('mail.filters.flagged')}
              </button>
            </div>
            )}

            {!isOutboxFolder && (
            <div className="list-actions">
              <button className="btn-icon" disabled={selectedCount === 0} onClick={() => void setSeenForMany(true)} title={selectedCount === 0 ? t('mail.actions.selectToAct') : t('mail.actions.markRead')}>
                <MailOpen size={16} />
              </button>
              <button data-testid="bulk-mark-unread" className="btn-icon" disabled={selectedCount === 0} onClick={() => void setSeenForMany(false)} title={selectedCount === 0 ? t('mail.actions.selectToAct') : t('mail.actions.markUnread')}>
                <MailCheck size={16} />
              </button>
              <button className="btn-icon" disabled={selectedCount === 0 || (viewMode === 'account' && !roles.junk)} onClick={() => void bulkSpam()} title={selectedCount === 0 ? t('mail.actions.selectToAct') : t('mail.actions.spam')}>
                <ShieldAlert size={16} />
              </button>
              <button className="btn-icon" disabled={selectedCount === 0 || (viewMode === 'account' && !roles.archive)} onClick={() => void bulkArchive()} title={selectedCount === 0 ? t('mail.actions.selectToAct') : t('mail.actions.archive')}>
                <Archive size={16} />
              </button>
              <button className="btn-icon" disabled={selectedCount === 0} onClick={() => void bulkDelete()} title={selectedCount === 0 ? t('mail.actions.selectToAct') : t('mail.actions.delete')}>
                <Trash2 size={16} />
              </button>
              <select
                className="select-sm"
                disabled={selectedCount === 0 || viewMode !== 'account'}
                value=""
                onChange={(e) => {
                  const to = e.target.value
                  if (to) void bulkMove(to)
                  e.currentTarget.value = ''
                }}
                title={selectedCount === 0 ? t('mail.actions.selectToAct') : viewMode !== 'account' ? t('mail.actions.moveNotInUnified') : t('mail.actions.moveToFolder')}
              >
                <option value="">{t('mail.actions.moveToFolder')}</option>
                {folders.filter(f => f.path !== currentFolder).map(f => (
                  <option key={f.path} value={f.path}>{f.path}</option>
                ))}
              </select>
            </div>
            )}
          </div>

          {isOutboxFolder ? (
            outboxLoading ? (
              <div className="empty-state">
                <Loader2 size={32} className="spin" />
                <p>{t('app.empty.loading.title')}</p>
              </div>
            ) : outboxItems.length === 0 ? (
              <div className="empty-state" data-testid="outbox-empty">
                <Inbox size={40} strokeWidth={1} />
                <p>{t('outbox.empty.title')}</p>
                <small>{t('outbox.empty.hint')}</small>
              </div>
            ) : (
              <div className="outbox-list" data-testid="outbox-list">
                {outboxItems.map(item => {
                  const to = (item.messageData.to || '').trim()
                  const subject = (item.messageData.subject || '').trim() || t('outbox.noSubject')
                  const sendAt = new Date(item.sendAt)
                  const sendAtLabel = Number.isNaN(sendAt.getTime()) ? item.sendAt : sendAt.toLocaleString()
                  const busy = outboxActionId === item.id
                  return (
                    <div key={item.id} className={`outbox-item outbox-item-${item.status}`} data-testid="outbox-item">
                      <div className="outbox-item-top">
                        <span className="outbox-item-subject">{subject}</span>
                        <span className={`outbox-item-status outbox-item-status-${item.status}`}>{t(`outbox.status.${item.status}`)}</span>
                      </div>
                      <div className="outbox-item-meta">
                        <span>{to || '—'}</span>
                        <span>{sendAtLabel}</span>
                      </div>
                      {item.lastError && <div className="outbox-item-error">{item.lastError}</div>}
                      <div className="outbox-item-actions">
                        <button
                          type="button"
                          data-testid="outbox-send-now"
                          onClick={() => void sendQueuedNow(item)}
                          disabled={busy || item.status === 'sending'}
                        >
                          {t('outbox.actions.sendNow')}
                        </button>
                        <button
                          type="button"
                          data-testid="outbox-edit"
                          onClick={() => void cancelQueuedSend(item, { edit: true })}
                          disabled={busy || item.status === 'sending'}
                        >
                          {t('outbox.actions.edit')}
                        </button>
                        <button
                          type="button"
                          data-testid="outbox-cancel"
                          onClick={() => void cancelQueuedSend(item)}
                          disabled={busy || item.status === 'sending'}
                        >
                          {t('outbox.actions.cancel')}
                        </button>
                        <button
                          type="button"
                          data-testid="outbox-postpone"
                          onClick={() => void postponeQueuedSend(item, 15)}
                          disabled={busy || item.status === 'sending'}
                        >
                          {t('outbox.actions.postpone15')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : isSnoozedFolder ? (
            filteredSnoozedItems.length === 0 ? (
              <div className="empty-state" data-testid="snoozed-empty">
                <Clock3 size={40} strokeWidth={1} />
                <p>{t('snooze.empty.title')}</p>
                <small>{t('snooze.empty.hint')}</small>
              </div>
            ) : (
              <div className="outbox-list" data-testid="snoozed-list">
                {filteredSnoozedItems.map(item => {
                  const wakeAt = new Date(item.wakeAt)
                  const wakeLabel = Number.isNaN(wakeAt.getTime()) ? item.wakeAt : wakeAt.toLocaleString()
                  return (
                    <div
                      key={item.id}
                      className={`vfolder-item${item.uid != null ? ' vfolder-item-clickable' : ''}`}
                      onClick={() => {
                        if (item.uid == null) return
                        const summary: MailSummary = {
                          accountId: item.accountId,
                          folder: item.folder,
                          uid: item.uid,
                          subject: item.subject,
                          from: item.from,
                          date: item.date,
                          unread: item.unread,
                          flagged: false,
                        }
                        void openMail(summary)
                      }}
                    >
                      <div className="vfolder-item-info">
                        <div className="vfolder-item-subject">{item.subject || t('outbox.noSubject')}</div>
                        <div className="vfolder-item-meta">
                          <span>{item.from || '—'}</span>
                          <span> · {t('snooze.wakeAt', { time: wakeLabel })}</span>
                        </div>
                      </div>
                      <div className="vfolder-item-actions">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void window.api.invoke('mail:snoozeRemove', item.id)
                          }}
                          title={t('snooze.cancel')}
                        >
                          {t('snooze.cancel')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : isFollowUpFolder ? (
            followUpItems.length === 0 ? (
              <div className="empty-state" data-testid="followup-empty">
                <Bell size={40} strokeWidth={1} />
                <p>{t('followUp.empty')}</p>
              </div>
            ) : (
              <div className="followup-list" data-testid="followup-list">
                {followUpItems.map(item => {
                  const remindAt = new Date(item.remindAt)
                  const remindLabel = Number.isNaN(remindAt.getTime()) ? item.remindAt : remindAt.toLocaleString()
                  return (
                    <div key={item.id} className="followup-item">
                      <div className="followup-item-info">
                        <div className="followup-item-subject">{item.subject || t('outbox.noSubject')}</div>
                        <div className="followup-item-meta">
                          <span>{t('followUp.to', { address: item.toAddr })}</span>
                          <span> · {t('followUp.dueSince', { date: remindLabel })}</span>
                        </div>
                      </div>
                      <div className="followup-item-actions">
                        <button
                          type="button"
                          onClick={() => {
                            void window.api.invoke('followup:dismiss', item.id).then(() => loadFollowUps())
                          }}
                          title={t('followUp.dismiss')}
                        >
                          {t('followUp.dismiss')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : isReadLaterFolder ? (
            filteredReadLaterItems.length === 0 ? (
              <div className="empty-state" data-testid="readlater-empty">
                <BookOpen size={40} strokeWidth={1} />
                <p>{t('readLater.empty.title')}</p>
                <small>{t('readLater.empty.hint')}</small>
              </div>
            ) : (
              <div className="outbox-list" data-testid="readlater-list">
                {filteredReadLaterItems.map(item => (
                  <div
                    key={item.id}
                    className="vfolder-item vfolder-item-clickable"
                    onClick={() => {
                      const summary: MailSummary = {
                        accountId: item.accountId,
                        folder: item.folder,
                        uid: item.uid,
                        subject: item.subject,
                        from: item.from,
                        date: item.date,
                        unread: false,
                        flagged: false,
                      }
                      void openMail(summary)
                    }}
                  >
                    <div className="vfolder-item-info">
                      <div className="vfolder-item-subject">{item.subject || t('outbox.noSubject')}</div>
                      <div className="vfolder-item-meta">
                        <span>{item.from || '—'}</span>
                        {item.date && <span> · {formatSmartDate(item.date, t).display}</span>}
                      </div>
                    </div>
                    <div className="vfolder-item-actions">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.api.invoke('mail:readLaterRemove', item.id, item.accountId)
                        }}
                        title={t('readLater.remove')}
                      >
                        {t('readLater.remove')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : !hasAccount ? (
            <div className="empty-state">
              <Mail size={40} strokeWidth={1} />
              <p>{t('app.empty.noAccount.title')}</p>
              <small>{t('app.empty.noAccount.hint')}</small>
            </div>
          ) : mails.length === 0 ? (
            searching && q ? (
              <div className="empty-state" data-testid="search-loading">
                <Loader2 size={32} className="spin" />
                <p>{t('app.search.searching')}</p>
              </div>
            ) : inboxZeroCount > 0 && (viewMode === 'unified' || currentFolder === 'INBOX') ? (
              <div className="empty-state">
                <CheckCircle2 size={40} strokeWidth={1} className="inbox-zero-icon" />
                <p>{t('inboxZero.congrats')}</p>
                <small>{t('inboxZero.processedToday', { count: inboxZeroCount })}</small>
              </div>
            ) : (
              <div className="empty-state">
                <Inbox size={40} strokeWidth={1} />
                <p>{t('app.empty.noMessages.title')}</p>
                <small>{t('app.empty.noMessages.hint')}</small>
              </div>
            )
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              style={{ flex: 1 }}
              data={threadRows}
              computeItemKey={(_i, row) => row.key}
              endReached={canAutoPage ? loadPage : undefined}
              components={virtuosoComponents}
              itemContent={(_i, row) => {
                const m = row.lead
                const sd = formatSmartDate(m.date, t)
                const accountLabel = (() => {
                  const a = accountsById.get(m.accountId)
                  return a ? ((a.imap.user || a.smtp.user || a.name || '').trim() || `#${m.accountId}`) : `#${m.accountId}`
                })()
                const activeKey = active ? mailKey(active) : null
                const rowHasActive = Boolean(activeKey && row.items.some(item => mailKey(item) === activeKey))
                const rowHasSelected = rowIsSelected(row, selectedKeys)
                const accountColor = (() => {
                  if (viewMode !== 'unified') return null
                  const a = accountsById.get(m.accountId)
                  if (typeof a?.colorIndex === 'number') return getPaletteColor(a.colorIndex)
                  const seed = a ? (a.smtp.user || a.imap.user || '') : ''
                  return getAvatarColor(seed || String(m.accountId))
                })()
                return (
                <div
                  data-testid="mail-item"
                  className={`mail-item ${rowHasSelected ? 'mail-selected' : ''} ${rowHasActive ? 'mail-active' : ''} ${row.unreadCount > 0 ? 'mail-unread' : ''}`}
                  onClick={(e) => onMailClick(e, m, row)}
                  onContextMenu={(e) => openContextMenu(e, m)}
                  draggable={hasAccount && viewMode === 'account'}
                  onDragStart={(e) => onDragStartMail(e, m)}
                  style={viewMode === 'unified' && accountColor ? { borderLeft: `4px solid ${accountColor}` } : undefined}
                >
                  <MailAvatar
                    from={m.from}
                    fromAddr={m.fromAddr}
                    gravatarEnabled={gravatarInMail}
                    title={m.fromAddr ? t('mail.filters.fromTooltip', { from: m.from || m.fromAddr }) : undefined}
                    onClick={(e) => {
                      if (!m.fromAddr) return
                      e.stopPropagation()
                      const nextQ = `from:${m.fromAddr}`
                      if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current)
                      setQ(nextQ)
                      // onSearchRef will fire after re-render with q=...
                      searchDebounceRef.current = window.setTimeout(() => { void onSearchRef.current(nextQ) }, 0)
                    }}
                  />
                  <div className="mail-content">
                    <div className="mail-top-row">
                      <span className="mail-from">
                        {m.from}
                        {viewMode === 'unified' && <span className="mail-account-tag"> · {accountLabel}</span>}
                        {q && (viewMode === 'unified' || searchScope !== 'folder') && (
                          <span className="mail-folder-tag"> {m.folder !== 'INBOX' ? m.folder.replace(/.*\//, '') : t('folders.inbox')}</span>
                        )}
                      </span>
                      <span className="mail-right">
                        {m.hasAttachments && <Paperclip size={12} className="mail-attachment-icon" />}
                        {/* uiaudit.2 — hover quick-action chips removed; right-click context menu is
                            the discoverability surface for archive/delete/snooze/mark actions. */}
                        <span className="mail-date" title={sd.full}>{sd.display}</span>
                        <button
                          className={`star-btn ${m.flagged ? 'star-on' : ''}`}
                          onClick={(e) => { e.stopPropagation(); void setFlaggedForMail(m, !m.flagged) }}
                          title={m.flagged ? t('mail.actions.unflag') : t('mail.actions.flag')}
                        >
                          <Star size={14} fill={m.flagged ? 'currentColor' : 'none'} />
                        </button>
                      </span>
                    </div>
                    <div className="mail-subject">
                      {m.subject}
                      {row.count > 1 && (
                        <span className="mail-thread-badge" title={t('mail.thread.countTitle', { count: row.count })}>
                          {t('mail.thread.count', { count: Math.max(1, row.count - 1) })}
                        </span>
                      )}
                      {m.pinned && <Pin size={12} className="mail-pin-icon" />}
                    </div>
                  </div>
                </div>
                )
              }}
            />
          )}

          {canManualPage && (
            <div className="load-more-row">
              <span className="load-more-hint">{t('mail.list.autoPagingDisabled')}</span>
              <button type="button" onClick={() => void loadPage()}>
                {t('mail.list.loadMore')}
              </button>
            </div>
          )}

          {error && (
            <div className="error-banner">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}
        </section>

        {/* Resize handle */}
        <div className="resize-handle" onMouseDown={startResize} />

        {/* Mail viewer */}
        <section className="mail-viewer">
          {!active ? (
            <div className="empty-state">
              <Mail size={40} strokeWidth={1} />
              <p>{t('app.empty.selectMessage.title')}</p>
              <small>{t('app.empty.selectMessage.hint')}</small>
              <small className="empty-state-tip">{t('app.empty.selectMessage.rightClickTip')}</small>
            </div>
          ) : (
            <>
              {(() => {
                // Thread-aware action targets — see `src/utils/threadToolbar.ts`
                // for the contract. In thread mode Reply/ReplyAll/Forward/Snooze
                // target the newest message; Archive/Delete/MarkRead act on the
                // whole thread (Gmail / Spark / Shortwave UX). Star / Pin / Spam /
                // Print / Open-in-window remain per-message — intrinsically so.
                const isThreadMode = computeIsThreadMode(groupConversations, activeThread)
                const latestMail = pickLatestMail(activeThread, active, isThreadMode)
                const threadUnreadCount = countThreadUnread(activeThread, isThreadMode)
                const replyTarget = pickReplyTarget(active, latestMail, isThreadMode)
                return (
              <div className="mail-viewer-header">
                <div className="mail-viewer-from">{metaFrom}</div>
                <div className="mail-viewer-subject-row">
                  <div data-testid="mail-subject" className="mail-viewer-subject">{active.subject}</div>
                  <div className="mail-viewer-actions">
                  {isDraftsFolder ? (
                    <button data-testid="mail-action-edit-draft" className="btn-icon" onClick={() => void editDraft(active)} title={t('mail.actions.editDraft')}>
                      <Pencil size={16} />
                    </button>
                  ) : (
                    <>
                      {viewMode === 'unified' && (
                        <button
                          data-testid="mail-action-open-in-account"
                          className="btn-icon"
                          onClick={() => selectAccount(active.accountId, active.folder)}
                          title={t('unified.openInAccount')}
                        >
                          <Inbox size={16} />
                        </button>
                      )}
                      <button
                        data-testid="mail-action-open-in-window"
                        className="btn-icon"
                        onClick={() => {
                          void window.api.invoke('mail:openInWindow', {
                            accountId: active.accountId,
                            folder: active.folder,
                            uid: active.uid,
                            mailKey: mailKey(active),
                          })
                        }}
                        title={t('mail.actions.openInWindow')}
                      >
                        <ExternalLink size={16} />
                      </button>
                      <button data-testid="mail-action-reply" className="btn-icon" onClick={() => void replyMail(replyTarget, 'reply')} title={t('mail.actions.reply')}>
                        <Reply size={16} />
                      </button>
                      <button data-testid="mail-action-reply-all" className="btn-icon" onClick={() => void replyMail(replyTarget, 'replyAll')} title={t('mail.actions.replyAll')}>
                        <ReplyAll size={16} />
                      </button>
                      <button data-testid="mail-action-forward" className="btn-icon" onClick={() => void replyMail(replyTarget, 'forward')} title={t('mail.actions.forward')}>
                        <Forward size={16} />
                      </button>
                    </>
                  )}
                  <button
                    className="btn-icon"
                    onClick={() => void setFlaggedForMail(active, !active.flagged)}
                    title={active.flagged ? t('mail.actions.unflag') : t('mail.actions.flag')}
                  >
                    <Star size={16} fill={active.flagged ? 'currentColor' : 'none'} />
                  </button>
                  {isThreadMode ? (
                    threadUnreadCount > 0 && (
                      <button
                        data-testid="mail-action-mark-thread-read"
                        className="btn-icon"
                        onClick={() => void markReadThread()}
                        title={t('mail.thread.markAllRead')}
                      >
                        <MailCheck size={16} />
                      </button>
                    )
                  ) : (
                    <button
                      data-testid="mail-action-toggle-seen"
                      className="btn-icon"
                      onClick={() => void setSeenForMail(active, active.unread)}
                      title={active.unread ? t('mail.actions.markRead') : t('mail.actions.markUnread')}
                    >
                      {active.unread ? <MailOpen size={16} /> : <MailCheck size={16} />}
                    </button>
                  )}
                  {!isDraftsFolder && (
                    <button
                      data-testid="mail-action-snooze"
                      className="btn-icon"
                      onClick={(e) => setSnoozeAnchor({ mail: replyTarget, rect: (e.currentTarget as HTMLButtonElement).getBoundingClientRect() })}
                      title={t('mail.actions.snooze')}
                    >
                      <AlarmClock size={16} />
                    </button>
                  )}
                  <button
                    data-testid="mail-action-spam"
                    className="btn-icon"
                    onClick={() => void spamMail()}
                    disabled={!activeRoles.junk}
                    title={activeRoles.junk ? t('mail.actions.spamTo', { junk: activeRoles.junk }) : t('mail.actions.junkNotFound')}
                  >
                    <ShieldAlert size={16} />
                  </button>
                  <button
                    data-testid="mail-action-archive"
                    className="btn-icon"
                    onClick={() => { if (isThreadMode) archiveThread(); else void archiveMail() }}
                    disabled={!activeRoles.archive}
                    title={activeRoles.archive
                      ? (isThreadMode
                          ? t('mail.thread.archiveThread')
                          : t('mail.actions.archiveTo', { archive: activeRoles.archive }))
                      : t('mail.actions.archiveNotFound')}
                  >
                    <Archive size={16} />
                  </button>
                  <button
                    data-testid="mail-action-delete"
                    className="btn-icon"
                    onClick={() => { if (isThreadMode) void deleteThread(); else void deleteMail() }}
                    title={isThreadMode
                      ? t('mail.thread.deleteThread')
                      : (activeRoles.trash && activeFolder !== activeRoles.trash
                          ? t('mail.actions.deleteToTrash', { trash: activeRoles.trash })
                          : t('mail.actions.deleteForever'))}
                  >
                    <Trash2 size={16} />
                  </button>
                  <button
                    data-testid="mail-action-pin"
                    className="btn-icon"
                    onClick={() => void togglePin(active)}
                    title={active.pinned ? t('mail.actions.unpin') : t('mail.actions.pin')}
                  >
                    <Pin size={16} />
                  </button>
                  <button
                    data-testid="mail-action-print"
                    className="btn-icon"
                    onClick={printMailIframe}
                    title={t('mail.actions.print')}
                  >
                    <Printer size={16} />
                  </button>
                </div>
                </div>
              </div>
                )
              })()}
              {groupConversations && activeThread && activeThread.count > 1 ? (
                <ThreadView
                  thread={activeThread}
                  activeKey={active ? mailKey(active) : null}
                  onCardOpen={item => { void openMail(item) }}
                  gravatarEnabled={gravatarInMail}
                  summaryEnabled={isAiFeatureEnabledForAccount(aiThreadSummaryEnabled, active?.accountId ?? activeThread.lead?.accountId)}
                  instantReplyEnabled={isAiFeatureEnabledForAccount(aiInstantReplyEnabled, active?.accountId ?? activeThread.lead?.accountId)}
                  onInstantReplyPick={(ref, draft) => { void instantReplyPick(ref, draft) }}
                  renderBody={() => (
                    <MailBodyContent
                      active={active}
                      details={details}
                      identities={accountIdentities}
                      loadingBody={loadingBody}
                      metaTo={metaTo}
                      metaCc={metaCc}
                      metaBcc={metaBcc}
                      isSentByMe={isSentByMe}
                      metaDate={metaDate}
                      mailHasExternalImages={mailHasExternalImages}
                      alwaysLoadImages={alwaysLoadImages}
                      showExternalImages={showExternalImages}
                      mailIframeDoc={mailIframeDoc}
                      hiddenAttachments={mailHiddenAttachments}
                      iframeKey={`${activeKey}:${alwaysLoadImages || showExternalImages ? 'ext' : 'safe'}`}
                      mailIframeRef={mailIframeRef}
                      activeMailKey={`${active?.accountId}:${active?.folder}:${active?.uid}`}
                      savingAttachment={savingAttachment}
                      onShowExternalImages={() => setShowExternalImages(true)}
                      onRetry={() => { if (active) void openMail(active) }}
                      onDownloadAttachment={att => { if (active) void saveAttachment(active, att) }}
                      onShowFullMessage={requestFullMessage}
                      loadingFullMessage={loadingFull}
                      translation={mailTranslation}
                    />
                  )}
                />
              ) : (
                <>
                  {/* §3.3 B4 Instant Reply — single-message reading-pane parity.
                      The strip appears on the active single message when the
                      per-account opt-in is ON for THAT message's account
                      (fail-closed backend still applies). Same no-auto-send
                      behavior as the thread path: picking a draft only prefills
                      a new Compose. */}
                  {active && isAiFeatureEnabledForAccount(aiInstantReplyEnabled, active.accountId) && (
                    <SingleMessageInstantReply
                      message={{
                        accountId: active.accountId,
                        folder: active.folder,
                        uid: active.uid,
                        messageId: active.messageId ?? null,
                      }}
                      onPick={(ref, draft) => { void instantReplyPick(ref, draft) }}
                    />
                  )}
                  <MailBodyContent
                    active={active}
                    details={details}
                    identities={accountIdentities}
                    loadingBody={loadingBody}
                    metaTo={metaTo}
                    metaCc={metaCc}
                    metaBcc={metaBcc}
                    isSentByMe={isSentByMe}
                    metaDate={metaDate}
                    mailHasExternalImages={mailHasExternalImages}
                    alwaysLoadImages={alwaysLoadImages}
                    showExternalImages={showExternalImages}
                    mailIframeDoc={mailIframeDoc}
                    hiddenAttachments={mailHiddenAttachments}
                    iframeKey={`${activeKey}:${alwaysLoadImages || showExternalImages ? 'ext' : 'safe'}`}
                    mailIframeRef={mailIframeRef}
                    activeMailKey={`${active?.accountId}:${active?.folder}:${active?.uid}`}
                    savingAttachment={savingAttachment}
                    onShowExternalImages={() => setShowExternalImages(true)}
                    onRetry={() => { if (active) void openMail(active) }}
                    onDownloadAttachment={att => { if (active) void saveAttachment(active, att) }}
                    onShowFullMessage={requestFullMessage}
                    loadingFullMessage={loadingFull}
                    translation={mailTranslation}
                  />
                </>
              )}
            </>
          )}
        </section>

        {/* AI panel */}
        {aiPanelOpen && (
          <div
            className="ai-drag-handle"
            onMouseDown={e => {
              e.preventDefault()
              const startX = e.clientX
              const startW = aiPanelWidth
              let currentW = startW
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
              // Block pointer-events on iframes so they don't capture mouse events during drag.
              document.querySelectorAll('iframe').forEach(f => ((f as HTMLElement).style.pointerEvents = 'none'))
              const onMove = (ev: MouseEvent) => {
                const delta = startX - ev.clientX
                currentW = Math.max(280, Math.min(600, startW + delta))
                setAiPanelWidth(currentW)
              }
              const onUp = () => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                window.removeEventListener('blur', onUp)
                document.body.style.cursor = ''
                document.body.style.userSelect = ''
                document.querySelectorAll('iframe').forEach(f => { (f as HTMLElement).style.removeProperty('pointer-events') })
                // Persist width without triggering a full settings:changed broadcast
                // to avoid re-rendering the entire app and disrupting the active email view.
                void window.api.invoke('settings:save', { aiPanelWidth: currentW })
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
              window.addEventListener('blur', onUp)
            }}
          />
        )}
        {aiPanelOpen && (
          <AiPanel
            open={aiPanelOpen}
            onClose={() => setAiPanelOpen(false)}
            contextType={aiContextType}
            contextData={aiContextData}
            aiProvider={aiProvider}
            aiPrivacyConsent={aiPrivacyConsent}
            aiSendOnEnter={aiSendOnEnter}
            aiShowSources={aiShowSources}
            aiEgressPolicy={aiEgressPolicy}
            onSettingsChange={handleAiSettingsChange}
            onOpenSource={openAiSource}
            quickPrompt={aiQuickPrompt}
            onQuickPromptHandled={() => setAiQuickPrompt(null)}
          />
        )}
      </div>

      {/* Status bar — sync and index progress */}
      <div className="statusbar" data-testid="statusbar">
        {(() => {
          const stats = globalCoverageStats
          const fc = stats?.folderCoverage
          const parts: string[] = []
          // Show current sync folder with progress.
          // Use prettyFolderName so raw IMAP paths like "[Gmail]/Sent Mail"
          // are displayed as the localised role label (e.g. "Sent").
          if (syncFolderProgress) {
            const { account, folder, fetched, total } = syncFolderProgress
            const shortAccount = account.split('@')[0] || account
            const pct = total && total > 0 ? Math.round(Math.min(fetched / total, 1) * 100) : null
            const progress = total != null
              ? `${Math.min(fetched, total).toLocaleString()}/${total.toLocaleString()}${pct != null ? ` (${pct}%)` : ''}`
              : `${fetched.toLocaleString()}`
            const folderDisplay = prettyFolderName(folder, roles, t)
            parts.push(`${shortAccount} ${folderDisplay} ${progress}`)
          }
          if (fc && fc.total > 0) {
            const covered = fc.coveredFull
            if (covered < fc.total) {
              parts.push(t('app.statusbar.headersCoverage', { covered, total: fc.total }))
            }
          }
          if (stats && stats.totalMessages > 0 && stats.bodyIndexed < stats.totalMessages) {
            const pct = Math.round((stats.bodyIndexed / stats.totalMessages) * 100)
            parts.push(t('app.statusbar.bodyIndex', { percent: pct }))
          }
          if (parts.length === 0) return null
          return <span className="statusbar-text">{parts.join(' · ')}</span>
        })()}
        {remoteResultCount > 0 && (
          <span className="statusbar-remote">{t('app.search.remoteResults', { count: remoteResultCount })}</span>
        )}
      </div>

      {/* Snooze dropdown */}
      {snoozeAnchor && (
        <SnoozeDropdown
          anchorRect={snoozeAnchor.rect}
          onSnooze={(wakeAt) => void snoozeMessage(snoozeAnchor.mail, wakeAt)}
          onClose={() => setSnoozeAnchor(null)}
          t={t}
        />
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          folders={foldersByAccount.current.get(ctxMenu.mail.accountId) ?? folders}
          currentFolder={ctxMenu.mail.folder}
          roles={rolesByAccount.current.get(ctxMenu.mail.accountId) ?? roles}
          onClose={closeCtxMenu}
          onToggleMoveOpen={toggleCtxMoveOpen}
          onReply={replyMail}
          onToggleSeen={hasMultiSelection
            ? () => void setSeenForMany(true)
            : setSeenForMail}
          onMove={hasMultiSelection
            ? (_mail, folder) => void bulkMove(folder)
            : moveMailToFolder}
          onSpam={hasMultiSelection ? () => bulkSpam() : spamMailTarget}
          onArchive={hasMultiSelection ? () => bulkArchive() : archiveMailTarget}
          onSnooze={(mail) => {
            setSnoozeAnchor({ mail, rect: new DOMRect(ctxMenu.x, ctxMenu.y, 0, 0) })
          }}
          onReadLater={(mail) => {
            void window.api.invoke('mail:readLaterAdd', mail.accountId, mail.folder, [mail.uid])
          }}
          onPin={(mail) => void togglePin(mail)}
          onDelete={hasMultiSelection ? () => bulkDelete() : deleteMailTarget}
          t={t}
          selectedCount={selectedCount}
        />
      )}

      {folderCtxMenu && (
        <FolderContextMenu
          menu={folderCtxMenu}
          canEditRemote={(
            folderCtxMenu.folderPath.toUpperCase() !== 'INBOX'
            && !['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive'].includes(folderCtxMenu.role || '')
          )}
          includeInBadges={(
            (folderPrefsByAccount.current.get(folderCtxMenu.accountId) ?? {})[folderCtxMenu.folderPath]?.includeInBadges
            ?? (folderCtxMenu.role === '\\Inbox')
          )}
          visible={(
            (folderPrefsByAccount.current.get(folderCtxMenu.accountId) ?? {})[folderCtxMenu.folderPath]?.visible
            ?? true
          )}
          indexInSearch={(
            (folderPrefsByAccount.current.get(folderCtxMenu.accountId) ?? {})[folderCtxMenu.folderPath]?.indexInSearch
            ?? true
          )}
          onClose={closeFolderCtxMenu}
          onRename={renameFolderFromMenu}
          onDelete={deleteFolderFromMenu}
          onChangeIcon={changeFolderIconFromMenu}
          onSetHeaderSync={setFolderSyncModeFromMenu}
          onToggleBadge={toggleFolderBadgeFromMenu}
          onToggleVisible={toggleFolderVisibilityFromMenu}
          onToggleIndexInSearch={toggleFolderIndexInSearchFromMenu}
          t={t}
        />
      )}

      {/* Keyboard shortcuts modal */}
      {showShortcuts && <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />}

      {showCommandPalette && (
        <div className="command-palette-overlay" role="presentation" onClick={() => setShowCommandPalette(false)}>
          <div className="command-palette" data-testid="command-palette" role="dialog" aria-modal="true" aria-label={t('commandPalette.ariaLabel')} onClick={e => e.stopPropagation()}>
            <div className="command-palette-input-wrap">
              <Search size={15} />
              <input
                data-testid="command-palette-input"
                role="combobox"
                aria-expanded={filteredPaletteCommands.length > 0}
                aria-controls="command-palette-listbox"
                aria-activedescendant={filteredPaletteCommands[commandIndex] ? `cmd-${filteredPaletteCommands[commandIndex].id}` : undefined}
                aria-autocomplete="list"
                value={commandQuery}
                placeholder={t('commandPalette.placeholder')}
                autoFocus
                onChange={e => setCommandQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setShowCommandPalette(false)
                    return
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setCommandIndex(i => (
                      filteredPaletteCommands.length <= 1
                        ? 0
                        : Math.min(filteredPaletteCommands.length - 1, i + 1)
                    ))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setCommandIndex(i => Math.max(0, i - 1))
                    return
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const cmd = filteredPaletteCommands[commandIndex]
                    if (cmd) runPaletteCommand(cmd)
                  }
                }}
              />
            </div>
            <div className="command-palette-list" role="listbox" id="command-palette-listbox">
              {filteredPaletteCommands.length === 0 ? (
                <div className="command-palette-empty">{t('commandPalette.empty')}</div>
              ) : (
                filteredPaletteCommands.map((cmd, idx) => (
                  <button
                    key={cmd.id}
                    type="button"
                    role="option"
                    id={`cmd-${cmd.id}`}
                    aria-selected={idx === commandIndex}
                    data-testid="command-palette-item"
                    className={`command-palette-item${idx === commandIndex ? ' command-palette-item-active' : ''}`}
                    onMouseEnter={() => setCommandIndex(idx)}
                    onClick={() => runPaletteCommand(cmd)}
                  >
                    <span className="command-palette-item-label">{cmd.label}</span>
                    {cmd.shortcut && <span className="command-palette-item-shortcut">{cmd.shortcut}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Undo-bar */}
      {undoInfo && (
        <div className="undo-bar">
          <span>
            {undoInfo.label}
            {undoInfo.messages.length > 1 && ` (${undoInfo.messages.length})`}
          </span>
          <button onClick={handleUndo}>{t('app.undo.undo')}</button>
          {undoCountdown > 0 && <span className="undo-countdown">{undoCountdown}</span>}
        </div>
      )}

      {sendUndoInfo && (
        <div className="undo-bar send-undo-bar" data-testid="send-undo-bar">
          <span>{t('app.undo.sendScheduled')}</span>
          <button data-testid="send-undo-action" onClick={() => void handleSendUndo()}>
            {t('app.undo.undo')}
          </button>
          {sendUndoCountdown > 0 && <span className="undo-countdown">{sendUndoCountdown}</span>}
        </div>
      )}

      {/* §2.23 PR1: delivered, but Sent copy failed (mail:sentCopyFailed) */}
      <SentCopyFailedToast />

      {/* TLS trust rework Phase A3 — one-time local-interception notices */}
      {certNotices.map((n) => (
        <div key={n.host} className="undo-bar" role="status" data-testid="cert-interception-notice">
          <ShieldAlert size={14} />
          <span>
            {n.issuerCn
              ? t('app.certRecovery.notice.messageWithIssuer', { host: n.host, issuer: n.issuerCn })
              : t('app.certRecovery.notice.message', { host: n.host })}
          </span>
          <button
            type="button"
            data-testid="cert-interception-dismiss"
            onClick={() => dismissCertNotice(n.host)}
          >
            {t('app.certRecovery.notice.dismiss')}
          </button>
        </div>
      ))}

      {/* Update notification */}
      {updateVersion && !canSelfUpdate && (
        <div className="update-bar">
          <span>{t('app.update.adminRequired', { version: updateVersion })}</span>
          <button onClick={() => setUpdateVersion(null)}>{t('app.update.later')}</button>
        </div>
      )}
      {updateVersion && canSelfUpdate && !updateReady && (
        <div className="update-bar">
          <span>{t('app.update.available', { version: updateVersion })}</span>
          <button
            disabled={updateDownloading}
            onClick={() => {
              setUpdateDownloading(true)
              // Handle rejection explicitly — otherwise wrapped IPC errors
              // like ERR_CONNECTION_RESET become unhandledrejection in the
              // renderer (MAILCOPILOT-8, MAILCOPILOT-A). Main also returns
              // { ok: false, reason } for known failures without throwing.
              window.api.invoke('update:download').then((res) => {
                if (res && typeof res === 'object' && 'ok' in res && !res.ok) {
                  setUpdateDownloading(false)
                }
              }).catch(() => {
                setUpdateDownloading(false)
              })
            }}
          >
            {updateDownloading ? t('app.update.downloading') : t('app.update.download')}
          </button>
          <button onClick={() => setUpdateVersion(null)}>{t('app.update.later')}</button>
        </div>
      )}
      {updateReady && canSelfUpdate && (
        <div className="update-bar">
          <span>{t('app.update.ready')}</span>
          <button className="btn-primary" onClick={() => {
            window.api.invoke('update:install').catch(() => { /* dialog shown in main */ })
          }}>
            {t('app.update.restart')}
          </button>
        </div>
      )}

      {/* Thread-level action confirmation */}
      {threadConfirm && (
        <div className="confirm-overlay" role="presentation" onClick={() => setThreadConfirm(null)}>
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <p>{t('mail.thread.confirmAction', { count: threadConfirm.msgs.length })}</p>
            <div className="confirm-dialog-actions">
              <button onClick={() => setThreadConfirm(null)}>{t('app.confirm.no')}</button>
              <button className="btn-primary" onClick={executeThreadAction}>{t('mail.thread.confirmYes')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent deletion confirmation */}
      {confirmDelete && (
        <div className="confirm-overlay" role="presentation" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-delete-title" aria-describedby="confirm-delete-desc" onClick={e => e.stopPropagation()}>
            <span className="sr-only" id="confirm-delete-title">{t('app.confirm.ariaTitle')}</span>
            <p id="confirm-delete-desc">{t('app.confirm.deleteForever', { count: confirmDelete.groups.reduce((n, g) => n + g.uids.length, 0) })}</p>
            <div className="confirm-dialog-actions">
              <button onClick={() => setConfirmDelete(null)}>{t('app.confirm.no')}</button>
              <button className="btn-primary" data-testid="confirm-delete-yes" onClick={() => void confirmDeleteAction()}>
                <Trash2 size={14} /> {t('app.confirm.yes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suspicious link warning — shared component with MailWindow */}
      {linkPrompt && (
        <LinkWarningDialog
          prompt={linkPrompt}
          onApprove={approvePrompt}
          onCancel={dismissPrompt}
        />
      )}

      {/* TLS trust rework Phase A3 — unexpected-certificate recovery dialog */}
      {certDialog && (
        <CertRecoveryDialog
          state={certDialog}
          onTrust={() => void trustCert()}
          onCancel={() => void dismissCert()}
        />
      )}
      {/* Tooltip portal — rendered outside <aside> DOM node to escape sidebar overflow:hidden */}
      {tooltipState && (
        <div
          className="tooltip-portal"
          style={{
            position: 'fixed',
            left: tooltipState.x,
            top: tooltipState.y,
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
          }}
        >
          {tooltipState.text}
        </div>
      )}
    </div>
  )
}
