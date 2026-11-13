import { describe, expect, it } from 'vitest'
import { resolveSendFrom } from './sendFromAddress'

const meta = {
  name: 'Primary Name',
  identities: [
    { id: 'alias', displayName: 'Alias Name', email: 'alias@other.test' },
    { id: 'bare', displayName: '  ', email: ' bare@third.test ' },
  ],
}

describe('resolveSendFrom', () => {
  it('uses the chosen identity for the address and the display name', () => {
    expect(resolveSendFrom(meta, { from: 'me@primary.test', identityId: 'alias' })).toEqual({
      fromEmail: 'alias@other.test',
      fromHeader: 'Alias Name <alias@other.test>',
    })
  })

  it('falls back to the account name when the identity has none, trimming the address', () => {
    expect(resolveSendFrom(meta, { from: 'me@primary.test', identityId: 'bare' })).toEqual({
      fromEmail: 'bare@third.test',
      fromHeader: 'Primary Name <bare@third.test>',
    })
  })

  it('uses the renderer address when no identity is chosen or the id is unknown', () => {
    expect(resolveSendFrom(meta, { from: 'me@primary.test' }).fromEmail).toBe('me@primary.test')
    expect(resolveSendFrom(meta, { from: 'me@primary.test', identityId: 'gone' }).fromHeader).toBe('Primary Name <me@primary.test>')
  })

  it('gives a bare address when there is no account meta', () => {
    expect(resolveSendFrom(undefined, { from: 'me@primary.test', identityId: 'alias' })).toEqual({
      fromEmail: 'me@primary.test',
      fromHeader: 'me@primary.test',
    })
  })
})
