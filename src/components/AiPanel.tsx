/**
 * AI panel — right sidebar with a chat interface.
 * Includes onboarding, privacy dialog, and contextual chips.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Plus, Send, Square, Sparkles, Loader2, ShieldCheck, Key, ExternalLink, History, Trash2, Mail, FolderOpen, AlertCircle } from 'lucide-react'
import { normalizeMailrefs } from '../utils/normalizeMailrefs'
import { singleFlightInvoke } from '../utils/ipcSingleFlight'
import AiActionConfirmation, { type PendingActionSummary } from './AiActionConfirmation'

// --- Types ---

export type EgressPolicy = 'default-deny' | 'ask' | 'allow'

/** Payload from the `ai:internet-tool-pending` IPC event (§3.10 P2). */
type InternetToolPending = {
  requestId: string
  toolName: string
  query?: string
  url?: string
  args?: unknown
}

type MessageRef = { accountId: number; folder: string; uid: number }
type AiSource = { ref: MessageRef; reason?: string; subject?: string; from?: string; date?: string }

type AiStreamEvent =
  | { type: 'text_delta'; requestId: string; text: string }
  | { type: 'tool_use_start'; requestId: string; toolName: string; toolInput: unknown }
  | { type: 'tool_use_end'; requestId: string; toolName: string; result: string }
  | { type: 'thinking'; requestId: string; text: string }
  | { type: 'result'; requestId: string; text: string; sessionId: string; costUsd?: number; sources?: AiSource[] }
  | { type: 'error'; requestId: string; message: string }
  // §2.51.f2 — non-error interruption notice (mirrors `AiStreamNoticeCode` in
  // electron/services/ai.ts). The main process has no i18next instance, so it
  // sends a machine-readable `code` plus an English `message` fallback and the
  // renderer localizes the known codes.
  | { type: 'notice'; requestId: string; code: 'request_budget_exceeded'; message: string }
  | { type: 'status'; requestId: string; status: 'thinking' | 'using_tool' | 'streaming' | 'done' }

type AuthStatus =
  | { status: 'authenticated'; email?: string }
  | { status: 'not_configured' }
  | { status: 'invalid_key' }
  | { status: 'no_subscription' }
  | { status: 'error'; message: string }

