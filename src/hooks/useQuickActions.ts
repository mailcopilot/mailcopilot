import { useCallback, useEffect, useRef, useState } from 'react'
import { applyComposeEdits, joinComposeBody, splitComposeBody, type ComposeBodySplit } from '@mailcopilot/core'
import { captureException } from '../sentry'
import {
  hasRewritableText,
  type ProofreadDisplayRefusal,
  type ProofreadEdit,
  type ProofreadRequest,
  type ProofreadResult,
  type QuickActionDisplayRefusal,
  type QuickActionPreset,
  type QuickActionRequest,
  type QuickActionResult,
} from '../utils/quickActions'

/**
 * useQuickActions — B4 Compose Quick Actions (renderer side).
 *
 * Owns the request/refusal/preview state machine for the four rewrite presets
 * (Improve / Shorter / Formal / Grammar) in the Compose toolbar. Compose.tsx
 * stays thin: it renders buttons that call `run(preset, body)` with the draft
 * body captured at click time, and renders the diff preview from this hook's
 * `preview` state (CLAUDE.md §5 hotspot policy).
 *
 * Flow (single correct path over the declared IPC contract):
 * - The component calls `run(preset)` with the current draft body captured at
 *   click time. The hook splits that body with `splitComposeBody()` and fires
 *   `ai:quickAction:rewrite` with the user's OWN part plus the preset ID only —
 *   never the quoted original, forwarded message or signature (§2.78), and
 *   never a rewrite instruction (main maps the preset to a system prompt and
 *   wraps the untrusted draft with `wrapUntrusted()` before prompting).
 * - On success the rewritten text is held in `preview` alongside the own part
 *   it replaces and a ready-made `replacement` (the rewrite spliced back in with
 *   the quoted / forwarded / signature tail verbatim — the tail is not kept as a
 *   separate field, nothing reads it and it can be a large string).
 *   The component opens the diff-preview UI. NOTHING is written
 *   back to the draft body until the user explicitly chooses Replace or Insert
 *   — this hook never mutates the body itself (no auto-substitution invariant).
 * - Refusals are surfaced as structured state (`refusal`), never thrown, so
 *   budget/no-provider/provider-error/empty-input/too-long/no-own-text render
 *   graceful inline copy in the toolbar rather than a crash.
 *
 * Two independent staleness guards, because they cover different accidents:
 * - a monotonic request token drops an in-flight rewrite superseded by a second
 *   PRESET click, so a late response can't overwrite the current one;
 * - `preview.sourceBody` records the exact body the rewrite was computed from,
 *   so the component can refuse to apply a replacement over a draft the user
 *   edited meanwhile (`isPreviewStale`, §2.78 AC-h). The token cannot see body
 *   edits, so the second guard is not redundant.
 */

export type QuickActionStatus = 'idle' | 'loading' | 'ready' | 'refused'

/** The material the diff-preview UI renders: the before/after text pair. */
export type QuickActionPreview = {
  preset: QuickActionPreset
  /**
   * The user's OWN text as it was when the rewrite was requested — the "before"
   * side of the diff. Excludes quoted/forwarded material and the signature.
   */
  original: string
  /** The model's rewritten text (the "after" side). */
  rewritten: string
  /**
   * The FULL draft body as it was at request time. Used only to detect that the
   * user edited the draft while the rewrite was in flight (`isPreviewStale`).
   */
  sourceBody: string
  /**
   * The full body to write on "Replace": the rewritten own part spliced back
   * into the original layout, with the quoted / forwarded / signature tail
   * byte-identical. Precomputed here so the component never has to reassemble a
   * body itself — and deliberately the ONLY place the tail is kept, since a
   * separate copy of it in this state would just be a second (potentially
   * large) retained string that nothing reads.
   */
  replacement: string
}

export type UseQuickActionsParams = {
  /** Account authoring the draft; `null` disables the toolbar (no account). */
  accountId: number | null
  /**
   * Generation of the compose form: a counter the window bumps on every
   * `compose:init`. See {@link COMPOSE_GENERATION_RESET_NOTE} — one rule, the
   * same key, for all three compose-AI machines. Required rather than
   * defaulted, so a new call site cannot silently opt out of the reset.
   */
  composeGeneration: number
  /**
   * Injectable IPC runner (tests). Defaults to the whitelisted
   * `ai:quickAction:rewrite` channel.
   */
  rewrite?: (req: QuickActionRequest) => Promise<QuickActionResult>
}

