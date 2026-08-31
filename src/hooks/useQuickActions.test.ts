// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useQuickActions } from './useQuickActions'
import type { QuickActionRequest, QuickActionResult } from '../utils/quickActions'

vi.mock('../sentry', () => ({ captureException: vi.fn() }))
import { captureException } from '../sentry'

type RewriteFn = (req: QuickActionRequest) => Promise<QuickActionResult>

describe('useQuickActions', () => {
  it('surfaces a ready preview (original + rewritten) on success', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'Better text.', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('improve', 'raw text'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.preview).toEqual({
      preset: 'improve',
      original: 'raw text',
      rewritten: 'Better text.',
      sourceBody: 'raw text',
      replacement: 'Better text.',
    })
    expect(result.current.refusal).toBeNull()
    expect(rewrite).toHaveBeenCalledWith({ accountId: 1, preset: 'improve', text: 'raw text' })
  })

  it('sends ONLY the user\'s own text — never the quoted original or the signature', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'Sounds good.', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))
    const body = 'sounds good\n\nOn Mon, alice wrote:\n> Can you ship it?\n\n--\nSergey'

    act(() => result.current.run('formal', body))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(rewrite).toHaveBeenCalledWith({ accountId: 1, preset: 'formal', text: 'sounds good' })
    const sent = (rewrite as unknown as { mock: { calls: [QuickActionRequest][] } }).mock.calls[0][0].text
    expect(sent).not.toContain('> Can you ship it?')
    expect(sent).not.toContain('Sergey')
  })

  it('builds a replacement that keeps the quoted original and the signature byte-identical', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'Sounds good — shipping today.', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))
    const body = 'sounds good\n\nOn Mon, alice wrote:\n> Can you ship it?\n\n--\nSergey'

    act(() => result.current.run('improve', body))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.preview?.replacement).toBe(
      'Sounds good — shipping today.\n\nOn Mon, alice wrote:\n> Can you ship it?\n\n--\nSergey',
    )
    // The tail is not carried as its own field — `replacement` is the single
    // place it lives, so assert it survives verbatim inside that string.
    expect(result.current.preview?.replacement)
      .toContain('\n\nOn Mon, alice wrote:\n> Can you ship it?\n\n--\nSergey')
    // The "before" pane shows the own part only, not the whole field.
    expect(result.current.preview?.original).toBe('sounds good')
  })

  it('records the full body snapshot so the component can detect edits mid-flight', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'X', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))
    const body = 'draft\n\n--\nSergey'

    act(() => result.current.run('improve', body))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.preview?.sourceBody).toBe(body)
  })

  it('refuses with no_own_text (no IPC call) when the draft is only quoted material', () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('improve', '\n\nOn Mon, alice wrote:\n> Can you ship it?'))

    expect(result.current.status).toBe('refused')
    expect(result.current.refusal).toBe('no_own_text')
    expect(rewrite).not.toHaveBeenCalled()
  })

  it('refuses with no_own_text for a reply typed under the quote (v1 does not segment)', () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('improve', '\n\nOn Mon, alice wrote:\n> question?\n\nmy answer below'))

    expect(result.current.refusal).toBe('no_own_text')
    expect(rewrite).not.toHaveBeenCalled()
  })

  it('surfaces the too_long refusal verbatim from the backend', async () => {
    const rewrite: RewriteFn = vi.fn(async (): Promise<QuickActionResult> => ({ ok: false, reason: 'too_long' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('improve', 'a very long draft'))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('too_long')
  })

  it('gates an empty draft client-side with empty_input and no IPC call', () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('shorter', '   '))

    expect(result.current.status).toBe('refused')
    expect(result.current.refusal).toBe('empty_input')
    expect(rewrite).not.toHaveBeenCalled()
  })

  it('surfaces a structured refusal (never throws)', async () => {
    const rewrite: RewriteFn = vi.fn(async (): Promise<QuickActionResult> => ({ ok: false, reason: 'budget' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('formal', 'text'))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('budget')
    expect(result.current.preview).toBeNull()
  })

  it('degrades a thrown transport error to provider_error and reports it', async () => {
    const rewrite: RewriteFn = vi.fn(async () => { throw new Error('boom') })
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('grammar', 'text'))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('provider_error')
    expect(captureException).toHaveBeenCalled()
  })

  it('is inert when there is no account', () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: null, composeGeneration: 0, rewrite }))
    act(() => result.current.run('improve', 'text'))
    expect(result.current.status).toBe('idle')
    expect(rewrite).not.toHaveBeenCalled()
  })

  it('dismiss returns to idle and drops the preview', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))
    act(() => result.current.run('improve', 'text'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.dismiss())
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
  })

  it('drops a stale in-flight response when a newer preset supersedes it', async () => {
    let resolveFirst: (r: QuickActionResult) => void = () => {}
    const rewrite: RewriteFn = vi
      .fn<RewriteFn>()
      .mockImplementationOnce(() => new Promise<QuickActionResult>(res => { resolveFirst = res }))
      .mockImplementationOnce(async () => ({ ok: true as const, rewritten: 'second', provider: 'p' }))

    const { result } = renderHook(() => useQuickActions({ accountId: 1, composeGeneration: 0, rewrite }))

    act(() => result.current.run('improve', 'a'))
    act(() => result.current.run('shorter', 'b'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    // Resolve the stale first request AFTER the second already landed.
    act(() => resolveFirst({ ok: true as const, rewritten: 'first-STALE', provider: 'p' }))

    expect(result.current.preview?.rewritten).toBe('second')
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f-renderer iter2 — the state belongs to the DRAFT, not the window.
//
// The reset matters twice over here: `ComposeQuickActions` makes the three
// compose-AI machines dependent on each other (one busy machine disables the
// other two), and a provider that neither answers nor drops the connection
// leaves `status === 'loading'` forever. Without a reset on `compose:init`
// that one stuck request would disable the whole AI toolbar for every message
// the reused window goes on to write.
// ---------------------------------------------------------------------------
describe('useQuickActions — compose generation resets the machine', () => {
  type Props = { accountId: number | null; composeGeneration: number; rewrite: RewriteFn }

  it('frees a request that never answers, and drops its late reply', async () => {
    let resolveHung: (r: QuickActionResult) => void = () => {}
    const rewrite: RewriteFn = vi
      .fn<RewriteFn>()
      .mockImplementationOnce(() => new Promise<QuickActionResult>(res => { resolveHung = res }))

    const { result, rerender } = renderHook(
      (p: Props) => useQuickActions(p),
      { initialProps: { accountId: 1, composeGeneration: 0, rewrite } },
    )

    act(() => result.current.run('improve', 'my draft'))
    expect(result.current.status).toBe('loading')
    expect(result.current.activePreset).toBe('improve')

    // The window was reused for another message while the provider hung.
    rerender({ accountId: 1, composeGeneration: 1, rewrite })
    expect(result.current.status).toBe('idle')
    expect(result.current.activePreset).toBeNull()

    // The abandoned request finally answers — about the PREVIOUS message.
    act(() => resolveHung({ ok: true as const, rewritten: 'about the old mail', provider: 'p' }))
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
  })

  it('drops an open preview and a surfaced refusal on the new draft', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'Better.', provider: 'p' }))
    const { result, rerender } = renderHook(
      (p: Props) => useQuickActions(p),
      { initialProps: { accountId: 1, composeGeneration: 0, rewrite } },
    )

    act(() => result.current.run('improve', 'my draft'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    rerender({ accountId: 1, composeGeneration: 1, rewrite })
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
    expect(result.current.refusal).toBeNull()
  })

  it('keeps the preview while the SAME draft merely re-renders', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'Better.', provider: 'p' }))
    const { result, rerender } = renderHook(
      (p: Props) => useQuickActions(p),
      { initialProps: { accountId: 1, composeGeneration: 0, rewrite } },
    )

    act(() => result.current.run('improve', 'my draft'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    // Same generation: the body hydrating, a suggestion arriving late, any
    // parent re-render. None of those is a new message.
    rerender({ accountId: 1, composeGeneration: 0, rewrite })
    expect(result.current.status).toBe('ready')
    expect(result.current.preview?.rewritten).toBe('Better.')
  })
})
