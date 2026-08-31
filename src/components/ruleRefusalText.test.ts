import { describe, expect, it } from 'vitest'
import {
  formatMailRuleRefusal,
  mailRuleRefusalError,
  type MailRuleRefusal,
} from '@mailcopilot/core'
import {
  collectRuleRowRefusals,
  findRuleRowRefusal,
  readMailRuleRefusal,
  readRefusedReply,
  ruleApplyRefusalText,
  ruleRefusalReasonText,
  ruleSaveErrorText,
} from './ruleRefusalText'

/**
 * Stub translator: returns `<key>|<a=b,…>` so every assertion can name both the
 * key that was chosen and the values interpolated into it, without depending on
 * the copy itself. Field labels resolve to their own id (the real catalogue
 * localises them).
 */
const t = (key: string, options?: Record<string, unknown>): string => {
  if (key.startsWith('settings.rules.field.') || key.startsWith('settings.rules.action.')) {
    return String(options?.defaultValue ?? key.split('.').pop())
  }
  const args = options
    ? Object.entries(options)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')
    : ''
  return args ? `${key}|${args}` : key
}

describe('readMailRuleRefusal', () => {
  it('recovers the refusal from the error a save path threw', () => {
    const err = mailRuleRefusalError({ reason: 'unsupported_field', field: 'cc' })
    expect(readMailRuleRefusal(err)).toEqual({ reason: 'unsupported_field', field: 'cc' })
  })

  it('survives the tag and envelope the message picks up crossing IPC', () => {
    // What the renderer actually catches, written out literally: Electron's
    // wrapper around the remote method name, then the IPC funnel's `[mcerr:…]`
    // tag, then the original text. The code sits at neither end of it.
    const code = formatMailRuleRefusal({
      reason: 'unverifiable_sender',
      field: 'from',
      action: 'trash',
    })
    const crossed = new Error(
      `Error invoking remote method 'rules:update': Error: [mcerr:unknown] ${code}: mail rule refused`,
    )
    expect(readMailRuleRefusal(crossed)).toEqual({
      reason: 'unverifiable_sender',
      field: 'from',
      action: 'trash',
    })
  })

  it('reads a rejection that arrived as a plain object', () => {
    const value = { message: formatMailRuleRefusal({ reason: 'unsupported_field', field: 'cc' }) }
    expect(readMailRuleRefusal(value)).toEqual({ reason: 'unsupported_field', field: 'cc' })
  })

  it('returns null for an unrelated failure', () => {
    expect(readMailRuleRefusal(new Error('ECONNRESET'))).toBeNull()
    expect(readMailRuleRefusal(undefined)).toBeNull()
  })
})

describe('readRefusedReply', () => {
  it('accepts the shape rules:applyToFolder replies with', () => {
    expect(readRefusedReply({ reason: 'unverifiable_sender', field: 'from', action: 'move' }))
      .toEqual({ reason: 'unverifiable_sender', field: 'from', action: 'move' })
  })

  it('accepts the structural verdict, which carries no field to blame', () => {
    expect(readRefusedReply({ reason: 'malformed_rule', field: 'unknown' })).toEqual({
      reason: 'malformed_rule',
      field: 'unknown',
    })
  })

  it('rejects a reason it does not know rather than trusting it', () => {
    expect(readRefusedReply({ reason: 'because', field: 'cc' })).toBeNull()
    expect(readRefusedReply(null)).toBeNull()
    expect(readRefusedReply('unsupported_field')).toBeNull()
  })

  it('degrades a missing field name instead of dropping the refusal', () => {
    expect(readRefusedReply({ reason: 'unsupported_field' })).toEqual({
      reason: 'unsupported_field',
      field: 'unknown',
    })
  })
})

describe('ruleRefusalReasonText', () => {
  it('explains a structurally broken rule without naming a field', () => {
    // The verdict is about the whole rule and core reports `field: 'unknown'`
    // for it, so copy built around the field name would read "the unknown
    // field". It also must not collapse into the catch-all sentence.
    const text = ruleRefusalReasonText(t, { reason: 'malformed_rule', field: 'unknown' })
    expect(text).toBe('settings.rules.refusal.malformedRule')
    expect(text).not.toBe('settings.rules.refusal.unknown')
  })

  it('still has a sentence for a reason this build has never heard of', () => {
    // A newer main process may refuse for something new; a vague sentence beats
    // an empty dialog or a raw machine code.
    const future = { reason: 'newly_invented', field: 'subject' } as unknown as MailRuleRefusal
    expect(ruleRefusalReasonText(t, future)).toBe('settings.rules.refusal.unknown')
  })

  it('names the field the client cannot answer about', () => {
    expect(ruleRefusalReasonText(t, { reason: 'unsupported_field', field: 'cc' }))
      .toBe('settings.rules.refusal.unsupportedField|field=cc')
  })

  it('names the field, the action and the field to use instead', () => {
    expect(
      ruleRefusalReasonText(t, { reason: 'unverifiable_sender', field: 'from', action: 'trash' }),
    ).toBe(
      'settings.rules.refusal.unverifiableSender|field=from,action=trash,suggestion=from_address',
    )
  })

  it('falls back when the sender refusal arrived without its action', () => {
    expect(ruleRefusalReasonText(t, { reason: 'unverifiable_sender', field: 'from' }))
      .toBe('settings.rules.refusal.unknown')
  })
})

