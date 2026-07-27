import { describe, expect, it } from 'vitest'
import { isAdvancedSearch, parseSearchQuery } from './searchParser'

describe('packages/db/searchParser', () => {
  it('parses free text and negations', () => {
    const q = parseSearchQuery('hello world -"weekly report" -spam')
    expect(q.text).toEqual(['hello', 'world'])
    expect(q.notText).toEqual(['weekly report', 'spam'])
    expect(isAdvancedSearch(q)).toBe(true)
  })

  it('parses from/to/subject with quotes and negations', () => {
    const q = parseSearchQuery('from:john@example.com to:"me@example.com" body:"weekly report" -subject:"bad news" -body:spam')
    expect(q.from).toEqual(['john@example.com'])
    expect(q.to).toEqual(['me@example.com'])
    expect(q.body).toEqual(['weekly report'])
    expect(q.notSubject).toEqual(['bad news'])
    expect(q.notBody).toEqual(['spam'])
  })

  it('parses is:/has:/in: operators', () => {
    const q = parseSearchQuery('is:unread is:starred has:attachment in:Sent')
    expect(q.isUnread).toBe(true)
    expect(q.isFlagged).toBe(true)
    expect(q.hasAttachment).toBe(true)
    expect(q.folder).toBe('Sent')
  })

  it('normalizes negations for is:/has:', () => {
    const q1 = parseSearchQuery('-is:unread')
    expect(q1.isUnread).toBe(false)

    const q2 = parseSearchQuery('-is:read')
    expect(q2.isUnread).toBe(true)

    const q3 = parseSearchQuery('-is:starred -has:attachment')
    expect(q3.isFlagged).toBe(false)
    expect(q3.hasAttachment).toBe(false)
  })

  it('in:anywhere enables the anywhere flag', () => {
    const q = parseSearchQuery('from:john in:anywhere')
    expect(q.anywhere).toBe(true)
    expect(q.folder).toBeUndefined()
  })

  it('before/after accepts only YYYY-MM-DD', () => {
    const ok = parseSearchQuery('before:2026-01-01 after:2025-12-01')
    expect(ok.before).toBe('2026-01-01')
    expect(ok.after).toBe('2025-12-01')

    const bad = parseSearchQuery('before:01-01-2026 after:2026/01/01')
    expect(bad.before).toBeUndefined()
    expect(bad.after).toBeUndefined()
  })

  it('uid: parses a single UID', () => {
    const q = parseSearchQuery('uid:7038')
    expect(q.uids).toEqual([7038])
    expect(isAdvancedSearch(q)).toBe(true)
  })

  it('uid: parses comma-separated UID list', () => {
    const q = parseSearchQuery('uid:7038,7037,7036')
    expect(q.uids).toEqual([7038, 7037, 7036])
  })

  it('uid: combines with other operators', () => {
    const q = parseSearchQuery('uid:100,200 from:alice@example.com')
    expect(q.uids).toEqual([100, 200])
    expect(q.from).toEqual(['alice@example.com'])
  })

  it('uid: ignores invalid values', () => {
    const q = parseSearchQuery('uid:123,abc,-5,0,456')
    expect(q.uids).toEqual([123, 456])
  })

  it('-uid: (negation) is ignored', () => {
    const q = parseSearchQuery('-uid:123')
    expect(q.uids).toEqual([])
  })

  it('uids is empty by default', () => {
    const q = parseSearchQuery('hello world')
    expect(q.uids).toEqual([])
  })

  it('OR/AND are skipped and do not end up in free text', () => {
    const q = parseSearchQuery('from:a@test.com OR from:b@test.com AND from:c@test.com')
    expect(q.from).toEqual(['a@test.com', 'b@test.com', 'c@test.com'])
    expect(q.text).toEqual([])
    expect(q.notText).toEqual([])
  })

  it('OR/AND are skipped in any case (case-insensitive)', () => {
    const q = parseSearchQuery('or and from:x@test.com')
    expect(q.text).toEqual([])
    expect(q.from).toEqual(['x@test.com'])

    const q2 = parseSearchQuery('from:a@test.com Or from:b@test.com And from:c@test.com')
    expect(q2.from).toEqual(['a@test.com', 'b@test.com', 'c@test.com'])
    expect(q2.text).toEqual([])
  })

  it('multiple from: values are collected into array (for OR grouping)', () => {
    const q = parseSearchQuery('from:alice@a.com from:bob@b.com from:carol@c.com')
    expect(q.from).toEqual(['alice@a.com', 'bob@b.com', 'carol@c.com'])
  })
})
