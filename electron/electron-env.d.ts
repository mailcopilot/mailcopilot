/// <reference types="vite-plugin-electron/electron-env" />

// Vite define substitutions (sentry)
declare const __SENTRY_DSN__: string
declare const __APP_VERSION__: string

// Vite define substitutions (Google OAuth Desktop client, main bundle only).
// Empty string when the build was made without credentials — see
// electron/googleOAuthConfig.ts.
declare const __GOOGLE_OAUTH_CLIENT_ID__: string
declare const __GOOGLE_OAUTH_CLIENT_SECRET__: string

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in the renderer process, exposed via preload.ts.
// Channel list must match ALLOWED_INVOKE_CHANNELS / ALLOWED_LISTEN_CHANNELS in preload.ts.
interface Window {
  api: {
    /** Initial theme detected synchronously from additionalArguments (no IPC round-trip). */
    initialTheme: 'dark' | 'light'
    /** Pseudonymous install-id hash (16 hex chars) propagated from main. Empty string in dev/e2e. */
    installIdHash: string
    /** Persisted sentryEnabled flag, propagated from main via additionalArguments. */
    sentryEnabled: boolean
    invoke: <T = unknown>(
      channel:
        | 'accounts:list'
        | 'accounts:get'
        | 'accounts:save'
        | 'accounts:remove'
        | 'accounts:setCurrent'
        | 'accounts:getCurrent'
        | 'accounts:autoconfig'
        | 'accounts:removePreview'
        | 'oauth:google:connect'
        | 'oauth:microsoft:connect'
        | 'net:testImap'
        | 'net:testSmtp'
        | 'net:inboxSummaries'
        | 'net:folderPage'
        | 'net:mailboxesAndRoles'
        | 'net:sendMail'
        | 'mail:scheduleSend'
        | 'mail:scheduleSendAt'
        | 'mail:cancelSend'
        | 'mail:queueList'
        | 'mail:queueSendNow'
        | 'mail:queueReschedule'
        | 'net:messageDetails'
        | 'net:setSeen'
        | 'net:setFlagged'
        | 'net:move'
        | 'net:move:pendingAdd'
        | 'net:move:pendingRemove'
        | 'net:move:pendingClear'
        | 'net:delete'
        | 'net:saveDraft'
        | 'net:deleteDraft'
        | 'drafts:wasSent'
        | 'net:idleStart'
        | 'net:idleStop'
        | 'net:createMailbox'
        | 'net:renameMailbox'
        | 'net:deleteMailbox'
        | 'net:syncFolderHeaders'
        | 'net:saveAttachment'
        | 'net:attachmentBase64'
        | 'net:fetchExternalImage'
        | 'folder:prefs:list'
        | 'folder:prefs:upsert'
        | 'folder:prefs:remove'
        | 'folder:refreshCounts'
        | 'tls:listPins'
        | 'tls:addPin'
        | 'tls:removePin'
        | 'tls:getServerCert'
        // TLS trust rework Phase A2 — cert-recovery dialog actions.
        //   net:trustCert ({ accountId: number; host: string; port: number;
        //     fingerprintSha256: string })
        //     → { ok: true }                        pin stored
        //     → { ok: false; cancelled: true }      user refused main's native
        //       confirmation (gate 5): nothing probed, nothing written, the
        //       offer stays open so the renderer must keep its dialog up.
        //   cert:dismiss ({ host: string }) → { ok: true }
        | 'net:trustCert'
        | 'cert:dismiss'
        | 'contacts:search'
        | 'contacts:upsert'
        | 'cache:inboxPage'
        | 'cache:search'
        | 'cache:messageByUid'
        | 'cache:unifiedInboxPage'
        | 'cache:unifiedSearch'
        | 'search:indexStats'
        | 'search:coverageStats'
        | 'search:crawlStates'
        | 'search:remoteSearch'
        | 'search:cancelInflight'
        | 'cache:folderRoles'
        | 'cache:mailboxes'
        | 'cache:folderPrefs'
        | 'cache:bodyTrimPreview'
        | 'offline:syncNow'
        | 'offline:status'
        | 'settings:get'
        | 'settings:save'
        // §2.82 — first-run telemetry consent. `telemetry:consentState` answers
        // `{ needed, version }` (read-only, "should the screen be shown");
        // `telemetry:setConsent` takes `{ granted }` and nothing else — main
        // stamps the disclosure version and the timestamp itself.
        | 'telemetry:consentState'
        | 'telemetry:setConsent'
        | 'e2e:localizeMails'
        | 'compose:getInit'
        | 'ui:openSettings'
        | 'ui:openAccount'
        | 'ui:openCompose'
        | 'mail:openInWindow'
        | 'ui:openExternal'
        | 'ui:domainToUnicode'
        | 'win:minimize'
        | 'win:maximize'
        | 'win:isMaximized'
        | 'win:close'
        | 'win:getPlatform'
        | 'win:startResize'
        | 'win:stopResize'
        | 'update:download'
        | 'update:install'
        | 'update:check'
        | 'update:systemInfo'
        | 'ai:chat'
        | 'ai:stop'
        | 'ai:newSession'
        | 'ai:quickAction'
        // §3.3 B4 Compose Quick Actions + Instant Reply. Renderer contract:
        //   ai:quickAction:rewrite  — request { accountId, preset, text } →
        //     { ok:true, rewritten, provider } | { ok:false, reason }.
        //   ai:instantReply:generate — request { accountId, folder, uid } →
        //     { ok:true, drafts } | { ok:false, reason }.
        // The renderer hook may still send a `messageId` field for compat, but
        // main's zod schema (instantReplyGenerateSchema in main.ts) DROPS it —
        // message identity is entirely cache-derived from (accountId, folder,
        // uid) so a renderer-supplied id can never influence the lookup
        // (cache-poisoning defense, CLAUDE.md §5). Bodies are fetched by main
        // from the local SQLite cache and wrapped with wrapUntrusted() — the
        // renderer never sends email body text for instant reply. Payload/result
        // types live in src/utils/quickActions.ts (they mirror the ai.ts
        // QuickActionRewriteResult / InstantReplyDraftsResult) until canonical
        // shapes are added to @mailcopilot/types.
        | 'ai:quickAction:rewrite'
        | 'ai:instantReply:generate'
        | 'ai:setContext'
        | 'ai:checkAuth'
        | 'ai:openProviderSetup'
        | 'ai:saveApiKey'
        | 'ai:deleteApiKey'
        | 'ai:memoryRead'
        | 'ai:memoryWrite'
        | 'ai:auditLog:list'
        | 'ai:auditLog:aggregate'
        | 'ai:auditLog:softDelete'
        | 'ai:auditLog:export'
        | 'ai:auditLog:clear'
        | 'ai:threadSummary:generate'
        | 'ai:action:apply'
        | 'ai:action:cancel'
        | 'ai:action:list'
        | 'ai:internet-tool-approve'
        | 'ai:internet-tool-deny'
        | 'aiSession:create'
        | 'aiSession:list'
        | 'aiSession:get'
        | 'aiSession:updateTitle'
        | 'aiSession:delete'
        | 'aiSession:deleteAll'
        | 'aiSession:messages'
        | 'aiSession:addMessage'
        | 'aiSession:generateTitle'
        | 'mail:snoozeAdd'
        | 'mail:snoozeRemove'
        | 'mail:snoozeList'
        | 'mail:snoozedUids'
        | 'followup:add'
        | 'followup:list'
        | 'followup:dismiss'
        | 'followup:remove'
        | 'mail:readLaterAdd'
        | 'mail:readLaterRemove'
        | 'mail:readLaterList'
        | 'mail:readLaterUids'
        | 'templates:list'
        | 'templates:create'
        | 'templates:update'
        | 'templates:delete'
        | 'mcpExport:start'
        | 'mcpExport:stop'
        | 'mcpExport:status'
        | 'mcp:saveConnection'
        | 'mcp:removeConnection'
        | 'mcp:connect'
        | 'mcp:disconnect'
        | 'mcp:testConnection'
        | 'mcp:status'
        | 'mcp:listTools'
        | 'mcp:requestStdioEnable'
        | 'mcp:approveStdioConnection'
        | 'rules:list'
        | 'rules:create'
        | 'rules:update'
        | 'rules:delete'
        | 'rules:test'
        | 'rules:applyToFolder'
        | 'aiRules:list'
        | 'aiRules:create'
        | 'aiRules:update'
        | 'aiRules:delete'
        | 'aiRules:log'
        | 'mail:togglePin'
        | 'notifications:list'
        | 'notifications:unreadCount'
        | 'notifications:markRead'
        | 'notifications:markAllRead'
        | 'notifications:delete'
        // §2.22 Wave A — ICS/iTIP RSVP reply. Payload: { accountId, uid, folder, response }.
        | 'mail:rsvpInvite'
        | 'log:uiFreeze',
      ...args: unknown[]
    ) => Promise<T>
    recordMetric: (
      name: string,
      kind: 'event' | 'histogram' | 'gauge',
      value: number | null,
      tags?: Record<string, string | number | boolean | undefined>,
    ) => void
    // TLS trust rework Phase A2 — cert recovery broadcasts (main → renderer).
    //   cert:recoveryRequired payload = { accountId: number; host: string;
    //     port: number; issuerCn: string; subjectCn: string;
    //     fingerprintSha256: string; systemOnly: boolean; rawMessage: string }
    //     (server-derived strings are UNTRUSTED — render as text only).
    //   cert:interceptionNotice payload = { host: string; issuerCn: string }.
    // §2.94 — oauth:progress payload = { provider: 'gmail' | 'outlook';
    //   stage: OAuthConnectStage } (no addresses, names or tokens).
    on: (channel: 'main-process-message' | 'settings:changed' | 'accounts:changed' | 'compose:init' | 'mail:link' | 'mail:exists' | 'mail:queueChanged' | 'mail:queued' | 'offline:progress' | 'update:available' | 'update:downloaded' | 'update:downloadProgress' | 'update:checkResult' | 'update:downloadFailed' | 'ai:stream' | 'ai:status' | 'ai:internet-tool-pending' | 'mail:snoozeChanged' | 'mail:snoozeWake' | 'mail:followUpDue' | 'mail:sendFailed' | 'mail:sentCopyFailed' | 'mail:readLaterChanged' | 'mail:backgroundArchived' | 'win:maximizeChanged' | 'notifications:changed' | 'sync:folderProgress' | 'mail:print' | 'cert:recoveryRequired' | 'cert:interceptionNotice' | 'oauth:progress', listener: (...args: unknown[]) => void) => void
    off: (channel: 'main-process-message' | 'settings:changed' | 'accounts:changed' | 'compose:init' | 'mail:link' | 'mail:exists' | 'mail:queueChanged' | 'mail:queued' | 'offline:progress' | 'update:available' | 'update:downloaded' | 'update:downloadProgress' | 'update:checkResult' | 'update:downloadFailed' | 'ai:stream' | 'ai:status' | 'ai:internet-tool-pending' | 'mail:snoozeChanged' | 'mail:snoozeWake' | 'mail:followUpDue' | 'mail:sendFailed' | 'mail:sentCopyFailed' | 'mail:readLaterChanged' | 'mail:backgroundArchived' | 'win:maximizeChanged' | 'notifications:changed' | 'sync:folderProgress' | 'mail:print' | 'cert:recoveryRequired' | 'cert:interceptionNotice' | 'oauth:progress', listener: (...args: unknown[]) => void) => void
    removeAll: (channel: 'main-process-message' | 'settings:changed' | 'accounts:changed' | 'compose:init' | 'mail:link' | 'mail:exists' | 'mail:queueChanged' | 'mail:queued' | 'offline:progress' | 'update:available' | 'update:downloaded' | 'update:downloadProgress' | 'update:checkResult' | 'update:downloadFailed' | 'ai:stream' | 'ai:status' | 'ai:internet-tool-pending' | 'mail:snoozeChanged' | 'mail:snoozeWake' | 'mail:followUpDue' | 'mail:sendFailed' | 'mail:sentCopyFailed' | 'mail:readLaterChanged' | 'mail:backgroundArchived' | 'win:maximizeChanged' | 'notifications:changed' | 'sync:folderProgress' | 'mail:print' | 'cert:recoveryRequired' | 'cert:interceptionNotice' | 'oauth:progress') => void
  }
}