/**
 * COMPOSE_GENERATION_RESET_NOTE — why all three compose-AI hooks
 * (`useQuickActions`, `useProofread`, `useDraftTranslation`) reset on the same
 * key, and why the key is a generation counter.
 *
 * A `compose:init` means this form is now writing a DIFFERENT message. Anything
 * the previous one produced — an open review panel, a surfaced refusal, and
 * above all a request still in flight — belongs to that message and must go
 * with it; the request token is bumped so a late answer lands nowhere instead
 * of painting over the new draft.
 *
 * Not merely tidiness, because these three machines are no longer independent:
 * `ComposeQuickActions` reads all three to decide "this draft is occupied" and
 * disables the other two while any one of them is busy. A provider that neither
 * answers nor drops the connection leaves `status === 'loading'` forever, so
 * without this reset ONE stuck request would disable the whole AI toolbar for
 * every message the reused window goes on to write — recoverable only by
 * closing the window, which is neither discoverable nor free (the draft in
 * progress is autosaved, but the user does not know that).
 *
 * The key is a counter and NOT the draft's storage id: `draftId` resolves
 * asynchronously, well after the toolbar is interactive, so a click made in
 * that gap would be wiped by its arrival (see `useDraftTranslation` property 3
 * for the full statement of that defect).
 */

export type UseQuickActionsResult = {
  status: QuickActionStatus
  /** Preset currently being processed (for per-button spinner), else null. */
  activePreset: QuickActionPreset | null
  /** Before/after pair when `status === 'ready'`, else null. */
  preview: QuickActionPreview | null
  /** Refusal reason when `status === 'refused'`, else null. */
  refusal: QuickActionDisplayRefusal | null
  /**
   * Fire a rewrite for `preset` against `body` (the WHOLE current draft body,
   * captured by the caller at click time — the hook does the own/tail split).
   * No-op when there is no account; surfaces `empty_input` for an empty draft
   * and `no_own_text` when the draft is only quoted material / a signature.
   */
  run: (preset: QuickActionPreset, body: string) => void
  /** Dismiss the diff preview / refusal and return to idle. */
  dismiss: () => void
}

/** Default IPC runner — invokes the whitelisted `ai:quickAction:rewrite` channel. */
async function defaultRewrite(req: QuickActionRequest): Promise<QuickActionResult> {
  return (await window.api.invoke('ai:quickAction:rewrite', req)) as QuickActionResult
}

