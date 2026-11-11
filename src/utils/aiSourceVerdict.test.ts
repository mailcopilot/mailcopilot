import { describe, expect, it } from 'vitest'
import { judgeMailref, type CitationStatus } from './aiSourceVerdict'

const found = (token: string): CitationStatus => ({ token, status: 'found', subject: 's', from: 'f', date: 'd' })
const missing = (token: string): CitationStatus => ({ token, status: 'missing' })
const unknown = (token: string): CitationStatus => ({ token, status: 'unknown' })
const map = (...c: CitationStatus[]) => new Map(c.map(x => [x.token, x]))
const base = { citations: map(), streaming: false, legacyLinks: false }
const T = 'k3f2x7ab'

describe('judgeMailref: a citation link', () => {
  it('is a source when main registered the ticket for the session and the message is there', () => {
    expect(judgeMailref(`mailref://c/${T}`, { ...base, citations: map(found(T)) })).toEqual({ kind: 'citation', token: T, found: true })
  })
  it('is still a source when the message is gone (the caption says so, the click says not found)', () => {
    expect(judgeMailref(`mailref://c/${T}`, { ...base, citations: map(missing(T)) })).toEqual({ kind: 'citation', token: T, found: false })
  })
  it('is NOT a source when the ticket is not the session\'s: plain text with a mark', () => {
    expect(judgeMailref(`mailref://c/${T}`, { ...base, citations: map(unknown(T)) })).toEqual({ kind: 'unconfirmed' })
  })
  it('is pending while main has not answered about it yet', () => {
    expect(judgeMailref(`mailref://c/${T}`, base)).toEqual({ kind: 'pending' })
  })
  it('is pending while the answer streams, whatever main said', () => {
    expect(judgeMailref(`mailref://c/${T}`, { ...base, streaming: true, citations: map(found(T)) })).toEqual({ kind: 'pending' })
  })
  it('in an answer saved before tickets it cannot be ours', () => {
    expect(judgeMailref(`mailref://c/${T}`, { ...base, legacyLinks: true, citations: map(found(T)) })).toEqual({ kind: 'unconfirmed' })
  })
  it.each([['mailref://c/short'], ['mailref://c/k3f2x7abc'], ['mailref://c/K3F2X7AB'], ['mailref://c/']])('a malformed ticket %s is invalid', href => {
    expect(judgeMailref(href, { ...base, citations: map(found(T)) })).toEqual({ kind: 'invalid' })
  })
})

describe('judgeMailref: a place link (mailref://account/folder/uid)', () => {
  const place = 'mailref://1/INBOX/42'
  it('in an answer written with tickets is NEVER clickable: the model composed it', () => {
    expect(judgeMailref(place, base)).toEqual({ kind: 'unconfirmed' })
    expect(judgeMailref(place, { ...base, citations: map(found(T)) })).toEqual({ kind: 'unconfirmed' })
  })
  it('in an answer saved before tickets works as it always did, unflagged', () => {
    expect(judgeMailref(place, { ...base, legacyLinks: true })).toEqual({ kind: 'legacy', target: { accountId: 1, folder: 'INBOX', uid: 42 } })
  })
  it('is pending while streaming', () => {
    expect(judgeMailref(place, { ...base, streaming: true })).toEqual({ kind: 'pending' })
  })
  it.each([['mailref://x/INBOX/1'], ['mailref://1/INBOX'], ['https://example.test'], [undefined], ['']])('a malformed or foreign link %s is invalid', href => {
    expect(judgeMailref(href, base)).toEqual({ kind: 'invalid' })
  })
})
