// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUndoSystem, type UseUndoSystemParams } from './useUndoSystem'
import type { MailSummary } from '../../packages/net/types'

// Mock window.api
const mockInvoke = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
  writable: true,
})

function makeMail(uid: number, unread = false): MailSummary {
  return {
    accountId: 1, folder: 'INBOX', uid,
    subject: `s${uid}`, from: `u${uid}@test`, fromAddr: `u${uid}@test`,
    date: '2026-01-01T00:00:00Z', unread, flagged: false, hasAttachments: false,
  }
}

function makeParams(overrides?: Partial<ReturnType<typeof defaultParams>>) {
  return { ...defaultParams(), ...overrides }
}

function defaultParams() {
  return {
    currentFolder: 'INBOX',
    currentAccountIdRef: { current: 1 as number | null },
    removeManyFromUi: vi.fn(),
    bumpFolderUnreadPending: vi.fn(),
    clearPendingUnread: vi.fn(),
    setMails: vi.fn(),
    setError: vi.fn(),
    loadOutbox: vi.fn().mockResolvedValue(undefined),
    // §2.127: the hook now shares `presentedError`'s `Translate` (react-i18next's
    // branded TFunction), so a bare key->string stub needs the same cast the
    // canonical helper's own test uses. Behaviour is unchanged: only `t(key)` is
    // ever called here.
    t: vi.fn((key: string) => key) as unknown as UseUndoSystemParams['t'],
    // §2.7 iter2: epoch ref owned by the caller. Each test gets a fresh
    // counter starting at 0; tests that assert the bump increment it via
    // the hook's transitions, then read .current.
    pendingMoveEpochRef: { current: 0 },
  }
}

describe('useUndoSystem', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockInvoke.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moveWithUndo removes messages from UI and sets up undo', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    const msgs = [makeMail(1, true), makeMail(2)]
    act(() => result.current.moveWithUndo(1, msgs, 'INBOX', 'Trash', 'Удалено'))

    expect(params.removeManyFromUi).toHaveBeenCalledWith(msgs)
    expect(params.bumpFolderUnreadPending).toHaveBeenCalledWith(1, 'INBOX', -1)
    expect(params.bumpFolderUnreadPending).toHaveBeenCalledWith(1, 'Trash', 1)
    expect(result.current.undoInfo).not.toBeNull()
    expect(result.current.undoInfo!.label).toBe('Удалено')
    expect(result.current.undoCountdown).toBe(5)
  })

  it('after 5 seconds undo executes net:move', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    expect(result.current.undoInfo).not.toBeNull()

    act(() => { vi.advanceTimersByTime(5000) })
    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Trash', [1])
    expect(result.current.undoInfo).toBeNull()
  })

  it('handleUndo restores messages', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    const msgs = [makeMail(1, true)]
    act(() => result.current.moveWithUndo(1, msgs, 'INBOX', 'Trash', 'Del'))
    act(() => result.current.handleUndo())

    expect(params.setMails).toHaveBeenCalled()
    expect(params.bumpFolderUnreadPending).toHaveBeenCalledWith(1, 'INBOX', 1) // Restore
    expect(result.current.undoInfo).toBeNull()
    // net:move should NOT have been called
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('flushUndo immediately executes the move', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    act(() => result.current.flushUndo())

    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Trash', [1])
    expect(result.current.undoInfo).toBeNull()
  })

  it('clearSendUndo resets send undo', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.setSendUndoInfo({ id: 'q1', accountId: 1, sendAt: new Date(Date.now() + 10000).toISOString() }))
    expect(result.current.sendUndoInfo).not.toBeNull()

    act(() => result.current.clearSendUndo())
    expect(result.current.sendUndoInfo).toBeNull()
  })

  it('countdown decreases every second', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    expect(result.current.undoCountdown).toBe(5)

    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.undoCountdown).toBe(4)

    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.undoCountdown).toBe(3)
  })

  it('scheduleSendUndo sets up send undo with a timer', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    const sendAt = new Date(Date.now() + 5000).toISOString()
    act(() => result.current.scheduleSendUndo({ id: 'q1', accountId: 1, sendAt }))

    expect(result.current.sendUndoInfo).not.toBeNull()
    expect(result.current.sendUndoInfo!.id).toBe('q1')

    // After sendAt + 150ms — auto-clear
    act(() => { vi.advanceTimersByTime(5200) })
    expect(result.current.sendUndoInfo).toBeNull()
  })
})

