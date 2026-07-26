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
    const { result } = renderHook(() => useQuickActions({ accountId: 1, rewrite }))

    act(() => result.current.run('improve', 'raw text'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.preview).toEqual({ preset: 'improve', original: 'raw text', rewritten: 'Better text.' })
    expect(result.current.refusal).toBeNull()
    expect(rewrite).toHaveBeenCalledWith({ accountId: 1, preset: 'improve', text: 'raw text' })
  })

  it('gates an empty draft client-side with empty_input and no IPC call', () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, rewrite }))

    act(() => result.current.run('shorter', '   '))

    expect(result.current.status).toBe('refused')
    expect(result.current.refusal).toBe('empty_input')
    expect(rewrite).not.toHaveBeenCalled()
  })

  it('surfaces a structured refusal (never throws)', async () => {
    const rewrite: RewriteFn = vi.fn(async (): Promise<QuickActionResult> => ({ ok: false, reason: 'budget' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, rewrite }))

    act(() => result.current.run('formal', 'text'))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('budget')
    expect(result.current.preview).toBeNull()
  })

  it('degrades a thrown transport error to provider_error and reports it', async () => {
    const rewrite: RewriteFn = vi.fn(async () => { throw new Error('boom') })
    const { result } = renderHook(() => useQuickActions({ accountId: 1, rewrite }))

    act(() => result.current.run('grammar', 'text'))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('provider_error')
    expect(captureException).toHaveBeenCalled()
  })

  it('is inert when there is no account', () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: null, rewrite }))
    act(() => result.current.run('improve', 'text'))
    expect(result.current.status).toBe('idle')
    expect(rewrite).not.toHaveBeenCalled()
  })

  it('dismiss returns to idle and drops the preview', async () => {
    const rewrite: RewriteFn = vi.fn(async () => ({ ok: true as const, rewritten: 'x', provider: 'p' }))
    const { result } = renderHook(() => useQuickActions({ accountId: 1, rewrite }))
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

    const { result } = renderHook(() => useQuickActions({ accountId: 1, rewrite }))

    act(() => result.current.run('improve', 'a'))
    act(() => result.current.run('shorter', 'b'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    // Resolve the stale first request AFTER the second already landed.
    act(() => resolveFirst({ ok: true as const, rewritten: 'first-STALE', provider: 'p' }))

    expect(result.current.preview?.rewritten).toBe('second')
  })
})
