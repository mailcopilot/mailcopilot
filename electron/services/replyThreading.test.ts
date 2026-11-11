import { describe, expect, it, vi } from 'vitest'
import { resolveReplyThreading, resolveDraftReplyRef } from './replyThreading'

const parent = { messageId: '<p@x>', references: '<r@x>' }

describe('resolveReplyThreading', () => {
  it('reads the parent from the cache by the pointer and builds both headers', () => {
    const lookup = vi.fn().mockReturnValue(parent)
    expect(resolveReplyThreading({ accountId: 1, folder: 'INBOX', uid: 7 }, lookup)).toEqual({
      inReplyTo: '<p@x>',
      references: '<r@x> <p@x>',
    })
    expect(lookup).toHaveBeenCalledWith(1, 'INBOX', 7)
  })

  it('sets nothing without a pointer (forward, new message)', () => {
    const lookup = vi.fn()
    expect(resolveReplyThreading(undefined, lookup)).toEqual({})
    expect(lookup).not.toHaveBeenCalled()
  })

  it('finds the parent in the account the POINTER names, whichever mailbox sends the reply', () => {
    // The user opened a reply on account 2 and picked another sender identity
    // or mailbox in the compose window: the reply still answers that message.
    const lookup = vi.fn().mockReturnValue(parent)
    expect(resolveReplyThreading({ accountId: 2, folder: 'INBOX', uid: 7 }, lookup)).toEqual({
      inReplyTo: '<p@x>',
      references: '<r@x> <p@x>',
    })
    expect(lookup).toHaveBeenCalledWith(2, 'INBOX', 7)
  })

  it('sends unthreaded when the parent left the cache or has no Message-ID', () => {
    expect(resolveReplyThreading({ accountId: 1, folder: 'INBOX', uid: 7 }, () => undefined)).toEqual({})
    expect(resolveReplyThreading({ accountId: 1, folder: 'INBOX', uid: 7 }, () => ({ messageId: null }))).toEqual({})
  })
})

describe('resolveDraftReplyRef (reopening a saved reply draft)', () => {
  const draftRef = { accountId: 1, folder: 'Drafts', uid: 90 }

  it('turns the In-Reply-To stored in the draft into a pointer at the parent in the same account', () => {
    const readDraft = vi.fn().mockReturnValue({ inReplyTo: '<p@x>' })
    const findParent = vi.fn().mockReturnValue({ folder: 'INBOX', uid: 7 })
    expect(resolveDraftReplyRef(draftRef, readDraft, findParent)).toEqual({ accountId: 1, folder: 'INBOX', uid: 7 })
    expect(readDraft).toHaveBeenCalledWith(1, 'Drafts', 90)
    expect(findParent).toHaveBeenCalledWith(1, '<p@x>')
  })

  it('uses the first id when the draft header lists several', () => {
    const findParent = vi.fn().mockReturnValue({ folder: 'INBOX', uid: 7 })
    resolveDraftReplyRef(draftRef, () => ({ inReplyTo: '<p@x> <q@x>' }), findParent)
    expect(findParent).toHaveBeenCalledWith(1, '<p@x>')
  })

  it('gives no pointer for a draft that answers nothing, is not cached, or whose parent is gone', () => {
    const findParent = vi.fn().mockReturnValue(undefined)
    expect(resolveDraftReplyRef(draftRef, () => ({ inReplyTo: null }), findParent)).toBeUndefined()
    expect(resolveDraftReplyRef(draftRef, () => undefined, findParent)).toBeUndefined()
    expect(resolveDraftReplyRef(draftRef, () => ({ inReplyTo: '<p@x>' }), findParent)).toBeUndefined()
    expect(resolveDraftReplyRef(undefined, () => ({ inReplyTo: '<p@x>' }), findParent)).toBeUndefined()
  })
})
