// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useCitations } from './useCitations'

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()
Object.defineProperty(window, 'api', { value: { invoke: mockInvoke, on: mockOn, off: mockOff }, writable: true, configurable: true })

const link = (t: string) => `[m](mailref://c/${t})`
const found = (token: string) => ({ token, status: 'found', subject: 's', from: 'f', date: 'd' })
const answer = (...tokens: string[]) => tokens.map(link).join(' ')

beforeEach(() => {
  mockInvoke.mockReset(); mockOn.mockReset(); mockOff.mockReset()
})

describe('useCitations', () => {
  it('asks main about the tickets of the answers, once, and exposes what it says', async () => {
    mockInvoke.mockResolvedValue([found('aaaaaaaa'), { token: 'bbbbbbbb', status: 'unknown' }])
    const answers = [answer('aaaaaaaa', 'bbbbbbbb')]
    const { result, rerender } = renderHook(({ a }) => useCitations('s1', a), { initialProps: { a: answers } })
    await waitFor(() => expect(result.current.citations.size).toBe(2))
    expect(mockInvoke).toHaveBeenCalledWith('ai:resolveCitations', { sessionId: 's1', tokens: ['aaaaaaaa', 'bbbbbbbb'] })
    expect(result.current.citations.get('aaaaaaaa')).toMatchObject({ status: 'found' })
    expect(result.current.citations.get('bbbbbbbb')).toMatchObject({ status: 'unknown' })
    rerender({ a: [...answers] }) // a new array with the same tickets does not ask again
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('asks only about tickets it has not asked about', async () => {
    mockInvoke.mockImplementation(async (_c: string, req: { tokens: string[] }) => req.tokens.map(found))
    const { result, rerender } = renderHook(({ a }) => useCitations('s1', a), { initialProps: { a: [answer('aaaaaaaa')] } })
    await waitFor(() => expect(result.current.citations.size).toBe(1))
    rerender({ a: [answer('aaaaaaaa', 'cccccccc')] })
    await waitFor(() => expect(result.current.citations.size).toBe(2))
    expect(mockInvoke).toHaveBeenLastCalledWith('ai:resolveCitations', { sessionId: 's1', tokens: ['cccccccc'] })
  })

  it('never asks without a session or without tickets', () => {
    renderHook(() => useCitations(null, [answer('aaaaaaaa')]))
    renderHook(() => useCitations('s1', ['no links here', '[x](mailref://1/INBOX/42)']))
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('a different chat starts from nothing and its answer is not mixed into the previous one', async () => {
    let release!: (v: unknown) => void
    mockInvoke.mockImplementationOnce(() => new Promise(r => { release = r }))
    const { result, rerender } = renderHook(({ sid }) => useCitations(sid, [answer('aaaaaaaa')]), { initialProps: { sid: 's1' } })
    mockInvoke.mockResolvedValueOnce([{ token: 'aaaaaaaa', status: 'unknown' }])
    rerender({ sid: 's2' })
    await waitFor(() => expect(result.current.citations.get('aaaaaaaa')).toMatchObject({ status: 'unknown' }))
    await act(async () => { release([found('aaaaaaaa')]) }) // the first chat's late answer
    expect(result.current.citations.get('aaaaaaaa')).toMatchObject({ status: 'unknown' })
  })

  it('a failed question leaves the tickets absent and is asked again when the answers change', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('ipc down'))
    const { result, rerender } = renderHook(({ a }) => useCitations('s1', a), { initialProps: { a: [answer('aaaaaaaa')] } })
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    expect(result.current.citations.size).toBe(0)
    mockInvoke.mockResolvedValueOnce([found('aaaaaaaa')])
    rerender({ a: [answer('aaaaaaaa', 'dddddddd')] })
    await waitFor(() => expect(result.current.citations.get('aaaaaaaa')).toBeDefined())
  })

  it('asks in batches of 100 (main refuses a bigger request): a chat with more tickets keeps every source', async () => {
    const tokens = Array.from({ length: 230 }, (_, i) => `${'abcdefghijklmnopqrstuvwxyz234567'[i % 32]}${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(i / 32) % 32]}aaaaaa`)
    mockInvoke.mockImplementation(async (_c: string, req: { tokens: string[] }) => req.tokens.map(found))
    // an answer carries at most 100 tickets, so a long chat is several answers
    const answers = [answer(...tokens.slice(0, 100)), answer(...tokens.slice(100, 200)), answer(...tokens.slice(200))]
    const { result } = renderHook(() => useCitations('s1', answers))
    await waitFor(() => expect(result.current.citations.size).toBe(230))
    expect(mockInvoke.mock.calls.map(c => (c[1] as { tokens: string[] }).tokens.length)).toEqual([100, 100, 30])
  })

  it('a reply that misses some tickets, or is not a list, leaves them to be asked again', async () => {
    mockInvoke.mockResolvedValueOnce([found('aaaaaaaa')]) // 'bbbbbbbb' is missing from the reply
    const { result, rerender } = renderHook(({ a }) => useCitations('s1', a), { initialProps: { a: [answer('aaaaaaaa', 'bbbbbbbb')] } })
    await waitFor(() => expect(result.current.citations.get('aaaaaaaa')).toBeDefined())
    expect(result.current.citations.get('bbbbbbbb')).toBeUndefined()
    mockInvoke.mockResolvedValueOnce([found('bbbbbbbb')])
    rerender({ a: [answer('aaaaaaaa', 'bbbbbbbb', 'cccccccc')] })
    await waitFor(() => expect(result.current.citations.get('bbbbbbbb')).toBeDefined())

    mockInvoke.mockResolvedValueOnce('not a list')
    rerender({ a: [answer('aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd')] })
    await act(async () => { await Promise.resolve() })
    expect(result.current.citations.get('dddddddd')).toBeUndefined()
  })

  it('asks again after the mailbox list changes', async () => {
    mockInvoke.mockResolvedValue([found('aaaaaaaa')])
    renderHook(() => useCitations('s1', [answer('aaaaaaaa')]))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1))
    const onChanged = mockOn.mock.calls.find(c => c[0] === 'accounts:changed')![1] as () => void
    await act(async () => { onChanged() })
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2))
  })

  it('hands out the parsed tickets of an answer for the Sources list, from the cache of THIS chat', async () => {
    mockInvoke.mockResolvedValue([])
    const { result, rerender } = renderHook(({ sid }) => useCitations(sid, []), { initialProps: { sid: 's1' } })
    const text = `[a](mailref://c/aaaaaaaa)`
    expect(result.current.tokensOf(text)).toEqual(['aaaaaaaa'])
    expect(result.current.tokensOf(text)).toBe(result.current.tokensOf(text)) // cached within the chat
    const first = result.current.tokensOf(text)
    rerender({ sid: 's2' })
    expect(result.current.tokensOf(text)).not.toBe(first) // another chat starts with a cache of its own
  })

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useCitations('s1', []))
    const registered = mockOn.mock.calls.find(c => c[0] === 'accounts:changed')![1]
    unmount()
    expect(mockOff).toHaveBeenCalledWith('accounts:changed', registered)
  })
})
