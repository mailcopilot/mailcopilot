/**
 * AI panel — right sidebar with a chat interface.
 * Includes onboarding, privacy dialog, and contextual chips.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Send, Square, Sparkles, Loader2, ShieldCheck, Key, ExternalLink, History, Trash2, Mail, FolderOpen, AlertCircle } from 'lucide-react'
import AiAnswerMarkdown from './AiAnswerMarkdown'
import { useCitations } from '../hooks/useCitations'
import { singleFlightInvoke } from '../utils/ipcSingleFlight'
// §2.127 — `presentedError` lives in src/utils/errorPresentation.ts. Applies to
// `invoke()` rejections only: the `{ ok: false, reason }` / stream-event
// messages elsewhere in this panel are envelopes composed by our AI service and
// carry no closed-vocabulary tag.
import { presentedError } from '../utils/errorPresentation'
import { isApiKeyProvider, type AiApiKeySavedMap } from '../utils/aiApiKey'
import AiActionConfirmation, { type PendingActionSummary } from './AiActionConfirmation'
import AiSources from './AiSources'

// --- Types ---

/** Payload from the `ai:internet-tool-pending` IPC event (§3.10 P2). */
type InternetToolPending = {
  requestId: string
  toolName: string
  query?: string
  url?: string
  args?: unknown
}

/** The panel renders its messages as Markdown and i18next does not escape values: a model id (typed by the user or
 * listed by a custom endpoint) must not turn into a link or formatting inside the sentence. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+!|~&]/g, '\\$&')
}

type MessageRef = { accountId: number; folder: string; uid: number }

type AiStreamEvent =
  | { type: 'text_delta'; requestId: string; text: string }
  | { type: 'tool_use_start'; requestId: string; toolName: string; toolInput: unknown }
  | { type: 'tool_use_end'; requestId: string; toolName: string; result: string }
  | { type: 'thinking'; requestId: string; text: string }
  | { type: 'result'; requestId: string; text: string; sessionId: string; costUsd?: number }
  | { type: 'index_incomplete'; requestId: string }
  // `failure: 'model'` + `model`: the provider does not serve the chosen model (mirrors the error event of ai.ts); `failure: 'endpoint'`: the server answered 404 for the route.
  | { type: 'error'; requestId: string; message: string; failure?: string; model?: string }
  // §2.51.f2 — non-error interruption notice (mirrors `AiStreamNoticeCode` in
  // electron/services/ai.ts). The main process has no i18next instance, so it
  // sends a machine-readable `code` plus an English `message` fallback and the
  // renderer localizes the known codes.
  | { type: 'notice'; requestId: string; code: 'request_budget_exceeded' | 'destructive_action_not_prepared'; message: string }
  | { type: 'status'; requestId: string; status: 'thinking' | 'using_tool' | 'streaming' | 'done' }

/**
 * Mirrors `AuthStatus` in electron/services/ai.ts. §2.122 split the single
 * `invalid_key` verdict into three, because the panel was telling users their
 * key was wrong in the two cases where nothing had been read at all:
 *   - `no_key`            — the store answered and holds no key for this
 *                           provider. Ask for one; do not blame the user.
 *   - `store_unavailable` — the store itself failed. We do NOT know whether a
 *                           key exists, so the copy must not imply it is gone.
 *   - `invalid_key`       — a key WAS read and rejected.
 */
type AuthStatus =
  | { status: 'authenticated'; email?: string }
  | { status: 'not_configured' }
  | { status: 'no_key' }
  | { status: 'store_unavailable' }
  | { status: 'invalid_key' }
  | { status: 'error'; message: string }

type AiMessage = {
  role: 'user' | 'assistant'
  content: string
  /** A mail search ran against a local index that was still incomplete. Not persisted. */
  indexIncomplete?: boolean
  /** Request that produced this answer; lets a late event find its message. */
  requestId?: string
  /** Loaded from a session saved before citation tickets: its place links keep working (main marks every newer answer). */
  legacyLinks?: boolean
  costUsd?: number | null
}

type AiSessionListItem = {
  id: string
  title: string
  provider: string
  updatedAt: string
}

type ContextType = 'email' | 'thread' | 'folder' | 'compose' | 'multi-select' | null

export type AiPanelProps = {
  open: boolean
  onClose: () => void
  contextType: ContextType
  contextData: unknown
  aiProvider?: string
  aiPrivacyConsent?: boolean
  aiSendOnEnter?: boolean
  aiShowSources?: boolean
  onSettingsChange?: (key: string, value: unknown) => void
  onOpenSource?: (ref: MessageRef) => void | Promise<void>
  /** Open the message a citation ticket of this session names (main resolves it; nothing opens if it is gone). */
  onOpenCitation?: (sessionId: string, token: string) => void | Promise<void>
  quickPrompt?: string | null
  onQuickPromptHandled?: () => void
}

// --- requestId generation ---

let reqCounter = 0
function nextRequestId(): string {
  return `ai-${Date.now()}-${++reqCounter}`
}

// --- Component ---

