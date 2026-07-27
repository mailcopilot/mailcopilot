import { useCallback, useRef, useState } from 'react'
import { captureException } from '../sentry'
import {
  hasRewritableText,
  type QuickActionPreset,
  type QuickActionRefusalReason,
  type QuickActionRequest,
  type QuickActionResult,
} from '../utils/quickActions'

/**
 * useQuickActions — B4 Compose Quick Actions (renderer side).
 *
 * Owns the request/refusal/preview state machine for the four rewrite presets
 * (Improve / Shorter / Formal / Grammar) in the Compose toolbar. Compose.tsx
 * stays thin: it renders buttons that call `run(preset)` and renders the diff
 * preview from this hook's `preview` state (CLAUDE.md §5 hotspot policy).
 *
 * Flow (single correct path over the declared IPC contract):
 * - The component calls `run(preset)` with the current draft text captured at
 *   click time. The hook fires `ai:quickAction:rewrite` with the RAW draft text
 *   and preset ID only — it NEVER builds a rewrite instruction (main maps the
 *   preset to a system prompt and wraps the untrusted draft with
 *   `wrapUntrusted()` before prompting).
 * - On success the rewritten text is held in `preview` alongside the original,
 *   and the component opens the diff-preview UI. NOTHING is written back to the
 *   draft body until the user explicitly chooses Replace or Insert — this hook
 *   never mutates the body itself (no auto-substitution invariant).
 * - Refusals are surfaced as structured state (`refusal`), never thrown, so
 *   budget/no-provider/provider-error/empty-input render graceful inline copy
 *   in the toolbar rather than a crash.
 *
 * A monotonic request token drops any stale in-flight rewrite (user clicked a
 * second preset before the first resolved) so a late response can't overwrite
 * the current one.
 */

export type QuickActionStatus = 'idle' | 'loading' | 'ready' | 'refused'

/** The material the diff-preview UI renders: the before/after text pair. */
export type QuickActionPreview = {
  preset: QuickActionPreset
  /** The draft text as it was when the rewrite was requested. */
  original: string
  /** The model's rewritten text. */
  rewritten: string
}

export type UseQuickActionsParams = {
  /** Account authoring the draft; `null` disables the toolbar (no account). */
  accountId: number | null
  /**
   * Injectable IPC runner (tests). Defaults to the whitelisted
   * `ai:quickAction:rewrite` channel.
   */
  rewrite?: (req: QuickActionRequest) => Promise<QuickActionResult>
}

export type UseQuickActionsResult = {
  status: QuickActionStatus
  /** Preset currently being processed (for per-button spinner), else null. */
  activePreset: QuickActionPreset | null
  /** Before/after pair when `status === 'ready'`, else null. */
  preview: QuickActionPreview | null
  /** Refusal reason when `status === 'refused'`, else null. */
  refusal: QuickActionRefusalReason | null
  /**
   * Fire a rewrite for `preset` against `text` (the current draft body,
   * captured by the caller at click time). No-op when there is no account or
   * the text has nothing to rewrite (surfaces `empty_input` instead).
   */
  run: (preset: QuickActionPreset, text: string) => void
  /** Dismiss the diff preview / refusal and return to idle. */
  dismiss: () => void
}

/** Default IPC runner — invokes the whitelisted `ai:quickAction:rewrite` channel. */
async function defaultRewrite(req: QuickActionRequest): Promise<QuickActionResult> {
  return (await window.api.invoke('ai:quickAction:rewrite', req)) as QuickActionResult
}

export function useQuickActions({
  accountId,
  rewrite = defaultRewrite,
}: UseQuickActionsParams): UseQuickActionsResult {
  const [status, setStatus] = useState<QuickActionStatus>('idle')
  const [activePreset, setActivePreset] = useState<QuickActionPreset | null>(null)
  const [preview, setPreview] = useState<QuickActionPreview | null>(null)
  const [refusal, setRefusal] = useState<QuickActionRefusalReason | null>(null)

  const rewriteRef = useRef(rewrite)
  rewriteRef.current = rewrite

  // Monotonic token so a stale rewrite (second preset clicked mid-flight)
  // cannot overwrite the current preview/refusal.
  const requestIdRef = useRef(0)

  const run = useCallback((preset: QuickActionPreset, text: string) => {
    if (typeof accountId !== 'number') return

    // Gate empty drafts client-side: surface the refusal without an IPC call so
    // we never burn budget on a whitespace-only body.
    if (!hasRewritableText(text)) {
      setActivePreset(null)
      setPreview(null)
      setRefusal('empty_input')
      setStatus('refused')
      return
    }

    const requestId = ++requestIdRef.current
    setActivePreset(preset)
    setPreview(null)
    setRefusal(null)
    setStatus('loading')

    void (async () => {
      try {
        const result = await rewriteRef.current({ accountId, preset, text })
        if (requestId !== requestIdRef.current) return

        if (result.ok) {
          setPreview({ preset, original: text, rewritten: result.rewritten })
          setRefusal(null)
          setStatus('ready')
        } else {
          setPreview(null)
          setRefusal(result.reason)
          setStatus('refused')
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        // The contract promises structured refusals, so a throw is an
        // unexpected transport failure — degrade to provider_error and report.
        captureException(err, { source: 'useQuickActions.rewrite' })
        setPreview(null)
        setRefusal('provider_error')
        setStatus('refused')
      } finally {
        if (requestId === requestIdRef.current) setActivePreset(null)
      }
    })()
  }, [accountId])

  const dismiss = useCallback(() => {
    // Invalidate any in-flight rewrite so a late response can't re-open the
    // preview after the user dismissed it.
    requestIdRef.current++
    setStatus('idle')
    setActivePreset(null)
    setPreview(null)
    setRefusal(null)
  }, [])

  return { status, activePreset, preview, refusal, run, dismiss }
}