type AiMessage = {
  role: 'user' | 'assistant'
  content: string
  sources?: AiSource[]
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
  /**
   * §3.10 P2 outbound egress policy. Used for the Shield icon tooltip label.
   * Defaults to `'default-deny'` to match the backend's `defaultEgressPolicy()`.
   */
  aiEgressPolicy?: EgressPolicy
  onSettingsChange?: (key: string, value: unknown) => void
  onOpenSource?: (ref: MessageRef) => void | Promise<void>
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
  aiEgressPolicy = 'default-deny',
  onSettingsChange,
  onOpenSource,
  quickPrompt,
  onQuickPromptHandled,
}: AiPanelProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
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
  const streamingTextRef = useRef('')
  // Forward ref to sendMessage so handleApplyPendingAction (declared above
  // sendMessage to keep the wiring readable) can nudge the AI without a
  // circular `useCallback` dep. sendMessage assigns into this ref each render.
  const sendMessageRef = useRef<((text?: string) => void) | null>(null)

  // Keep ref in sync with state for use inside callbacks
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])

  // Prompt history (up/down arrow navigation, like in a terminal)
  const promptHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const draftRef = useRef('')

  // Session cost — sum of costUsd across all assistant messages
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
        { role: 'assistant', content: `**${t('ai.errors.errorPrefix')}:** ${String((e as Error).message ?? e)}` },
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
      return
    }
    void (async () => {
      try {
        // Pass aiProvider explicitly — avoids race condition when saving settings.
        // Routed through singleFlightInvoke to coalesce duplicate fires during
        // cold start (AiPanel open-effect + aiProvider-settle effect +
        // StrictMode double-invoke in dev). §1.4 renderer dedup.
        const status = await singleFlightInvoke<AuthStatus>('ai:checkAuth', [aiProvider])
        setAuthStatus(status)
      } catch {
        setAuthStatus({ status: 'error', message: t('ai.errors.authCheck') })
      }
    })()
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

      switch (event.type) {
        case 'text_delta':
          streamingTextRef.current += event.text
          setMessages(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: streamingTextRef.current }
            }
            return next
          })
          break

        case 'tool_use_start':
          setStreamStatus(t('ai.panel.usingTool', { tool: event.toolName.replace('mcp__mailcopilot__', '') }))
          break

        case 'tool_use_end': {
          // Tool use status is shown in the status bar, not inline.
          // §3.10 P0: any preview tool may have just registered a new
          // pending action. Refresh from main on every tool_use_end —
          // it's a synchronous map iteration in the registry, so the cost
          // is trivial and we never go stale.
          const stripped = event.toolName.replace('mcp__mailcopilot__', '')
          if (stripped.startsWith('preview_') || stripped.endsWith('_preview') || stripped.startsWith('apply_') || stripped.endsWith('_apply')) {
            void refreshPendingActions()
          }
          break
        }

        case 'status':
          if (event.status === 'thinking') setStreamStatus(t('ai.panel.thinking'))
          else if (event.status === 'streaming') setStreamStatus(t('ai.panel.streaming'))
          else if (event.status === 'done') {
            setIsStreaming(false)
            setStreamStatus(null)
            setCurrentRequestId(null)
          }
          break

        case 'result':
          // sessionId from Claude SDK is persisted via updateAiSessionClaudeId in main.ts
          // Final text is already in the message via text_delta
          setMessages(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                ...(event.sources && event.sources.length > 0 ? { sources: event.sources } : {}),
                costUsd: event.costUsd ?? null,
              }
            }
            return next
          })
          setIsStreaming(false)
          setStreamStatus(null)
          setCurrentRequestId(null)
          // Persist assistant message and maybe generate title
          {
            const sid = activeSessionIdRef.current
            const assistantText = event.text
            if (sid && assistantText) {
              void (async () => {
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
              })()
            }
          }
          break

        // §2.51.f2 — the request was cut short for a known, non-error reason
        // (currently: the per-request cost ceiling). Appended as its own
        // assistant message AFTER the partial answer so the answer keeps its
        // cost badge. Unknown future codes fall back to the English message from
        // main rather than rendering nothing.
        case 'notice': {
          const noticeText = event.code === 'request_budget_exceeded'
            ? t('ai.errors.requestBudgetStopped')
            : event.message
          setMessages(prev => [...prev, { role: 'assistant', content: noticeText }])
          break
        }

        case 'error':
          setIsStreaming(false)
          setStreamStatus(null)
          setCurrentRequestId(null)
          setMessages(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant' && !last.content) {
              next[next.length - 1] = { ...last, content: `**${t('ai.errors.errorPrefix')}:** ${event.message}` }
            } else {
              next.push({ role: 'assistant', content: `**${t('ai.errors.errorPrefix')}:** ${event.message}` })
            }
            return next
          })
          break
      }
    }

    window.api.on('ai:stream', handler as (...args: unknown[]) => void)
    return () => {
      window.api.off('ai:stream', handler as (...args: unknown[]) => void)
    }
  }, [open, t, loadSessionList, refreshPendingActions])

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
    streamingTextRef.current = ''
    const reqId = nextRequestId()
    setCurrentRequestId(reqId)
    setIsStreaming(true)
    setStreamStatus(t('ai.panel.thinking'))

    setMessages(prev => [
      ...prev,
      { role: 'user', content: prompt },
      { role: 'assistant', content: '' },
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
      void window.api.invoke('ai:chat', reqId, prompt, contextType ? { type: contextType, data: contextData } : undefined, sid, aiProvider)
    })()
  }, [input, isStreaming, contextType, contextData, aiProvider, t])

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
      void window.api.invoke('ai:stop', currentRequestId)
      setIsStreaming(false)
      setStreamStatus(null)
      setCurrentRequestId(null)
    }
  }, [currentRequestId])

  // New chat
  const newChat = useCallback(() => {
    if (isStreaming) stopGeneration()
    setMessages([])
    setActiveSessionId(null)
    setShowSessionList(false)
    setPendingActions([])
    streamingTextRef.current = ''
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
      const msgs = await window.api.invoke('aiSession:messages', id) as Array<{ role: 'user' | 'assistant'; content: string; costUsd: number | null }>
      setMessages(msgs.map(m => ({ role: m.role, content: m.content, costUsd: m.costUsd })))
      setActiveSessionId(id)
      setShowSessionList(false)
      streamingTextRef.current = ''
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
        streamingTextRef.current = ''
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
      streamingTextRef.current = ''
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

  // Custom markdown link renderer for mailref:// protocol
  const markdownComponents = useMemo(() => ({
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
      if (href?.startsWith('mailref://')) {
        const path = href.slice('mailref://'.length)
        const firstSlash = path.indexOf('/')
        const lastSlash = path.lastIndexOf('/')
        if (firstSlash > 0 && lastSlash > firstSlash) {
          const accountId = Number(path.slice(0, firstSlash))
          const folder = decodeURIComponent(path.slice(firstSlash + 1, lastSlash))
          const uid = Number(path.slice(lastSlash + 1))
          if (accountId > 0 && folder && uid > 0) {
            return (
              <button
                type="button"
                className="ai-inline-mail-link"
                onClick={() => { void onOpenSource?.({ accountId, folder, uid }) }}
              >
                {children}
              </button>
            )
          }
        }
      }
      return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    },
  }), [onOpenSource])

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
            <button
              className="ai-onboarding-option"
              onClick={async () => {
                // Check CLI availability before switching to subscription.
                // Explicit user action — source: 'user' bypasses the result
                // cache but still joins any pending background request.
                try {
                  const result = await singleFlightInvoke<{ status: string; message?: string }>(
                    'ai:checkAuth',
                    ['subscription'],
                    { source: 'user' },
                  )
                  if (result.status === 'error') {
                    setAuthStatus({ status: 'error', message: result.message || 'CLI not found' })
                    return
                  }
                } catch (e) {
                  setAuthStatus({ status: 'error', message: String(e) })
                  return
                }
                onSettingsChange?.('aiProvider', 'subscription')
              }}
            >
              <Sparkles size={16} />
              <div>
                <strong>{t('ai.onboarding.subscription')}</strong>
                <small>{t('ai.onboarding.subscriptionHint')}</small>
              </div>
            </button>
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
    const errorKey = authStatus.status === 'invalid_key' ? 'invalidKey'
      : authStatus.status === 'no_subscription' ? 'noSubscription'
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
            <button className="btn btn-secondary" onClick={async () => {
              try {
                await window.api.invoke('ai:deleteApiKey')
                onSettingsChange?.('aiProvider', '')
                setAuthStatus({ status: 'not_configured' })
              } catch (e) {
                setAuthStatus({ status: 'error', message: String(e) })
              }
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
          {/* §3.10 P2: shield icon indicates egress is intercepted (policy ≠ allow) */}
          {aiEgressPolicy !== 'allow' && (
            <span
              className="btn-icon ai-egress-shield"
              data-testid="ai-egress-shield"
              title={t('ai.egress.shieldTooltip')}
              aria-label={t('ai.egress.shieldTooltip')}
            >
              <ShieldCheck size={14} />
            </span>
          )}
          <button
            className={`btn-icon${showSessionList ? ' active' : ''}`}
            onClick={() => setShowSessionList(prev => !prev)}
            title={t('ai.sessions.history')}
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
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                  urlTransform={(url) => url.startsWith('mailref://') ? url : defaultUrlTransform(url)}
                >
                  {normalizeMailrefs(msg.content || (isStreaming && i === messages.length - 1 ? '...' : ''))}
                </ReactMarkdown>
                {aiShowSources && msg.sources && msg.sources.length > 0 && (
                  <div className="ai-sources">
                    <div className="ai-sources-title">{t('ai.panel.sources')}</div>
                    <div className="ai-sources-list">
                      {msg.sources.map((src, idx) => (
                        <button
                          key={`${src.ref.accountId}:${src.ref.folder}:${src.ref.uid}:${idx}`}
                          type="button"
                          className="ai-source-link"
                          onClick={() => { void onOpenSource?.(src.ref) }}
                          title={src.subject ? `${src.from || ''} — ${src.subject}` : `${src.ref.folder}/${src.ref.uid}`}
                        >
                          <span className="ai-source-num">#{idx + 1}</span>
                          {src.subject
                            ? <span className="ai-source-subject">{src.subject}</span>
                            : <span className="ai-source-fallback">{src.ref.folder}/{src.ref.uid}</span>}
                          {src.from && <span className="ai-source-from">{src.from}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
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