// ─── §2.7: pendingAdd / pendingRemove IPC paths ───────────────────────────────

describe('useUndoSystem §2.7 — pending-UID suppression IPC calls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockInvoke.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moveWithUndo calls net:move:pendingAdd immediately for the moved UIDs', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))
    const msgs = [makeMail(10), makeMail(11)]

    act(() => result.current.moveWithUndo(1, msgs, 'INBOX', 'Trash', 'Del'))

    expect(mockInvoke).toHaveBeenCalledWith('net:move:pendingAdd', 1, 'INBOX', [10, 11])
  })

  it('moveWithUndo calls pendingAdd before the 5s undo timer fires', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(5)], 'INBOX', 'Trash', 'Del'))

    // pendingAdd is synchronous within the moveWithUndo call.
    const addCalls = mockInvoke.mock.calls.filter(c => c[0] === 'net:move:pendingAdd')
    expect(addCalls).toHaveLength(1)
    expect(addCalls[0]).toEqual(['net:move:pendingAdd', 1, 'INBOX', [5]])

    // net:move must NOT have been called yet.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('after 5s undo timer fires, pendingRemove is called in .finally (success path)', async () => {
    const params = makeParams()
    mockInvoke.mockResolvedValue(undefined) // net:move succeeds
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(3)], 'INBOX', 'Trash', 'Del'))
    await act(async () => { vi.advanceTimersByTime(5000) })
    // Flush pending promises.
    await act(async () => { await Promise.resolve() })

    expect(mockInvoke).toHaveBeenCalledWith('net:move:pendingRemove', 1, 'INBOX', [3])
  })

  it('after 5s undo timer fires, pendingRemove is called in .finally even when net:move rejects', async () => {
    const params = makeParams()
    // net:move rejects — pendingRemove must still fire (finally chain).
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:move') return Promise.reject(new Error('IMAP error'))
      return Promise.resolve(undefined)
    })
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(7)], 'INBOX', 'Trash', 'Del'))
    await act(async () => { vi.advanceTimersByTime(5000) })
    await act(async () => { await Promise.resolve() })

    const removeCalls = mockInvoke.mock.calls.filter(c => c[0] === 'net:move:pendingRemove')
    expect(removeCalls).toHaveLength(1)
    expect(removeCalls[0]).toEqual(['net:move:pendingRemove', 1, 'INBOX', [7]])
  })

  it('handleUndo calls pendingRemove immediately (no net:move)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(8), makeMail(9)], 'INBOX', 'Trash', 'Del'))
    mockInvoke.mockClear() // reset after pendingAdd

    act(() => result.current.handleUndo())

    // pendingRemove fired synchronously on undo.
    expect(mockInvoke).toHaveBeenCalledWith('net:move:pendingRemove', 1, 'INBOX', [8, 9])
    // net:move was NOT invoked — undo cancelled the deferred move.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('handleUndo does not call pendingRemove when there is no active undo (no-op guard)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.handleUndo())

    expect(mockInvoke).not.toHaveBeenCalledWith('net:move:pendingRemove', expect.anything(), expect.anything(), expect.anything())
  })

  it('flushUndo calls pendingRemove in .finally after net:move (success path)', async () => {
    const params = makeParams()
    mockInvoke.mockResolvedValue(undefined)
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(20)], 'INBOX', 'Trash', 'Del'))
    mockInvoke.mockClear()

    await act(async () => { result.current.flushUndo() })
    await act(async () => { await Promise.resolve() })

    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Trash', [20])
    expect(mockInvoke).toHaveBeenCalledWith('net:move:pendingRemove', 1, 'INBOX', [20])
  })

  it('flushUndo calls pendingRemove in .finally even when net:move rejects', async () => {
    const params = makeParams()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:move') return Promise.reject(new Error('SMTP error'))
      return Promise.resolve(undefined)
    })
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(21)], 'INBOX', 'Trash', 'Del'))
    mockInvoke.mockClear()

    await act(async () => { result.current.flushUndo() })
    await act(async () => { await Promise.resolve() })

    const removeCalls = mockInvoke.mock.calls.filter(c => c[0] === 'net:move:pendingRemove')
    expect(removeCalls).toHaveLength(1)
    expect(removeCalls[0]).toEqual(['net:move:pendingRemove', 1, 'INBOX', [21]])
  })

  it('second moveWithUndo flushes previous pending (calls pendingRemove for old batch)', async () => {
    const params = makeParams()
    mockInvoke.mockResolvedValue(undefined)
    const { result } = renderHook(() => useUndoSystem(params))

    // First move — starts pending for uid=1.
    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del1'))
    mockInvoke.mockClear()

    // Second move — flushes the first (calls net:move for uid=1, then in .finally pendingRemove for uid=1).
    await act(async () => {
      result.current.moveWithUndo(1, [makeMail(2)], 'INBOX', 'Trash', 'Del2')
      await Promise.resolve()
    })

    // Verify net:move for uid=1 was dispatched (flush) and new pendingAdd for uid=2.
    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Trash', [1])
    expect(mockInvoke).toHaveBeenCalledWith('net:move:pendingAdd', 1, 'INBOX', [2])
  })
})

