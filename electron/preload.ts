import { ipcRenderer, contextBridge } from 'electron'

// Allowed IPC channels (whitelist)
const ALLOWED_INVOKE_CHANNELS = [
  'accounts:list',
  'accounts:get',
  'accounts:save',
  'accounts:remove',
  'accounts:setCurrent',
  'accounts:getCurrent',
  'accounts:autoconfig',
  'accounts:removePreview',
  'oauth:google:connect',
  'oauth:microsoft:connect',
  'net:testImap',
  'net:testSmtp',
  'net:inboxSummaries',
  'net:folderPage',
  'net:mailboxesAndRoles',
  'net:sendMail',
  'mail:scheduleSend',
  'mail:scheduleSendAt',
  'mail:cancelSend',
  'mail:queueList',
  'mail:queueSendNow',
  'mail:queueReschedule',
  'net:messageDetails',
  'net:setSeen',
  'net:setFlagged',
  'net:move',
  // §2.7: optimistic undo-window UID suppression — renderer marks UIDs that
  // it has optimistically moved out so concurrent fetches do not resurrect
  // them in the UI before the deferred IMAP MOVE actually fires.
  'net:move:pendingAdd',
  'net:move:pendingRemove',
  'net:move:pendingClear',
  'net:delete',
  'net:saveDraft',
  'net:deleteDraft',
  // §2.16 — Compose checks before reusing the per-account "last draft" id
  // from localStorage. Returns true if the draftId has been finalized
  // (sent or discarded) in this main-process session.
  'drafts:wasSent',
  'net:idleStart',
  'net:idleStop',
  'net:createMailbox',
  'net:renameMailbox',
  'net:deleteMailbox',
  'net:syncFolderHeaders',
  'net:saveAttachment',
  'net:attachmentBase64',
  'net:fetchExternalImage',
  // §2.22 Wave A — ICS / iTIP invite bridge. Renderer InviteCard calls this
  // with { accountId, uid, folder, response } to send an RSVP REPLY through
  // the per-account SMTP / Outlook Graph transport. Argument validation is
  // done server-side via Zod inside `electron/services/inviteBridge.ts`.
  'mail:rsvpInvite',
  'folder:prefs:list',
  'folder:prefs:upsert',
  'folder:prefs:remove',
  'folder:refreshCounts',
  'tls:listPins',
  'tls:addPin',
  'tls:removePin',
  'tls:getServerCert',
  // TLS trust rework Phase A2 — cert-recovery dialog actions. `net:trustCert`
  // stores a TLS pin ({ accountId, host, port, fingerprintSha256 }, zod-
  // validated in main) and triggers a resync; `cert:dismiss` ({ host })
  // suppresses re-broadcasts for the session (in-memory debounce in
  // electron/services/certRecovery.ts).
  'net:trustCert',
  'cert:dismiss',
  'contacts:search',
  'contacts:upsert',
  'cache:inboxPage',
  'cache:search',
  'cache:messageByUid',
  'cache:unifiedInboxPage',
  'cache:unifiedSearch',
  'search:indexStats',
  'search:coverageStats',
  'search:crawlStates',
  'search:remoteSearch',
  'search:cancelInflight',
  'cache:folderRoles',
  'cache:mailboxes',
  'cache:folderPrefs',
  'cache:bodyTrimPreview',
  'offline:syncNow',
  'offline:status',
  'settings:get',
  'settings:save',
  'e2e:localizeMails',
  'e2e:injectCalendarMail',
  // §3.3.C-uiaudit.22 — inject arbitrary mail fixture for recipient overflow tests.
  'e2e:injectMail',
  'compose:getInit',
  'ui:openSettings',
  'ui:openAccount',
  'ui:openCompose',
  // uiaudit.3 PR B4: open a single message in a standalone BrowserWindow.
  // Replaces the pre-PR-B4 "Open in account" toolbar button. Payload is
  // validated server-side via Zod (see mailOpenInWindowSchema in main.ts).
  'mail:openInWindow',
  'ui:openExternal',
  'ui:domainToUnicode',
  'win:minimize',
  'win:maximize',
  'win:isMaximized',
  'win:close',
  'win:getPlatform',
  'win:startResize',
  'win:stopResize',
  'update:download',
  'update:install',
  // §2.19 — renderer-triggered manual check. Returns
  // { ok, status: 'unsupported' | 'checking' | 'up-to-date' | 'available' | 'error', version?, error_class? }.
  // In dev/e2e or when !app.isPackaged, status is 'unsupported' (no-op).
  'update:check',
  // §2.19 — renderer reads system info (versions, install path, writable
  // flag, channel) for the About → System Info panel. Static at runtime,
  // so a single round-trip on Settings open is enough.
  'update:systemInfo',
  'ai:chat',
  'ai:stop',
  'ai:newSession',
  'ai:quickAction',
  'ai:setContext',
  'ai:checkAuth',
  'ai:openProviderSetup',
  'ai:saveApiKey',
  'ai:deleteApiKey',
  'ai:memoryRead',
  'ai:memoryWrite',
  // §3.3 B1 Privacy Audit Panel — read/export/clear renderer access. All
  // five channels are read-only against `ai_action_log` except for the
  // soft-delete path; main enforces the append-only invariant by only
  // ever issuing UPDATE deleted_at, never DELETE FROM.
  'ai:auditLog:list',
  'ai:auditLog:aggregate',
  'ai:auditLog:softDelete',
  'ai:auditLog:export',
  'ai:auditLog:clear',
  // §3.3 B2 Thread AI Summary — reading-pane summary strip. `generate` runs the
  // cache-or-generate path (per-account opt-in gated, budget-capped, every body
  // wrapUntrusted(), account-scoped cache). Read-only — no mutation of
  // send_queue, flags, or any destructive path. (The former cache-only
  // `ai:threadSummary:get` channel was removed: unused by the renderer and
  // unauthenticated by account.)
  'ai:threadSummary:generate',
  // §3.3 B4 Compose Quick Actions + Instant Reply.
  //   ai:quickAction:rewrite  — request { accountId, preset, text } → rewrite of
  //     the RAW draft text under a preset system prompt. Read-only, no mutation;
  //     main wraps the untrusted draft with wrapUntrusted(), budget-capped,
  //     structured refusal (never a throw). Nothing is written back to the draft
  //     until the user picks Replace/Insert in the renderer.
  //   ai:instantReply:generate — request { accountId, folder, uid } → 2–3 reply
  //     draft options. The renderer sends only a message REF; main fetches the
  //     canonical body from the local cache by (accountId, folder, uid) and wraps
  //     it with wrapUntrusted(). Any renderer-supplied messageId is dropped by the
  //     main-side zod schema (identity is cache-derived — cache-poisoning defense,
  //     CLAUDE.md §5). Per-account opt-in gated (aiInstantReplyEnabled), read-only.
  'ai:quickAction:rewrite',
  'ai:instantReply:generate',
  // §3.10 P0: renderer-driven confirmation gate. The token returned by
  // `ai:action:apply` is the structural barrier between AI proposing a
  // mutating action and the underlying callback firing — main-only
  // writable, never minted client-side.
  'ai:action:apply',
  'ai:action:cancel',
  'ai:action:list',
  // §3.10 P2: renderer-driven approve/deny for internet-tool interceptor.
  // The renderer receives `ai:internet-tool-pending` (listen channel
  // below) with a per-prompt `requestId`, displays inline confirm UI in
  // the AI panel, and calls one of these two channels with the same id
  // to resolve the pending promise inside main.
  'ai:internet-tool-approve',
  'ai:internet-tool-deny',
  'aiSession:create',
  'aiSession:list',
  'aiSession:get',
  'aiSession:updateTitle',
  'aiSession:delete',
  'aiSession:deleteAll',
  'aiSession:messages',
  'aiSession:addMessage',
  'aiSession:generateTitle',
  'mail:snoozeAdd',
  'mail:snoozeRemove',
  'mail:snoozeList',
  'mail:snoozedUids',
  'followup:add',
  'followup:list',
  'followup:dismiss',
  'followup:remove',
  'mail:readLaterAdd',
  'mail:readLaterRemove',
  'mail:readLaterList',
  'mail:readLaterUids',
  'templates:list',
  'templates:create',
  'templates:update',
  'templates:delete',
  'rules:list',
  'rules:create',
  'rules:update',
  'rules:delete',
  'rules:log',
  'rules:test',
  'rules:applyToFolder',
  'aiRules:list',
  'aiRules:create',
  'aiRules:update',
  'aiRules:delete',
  'aiRules:log',
  'mail:togglePin',
  'mcpExport:start',
  'mcpExport:stop',
  'mcpExport:status',
  'mcp:saveConnection',
  'mcp:removeConnection',
  'mcp:connect',
  'mcp:disconnect',
  'mcp:testConnection',
  'mcp:status',
  'mcp:listTools',
  // §3.10 P0: renderer-visible gates for stdio MCP approval flows. Both
  // trigger native dialogs in main; the renderer cannot bypass them because
  // `mcpEnableStdio` / `stdioApproved` / `approvedSource` are main-only
  // writable.
  'mcp:requestStdioEnable',
  'mcp:approveStdioConnection',
  'notifications:list',
  'notifications:unreadCount',
  'notifications:markRead',
  'notifications:markAllRead',
  'notifications:delete',
  'log:uiFreeze',
] as const