export default function AiPanel({
  open,
  onClose,
  contextType,
  contextData,
  aiProvider,
  aiPrivacyConsent,
  aiSendOnEnter = true,
  aiShowSources = true,
  onSettingsChange,
  onOpenSource,
  onOpenCitation,
  quickPrompt,
  onQuickPromptHandled,
}: AiPanelProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  /**
   * §2.122 — our own recollection (`settings.aiApiKeySaved[provider]`, written
   * by the main process only) that a key for the current provider was once
   * saved. WORDING ONLY: it turns "no key is set" into "a key was saved but is
   * gone — enter it again". It never gates anything, never triggers a delete or
   * a re-auth, and is never consulted instead of a real store read — the OS
   * secret store owns that truth (CLAUDE.md §5 "Кто владеет правдой").
   */
  const [keyPreviouslySaved, setKeyPreviouslySaved] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionList, setSessionList] = useState<AiSessionListItem[]>([])
  const [showSessionList, setShowSessionList] = useState(false)
  // §3.10 P0: pending mutating actions awaiting user click on Apply.
  // Source of truth is the main-process registry (`aiPendingActions.ts`); we
  // mirror it here for rendering. Refreshed via `ai:action:list` after every
  // tool_use_end so we never go stale relative to the AI's preview tool calls.
  const [pendingActions, setPendingActions] = useState<PendingActionSummary[]>([])
  // §3.10 P2: pending internet-tool consent request from main process.
  // Set when `ai:internet-tool-pending` fires; cleared on approve/deny/timeout.
  const [pendingEgress, setPendingEgress] = useState<InternetToolPending | null>(null)

  const activeSessionIdRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const userScrolledUpRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Forward ref to sendMessage so handleApplyPendingAction (declared above
  // sendMessage to keep the wiring readable) can nudge the AI without a
  // circular `useCallback` dep. sendMessage assigns into this ref each render.
  const sendMessageRef = useRef<((text?: string) => void) | null>(null)
  // Serializes everything written to `aiSession:addMessage` from the stream
  // handler. Row order in the session history is the reading order the user
  // gets back after a restart, and a `notice` must land AFTER the answer it
  // corrects — chaining is what makes "after" true regardless of how the two
  // IPC round-trips interleave. Every link swallows its own failure, so the
  // chain can never reject and stall the ones behind it.
  const sessionWriteQueueRef = useRef<Promise<void>>(Promise.resolve())

  // Keep ref in sync with state for use inside callbacks
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])

  // The session each request this panel started was asked in, and the request now on screen. A
  // result is matched to its own request and session, never to "the last answer" or "the active
  // chat": a late result of an earlier chat must not give its sources to the next one.
  const requestSessionRef = useRef<Map<string, string>>(new Map())
  const currentRequestIdRef = useRef<string | null>(null)
  // The text each request has streamed so far, keyed by request: two requests never share a buffer.
  const textByRequestRef = useRef<Map<string, string>>(new Map())
  // Ref first, state second: a check made right after a stop must already see the stop.
  const setCurrentRequest = useCallback((id: string | null) => {
    currentRequestIdRef.current = id
    setCurrentRequestId(id)
  }, [])

  // Prompt history (up/down arrow navigation, like in a terminal)
  const promptHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const draftRef = useRef('')

  // Session cost — sum of costUsd across all assistant messages
  // What main says each citation ticket of the finished answers is (a source of this chat or not).
  const finishedAnswers = useMemo(
    () => messages.flatMap((m, i) => (m.role === 'assistant' && !m.legacyLinks && !(isStreaming && i === messages.length - 1) ? [m.content] : [])),
    [messages, isStreaming],
  )
  const { citations, tokensOf: citationTokensOf } = useCitations(activeSessionId, finishedAnswers)

  const sessionCost = useMemo(() => {
    let total = 0
    for (const msg of messages) {
      if (msg.role === 'assistant' && typeof msg.costUsd === 'number') {
        total += msg.costUsd
      }
    }
    return total
  }, [messages])

  // Load session list
  const loadSessionList = useCallback(async () => {
    try {
      const list = await window.api.invoke('aiSession:list') as AiSessionListItem[]
      setSessionList(list)
    } catch { /* ignore */ }
  }, [])

  // --- Pending mutating actions (preview→apply confirmation barrier) -------
  //
  // Refresh the renderer-mirrored list from main. Called after each
  // `tool_use_end` (so we pick up new previews regardless of which preview_*
  // tool the AI called) and after the user clicks Apply / Cancel (so the
  // `confirmed: true` flag flips on the button immediately).
  const refreshPendingActions = useCallback(async () => {
    try {
      const list = await window.api.invoke('ai:action:list') as PendingActionSummary[] | undefined
      // Defensive: tolerate IPC handler returning undefined / non-array (e.g.
      // when the registry is empty in some implementations, or when tests
      // stub `window.api.invoke` to a generic resolver).
      setPendingActions(Array.isArray(list) ? list : [])
    } catch { /* ignore — stale UI is preferable to throwing */ }
  }, [])

  // User clicked Apply on a confirmation block. Issuing the confirmation
  // token flips the registry entry to `confirmed: true` and main-side
  // `describePendingPreviews()` will inject the token into the next system
  // prompt build. We then nudge the AI with a synthetic user turn so it
  // proceeds to call the matching `apply_*` tool. The token is already in the
  // system prompt; we only need to surface "user said yes".
  //
  // HIGH#3 fix (preview/apply confirmation barrier review): Apply is a
  // no-op while a turn is streaming. `sendMessage` returns early when
  // `isStreaming === true`, so calling it before the assistant finishes
  // would consume the token main-side without nudging the AI — the next
  // turn would never receive the proceedPrompt and the model would either
  // give up or re-ask. Blocking the click during streaming is the simplest
  // correct option: matches user mental model (wait for AI to finish), no
  // queue state to clean up on abort/close, no surface area added to a
  // security-critical path. The button is also visually disabled (via
  // `summary.confirmed === undefined` plus the `disabled` prop on
  // AiActionConfirmation), so this is a defence-in-depth guard against
  // users who manage to click via keyboard/automation despite the
  // disabled state.
  const handleApplyPendingAction = useCallback(async (previewId: string) => {
    if (isStreaming) {
      // Should not normally happen — the confirmation block disables Apply
      // while streaming. Silent no-op so we don't consume the token before
      // the AI can read it.
      return
    }
    let confirmationToken: string | null = null
    try {
      const res = await window.api.invoke('ai:action:apply', previewId) as
        | { ok: true; confirmationToken: string; summary: PendingActionSummary }
        | { ok: false; reason: string }
      if (res?.ok) {
        confirmationToken = res.confirmationToken
        // Optimistic flip — disables the Apply button instantly while we
        // wait for the next list refresh.
        setPendingActions(prev => prev.map(p =>
          p.previewId === previewId ? { ...p, confirmed: true } : p,
        ))
      } else {
        // Preview not found / already consumed — drop from local state and
        // surface a one-line error in chat so the user understands why
        // nothing happened.
        setPendingActions(prev => prev.filter(p => p.previewId !== previewId))
        setMessages(prev => [
          ...prev,
          { role: 'assistant', content: `**${t('ai.errors.errorPrefix')}:** ${t('ai.confirmation.errorPreviewMissing')}` },
        ])
        return
      }
    } catch (e) {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `**${t('ai.errors.errorPrefix')}:** ${presentedError(t, e)}` },
      ])
      return
    }
    void refreshPendingActions()
    // Nudge the AI: synthetic user message that mentions the token so the
    // model has a clear instruction to proceed via apply_*. The system
    // prompt's [Pending actions] block already carries the token, but
    // restating it in the user turn makes the chain-of-thought explicit and
    // robust against models that ignore system-block hints.
    //
    // LOW#2: token is intentionally echoed in the user-side message text so
    // the AI's chain-of-thought has explicit confirmation. The token is
    // single-use (atomic claim removes the registry entry on the apply
    // path) and TTL-gated (TOKEN_TTL_MS in aiPendingActions.ts); even if
    // the message text persists in SQLite session storage it cannot be
    // replayed because the registry entry is gone after the first apply.
    if (confirmationToken) {
      sendMessageRef.current?.(t('ai.confirmation.proceedPrompt', { token: confirmationToken }))
    }
  }, [isStreaming, refreshPendingActions, t])

  const handleCancelPendingAction = useCallback(async (previewId: string) => {
    try {
      await window.api.invoke('ai:action:cancel', previewId)
    } catch { /* ignore — main-side TTL will still expire it */ }
    setPendingActions(prev => prev.filter(p => p.previewId !== previewId))
  }, [])

  // Load session list on panel open
  useEffect(() => {
    if (open) void loadSessionList()
  }, [open, loadSessionList])

  // Check authorization on open
  useEffect(() => {
    if (!open) return
    if (!aiProvider) {
      setAuthStatus({ status: 'not_configured' })
      setKeyPreviouslySaved(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        // Pass aiProvider explicitly — avoids race condition when saving settings.
        // Routed through singleFlightInvoke to coalesce duplicate fires during
        // cold start (AiPanel open-effect + aiProvider-settle effect +
        // StrictMode double-invoke in dev). §1.4 renderer dedup.
        const status = await singleFlightInvoke<AuthStatus>('ai:checkAuth', [aiProvider])
        if (cancelled) return
        setAuthStatus(status)
        // §2.122 — only the "the store answered and holds nothing" verdict has
        // two possible readings for the user; ask for our marker only then, and
        // only to pick the sentence.
        if (status.status === 'no_key' && isApiKeyProvider(aiProvider)) {
          let saved = false
          try {
            const s = await window.api.invoke('settings:get') as
              { aiApiKeySaved?: AiApiKeySavedMap } | null
            saved = s?.aiApiKeySaved?.[aiProvider] === true
          } catch {
            // No marker readable → fall back to the neutral "no key" wording.
            saved = false
          }
          if (!cancelled) setKeyPreviouslySaved(saved)
        } else if (!cancelled) {
          setKeyPreviouslySaved(false)
        }
      } catch {
        if (!cancelled) setAuthStatus({ status: 'error', message: t('ai.errors.authCheck') })
      }
    })()
    return () => { cancelled = true }
  }, [open, aiProvider, t])

  // Show privacy dialog on first use
  useEffect(() => {
    if (open && aiProvider && !aiPrivacyConsent) {
      setShowPrivacy(true)
    }
  }, [open, aiProvider, aiPrivacyConsent])

  // Context update (debounce)
  useEffect(() => {
    if (!open || !contextType) return
    const timer = setTimeout(() => {
      void window.api.invoke('ai:setContext', { type: contextType, data: contextData })
    }, 300)
    return () => clearTimeout(timer)
  }, [open, contextType, contextData])

  // Subscribe to stream events
  useEffect(() => {
    if (!open) return

    // Ensure no listener leaks (protection from HMR and StrictMode)
    window.api.removeAll('ai:stream')

    const handler = (event: AiStreamEvent) => {
      if (!event || !event.requestId) return
      // A preview tool may have registered a pending action in main whichever request ran it; the registry is
      // global to the app, so this refresh is not gated by request ownership (it only reads).
      if (event.type === 'tool_use_end') {
        // Tool use status is shown in the status bar, not inline.
        // §3.10 P0: any preview tool may have just registered a new
        // pending action. Refresh from main on every tool_use_end —
        // it's a synchronous map iteration in the registry, so the cost
        // is trivial and we never go stale.
        const stripped = event.toolName.replace('mcp__mailcopilot__', '')
        if (stripped.startsWith('preview_') || stripped.endsWith('_preview') || stripped.startsWith('apply_') || stripped.endsWith('_apply')) {
          void refreshPendingActions()
        }
        return
      }
      // Only events of a request this panel instance started are read at all.
      const ownerSession = requestSessionRef.current.get(event.requestId)
      if (!ownerSession) return
      // The request on screen drives the status line and the Stop button; an earlier chat's request does not.
      const isCurrent = currentRequestIdRef.current === event.requestId

      switch (event.type) {
        case 'text_delta': {
          const text = (textByRequestRef.current.get(event.requestId) ?? '') + event.text
          textByRequestRef.current.set(event.requestId, text)
          // The answer of THIS request, wherever it is; nothing happens when its chat is not on screen.
          setMessages(prev => {
            const idx = prev.findIndex(m => m.role === 'assistant' && m.requestId === event.requestId)
            if (idx < 0) return prev
            const next = [...prev]
            next[idx] = { ...next[idx]!, content: text }
            return next
          })
          break
        }

        case 'tool_use_start':
          if (isCurrent) setStreamStatus(t('ai.panel.usingTool', { tool: event.toolName.replace('mcp__mailcopilot__', '') }))
          break

        case 'status':
          if (event.status === 'done') {
            if (isCurrent) {
              setIsStreaming(false)
              setStreamStatus(null)
              setCurrentRequest(null)
            }
            // `done` is NOT the last event of a request: a notice (e.g. "no action was prepared") follows it, and
            // it must still find its owner. The request is forgotten when a newer one pushes it out of the bound.
            textByRequestRef.current.delete(event.requestId)
          } else if (isCurrent) {
            if (event.status === 'thinking') setStreamStatus(t('ai.panel.thinking'))
            else if (event.status === 'streaming') setStreamStatus(t('ai.panel.streaming'))
          }
          break

        // Arrives after `result`, only when the count had already finished: one line under that answer.
        case 'index_incomplete':
          setMessages(prev => prev.map(m => (m.role === 'assistant' && m.requestId === event.requestId ? { ...m, indexIncomplete: true } : m)))
          break

        case 'result': {
          // sessionId from Claude SDK is persisted via updateAiSessionClaudeId in main.ts
          // Final text is already in the message via text_delta
          const sid = ownerSession
          setMessages(prev => {
            const idx = prev.findIndex(m => m.role === 'assistant' && m.requestId === event.requestId)
            // The request's chat is no longer on screen: there is no answer here to give its verdict to.
            if (idx < 0) return prev
            const next = [...prev]
            next[idx] = {
              ...next[idx]!,
              costUsd: event.costUsd ?? null,
            }
            return next
          })
          // Only the request on screen ends the streaming state; an earlier chat's result does not.
          if (isCurrent) {
            setIsStreaming(false)
            setStreamStatus(null)
            setCurrentRequest(null)
          }
          // Persist assistant message (into the chat the request was asked in) and maybe generate title
          const assistantText = event.text
          if (assistantText) {
            sessionWriteQueueRef.current = sessionWriteQueueRef.current.then(async () => {
              try {
                await window.api.invoke('aiSession:addMessage', { sessionId: sid, role: 'assistant', content: assistantText, costUsd: event.costUsd ?? undefined })
              } catch { /* ignore */ }
              // Generate title after first exchange (2 messages: user + assistant)
              try {
                const msgs = await window.api.invoke('aiSession:messages', sid) as { role: string; content: string }[]
                if (msgs.length === 2) {
                  const userMsg = msgs.find(m => m.role === 'user')?.content || ''
                  const res = await window.api.invoke('aiSession:generateTitle', sid, userMsg, assistantText) as { title?: string }
                  const title = res?.title
                  if (title) {
                    setSessionList(prev => prev.map(s => s.id === sid ? { ...s, title } : s))
                  }
                }
              } catch { /* ignore */ }
              void loadSessionList()
            })
          }
          break
        }

        // §2.51.f2 — the request was cut short for a known, non-error reason
        // (currently: the per-request cost ceiling). Appended as its own
        // assistant message AFTER the partial answer so the answer keeps its
        // cost badge. Unknown future codes fall back to the English message from
        // main rather than rendering nothing.
        case 'notice': {
          // §2.123 added the second code: a turn that used the destructive tool
          // machinery and armed nothing, so no confirmation block will appear
          // below. Unknown future codes still fall back to main's English text.
          const noticeKey: Record<string, string> = {
            request_budget_exceeded: 'ai.errors.requestBudgetStopped',
            destructive_action_not_prepared: 'ai.errors.actionNotPrepared',
          }
          const key = noticeKey[event.code]
          const noticeText = key ? t(key) : event.message
          // On screen only when the request's own answer is (a notice of an earlier chat is not shown here).
          setMessages(prev => (prev.some(m => m.role === 'assistant' && m.requestId === event.requestId)
            ? [...prev, { role: 'assistant', content: noticeText }]
            : prev))
          // The notice belongs in the stored history too. Without this it lived
          // on screen only: reopening the session showed the answer WITHOUT the
          // correction, so a turn that armed nothing came back looking like a
          // turn that had a confirmation button somewhere — the exact belief
          // §2.123 exists to remove. Queued behind the `result` write (main
          // emits `result` before any notice), so the order on disk is the order
          // on screen. `assistant` is the role every service-side insert already
          // uses; the IPC channel accepts no other, and no cost is attached —
          // the notice is not a billable message.
          //
          // KNOWN codes only. An unrecognized code falls back to main's English
          // `message`, and persisting that would freeze an untranslated string
          // into the history forever; on screen it is transient and harmless.
          if (key) {
            const sid = ownerSession
            if (sid) {
              sessionWriteQueueRef.current = sessionWriteQueueRef.current.then(async () => {
                try {
                  await window.api.invoke('aiSession:addMessage', { sessionId: sid, role: 'assistant', content: noticeText })
                } catch { /* ignore */ }
              })
            }
          }
          break
        }

        case 'error':
          if (isCurrent) {
            setIsStreaming(false)
            setStreamStatus(null)
            setCurrentRequest(null)
          }
          requestSessionRef.current.delete(event.requestId)
          textByRequestRef.current.delete(event.requestId)
          setMessages(prev => {
            const idx = prev.findIndex(m => m.role === 'assistant' && m.requestId === event.requestId)
            // The request's answer is not on screen: its error is not either.
            if (idx < 0) return prev
            const next = [...prev]
            const errorText = event.failure === 'model' && event.model
              ? `**${t('ai.errors.errorPrefix')}:** ${t('ai.errors.modelUnavailable', { model: escapeMarkdown(event.model) })}`
              : event.failure === 'endpoint'
                ? `**${t('ai.errors.errorPrefix')}:** ${t('ai.errors.endpointNotFound')}`
                : `**${t('ai.errors.errorPrefix')}:** ${event.message}`
            if (!next[idx]!.content) next[idx] = { ...next[idx]!, content: errorText }
            else next.splice(idx + 1, 0, { role: 'assistant', content: errorText })
            return next
          })
          break
      }
    }

    window.api.on('ai:stream', handler as (...args: unknown[]) => void)
    return () => {
      window.api.off('ai:stream', handler as (...args: unknown[]) => void)
    }
  }, [open, t, loadSessionList, refreshPendingActions, setCurrentRequest])

  // §3.10 P2: subscribe to main-process internet-tool consent requests.
  // Main sends `ai:internet-tool-pending` when an egress tool call is
  // intercepted and consent is required. The renderer shows an inline confirm
  // modal; the user clicks Allow or Deny to unblock the AI turn.
  // If main times out (30 s) it sends a deny event — renderer responds to
  // that by clearing the modal (no renderer-side timer needed).
  useEffect(() => {
    if (!open) return

    const pendingHandler = (payload: unknown) => {
      const p = payload as InternetToolPending
      if (!p || !p.requestId) return
      setPendingEgress(p)
    }

    window.api.on('ai:internet-tool-pending', pendingHandler as (...args: unknown[]) => void)
    return () => {
      window.api.off('ai:internet-tool-pending', pendingHandler as (...args: unknown[]) => void)
    }
  }, [open])

  // Smart scroll: auto-scroll on new messages if user hasn't manually scrolled up.
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // pendingEgress renders outside .ai-body and is always visible above the input
  // — no scroll-into-view needed.

  // Track user scroll position
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      userScrolledUpRef.current = !atBottom
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  // Send message
  const sendMessage = useCallback((text?: string) => {
    const prompt = (text || input).trim()
    if (!prompt || isStreaming) return

    // Save prompt to history (no consecutive duplicates)
    if (promptHistoryRef.current[promptHistoryRef.current.length - 1] !== prompt) {
      promptHistoryRef.current.push(prompt)
    }
    historyIndexRef.current = -1
    draftRef.current = ''

    setInput('')
    const reqId = nextRequestId()
    setCurrentRequest(reqId)
    setIsStreaming(true)
    setStreamStatus(t('ai.panel.thinking'))

    setMessages(prev => [
      ...prev,
      { role: 'user', content: prompt },
      { role: 'assistant', content: '', requestId: reqId },
    ])

    // Create session if needed, persist user message, then send
    void (async () => {
      let sid = activeSessionIdRef.current
      if (!sid) {
        sid = crypto.randomUUID()
        setActiveSessionId(sid)
        activeSessionIdRef.current = sid
        try {
          await window.api.invoke('aiSession:create', { id: sid, provider: aiProvider || 'openai-api' })
        } catch { /* ignore */ }
      }
      // Persist user message
      try {
        await window.api.invoke('aiSession:addMessage', { sessionId: sid, role: 'user', content: prompt })
      } catch { /* ignore */ }
      // The user stopped this request, or opened another chat, while the writes above were running:
      // it is no longer the request on screen, so it is not sent at all.
      if (currentRequestIdRef.current !== reqId) return
      requestSessionRef.current.set(reqId, sid)
      // Bounded: the owner of a finished request is kept only long enough for its trailing events.
      while (requestSessionRef.current.size > 16) {
        const oldest = requestSessionRef.current.keys().next().value
        if (oldest === undefined) break
        requestSessionRef.current.delete(oldest)
      }
      void window.api.invoke('ai:chat', reqId, prompt, contextType ? { type: contextType, data: contextData } : undefined, sid, aiProvider)
    })()
  }, [input, isStreaming, contextType, contextData, aiProvider, t, setCurrentRequest])

  // Keep sendMessageRef in sync — used by handleApplyPendingAction (declared
  // above sendMessage to keep the confirmation-block wiring readable).
  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])

  // Refresh pending actions when the panel opens — handles reload-into-an-
  // existing-session where main may already hold previews from a prior turn
  // that hasn't been cleared by TTL yet.
  useEffect(() => {
    if (!open) return
    void refreshPendingActions()
  }, [open, refreshPendingActions])

  // External trigger for quick summarization (Ctrl+Shift+S / Command Palette)
  useEffect(() => {
    if (!open || !quickPrompt) return
    if (isStreaming) return
    if (showPrivacy) return
    if (!aiProvider) return
    if (authStatus && authStatus.status !== 'authenticated') return
    sendMessage(quickPrompt)
    onQuickPromptHandled?.()
  }, [aiProvider, authStatus, isStreaming, onQuickPromptHandled, open, quickPrompt, sendMessage, showPrivacy])

  // §3.10 P2: approve / deny an internet-tool consent request.
  const handleEgressApprove = useCallback(() => {
    if (!pendingEgress) return
    const { requestId } = pendingEgress
    setPendingEgress(null)
    void window.api.invoke('ai:internet-tool-approve', requestId)
  }, [pendingEgress])

  const handleEgressDeny = useCallback(() => {
    if (!pendingEgress) return
    const { requestId } = pendingEgress
    setPendingEgress(null)
    void window.api.invoke('ai:internet-tool-deny', requestId)
  }, [pendingEgress])

  // Stop generation
  const stopGeneration = useCallback(() => {
    if (currentRequestId) {
      requestSessionRef.current.delete(currentRequestId)
      textByRequestRef.current.delete(currentRequestId)
      void window.api.invoke('ai:stop', currentRequestId)
      setIsStreaming(false)
      setStreamStatus(null)
      setCurrentRequest(null)
    }
  }, [currentRequestId, setCurrentRequest])

  // New chat
  const newChat = useCallback(() => {
    if (isStreaming) stopGeneration()
    setMessages([])
    setActiveSessionId(null)
    setShowSessionList(false)
    setPendingActions([])
    void window.api.invoke('ai:newSession')
    void loadSessionList()
    void refreshPendingActions()
  }, [isStreaming, stopGeneration, loadSessionList, refreshPendingActions])

  // Load a session by ID
  const loadSession = useCallback(async (id: string) => {
    if (isStreaming) stopGeneration()
    try {
      // Session boundary: clear pending preview registry so confirmation tokens
      // and previewIds from the previously-active session don't leak into the
      // freshly-loaded one (cross-session token replay). `ai:newSession` is the
      // shared session-boundary IPC; despite the name it just clears the pending
      // preview registry on the main side.
      void window.api.invoke('ai:newSession')
      const msgs = await window.api.invoke('aiSession:messages', id) as Array<{ role: 'user' | 'assistant'; content: string; costUsd: number | null; citationVersion: number | null }>
      setMessages(msgs.map(m => ({ role: m.role, content: m.content, costUsd: m.costUsd, ...(m.role === 'assistant' && m.citationVersion == null ? { legacyLinks: true } : {}) })))
      setActiveSessionId(id)
      setShowSessionList(false)
      void refreshPendingActions()
    } catch { /* ignore */ }
  }, [isStreaming, stopGeneration, refreshPendingActions])

  // Delete a session
  const deleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await window.api.invoke('aiSession:delete', id)
      if (activeSessionId === id) {
        // Active session removed → cross a session boundary. Clear pending
        // preview registry alongside local state so a stale preview from the
        // deleted session can't surface in the next session the user opens.
        void window.api.invoke('ai:newSession')
        setMessages([])
        setActiveSessionId(null)
      }
      void loadSessionList()
    } catch { /* ignore */ }
  }, [activeSessionId, loadSessionList])

  // Delete all sessions
  const deleteAllSessions = useCallback(async () => {
    try {
      // Session boundary: bulk-deleting every session necessarily abandons
      // the currently-active one, so the main-side pending preview registry
      // must be cleared too. Otherwise an unconfirmed preview (and its
      // confirmation_token) from the just-deleted session leaks into the
      // next session the user opens. Same class of leak as loadSession /
      // deleteSession (waves 3-4); deleteAllSessions is the 4th boundary.
      // `ai:newSession` is the shared session-boundary IPC: despite the
      // name it just clears the pending preview registry on the main side
      // (and now also aborts any in-flight LLM stream — see main.ts).
      if (isStreaming) stopGeneration()
      void window.api.invoke('ai:newSession')
      await window.api.invoke('aiSession:deleteAll')
      setMessages([])
      setActiveSessionId(null)
      void loadSessionList()
    } catch { /* ignore */ }
  }, [isStreaming, stopGeneration, loadSessionList])

  // Keyboard handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget

    // Prompt history: ArrowUp/ArrowDown
    // Enter history mode: ArrowUp when cursor is at position 0 (don't intercept soft-wrap navigation)
    // In history mode (historyIndex !== -1): ArrowUp/Down switch entries without cursor check
    if (e.key === 'ArrowUp' && promptHistoryRef.current.length > 0) {
      const inHistoryMode = historyIndexRef.current !== -1
      if (inHistoryMode || ta.selectionStart === 0) {
        e.preventDefault()
        const history = promptHistoryRef.current
        if (!inHistoryMode) {
          draftRef.current = input
          historyIndexRef.current = history.length - 1
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current--
        }
        setInput(history[historyIndexRef.current])
      }
    }
    if (e.key === 'ArrowDown' && historyIndexRef.current !== -1) {
      e.preventDefault()
      const history = promptHistoryRef.current
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current++
        setInput(history[historyIndexRef.current])
      } else {
        historyIndexRef.current = -1
        setInput(draftRef.current)
      }
    }

    if (e.key === 'Enter') {
      if (aiSendOnEnter && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault()
        sendMessage()
      } else if (!aiSendOnEnter && e.ctrlKey) {
        e.preventDefault()
        sendMessage()
      }
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (isStreaming) {
        stopGeneration()
      } else {
        onClose()
      }
    }
  }, [aiSendOnEnter, sendMessage, isStreaming, stopGeneration, onClose, input])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [input])

  // Chip scope toggle: when email/thread is open, allow switching to folder chips
  const [chipScope, setChipScope] = useState<'email' | 'folder'>('email')
  const showScopeToggle = contextType === 'email' || contextType === 'thread'
  useEffect(() => { setChipScope('email') }, [contextType])

  // Contextual chips
  const chips = useMemo(() => {
    if (showScopeToggle && chipScope === 'folder') {
      return [
        { key: 'digest', label: t('ai.chips.digest'), prompt: t('ai.prompts.digest') },
        { key: 'needsReply', label: t('ai.chips.needsReply'), prompt: t('ai.prompts.needsReply') },
        { key: 'nlSearch', label: t('ai.chips.nlSearch'), prompt: t('ai.prompts.nlSearch') },
        { key: 'gtdTriage', label: t('ai.chips.gtdTriage'), prompt: t('ai.prompts.gtdTriage') },
        { key: 'weeklyReview', label: t('ai.chips.weeklyReview'), prompt: t('ai.prompts.weeklyReview') },
        { key: 'cleanupAll', label: t('ai.chips.cleanupAll'), prompt: t('ai.prompts.cleanupAll') },
      ]
    }
    switch (contextType) {
      case 'email':
        return [
          { key: 'summarize', label: t('ai.chips.summarize'), prompt: t('ai.prompts.summarize') },
          { key: 'reply', label: t('ai.chips.reply'), prompt: t('ai.prompts.reply') },
          { key: 'tasksDeadlines', label: t('ai.chips.tasksDeadlines'), prompt: t('ai.prompts.tasksDeadlines') },
          { key: 'triage', label: t('ai.chips.triage'), prompt: t('ai.prompts.triage') },
          { key: 'snooze', label: t('ai.chips.snooze'), prompt: t('ai.prompts.snooze') },
          { key: 'flag', label: t('ai.chips.flag'), prompt: t('ai.prompts.flag') },
          { key: 'followup', label: t('ai.chips.followup'), prompt: t('ai.prompts.followup') },
          { key: 'gtdClassify', label: t('ai.chips.gtdClassify'), prompt: t('ai.prompts.gtdClassify') },
        ]
      case 'thread':
        return [
          { key: 'summarizeThread', label: t('ai.chips.summarizeThread'), prompt: t('ai.prompts.summarizeThread') },
          { key: 'keyDecisions', label: t('ai.chips.keyDecisions'), prompt: t('ai.prompts.keyDecisions') },
          { key: 'needsReply', label: t('ai.chips.needsReply'), prompt: t('ai.prompts.needsReply') },
          { key: 'tasksDeadlines', label: t('ai.chips.tasksDeadlines'), prompt: t('ai.prompts.tasksDeadlines') },
          { key: 'triage', label: t('ai.chips.triage'), prompt: t('ai.prompts.triageThread') },
        ]
      case 'folder':
        return [
          { key: 'digest', label: t('ai.chips.digest'), prompt: t('ai.prompts.digest') },
          { key: 'needsReply', label: t('ai.chips.needsReply'), prompt: t('ai.prompts.needsReply') },
          { key: 'nlSearch', label: t('ai.chips.nlSearch'), prompt: t('ai.prompts.nlSearch') },
          { key: 'gtdTriage', label: t('ai.chips.gtdTriage'), prompt: t('ai.prompts.gtdTriage') },
          { key: 'weeklyReview', label: t('ai.chips.weeklyReview'), prompt: t('ai.prompts.weeklyReview') },
          { key: 'cleanupAll', label: t('ai.chips.cleanupAll'), prompt: t('ai.prompts.cleanupAll') },
        ]
      default:
        // Global chips available without specific context
        return [
          { key: 'weeklyReview', label: t('ai.chips.weeklyReview'), prompt: t('ai.prompts.weeklyReview') },
          { key: 'cleanupAll', label: t('ai.chips.cleanupAll'), prompt: t('ai.prompts.cleanupAll') },
        ]
    }
  }, [contextType, chipScope, showScopeToggle, t])

  // Accept privacy consent
  const acceptPrivacy = useCallback(() => {
    setShowPrivacy(false)
    onSettingsChange?.('aiPrivacyConsent', true)
  }, [onSettingsChange])

  if (!open) return null

  // --- Privacy dialog ---
  if (showPrivacy) {
    return (
      <div className="ai-panel" data-testid="ai-panel">
        <div className="ai-panel-header">
          <div className="ai-panel-title">
            <ShieldCheck size={16} />
            <span>{t('ai.privacy.title')}</span>
          </div>
          <button className="btn-icon" onClick={onClose} title={t('ai.panel.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="ai-privacy-dialog" data-testid="ai-privacy-dialog">
          <p>{t('ai.privacy.description')}</p>
          <div className="ai-privacy-actions">
            <button className="btn" onClick={onClose}>{t('ai.privacy.cancel')}</button>
            <button className="btn btn-primary" onClick={acceptPrivacy}>{t('ai.privacy.accept')}</button>
          </div>
        </div>
      </div>
    )
  }

  // --- Onboarding ---
  if (!aiProvider || (authStatus && authStatus.status === 'not_configured')) {
    return (
      <div className="ai-panel" data-testid="ai-panel">
        <div className="ai-panel-header">
          <div className="ai-panel-title">
            <Sparkles size={16} />
            <span>{t('ai.onboarding.title')}</span>
          </div>
          <button className="btn-icon" onClick={onClose} title={t('ai.panel.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="ai-onboarding" data-testid="ai-onboarding">
          <p>{t('ai.onboarding.description')}</p>
          <ul className="ai-onboarding-features">
            <li>{t('ai.onboarding.features.summarize')}</li>
            <li>{t('ai.onboarding.features.drafts')}</li>
            <li>{t('ai.onboarding.features.search')}</li>
            <li>{t('ai.onboarding.features.digest')}</li>
          </ul>
          <p className="ai-onboarding-choose">{t('ai.onboarding.chooseProvider')}</p>
          <div className="ai-onboarding-options">
            {/* §2.218 — the "Claude subscription" option was removed with the
                provider. Every remaining provider is key-based, and the panel
                offers the shortest path (Anthropic API key); the other two are
                one click away through the Settings link below. */}
            <button
              className="ai-onboarding-option"
              onClick={() => onSettingsChange?.('aiProvider', 'anthropic-api')}
            >
              <Key size={16} />
              <div>
                <strong>{t('ai.onboarding.apiKey')}</strong>
                <small>{t('ai.onboarding.apiKeyHint')}</small>
              </div>
            </button>
          </div>
          <button
            className="ai-onboarding-settings-link"
            onClick={() => void window.api.invoke('ui:openSettings')}
          >
            <ExternalLink size={12} />
            {t('ai.onboarding.configure')}
          </button>
        </div>
      </div>
    )
  }

  // --- Authorization error ---
  if (authStatus && authStatus.status !== 'authenticated') {
    // §2.122 — one sentence per storage outcome. "invalidKey" is reserved for
    // the case where a key was actually read and rejected; an empty store and
    // an unreachable store each get their own, non-accusing copy.
    const errorKey = authStatus.status === 'invalid_key' ? 'invalidKey'
      : authStatus.status === 'no_key' ? (keyPreviouslySaved ? 'keyMissing' : 'noKey')
      : authStatus.status === 'store_unavailable' ? 'storeUnavailable'
      : 'notConfigured'
    return (
      <div className="ai-panel" data-testid="ai-panel">
        <div className="ai-panel-header">
          <div className="ai-panel-title">
            <Sparkles size={16} />
            <span>{t('ai.panel.title')}</span>
          </div>
          <button className="btn-icon" onClick={onClose} title={t('ai.panel.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="ai-auth-error" data-testid="ai-auth-error">
          <p>{t(`ai.errors.${errorKey}`)}</p>
          {'message' in authStatus && authStatus.message && <p className="ai-auth-error-detail">{authStatus.message}</p>}
          <div className="ai-auth-error-actions">
            <button className="btn btn-primary" onClick={() => void window.api.invoke('ui:openSettings')}>
              {t('ai.onboarding.configure')}
            </button>
            {/*
              §2.122 — changing the provider is a SETTINGS change, nothing else.
              This button used to call `ai:deleteApiKey` with no argument, which
              the main process read as "delete every provider's key": one click
              destroyed all three stored keys, with no confirmation, from a
              screen the app reached by mistakenly claiming the key was invalid.
              Providers do not conflict — keeping the keys costs nothing and
              switching back has to just work. Deleting a key is a separate,
              explicit, per-provider action behind a confirmation, and it lives
              in Settings → AI ("Reset configuration").
            */}
            <button className="btn btn-secondary" onClick={() => {
              onSettingsChange?.('aiProvider', '')
              setAuthStatus({ status: 'not_configured' })
            }}>
              {t('ai.errors.changeProvider')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // --- Main chat ---
  return (
    <div className="ai-panel" data-testid="ai-panel">
      {/* Header */}
      <div className="ai-panel-header">
        <div className="ai-panel-title">
          <Sparkles size={16} />
          <span>{t('ai.panel.title')}</span>
          {sessionCost > 0 && (
            <span className="ai-session-cost" title={t('ai.panel.sessionCostTooltip', { cost: `$${sessionCost.toFixed(4)}` })}>
              ${sessionCost < 0.01 ? sessionCost.toFixed(4) : sessionCost.toFixed(2)}
            </span>
          )}
        </div>
        <div className="ai-panel-actions">
          <button
            className={`btn-icon${showSessionList ? ' active' : ''}`}
            onClick={() => setShowSessionList(prev => !prev)}
            title={t('ai.sessions.history')}
            data-testid="ai-sessions-toggle"
          >
            <History size={14} />
          </button>
          <button className="btn-icon" onClick={newChat} title={t('ai.panel.newChat')}>
            <Plus size={14} />
          </button>
          <button className="btn-icon" onClick={onClose} title={t('ai.panel.close')}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Session list */}
      {showSessionList && (
        <div className="ai-session-list" data-testid="ai-session-list">
          <div className="ai-session-list-header">
            <span>{t('ai.sessions.title')}</span>
            {sessionList.length > 0 && (
              <button className="ai-session-clear-all" onClick={() => void deleteAllSessions()} title={t('ai.sessions.clearAll')}>
                <Trash2 size={12} />
                <span>{t('ai.sessions.clearAll')}</span>
              </button>
            )}
          </div>
          {sessionList.length === 0 ? (
            <div className="ai-session-empty">{t('ai.sessions.empty')}</div>
          ) : (
            sessionList.map(s => (
              <div
                key={s.id}
                className={`ai-session-item${s.id === activeSessionId ? ' active' : ''}`}
                data-testid="ai-session-item"
                onClick={() => void loadSession(s.id)}
              >
                <div className="ai-session-info">
                  <span className="ai-session-title">{s.title || t('ai.sessions.untitled')}</span>
                  <span className="ai-session-date">{new Date(s.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
                <button
                  className="ai-session-delete btn-icon"
                  onClick={(e) => void deleteSession(s.id, e)}
                  title={t('ai.sessions.delete')}
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Scrollable body: messages + chips + status + egress confirm.
          .ai-body takes flex: 1 and is the only overflow-y: auto element.
          The input row is rendered below this div so it always stays visible
          regardless of how much content is in the body (uiaudit.7). */}
      <div className="ai-body" ref={messagesContainerRef} data-testid="ai-body">
      {/* Messages area */}
      <div className="ai-messages" data-testid="ai-messages">
        {messages.length === 0 && (
          <div className="ai-empty">
            <Sparkles size={24} className="ai-empty-icon" />
            <p>{t('ai.panel.placeholder')}</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={`msg-${i}`} className={`ai-message ai-message-${msg.role}`} data-testid={`ai-message-${msg.role}`}>
            {msg.role === 'assistant' ? (
              <div className="ai-message-content">
                <AiAnswerMarkdown
                  content={msg.content || (isStreaming && i === messages.length - 1 ? '...' : '')}
                  citations={citations}
                  streaming={isStreaming && i === messages.length - 1}
                  legacyLinks={msg.legacyLinks}
                  onOpenCitation={token => { if (activeSessionId) void onOpenCitation?.(activeSessionId, token) }}
                  onOpenSource={onOpenSource}
                />
                {aiShowSources && !msg.legacyLinks && !(isStreaming && i === messages.length - 1) && (() => {
                  // Sources under the answer = the tickets of its links that this session knows (found or gone), in order.
                  const cited = citationTokensOf(msg.content).flatMap(token => {
                    const c = citations.get(token)
                    return c && c.status !== 'unknown' ? [c] : []
                  })
                  if (cited.length === 0) return null
                  return (
                    <AiSources
                      key={`${activeSessionId ?? ''}:${i}`}
                      cited={cited}
                      onOpen={token => { if (activeSessionId) void onOpenCitation?.(activeSessionId, token) }}
                    />
                  )
                })()}
                {msg.indexIncomplete && (
                  <div className="ai-index-note" data-testid="ai-index-note">{t('ai.panel.indexIncomplete')}</div>
                )}
                {typeof msg.costUsd === 'number' && msg.costUsd > 0 && (
                  <span className="ai-cost-badge" title={t('ai.panel.costTooltip', { cost: `$${msg.costUsd.toFixed(4)}` })}>
                    ${msg.costUsd < 0.01 ? msg.costUsd.toFixed(4) : msg.costUsd.toFixed(2)}
                  </span>
                )}
              </div>
            ) : (
              <div className="ai-message-content">{msg.content}</div>
            )}
          </div>
        ))}
        {/* §3.10 P0: pending mutating actions awaiting user confirmation.
            Rendered in chat flow so the click target sits next to the AI
            message that proposed the action. The block is the structural
            barrier between AI proposal and DB/IMAP/SMTP mutation —
            without a click here, no apply_* tool can fire.

            HIGH#3 fix: while a turn is streaming, Apply must be visually
            blocked. `sendMessage` returns early during streaming, so a
            click would consume the token main-side but never nudge the AI
            with the proceedPrompt — the next turn would never receive the
            token and the model would re-ask. We wrap the block in an
            aria-disabled container with `pointer-events: none` so users
            cannot click Apply/Cancel until the turn finishes. The tooltip
            explains the wait. We do NOT change AiActionConfirmation's
            interface (it stays stable for security review). */}
        {pendingActions.length > 0 && (
          <div
            className={`ai-pending-actions${isStreaming ? ' ai-pending-actions-streaming-blocked' : ''}`}
            data-testid="ai-pending-actions"
            data-streaming-blocked={isStreaming || undefined}
            aria-disabled={isStreaming || undefined}
            // Tooltip uses an existing string. Adding a new i18n key here
            // would require updating all 6 locale files (merge gate); we
            // reuse the existing "thinking..." status string which the
            // user already understands as "AI is busy, wait".
            title={isStreaming ? t('ai.panel.thinking') : undefined}
            style={isStreaming ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
          >
            {pendingActions.map(p => (
              <AiActionConfirmation
                key={p.previewId}
                summary={p}
                onApply={handleApplyPendingAction}
                onCancel={handleCancelPendingAction}
              />
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      </div>{/* end .ai-body — only .ai-messages stays inside the scrollable region */}

      {/* Streaming status — outside .ai-body, always visible above the chips/input row. */}
      {isStreaming && streamStatus && (
        <div className="ai-status" data-testid="ai-status">
          <Loader2 size={12} className="spin" />
          <span>{streamStatus}</span>
          <button className="btn-icon ai-stop-btn" onClick={stopGeneration} title={t('ai.panel.stop')}>
            <Square size={12} />
          </button>
        </div>
      )}

      {/* Contextual chips — outside .ai-body, pinned just above the input regardless of scroll. */}
      {chips.length > 0 && !isStreaming && (
        <div
          className="ai-chips"
          data-testid="ai-chips"
        >
          {showScopeToggle && (
            <button
              className="ai-chip ai-chip-scope"
              onClick={() => setChipScope(s => s === 'email' ? 'folder' : 'email')}
              title={chipScope === 'email' ? t('ai.chips.scopeFolder') : t('ai.chips.scopeEmail')}
              aria-label={chipScope === 'email' ? t('ai.chips.scopeFolder') : t('ai.chips.scopeEmail')}
              data-testid="ai-chip-scope-toggle"
            >
              {chipScope === 'email' ? <FolderOpen size={14} /> : <Mail size={14} />}
            </button>
          )}
          {chips.map(chip => (
            <button
              key={chip.key}
              className="ai-chip"
              onClick={() => sendMessage(chip.prompt)}
              disabled={isStreaming}
              title={chip.label}
              aria-label={chip.label}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* §3.10 P2: inline confirm modal for internet-tool consent.
          Shown when main intercepts an egress tool call and needs the user
          to approve or deny before proceeding. query/url/toolName come from
          the LLM — rendered as plain React text nodes (no dangerouslySetInnerHTML),
          so React's built-in escaping prevents XSS automatically. */}
      {pendingEgress && (
        <div className="ai-egress-confirm" data-testid="ai-egress-confirm" role="alertdialog" aria-modal="true">
          <div className="ai-egress-confirm-header">
            <AlertCircle size={14} aria-hidden="true" />
            <span>{t('ai.egress.confirmTitle')}</span>
          </div>
          <p className="ai-egress-confirm-action">
            {pendingEgress.toolName === 'web_search' || pendingEgress.toolName === 'WebSearch'
              ? t('ai.egress.action.webSearch')
              : pendingEgress.toolName === 'web_fetch' || pendingEgress.toolName === 'WebFetch'
                ? t('ai.egress.action.webFetch')
                : t('ai.egress.action.externalTool')}
            {pendingEgress.query && (
              // LLM-sourced string: rendered as a React text node — no dangerouslySetInnerHTML.
              // React auto-escapes text nodes, so XSS is prevented without manual escaping.
              <span className="ai-egress-confirm-detail">{pendingEgress.query}</span>
            )}
            {!pendingEgress.query && pendingEgress.url && (
              <span className="ai-egress-confirm-detail">{pendingEgress.url}</span>
            )}
          </p>
          <div className="ai-egress-confirm-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="ai-egress-confirm-allow"
              onClick={handleEgressApprove}
            >
              {t('ai.egress.confirmAllow')}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="ai-egress-confirm-deny"
              onClick={handleEgressDeny}
            >
              {t('ai.egress.confirmDeny')}
            </button>
          </div>
        </div>
      )}
      {/* Input field — pinned at the panel bottom along with status/chips/egress, all
          outside .ai-body so they remain visible regardless of message scroll position. */}
      <div className="ai-input-area">
        <textarea
          ref={textareaRef}
          className="ai-input"
          data-testid="ai-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('ai.panel.placeholder')}
          rows={1}
          disabled={isStreaming}
        />
        <button
          className="btn-icon ai-send-btn"
          onClick={() => sendMessage()}
          disabled={isStreaming || !input.trim()}
          title={t('ai.panel.send')}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  )
}
