import { describe, expect, it } from 'vitest'
import {
  hasMoveMissingFolder,
  isMoveMissingFolder,
  toMailRuleDraft,
  toMailRuleDrafts,
} from './mailRuleDrafts'

/** A `rules:list` row, well formed unless a test says otherwise. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rule-1',
    accountId: null,
    name: 'Newsletters',
    enabled: true,
    priority: 3,
    conditions: JSON.stringify([{ field: 'from_address', op: 'contains', value: '@news.test' }]),
    actions: JSON.stringify([{ type: 'archive' }]),
    stopProcessing: false,
    ...overrides,
  }
}

describe('toMailRuleDraft — well-formed rows', () => {
  it('decodes both halves and reports the rule as applicable', () => {
    const draft = toMailRuleDraft(row())
    expect(draft).toEqual({
      id: 'rule-1',
      accountId: null,
      name: 'Newsletters',
      enabled: true,
      priority: 3,
      conditions: [{ field: 'from_address', op: 'contains', value: '@news.test' }],
      actions: [{ type: 'archive' }],
      stopProcessing: false,
      malformed: false,
    })
  })

  it('keeps a rule the policy refuses fully editable', () => {
    // `cc` and the legacy `from` are refused on save, but they are well FORMED:
    // the screen must show their conditions, not an empty editor.
    const draft = toMailRuleDraft(row({
      conditions: JSON.stringify([{ field: 'cc', op: 'not_contains', value: 'boss@corp.test' }]),
      actions: JSON.stringify([{ type: 'trash' }]),
    }))
    expect(draft.malformed).toBe(false)
    expect(draft.conditions).toEqual([{ field: 'cc', op: 'not_contains', value: 'boss@corp.test' }])
    expect(draft.actions).toEqual([{ type: 'trash' }])
  })

  it('reads an empty rule as empty, not as broken', () => {
    const draft = toMailRuleDraft(row({ conditions: '[]', actions: '[]' }))
    expect(draft.malformed).toBe(false)
    expect(draft.conditions).toEqual([])
  })

  it('carries the account scope and the priority through', () => {
    const draft = toMailRuleDraft(row({ accountId: '7', priority: 0, stopProcessing: true }))
    expect(draft.accountId).toBe('7')
    expect(draft.priority).toBe(0)
    expect(draft.stopProcessing).toBe(true)
  })
})

describe('toMailRuleDraft — rows that are not a rule', () => {
  // The row that took the whole Rules tab down: `JSON.parse` succeeded, and
  // `null.length` did the rest.
  it('keeps a row whose conditions decoded to null, and marks it', () => {
    const draft = toMailRuleDraft(row({ id: 'broken-1', name: 'From an assistant', conditions: 'null' }))
    expect(draft.malformed).toBe(true)
    expect(draft.conditions).toEqual([])
    expect(draft.actions).toEqual([])
    // Identity survives — this is what makes disable and delete reachable.
    expect(draft.id).toBe('broken-1')
    expect(draft.name).toBe('From an assistant')
    expect(draft.enabled).toBe(true)
  })

  it('keeps a row whose halves decoded to objects, and marks it', () => {
    // Survived the list and broke the editor at `.map`.
    const draft = toMailRuleDraft(row({ conditions: '{}', actions: '{}' }))
    expect(draft.malformed).toBe(true)
    expect(draft.conditions).toEqual([])
    expect(draft.id).toBe('rule-1')
  })

  it('marks a row whose entries are not condition objects', () => {
    expect(toMailRuleDraft(row({ conditions: '[1,2]' })).malformed).toBe(true)
    expect(toMailRuleDraft(row({ conditions: '[null]' })).malformed).toBe(true)
  })

  it('marks a condition missing the operand the engine compares', () => {
    expect(toMailRuleDraft(row({
      conditions: JSON.stringify([{ field: 'subject', op: 'contains' }]),
    })).malformed).toBe(true)
  })

  it('marks a stored move that names no folder', () => {
    // It used to save quietly, move nothing, and be logged as applied.
    expect(toMailRuleDraft(row({ actions: JSON.stringify([{ type: 'move' }]) })).malformed).toBe(true)
    expect(toMailRuleDraft(row({
      actions: JSON.stringify([{ type: 'move', folder: '  ' }]),
    })).malformed).toBe(true)
  })

  it('marks a row whose actions are not action objects', () => {
    expect(toMailRuleDraft(row({ actions: '[{}]' })).malformed).toBe(true)
    expect(toMailRuleDraft(row({ actions: '"archive"' })).malformed).toBe(true)
  })

  it('marks undecodable JSON and a missing half', () => {
    expect(toMailRuleDraft(row({ conditions: '{oops' })).malformed).toBe(true)
    expect(toMailRuleDraft(row({ conditions: undefined })).malformed).toBe(true)
  })

  it('never throws on a row that is not an object at all', () => {
    const draft = toMailRuleDraft(null)
    expect(draft.malformed).toBe(true)
    expect(draft.id).toBe('')
    expect(draft.enabled).toBe(false)
  })
})

describe('isMoveMissingFolder', () => {
  it('flags a move with no folder at all', () => {
    expect(isMoveMissingFolder({ type: 'move' })).toBe(true)
    expect(isMoveMissingFolder({ type: 'move', folder: '' })).toBe(true)
  })

  it('flags a folder made of whitespace — it addresses no mailbox', () => {
    expect(isMoveMissingFolder({ type: 'move', folder: '   ' })).toBe(true)
    expect(isMoveMissingFolder({ type: 'move', folder: '\t\n' })).toBe(true)
  })

  it('accepts a folder whose name merely contains spaces', () => {
    // A space is legal in an IMAP mailbox name; only the emptiness decision
    // trims, the value itself must reach storage untouched.
    expect(isMoveMissingFolder({ type: 'move', folder: 'Archive 2026' })).toBe(false)
    expect(isMoveMissingFolder({ type: 'move', folder: ' Leading' })).toBe(false)
  })

  it('says nothing about action types that carry no folder', () => {
    expect(isMoveMissingFolder({ type: 'archive' })).toBe(false)
    expect(isMoveMissingFolder({ type: 'trash', folder: '' })).toBe(false)
  })

  it('never throws on a value that is not an action', () => {
    expect(isMoveMissingFolder(null)).toBe(false)
    expect(isMoveMissingFolder('move')).toBe(false)
    expect(isMoveMissingFolder({ type: 'move', folder: 42 })).toBe(true)
  })
})

describe('hasMoveMissingFolder', () => {
  it('is true when any action is an unaddressed move', () => {
    expect(hasMoveMissingFolder([{ type: 'mark_read' }, { type: 'move' }])).toBe(true)
  })

  it('is false for a complete action list', () => {
    expect(hasMoveMissingFolder([{ type: 'mark_read' }, { type: 'move', folder: 'Later' }]))
      .toBe(false)
    expect(hasMoveMissingFolder([])).toBe(false)
  })

  it('is false for something that is not a list of actions', () => {
    expect(hasMoveMissingFolder(undefined)).toBe(false)
    expect(hasMoveMissingFolder({ type: 'move' })).toBe(false)
  })
})

describe('toMailRuleDrafts', () => {
  it('normalises every row and drops none', () => {
    const drafts = toMailRuleDrafts([row({ id: 'a' }), row({ id: 'b', conditions: 'null' })])
    expect(drafts.map(d => d.id)).toEqual(['a', 'b'])
    expect(drafts.map(d => d.malformed)).toEqual([false, true])
  })

  it('treats a reply that is not a list as no rules', () => {
    expect(toMailRuleDrafts(undefined)).toEqual([])
    expect(toMailRuleDrafts({ rules: [] })).toEqual([])
  })
})
