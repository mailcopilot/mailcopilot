// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type {
  ThreadSummary,
  ThreadSummaryGenerateRequest,
  ThreadSummaryResult,
} from '@mailcopilot/types'
import {
  useThreadSummary,
  THREAD_SUMMARY_MIN_MESSAGES,
  type ThreadSummaryMessageInput,
} from './useThreadSummary'

vi.mock('../sentry', () => ({
  captureException: vi.fn(),
}))
import { captureException } from '../sentry'

type GenerateFn = (req: ThreadSummaryGenerateRequest) => Promise<ThreadSummaryResult>

function makeSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadHash: 'hash-abc',
    oneLine: 'A one-line thread summary.',
    bullets: ['b1', 'b2', 'b3', 'b4', 'b5'],
    provider: 'anthropic-api',
    cached: false,
    wasLocal: false,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function makeMessages(n: number): ThreadSummaryMessageInput[] {
  return Array.from({ length: n }, (_, i) => ({
    folder: 'INBOX',
    uid: i + 1,
    messageId: `<msg-${i + 1}@example.com>`,
  }))
}

/**
 * Advance the debounce timer and drain the promise microtask queue so the
 * async generate() callback settles. Kept small and explicit because
 * @testing-library's waitFor uses real timers and deadlocks under fake ones.
 */