const ALLOWED_LISTEN_CHANNELS = [
  'main-process-message',
  'settings:changed',
  'accounts:changed',
  'compose:init',
  'mail:link',
  'mail:exists',
  'mail:queueChanged',
  'mail:queued',
  'offline:progress',
  'update:available',
  'update:downloaded',
  // §2.19 — periodic download progress (percent + bytes). Renderer uses
  // it for the inline "Downloading N%" state in Settings → About and any
  // future banners. Best-effort — main may emit at 0%, 100%, and every
  // few percent in between.
  'update:downloadProgress',
  // §2.19 — emitted on the result of an `update:check` call AND on
  // automatic background polls so renderer state machines (Settings →
  // About) stay in sync without polling. Payload mirrors the IPC reply.
  'update:checkResult',
  // §2.19 — emitted when a download fails (network error, disk full,
  // permissions). Renderer clears any "downloading" UI state.
  'update:downloadFailed',
  'ai:stream',
  'ai:status',
  // §3.10 P2: emitted from `aiInternetGate` whenever the LLM proposes an
  // internet-tool call (WebSearch / WebFetch / external MCP) without
  // per-turn consent. Payload is `{ requestId, toolName, query?, url?,
  // args }`. The renderer must treat `query`/`url` as untrusted (the
  // LLM may be prompt-injected) and escape before rendering.
  'ai:internet-tool-pending',
  'mail:snoozeChanged',
  'mail:snoozeWake',
  'mail:followUpDue',
  'mail:sendFailed',
  // §2.23 PR1 — SMTP delivery succeeded but the IMAP APPEND of the Sent
  // copy failed. Payload: { accountId: number, folder: string | null } —
  // the Sent folder path only, no message content / recipients / subject.
  // Renderer shows a "delivered, but no Sent copy" toast.
  'mail:sentCopyFailed',
  'mail:readLaterChanged',
  'mail:backgroundArchived',
  'win:maximizeChanged',
  'notifications:changed',
  'sync:folderProgress',
  // TLS trust rework Phase A2 — cert recovery UX. `cert:recoveryRequired`
  // payload: { accountId, host, port, issuerCn, subjectCn, fingerprintSha256,
  // systemOnly, rawMessage } — rawMessage/issuerCn are untrusted display-only
  // strings, renderer must escape before rendering. `cert:interceptionNotice`
  // payload: { host, issuerCn } — one-time local-TLS-interception banner.
  'cert:recoveryRequired',
  'cert:interceptionNotice',
  // §3.3.C-print.f1: Ctrl+P forwarded from main → renderer so the renderer
  // can scope printing to the focused message-body iframe rather than the
  // whole window chrome. Payload-less notification.
  'mail:print',
] as const