// ─── §2.7 iter2: pendingMoveEpoch counter ─────────────────────────────────────
//
// The epoch counter exists so that renderer call sites that fetch list data
// over IPC (cache:inboxPage, cache:unifiedInboxPage, net:inboxSummaries,
// net:folderPage) can drop a stale response that was filtered against an
// older pending-move set than the renderer currently believes is active.
//
// Codex iter2 finding: filterPendingMoves on the main side only suppresses
// UIDs whose filter step happens AFTER pendingAdd. A response already in
// flight, or one whose filter step happened BEFORE the registry shifted,
// will arrive later and overwrite the current view with stale state. This
// test pins down the bump points so future drift is caught immediately.

describe('useUndoSystem §2.7 iter2 — pendingMoveEpoch counter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockInvoke.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('exposes a getPendingMoveEpoch() reader that returns the initial value (0)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))
    expect(result.current.getPendingMoveEpoch()).toBe(0)
  })

  it('moveWithUndo bumps the epoch (pending-move set grew)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    expect(params.pendingMoveEpochRef.current).toBe(0)
    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    expect(params.pendingMoveEpochRef.current).toBe(1)
    expect(result.current.getPendingMoveEpoch()).toBe(1)
  })

  it('handleUndo bumps the epoch (pending-move set shrank)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    expect(params.pendingMoveEpochRef.current).toBe(1)

    act(() => result.current.handleUndo())
    expect(params.pendingMoveEpochRef.current).toBe(2)
  })

  it('handleUndo with no active undo does NOT bump the epoch (no-op guard)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.handleUndo())
    expect(params.pendingMoveEpochRef.current).toBe(0)
  })

  it('flushUndo bumps the epoch (pending-move set settling)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    expect(params.pendingMoveEpochRef.current).toBe(1)

    act(() => result.current.flushUndo())
    expect(params.pendingMoveEpochRef.current).toBe(2)
  })

  it('flushUndo with no active undo does NOT bump the epoch', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.flushUndo())
    expect(params.pendingMoveEpochRef.current).toBe(0)
  })

  it('5s auto-fire bumps the epoch (suppression about to be released)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    expect(params.pendingMoveEpochRef.current).toBe(1)

    act(() => { vi.advanceTimersByTime(5000) })
    // moveWithUndo bump (1) + 5s timer bump (2) = 2.
    expect(params.pendingMoveEpochRef.current).toBe(2)
  })

  it('second moveWithUndo bumps twice (flush of previous + new pending)', async () => {
    const params = makeParams()
    mockInvoke.mockResolvedValue(undefined)
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del1'))
    expect(params.pendingMoveEpochRef.current).toBe(1)

    // Second move: internally flushes the first (bump #2) then registers new
    // pending (bump #3).
    await act(async () => {
      result.current.moveWithUndo(1, [makeMail(2)], 'INBOX', 'Trash', 'Del2')
      await Promise.resolve()
    })
    expect(params.pendingMoveEpochRef.current).toBe(3)
  })

  it('caller-supplied ref is shared (the hook does not allocate its own)', () => {
    // Sanity check: the same ref instance the caller passed in is the one the
    // hook bumps. Without this, App.tsx's setMails call sites would read a
    // different counter than the one the hook updates.
    const sharedRef = { current: 42 } // arbitrary non-zero starting point
    const params = makeParams({ pendingMoveEpochRef: sharedRef })
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    expect(sharedRef.current).toBe(43)
    expect(result.current.getPendingMoveEpoch()).toBe(43)
  })

  it('epoch is monotonic across an entire move/undo lifecycle', () => {
    const params = makeParams()
    const { result } = renderHook(() => useUndoSystem(params))

    const e0 = params.pendingMoveEpochRef.current
    act(() => result.current.moveWithUndo(1, [makeMail(1)], 'INBOX', 'Trash', 'Del'))
    const e1 = params.pendingMoveEpochRef.current
    act(() => result.current.handleUndo())
    const e2 = params.pendingMoveEpochRef.current

    expect(e1).toBeGreaterThan(e0)
    expect(e2).toBeGreaterThan(e1)
  })
})

