import { describe, expect, it, vi } from 'vitest'
import {
  ABANDONED_SEND_FAILURE_TEXT,
  ABANDONED_SEND_STALE_MS,
  createSendQueueRecovery,
  type AbandonedSendRow,
  type SendQueueRecoveryDeps,
} from './sendQueueRecovery'
import { presentedTaggedText } from '../../src/utils/errorPresentation'
import { encodeErrorPresentation } from '@mailcopilot/core/errorPresentation'

function makeDeps(rowsPerCall: AbandonedSendRow[][], now = Date.parse('2026-11-13T12:00:00.000Z')) {
  const failAbandoned = vi.fn<SendQueueRecoveryDeps['failAbandoned']>(() => rowsPerCall.shift() ?? [])
  const reportFailed = vi.fn<SendQueueRecoveryDeps['reportFailed']>()
  const reportError = vi.fn<SendQueueRecoveryDeps['reportError']>()
  return { deps: { failAbandoned, reportFailed, reportError, now: () => now }, failAbandoned, reportFailed, reportError, now }
}

describe('sendQueueRecovery', () => {
  it('fails only rows claimed more than two minutes ago, on every pass including the first', () => {
    const { deps, failAbandoned, now } = makeDeps([[], []])
    const recover = createSendQueueRecovery(deps)
    recover()
    recover()
    const cutoff = new Date(now - ABANDONED_SEND_STALE_MS).toISOString()
    expect(failAbandoned.mock.calls.map(c => c[1])).toEqual([cutoff, cutoff])
    expect(ABANDONED_SEND_STALE_MS).toBe(120_000)
  })

  it('reports each failed row with the delivery_unknown text it stored', () => {
    const rows = [
      { id: 'q1', accountId: 1, messageData: { subject: 'one' } },
      { id: 'q2', accountId: 2, messageData: { subject: 'two' } },
    ]
    const { deps, failAbandoned, reportFailed } = makeDeps([rows])
    expect(createSendQueueRecovery(deps)()).toEqual(rows)
    expect(failAbandoned.mock.calls[0][0]).toBe(ABANDONED_SEND_FAILURE_TEXT)
    expect(reportFailed.mock.calls).toEqual([
      [rows[0], ABANDONED_SEND_FAILURE_TEXT],
      [rows[1], ABANDONED_SEND_FAILURE_TEXT],
    ])
  })

  it('the stored text is decoded by the renderer as the unknown-delivery sentence', () => {
    const t = ((key: string) => `<${key}>`) as unknown as Parameters<typeof presentedTaggedText>[0]
    expect(presentedTaggedText(t, ABANDONED_SEND_FAILURE_TEXT)).toBe('<app.errors.presented.delivery_unknown>')
  })

  it('a report that throws for one row does not stop the others or the queue pass', () => {
    const rows = [
      { id: 'q1', accountId: 1, messageData: {} },
      { id: 'q2', accountId: 1, messageData: {} },
      { id: 'q3', accountId: 2, messageData: {} },
    ]
    const { deps, reportFailed, reportError } = makeDeps([rows])
    const boom = new Error('broadcast failed')
    reportFailed.mockImplementation((row) => { if (row.id === 'q1') throw boom })
    let result: AbandonedSendRow[] = []
    expect(() => { result = createSendQueueRecovery(deps)() }).not.toThrow()
    expect(result).toEqual(rows)
    expect(reportFailed.mock.calls.map(([row]) => row.id)).toEqual(['q1', 'q2', 'q3'])
    expect(reportError).toHaveBeenCalledTimes(1)
    expect(reportError).toHaveBeenCalledWith(boom)
  })
  it('a pass that finds nothing reports nothing and returns an empty list', () => {
    const { deps, reportFailed } = makeDeps([[], []])
    const recover = createSendQueueRecovery(deps)
    expect(recover()).toEqual([])
    expect(recover()).toEqual([])
    expect(reportFailed).not.toHaveBeenCalled()
  })

  it('reports only after the rows are already failed in the store (the storage call comes first)', () => {
    const order: string[] = []
    const rows = [{ id: 'q1', accountId: 1, messageData: {} }]
    const recover = createSendQueueRecovery({
      failAbandoned: () => { order.push('stored'); return rows },
      reportFailed: () => { order.push('reported') },
      reportError: () => {},
      now: () => 0,
    })
    recover()
    expect(order).toEqual(['stored', 'reported'])
  })

  it('stored text names the unknown outcome and says the send is not retried automatically', () => {
    expect(ABANDONED_SEND_FAILURE_TEXT.startsWith(encodeErrorPresentation('delivery_unknown'))).toBe(true)
    expect(ABANDONED_SEND_FAILURE_TEXT).toMatch(/not retried automatically/)
  })
})
