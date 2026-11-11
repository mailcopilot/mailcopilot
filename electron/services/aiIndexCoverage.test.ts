import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COVERAGE_WAIT_MS,
  createIndexProbe,
  isIndexIncomplete,
  setIndexCoverageReader,
  type CoverageStatsView,
} from './aiIndexCoverage'

const stats = (over: Partial<CoverageStatsView> & { folderCoverage?: Partial<CoverageStatsView['folderCoverage']> } = {}): CoverageStatsView => ({
  totalMessages: 100,
  bodyIndexed: 100,
  ...over,
  folderCoverage: { total: 4, coveredFull: 4, ...over.folderCoverage },
})

describe('isIndexIncomplete', () => {
  it('is false for a complete index', () => {
    expect(isIndexIncomplete(stats())).toBe(false)
  })

  it('is true when some bodies are not indexed', () => {
    expect(isIndexIncomplete(stats({ bodyIndexed: 99 }))).toBe(true)
  })

  it('is true when some folders are only partly covered', () => {
    expect(isIndexIncomplete(stats({ folderCoverage: { total: 4, coveredFull: 3 } }))).toBe(true)
  })

  it('is false for an empty mailbox', () => {
    expect(isIndexIncomplete(stats({ totalMessages: 0, bodyIndexed: 0, folderCoverage: { total: 0, coveredFull: 0 } }))).toBe(false)
  })

  it('does not report incomplete when more is indexed than counted (clamped)', () => {
    expect(isIndexIncomplete(stats({ bodyIndexed: 150 }))).toBe(false)
    expect(isIndexIncomplete(stats({ folderCoverage: { total: 4, coveredFull: 9 } }))).toBe(false)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a missing folderCoverage', { totalMessages: 10, bodyIndexed: 1 } as unknown as CoverageStatsView],
    ['a null folderCoverage', { totalMessages: 10, bodyIndexed: 1, folderCoverage: null } as unknown as CoverageStatsView],
    ['a non-object folderCoverage', { totalMessages: 10, bodyIndexed: 1, folderCoverage: 'x' } as unknown as CoverageStatsView],
    ['a non-object stats value', 'stats' as unknown as CoverageStatsView],
  ])('is false for unusable stats: %s', (_name, value) => {
    expect(isIndexIncomplete(value)).toBe(false)
  })

  it('treats NaN, negative and non-numeric figures as zero, which shows no incompleteness', () => {
    expect(isIndexIncomplete(stats({ totalMessages: Number.NaN, bodyIndexed: 0, folderCoverage: { total: Number.NaN, coveredFull: 0 } }))).toBe(false)
    expect(isIndexIncomplete(stats({ totalMessages: -5, bodyIndexed: 0, folderCoverage: { total: -1, coveredFull: 0 } }))).toBe(false)
    expect(isIndexIncomplete({ totalMessages: '10', bodyIndexed: 1, folderCoverage: { total: '4', coveredFull: 0 } } as unknown as CoverageStatsView)).toBe(false)
  })

  it('a negative or NaN indexed figure counts as zero indexed (still incomplete against a positive total)', () => {
    expect(isIndexIncomplete(stats({ totalMessages: 10, bodyIndexed: -3 }))).toBe(true)
    expect(isIndexIncomplete(stats({ totalMessages: 10, bodyIndexed: Number.NaN }))).toBe(true)
  })
})

