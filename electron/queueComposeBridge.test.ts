import { describe, expect, it } from 'vitest'
import type { ArchiveRef } from '../packages/db'
import { queueItemToComposeInit } from './queueComposeBridge'

/**
 * Round-trip guards for the cancel→edit path (codex HIGH-1). A queued send's
 * stored `messageData` is validated and normalised into a `ComposeInit` so
 * Compose can re-open the cancelled message; every field that the user can
 * set in Compose must survive the trip, including the identity id.
 */
describe('queueItemToComposeInit', () => {
  const base = {
    from: 'me@x.com',
    to: 'friend@y.com',
    subject: 'hello',
    text: 'body',
  }

  it('preserves the identityId the user picked', () => {
    const init = queueItemToComposeInit({ ...base, identityId: 'alias-id' })
    expect(init.identityId).toBe('alias-id')
  })

  it('passes through cc / bcc / html / attachments', () => {
    const init = queueItemToComposeInit({
      ...base,
      cc: 'cc@y.com',
      bcc: 'bcc@y.com',
      html: '<p>body</p>',
      attachments: [{ filename: 'file.txt', contentBase64: 'aGk=' }],
    })
    expect(init.cc).toBe('cc@y.com')
    expect(init.bcc).toBe('bcc@y.com')
    expect(init.html).toBe('<p>body</p>')
    expect(init.attachments).toEqual([{ filename: 'file.txt', contentBase64: 'aGk=' }])
  })

  it('populates replyRef from archiveRef when provided', () => {
    const archive: ArchiveRef = { accountId: 7, folder: 'INBOX', archiveFolder: 'Archive', uid: 42 }
    const init = queueItemToComposeInit(base, archive)
    expect(init.replyRef).toEqual({ accountId: 7, folder: 'INBOX', uid: 42 })
  })

  it('leaves replyRef undefined when archiveRef is absent', () => {
    const init = queueItemToComposeInit(base)
    expect(init.replyRef).toBeUndefined()
  })

  it('omits identityId when the queued payload did not carry one', () => {
    // Legacy send queued before the 2.3-B identity selector existed — must
    // not invent an id, Compose's normal default-pick path handles it.
    const init = queueItemToComposeInit(base)
    expect(init.identityId).toBeUndefined()
  })

  it('throws on malformed payload (missing required from/to/subject)', () => {
    expect(() => queueItemToComposeInit({ from: 'me@x.com' })).toThrow()
    expect(() => queueItemToComposeInit({})).toThrow()
  })

  it('rejects empty identityId string as malformed', () => {
    // An empty identity id is never something Compose would send — refuse it
    // loudly so a stale/corrupted queue entry does not silently become a
    // default-identity fallback.
    expect(() => queueItemToComposeInit({ ...base, identityId: '' })).toThrow()
  })
})
