// @vitest-environment jsdom
/**
 * §3.3 B7 — `useProofread` (declared in `useQuickActions.ts`, the compose-AI
 * hook module).
 *
 * What these tests pin down, in order of what would hurt most if it broke:
 *   - only the user's own text is ever sent (§2.78);
 *   - `ok: true, edits: []` is the "no mistakes" SUCCESS, not a refusal;
 *   - applying accepts a SUBSET and carries the quoted tail through verbatim;
 *   - an acceptance is keyed by a content-derived id (§2.251), so re-running
 *     the check keeps it iff the same fix is offered again and can never move
 *     it onto a different edit;
 *   - `dropped` is surfaced rather than swallowed;
 *   - every refusal is structural state, never a throw.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProofread } from './useQuickActions'
import type { ProofreadEdit, ProofreadRequest, ProofreadResult } from '../utils/quickActions'
import { composeEditId } from '../../packages/core'

vi.mock('../sentry', () => ({ captureException: vi.fn() }))
import { captureException } from '../sentry'

type CheckFn = (req: ProofreadRequest) => Promise<ProofreadResult>

function edit(over: Partial<ProofreadEdit> & Pick<ProofreadEdit, 'id' | 'offset' | 'length' | 'original' | 'replacement'>): ProofreadEdit {
  return { category: 'spelling', message: 'Fix it.', ...over }
}

/** `own` = "teh cat sat"; the rest is a signature that must never be touched. */
const BODY = 'teh cat sat\n\n--\nSergey'
const TEH = edit({ id: composeEditId({ offset: 0, length: 3, original: 'teh', replacement: 'the' }), offset: 0, length: 3, original: 'teh', replacement: 'the' })
const SAT = edit({ id: composeEditId({ offset: 8, length: 3, original: 'sat', replacement: 'slept' }), offset: 8, length: 3, original: 'sat', replacement: 'slept', category: 'wording' })

function okWith(edits: ProofreadEdit[], dropped = 0): CheckFn {
  return vi.fn(async () => ({ ok: true as const, edits, provider: 'p', dropped }))
}