export function useQuickActions({
  accountId,
  composeGeneration,
  rewrite = defaultRewrite,
}: UseQuickActionsParams): UseQuickActionsResult {
  const [status, setStatus] = useState<QuickActionStatus>('idle')
  const [activePreset, setActivePreset] = useState<QuickActionPreset | null>(null)
  const [preview, setPreview] = useState<QuickActionPreview | null>(null)
  const [refusal, setRefusal] = useState<QuickActionDisplayRefusal | null>(null)

  const rewriteRef = useRef(rewrite)
  rewriteRef.current = rewrite

  // Monotonic token so a stale rewrite (second preset clicked mid-flight)
  // cannot overwrite the current preview/refusal.
  const requestIdRef = useRef(0)

  // A new draft is a new question — see COMPOSE_GENERATION_RESET_NOTE. Keyed on
  // `composeGeneration` and on nothing else; `activePreset` is cleared here too
  // because the `finally` that normally clears it is gated on the very token
  // this effect just invalidated.
  useEffect(() => {
    requestIdRef.current++
    setStatus('idle')
    setActivePreset(null)
    setPreview(null)
    setRefusal(null)
  }, [composeGeneration])

  const refuse = useCallback((reason: QuickActionDisplayRefusal) => {
    setActivePreset(null)
    setPreview(null)
    setRefusal(reason)
    setStatus('refused')
  }, [])

  const run = useCallback((preset: QuickActionPreset, body: string) => {
    if (typeof accountId !== 'number') return

    // Gate empty drafts client-side: surface the refusal without an IPC call so
    // we never burn budget on a whitespace-only body.
    if (!hasRewritableText(body)) {
      refuse('empty_input')
      return
    }

    // §2.78: only the user's own text is ever sent or replaced. The quoted
    // original, the forwarded message and the signature stay out of the prompt
    // AND out of the replacement.
    const split = splitComposeBody(body)
    const text = split.own
    if (!hasRewritableText(text)) {
      // The draft is nothing but quoted material / a signature (or the reply was
      // typed under the quote — see the v1 limitation in `composeBody.ts`).
      refuse('no_own_text')
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
          setPreview({
            preset,
            original: text,
            rewritten: result.rewritten,
            sourceBody: body,
            replacement: joinComposeBody(split, result.rewritten),
          })
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
  }, [accountId, refuse])

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

// ---------------------------------------------------------------------------
// §3.3 B7 — AI Proofread (per-edit corrector)
//
// Same family as the presets above and the same three invariants (own text
// only, structured refusals, nothing written back without an explicit click),
// but a different result shape: a LIST of individually acceptable edits instead
// of one rewritten string. That is why it is a separate hook and a separate
// channel rather than a fifth preset.
//
// What this hook does NOT do, on purpose:
//   - it does not re-derive the own/quote/signature boundary beyond calling
//     `splitComposeBody()` — that boundary is an ESTIMATE over flat text, and
//     on an unrecognized quoting style the whole body counts as "own" (§2.173).
//     No heuristics are layered on top of it here;
//   - it does not compute, adjust or re-anchor an offset. Main returns spans it
//     has already verified against the exact string this hook sent, and
//     `applyComposeEdits` skips (never clamps) anything that does not fit;
//   - it does not interpret, log or report `edit.message`. That string is
//     third-party free text and is display-only.
// ---------------------------------------------------------------------------

export type ProofreadStatus = 'idle' | 'loading' | 'ready' | 'refused'

/** The material the proofread review panel renders. */
export type ProofreadReview = {
  /**
   * The user's OWN text exactly as sent. Every edit's `offset` indexes into
   * THIS string, so it is what accepted edits are applied to.
   */
  own: string
  /**
   * The layout the own part was cut out of. Kept so an applied result can be
   * rejoined with the quoted original / forwarded message / signature byte for
   * byte (§2.78) without re-parsing a body that may have changed since.
   */
  split: ComposeBodySplit
  /**
   * The FULL draft body at request time. Used only to detect that the user
   * edited the draft while the check was in flight (`isPreviewStale`) — the
   * offsets point into the string that was sent, so ANY edit to the body
   * invalidates the whole list.
   */
  sourceBody: string
  /** Individually acceptable edits, ascending by offset and non-overlapping. */
  edits: readonly ProofreadEdit[]
  /**
   * How many model proposals main could not anchor in the draft and discarded.
   * Surfaced rather than swallowed: a silently shortened list looks like a
   * clean draft (§3.3 B7 AC-e).
   */
  dropped: number
}

export type UseProofreadParams = {
  accountId: number | null
  /**
   * Generation of the compose form — the same key, and the same rule, as the
   * two sibling machines. See {@link COMPOSE_GENERATION_RESET_NOTE}.
   */
  composeGeneration: number
  /** Injectable IPC runner (tests). Defaults to `ai:proofread:check`. */
  check?: (req: ProofreadRequest) => Promise<ProofreadResult>
}

export type UseProofreadResult = {
  status: ProofreadStatus
  /** Result of the last check when `status === 'ready'`, else null. */
  review: ProofreadReview | null
  refusal: ProofreadDisplayRefusal | null
  /** Ids of the edits the user has accepted so far. */
  accepted: ReadonlySet<string>
  /** Run a check over `body` (the WHOLE draft; the hook does the own/tail split). */
  run: (body: string) => void
  /** Accept / un-accept one edit by id. */
  toggleEdit: (id: string) => void
  /** Accept every edit currently offered. */
  acceptAll: () => void
  /**
   * The full draft body with ONLY the accepted edits applied, or `null` when
   * there is nothing to apply. Never mutates anything itself — the caller hands
   * the string to the parent's body setter (no auto-substitution invariant).
   */
  buildAcceptedBody: () => string | null
  /** Dismiss the panel / refusal and return to idle. */
  dismiss: () => void
}

const NO_ACCEPTED: ReadonlySet<string> = new Set<string>()

/** Default IPC runner — invokes the whitelisted `ai:proofread:check` channel. */
async function defaultCheck(req: ProofreadRequest): Promise<ProofreadResult> {
  return (await window.api.invoke('ai:proofread:check', req)) as ProofreadResult
}

export function useProofread({
  accountId,
  composeGeneration,
  check = defaultCheck,
}: UseProofreadParams): UseProofreadResult {
  const [status, setStatus] = useState<ProofreadStatus>('idle')
  const [review, setReview] = useState<ProofreadReview | null>(null)
  const [refusal, setRefusal] = useState<ProofreadDisplayRefusal | null>(null)
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(NO_ACCEPTED)

  const checkRef = useRef(check)
  checkRef.current = check

  // Monotonic token: a second click supersedes an in-flight check, so a late
  // response cannot re-open a panel the user already moved past.
  const requestIdRef = useRef(0)

  // A new draft is a new question — see COMPOSE_GENERATION_RESET_NOTE. The
  // accepted set goes too: acceptances are ids of edits computed against the
  // PREVIOUS message's text, and nothing in the new one can honour them.
  useEffect(() => {
    requestIdRef.current++
    setStatus('idle')
    setReview(null)
    setRefusal(null)
    setAccepted(NO_ACCEPTED)
  }, [composeGeneration])

  const refuse = useCallback((reason: ProofreadDisplayRefusal) => {
    setReview(null)
    setAccepted(NO_ACCEPTED)
    setRefusal(reason)
    setStatus('refused')
  }, [])

  const run = useCallback((body: string) => {
    if (typeof accountId !== 'number') return

    // Gate an empty draft locally so a whitespace-only body never costs a round
    // trip or budget. Main guards with `empty_input` too.
    if (!hasRewritableText(body)) {
      refuse('empty_input')
      return
    }

    // §2.78: only the user's own text is sent, and only it can be edited. Note
    // this split is a best-effort estimate, not a guarantee (§2.173) — main
    // re-runs it on what arrives and confines every returned span to its own
    // view of the own-region, which is the boundary that actually holds.
    const split = splitComposeBody(body)
    const own = split.own
    if (!hasRewritableText(own)) {
      refuse('no_own_text')
      return
    }

    const requestId = ++requestIdRef.current
    setReview(null)
    setRefusal(null)
    setStatus('loading')

    void (async () => {
      try {
        const result = await checkRef.current({ accountId, text: own })
        if (requestId !== requestIdRef.current) return

        if (result.ok) {
          const edits = Array.isArray(result.edits) ? result.edits : []
          setReview({
            own,
            split,
            sourceBody: body,
            edits,
            dropped: Number.isFinite(result.dropped) ? Math.max(0, Math.trunc(result.dropped)) : 0,
          })
          // §2.251: ids are content-derived, so an acceptance made before a
          // re-check survives it iff the very same fix is offered again. Any
          // acceptance that no longer matches an offered edit is dropped here —
          // it can never land on a different edit, because there is no position
          // to land on.
          setAccepted(prev => {
            const survivors = edits.filter(e => prev.has(e.id)).map(e => e.id)
            return survivors.length === 0 ? NO_ACCEPTED : new Set(survivors)
          })
          setRefusal(null)
          // `edits: []` is a SUCCESS — "no mistakes found" — not a refusal.
          setStatus('ready')
        } else {
          setReview(null)
          setAccepted(NO_ACCEPTED)
          setRefusal(result.reason)
          setStatus('refused')
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        // The contract promises structured refusals, so a throw is an
        // unexpected transport failure — degrade to provider_error and report.
        captureException(err, { source: 'useProofread.check' })
        setReview(null)
        setAccepted(NO_ACCEPTED)
        setRefusal('provider_error')
        setStatus('refused')
      }
    })()
  }, [accountId, refuse])

  const toggleEdit = useCallback((id: string) => {
    setAccepted(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const acceptAll = useCallback(() => {
    setAccepted(review ? new Set(review.edits.map(e => e.id)) : NO_ACCEPTED)
  }, [review])

  const buildAcceptedBody = useCallback((): string | null => {
    if (!review) return null
    const chosen = review.edits.filter(e => accepted.has(e.id))
    if (chosen.length === 0) return null
    // The tail (quote / forward / signature) is carried through verbatim; only
    // spans inside the own part are rewritten, and only the accepted ones.
    return joinComposeBody(review.split, applyComposeEdits(review.own, chosen))
  }, [review, accepted])

  const dismiss = useCallback(() => {
    requestIdRef.current++
    setStatus('idle')
    setReview(null)
    setRefusal(null)
    setAccepted(NO_ACCEPTED)
  }, [])

  return { status, review, refusal, accepted, run, toggleEdit, acceptAll, buildAcceptedBody, dismiss }
}