describe('createIndexProbe', () => {
  let reader: ReturnType<typeof vi.fn>
  let controller: AbortController

  beforeEach(() => {
    vi.useFakeTimers()
    reader = vi.fn()
    controller = new AbortController()
    setIndexCoverageReader(reader as unknown as Parameters<typeof setIndexCoverageReader>[0])
  })

  afterEach(() => {
    setIndexCoverageReader(null)
    vi.useRealTimers()
  })

  const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

  it('is not incomplete before anything happened', () => {
    expect(createIndexProbe(controller.signal).incompleteNow()).toBe(false)
  })

  it('reports incomplete after a search finished and its count came back incomplete', async () => {
    reader.mockResolvedValue(stats({ bodyIndexed: 1 }))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3, query: 'x' })
    probe.noteResult('search_emails')
    expect(probe.incompleteNow()).toBe(false) // never waited for
    await settle()
    expect(probe.incompleteNow()).toBe(true)
    expect(reader).toHaveBeenCalledWith([3])
  })

  it('accepts the in-process server prefix on the tool name', async () => {
    reader.mockResolvedValue(stats({ bodyIndexed: 1 }))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('mcp__mailcopilot__search_emails', { accountId: 3 })
    probe.noteResult('mcp__mailcopilot__search_emails')
    await settle()
    expect(probe.incompleteNow()).toBe(true)
  })

  it('stays false for a complete index', async () => {
    reader.mockResolvedValue(stats())
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(probe.incompleteNow()).toBe(false)
  })

  it.each(['get_email', 'list_emails', 'get_thread', 'query_db', 'mcp__other__search_emails'])('does not read for the tool %s', async (tool) => {
    reader.mockResolvedValue(stats({ bodyIndexed: 1 }))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall(tool, { accountId: 3 })
    probe.noteResult(tool)
    await settle()
    expect(reader).not.toHaveBeenCalled()
    expect(probe.incompleteNow()).toBe(false)
  })

  it.each([
    ['missing', {}],
    ['a string', { accountId: '3' }],
    ['zero', { accountId: 0 }],
    ['negative', { accountId: -1 }],
    ['a float', { accountId: 1.5 }],
    ['NaN', { accountId: Number.NaN }],
  ])('ignores a search whose account id is %s', async (_name, input) => {
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', input)
    probe.noteResult('search_emails')
    await settle()
    expect(reader).not.toHaveBeenCalled()
  })

  it('ignores a call with a non-object input', async () => {
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', null)
    probe.noteCall('search_emails', 'x')
    probe.noteResult('search_emails')
    await settle()
    expect(reader).not.toHaveBeenCalled()
  })

  it('does not read when a search result arrives but no search named a mailbox', async () => {
    const probe = createIndexProbe(controller.signal)
    probe.noteResult('search_emails')
    await settle()
    expect(reader).not.toHaveBeenCalled()
  })

  it('starts the read synchronously and returns without waiting for it', () => {
    reader.mockReturnValue(new Promise(() => undefined))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    const returned = probe.noteResult('search_emails')
    expect(returned).toBeUndefined()
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('reads a mailbox only once and starts one read for a batch of new mailboxes', async () => {
    reader.mockResolvedValue(stats())
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 1 })
    probe.noteCall('search_emails', { accountId: 2 })
    probe.noteResult('search_emails')
    probe.noteResult('search_emails') // nothing new
    await settle()
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith([1, 2])

    probe.noteCall('search_emails', { accountId: 2 }) // already counted
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(reader).toHaveBeenCalledTimes(2)
    expect(reader).toHaveBeenLastCalledWith([3])
  })

  it('does not report incomplete until the pending read resolves', async () => {
    let resolve!: (v: CoverageStatsView) => void
    reader.mockReturnValue(new Promise<CoverageStatsView>(r => { resolve = r }))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(probe.incompleteNow()).toBe(false)
    resolve(stats({ bodyIndexed: 0 }))
    await settle()
    expect(probe.incompleteNow()).toBe(true)
  })

  it('stays false when the read fails', async () => {
    reader.mockRejectedValue(new Error('worker crashed'))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(probe.incompleteNow()).toBe(false)
  })

  it('stays false when the read resolves to nothing usable', async () => {
    reader.mockResolvedValue(null)
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(probe.incompleteNow()).toBe(false)
  })

  it('stays false when the read is slower than the deadline', async () => {
    let resolve!: (v: CoverageStatsView) => void
    reader.mockReturnValue(new Promise<CoverageStatsView>(r => { resolve = r }))
    const probe = createIndexProbe(controller.signal, 500)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await vi.advanceTimersByTimeAsync(501)
    resolve(stats({ bodyIndexed: 0 })) // too late
    await settle()
    expect(probe.incompleteNow()).toBe(false)
  })

  it('uses COVERAGE_WAIT_MS as the default deadline', async () => {
    let resolve!: (v: CoverageStatsView) => void
    reader.mockReturnValue(new Promise<CoverageStatsView>(r => { resolve = r }))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await vi.advanceTimersByTimeAsync(COVERAGE_WAIT_MS - 1)
    resolve(stats({ bodyIndexed: 0 })) // just in time
    await settle()
    expect(probe.incompleteNow()).toBe(true)
  })

  it('stays false when the request is aborted while the read is pending', async () => {
    let resolve!: (v: CoverageStatsView) => void
    reader.mockReturnValue(new Promise<CoverageStatsView>(r => { resolve = r }))
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    controller.abort()
    await settle()
    resolve(stats({ bodyIndexed: 0 }))
    await settle()
    expect(probe.incompleteNow()).toBe(false)
  })

  it('does not call the reader when the signal is already aborted', async () => {
    controller.abort()
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(reader).not.toHaveBeenCalled()
    expect(probe.incompleteNow()).toBe(false)
  })

  it('stays false when no reader is registered', async () => {
    setIndexCoverageReader(null)
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(probe.incompleteNow()).toBe(false)
  })

  it('does not leave a pending timer behind after the read settles', async () => {
    reader.mockResolvedValue(stats())
    const probe = createIndexProbe(controller.signal)
    probe.noteCall('search_emails', { accountId: 3 })
    probe.noteResult('search_emails')
    await settle()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps probes of two requests independent', async () => {
    reader.mockResolvedValue(stats({ bodyIndexed: 0 }))
    const a = createIndexProbe(controller.signal)
    const b = createIndexProbe(controller.signal)
    a.noteCall('search_emails', { accountId: 3 })
    a.noteResult('search_emails')
    await settle()
    expect(a.incompleteNow()).toBe(true)
    expect(b.incompleteNow()).toBe(false)
  })
})
