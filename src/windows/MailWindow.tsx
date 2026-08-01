import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertTriangle, WifiOff, Undo2 } from 'lucide-react'
import type { AccountMeta, ComposeInit, FolderRoles, MessageDetails } from '@mailcopilot/types'
import { addrListToString } from '@mailcopilot/core'
import RecipientList from '../components/RecipientList'
import { computeReplyRecipients, prefixSubject, htmlToText, quoteText } from '../utils/mail'
import WindowTitlebar from '../components/WindowTitlebar'
import { sanitizeMailHtml } from '../utils/mail'
import { rewriteMailHtmlLinks } from '../utils/mailLinks'
import { useMailLinkClick } from '../hooks/useMailLinkClick'
import LinkWarningDialog from '../components/LinkWarningDialog'
import MailActionsToolbar from '../components/MailActionsToolbar'

/**
 * Standalone window that displays a single mail message with a full action
 * toolbar (Reply / Reply All / Forward / Archive / Delete / Flag / Mark
 * read|unread / Print).
 *
 * Opened via the `mail:openInWindow` IPC from the main mail viewer
 * "Open in window" toolbar button (uiaudit.3 PR B4). Destructive actions
 * (Archive / Delete) close the window after the IPC completes so the user
 * is not left looking at a message that no longer exists in the list.
 *
 * Security invariants (CLAUDE.md §5):
 *   - Runs under the same sandbox / contextIsolation / preload whitelist
 *     as every other renderer entry; no Node/Electron APIs are reachable
 *     from this component.
 *   - HTML body is rendered inside a sandboxed iframe with
 *     `sandbox="allow-same-origin"` (no scripts) and
 *     `referrerPolicy="no-referrer"`, mirroring the in-app viewer's
 *     defense against tracker pixels and remote-content leaks.
 *   - External (remote) images are blocked by default — same policy as
 *     the in-app viewer.
 *   - Phishing-check pipeline shared with App.tsx via useMailLinkClick hook
 *     (IDN/http/mismatch/unsafeBypass checks), link warning UI via
 *     LinkWarningDialog component.
 *   - All IPC channels used here are in the preload whitelist:
 *       accounts:get, cache:folderRoles, net:attachmentBase64,
 *       net:messageDetails, net:move, net:delete, net:setSeen, net:setFlagged,
 *       ui:openCompose, win:minimize, win:maximize, win:isMaximized.
 */
