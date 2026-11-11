import { describe, expect, it } from 'vitest'
import { buildReplyThreadHeaders } from './replyThreading'

describe('buildReplyThreadHeaders (RFC 5322 §3.6.4)', () => {
  it('parent without References or In-Reply-To: both headers are the parent id', () => {
    expect(buildReplyThreadHeaders({ messageId: '<a@x>' })).toEqual({ inReplyTo: '<a@x>', references: '<a@x>' })
  })

  it('appends the parent id to the parent References', () => {
    expect(buildReplyThreadHeaders({ messageId: '<c@x>', references: '<a@x> <b@x>', inReplyTo: '<b@x>' })).toEqual({
      inReplyTo: '<c@x>',
      references: '<a@x> <b@x> <c@x>',
    })
  })

  it('falls back to the parent In-Reply-To when it has no References and holds one id', () => {
    expect(buildReplyThreadHeaders({ messageId: '<b@x>', inReplyTo: '<a@x>' })?.references).toBe('<a@x> <b@x>')
  })

  it('does not use an In-Reply-To that holds several ids', () => {
    expect(buildReplyThreadHeaders({ messageId: '<c@x>', inReplyTo: '<a@x> <b@x>' })?.references).toBe('<c@x>')
  })

  it('does not repeat the parent id when the chain already ends with it', () => {
    expect(buildReplyThreadHeaders({ messageId: '<b@x>', references: '<a@x> <b@x>' })?.references).toBe('<a@x> <b@x>')
  })

  it('accepts a stored Message-ID without angle brackets and wraps it', () => {
    expect(buildReplyThreadHeaders({ messageId: 'a@x' })?.inReplyTo).toBe('<a@x>')
  })

  it('returns null when the parent has no usable Message-ID', () => {
    expect(buildReplyThreadHeaders({})).toBeNull()
    expect(buildReplyThreadHeaders({ messageId: '  ' })).toBeNull()
    expect(buildReplyThreadHeaders({ messageId: 'two words', references: '<a@x>' })).toBeNull()
  })

  it('keeps the thread root and the newest ids of a very long chain', () => {
    const chain = Array.from({ length: 200 }, (_, i) => `<m${i}@x>`)
    const out = buildReplyThreadHeaders({ messageId: '<last@x>', references: chain.join(' ') })
    const ids = out?.references.split(' ') ?? []
    expect(ids).toHaveLength(50)
    expect(ids[0]).toBe('<m0@x>')
    expect(ids[49]).toBe('<last@x>')
    expect(ids[48]).toBe('<m199@x>')
  })

  it('ignores header injection attempts inside stored values', () => {
    const out = buildReplyThreadHeaders({ messageId: '<a@x>', references: '<b@x>\r\nBcc: evil@x <c@x>' })
    expect(out?.references).toBe('<b@x> <c@x> <a@x>')
  })
})
