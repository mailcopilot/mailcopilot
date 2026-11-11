import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMint = vi.hoisted(() => vi.fn())
const mockGet = vi.hoisted(() => vi.fn())
const mockList = vi.hoisted(() => vi.fn())
const mockFind = vi.hoisted(() => vi.fn())
vi.mock('../../packages/db', () => ({
  mintAiCitation: mockMint, getAiCitation: mockGet, listAiCitations: mockList, findMessageForSource: mockFind,
}))
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }))

import { citationFor, openCitation, resolveCitations, withCitation } from './aiCitations'

const row = { accountId: 1, folder: 'INBOX', uid: 42, messageId: '<a@x>' }

beforeEach(() => {
  mockMint.mockReset(); mockGet.mockReset(); mockList.mockReset(); mockFind.mockReset()
})

describe('citationFor', () => {
  it('issues a ticket for the row and returns the ready link', () => {
    mockMint.mockReturnValue('k3f2x7ab')
    expect(citationFor('s1', row)).toBe('mailref://c/k3f2x7ab')
    expect(mockMint).toHaveBeenCalledWith('s1', { accountId: 1, folder: 'INBOX', uid: 42, messageId: '<a@x>' })
  })
  it('gives nothing without a session (export server, no sessionId): the model gets no link to copy', () => {
    expect(citationFor(undefined, row)).toBeUndefined()
    expect(mockMint).not.toHaveBeenCalled()
  })
  it('gives nothing when the registry refuses (no Message-ID, unknown session) or throws', () => {
    mockMint.mockReturnValue(null)
    expect(citationFor('s1', row)).toBeUndefined()
    mockMint.mockImplementation(() => { throw new Error('db closed') })
    expect(citationFor('s1', row)).toBeUndefined()
  })
})

describe('withCitation', () => {
  it('puts cite FIRST, then the shaped row', () => {
    mockMint.mockReturnValue('k3f2x7ab')
    const out = withCitation('s1', row, { uid: 42, subject: 'Invoice' })
    expect(Object.keys(out)).toEqual(['cite', 'uid', 'subject'])
    expect((out as { cite: string }).cite).toBe('mailref://c/k3f2x7ab')
  })
  it('a cite field already present in the row (from a caller, never from our database) never overrides the ticket main issues', () => {
    mockMint.mockReturnValue('k3f2x7ab')
    const out = withCitation('s1', row, { cite: 'mailref://c/zzzzzzzz', uid: 42 }) as Record<string, unknown>
    expect(out.cite).toBe('mailref://c/k3f2x7ab')
    expect(Object.keys(out)[0]).toBe('cite')
    expect(out.uid).toBe(42)
  })
  it('returns the row untouched when there is no ticket', () => {
    mockMint.mockReturnValue(null)
    expect(withCitation('s1', row, { uid: 42 })).toEqual({ uid: 42 })
  })
})

describe('resolveCitations', () => {
  const entry = (token: string) => ({ token, accountId: 1, folder: 'INBOX', uid: 42, messageId: '<a@x>' })

  it('a ticket of the session whose message is there is found, with the CURRENT caption (not the stored one)', () => {
    mockList.mockReturnValue([entry('aaaaaaaa')])
    mockFind.mockReturnValue({ folder: 'Archive', uid: 7, subject: 'Now', from: 'Alice', date: 'd' })
    expect(resolveCitations({ sessionId: 's1', tokens: ['aaaaaaaa'] })).toEqual([{ token: 'aaaaaaaa', status: 'found', subject: 'Now', from: 'Alice', date: 'd' }])
    expect(mockFind).toHaveBeenCalledWith(1, 'INBOX', 42, '<a@x>')
  })
  it('a ticket whose message is gone is missing, with no caption', () => {
    mockList.mockReturnValue([entry('aaaaaaaa')])
    mockFind.mockReturnValue(undefined)
    expect(resolveCitations({ sessionId: 's1', tokens: ['aaaaaaaa'] })).toEqual([{ token: 'aaaaaaaa', status: 'missing' }])
  })
  it('a ticket that is not registered for the session is unknown (not a source)', () => {
    mockList.mockReturnValue([])
    expect(resolveCitations({ sessionId: 's1', tokens: ['bbbbbbbb'] })).toEqual([{ token: 'bbbbbbbb', status: 'unknown' }])
  })
  it('malformed tokens are unknown and never reach the database', () => {
    mockList.mockReturnValue([])
    expect(resolveCitations({ sessionId: 's1', tokens: ['short', 'UPPERCAS', 'abcdefg1'] }).map(r => r.status)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(mockList).toHaveBeenCalledWith('s1', [])
  })
  it('repeats are answered once, in order', () => {
    mockList.mockReturnValue([])
    expect(resolveCitations({ sessionId: 's1', tokens: ['aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa'] }).map(r => r.token)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })
  it.each([[null], ['x'], [{}], [{ sessionId: '', tokens: [] }], [{ sessionId: 's', tokens: 'a' }], [{ sessionId: 's', tokens: Array(101).fill('aaaaaaaa') }]])(
    'refuses a malformed payload %j with an empty answer', raw => {
      expect(resolveCitations(raw)).toEqual([])
    },
  )
  it('a failed registry read answers about NO ticket: the links stay pending and are asked again, never called "unknown"', () => {
    mockList.mockImplementation(() => { throw new Error('db closed') })
    expect(resolveCitations({ sessionId: 's1', tokens: ['aaaaaaaa'] })).toEqual([])
  })
})

describe('openCitation', () => {
  const entry = { token: 'aaaaaaaa', accountId: 2, folder: 'INBOX', uid: 42, messageId: '<a@x>' }
  it('returns the CURRENT place of the message (moved to another folder)', () => {
    mockGet.mockReturnValue(entry)
    mockFind.mockReturnValue({ folder: 'Archive', uid: 7, subject: '', from: '', date: '' })
    expect(openCitation({ sessionId: 's1', token: 'aaaaaaaa' })).toEqual({ found: true, accountId: 2, folder: 'Archive', uid: 7 })
  })
  it('not found when the ticket is unknown to the session', () => {
    mockGet.mockReturnValue(undefined)
    expect(openCitation({ sessionId: 's1', token: 'aaaaaaaa' })).toEqual({ found: false })
    expect(mockFind).not.toHaveBeenCalled()
  })
  it('not found when the message is gone: nothing else is offered', () => {
    mockGet.mockReturnValue(entry)
    mockFind.mockReturnValue(undefined)
    expect(openCitation({ sessionId: 's1', token: 'aaaaaaaa' })).toEqual({ found: false })
  })
  it.each([[null], [{ sessionId: 's1', token: 'short' }], [{ sessionId: '', token: 'aaaaaaaa' }], [{ token: 'aaaaaaaa' }]])('refuses %j', raw => {
    expect(openCitation(raw)).toEqual({ found: false })
    expect(mockGet).not.toHaveBeenCalled()
  })
  it('a store that throws is not found', () => {
    mockGet.mockImplementation(() => { throw new Error('db closed') })
    expect(openCitation({ sessionId: 's1', token: 'aaaaaaaa' })).toEqual({ found: false })
  })
})