async function flush(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    // Two microtask turns: one for the awaited generate(), one for setState.
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('useThreadSummary', () => {
  it('is inert (active=false, no IPC) when the account toggle is OFF', () => {
    const generate = vi.fn<GenerateFn>()
    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: 1,
        messages: makeMessages(4),
        enabled: false,
        threadKey: '1:INBOX:1',
        generate,
      }),
    )
    expect(result.current.active).toBe(false)
    expect(result.current.status).toBe('idle')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(generate).not.toHaveBeenCalled()
  })

  it('is inert (active=false, no IPC) for threads shorter than the minimum', () => {
    const generate = vi.fn<GenerateFn>()
    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: 1,
        messages: makeMessages(THREAD_SUMMARY_MIN_MESSAGES - 1),
        enabled: true,
        threadKey: '1:INBOX:1',
        generate,
      }),
    )
    expect(result.current.active).toBe(false)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(generate).not.toHaveBeenCalled()
  })

  it('is inert when accountId is null', () => {
    const generate = vi.fn<GenerateFn>()
    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: null,
        messages: makeMessages(4),
        enabled: true,
        threadKey: '1:INBOX:1',
        generate,
      }),
    )
    expect(result.current.active).toBe(false)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(generate).not.toHaveBeenCalled()
  })

  it('debounces: fires generate exactly once after the debounce window', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: true, summary: makeSummary() })

    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: 7,
        messages: makeMessages(4),
        enabled: true,
        threadKey: '7:INBOX:1',
        debounceMs: 300,
        generate,
      }),
    )

    expect(result.current.status).toBe('loading')
    expect(generate).not.toHaveBeenCalled()

    // Advance only 200ms — still within the debounce window.
    act(() => { vi.advanceTimersByTime(200) })
    expect(generate).not.toHaveBeenCalled()

    // Cross the 300ms boundary — one fire.
    await flush(150)
    expect(generate).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledWith({
      accountId: 7,
      messages: [
        { folder: 'INBOX', uid: 1, messageId: '<msg-1@example.com>' },
        { folder: 'INBOX', uid: 2, messageId: '<msg-2@example.com>' },
        { folder: 'INBOX', uid: 3, messageId: '<msg-3@example.com>' },
        { folder: 'INBOX', uid: 4, messageId: '<msg-4@example.com>' },
      ],
    })
    expect(result.current.status).toBe('ready')
    expect(result.current.summary?.oneLine).toBe('A one-line thread summary.')
  })

  it('never sends body text — only folder/uid/messageId refs', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: true, summary: makeSummary() })

    renderHook(() =>
      useThreadSummary({
        accountId: 3,
        messages: makeMessages(3),
        enabled: true,
        threadKey: '3:INBOX:1',
        debounceMs: 100,
        generate,
      }),
    )

    await flush(100)

    const req = generate.mock.calls[0][0]
    for (const ref of req.messages) {
      expect(Object.keys(ref).sort()).toEqual(['folder', 'messageId', 'uid'])
    }
  })

  it('caps the refs it sends at 50 even for very long threads', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: true, summary: makeSummary() })

    renderHook(() =>
      useThreadSummary({
        accountId: 3,
        messages: makeMessages(80),
        enabled: true,
        threadKey: '3:INBOX:1',
        debounceMs: 100,
        generate,
      }),
    )

    await flush(100)

    expect(generate.mock.calls[0][0].messages).toHaveLength(50)
  })

  it('cache HIT resolves to ready with cached=true summary (no lingering loading)', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: true, summary: makeSummary({ cached: true }) })

    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: 1,
        messages: makeMessages(3),
        enabled: true,
        threadKey: '1:INBOX:1',
        debounceMs: 100,
        generate,
      }),
    )

    await flush(100)

    expect(result.current.status).toBe('ready')
    expect(result.current.summary?.cached).toBe(true)
  })

  it('budget refusal surfaces status=refused reason=budget without throwing', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: false, reason: 'budget' })

    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: 1,
        messages: makeMessages(3),
        enabled: true,
        threadKey: '1:INBOX:1',
        debounceMs: 100,
        generate,
      }),
    )

    await flush(100)

    expect(result.current.status).toBe('refused')
    expect(result.current.refusal).toBe('budget')
    expect(result.current.summary).toBeNull()
  })

  it('no_provider and provider_error refusals surface as refused', async () => {
    for (const reason of ['no_provider', 'provider_error'] as const) {
      const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: false, reason })
      const { result, unmount } = renderHook(() =>
        useThreadSummary({
          accountId: 1,
          messages: makeMessages(3),
          enabled: true,
          threadKey: `1:INBOX:${reason}`,
          debounceMs: 50,
          generate,
        }),
      )
      await flush(50)
      expect(result.current.status).toBe('refused')
      expect(result.current.refusal).toBe(reason)
      unmount()
    }
  })

  it('too_short and opt_out refusals leave the strip inert (idle, no message)', async () => {
    for (const reason of ['too_short', 'opt_out'] as const) {
      const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: false, reason })
      const { result, unmount } = renderHook(() =>
        useThreadSummary({
          accountId: 1,
          messages: makeMessages(3),
          enabled: true,
          threadKey: `1:INBOX:${reason}`,
          debounceMs: 50,
          generate,
        }),
      )
      await flush(50)
      expect(result.current.status).toBe('idle')
      expect(result.current.refusal).toBeNull()
      expect(result.current.summary).toBeNull()
      unmount()
    }
  })

  it('a thrown transport error degrades to provider_error and reports to Sentry', async () => {
    const generate = vi.fn<GenerateFn>().mockRejectedValue(new Error('ipc boom'))

    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: 1,
        messages: makeMessages(3),
        enabled: true,
        threadKey: '1:INBOX:1',
        debounceMs: 50,
        generate,
      }),
    )

    await flush(50)

    expect(result.current.status).toBe('refused')
    expect(result.current.refusal).toBe('provider_error')
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'useThreadSummary.generate' }),
    )
  })

  it('retry() re-runs generate for the current thread', async () => {
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce({ ok: false, reason: 'provider_error' })
      .mockResolvedValueOnce({ ok: true, summary: makeSummary() })

    const { result } = renderHook(() =>
      useThreadSummary({
        accountId: 1,
        messages: makeMessages(3),
        enabled: true,
        threadKey: '1:INBOX:1',
        debounceMs: 50,
        generate,
      }),
    )

    await flush(50)
    expect(result.current.refusal).toBe('provider_error')

    act(() => { result.current.retry() })
    await flush(50)

    expect(result.current.status).toBe('ready')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('switching threads mid-flight discards the stale response', async () => {
    let resolveFirst!: (r: ThreadSummaryResult) => void
    const generate = vi.fn<GenerateFn>()
      .mockImplementationOnce(() => new Promise<ThreadSummaryResult>(res => { resolveFirst = res }))
      .mockResolvedValueOnce({ ok: true, summary: makeSummary({ oneLine: 'SECOND thread summary' }) })

    const { result, rerender } = renderHook(
      (props: { threadKey: string }) =>
        useThreadSummary({
          accountId: 1,
          messages: makeMessages(3),
          enabled: true,
          threadKey: props.threadKey,
          debounceMs: 50,
          generate,
        }),
      { initialProps: { threadKey: '1:INBOX:first' } },
    )

    // Fire the first request (stays pending).
    await flush(50)

    // Switch threads — second request fires and resolves.
    rerender({ threadKey: '1:INBOX:second' })
    await flush(50)
    expect(result.current.summary?.oneLine).toBe('SECOND thread summary')

    // Now resolve the stale first request — it must NOT overwrite state.
    await act(async () => {
      resolveFirst({ ok: true, summary: makeSummary({ oneLine: 'STALE first summary' }) })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.summary?.oneLine).toBe('SECOND thread summary')
  })

  it('drops a stale response that resolves DURING the new thread\'s debounce window', async () => {
    // Regression for the race: thread A's generate resolves after the user
    // switched to thread B but BEFORE B's debounce timer fired (so B's run()
    // has not bumped the token yet). The old code bumped the token only inside
    // run(), leaving requestIdRef === A's captured token, so A's late response
    // slipped into B's view. Bumping the token synchronously on effect cleanup
    // closes the window.
    let resolveFirst!: (r: ThreadSummaryResult) => void
    const generate = vi.fn<GenerateFn>()
      .mockImplementationOnce(() => new Promise<ThreadSummaryResult>(res => { resolveFirst = res }))
      .mockResolvedValueOnce({ ok: true, summary: makeSummary({ oneLine: 'SECOND thread summary' }) })

    const { result, rerender } = renderHook(
      (props: { threadKey: string }) =>
        useThreadSummary({
          accountId: 1,
          messages: makeMessages(3),
          enabled: true,
          threadKey: props.threadKey,
          debounceMs: 300,
          generate,
        }),
      { initialProps: { threadKey: '1:INBOX:first' } },
    )

    // Fire thread A's request (stays pending).
    await flush(300)
    expect(generate).toHaveBeenCalledTimes(1)

    // Switch to thread B. B enters loading and schedules its 300ms debounce,
    // but the timer has NOT fired yet — B's run() has not bumped the token.
    rerender({ threadKey: '1:INBOX:second' })
    expect(result.current.status).toBe('loading')

    // A's generate resolves NOW, inside B's still-open debounce window.
    await act(async () => {
      resolveFirst({ ok: true, summary: makeSummary({ oneLine: 'STALE first summary' }) })
      await Promise.resolve()
      await Promise.resolve()
    })

    // A's stale summary must be discarded: still loading B, no thread-1 summary.
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()

    // Let B's debounce fire and resolve — only B's summary lands.
    await flush(300)
    expect(result.current.status).toBe('ready')
    expect(result.current.summary?.oneLine).toBe('SECOND thread summary')
  })

  it('regenerates when a message is appended to the SAME open thread', async () => {
    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce({ ok: true, summary: makeSummary({ oneLine: 'first pass' }) })
      .mockResolvedValueOnce({ ok: true, summary: makeSummary({ oneLine: 'after append' }) })

    const { result, rerender } = renderHook(
      (props: { messages: ThreadSummaryMessageInput[] }) =>
        useThreadSummary({
          accountId: 1,
          messages: props.messages,
          enabled: true,
          threadKey: '1:INBOX:1', // SAME thread throughout
          debounceMs: 100,
          generate,
        }),
      { initialProps: { messages: makeMessages(3) } },
    )

    await flush(100)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.current.summary?.oneLine).toBe('first pass')

    // A reply lands in the same open thread — membership changed (4 messages).
    rerender({ messages: makeMessages(4) })
    await flush(100)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1][0].messages).toHaveLength(4)
    expect(result.current.summary?.oneLine).toBe('after append')
  })

  it('does NOT regenerate on a re-render that only produces a new array reference', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: true, summary: makeSummary() })

    const { rerender } = renderHook(
      (props: { messages: ThreadSummaryMessageInput[] }) =>
        useThreadSummary({
          accountId: 1,
          messages: props.messages,
          enabled: true,
          threadKey: '1:INBOX:1',
          debounceMs: 100,
          generate,
        }),
      { initialProps: { messages: makeMessages(3) } },
    )

    await flush(100)
    expect(generate).toHaveBeenCalledTimes(1)

    // Same membership, brand-new array reference (identical folder/uid set).
    rerender({ messages: makeMessages(3) })
    await flush(100)

    // No refetch — the derived membership key is unchanged.
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('regenerates when different ref lists collide under a naive delimiter join (injective membership key)', async () => {
    // Regression: the old `${folder}:${uid}` + `,`-join membership key was not
    // injective. IMAP folder names can legitimately contain `:` and `,`, so two
    // DIFFERENT ref lists could serialize to the SAME string, swallowing a real
    // membership change and preventing the summary from regenerating (the exact
    // bug the membership key exists to fix).
    //
    // Both lists below share length 3 (≥ the minimum, so the strip is active)
    // and serialize BYTE-IDENTICALLY under the old naive join
    // ("3|x:1,y:2,z:3,w:4"): the `:` and `,` inside the folder names shift the
    // field boundaries without changing the flat string. Their structured
    // [folder, uid] tuples differ, so an injective key must produce DIFFERENT
    // signatures and trigger a second generate on the swap.
    const listA: ThreadSummaryMessageInput[] = [
      { folder: 'x', uid: 1, messageId: null },
      { folder: 'y:2,z', uid: 3, messageId: null },
      { folder: 'w', uid: 4, messageId: null },
    ] // naive join: "3|x:1,y:2,z:3,w:4"
    const listB: ThreadSummaryMessageInput[] = [
      { folder: 'x:1,y', uid: 2, messageId: null },
      { folder: 'z', uid: 3, messageId: null },
      { folder: 'w', uid: 4, messageId: null },
    ] // naive join: "3|x:1,y:2,z:3,w:4" — identical
    // Prove the collision the fix targets: the old naive join is byte-identical.
    const naiveJoin = (ms: ThreadSummaryMessageInput[]) =>
      `${ms.length}|${ms.map(m => `${m.folder}:${m.uid}`).join(',')}`
    expect(naiveJoin(listA)).toBe(naiveJoin(listB))

    const generate = vi.fn<GenerateFn>()
      .mockResolvedValueOnce({ ok: true, summary: makeSummary({ oneLine: 'list A' }) })
      .mockResolvedValueOnce({ ok: true, summary: makeSummary({ oneLine: 'list B' }) })

    const { result, rerender } = renderHook(
      (props: { messages: ThreadSummaryMessageInput[] }) =>
        useThreadSummary({
          accountId: 1,
          messages: props.messages,
          enabled: true,
          threadKey: '1:INBOX:1', // SAME thread throughout
          debounceMs: 100,
          generate,
        }),
      { initialProps: { messages: listA } },
    )

    await flush(100)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.current.summary?.oneLine).toBe('list A')

    // Swap to the colliding-under-old-join list. The injective JSON key differs,
    // so a second generate must fire.
    rerender({ messages: listB })
    await flush(100)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.current.summary?.oneLine).toBe('list B')
  })

  it('caps refs to the NEWEST 50 (slice(-50)) for over-cap threads', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue({ ok: true, summary: makeSummary() })

    renderHook(() =>
      useThreadSummary({
        accountId: 3,
        messages: makeMessages(80), // uids 1..80
        enabled: true,
        threadKey: '3:INBOX:1',
        debounceMs: 100,
        generate,
      }),
    )

    await flush(100)

    const sent = generate.mock.calls[0][0].messages
    expect(sent).toHaveLength(50)
    // Newest 50 = uids 31..80 (oldest 30 dropped), matching main's slice(-50).
    expect(sent[0].uid).toBe(31)
    expect(sent[sent.length - 1].uid).toBe(80)
  })
})
