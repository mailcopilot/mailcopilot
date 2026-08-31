// @vitest-environment jsdom
/**
 * §1.26.1(3) — the per-account AI consent grid.
 *
 * Pure functions first (they carry every rule that matters), then the hook via
 * `renderHook` for the wiring between a column click and the four setters the
 * caller owns.
 */
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  useAiConsentMatrix,
  AI_CONSENT_FEATURES,
  consentColumnState,
  isConsentGranted,
  nextColumnValue,
  withColumnConsent,
  withConsent,
  type AiConsentFeature,
  type AiConsentMap,
  type AiConsentValue,
} from './useAiConsentMatrix'

describe('AI_CONSENT_FEATURES', () => {
  it('is exactly the four per-account opt-ins, in grid order', () => {
    expect([...AI_CONSENT_FEATURES]).toEqual([
      'threadSummary',
      'instantReply',
      'proofread',
      'translate',
    ])
  })
})

describe('isConsentGranted', () => {
  it('is false for a missing entry — the default is OFF, not "unknown"', () => {
    expect(isConsentGranted({}, 1)).toBe(false)
  })

  it('is false for an explicit false', () => {
    expect(isConsentGranted({ '1': false }, 1)).toBe(false)
  })

  it('is true only for a strictly-true entry, like the main-side gate', () => {
    expect(isConsentGranted({ '1': true }, 1)).toBe(true)
  })

  it('reads the entry for the asked-for account and no other', () => {
    expect(isConsentGranted({ '2': true }, 1)).toBe(false)
  })
})

describe('consentColumnState', () => {
  it('is `none` when no mailbox has granted it', () => {
    expect(consentColumnState({}, [1, 2, 3])).toBe('none')
    expect(consentColumnState({ '1': false, '2': false }, [1, 2])).toBe('none')
  })

  it('is `all` when every listed mailbox has granted it', () => {
    expect(consentColumnState({ '1': true, '2': true }, [1, 2])).toBe('all')
  })

  it('is `some` in between — the mixed checkbox state', () => {
    expect(consentColumnState({ '1': true, '2': false }, [1, 2])).toBe('some')
  })

  it('is `none` with no mailboxes at all (nothing to grant to)', () => {
    expect(consentColumnState({ '9': true }, [])).toBe('none')
  })

  it('ignores entries for mailboxes the user cannot see', () => {
    // A leftover entry for a deleted account must not make the header claim
    // "partly on" for a set that is entirely off.
    expect(consentColumnState({ '99': true }, [1, 2])).toBe('none')
    expect(consentColumnState({ '1': true, '2': true, '99': false }, [1, 2])).toBe('all')
  })
})

describe('withConsent', () => {
  it('writes one cell and leaves the rest of the map alone', () => {
    expect(withConsent({ '2': true }, 1, true)).toEqual({ '1': true, '2': true })
  })

  it('records a withdrawal as an explicit false, not as a deleted key', () => {
    expect(withConsent({ '1': true }, 1, false)).toEqual({ '1': false })
  })

  it('does not mutate its input', () => {
    const before = { '1': true }
    withConsent(before, 2, true)
    expect(before).toEqual({ '1': true })
  })
})

describe('withColumnConsent', () => {
  it('grants to every listed mailbox', () => {
    expect(withColumnConsent({}, [1, 2, 3], true)).toEqual({ '1': true, '2': true, '3': true })
  })

  it('withdraws from every listed mailbox', () => {
    expect(withColumnConsent({ '1': true, '2': true }, [1, 2], false))
      .toEqual({ '1': false, '2': false })
  })

  it('never rewrites the answer recorded for a mailbox outside the list', () => {
    // A mailbox absent from this render (not loaded, or removed while the
    // window was open) must keep whatever it had.
    expect(withColumnConsent({ '99': true }, [1], true)).toEqual({ '1': true, '99': true })
  })

  it('is a no-op on an empty mailbox list', () => {
    expect(withColumnConsent({ '1': true }, [], true)).toEqual({ '1': true })
  })
})