describe('ruleSaveErrorText', () => {
  it('explains a refusal in full', () => {
    const err = mailRuleRefusalError({ reason: 'unsupported_field', field: 'cc' })
    expect(ruleSaveErrorText(t, err)).toBe(
      'settings.rules.saveRefused|reason=settings.rules.refusal.unsupportedField|field=cc',
    )
  })

  it('explains a rule refused for its shape, not for its policy', () => {
    // What an assistant's malformed rule produces end to end.
    const err = mailRuleRefusalError({ reason: 'malformed_rule', field: 'unknown' })
    expect(ruleSaveErrorText(t, err)).toBe(
      'settings.rules.saveRefused|reason=settings.rules.refusal.malformedRule',
    )
  })

  it('keeps the generic wording for a failure that is not a refusal', () => {
    expect(ruleSaveErrorText(t, new Error('database is locked')))
      .toBe('settings.rules.saveFailed')
  })
})

describe('ruleApplyRefusalText', () => {
  it('says the rule exists but did not run, and why', () => {
    expect(ruleApplyRefusalText(t, { reason: 'unsupported_field', field: 'cc' })).toBe(
      'settings.rules.applyRefused|reason=settings.rules.refusal.unsupportedField|field=cc',
    )
  })

  it('still reports a refusal whose reason it cannot read', () => {
    // Silence here is the failure mode this exists to avoid: the alternative
    // reads as "0 messages matched".
    expect(ruleApplyRefusalText(t, { reason: 'novel' })).toBe(
      'settings.rules.applyRefused|reason=settings.rules.refusal.unknown',
    )
  })
})

// ---------------------------------------------------------------------------
// §2.202 — the verdict on a rule that is already stored.
// ---------------------------------------------------------------------------

/** A `rules:list` row as main sends it: identity fields plus two JSON halves. */
function row(conditions: unknown[], actions: unknown[], id = 'r1'): Record<string, unknown> {
  return {
    id,
    accountId: null,
    name: 'rule',
    enabled: true,
    priority: 0,
    conditions: JSON.stringify(conditions),
    actions: JSON.stringify(actions),
    stopProcessing: false,
  }
}

describe('§2.202 findRuleRowRefusal', () => {
  it('refuses a destructive action gated on the sender-written display name', () => {
    const refusal = findRuleRowRefusal(
      row([{ field: 'from_name', op: 'contains', value: 'Bank' }], [{ type: 'trash' }]),
    )
    expect(refusal).toEqual({
      reason: 'unverifiable_sender',
      field: 'from_name',
      action: 'trash',
    })
  })

  it('refuses a condition on a field the client never stores', () => {
    const refusal = findRuleRowRefusal(
      row([{ field: 'cc', op: 'contains', value: 'team@example.test' }], [{ type: 'mark_read' }]),
    )
    expect(refusal).toEqual({ reason: 'unsupported_field', field: 'cc' })
  })

  // NEGATIVE CONTROL — the badge must not appear on a rule that runs fine.
  it('returns null for a rule the client can apply', () => {
    expect(
      findRuleRowRefusal(
        row([{ field: 'from_address', op: 'contains', value: '@example.test' }], [{ type: 'archive' }]),
      ),
    ).toBeNull()
  })

  it('returns null for the display name gating a reversible action', () => {
    // The policy is about justifying DESTRUCTIVE actions; `mark_read` is not
    // one, so a display-name condition stays legal and unmarked.
    expect(
      findRuleRowRefusal(
        row([{ field: 'from_name', op: 'contains', value: 'Bank' }], [{ type: 'mark_read' }]),
      ),
    ).toBeNull()
  })

  it('reports the structural verdict for halves that are not a rule', () => {
    expect(findRuleRowRefusal({ id: 'r1', conditions: 'null', actions: '[]' }))
      .toEqual({ reason: 'malformed_rule', field: 'unknown' })
    expect(findRuleRowRefusal({ id: 'r1' }))
      .toEqual({ reason: 'malformed_rule', field: 'unknown' })
  })

  it('has no verdict about something that is not a row', () => {
    expect(findRuleRowRefusal(null)).toBeNull()
    expect(findRuleRowRefusal('rule')).toBeNull()
    expect(findRuleRowRefusal(undefined)).toBeNull()
  })

  it('has no verdict about a rule with no conditions and no actions', () => {
    // Empty halves are structurally valid — a rule under construction, or one
    // whose parts were removed. The list must show its counts, not a badge:
    // "0 conditions, 0 actions" says what is wrong far better than "not
    // applied", which would claim a policy refusal that did not happen.
    expect(findRuleRowRefusal(row([], []))).toBeNull()
  })

  it('keeps the canonical order of the two verdicts a rule can earn at once', () => {
    // This rule breaks both policies: `cc` is a field the client never stores,
    // AND a destructive action rests on the sender-written display name. Which
    // one the user is told about is decided in packages/core (unsupported field
    // first) — asserted here so the wrapper can never be "fixed" into reporting
    // the other one and quietly disagree with what the save path says.
    const refusal = findRuleRowRefusal(
      row(
        [
          { field: 'cc', op: 'contains', value: 'team@example.test' },
          { field: 'from_name', op: 'contains', value: 'Bank' },
        ],
        [{ type: 'trash' }],
      ),
    )
    expect(refusal).toEqual({ reason: 'unsupported_field', field: 'cc' })
  })
})

