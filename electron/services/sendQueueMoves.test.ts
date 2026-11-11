import { describe, expect, it } from 'vitest'
import {
  QUEUE_ROW_SENDING_REFUSAL,
  requestQueueReschedule,
  requestQueueSendNow,
  type SendQueueMoveDeps,
} from './sendQueueMoves'

type Status = 'queued' | 'sending' | 'failed' | 'sent' | 'canceled'

/**
 * An in-memory queue behind the dependency seam. Its writes copy the real SQL of
 * `rescheduleSendQueue` (packages/db): it accepts `queued`, `sending` and
 * `failed` rows and puts them back to `queued`. That permissiveness is the
 * point — the queue's own retry path relies on it — so a refusal seen below can
 * only come from the service, never from the store.
 */
function makeQueue(rows: Record<string, { accountId: number; status: Status }>) {
  const log = { writes: 0, notified: [] as number[], started: 0 }
  let nowMs = Date.parse('2026-11-07T12:00:00Z')
  const write = (id: string): boolean => {
    log.writes += 1
    const row = rows[id]
    if (!row || !['queued', 'sending', 'failed'].includes(row.status)) return false
    row.status = 'queued'
    return true
  }
  const deps: SendQueueMoveDeps = {
    getById: (id) => (rows[id] ? { ...rows[id] } : undefined),
    sendNow: write,
    reschedule: write,
    notifyChanged: (accountId) => { log.notified.push(accountId) },
    startProcessing: () => { log.started += 1 },
    now: () => nowMs,
  }
  return { rows, log, deps, setNow: (ms: number) => { nowMs = ms } }
}

const future = '2026-11-07T12:15:00.000Z'
const past = '2026-11-07T11:00:00.000Z'

describe.each([
  ['send now', (q: ReturnType<typeof makeQueue>, id: string) => requestQueueSendNow(q.deps, id)],
  ['reschedule', (q: ReturnType<typeof makeQueue>, id: string) => requestQueueReschedule(q.deps, id, future)],
])('%s', (_name, run) => {
  it('refuses a row that is being sent: status unchanged, nothing written, nobody told, no pass started', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'sending' } })
    expect(() => run(q, 'a')).toThrow(QUEUE_ROW_SENDING_REFUSAL)
    expect(q.rows.a.status).toBe('sending')
    expect(q.log).toEqual({ writes: 0, notified: [], started: 0 })
  })

  it('puts a failed row back to queued, tells the account and starts a pass when it is due', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'failed' } })
    run(q, 'a')
    expect(q.rows.a.status).toBe('queued')
    expect(q.log.writes).toBe(1)
    expect(q.log.notified).toEqual([7])
  })

  it('lets a queued row through', () => {
    const q = makeQueue({ a: { accountId: 3, status: 'queued' } })
    expect(() => run(q, 'a')).not.toThrow()
    expect(q.rows.a.status).toBe('queued')
    expect(q.log.notified).toEqual([3])
  })

  it('reports a missing row without touching anything', () => {
    const q = makeQueue({})
    expect(() => run(q, 'nope')).toThrow('Queue entry nope not found')
    expect(q.log).toEqual({ writes: 0, notified: [], started: 0 })
  })

  it('reports a write that changed nothing (a sent row) and announces nothing', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'sent' } })
    expect(() => run(q, 'a')).toThrow(/Cannot (send now|reschedule) for current status/)
    expect(q.rows.a.status).toBe('sent')
    expect(q.log.notified).toEqual([])
    expect(q.log.started).toBe(0)
  })

  it('is synchronous: nothing is awaited between reading the status and writing it', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'queued' } })
    const result = run(q, 'a') as unknown as { then?: unknown }
    expect(typeof result.then).not.toBe('function')
  })
})

describe('send now — starting the queue', () => {
  it('starts a pass and answers ok', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'failed' } })
    expect(requestQueueSendNow(q.deps, 'a')).toEqual({ ok: true })
    expect(q.log.started).toBe(1)
  })
})

describe('reschedule — starting the queue only when the new time has come', () => {
  it('a future time starts nothing and echoes the time', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'queued' } })
    expect(requestQueueReschedule(q.deps, 'a', future)).toEqual({ ok: true, sendAt: future })
    expect(q.log.started).toBe(0)
  })

  it('a time already past starts a pass', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'failed' } })
    expect(requestQueueReschedule(q.deps, 'a', past)).toEqual({ ok: true, sendAt: past })
    expect(q.log.started).toBe(1)
  })

  it('compares with the injected clock', () => {
    const q = makeQueue({ a: { accountId: 7, status: 'queued' } })
    q.setNow(Date.parse(future) + 1)
    requestQueueReschedule(q.deps, 'a', future)
    expect(q.log.started).toBe(1)
  })
})