describe('nextColumnValue — withdrawal is never more than one click', () => {
  it('grants only from a column nobody has granted', () => {
    expect(nextColumnValue('none')).toBe(true)
  })

  it('withdraws from a MIXED column — the half that carries the asymmetry rule', () => {
    // The first shape of this cycle mapped `some` to "grant to everyone", so
    // withdrawing from a mixed column cost two clicks while granting cost one.
    // §2.82: the safe direction may never be the expensive one.
    expect(nextColumnValue('some')).toBe(false)
  })

  it('withdraws when everyone already has it', () => {
    expect(nextColumnValue('all')).toBe(false)
  })

  it('makes withdrawal exactly as cheap as granting (one click each way)', () => {
    const ids = [1, 2, 3]
    const granted = withColumnConsent({}, ids, nextColumnValue(consentColumnState({}, ids)))
    expect(consentColumnState(granted, ids)).toBe('all')
    const withdrawn = withColumnConsent(
      granted,
      ids,
      nextColumnValue(consentColumnState(granted, ids)),
    )
    expect(consentColumnState(withdrawn, ids)).toBe('none')
  })

  it('withdraws from EVERY state in one click, from any starting point', () => {
    const ids = [1, 2, 3]
    const starts: AiConsentMap[] = [
      {},                                        // none
      { '2': true },                             // some
      { '1': true, '2': true, '3': true },       // all
    ]
    for (const start of starts) {
      const state = consentColumnState(start, ids)
      const afterOneClick = withColumnConsent(start, ids, nextColumnValue(state))
      // From `none` the one click grants (there is nothing to withdraw); from
      // `some` and `all` it lands on `none`. Either way nobody has to click
      // twice to say "no".
      const expected = state === 'none' ? 'all' : 'none'
      expect(consentColumnState(afterOneClick, ids)).toBe(expected)
    }
  })

  it('costs granting the extra click when a column is mixed, never withdrawal', () => {
    // The accepted price of the fix, pinned so it is a decision and not a
    // surprise: "finish granting the rest" from a mixed column is two clicks.
    const ids = [1, 2]
    const mixed: AiConsentMap = { '1': true }
    const first = withColumnConsent(mixed, ids, nextColumnValue(consentColumnState(mixed, ids)))
    expect(consentColumnState(first, ids)).toBe('none')
    const second = withColumnConsent(first, ids, nextColumnValue(consentColumnState(first, ids)))
    expect(consentColumnState(second, ids)).toBe('all')
  })
})

describe('granularity — no "everything everywhere" control exists', () => {
  it('exposes no helper that writes more than one feature at a time', async () => {
    // EDPB Guidelines 05/2020: consent is per purpose. A bulk action is offered
    // along the repetitive axis (mailboxes) and never across purposes. This
    // pins that the module has no such export to reach for.
    const mod = await import('./useAiConsentMatrix')
    const writers = Object.keys(mod).filter(k => k.startsWith('with'))
    expect(writers.sort()).toEqual(['withColumnConsent', 'withConsent'])
  })
})

// ---------------------------------------------------------------------------
// The hook: column click → one setter call for one feature.
// ---------------------------------------------------------------------------

const EMPTY: AiConsentValue = {
  threadSummary: {},
  instantReply: {},
  proofread: {},
  translate: {},
}

/**
 * The hook hands the caller an UPDATER, never a finished map (see the module
 * docblock: a batched write must not resolve against a stale snapshot). These
 * assertions therefore run the updater against the map it would really receive,
 * which also keeps them honest if the shape ever regresses.
 */
function applied(
  onChangeFeature: ReturnType<typeof vi.fn>,
  prev: AiConsentMap,
  feature: AiConsentFeature,
): AiConsentMap {
  const call = onChangeFeature.mock.calls.find(c => c[0] === feature)
  expect(call, `no write for ${feature}`).toBeDefined()
  const update = call![1] as unknown
  expect(typeof update).toBe('function')
  return (update as (p: AiConsentMap) => AiConsentMap)(prev)
}