// §2.127 — electron/ipc.ts prefixes every rejection that crosses the IPC
// boundary with a machine tag (`[mcerr:<key>] `). Both failure paths of this
// hook used to interpolate `String(e)` straight into a user-visible sentence,
// so the tag — and the third-party server text behind it — landed on screen.
describe('useUndoSystem §2.127 — error presentation', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockInvoke.mockClear()
    // The presentation helper keeps the raw value in DevTools on purpose;
    // silence it here so a failing expectation stays readable.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    consoleError.mockRestore()
  })

  it('shows the vocabulary sentence for a tagged net:move rejection, not the tag', async () => {
    const params = makeParams()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:move') {
        return Promise.reject(new Error("[mcerr:offline] Error invoking remote method 'net:move': AggregateError"))
      }
      return Promise.resolve(undefined)
    })
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(30)], 'INBOX', 'Trash', 'Del'))
    await act(async () => { vi.advanceTimersByTime(5000) })
    await act(async () => { await Promise.resolve() })

    expect(params.t).toHaveBeenCalledWith('app.errors.move', { error: 'app.errors.presented.offline' })
    // The `t` mock echoes its key, so setError sees the outer sentence only.
    const shown = (params.setError as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0])).join('\n')
    expect(shown).not.toContain('mcerr')
    expect(shown).not.toContain('AggregateError')
    // The raw value still reaches diagnostics.
    expect(consoleError).toHaveBeenCalled()
  })

  it('shows the vocabulary sentence for a tagged mail:cancelSend rejection', async () => {
    const params = makeParams()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'mail:cancelSend') {
        return Promise.reject(new Error('[mcerr:auth] 535 5.7.8 Username and Password not accepted'))
      }
      return Promise.resolve(undefined)
    })
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.setSendUndoInfo({ id: 'q9', accountId: 1, sendAt: new Date(Date.now() + 10000).toISOString() }))
    await act(async () => { await result.current.handleSendUndo() })

    expect(params.t).toHaveBeenCalledWith('app.errors.queue', { error: 'app.errors.presented.auth' })
    const shown = (params.setError as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0])).join('\n')
    expect(shown).not.toContain('mcerr')
    expect(shown).not.toContain('Username and Password')
  })

  it('falls back to the classifier when the rejection carries no tag', async () => {
    const params = makeParams()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:move') return Promise.reject(new Error('socket hang up ETIMEDOUT'))
      return Promise.resolve(undefined)
    })
    const { result } = renderHook(() => useUndoSystem(params))

    act(() => result.current.moveWithUndo(1, [makeMail(31)], 'INBOX', 'Trash', 'Del'))
    await act(async () => { vi.advanceTimersByTime(5000) })
    await act(async () => { await Promise.resolve() })

    expect(params.t).toHaveBeenCalledWith('app.errors.move', { error: 'app.errors.presented.timeout' })
  })
})