type InvokeChannel = typeof ALLOWED_INVOKE_CHANNELS[number]
type ListenChannel = typeof ALLOWED_LISTEN_CHANNELS[number]

type RendererListener = (...args: unknown[]) => void
type IpcListener = Parameters<typeof ipcRenderer.on>[1]

// ipcRenderer.on/off require the same listener reference.
// We wrap the listener to avoid exposing IpcRendererEvent to the renderer,
// so we maintain a mapping of original listener -> wrapped listener.
const LISTENER_MAP = new Map<ListenChannel, Map<RendererListener, IpcListener>>()

function channelMap(channel: ListenChannel) {
  let m = LISTENER_MAP.get(channel)
  if (!m) {
    m = new Map()
    LISTENER_MAP.set(channel, m)
  }
  return m
}

// Detect initial theme from additionalArguments (synchronous, no IPC round-trip).
const initialTheme = process.argv.includes('--theme=dark') ? 'dark' : 'light'

// Read the anonymous install-id hash that main passed via
// additionalArguments. Must be available synchronously before Sentry.init
// in the renderer runs — that's why we route it through argv, not IPC.
function readInstallIdHash(): string {
  const arg = process.argv.find(a => a.startsWith('--install-id-hash='))
  return arg ? arg.slice('--install-id-hash='.length) : ''
}
const installIdHash = readInstallIdHash()