describe('useProofread', () => {
  it('sends ONLY the user\'s own text — never the signature', async () => {
    const check = okWith([TEH])
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(check).toHaveBeenCalledWith({ accountId: 1, text: 'teh cat sat' })
    const sent = (check as unknown as { mock: { calls: [ProofreadRequest][] } }).mock.calls[0][0].text
    expect(sent).not.toContain('Sergey')
  })

  it('treats an empty edit list as SUCCESS ("no mistakes"), not a refusal', async () => {
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check: okWith([]) }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.refusal).toBeNull()
    expect(result.current.review?.edits).toEqual([])
  })

  it('surfaces the dropped count instead of silently shortening the list', async () => {
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check: okWith([TEH], 2) }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.review?.dropped).toBe(2)
  })

  it('applies ONLY the accepted edits and keeps the signature byte-identical', async () => {
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check: okWith([TEH, SAT]) }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.toggleEdit(TEH.id))

    // Only the accepted span moved; "sat" and the whole tail are untouched.
    expect(result.current.buildAcceptedBody()).toBe('the cat sat\n\n--\nSergey')
  })

  it('applies every edit after acceptAll', async () => {
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check: okWith([TEH, SAT]) }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.acceptAll())

    expect(result.current.accepted.size).toBe(2)
    expect(result.current.buildAcceptedBody()).toBe('the cat slept\n\n--\nSergey')
  })

  it('builds nothing when no edit was accepted (so the body is never rewritten identically)', async () => {
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check: okWith([TEH]) }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.buildAcceptedBody()).toBeNull()
  })

  it('un-accepts on a second toggle of the same edit', async () => {
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check: okWith([TEH]) }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.toggleEdit(TEH.id))
    act(() => result.current.toggleEdit(TEH.id))

    expect(result.current.accepted.has(TEH.id)).toBe(false)
    expect(result.current.buildAcceptedBody()).toBeNull()
  })

  it('§2.251: a re-check keeps an acceptance whose id survives and drops one that does not', async () => {
    // Second run offers TEH again (same content → same id) but replaces SAT
    // with a different proposal carrying a different id.
    const REPHRASED = edit({ id: 'e8-3-c', offset: 8, length: 3, original: 'sat', replacement: 'rested' })
    let call = 0
    const check: CheckFn = vi.fn(async () => ({
      ok: true as const,
      edits: call++ === 0 ? [TEH, SAT] : [TEH, REPHRASED],
      provider: 'p',
      dropped: 0,
    }))
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.acceptAll())
    expect(result.current.accepted.size).toBe(2)

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.review?.edits).toHaveLength(2))

    // The stale acceptance found nothing to match; it did NOT land on the new
    // proposal occupying the same span.
    expect(result.current.accepted.has(TEH.id)).toBe(true)
    expect(result.current.accepted.has(SAT.id)).toBe(false)
    expect(result.current.accepted.has(REPHRASED.id)).toBe(false)
    expect(result.current.buildAcceptedBody()).toBe('the cat sat\n\n--\nSergey')
  })

  it('refuses an empty draft locally, without an IPC call', () => {
    const check = okWith([])
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    act(() => result.current.run('   \n  '))

    expect(result.current.status).toBe('refused')
    expect(result.current.refusal).toBe('empty_input')
    expect(check).not.toHaveBeenCalled()
  })

  it('refuses with no_own_text when the draft is only quoted material', () => {
    const check = okWith([])
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    act(() => result.current.run('\n\nOn Mon, alice wrote:\n> Can you ship it?'))

    expect(result.current.refusal).toBe('no_own_text')
    expect(check).not.toHaveBeenCalled()
  })

  it('surfaces a backend refusal as state, keeping not_enabled distinct from no_provider', async () => {
    const check: CheckFn = vi.fn(async () => ({ ok: false as const, reason: 'not_enabled' as const }))
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('refused'))

    expect(result.current.refusal).toBe('not_enabled')
    expect(result.current.review).toBeNull()
  })

  it('degrades a transport throw to provider_error and reports it', async () => {
    const check: CheckFn = vi.fn(async () => { throw new Error('boom') })
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('refused'))

    expect(result.current.refusal).toBe('provider_error')
    expect(captureException).toHaveBeenCalled()
  })

  it('ignores a superseded in-flight check', async () => {
    let resolveFirst: ((r: ProofreadResult) => void) | null = null
    let call = 0
    const check: CheckFn = vi.fn(() => {
      if (call++ === 0) return new Promise<ProofreadResult>(res => { resolveFirst = res })
      return Promise.resolve({ ok: true as const, edits: [SAT], provider: 'p', dropped: 0 })
    })
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    act(() => result.current.run(BODY))
    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => resolveFirst?.({ ok: true, edits: [TEH], provider: 'p', dropped: 9 }))

    // The late first response must not overwrite the current review.
    expect(result.current.review?.edits).toEqual([SAT])
    expect(result.current.review?.dropped).toBe(0)
  })

  it('does nothing without an account', () => {
    const check = okWith([])
    const { result } = renderHook(() => useProofread({ accountId: null, composeGeneration: 0, check }))

    act(() => result.current.run(BODY))

    expect(result.current.status).toBe('idle')
    expect(check).not.toHaveBeenCalled()
  })

  it('clears review, refusal and acceptances on dismiss', async () => {
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check: okWith([TEH]) }))

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.acceptAll())
    act(() => result.current.dismiss())

    expect(result.current.status).toBe('idle')
    expect(result.current.review).toBeNull()
    expect(result.current.accepted.size).toBe(0)
  })

  it('drops_stale_acceptance_when_full_tuple_changes: different replacement on same span gets a different id and is not pre-accepted', async () => {
    // §2.251: edit identity is content-derived (offset+length+original+replacement).
    // If a re-check returns a different replacement for the same span, the new
    // edit has a DIFFERENT id, so the stale acceptance for the old edit must NOT
    // carry over to it — the user never reviewed the new proposal.
    //
    // What would break this: if composeEditId only encoded (offset, length) without
    // original/replacement, a re-check with a different replacement would silently
    // inherit the old acceptance.
    const DIFFERENT_REPLACEMENT = edit({
      // Same span and original as TEH (offset:0, length:3, original:'teh')
      // but replacement is 'thee' instead of 'the' — full tuple differs.
      id: composeEditId({ offset: 0, length: 3, original: 'teh', replacement: 'thee' }),
      offset: 0,
      length: 3,
      original: 'teh',
      replacement: 'thee',
    })

    let call = 0
    const check: CheckFn = vi.fn(async () => ({
      ok: true as const,
      edits: call++ === 0 ? [TEH] : [DIFFERENT_REPLACEMENT],
      provider: 'p',
      dropped: 0,
    }))
    const { result } = renderHook(() => useProofread({ accountId: 1, composeGeneration: 0, check }))

    // First run: accept TEH.
    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.toggleEdit(TEH.id))
    expect(result.current.accepted.has(TEH.id)).toBe(true)

    // Second run: re-check returns a different replacement for the same span.
    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.review?.edits).toHaveLength(1))

    // The new edit has a different id — the stale acceptance for TEH.id is gone
    // (TEH.id no longer appears in the new edit list) and DIFFERENT_REPLACEMENT
    // was never accepted by the user, so it must not be pre-accepted.
    expect(result.current.accepted.has(TEH.id)).toBe(false)
    expect(result.current.accepted.has(DIFFERENT_REPLACEMENT.id)).toBe(false)
    // Building the accepted body should return null (nothing accepted).
    expect(result.current.buildAcceptedBody()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f-renderer iter2 — the state belongs to the DRAFT, not the window.
//
// Same rule and same key as `useQuickActions` and `useDraftTranslation`. The
// acceptances go with it: every accepted id names an edit computed against the
// PREVIOUS message's text, and there is nothing in the new one for it to land
// on. And because the toolbar disables the other two actions while this one
// holds the draft, a check left hanging by a provider that never answers would
// otherwise keep the whole bar disabled across `compose:init`.
// ---------------------------------------------------------------------------
describe('useProofread — compose generation resets the machine', () => {
  type Props = { accountId: number | null; composeGeneration: number; check: CheckFn }

  it('frees a check that never answers, and drops its late reply', () => {
    let resolveHung: (r: ProofreadResult) => void = () => {}
    const check: CheckFn = vi
      .fn<CheckFn>()
      .mockImplementationOnce(() => new Promise<ProofreadResult>(res => { resolveHung = res }))

    const { result, rerender } = renderHook(
      (p: Props) => useProofread(p),
      { initialProps: { accountId: 1, composeGeneration: 0, check } },
    )

    act(() => result.current.run(BODY))
    expect(result.current.status).toBe('loading')

    rerender({ accountId: 1, composeGeneration: 1, check })
    expect(result.current.status).toBe('idle')

    act(() => resolveHung({ ok: true as const, edits: [TEH], provider: 'p', dropped: 0 }))
    expect(result.current.status).toBe('idle')
    expect(result.current.review).toBeNull()
  })

  it('drops the open panel AND the acceptances made against the old message', async () => {
    const check = okWith([TEH, SAT])
    const { result, rerender } = renderHook(
      (p: Props) => useProofread(p),
      { initialProps: { accountId: 1, composeGeneration: 0, check } },
    )

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.acceptAll())
    expect(result.current.accepted.size).toBe(2)

    rerender({ accountId: 1, composeGeneration: 1, check })
    expect(result.current.status).toBe('idle')
    expect(result.current.review).toBeNull()
    expect(result.current.refusal).toBeNull()
    expect(result.current.accepted.size).toBe(0)
    expect(result.current.buildAcceptedBody()).toBeNull()
  })

  it('keeps the panel while the SAME draft merely re-renders', async () => {
    const check = okWith([TEH])
    const { result, rerender } = renderHook(
      (p: Props) => useProofread(p),
      { initialProps: { accountId: 1, composeGeneration: 0, check } },
    )

    act(() => result.current.run(BODY))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.toggleEdit(TEH.id))

    rerender({ accountId: 1, composeGeneration: 0, check })
    expect(result.current.status).toBe('ready')
    expect(result.current.accepted.has(TEH.id)).toBe(true)
  })
})
