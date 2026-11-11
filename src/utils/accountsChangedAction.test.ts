import { describe, expect, it } from 'vitest'
import { decideAccountsChangedAction } from './accountsChangedAction'

const saved = (id: number) => ({ kind: 'saved', id })

describe('decideAccountsChangedAction', () => {
  it('first mailbox: a save while no mailbox is chosen runs the initial load', () => {
    expect(decideAccountsChangedAction(saved(1), { currentAccountId: null, knownAccountIds: [] })).toBe('init')
  })

  it('later mailboxes and edits: a save refreshes metadata only', () => {
    expect(decideAccountsChangedAction(saved(2), { currentAccountId: 1, knownAccountIds: [1] })).toBe('refresh-saved')
    expect(decideAccountsChangedAction(saved(1), { currentAccountId: 1, knownAccountIds: [1] })).toBe('refresh-saved')
  })

  it('the last mailbox was removed and a new one is added in the same session: the initial load runs', () => {
    // After the removal the window kept the old current id but its account
    // list is empty (the load stops early); the save is the "first" mailbox.
    expect(decideAccountsChangedAction(saved(2), { currentAccountId: 1, knownAccountIds: [] })).toBe('init')
  })

  it('the chosen mailbox is no longer among the known ones: the initial load runs', () => {
    expect(decideAccountsChangedAction(saved(3), { currentAccountId: 1, knownAccountIds: [2] })).toBe('init')
  })

  it('a current-account switch is followed locally', () => {
    expect(decideAccountsChangedAction({ kind: 'current', id: 2 }, { currentAccountId: 1, knownAccountIds: [1, 2] })).toBe('switch-current')
    expect(decideAccountsChangedAction({ kind: 'current', id: 1 }, { currentAccountId: null, knownAccountIds: [] })).toBe('switch-current')
  })

  it('removal and malformed payloads fall back to the initial load', () => {
    const state = { currentAccountId: 1, knownAccountIds: [1] }
    expect(decideAccountsChangedAction({ kind: 'removed', id: 2 }, state)).toBe('init')
    expect(decideAccountsChangedAction({ kind: 'saved' }, state)).toBe('init')
    expect(decideAccountsChangedAction({ kind: 'saved', id: 0 }, state)).toBe('init')
    expect(decideAccountsChangedAction(undefined, state)).toBe('init')
    expect(decideAccountsChangedAction('x', { currentAccountId: null, knownAccountIds: [] })).toBe('init')
  })
})