describe('useAiConsentMatrix', () => {
  it('builds a row per mailbox and a cell per feature', async () => {
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2], value: EMPTY, onChangeFeature: vi.fn() }),
    )
    expect(result.current.rows.map(r => r.accountId)).toEqual([1, 2])
    expect(result.current.rows[0].cells.map(c => c.feature)).toEqual([...AI_CONSENT_FEATURES])
    expect(result.current.columns.map(c => c.feature)).toEqual([...AI_CONSENT_FEATURES])
    expect(result.current.accountCount).toBe(2)
  })

  it('a column click writes ONE feature across every mailbox and nothing else', async () => {
    const onChangeFeature = vi.fn()
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2], value: EMPTY, onChangeFeature }),
    )
    result.current.columns.find(c => c.feature === 'translate')!.toggleAll()
    expect(onChangeFeature).toHaveBeenCalledTimes(1)
    expect(onChangeFeature.mock.calls[0][0]).toBe('translate')
    expect(applied(onChangeFeature, EMPTY.translate, 'translate')).toEqual({ '1': true, '2': true })
  })

  it('a cell click writes only that mailbox for that feature', async () => {
    const onChangeFeature = vi.fn()
    const value: AiConsentValue = { ...EMPTY, proofread: { '2': true } }
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2], value, onChangeFeature }),
    )
    result.current.rows[0].cells.find(c => c.feature === 'proofread')!.toggle(true)
    expect(applied(onChangeFeature, value.proofread, 'proofread'))
      .toEqual({ '1': true, '2': true })
  })

  it('a second column click on a fully-granted column withdraws it everywhere', async () => {
    const onChangeFeature = vi.fn()
    const value: AiConsentValue = { ...EMPTY, instantReply: { '1': true, '2': true } }
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2], value, onChangeFeature }),
    )
    expect(result.current.columns.find(c => c.feature === 'instantReply')!.state).toBe('all')
    result.current.columns.find(c => c.feature === 'instantReply')!.toggleAll()
    expect(applied(onChangeFeature, value.instantReply, 'instantReply'))
      .toEqual({ '1': false, '2': false })
  })

  it('never turns a consent on by itself — reading the matrix writes nothing', async () => {
    const onChangeFeature = vi.fn()
    renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2, 3], value: EMPTY, onChangeFeature }),
    )
    expect(onChangeFeature).not.toHaveBeenCalled()
  })

  it('produces no rows and a `none` column state with zero mailboxes', async () => {
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [], value: EMPTY, onChangeFeature: vi.fn() }),
    )
    expect(result.current.rows).toEqual([])
    expect(result.current.accountCount).toBe(0)
    expect(result.current.columns.every(c => c.state === 'none')).toBe(true)
  })

  it('a column toggle on zero mailboxes still calls the setter, with an unchanged empty map', async () => {
    // Not a no-op at the hook boundary — `withColumnConsent` over an empty id
    // list returns the map untouched, but the setter still runs. Pinned so a
    // future short-circuit ("skip the call when there is nothing to touch")
    // does not silently change this contract.
    const onChangeFeature = vi.fn()
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [], value: EMPTY, onChangeFeature }),
    )
    result.current.columns.find(c => c.feature === 'translate')!.toggleAll()
    expect(applied(onChangeFeature, EMPTY.translate, 'translate')).toEqual({})
  })

  it('reports `some` for a column granted by a minority of many mailboxes', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8]
    const value: AiConsentValue = { ...EMPTY, proofread: { '3': true } }
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: ids, value, onChangeFeature: vi.fn() }),
    )
    expect(result.current.rows).toHaveLength(8)
    expect(result.current.accountCount).toBe(8)
    expect(result.current.columns.find(c => c.feature === 'proofread')!.state).toBe('some')
  })

  it('a click on a MIXED column withdraws from everyone, in one click', async () => {
    const onChangeFeature = vi.fn()
    const value: AiConsentValue = { ...EMPTY, translate: { '1': true, '2': false } }
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2], value, onChangeFeature }),
    )
    const col = result.current.columns.find(c => c.feature === 'translate')!
    expect(col.state).toBe('some')
    expect(col.grants).toBe(false)
    col.toggleAll()
    expect(applied(onChangeFeature, value.translate, 'translate'))
      .toEqual({ '1': false, '2': false })
  })

  it('`grants` on every column says what its click would write', async () => {
    const value: AiConsentValue = {
      threadSummary: {},
      instantReply: { '1': true },
      proofread: { '1': true, '2': true },
      translate: {},
    }
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2], value, onChangeFeature: vi.fn() }),
    )
    const byFeature = new Map(result.current.columns.map(c => [c.feature, c]))
    // The header labels itself from this, so a disagreement between `grants`
    // and `nextColumnValue(state)` would be a control that promises one thing
    // and does another.
    for (const col of result.current.columns) {
      expect(col.grants).toBe(nextColumnValue(col.state))
    }
    expect(byFeature.get('threadSummary')!.grants).toBe(true)
    expect(byFeature.get('instantReply')!.grants).toBe(false)
    expect(byFeature.get('proofread')!.grants).toBe(false)
  })

  it('the column write merges into the map it is GIVEN, not the rendered one', async () => {
    // Depth against batched writes: if two updates for one feature coalesce,
    // the second must see the first. A withdrawal recorded between render and
    // flush survives here; a snapshot-based write would resurrect it as `true`.
    const onChangeFeature = vi.fn()
    const value: AiConsentValue = { ...EMPTY, proofread: { '9': true } }
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1], value, onChangeFeature }),
    )
    result.current.columns.find(c => c.feature === 'proofread')!.toggleAll()
    const fresher: AiConsentMap = { '9': false }
    expect(applied(onChangeFeature, fresher, 'proofread')).toEqual({ '9': false, '1': true })
  })

  it('a cell write merges into the map it is GIVEN, not the rendered one', async () => {
    const onChangeFeature = vi.fn()
    const value: AiConsentValue = { ...EMPTY, translate: { '1': true, '2': true } }
    const { result } = renderHook(() =>
      useAiConsentMatrix({ accountIds: [1, 2], value, onChangeFeature }),
    )
    result.current.rows[0].cells.find(c => c.feature === 'translate')!.toggle(false)
    // Mailbox 2 was withdrawn after this render; the pending cell write for
    // mailbox 1 must not put it back.
    expect(applied(onChangeFeature, { '1': true, '2': false }, 'translate'))
      .toEqual({ '1': false, '2': false })
  })
})
