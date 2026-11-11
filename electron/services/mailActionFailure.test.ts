import { describe, expect, it } from 'vitest'
import { markImapOutcomeUndetermined } from '@mailcopilot/core/transportFailure'
import { describeMailActionFailure } from './mailActionFailure'

describe('describeMailActionFailure', () => {
  const aggregate = (errors: unknown[], message = '', extra: object = {}) => Object.assign(new Error(message), { name: 'AggregateError', errors, ...extra })
  const refused = aggregate([Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:993'), { code: 'ECONNREFUSED', syscall: 'connect' })], '')

  it('names the reason, the progress made and the groups that were not attempted', () => {
    const text = describeMailActionFailure({ action: 'archive', accountId: 5, err: refused, affected: 3, notAttempted: 2 })
    expect(text).toBe('Action "archive" stopped for account #5: ECONNREFUSED (connect). Completed before the failure: 3 messages. 2 further folder groups were not attempted.')
  })

  it('does not claim anything about the failed group, and omits the tail when nothing was skipped', () => {
    const text = describeMailActionFailure({ action: 'delete', accountId: 1, err: refused, affected: 1, notAttempted: 0 })
    expect(text).toContain('Completed before the failure: 1 message.')
    expect(text).not.toContain('not attempted')
    expect(text).not.toMatch(/nothing|no message was changed|not changed/i)
  })

  it('carries the outcome-unknown note when the failure struck after a mutating command', () => {
    const err = new Error('Unexpected close')
    markImapOutcomeUndetermined(err)
    expect(describeMailActionFailure({ action: 'archive', accountId: 2, err, affected: 0, notAttempted: 0 })).toContain('outcome unknown')
  })

  it('carries no mailbox content: only the action, the account number and counts', () => {
    const text = describeMailActionFailure({ action: 'archive', accountId: null, err: refused, affected: 0, notAttempted: 0 })
    expect(text).not.toContain('203.0.113.7')
    expect(text).not.toContain('account #')
    // An ordinary error contributes only its class, never its message.
    const plain = describeMailActionFailure({ action: 'archive', accountId: 1, err: new Error('MOVE failed from "Клиенты" at mail.example.org'), affected: 0, notAttempted: 0 })
    expect(plain).not.toMatch(/Клиенты|example\.org/)
  })
})