describe('§2.202 collectRuleRowRefusals', () => {
  it('keys the verdicts by rule id and omits the rules that pass', () => {
    const refused = row([{ field: 'from', op: 'contains', value: 'Bank' }], [{ type: 'archive' }], 'bad')
    const fine = row([{ field: 'subject', op: 'contains', value: 'invoice' }], [{ type: 'archive' }], 'good')

    const refusals = collectRuleRowRefusals([fine, refused])
    expect([...refusals.keys()]).toEqual(['bad'])
    expect(refusals.get('bad')).toEqual({ reason: 'unverifiable_sender', field: 'from', action: 'archive' })
  })

  it('yields nothing for a reply that is not a list', () => {
    expect(collectRuleRowRefusals(null).size).toBe(0)
    expect(collectRuleRowRefusals({ rules: [] }).size).toBe(0)
  })

  it('skips an entry that is not a row instead of throwing on it', () => {
    // A defensive read, not a validated one: `rules:list` is a reply crossing
    // IPC, and one unreadable entry must not cost the verdicts for the rest.
    const refused = row([{ field: 'from', op: 'contains', value: 'Bank' }], [{ type: 'trash' }], 'bad')
    const refusals = collectRuleRowRefusals([null, 'not a row', 42, refused])
    expect([...refusals.keys()]).toEqual(['bad'])
  })

  it('files no verdict for a row whose id cannot be read', () => {
    // A refusal is only useful if it can be pointed at ONE rule. A row with a
    // non-string or missing id has no such handle, and the previous shape filed
    // it under the empty string — which every such row shares.
    const missingId = row([{ field: 'cc', op: 'contains', value: 'x' }], [{ type: 'mark_read' }])
    delete missingId.id
    const numericId = { id: 7, conditions: 'null', actions: '[]' }
    const emptyId = row([{ field: 'cc', op: 'contains', value: 'x' }], [{ type: 'mark_read' }], '')

    expect(collectRuleRowRefusals([missingId, numericId, emptyId]).size).toBe(0)
  })

  it('does not let one unidentifiable rule mark another one', () => {
    // The failure this replaces: both rows render with the empty-string id, so
    // the refused one's verdict was looked up by the HEALTHY one and badged it.
    const refusedNoId = row([{ field: 'cc', op: 'contains', value: 'x' }], [{ type: 'mark_read' }])
    delete refusedNoId.id
    const healthyNoId = row(
      [{ field: 'subject', op: 'contains', value: 'invoice' }],
      [{ type: 'archive' }],
    )
    delete healthyNoId.id

    const refusals = collectRuleRowRefusals([refusedNoId, healthyNoId])
    expect(refusals.size).toBe(0)
    expect(refusals.get('')).toBeUndefined()
  })

  it('answers nothing for ids that name a member of Object.prototype', () => {
    // A rule id is data off the wire, and `rules:list` will happily carry
    // `toString` or `__proto__`. On a plain object those lookups return an
    // inherited member — truthy, so the healthy rule gets a badge, and then a
    // non-refusal object reaches the copy builder.
    const healthy = (id: string) =>
      row([{ field: 'subject', op: 'contains', value: 'invoice' }], [{ type: 'archive' }], id)

    const refusals = collectRuleRowRefusals([
      healthy('toString'),
      healthy('constructor'),
      healthy('__proto__'),
      healthy('hasOwnProperty'),
    ])

    expect(refusals.size).toBe(0)
    for (const id of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(refusals.get(id)).toBeUndefined()
    }
  })

  it('still files a real verdict under an id that names a prototype member', () => {
    // The other half of the guard: skipping such ids entirely would lose a
    // genuine refusal. A `Map` keeps them as ordinary keys.
    const refusals = collectRuleRowRefusals([
      row([{ field: 'cc', op: 'contains', value: 'x' }], [{ type: 'mark_read' }], '__proto__'),
    ])
    expect(refusals.get('__proto__')).toEqual({ reason: 'unsupported_field', field: 'cc' })
  })
})
