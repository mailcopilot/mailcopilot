import { describe, expect, it, vi } from 'vitest'
import { resolveMessageRefSummary } from './messageRefSummary'

const ref = { accountId: 2, folder: 'INBOX', uid: 42 }

describe('resolveMessageRefSummary', () => {
  it('returns the cached row without asking the server', async () => {
    const row = { accountId: 2, folder: 'INBOX', uid: 42, subject: 's' }
    const invoke = vi.fn(async (channel: string) => (channel === 'cache:messageByUid' ? row : null))
    await expect(resolveMessageRefSummary(ref, invoke)).resolves.toBe(row)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('builds a row from the server details when the cache has none', async () => {
    const invoke = vi.fn(async (channel: string) => (channel === 'cache:messageByUid' ? null : {
      envelope: { from: [{ address: 'a@x.test', name: 'Alice' }], subject: 'Hello', date: '2026-01-01' },
      flags: ['\\Seen', '\\Flagged'],
      attachments: [{}],
    }))
    const row = await resolveMessageRefSummary(ref, invoke)
    expect(row).toMatchObject({ accountId: 2, uid: 42, from: 'Alice', fromAddr: 'a@x.test', subject: 'Hello', unread: false, flagged: true, hasAttachments: true })
  })

  it('a link into a mailbox that no longer exists finds nothing: the message is "not found", never another mailbox\'s mail', async () => {
    // Account 2 was deleted; its number is never issued again, so no other mailbox answers for it.
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'cache:messageByUid') return null
      throw new Error('account not found')
    })
    await expect(resolveMessageRefSummary(ref, invoke)).resolves.toBeNull()
  })
})
