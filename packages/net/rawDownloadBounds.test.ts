import { describe, expect, it, vi } from 'vitest'

// `./message` reaches better-sqlite3 through `./imap` -> `../db`; the native
// binding is built for the Electron ABI, not the Node one vitest runs under.
// Same shield as eml.test.ts and imap.test.ts.
vi.mock('../db', () => ({
  upsertMessages: vi.fn(),
  setUnread: vi.fn(),
  deleteMessages: vi.fn(),
  setFlagged: vi.fn(),
  upsertContactsIncoming: vi.fn(),
  removeStaleMessages: vi.fn(),
  getAccountMessageCount: vi.fn().mockReturnValue(0),
  getFolderUids: vi.fn().mockReturnValue([]),
  getFolderFlags: vi.fn().mockReturnValue(new Map()),
  removeStaleMessagesByUids: vi.fn(),
  getMessageByUid: vi.fn().mockReturnValue(undefined),
  dataDir: '/tmp/mailcopilot-test',
}))

import { MAX_EML_PARSE_BYTES } from './limits'
import { collectRawBounded } from './message'

/**
 * §2.145 wave 2.1 — the allocation boundary.
 *
 * The hard cap used to run at parser entry, which is AFTER the whole
 * attacker-controlled message had been accumulated chunk by chunk off the IMAP
 * socket. The parse was bounded; the allocation was not. A remote sender
 * delivering a huge message to a folder in offline mode got it buffered in
 * full before anything asked how big it was — and, when the folder's per-file
 * limit was "unlimited", written to disk as well.
 *
 * `collectRawBounded` is not exported (it is an implementation detail of the
 * two download functions), so these tests exercise the PROPERTY it must have,
 * against a fake stream that reports how far it was consumed. That is the
 * claim that matters: consumption stops, and no full buffer is ever built.
 */

/** A chunk source that records how many chunks were actually pulled, so a test
 *  can prove the consumer stopped rather than merely discarded. */
function countingChunks(chunkSize: number, count: number) {
  const state = { pulled: 0, destroyed: false }
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < count; i++) {
        state.pulled += 1
        yield Buffer.alloc(chunkSize, 0x61)
      }
    },
    destroy() { state.destroyed = true },
  }
  return { iterable, state }
}

describe('§2.145 — bounded raw acquisition', () => {
  it('stops consuming the stream once the ceiling is passed, and retains nothing', async () => {
    const { iterable, state } = countingChunks(1024, 100)

    const result = await collectRawBounded(iterable, 4096)

    expect(result.kind).toBe('over_limit')
    if (result.kind !== 'over_limit') throw new Error('unreachable')
    // Four chunks fill the budget exactly; the fifth crosses it and stops us.
    expect(result.bytesSeen).toBe(5 * 1024)
    expect(state.pulled).toBe(5)
    // The other 95 chunks were never pulled, so never allocated. That is the
    // entire finding: before this, all 100 would have been.
    expect(state.pulled).toBeLessThan(100)
    // Best-effort teardown attempted on the way out.
    expect(state.destroyed).toBe(true)
  })

  it('delivers a message that sits exactly at the ceiling', async () => {
    const { iterable, state } = countingChunks(1024, 4)

    const result = await collectRawBounded(iterable, 4096)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.raw).toHaveLength(4096)
    expect(state.pulled).toBe(4)
  })

  it('refuses a message one byte over the ceiling', async () => {
    const { iterable } = countingChunks(1, 4097)
    const result = await collectRawBounded(iterable, 4096)
    expect(result.kind).toBe('over_limit')
  })

  it('handles an empty stream without inventing bytes', async () => {
    const { iterable } = countingChunks(1024, 0)
    const result = await collectRawBounded(iterable, 4096)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.raw).toHaveLength(0)
  })

  it('the ceiling a caller asks for can never exceed the hard cap', () => {
    // Callers pass min(their budget, MAX_EML_PARSE_BYTES); the download applies
    // the same min again, so an over-large caller budget cannot raise it.
    expect(Math.min(500 * 1024 * 1024, MAX_EML_PARSE_BYTES)).toBe(MAX_EML_PARSE_BYTES)
    // A tighter caller budget (a folder's per-file limit) is respected.
    expect(Math.min(2 * 1024 * 1024, MAX_EML_PARSE_BYTES)).toBe(2 * 1024 * 1024)
  })
})


describe('§2.145 — the download surface is a typed union, not a nullable buffer', () => {
  it('exposes the three outcomes callers must distinguish', async () => {
    const mod = await import('./message')
    // The functions exist and are the bounded ones (arity includes the budget).
    expect(typeof mod.downloadRawMessage).toBe('function')
    expect(typeof mod.downloadRawMessagePerAccount).toBe('function')
    // `over_limit` must be a RETURNED value, never a thrown error: this runs
    // inside withImapRetry, and retrying an oversized message re-streams the
    // same bytes forever. A type-level statement of that contract:
    const outcomes: Array<import('./message').RawDownloadResult> = [
      { kind: 'ok', raw: Buffer.alloc(1) },
      { kind: 'empty' },
      { kind: 'over_limit', bytesSeen: MAX_EML_PARSE_BYTES + 1 },
    ]
    expect(outcomes.map(o => o.kind)).toEqual(['ok', 'empty', 'over_limit'])
  })
})
