import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock DB module
vi.mock('../../packages/db', () => ({
  getOfflineOps: vi.fn().mockReturnValue([]),
  deleteOfflineOp: vi.fn(),
  deleteOfflineOpsForFolder: vi.fn(),
  incrementOfflineOpRetry: vi.fn(),
  deletePoisonOfflineOps: vi.fn(),
  removeTempPlaceholders: vi.fn(),
}))

// Mock IMAP module
vi.mock('../../packages/net/imap', () => ({
  setSeen: vi.fn().mockResolvedValue(undefined),
  setFlagged: vi.fn().mockResolvedValue(undefined),
  moveMessages: vi.fn().mockResolvedValue(undefined),
  deleteMessagesRemote: vi.fn().mockResolvedValue(undefined),
  getMailboxStatus: vi.fn().mockResolvedValue({ exists: 10, highestModseq: '100', uidValidity: 42 }),
}))

// Spy on Sentry captureException so the cooldown gate tests can assert how
// many times the real Sentry call gets through.
const captureExceptionMock = vi.fn()
vi.mock('../sentry', () => ({
  captureException: (err: unknown, ctx: unknown) => captureExceptionMock(err, ctx),
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}))

// Capture startMetricSpan calls so we can assert span name, attributes, and end().
const spanEnd = vi.fn()
const spanSetAttributes = vi.fn()
const startMetricSpan: ReturnType<typeof vi.fn> = vi.fn(() => ({
  end: spanEnd,
  setAttributes: spanSetAttributes,
}))
vi.mock('../metrics', () => ({
  startMetricSpan: (name: string, attrs?: Record<string, unknown>) => startMetricSpan(name, attrs),
}))

import { currentImapPriority } from '../../packages/net/imapScheduler'
import { replayOfflineOps, captureOnce, resetOfflineReplayCaptureGate } from './offlineReplay'
import { getOfflineOps, deleteOfflineOp, deleteOfflineOpsForFolder } from '../../packages/db'
import { setSeen, setFlagged, moveMessages, deleteMessagesRemote, getMailboxStatus } from '../../packages/net/imap'

const mockImapConfig = { host: 'imap.test.com', port: 993, user: 'test@test.com', pass: 'pass' }
const getImapConfig = vi.fn().mockResolvedValue(mockImapConfig)

