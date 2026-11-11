import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAccountMeta = vi.hoisted(() => vi.fn())

vi.mock('../../packages/net/config', () => ({
  getAccountMeta: mockGetAccountMeta,
}))

import { saveAccountFenced } from './accountSaveFence'

type SaveInput = { id?: number; imap: { host: string; user: string } }
const input = (id: number | undefined, host = 'imap.example.test'): SaveInput => ({ id, imap: { host, user: 'anna@example.test' } })
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('saveAccountFenced', () => {
  const save = vi.fn(async (i: SaveInput) => ({ id: i.id ?? 99 }))

  beforeEach(() => {
    save.mockClear()
    mockGetAccountMeta.mockReset()
    mockGetAccountMeta.mockReturnValue({ imap: { host: 'imap.example.test', user: 'anna@example.test' } })
  })

  it('returns what the save returned, and passes the input through untouched', async () => {
    const given = { ...input(1), extra: 'kept' }
    await expect(saveAccountFenced(save, given)).resolves.toEqual({ id: 1 })
    expect(save).toHaveBeenCalledWith(given)
  })

  describe('the gate', () => {
    it('is called with the stored record of the id before the write', async () => {
      const order: string[] = []
      const gate = vi.fn(() => { order.push('gate') })
      await saveAccountFenced(async i => { order.push('save'); return { id: i.id ?? 0 } }, input(1), gate)
      expect(gate).toHaveBeenCalledWith({ imap: { host: 'imap.example.test', user: 'anna@example.test' } })
      expect(order).toEqual(['gate', 'save'])
    })

    it('is called with no record for a new account, and the store is not read', async () => {
      const gate = vi.fn()
      await saveAccountFenced(save, input(undefined), gate)
      expect(gate).toHaveBeenCalledWith(undefined)
      expect(mockGetAccountMeta).not.toHaveBeenCalled()
    })

    it('refuses the save when it throws: nothing is written and a later save of the id still runs', async () => {
      await expect(saveAccountFenced(save, input(1), () => { throw new Error('refused') })).rejects.toThrow('refused')
      expect(save).not.toHaveBeenCalled()
      await expect(saveAccountFenced(save, input(1))).resolves.toEqual({ id: 1 })
    })

    it('refuses when the stored record cannot be read: a gate cannot judge what it cannot see', async () => {
      mockGetAccountMeta.mockImplementation(() => { throw new Error('store unreadable') })
      await expect(saveAccountFenced(save, input(1), vi.fn())).rejects.toThrow('store unreadable')
      expect(save).not.toHaveBeenCalled()
    })

    it('without a gate the store is not read at all', async () => {
      await saveAccountFenced(save, input(1))
      expect(mockGetAccountMeta).not.toHaveBeenCalled()
    })
  })

  describe('saves of one id run one after another', () => {
    function makeHold() {
      let running = 0
      let maxRunning = 0
      const trace: string[] = []
      const saves: Array<{ host: string; release: () => void; fail: (err: Error) => void }> = []
      const hold = vi.fn((i: SaveInput) => new Promise<{ id: number }>((resolve, reject) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        trace.push(`start:${i.imap.host}`)
        saves.push({
          host: i.imap.host,
          release: () => { running--; trace.push(`end:${i.imap.host}`); resolve({ id: i.id ?? 0 }) },
          fail: err => { running--; trace.push(`fail:${i.imap.host}`); reject(err) },
        })
      }))
      return { hold, saves, trace, maxRunning: () => maxRunning }
    }

    it('never has two saves of one id inside their write at once', async () => {
      const h = makeHold()
      const one = saveAccountFenced(h.hold, input(1, 'a'))
      const two = saveAccountFenced(h.hold, input(1, 'b'))
      const three = saveAccountFenced(h.hold, input(1, 'c'))
      await flush()
      expect(h.saves).toHaveLength(1)
      h.saves[0]!.release(); await one; await flush()
      expect(h.saves).toHaveLength(2)
      h.saves[1]!.release(); await two; await flush()
      h.saves[2]!.release(); await three
      expect(h.maxRunning()).toBe(1)
      expect(h.trace).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
    })

    it('runs the gate of the second save only after the first one settled, against the record it left', async () => {
      let record = 'x'
      mockGetAccountMeta.mockImplementation(() => ({ imap: { host: record, user: 'u' } }))
      const seen: string[] = []
      const h = makeHold()
      const one = saveAccountFenced(h.hold, input(1, 'a'))
      const two = saveAccountFenced(h.hold, input(1, 'b'), stored => { seen.push((stored as { imap: { host: string } }).imap.host) })
      await flush()
      expect(seen).toEqual([])
      record = 'a'
      h.saves[0]!.release(); await one; await flush()
      expect(seen).toEqual(['a'])
      h.saves[1]!.release(); await two
    })

    it('does not wedge the queue when a save rejects: the next one runs and the failure reaches only its own caller', async () => {
      const h = makeHold()
      const one = saveAccountFenced(h.hold, input(1, 'a'))
      const two = saveAccountFenced(save, input(1, 'b'))
      await flush()
      h.saves[0]!.fail(new Error('nope'))
      await expect(one).rejects.toThrow('nope')
      await expect(two).resolves.toEqual({ id: 1 })
    })

    it('does not wedge the queue when a save throws synchronously', async () => {
      const throwing = vi.fn(() => { throw new Error('sync') })
      const one = saveAccountFenced(throwing as never, input(1, 'a'))
      const two = saveAccountFenced(save, input(1, 'b'))
      await expect(one).rejects.toThrow('sync')
      await expect(two).resolves.toEqual({ id: 1 })
    })

    it('lets different ids go ahead without waiting for each other', async () => {
      const h = makeHold()
      const slow = saveAccountFenced(h.hold, input(1, 'a'))
      await flush()
      await expect(saveAccountFenced(save, input(2, 'b'))).resolves.toEqual({ id: 2 })
      h.saves[0]!.release(); await slow
    })

    it('starts a new account (no id) at once, however many saves of an id are queued', async () => {
      const h = makeHold()
      const slow = saveAccountFenced(h.hold, input(1, 'a'))
      await flush()
      await expect(saveAccountFenced(save, input(undefined, 'n'))).resolves.toEqual({ id: 99 })
      h.saves[0]!.release(); await slow
    })

    it('starts the first save of an id in the caller\'s own turn', () => {
      const pending = saveAccountFenced(save, input(1))
      expect(save).toHaveBeenCalledTimes(1)
      return pending
    })

    it('drops the queue entry once idle: a later save starts synchronously again', async () => {
      await saveAccountFenced(save, input(1))
      await flush()
      save.mockClear()
      const later = saveAccountFenced(save, input(1))
      expect(save).toHaveBeenCalledTimes(1)
      await later
    })
  })
})
