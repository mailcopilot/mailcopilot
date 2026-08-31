import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Preload bridge tests, scoped to what §2.99 added: the `mail:openRef`
 * replay-on-subscribe buffer (review M1) and the whitelist invariant it must
 * not weaken.
 *
 * `contextBridge.exposeInMainWorld` is captured instead of executed, so the
 * exposed object can be exercised directly without a renderer.
 */

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>()
  const exposed: { api?: Record<string, unknown> } = {}
  return {
    listeners,
    exposed,
    ipcRenderer: {
      on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        const arr = listeners.get(channel) ?? []
        arr.push(listener)
        listeners.set(channel, arr)
      }),
      off: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        const arr = listeners.get(channel) ?? []
        listeners.set(channel, arr.filter(l => l !== listener))
      }),
      removeAllListeners: vi.fn((channel: string) => { listeners.delete(channel) }),
      invoke: vi.fn(async () => undefined),
      send: vi.fn(),
    },
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, value: Record<string, unknown>) => {
        if (key === 'api') h_exposedSet(value)
      }),
    },
  }
  function h_exposedSet(value: Record<string, unknown>) { exposed.api = value }
})

vi.mock('electron', () => ({ ipcRenderer: h.ipcRenderer, contextBridge: h.contextBridge }))

type Api = {
  on: (channel: string, listener: (...args: unknown[]) => void) => void
  off: (channel: string, listener: (...args: unknown[]) => void) => void
  removeAll: (channel: string) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

async function loadPreload(): Promise<Api> {
  vi.resetModules()
  h.listeners.clear()
  h.exposed.api = undefined
  await import('./preload')
  return h.exposed.api as unknown as Api
}

/** Emit a main→renderer message on `channel`, as ipcRenderer would. */
function emit(channel: string, payload: unknown): void {
  for (const l of [...(h.listeners.get(channel) ?? [])]) l({}, payload)
}

const REF = { accountId: 1, folder: 'INBOX', uid: 42 }

describe('preload whitelist', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('accepts mail:openRef as a listen channel', async () => {
    const api = await loadPreload()
    expect(() => api.on('mail:openRef', () => {})).not.toThrow()
  })

  it('still refuses channels outside the whitelist', async () => {
    const api = await loadPreload()
    expect(() => api.on('mail:openRefX', () => {})).toThrow(/not allowed/)
    expect(() => api.off('totally:made-up', () => {})).toThrow(/not allowed/)
    expect(() => api.removeAll('totally:made-up')).toThrow(/not allowed/)
  })

  it('does not expose mail:openRef as an invoke channel', async () => {
    const api = await loadPreload()
    // Synchronous throw, before any round-trip is attempted.
    expect(() => api.invoke('mail:openRef')).toThrow(/not allowed/)
  })
})

describe('mail:openRef replay-on-subscribe (review M1)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('delivers a click that arrived before the renderer subscribed', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      emit('mail:openRef', REF) // main sends on did-finish-load, before React mounts

      const received: unknown[] = []
      api.on('mail:openRef', payload => received.push(payload))
      expect(received).toHaveLength(0) // replay is async, never re-entrant

      vi.runAllTimers()
      expect(received).toEqual([REF])
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays only once — a later subscriber gets no stale click', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      emit('mail:openRef', REF)

      const first: unknown[] = []
      api.on('mail:openRef', p => first.push(p))
      vi.runAllTimers()

      const second: unknown[] = []
      api.on('mail:openRef', p => second.push(p))
      vi.runAllTimers()

      expect(first).toEqual([REF])
      expect(second).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps only the last click when several arrive before a subscriber', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      emit('mail:openRef', { accountId: 1, folder: 'INBOX', uid: 1 })
      emit('mail:openRef', { accountId: 1, folder: 'INBOX', uid: 2 })

      const received: unknown[] = []
      api.on('mail:openRef', p => received.push(p))
      vi.runAllTimers()
      expect(received).toEqual([{ accountId: 1, folder: 'INBOX', uid: 2 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not buffer while a listener is attached — live events go straight through', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      const received: unknown[] = []
      const listener = (p: unknown) => received.push(p)
      api.on('mail:openRef', listener)
      vi.runAllTimers()

      emit('mail:openRef', REF)
      expect(received).toEqual([REF])

      // And nothing is replayed to a second subscriber afterwards.
      const late: unknown[] = []
      api.on('mail:openRef', p => late.push(p))
      vi.runAllTimers()
      expect(late).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes buffering after the last listener detaches', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      const listener = () => {}
      api.on('mail:openRef', listener)
      api.off('mail:openRef', listener)

      emit('mail:openRef', REF)
      const received: unknown[] = []
      api.on('mail:openRef', p => received.push(p))
      vi.runAllTimers()
      expect(received).toEqual([REF])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes buffering after removeAll (HMR teardown)', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      api.on('mail:openRef', () => {})
      api.removeAll('mail:openRef')

      emit('mail:openRef', REF)
      const received: unknown[] = []
      api.on('mail:openRef', p => received.push(p))
      vi.runAllTimers()
      expect(received).toEqual([REF])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hand the click to a listener that detached before the replay ran (review round 2, MEDIUM-1)', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      emit('mail:openRef', REF)

      const gone: unknown[] = []
      const shortLived = (p: unknown) => gone.push(p)
      api.on('mail:openRef', shortLived)
      api.off('mail:openRef', shortLived) // effect cleanup before the timer fires
      vi.runAllTimers()
      expect(gone).toEqual([])

      // The click was put back, so the next subscriber still gets it.
      const received: unknown[] = []
      api.on('mail:openRef', p => received.push(p))
      vi.runAllTimers()
      expect(received).toEqual([REF])
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the click to the replacement subscriber after an HMR swap', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      emit('mail:openRef', REF)

      const old: unknown[] = []
      const oldListener = (p: unknown) => old.push(p)
      api.on('mail:openRef', oldListener)
      // Swap: the replacement attaches before the scheduled replay fires.
      const fresh: unknown[] = []
      api.on('mail:openRef', p => fresh.push(p))
      api.off('mail:openRef', oldListener)

      vi.runAllTimers()
      expect(old).toEqual([])
      expect(fresh).toEqual([REF])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not buffer any other channel', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      emit('mail:exists', { accountId: 1 })

      const received: unknown[] = []
      api.on('mail:exists', p => received.push(p))
      vi.runAllTimers()
      expect(received).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives a listener that throws during replay', async () => {
    vi.useFakeTimers()
    try {
      const api = await loadPreload()
      emit('mail:openRef', REF)
      api.on('mail:openRef', () => { throw new Error('renderer blew up') })
      expect(() => vi.runAllTimers()).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