describe('offlineReplay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getImapConfig.mockResolvedValue(mockImapConfig)
    vi.mocked(getMailboxStatus).mockResolvedValue({ exists: 10, highestModseq: '100', uidValidity: 42 })
    vi.mocked(setSeen).mockResolvedValue(undefined)
    vi.mocked(setFlagged).mockResolvedValue(undefined)
    vi.mocked(moveMessages).mockResolvedValue(undefined)
    vi.mocked(deleteMessagesRemote).mockResolvedValue(undefined)
    startMetricSpan.mockImplementation(() => ({ end: spanEnd, setAttributes: spanSetAttributes }))
  })

  it('returns zero counts when no pending ops', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([])
    const result = await replayOfflineOps(1, getImapConfig)
    expect(result).toEqual({ replayed: 0, failed: 0 })
    expect(getImapConfig).not.toHaveBeenCalled()
  })

  it('replays flag_seen ops successfully', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 1, accountId: 1, folder: 'INBOX', uid: 100, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 2, accountId: 1, folder: 'INBOX', uid: 101, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 2, failed: 0 })
    expect(setSeen).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [100, 101], true, 1)
    expect(deleteOfflineOp).toHaveBeenCalledTimes(2)
    expect(deleteOfflineOp).toHaveBeenCalledWith(1)
    expect(deleteOfflineOp).toHaveBeenCalledWith(2)
  })

  // §2.17 Phase 1 — the tier is what keeps a replay burst from pushing the
  // message the user is opening behind a queue of STORE/MOVE commands. It is
  // ambient, so the only honest way to observe it is from inside the net call.
  it('runs its IMAP work at the `sync` tier', async () => {
    const tiers: string[] = []
    vi.mocked(setSeen).mockImplementation(async () => { tiers.push(currentImapPriority()) })
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 1, accountId: 1, folder: 'INBOX', uid: 100, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    await replayOfflineOps(1, getImapConfig)

    expect(tiers).toEqual(['sync'])
    vi.mocked(setSeen).mockResolvedValue(undefined)
  })

  it('replays flag_flagged ops with mixed true/false', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 3, accountId: 1, folder: 'INBOX', uid: 200, opType: 'flag_flagged', payload: { flagged: true }, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 4, accountId: 1, folder: 'INBOX', uid: 201, opType: 'flag_flagged', payload: { flagged: false }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 2, failed: 0 })
    expect(setFlagged).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [200], true, 1)
    expect(setFlagged).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [201], false, 1)
  })

  it('discards ops when folder is not accessible', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 5, accountId: 1, folder: 'Deleted', uid: 300, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
    ])
    vi.mocked(getMailboxStatus).mockRejectedValue(new Error('Folder not found'))

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 0, failed: 1 })
    expect(setSeen).not.toHaveBeenCalled()
    // Ops are not deleted individually — the folder group is skipped
    expect(deleteOfflineOp).not.toHaveBeenCalled()
  })

  it('handles IMAP error during replay gracefully', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 6, accountId: 1, folder: 'INBOX', uid: 400, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
    ])
    vi.mocked(setSeen).mockRejectedValue(new Error('Connection lost'))

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 0, failed: 1 })
    // Op not deleted — will be retried next time
    expect(deleteOfflineOp).not.toHaveBeenCalled()
  })

  it('handles IMAP config unavailable', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 7, accountId: 1, folder: 'INBOX', uid: 500, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
    ])
    getImapConfig.mockRejectedValue(new Error('Account not found'))

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 0, failed: 1 })
  })

  it('processes multiple folders independently', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 8, accountId: 1, folder: 'INBOX', uid: 600, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 9, accountId: 1, folder: 'Sent', uid: 601, opType: 'flag_flagged', payload: { flagged: true }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 2, failed: 0 })
    expect(setSeen).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [600], true, 1)
    expect(setFlagged).toHaveBeenCalledWith(mockImapConfig, 'Sent', [601], true, 1)
  })

  it('maintains operation order: flag_seen before flag_flagged before move before delete', async () => {
    const callOrder: string[] = []
    vi.mocked(setSeen).mockImplementation(async () => { callOrder.push('setSeen') })
    vi.mocked(setFlagged).mockImplementation(async () => { callOrder.push('setFlagged') })
    vi.mocked(moveMessages).mockImplementation(async () => { callOrder.push('moveMessages') })
    vi.mocked(deleteMessagesRemote).mockImplementation(async () => { callOrder.push('deleteMessages') })

    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 10, accountId: 1, folder: 'INBOX', uid: 700, opType: 'move', payload: { destFolder: 'Archive' }, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 11, accountId: 1, folder: 'INBOX', uid: 701, opType: 'flag_flagged', payload: { flagged: true }, uidValidity: 42, createdAt: '2026-01-02' },
      { id: 12, accountId: 1, folder: 'INBOX', uid: 702, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-03' },
      { id: 13, accountId: 1, folder: 'INBOX', uid: 703, opType: 'delete', payload: null, uidValidity: 42, createdAt: '2026-01-04' },
    ])

    await replayOfflineOps(1, getImapConfig)

    expect(callOrder).toEqual(['setSeen', 'setFlagged', 'moveMessages', 'deleteMessages'])
  })

  it('replays move ops successfully', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 20, accountId: 1, folder: 'INBOX', uid: 800, opType: 'move', payload: { destFolder: 'Archive' }, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 21, accountId: 1, folder: 'INBOX', uid: 801, opType: 'move', payload: { destFolder: 'Archive' }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 2, failed: 0 })
    expect(moveMessages).toHaveBeenCalledWith(mockImapConfig, 'INBOX', 'Archive', [800, 801], 1)
    expect(deleteOfflineOp).toHaveBeenCalledWith(20)
    expect(deleteOfflineOp).toHaveBeenCalledWith(21)
  })

  it('groups move ops by destination folder', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 30, accountId: 1, folder: 'INBOX', uid: 900, opType: 'move', payload: { destFolder: 'Archive' }, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 31, accountId: 1, folder: 'INBOX', uid: 901, opType: 'move', payload: { destFolder: 'Trash' }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 2, failed: 0 })
    expect(moveMessages).toHaveBeenCalledWith(mockImapConfig, 'INBOX', 'Archive', [900], 1)
    expect(moveMessages).toHaveBeenCalledWith(mockImapConfig, 'INBOX', 'Trash', [901], 1)
  })

  it('replays delete ops successfully', async () => {
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 40, accountId: 1, folder: 'INBOX', uid: 1000, opType: 'delete', payload: null, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 41, accountId: 1, folder: 'INBOX', uid: 1001, opType: 'delete', payload: null, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 2, failed: 0 })
    expect(deleteMessagesRemote).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [1000, 1001], 1)
    expect(deleteOfflineOp).toHaveBeenCalledWith(40)
    expect(deleteOfflineOp).toHaveBeenCalledWith(41)
  })

  it('discards all ops for folder when UIDVALIDITY mismatches', async () => {
    vi.mocked(getMailboxStatus).mockResolvedValue({ exists: 10, highestModseq: '100', uidValidity: 99 })
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 50, accountId: 1, folder: 'INBOX', uid: 1100, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
      { id: 51, accountId: 1, folder: 'INBOX', uid: 1101, opType: 'move', payload: { destFolder: 'Archive' }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 0, failed: 2 })
    expect(deleteOfflineOpsForFolder).toHaveBeenCalledWith(1, 'INBOX')
    expect(setSeen).not.toHaveBeenCalled()
    expect(moveMessages).not.toHaveBeenCalled()
  })

  it('allows replay when ops have null uidValidity (legacy ops)', async () => {
    vi.mocked(getMailboxStatus).mockResolvedValue({ exists: 10, highestModseq: '100', uidValidity: 99 })
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 60, accountId: 1, folder: 'INBOX', uid: 1200, opType: 'flag_seen', payload: { seen: true }, uidValidity: null, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 1, failed: 0 })
    expect(setSeen).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [1200], true, 1)
  })

  it('allows replay when server uidValidity is null', async () => {
    vi.mocked(getMailboxStatus).mockResolvedValue({ exists: 10, highestModseq: '100', uidValidity: null })
    vi.mocked(getOfflineOps).mockReturnValue([
      { id: 70, accountId: 1, folder: 'INBOX', uid: 1300, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
    ])

    const result = await replayOfflineOps(1, getImapConfig)

    expect(result).toEqual({ replayed: 1, failed: 0 })
    expect(setSeen).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [1300], true, 1)
  })

  describe('offline.replay span', () => {
    it('starts an offline.replay span and ends it on a successful drain', async () => {
      vi.mocked(getOfflineOps).mockReturnValue([
        { id: 1, accountId: 1, folder: 'INBOX', uid: 100, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
      ])

      await replayOfflineOps(1, getImapConfig)

      expect(startMetricSpan).toHaveBeenCalledTimes(1)
      expect(startMetricSpan.mock.calls[0][0]).toBe('offline.replay')
      expect(spanSetAttributes).toHaveBeenCalledWith({
        ops_count_bucket: '1-5',
        failed_bucket: '0',
        uidvalidity_mismatch: false,
      })
      expect(spanEnd).toHaveBeenCalledTimes(1)
    })

    it('ends the span when there are zero pending ops', async () => {
      vi.mocked(getOfflineOps).mockReturnValue([])

      await replayOfflineOps(1, getImapConfig)

      expect(startMetricSpan.mock.calls[0][0]).toBe('offline.replay')
      expect(spanSetAttributes).toHaveBeenCalledWith({
        ops_count_bucket: '0',
        failed_bucket: '0',
        uidvalidity_mismatch: false,
      })
      expect(spanEnd).toHaveBeenCalledTimes(1)
    })

    it('sets uidvalidity_mismatch=true when a folder is discarded due to UIDVALIDITY drift', async () => {
      vi.mocked(getMailboxStatus).mockResolvedValue({ exists: 10, highestModseq: '100', uidValidity: 99 })
      vi.mocked(getOfflineOps).mockReturnValue([
        { id: 80, accountId: 1, folder: 'INBOX', uid: 1400, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
        { id: 81, accountId: 1, folder: 'INBOX', uid: 1401, opType: 'move', payload: { destFolder: 'Archive' }, uidValidity: 42, createdAt: '2026-01-01' },
      ])

      await replayOfflineOps(1, getImapConfig)

      expect(spanSetAttributes).toHaveBeenCalledWith({
        ops_count_bucket: '1-5',
        failed_bucket: '2',
        uidvalidity_mismatch: true,
      })
      expect(spanEnd).toHaveBeenCalledTimes(1)
    })

    it('reports failed count when IMAP config is unavailable', async () => {
      vi.mocked(getOfflineOps).mockReturnValue([
        { id: 90, accountId: 1, folder: 'INBOX', uid: 1500, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
      ])
      getImapConfig.mockRejectedValue(new Error('Account not found'))

      await replayOfflineOps(1, getImapConfig)

      expect(spanSetAttributes).toHaveBeenCalledWith({
        ops_count_bucket: '1-5',
        failed_bucket: '1',
        uidvalidity_mismatch: false,
      })
      expect(spanEnd).toHaveBeenCalledTimes(1)
    })

    it('ends the span when an IMAP batch fails mid-drain', async () => {
      vi.mocked(getOfflineOps).mockReturnValue([
        { id: 100, accountId: 1, folder: 'INBOX', uid: 1600, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
      ])
      vi.mocked(setSeen).mockRejectedValue(new Error('Connection lost'))

      await replayOfflineOps(1, getImapConfig)

      expect(spanSetAttributes).toHaveBeenCalledWith({
        ops_count_bucket: '1-5',
        failed_bucket: '1',
        uidvalidity_mismatch: false,
      })
      expect(spanEnd).toHaveBeenCalledTimes(1)
    })

    it('does not break replay when startMetricSpan itself throws', async () => {
      startMetricSpan.mockImplementation(() => { throw new Error('sentry broken') })
      vi.mocked(getOfflineOps).mockReturnValue([
        { id: 110, accountId: 1, folder: 'INBOX', uid: 1700, opType: 'flag_seen', payload: { seen: true }, uidValidity: 42, createdAt: '2026-01-01' },
      ])

      const result = await replayOfflineOps(1, getImapConfig)

      expect(result).toEqual({ replayed: 1, failed: 0 })
      expect(setSeen).toHaveBeenCalledWith(mockImapConfig, 'INBOX', [1700], true, 1)
    })
  })

  describe('captureOnce cooldown gate', () => {
    beforeEach(() => {
      resetOfflineReplayCaptureGate()
      captureExceptionMock.mockClear()
    })

    it('first capture for a key passes through to Sentry', () => {
      const err = new Error('boom')
      captureOnce('k1', err, { source: 'test' })
      expect(captureExceptionMock).toHaveBeenCalledTimes(1)
      expect(captureExceptionMock).toHaveBeenCalledWith(err, { source: 'test' })
    })

    it('second capture with same key within cooldown is suppressed', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      try {
        captureOnce('k1', new Error('boom'), {})
        vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
        captureOnce('k1', new Error('boom'), {})
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('different key is not suppressed by an unrelated recent capture', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      try {
        captureOnce('k1', new Error('boom'), {})
        vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
        captureOnce('k2', new Error('different'), {})
        expect(captureExceptionMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('capture after cooldown expiry passes through again', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      try {
        captureOnce('k1', new Error('boom'), {})
        vi.setSystemTime(new Date('2026-01-01T00:06:00Z'))
        captureOnce('k1', new Error('boom'), {})
        expect(captureExceptionMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