// The renderer must know the persisted sentryEnabled flag BEFORE Sentry.init
// runs, otherwise the default "enabled" leaks startup events for users who
// have telemetry off. Tri-state contract with main's sentryEnabledArgs:
//   --sentry-enabled=true  → confirmed on
//   --sentry-enabled=false → confirmed off
//   (absent)               → unknown → fail-closed (off)
// Exact-token match, not substring, so future `--sentry-enabled=...`
// variants cannot collide.
const sentryEnabled = process.argv.includes('--sentry-enabled=true')

contextBridge.exposeInMainWorld('api', {
  initialTheme,
  installIdHash,
  sentryEnabled,
  invoke: (channel: InvokeChannel, ...args: unknown[]) => {
    if (!(ALLOWED_INVOKE_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not allowed`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: ListenChannel, listener: RendererListener) => {
    if (!(ALLOWED_LISTEN_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not allowed for subscription`)
    }
    const m = channelMap(channel)
    const existing = m.get(listener)
    if (existing) return
    const wrapped: IpcListener = (_event, ...args) => listener(...args)
    m.set(listener, wrapped)
    ipcRenderer.on(channel, wrapped)
  },
  off: (channel: ListenChannel, listener: RendererListener) => {
    if (!(ALLOWED_LISTEN_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not allowed for unsubscription`)
    }
    const m = LISTENER_MAP.get(channel)
    const wrapped = m?.get(listener)
    if (!wrapped) return
    ipcRenderer.off(channel, wrapped)
    m?.delete(listener)
    if (m && m.size === 0) LISTENER_MAP.delete(channel)
  },
  /**
   * Fire-and-forget telemetry from the renderer. Uses ipcRenderer.send (no
   * round-trip) so it never blocks the UI. Main-side handler validates the
   * payload against METRIC_EVENTS before forwarding to the metrics pipeline.
   */
  recordMetric: (name: string, kind: 'event' | 'histogram' | 'gauge', value: number | null, tags?: Record<string, string | number | boolean | undefined>) => {
    try {
      ipcRenderer.send('metrics:record', { name, kind, value, tags })
    } catch {
      /* sandbox boundary issues — telemetry must never throw */
    }
  },
  /** Remove ALL listeners for a channel (protects against HMR leaks) */
  removeAll: (channel: ListenChannel) => {
    if (!(ALLOWED_LISTEN_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not allowed for unsubscription`)
    }
    const m = LISTENER_MAP.get(channel)
    if (m) {
      for (const [, wrapped] of m) {
        ipcRenderer.off(channel, wrapped)
      }
      LISTENER_MAP.delete(channel)
    }
    // Safety net: also remove any untracked listeners
    ipcRenderer.removeAllListeners(channel)
  },
})