export default function MailWindow({ accountId, folder, uid }: { accountId: number; folder: string; uid: number }) {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  const [details, setDetails] = useState<MessageDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Folder roles (archive/trash/sent/junk) — loaded once on mount via
  // cache:folderRoles IPC (already in preload whitelist). Used to enable or
  // disable the Archive button (requires a known archive folder path).
  // BLOCKER fix: folderRoles null = still loading; Delete button is disabled
  // until roles arrive to prevent accidental permanent deletion.
  const [folderRoles, setFolderRoles] = useState<FolderRoles | null>(null)
  const [folderRolesLoaded, setFolderRolesLoaded] = useState(false)

  // MEDIUM fix: self email for Reply All filtering — loaded via accounts:get.
  // Empty string until resolved (means no self-filter; harmless vs permanent deletion risk).
  const [selfEmail, setSelfEmail] = useState('')

  // Optimistic UI state for flag / seen so buttons feel instant.
  const [flagged, setFlaggedState] = useState(false)
  const [seen, setSeenState] = useState(true)
  // MEDIUM fix: disable flag/seen buttons while IPC pending to prevent re-entry conflicts.
  const [flagPending, setFlagPending] = useState(false)
  const [seenPending, setSeenPending] = useState(false)

  // BLOCKER fix: explicit confirmation gate for permanent delete (no trash folder
  // available or already in trash).
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState(false)

  // Visible error banner when Archive/Delete/Reply IPC fails.
  const [actionError, setActionError] = useState<string | null>(null)

  // Deferred undo state for reversible destructive actions (Archive / Move-to-trash).
  //
  // Defer pattern (mirrors useUndoSystem.moveWithUndo in App.tsx):
  //   1. User clicks Archive/Trash → show banner, start timer. NO net:move yet.
  //   2. Timer expires → fire net:move server-call, then window.close().
  //   3. User clicks Undo → clearTimeout, NO net:move server-call. Banner hides.
  //
  // This avoids the broken "reverse-UID" problem: after a real IMAP MOVE the
  // message gets a new UID in the target folder (UIDPLUS COPYUID). Storing the
  // source-folder UID and trying to use it for a reverse move in the target
  // folder fails silently (IMAP NO/BAD — UID not found).
  //
  // UIDs change on IMAP MOVE — references become dangling (see
  // electron/main.ts comment near net:move handler). The defer pattern sidesteps
  // this entirely: we never move the message until the user commits by letting
  // the timer expire.
  //
  // HIGH fix (MEDIUM — ref-idempotent flush): pendingUndoRef is the source of
  // truth; React state (pendingUndo) is a mirror for rendering only. flushPendingUndo
  // reads and nulls the ref synchronously before any side effects, making double-call
  // safe — the second call sees null ref and returns immediately.
  type PendingUndoState = {
    message: string
    sourceFolder: string       // original folder (where the message currently lives)
    targetFolder: string       // destination (archive / trash)
  }
  const pendingUndoRef = useRef<PendingUndoState | null>(null)
  const [pendingUndo, setPendingUndo] = useState<PendingUndoState | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Set both ref (source of truth) and state (for rendering) atomically.
  const setPendingUndoBoth = useCallback((next: PendingUndoState | null) => {
    pendingUndoRef.current = next
    setPendingUndo(next)
  }, [])

  // LOW fix: actionError clears the pending undo banner — when an error occurs
  // the deferred move is ambiguous; cancel the timer and clear the pending state.
  // Declared after pendingUndo/undoTimerRef so the inline function body can
  // reference them. Reassigned on every render so always has fresh closure.
  const setActionErrorRef = useRef((msg: string | null) => { setActionError(msg) })
  setActionErrorRef.current = (msg: string | null) => {
    if (msg !== null) {
      // Cancel deferred move and hide banner when an error is raised.
      if (undoTimerRef.current !== null) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null }
      pendingUndoRef.current = null
      setPendingUndo(null)
    }
    setActionError(msg)
  }

  // flushPendingUndo: if a deferred move is pending, execute it now (server-call)
  // and clear banner. Used before starting a second destructive action or before
  // opening the permanent-delete confirm dialog.
  //
  // MEDIUM fix (ref-idempotent): reads and nulls pendingUndoRef synchronously
  // BEFORE issuing the IPC call. A second synchronous call in the same tick sees
  // null ref and returns immediately — net:move fires exactly once.
  const flushPendingUndo = useCallback(() => {
    const pending = pendingUndoRef.current
    if (!pending) return
    // Null the ref synchronously first — makes this function idempotent under
    // double-call in the same tick (HIGH fix — ref-idempotent).
    pendingUndoRef.current = null
    if (undoTimerRef.current !== null) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null }
    setPendingUndo(null)
    // Fire-and-forget — errors are silently swallowed here because:
    //   a) The user has already committed to the action (new action started).
    //   b) The previous banner is already gone from the UI.
    //   c) A best-effort move is better than blocking the UI on a failed flush.
    void window.api.invoke('net:move', accountId, pending.sourceFolder, pending.targetFolder, [uid]).catch(() => {})
  }, [accountId, uid])

  // Unmount cleanup: flush any pending undo (user closed window = action committed).
  // Uses pendingUndoRef directly to avoid stale-closure over pendingUndo state.
  // Also nulls the ref synchronously to prevent double-fire if flushPendingUndo
  // was called just before unmount.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null }
      const pending = pendingUndoRef.current
      if (pending) {
        pendingUndoRef.current = null
        // Fire-and-forget server move on unmount — window is closing, action is committed.
        void window.api.invoke('net:move', accountId, pending.sourceFolder, pending.targetFolder, [uid]).catch(() => {})
      }
    }
    // accountId and uid are stable for the lifetime of the window; disable-exhaustive
    // is intentional here — the cleanup must capture initial values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // MEDIUM fix: refs for confirm dialog focus trap.
  const confirmCancelRef = useRef<HTMLButtonElement>(null)
  const confirmOkRef = useRef<HTMLButtonElement>(null)
  // Ref to restore focus when dialog closes.
  const focusBeforeDialogRef = useRef<Element | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!Number.isFinite(accountId) || accountId <= 0 || !folder || !Number.isFinite(uid) || uid <= 0) {
      setError('invalid_params')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const d = await window.api.invoke<MessageDetails>('net:messageDetails', accountId, folder, uid)
        if (!cancelled) {
          setDetails(d ?? null)
          setLoading(false)
          if (d?.flags) {
            setFlaggedState(d.flags.includes('\\Flagged'))
            setSeenState(d.flags.includes('\\Seen'))
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'fetch_failed')
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [accountId, folder, uid])

  // Load cached folder roles for this account. Errors are non-fatal —
  // Archive will be disabled if the cache is unavailable.
  // BLOCKER fix: setFolderRolesLoaded(true) regardless of result so Delete
  // button can be re-enabled after the attempt (even when trash is absent).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const allRoles = await window.api.invoke<Record<number, Record<string, string | undefined>>>('cache:folderRoles')
        if (!cancelled) {
          if (allRoles) {
            const raw = allRoles[accountId]
            if (raw) setFolderRoles(raw as FolderRoles)
          }
          setFolderRolesLoaded(true)
        }
      } catch {
        // Non-fatal — Archive button disabled, other actions still work.
        if (!cancelled) setFolderRolesLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [accountId])

  // Load account identity so Reply All can filter out our own address from cc.
  // Errors are non-fatal — selfEmail stays '' which means no self-filter.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const meta = await window.api.invoke<AccountMeta | undefined>('accounts:get', accountId)
        if (!cancelled && meta) {
          const email = (meta.email || meta.smtp.user || meta.imap.user || '').toLowerCase()
          setSelfEmail(email)
        }
      } catch {
        // Non-fatal — Reply All may include own address in cc.
      }
    })()
    return () => { cancelled = true }
  }, [accountId])

  // Focus management for confirm dialog.
  // Save previous focus on open; auto-focus Cancel (synchronously after layout
  // via useLayoutEffect so the dialog is guaranteed to be in the DOM); restore
  // on close.
  // LOW fix: replaced the old setTimeout(0) approach with useLayoutEffect so
  // that focus fires synchronously after paint without a setTimeout race.
  useLayoutEffect(() => {
    if (confirmPermanentDelete) {
      focusBeforeDialogRef.current = document.activeElement
      confirmCancelRef.current?.focus()
    } else {
      // Restore focus when dialog closes.
      if (focusBeforeDialogRef.current && focusBeforeDialogRef.current instanceof HTMLElement) {
        focusBeforeDialogRef.current.focus()
      }
    }
  }, [confirmPermanentDelete])

  // Phishing-check pipeline shared with App.tsx. mail:link IPC listener is
  // attached inside the hook — no separate useEffect needed here.
  const { linkPrompt, dismissPrompt, approvePrompt } = useMailLinkClick()

  const env = details?.envelope
  const from = env?.from ? addrListToString(env.from) : ''
  // §3.3.C-uiaudit.22: use raw MailAddress[] for RecipientList chip rendering.
  const toAddrs = env?.to ?? []
  const ccAddrs = env?.cc ?? []
  const subject = env?.subject || ''
  const dateIso = env?.date || details?.internalDate || ''
  const date = dateIso ? new Date(dateIso).toLocaleString() : ''

  // Build a sandboxed srcDoc for HTML bodies.
  //
  // Pipeline (security layers in order):
  //   1. sanitizeMailHtml (DOMPurify) — drops <script>/<iframe>/<object>,
  //      strips on* attrs, neutralizes javascript: URIs, forbids <base>/<meta>.
  //      Shared with the main viewer via src/utils/mail.ts — single source of
  //      truth for the sanitization policy.
  //   2. rewriteMailHtmlLinks — rewrites every http(s)/mailto: href to the
  //      mailcopilot-link:// routed scheme so link clicks are intercepted by
  //      the main process (will-frame-navigate → mail:link IPC), which
  //      dispatches them to useMailLinkClick for phishing warning evaluation
  //      BEFORE shell.openExternal() is called.
  const iframeDoc = useMemo(() => {
    if (!details?.html) return null
    const sanitized = sanitizeMailHtml(details.html)
    const html = rewriteMailHtmlLinks(sanitized)
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:"><style>html,body{margin:0;padding:12px;font-family:system-ui,sans-serif;color:#222;background:#fff;}body{word-break:break-word;}img{max-width:100%;height:auto;}</style></head><body>${html}</body></html>`
  }, [details?.html])

  // Match main window background to current theme synchronously.
  useEffect(() => {
    document.title = subject || t('mail.actions.openInWindow')
  }, [subject, t])

  // Forward Ctrl+P from main process to iframe print.
  useEffect(() => {
    const handler = () => {
      iframeRef.current?.contentWindow?.print()
    }
    window.api?.on('mail:print', handler)
    return () => { window.api?.off('mail:print', handler) }
  }, [])

  // ---------------------------------------------------------------------------
  // Action handlers — all IPC calls go through preload whitelist
  // ---------------------------------------------------------------------------

  const handleReply = useCallback(async (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!details) return
    try {
      const d = details
      const e = d.envelope
      const subj = (e?.subject || '').trim()
      const dateIso2 = e?.date || d.internalDate || ''
      const dateStr = dateIso2 ? new Date(dateIso2).toLocaleString() : ''
      const fromStr = e?.from ? addrListToString(e.from) : ''
      const toStr = e?.to ? addrListToString(e.to) : ''
      const bodyText = (d.text || (d.html ? htmlToText(d.html) : '') || '').trim()
      const safeFrom = fromStr || tRef.current('compose.templates.unknownSender')
      const safeDate = dateStr || tRef.current('compose.templates.unknownDate')

      let init: ComposeInit
      if (mode === 'forward') {
        // MEDIUM fix: fetch non-CID attachments and include in the forwarded message
        // (matches App.tsx behaviour — partial forward is better than no forward).
        const fwdAttachments: ComposeInit['attachments'] = []
        if (d.attachments && d.attachments.length > 0) {
          const results = await Promise.allSettled(
            d.attachments
              .filter(a => !a.cid)
              .map(async (a) => {
                const res = await window.api.invoke('net:attachmentBase64', accountId, folder, uid, a.part) as
                  { ok: true; contentBase64: string; contentType?: string } | { ok: false; error: string }
                if (res.ok) {
                  fwdAttachments.push({
                    filename: a.filename || tRef.current('mail.attachments.unnamed'),
                    contentBase64: res.contentBase64,
                    contentType: res.contentType || a.contentType || 'application/octet-stream',
                  })
                }
              })
          )
          void results // partial forward on errors — better than no forward
        }
        init = {
          to: '',
          subject: prefixSubject('Fwd', subj),
          text: [
            '', '',
            tRef.current('compose.templates.forwardHeader'),
            tRef.current('compose.templates.forwardFrom', { from: safeFrom }),
            tRef.current('compose.templates.forwardDate', { date: safeDate }),
            tRef.current('compose.templates.forwardSubject', { subject: subj }),
            tRef.current('compose.templates.forwardTo', { to: toStr }),
            '', bodyText,
          ].join('\n'),
          attachments: fwdAttachments.length > 0 ? fwdAttachments : undefined,
          source: 'forward',
        }
      } else {
        const replyIntro = dateStr
          ? tRef.current('compose.templates.replyIntro', { date: safeDate, from: safeFrom })
          : tRef.current('compose.templates.replyIntroNoDate', { from: safeFrom })
        // MEDIUM fix: pass selfEmail so Reply All filters out the account's own address from cc.
        const { to: replyTo, cc: replyCc, originalRecipients } = computeReplyRecipients(e, mode, selfEmail)
        init = {
          to: replyTo,
          cc: replyCc,
          subject: prefixSubject('Re', subj),
          text: ['', '', replyIntro, quoteText(bodyText)].join('\n'),
          replyRef: { accountId, folder, uid },
          originalRecipients,
          source: mode === 'replyAll' ? 'reply_all' : 'reply',
        }
      }

      await window.api.invoke('ui:openCompose', accountId, init)
    } catch {
      // Show error banner when compose fails — user gets visible feedback.
      setActionErrorRef.current(tRef.current('mail.actions.actionFailed'))
    }
  }, [accountId, details, folder, selfEmail, uid])

  const handleArchive = useCallback(() => {
    if (!folderRoles?.archive) return
    // Flush any previous pending undo before starting a new one (acceptance
    // criterion #4: second Archive while previous pending → flush previous).
    flushPendingUndo()
    setActionError(null)
    const archiveFolder = folderRoles.archive
    // Defer pattern: NO net:move yet. Server call fires only when the timer
    // expires (user did not click Undo). Undo = clearTimeout, no server call.
    setPendingUndoBoth({
      message: tRef.current('mail.actions.archived'),
      sourceFolder: folder,
      targetFolder: archiveFolder,
    })
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null
      pendingUndoRef.current = null
      setPendingUndo(null)
      void window.api.invoke('net:move', accountId, folder, archiveFolder, [uid])
        .catch(() => { /* window is closing; error not surfaceable */ })
        .finally(() => { window.close() })
    }, 3000)
  }, [accountId, folder, folderRoles, flushPendingUndo, setPendingUndoBoth, uid])

  // Delete button requires folderRolesLoaded before it can be clicked (disabled
  // while loading). When trash folder is available and we are not already in it,
  // defer move to trash (defer pattern — same as handleArchive). When permanent
  // delete is needed (in trash, or no trash folder), flush any pending undo first
  // then show a confirmation dialog.
  const handleDeleteClick = useCallback(() => {
    if (!folderRolesLoaded) return
    setActionError(null)
    if (folderRoles?.trash && folder !== folderRoles.trash) {
      const trashFolder = folderRoles.trash
      // Flush any previous pending undo before starting a new one.
      flushPendingUndo()
      // Defer pattern: NO net:move yet.
      setPendingUndoBoth({
        message: tRef.current('mail.actions.movedToTrash'),
        sourceFolder: folder,
        targetFolder: trashFolder,
      })
      undoTimerRef.current = setTimeout(() => {
        undoTimerRef.current = null
        pendingUndoRef.current = null
        setPendingUndo(null)
        void window.api.invoke('net:move', accountId, folder, trashFolder, [uid])
          .catch(() => { /* window is closing; error not surfaceable */ })
          .finally(() => { window.close() })
      }, 3000)
    } else {
      // Permanent delete — flush any pending undo first so the previous banner
      // action is committed before opening the new confirm dialog (acceptance
      // criterion #3 / MEDIUM: stale timer when permanent delete starts).
      flushPendingUndo()
      setConfirmPermanentDelete(true)
    }
  }, [accountId, folder, folderRoles, folderRolesLoaded, flushPendingUndo, setPendingUndoBoth, uid])

  // Undo handler — cancel the deferred server move. No net:move is ever issued.
  // The message was never moved, so there is no reverse operation needed.
  // actionError clears undoBanner (LOW fix): if an error is set, the pending
  // banner is already stale; we clear both together in setActionError calls.
  const handleUndo = useCallback(() => {
    if (!pendingUndoRef.current) return
    // Cancel deferred server move — synchronously null the ref first.
    pendingUndoRef.current = null
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current)
      undoTimerRef.current = null
    }
    setPendingUndo(null)
    // Window stays open — message was never moved, no server interaction needed.
  }, [])

  const handleConfirmPermanentDelete = useCallback(async () => {
    setConfirmPermanentDelete(false)
    try {
      await window.api.invoke('net:delete', accountId, folder, [uid])
      window.close()
    } catch {
      // Show visible error when permanent delete fails.
      setActionErrorRef.current(tRef.current('mail.actions.actionFailed'))
    }
  }, [accountId, folder, uid])

  // MEDIUM fix: disable button while IPC is pending to prevent re-entry.
  // Old code: concurrent clicks could cause the rejected toggle to overwrite the new one.
  const handleToggleFlag = useCallback(async () => {
    if (flagPending) return
    const next = !flagged
    setFlagPending(true)
    setFlaggedState(next)
    try {
      await window.api.invoke('net:setFlagged', accountId, folder, [uid], next)
    } catch {
      // Revert optimistic update on failure.
      setFlaggedState(!next)
    } finally {
      setFlagPending(false)
    }
  }, [accountId, flagged, flagPending, folder, uid])

  // MEDIUM fix: same pending guard for seen toggle.
  const handleToggleSeen = useCallback(async () => {
    if (seenPending) return
    const next = !seen
    setSeenPending(true)
    setSeenState(next)
    try {
      await window.api.invoke('net:setSeen', accountId, folder, [uid], next)
    } catch {
      // Revert optimistic update on failure.
      setSeenState(!next)
    } finally {
      setSeenPending(false)
    }
  }, [accountId, folder, seen, seenPending, uid])

  const handlePrint = useCallback(() => {
    iframeRef.current?.contentWindow?.print()
  }, [])

  return (
    <>
      <WindowTitlebar title={subject || t('mail.actions.openInWindow')} />
      <div className="mail-window-root">
        <MailActionsToolbar
          flagged={flagged}
          seen={seen}
          folderRoles={folderRoles}
          folderRolesLoaded={folderRolesLoaded}
          destructiveActionsDisabled={pendingUndo !== null}
          flagPending={flagPending}
          seenPending={seenPending}
          onReply={() => void handleReply('reply')}
          onReplyAll={() => void handleReply('replyAll')}
          onForward={() => void handleReply('forward')}
          onArchive={() => void handleArchive()}
          onDelete={handleDeleteClick}
          onToggleFlag={() => void handleToggleFlag()}
          onToggleSeen={() => void handleToggleSeen()}
          onPrint={handlePrint}
          className="mail-window-toolbar"
        />
        {/* LOW fix: action error banner shown when Archive/Delete/Undo IPC fails. */}
        {actionError && (
          <div className="error-banner" role="alert" data-testid="action-error-banner">
            {actionError}
          </div>
        )}
        {/* Deferred undo banner — shown while net:move is pending (not yet fired). */}
        {pendingUndo && (
          <div className="undo-banner" role="status" data-testid="undo-banner">
            <span data-testid="undo-banner-message">{pendingUndo.message}</span>
            <button
              className="btn-link undo-btn"
              data-testid="undo-banner-btn"
              onClick={handleUndo}
              aria-label={t('mail.actions.undo')}
            >
              <Undo2 size={14} />
              {t('mail.actions.undo')}
            </button>
          </div>
        )}
        <div className="mail-viewer-header">
          <div className="mail-viewer-from">{from}</div>
          <div className="mail-viewer-subject-row">
            <div className="mail-viewer-subject">{subject}</div>
          </div>
        </div>
        <div className="mail-viewer-meta">
          {toAddrs.length > 0 && (
            <div className="meta-row meta-row--recipients">
              <span className="meta-key">{t('mail.headers.to')}</span>
              <RecipientList addresses={toAddrs} maxVisible={3} />
            </div>
          )}
          {ccAddrs.length > 0 && (
            <div className="meta-row meta-row--recipients">
              <span className="meta-key">{t('mail.headers.cc')}</span>
              <RecipientList addresses={ccAddrs} maxVisible={3} />
            </div>
          )}
          {date && (
            <div className="meta-row">
              <span className="meta-key">{t('mail.headers.date')}</span>
              <span className="meta-val">{date}</span>
            </div>
          )}
        </div>
        <div className="mail-viewer-body">
          {loading ? (
            <div className="empty-state">
              <Loader2 size={24} className="spin" />
              <p>{t('app.empty.loadingMessage.title')}</p>
            </div>
          ) : error ? (
            <div className="empty-state">
              <AlertTriangle size={24} />
              <p>{t('app.empty.messageNotFound.title')}</p>
            </div>
          ) : details?.offlineFallback ? (
            <div className="empty-state offline-fallback">
              <WifiOff size={24} />
              <p>{t('app.errors.bodyNotAvailableOffline')}</p>
            </div>
          ) : details && !details.html && !details.text ? (
            <div className="empty-state">
              <AlertTriangle size={24} />
              <p>{t('app.empty.messageNotFound.title')}</p>
            </div>
          ) : iframeDoc ? (
            <iframe
              ref={iframeRef}
              title="mail"
              sandbox="allow-same-origin allow-modals"
              referrerPolicy="no-referrer"
              className="mail-iframe"
              srcDoc={iframeDoc}
            />
          ) : (
            <pre className="mail-text">{details?.text || ''}</pre>
          )}
        </div>
      </div>

      {/* BLOCKER fix: permanent delete confirmation dialog.
          Shown when the user clicks Delete while already in trash folder or
          when no trash folder is configured.
          MEDIUM fix: focus trap, autoFocus on Cancel, Escape cancels, backdrop click cancels. */}
      {confirmPermanentDelete && (
        <div
          className="confirm-overlay"
          data-testid="confirm-permanent-delete-overlay"
          onClick={() => setConfirmPermanentDelete(false)}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setConfirmPermanentDelete(false)
              } else if (e.key === 'Tab') {
                // Focus trap: cycle between Cancel and Confirm buttons only.
                const focusable = [confirmCancelRef.current, confirmOkRef.current].filter(Boolean) as HTMLElement[]
                if (focusable.length < 2) return
                const first = focusable[0]
                const last = focusable[focusable.length - 1]
                if (e.shiftKey) {
                  if (document.activeElement === first) {
                    e.preventDefault()
                    last.focus()
                  }
                } else {
                  if (document.activeElement === last) {
                    e.preventDefault()
                    first.focus()
                  }
                }
              }
            }}
          >
            <p id="confirm-delete-title" className="confirm-dialog-message">
              {t('mail.actions.confirmPermanentDelete')}
            </p>
            <div className="confirm-dialog-actions">
              <button
                ref={confirmCancelRef}
                data-testid="confirm-delete-cancel"
                className="btn"
                onClick={() => setConfirmPermanentDelete(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                ref={confirmOkRef}
                data-testid="confirm-delete-ok"
                className="btn btn-danger"
                onClick={() => void handleConfirmPermanentDelete()}
              >
                {t('mail.actions.deleteForever')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suspicious link warning — shared component with App.tsx */}
      {linkPrompt && (
        <LinkWarningDialog
          prompt={linkPrompt}
          onApprove={approvePrompt}
          onCancel={dismissPrompt}
        />
      )}
    </>
  )
}
