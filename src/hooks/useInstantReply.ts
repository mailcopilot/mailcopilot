import { useCallback, useRef, useState } from 'react'
import { captureException } from '../sentry'
import type {
  InstantReplyDraft,
  InstantReplyRefusalReason,
  InstantReplyRequest,
  InstantReplyResult,
} from '../utils/quickActions'

/**
 * useInstantReply — B4 Instant Reply (renderer side).
 *
 * Owns the request/refusal/options state machine for the Instant Reply button
 * on the actively-open email card in ThreadView. The card component stays thin:
 * it renders a trigger that calls `generate(ref)` and renders the returned draft
 * options from this hook's `drafts` state (CLAUDE.md §5 hotspot policy).
 *
 * Flow (single correct path over the declared IPC contract):
 * - The component calls `generate(ref)` with a message REF (accountId + folder +
 *   uid) for the active/last message. The hook fires
 *   `ai:instantReply:generate` with the REF only — NEVER body text. Main fetches
 *   the canonical body from the local cache and wraps it with `wrapUntrusted()`
 *   before prompting (B2-style cache-poisoning defense, CLAUDE.md §5).
 * - On success 2–3 draft options are held in `drafts`; the component shows them.
 *   Selecting a draft prefills a NEW Compose via the existing `ui:openCompose`
 *   mechanism — this hook does NOT open Compose and NOTHING is sent
 *   automatically (no-auto-send invariant; the user still presses Send).
 * - Refusals are surfaced as structured state (`refusal`), never thrown, so
 *   budget/no-provider/provider-error render graceful inline copy.
 *
 * A monotonic request token drops any stale in-flight generate (thread switched
 * or button re-clicked mid-flight) so a late response can't overwrite the
 * current options.
 */

export type InstantReplyStatus = 'idle' | 'loading' | 'ready' | 'refused'

/** Message ref the hook sends; ThreadView derives it from the active card's MailSummary. */
export type InstantReplyMessageRef = {
  accountId: number
  folder: string
  uid: number
  messageId?: string | null
}

export type UseInstantReplyParams = {
  /**
   * Injectable IPC runner (tests). Defaults to the whitelisted
   * `ai:instantReply:generate` channel.
   */
  generate?: (req: InstantReplyRequest) => Promise<InstantReplyResult>
}

export type UseInstantReplyResult = {
  status: InstantReplyStatus
  /** Generated draft options when `status === 'ready'`, else empty. */
  drafts: InstantReplyDraft[]
  /** Refusal reason when `status === 'refused'`, else null. */
  refusal: InstantReplyRefusalReason | null
  /**
   * Generate draft options for `ref` (the active/last message of the open
   * thread). Re-invoking supersedes any in-flight request.
   */
  generate: (ref: InstantReplyMessageRef) => void
  /** Dismiss the options / refusal and return to idle (e.g. after a pick). */
  dismiss: () => void
}

/** Default IPC runner — invokes the whitelisted `ai:instantReply:generate` channel. */
async function defaultGenerate(req: InstantReplyRequest): Promise<InstantReplyResult> {
  return (await window.api.invoke('ai:instantReply:generate', req)) as InstantReplyResult
}

export function useInstantReply({
  generate = defaultGenerate,
}: UseInstantReplyParams = {}): UseInstantReplyResult {
  const [status, setStatus] = useState<InstantReplyStatus>('idle')
  const [drafts, setDrafts] = useState<InstantReplyDraft[]>([])
  const [refusal, setRefusal] = useState<InstantReplyRefusalReason | null>(null)

  const generateRef = useRef(generate)
  generateRef.current = generate

  // Monotonic token so a stale generate (thread switched / re-clicked
  // mid-flight) cannot overwrite the current options/refusal.
  const requestIdRef = useRef(0)

  const runGenerate = useCallback((ref: InstantReplyMessageRef) => {
    const requestId = ++requestIdRef.current
    setDrafts([])
    setRefusal(null)
    setStatus('loading')

    void (async () => {
      try {
        const result = await generateRef.current({
          accountId: ref.accountId,
          folder: ref.folder,
          uid: ref.uid,
          messageId: ref.messageId ?? null,
        })
        if (requestId !== requestIdRef.current) return

        if (result.ok) {
          setDrafts(result.drafts)
          setRefusal(null)
          setStatus('ready')
        } else {
          setDrafts([])
          setRefusal(result.reason)
          setStatus('refused')
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        captureException(err, { source: 'useInstantReply.generate' })
        setDrafts([])
        setRefusal('provider_error')
        setStatus('refused')
      }
    })()
  }, [])

  const dismiss = useCallback(() => {
    // Invalidate any in-flight generate so a late response can't re-open the
    // options after the user dismissed or picked one.
    requestIdRef.current++
    setStatus('idle')
    setDrafts([])
    setRefusal(null)
  }, [])

  return { status, drafts, refusal, generate: runGenerate, dismiss }
}
