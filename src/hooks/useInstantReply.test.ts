// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useInstantReply } from './useInstantReply'
import type { InstantReplyRequest, InstantReplyResult } from '../utils/quickActions'

vi.mock('../sentry', () => ({ captureException: vi.fn() }))
import { captureException } from '../sentry'

type GenerateFn = (req: InstantReplyRequest) => Promise<InstantReplyResult>

const REF = { accountId: 1, folder: 'INBOX', uid: 42, messageId: '<m@x>' }

describe('useInstantReply', () => {
  it('surfaces generated draft options on success and sends a ref only (no body)', async () => {
    const generate: GenerateFn = vi.fn(async () => ({
      ok: true as const,
      drafts: [{ text: 'Sounds good.' }, { text: 'Let me check.', tone: 'Cautious' }],
    }))
    const { result } = renderHook(() => useInstantReply({ generate }))

    act(() => result.current.generate(REF))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.drafts).toHaveLength(2)
    expect(generate).toHaveBeenCalledWith({ accountId: 1, folder: 'INBOX', uid: 42, messageId: '<m@x>' })
    // Contract guard: the request payload never carries body text.
    const arg = (generate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(arg).sort()).toEqual(['accountId', 'folder', 'messageId', 'uid'])
  })

  it('surfaces a structured refusal (never throws)', async () => {
    const generate: GenerateFn = vi.fn(async (): Promise<InstantReplyResult> => ({ ok: false, reason: 'no_provider' }))
    const { result } = renderHook(() => useInstantReply({ generate }))
    act(() => result.current.generate(REF))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('no_provider')
    expect(result.current.drafts).toEqual([])
  })

  it('degrades a thrown transport error to provider_error and reports it', async () => {
    const generate: GenerateFn = vi.fn(async () => { throw new Error('boom') })
    const { result } = renderHook(() => useInstantReply({ generate }))
    act(() => result.current.generate(REF))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('provider_error')
    expect(captureException).toHaveBeenCalled()
  })

  it('dismiss clears options and returns to idle', async () => {
    const generate: GenerateFn = vi.fn(async () => ({ ok: true as const, drafts: [{ text: 'ok' }] }))
    const { result } = renderHook(() => useInstantReply({ generate }))
    act(() => result.current.generate(REF))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.dismiss())
    expect(result.current.status).toBe('idle')
    expect(result.current.drafts).toEqual([])
  })

  it('drops a stale in-flight response when a newer generate supersedes it', async () => {
    let resolveFirst: (r: InstantReplyResult) => void = () => {}
    const generate: GenerateFn = vi
      .fn<GenerateFn>()
      .mockImplementationOnce(() => new Promise<InstantReplyResult>(res => { resolveFirst = res }))
      .mockImplementationOnce(async () => ({ ok: true as const, drafts: [{ text: 'second' }] }))

    const { result } = renderHook(() => useInstantReply({ generate }))
    act(() => result.current.generate(REF))
    act(() => result.current.generate({ ...REF, uid: 43 }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => resolveFirst({ ok: true as const, drafts: [{ text: 'first-STALE' }] }))

    expect(result.current.drafts).toEqual([{ text: 'second' }])
  })
})
