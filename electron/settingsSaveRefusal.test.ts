import { describe, it, expect, vi } from 'vitest'

// `packages/net/config` transitively reaches `packages/db`, which opens SQLite
// at module load — fatal under the CI `unit-tests` job where better-sqlite3 is
// built for the Electron ABI. Only `deleteAccountData` is actually used from
// there by config.ts; the schemas themselves stay REAL, because the point of
// the suite below is that the refusal is derived from the schema the handler
// runs, not from a re-statement of it.
vi.mock('../packages/db', () => ({ deleteAccountData: vi.fn() }))

import {
  partitionRendererSettingsIssues,
  stripRefusedFields,
  dropErasingUndefined,
  SETTINGS_REFUSAL_CODES,
  SETTINGS_REFUSABLE_FIELDS,
  UNERASABLE_SETTINGS_FIELDS,
  MAX_REFUSED_VALUES,
  MAX_REFUSED_VALUE_LENGTH,
  type RefusedSettingsField,
} from './settingsSaveRefusal'
import { AI_DESTINATION_FIELDS } from './services/aiDestination'
import { DOMAINS } from './metricsSchema'
import {
  rendererWritableSettingsSchema,
  settingsSchema,
  MAIN_ONLY_SETTINGS_FIELDS,
  EXPORTABLE_MCP_TOOLS,
} from '../packages/net/config'

/**
 * §2.167 — `settings:save` refuses the offending FIELD instead of quietly
 * accepting an out-of-domain value (or, for a main-only field, instead of
 * anything at all).
 *
 * electron/main.ts cannot be imported in a unit test (module-level side
 * effects: window creation, IPC registration, DB open), so the handler ORDER
 * is asserted against the source in main.settingsClamp.test.ts. What this
 * suite owns is the decision itself, driven through the very schemas the
 * handler uses.
 */

/** A settings record that parses, to merge onto — the handler's `current`. */
function persistedSettings(overrides: Record<string, unknown> = {}) {
  return settingsSchema.parse({ theme: 'light', language: 'en', ...overrides })
}

/** The steps the handler performs between validation and the merge. */
function classify(payload: unknown) {
  const parsed = rendererWritableSettingsSchema.safeParse(payload)
  const { forbidden, refusedFields, unhandledFields } = partitionRendererSettingsIssues(
    parsed.success ? [] : parsed.error.issues,
    payload,
  )
  return {
    forbidden,
    refusedFields,
    unhandledFields,
    mainOnlyHit: forbidden.some(k => (MAIN_ONLY_SETTINGS_FIELDS as readonly string[]).includes(k)),
    // §2.218.f2 — the handler throws on this before merging anything. Exposed
    // here so a test can assert "this payload never reaches the merge".
    wholeSaveRefused: unhandledFields.length > 0,
    // Same composition as `settings:save`: refused fields out, then explicit
    // `undefined` read as omission for the fields it may not erase.
    accepted: dropErasingUndefined(stripRefusedFields(payload, refusedFields)),
  }
}

/**
 * What the handler would persist if it DID reach the merge — i.e. what the
 * whole-save refusal above is preventing. Mirrors
 * `settingsSchema.parse({ ...current, ...accepted })`.
 */
function mergeAndPersist(payload: unknown, current = persistedSettings()) {
  const { accepted } = classify(payload)
  return settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })
}

describe('partitionRendererSettingsIssues', () => {
  it('refuses only mcpExportWhitelist when it carries an unknown tool name', () => {
    const { forbidden, refusedFields, mainOnlyHit, accepted } = classify({
      mcpExportWhitelist: ['get_email', 'legacy_tool_from_an_older_build'],
      sortMode: 'from',
      mcpExportPort: 24000,
    })

    expect(forbidden).toEqual([])
    expect(mainOnlyHit).toBe(false)
    expect(refusedFields).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: ['legacy_tool_from_an_older_build'],
    }])
    // The offending field is gone; nothing else is touched.
    expect(accepted).toEqual({ sortMode: 'from', mcpExportPort: 24000 })
  })

  it('reports the refusal once, naming every entry that was out of domain', () => {
    // One line per FIELD (that is the granularity of the strip), but the line
    // carries all the names — the renderer repairs its state from them, so a
    // missing one would leave the loop the item exists to end.
    const { refusedFields } = classify({
      mcpExportWhitelist: ['nope_one', 'get_email', 'nope_two', 'nope_three'],
    })
    expect(refusedFields).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: ['nope_one', 'nope_two', 'nope_three'],
    }])
    // The names that WERE in domain stay out of the refusal.
    expect(refusedFields[0].values).not.toContain('get_email')
  })

  it('collapses a name repeated in the same array', () => {
    const { refusedFields } = classify({
      mcpExportWhitelist: ['nope_one', 'nope_one', 'nope_two', 'nope_one'],
    })
    expect(refusedFields[0].values).toEqual(['nope_one', 'nope_two'])
  })

  it('refuses the field but names nothing when the entry is not a string', () => {
    // A number in a `string[]` is corrupt persisted data, not a name: echoing
    // `"42"` would hand the renderer something that matches no entry it holds.
    const { refusedFields, accepted } = classify({ mcpExportWhitelist: [42, 'get_email'] })
    expect(refusedFields).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: [],
    }])
    // The refusal is real regardless: the field is still dropped.
    expect(accepted).toEqual({})
  })

  it('omits an overlong entry instead of truncating it', () => {
    const long = 'x'.repeat(MAX_REFUSED_VALUE_LENGTH + 1)
    const { refusedFields } = classify({ mcpExportWhitelist: [long, 'nope'] })
    // A cut-off string looks like a name and equals nothing, so the renderer
    // would keep re-submitting the entry it thinks it removed.
    expect(refusedFields[0].values).toEqual(['nope'])
  })

  it('keeps an entry exactly at the length cap', () => {
    const atCap = 'y'.repeat(MAX_REFUSED_VALUE_LENGTH)
    const { refusedFields } = classify({ mcpExportWhitelist: [atCap] })
    expect(refusedFields[0].values).toEqual([atCap])
  })

  it('stops naming values past the count cap, but still refuses the field', () => {
    // The array is renderer-writable: without a cap a compromised window makes
    // main mirror an unbounded payload back at it.
    const many = Array.from({ length: MAX_REFUSED_VALUES + 25 }, (_, i) => `nope_${i}`)
    const { refusedFields, accepted } = classify({ mcpExportWhitelist: many })
    expect(refusedFields).toHaveLength(1)
    expect(refusedFields[0].values).toHaveLength(MAX_REFUSED_VALUES)
    expect(refusedFields[0].values[0]).toBe('nope_0')
    expect(accepted).toEqual({})
  })

  it('does not let skipped entries eat the naming quota', () => {
    // The cap counts what was NAMED, not what was seen. Order matters here:
    // the entries that cannot be named (non-strings, overlong ones) come FIRST,
    // so a cap applied to "issues processed" instead of "values collected"
    // would silently swallow every real name behind them — the settings window
    // would be told the field is bad and given nothing to repair it with, which
    // is the permanent-refusal loop §2.167 exists to end.
    const unnameable = [
      ...Array.from({ length: 100 }, (_, i) => i),
      ...Array.from({ length: 50 }, () => 'z'.repeat(MAX_REFUSED_VALUE_LENGTH + 1)),
    ]
    const nameable = Array.from({ length: MAX_REFUSED_VALUES }, (_, i) => `nope_${i}`)
    const { refusedFields, accepted } = classify({
      mcpExportWhitelist: [...unnameable, ...nameable],
    })
    expect(refusedFields).toHaveLength(1)
    expect(refusedFields[0].values).toEqual(nameable)
    // The field is refused whole either way.
    expect(accepted).toEqual({})
  })

  it('names nothing when the issue path runs through a symbol', () => {
    // Defensive: `readIssuePathValue` refuses to index by symbol rather than
    // reaching for whatever a symbol-keyed property might hold. The field is
    // still refused — only the naming is skipped.
    expect(partitionRendererSettingsIssues(
      [{ code: 'invalid_value', path: ['mcpExportWhitelist', Symbol('0')] }],
      { mcpExportWhitelist: ['legacy_tool'] },
    ).refusedFields).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: [],
    }])
  })

  it('makes no per-field refusal for an issue whose top-level path segment is a symbol', () => {
    // A refusal is a promise to strip a NAMED field from the payload; a symbol
    // names nothing `stripRefusedFields` could delete, so there is no per-field
    // verdict available.
    //
    // §2.218.f2 — but "cannot be refused per-field" is not "can be ignored".
    // Being unable to name the offending field is exactly the case where
    // partial application is impossible, so it joins `unhandledFields` and the
    // handler kills the whole save. Fail-closed, and unreachable in practice:
    // zod's path[0] for our object schema is always a string key.
    expect(partitionRendererSettingsIssues(
      [{ code: 'invalid_value', path: [Symbol('mcpExportWhitelist'), 0] }],
      { mcpExportWhitelist: ['legacy_tool'] },
    )).toEqual({ forbidden: [], refusedFields: [], unhandledFields: ['(non-string path)'] })
  })

  it('invents no forbidden key when unrecognized_keys carries a non-array', () => {
    // `keys` is read off a zod issue, and the §3.10 P0 gate acts on what comes
    // out of here. Anything but an array of strings must produce nothing rather
    // than a guess: a fabricated key would either kill an honest payload (if it
    // happened to match a main-only name) or be audited as an attempt nobody
    // made.
    for (const keys of ['mcpEnableStdio', { 0: 'mcpEnableStdio' }, 42, null, undefined]) {
      expect(partitionRendererSettingsIssues([
        { code: 'unrecognized_keys', path: [], keys },
      ])).toEqual({ forbidden: [], refusedFields: [], unhandledFields: [] })
    }
  })

  it('reports the refusal without values when the payload is not supplied', () => {
    // The classifier stays usable as a pure function of the issues; the values
    // are an addition to the verdict, never a precondition for it.
    const parsed = rendererWritableSettingsSchema.safeParse({ mcpExportWhitelist: ['legacy_tool'] })
    const { refusedFields } = partitionRendererSettingsIssues(parsed.success ? [] : parsed.error.issues)
    expect(refusedFields).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: [],
    }])
  })

  it('names nothing when the issue path does not lead into the payload', () => {
    // Defensive: a mismatched (issue, payload) pair must not invent a value.
    expect(partitionRendererSettingsIssues(
      [{ code: 'invalid_value', path: ['mcpExportWhitelist', 7] }],
      { mcpExportWhitelist: ['get_email'] },
    ).refusedFields[0].values).toEqual([])
    // Nor may it walk a prototype chain to find one.
    expect(partitionRendererSettingsIssues(
      [{ code: 'invalid_value', path: ['mcpExportWhitelist', 'constructor'] }],
      { mcpExportWhitelist: ['get_email'] },
    ).refusedFields[0].values).toEqual([])
  })

  it('answers a main-only field with `forbidden`, never with a per-field refusal', () => {
    for (const field of MAIN_ONLY_SETTINGS_FIELDS) {
      const { forbidden, refusedFields, mainOnlyHit } = classify({ [field]: true, sortMode: 'from' })
      expect(forbidden).toContain(field)
      expect(mainOnlyHit).toBe(true)
      // Partial application must NOT be extended to the §3.10 P0 gate: a
      // main-only key produces nothing the handler could strip and continue on.
      expect(refusedFields).toEqual([])
    }
  })

  it('still reports the main-only key when an unknown tool name rides along', () => {
    // The handler acts on `forbidden` first, so the whole payload dies. The
    // per-field verdict existing alongside it must not change that — see the
    // order assertions in main.settingsClamp.test.ts.
    const { forbidden, mainOnlyHit, refusedFields } = classify({
      mcpEnableStdio: true,
      mcpExportWhitelist: ['legacy_tool'],
    })
    expect(mainOnlyHit).toBe(true)
    expect(forbidden).toEqual(['mcpEnableStdio'])
    expect(refusedFields).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: ['legacy_tool'],
    }])
  })

  it('leaves a valid payload completely alone', () => {
    const payload = { mcpExportWhitelist: ['get_email', 'list_folders'], sortMode: 'from' }
    const { forbidden, refusedFields, accepted } = classify(payload)
    expect(forbidden).toEqual([])
    expect(refusedFields).toEqual([])
    expect(accepted).toBe(payload)
  })

  it('does not refuse failures outside the allowlist — they keep throwing', () => {
    // A bad enum on another field is neither forbidden nor refusable: nothing
    // is stripped, no value is echoed, and `settingsSchema.parse` below is what
    // says no.
    const { forbidden, refusedFields, accepted } = classify({ sortMode: 'sideways' })
    expect(forbidden).toEqual([])
    expect(refusedFields).toEqual([])
    expect(accepted).toEqual({ sortMode: 'sideways' })
    expect(() => settingsSchema.parse({ ...persistedSettings(), sortMode: 'sideways' })).toThrow()
  })

  it('does not refuse a wrong TYPE for the refusable field', () => {
    // `unknown_export_tool` would misdescribe "not an array at all", which is a
    // renderer bug rather than stale persisted data. The old throwing path owns
    // it, so there is no refusal — and therefore no `values` — at all.
    const { refusedFields, accepted } = classify({ mcpExportWhitelist: 'get_email' })
    expect(refusedFields).toEqual([])
    // Nothing stripped: the payload still reaches `settingsSchema.parse`…
    expect(accepted).toEqual({ mcpExportWhitelist: 'get_email' })
    // …which is what says no.
    expect(() => settingsSchema.parse({
      ...persistedSettings(),
      mcpExportWhitelist: 'get_email',
    })).toThrow()
  })

  it('makes no per-field refusal for issues that are not about a top-level field', () => {
    // §2.218.f2 — the first two produce no per-field verdict (nothing nameable
    // to strip) and therefore land in `unhandledFields`, which the handler turns
    // into a whole-save refusal. A ROOT-level `invalid_type` (path `[]`) is the
    // reachable one: it is what a non-object payload produces, and it used to be
    // a silent no-op — `{ ...current, ...42 }` spreads to nothing, the persisted
    // parse succeeded on the unchanged record and the renderer got `{ ok: true }`
    // for a save that never happened. Both collapse to the single
    // `(non-string path)` bucket because neither carries a field name.
    //
    // `unrecognized_keys` keeps its own route (`forbidden`), where the §3.10 P0
    // gate judges it — an unknown key that is NOT main-only still falls through
    // to the soft persistent schema and is discarded silently, as it was long
    // before §2.167.
    expect(partitionRendererSettingsIssues([
      { code: 'invalid_type', path: [] },
      { code: 'invalid_value', path: [0, 'mcpExportWhitelist'] },
      { code: 'unrecognized_keys', path: [], keys: ['mcpEnableStdio', 42] },
    ])).toEqual({
      forbidden: ['mcpEnableStdio'],
      refusedFields: [],
      unhandledFields: ['(non-string path)'],
    })
  })

  it('emits machine codes and the sender\'s own input — never zod text', () => {
    const payload = { mcpExportWhitelist: ['legacy_tool'] }
    const parsed = rendererWritableSettingsSchema.safeParse(payload)
    expect(parsed.success).toBe(false)
    const { refusedFields } = partitionRendererSettingsIssues(
      parsed.success ? [] : parsed.error.issues,
      payload,
    )
    expect(refusedFields).toHaveLength(1)
    for (const refused of refusedFields) {
      expect(SETTINGS_REFUSAL_CODES).toContain(refused.code)
      const encoded = JSON.stringify(refused)
      // Zod's message quotes the offending value AND enumerates the whole
      // allowed domain; neither wording belongs in a reply of ours.
      expect(encoded).not.toContain('Invalid option')
      expect(encoded).not.toContain('expected one of')
      // The domain itself is not disclosed: only what the sender submitted.
      expect(refused.values).toEqual(['legacy_tool'])
      expect(encoded).not.toContain('get_email')
    }
  })

  it('echoes only entries the caller actually submitted', () => {
    // A `values` member that is not in the payload would mean main invented (or
    // leaked) a name. Property-style check over a mixed array.
    const payload = {
      mcpExportWhitelist: ['get_email', 'nope_one', 7, 'list_folders', 'nope_two', 'nope_one'],
    }
    const parsed = rendererWritableSettingsSchema.safeParse(payload)
    const { refusedFields } = partitionRendererSettingsIssues(
      parsed.success ? [] : parsed.error.issues,
      payload,
    )
    for (const value of refusedFields[0].values) {
      expect(payload.mcpExportWhitelist).toContain(value)
      expect(EXPORTABLE_MCP_TOOLS as readonly string[]).not.toContain(value)
    }
    expect(refusedFields[0].values).toEqual(['nope_one', 'nope_two'])
  })
})

describe('stripRefusedFields', () => {
  const refused: RefusedSettingsField[] = [
    { field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: ['legacy_tool'] },
  ]

  it('keeps a key the renderer sent as an explicit undefined', () => {
    // §2.119 reads "carried as undefined" as "cleared input", i.e. a request to
    // move the AI destination. Rebuilding from defined entries would erase it.
    const payload = { aiOpenAiBaseUrl: undefined, mcpExportWhitelist: ['legacy_tool'] }
    const accepted = stripRefusedFields(payload, refused) as Record<string, unknown>
    expect('aiOpenAiBaseUrl' in accepted).toBe(true)
    expect('mcpExportWhitelist' in accepted).toBe(false)
  })

  it('does not mutate the payload it was given', () => {
    const payload = { mcpExportWhitelist: ['legacy_tool'] }
    stripRefusedFields(payload, refused)
    expect(payload.mcpExportWhitelist).toEqual(['legacy_tool'])
  })

  it('returns non-object payloads untouched', () => {
    expect(stripRefusedFields(null, refused)).toBe(null)
    expect(stripRefusedFields('nonsense', refused)).toBe('nonsense')
    const arr = ['a']
    expect(stripRefusedFields(arr, refused)).toBe(arr)
  })

  it('returns the same reference when there is nothing to refuse', () => {
    const payload = { sortMode: 'from' }
    expect(stripRefusedFields(payload, [])).toBe(payload)
  })
})

// §2.167 branch C (codex, high) — a key PRESENT with `undefined` is not the
// same as an absent key to the merge that follows: the first overwrites the
// persisted value with `undefined`, which `saveSettings` drops from disk. For
// `mcpExportWhitelist` that turns "leave the stored list alone" into a WIDER
// exported tool surface on the next start, because `resolveExportWhitelist`
// reads a nullish value as "no preference" and serves the default set.
describe('dropErasingUndefined', () => {
  it('drops an explicit undefined on a field whose absence widens a surface', () => {
    const accepted = dropErasingUndefined({
      mcpExportWhitelist: undefined,
      sortMode: 'from',
    }) as Record<string, unknown>
    expect('mcpExportWhitelist' in accepted).toBe(false)
    expect(accepted.sortMode).toBe('from')
  })

  it('keeps an explicit empty array — "export nothing" is a value, not an absence', () => {
    const accepted = dropErasingUndefined({ mcpExportWhitelist: [] }) as Record<string, unknown>
    expect(accepted.mcpExportWhitelist).toEqual([])
  })

  it('keeps an explicit undefined on every other field', () => {
    // The three live clears on this channel: a cleared AI endpoint / proxy
    // (§2.119), the "Reset AI provider" payload, and an emptied trusted-domain
    // list. A blanket "drop every undefined" would no-op all of them.
    const accepted = dropErasingUndefined({
      aiOpenAiBaseUrl: undefined,
      aiProxyUrl: undefined,
      aiProvider: undefined,
      trustedDomains: undefined,
    }) as Record<string, unknown>
    for (const field of ['aiOpenAiBaseUrl', 'aiProxyUrl', 'aiProvider', 'trustedDomains']) {
      expect(field in accepted).toBe(true)
    }
  })

  it('does not mutate the payload it was given', () => {
    const payload = { mcpExportWhitelist: undefined, sortMode: 'from' }
    dropErasingUndefined(payload)
    expect('mcpExportWhitelist' in payload).toBe(true)
  })

  it('returns the same reference when nothing matched', () => {
    const payload = { mcpExportWhitelist: ['get_email'] }
    expect(dropErasingUndefined(payload)).toBe(payload)
  })

  it('returns non-object payloads untouched', () => {
    expect(dropErasingUndefined(null)).toBe(null)
    expect(dropErasingUndefined('nonsense')).toBe('nonsense')
    const arr = ['a']
    expect(dropErasingUndefined(arr)).toBe(arr)
  })

  it('ignores an inherited key of the same name', () => {
    const payload = Object.create({ mcpExportWhitelist: undefined }) as Record<string, unknown>
    payload.sortMode = 'from'
    expect(dropErasingUndefined(payload)).toBe(payload)
  })

  it('names only fields the renderer may write', () => {
    // A field outside the writable subset never reaches this pass: such a key
    // is `unrecognized_keys`, i.e. the §3.10 P0 whole-payload path.
    const writable = Object.keys(rendererWritableSettingsSchema.shape)
    for (const field of UNERASABLE_SETTINGS_FIELDS) expect(writable).toContain(field)
  })

  it('never names an AI destination field', () => {
    // Those two are (re)written downstream from this same normalised object
    // (`applyAiDestinationOverrides`), so listing one here would delete the
    // clear in the one place §2.119 performs it, not merely in the merge.
    for (const field of AI_DESTINATION_FIELDS) {
      expect(UNERASABLE_SETTINGS_FIELDS as readonly string[]).not.toContain(field)
    }
  })
})

// The refusal is also a telemetry tag (`settings.field_refused`). Both tag
// domains are copies of the vocabularies above, in another file — so the thing
// that can go wrong is drift: a member added here and not there makes the
// runtime domain check drop the event, a member added there and not here
// discloses a value we never send.
describe('telemetry domain parity', () => {
  it('discloses exactly the fields that can be refused', () => {
    expect([...DOMAINS.settings_refused_field]).toEqual([...SETTINGS_REFUSABLE_FIELDS])
  })

  it('discloses exactly the codes that can be reported', () => {
    expect([...DOMAINS.settings_refusal_code]).toEqual([...SETTINGS_REFUSAL_CODES])
  })

  it('every refusable field is a field the renderer may write', () => {
    // A refusal for a field outside the writable subset would be unreachable:
    // such a key is `unrecognized_keys`, i.e. the §3.10 P0 path, not this one.
    const writable = Object.keys(rendererWritableSettingsSchema.shape)
    for (const field of SETTINGS_REFUSABLE_FIELDS) expect(writable).toContain(field)
  })
})

describe('the merge the handler performs afterwards', () => {
  it('keeps the persisted whitelist and applies every other field of the save', () => {
    const current = persistedSettings({
      mcpExportWhitelist: ['get_email'],
      sortMode: 'date',
      mcpExportPort: 23847,
    })
    const { accepted, refusedFields } = classify({
      mcpExportWhitelist: ['get_email', 'legacy_tool_from_an_older_build'],
      sortMode: 'from',
      mcpExportPort: 24000,
    })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })

    // Not reset to a default, not replaced by what was submitted.
    expect(next.mcpExportWhitelist).toEqual(['get_email'])
    expect(refusedFields).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: ['legacy_tool_from_an_older_build'],
    }])
    // The rest of the same save landed.
    expect(next.sortMode).toBe('from')
    expect(next.mcpExportPort).toBe(24000)
  })

  it('leaves the field absent when it was never persisted', () => {
    const current = persistedSettings()
    expect(current.mcpExportWhitelist).toBeUndefined()
    const { accepted } = classify({ mcpExportWhitelist: ['legacy_tool'], sortMode: 'from' })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })
    expect(next.mcpExportWhitelist).toBeUndefined()
    expect(next.sortMode).toBe('from')
  })

  it('refuses the whole field for two unknown names riding with a third valid one, and still saves the rest of the payload', () => {
    // §2.167 branch: the field is stripped WHOLE on any offending entry — a
    // valid name in the same array does not survive on its own, and the
    // persisted whitelist (not a partially-cleaned submitted one) is what the
    // merge keeps. What DOES land, from the same save, is every other field.
    const current = persistedSettings({
      mcpExportWhitelist: ['get_email'],
      sortMode: 'date',
    })
    const { accepted, refusedFields } = classify({
      mcpExportWhitelist: ['nope_one', 'get_thread', 'nope_two'],
      sortMode: 'from',
    })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })

    expect(refusedFields).toHaveLength(1)
    // Exactly the two out-of-domain names — the in-domain one is not echoed.
    expect(refusedFields[0].values).toEqual(['nope_one', 'nope_two'])
    expect(refusedFields[0].values).not.toContain('get_thread')
    // The whitelist reverts to what was persisted, not a cleaned submission.
    expect(next.mcpExportWhitelist).toEqual(['get_email'])
    // The unrelated field of the very same save landed.
    expect(next.sortMode).toBe('from')
  })

  it('writes a valid whitelist through unchanged', () => {
    const current = persistedSettings({ mcpExportWhitelist: ['get_email'] })
    const { accepted, refusedFields } = classify({ mcpExportWhitelist: ['list_folders', 'get_thread'] })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })
    expect(refusedFields).toEqual([])
    expect(next.mcpExportWhitelist).toEqual(['list_folders', 'get_thread'])
  })

  it('lets a payload clear the whitelist', () => {
    // An empty array is in domain: refusing it would strand a user who wants
    // to export nothing.
    const current = persistedSettings({ mcpExportWhitelist: ['get_email'] })
    const { accepted, refusedFields } = classify({ mcpExportWhitelist: [] })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })
    expect(refusedFields).toEqual([])
    expect(next.mcpExportWhitelist).toEqual([])
  })

  // §2.167 branch C (codex, high) — "leave the persisted list alone" spelled as
  // a present-but-undefined key. The schema accepts it (every field is
  // optional), so before the normalisation pass the merge wrote `undefined`
  // over the stored array, `saveSettings` dropped the key from disk, and the
  // export server fell back to `DEFAULT_EXPORT_WHITELIST` — a whitelist that
  // narrowed the exported surface silently widened it.
  it('keeps a configured empty whitelist when the payload carries an explicit undefined', () => {
    // The worst case of the two: `[]` is the narrowest possible setting, and
    // losing it hands the export server its whole default set.
    const current = persistedSettings({ mcpExportWhitelist: [], sortMode: 'date' })
    const { accepted, refusedFields } = classify({ mcpExportWhitelist: undefined, sortMode: 'from' })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })
    expect(refusedFields).toEqual([])
    expect(next.mcpExportWhitelist).toEqual([])
    // The rest of the same save still landed — the key is ignored, not refused.
    expect(next.sortMode).toBe('from')
  })

  it('keeps a non-empty persisted whitelist when the payload carries an explicit undefined', () => {
    const current = persistedSettings({ mcpExportWhitelist: ['get_email'], sortMode: 'date' })
    const { accepted } = classify({ mcpExportWhitelist: undefined, sortMode: 'from' })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })
    expect(next.mcpExportWhitelist).toEqual(['get_email'])
    expect(next.sortMode).toBe('from')
  })

  it('still distinguishes an explicit empty array from an explicit undefined', () => {
    // The pair in one place: only `[]` may replace a stored list, and it always
    // may — "export nothing" must stay expressible.
    const current = persistedSettings({ mcpExportWhitelist: ['get_email'] })
    const cleared = settingsSchema.parse({
      ...current,
      ...(classify({ mcpExportWhitelist: [] }).accepted as Record<string, unknown>),
    })
    const held = settingsSchema.parse({
      ...current,
      ...(classify({ mcpExportWhitelist: undefined }).accepted as Record<string, unknown>),
    })
    expect(cleared.mcpExportWhitelist).toEqual([])
    expect(held.mcpExportWhitelist).toEqual(['get_email'])
  })

  it('leaves a persisted whitelist alone when the payload omits the key', () => {
    // The unchanged half of the contract: omission was already the way to say
    // "leave it alone", and the normalisation must not have moved it.
    const current = persistedSettings({ mcpExportWhitelist: ['get_email'] })
    const { accepted, refusedFields } = classify({ sortMode: 'from' })
    const next = settingsSchema.parse({ ...current, ...(accepted as Record<string, unknown>) })
    expect(refusedFields).toEqual([])
    expect(next.mcpExportWhitelist).toEqual(['get_email'])
    expect(next.sortMode).toBe('from')
  })
})

/**
 * §2.218.f2 — a value-level failure on a known field that is NOT on the refusal
 * allowlist kills the WHOLE save, and says so itself rather than borrowing the
 * verdict from the persisted schema.
 *
 * THE DEFECT THIS PINS (found by codex-security-review on the §2.218 removal,
 * and introduced by that same diff). `settingsSchema.aiProvider` gained
 * `.catch(undefined)` so a removed provider sitting on DISK could not brick the
 * settings load. Nothing acted on the renderer schema's rejection of the same
 * value, so a PAYLOAD carrying it flowed to the merge, `.catch` resolved it to
 * "unset", and the handler answered `{ ok: true }` — a stale or compromised
 * settings window could CLEAR a configured AI provider and still land every
 * other field it sent. The whole-save refusal used to be real but INCIDENTAL:
 * it depended on the persisted schema rejecting the same value, which is not a
 * property either schema promises the other.
 *
 * The two directions are asserted together on purpose, because the fix is only
 * correct if it is asymmetric — strict about a payload, tolerant about disk.
 */
describe('§2.218.f2 whole-save refusal for unhandled renderer-schema failures', () => {
  it('marks a removed AI provider in a PAYLOAD as unhandled, so the save dies whole', () => {
    const { forbidden, refusedFields, unhandledFields, wholeSaveRefused, mainOnlyHit } = classify({
      aiProvider: 'subscription',
      sortMode: 'from',
    })

    expect(unhandledFields).toEqual(['aiProvider'])
    expect(wholeSaveRefused).toBe(true)
    // Not a main-only attempt (that gate owns its own audit row and reason
    // code), and NOT a per-field refusal — `REFUSABLE_FIELDS` is an enumerated
    // exception set, and partial application is a courtesy this payload has not
    // earned.
    expect(mainOnlyHit).toBe(false)
    expect(forbidden).toEqual([])
    expect(refusedFields).toEqual([])
  })

  it('would otherwise have CLEARED the configured provider and landed the rest', () => {
    // The concrete damage, demonstrated: this is what the merge produces if the
    // refusal above is ever removed. `aiProvider` comes back unset (silently
    // cleared) while the unrelated edit is applied.
    const current = persistedSettings({ aiProvider: 'openai-api', sortMode: 'date' })
    const wouldPersist = mergeAndPersist({ aiProvider: 'subscription', sortMode: 'from' }, current)
    expect(wouldPersist.aiProvider).toBeUndefined()
    expect(wouldPersist.sortMode).toBe('from')
    // …which is exactly why the handler must never get here for this payload.
    expect(classify({ aiProvider: 'subscription', sortMode: 'from' }).wholeSaveRefused).toBe(true)
  })

  it('refuses every live-provider-shaped impostor the same way', () => {
    for (const bogus of ['subscription', 'claude-subscription', '', 'anthropic', 42]) {
      const { wholeSaveRefused, unhandledFields } = classify({ aiProvider: bogus })
      expect(wholeSaveRefused, String(bogus)).toBe(true)
      expect(unhandledFields, String(bogus)).toEqual(['aiProvider'])
    }
  })

  it('accepts every live provider without a refusal of any kind', () => {
    for (const provider of ['anthropic-api', 'openai-api', 'gemini-api']) {
      const { wholeSaveRefused, refusedFields, forbidden } = classify({ aiProvider: provider })
      expect(wholeSaveRefused, provider).toBe(false)
      expect(refusedFields, provider).toEqual([])
      expect(forbidden, provider).toEqual([])
    }
  })

  // THE ASYMMETRY. Same value, opposite verdicts, and both are deliberate:
  // reading our own disk must never brick the settings load, accepting a
  // payload must never launder a value the renderer had no business sending.
  it('still DROPS the same value silently when it comes from disk, not from a payload', () => {
    const fromDisk = settingsSchema.safeParse({
      theme: 'light',
      language: 'en',
      aiProvider: 'subscription',
      sortMode: 'from',
    })
    expect(fromDisk.success).toBe(true)
    if (fromDisk.success) {
      expect(fromDisk.data.aiProvider).toBeUndefined()
      expect(fromDisk.data.sortMode).toBe('from')
    }
    // The payload route for the identical value is refused whole.
    expect(classify({ aiProvider: 'subscription' }).wholeSaveRefused).toBe(true)
  })

  // Guard against over-correction. These two classes must NOT start throwing.
  it('does not treat an allowlisted per-field refusal as unhandled', () => {
    const { refusedFields, unhandledFields, wholeSaveRefused } = classify({
      mcpExportWhitelist: ['get_email', 'legacy_tool_from_an_older_build'],
    })
    expect(refusedFields.map(r => r.field)).toEqual(['mcpExportWhitelist'])
    expect(unhandledFields).toEqual([])
    expect(wholeSaveRefused).toBe(false)
  })

  it('does not treat an unknown NON-main-only key as unhandled (silent discard predates §2.167)', () => {
    const { forbidden, unhandledFields, wholeSaveRefused, mainOnlyHit } = classify({
      someKeyFromAnotherBuild: 'whatever',
      sortMode: 'from',
    })
    // Unknown keys travel on `forbidden`, where the main-only gate judges them;
    // a non-main-only one keeps falling through to the soft persistent schema,
    // which discards it without a word. That behaviour is older than §2.167 and
    // the new refusal must not have swept it up.
    expect(forbidden).toEqual(['someKeyFromAnotherBuild'])
    expect(mainOnlyHit).toBe(false)
    expect(unhandledFields).toEqual([])
    expect(wholeSaveRefused).toBe(false)
  })

  // A behaviour that genuinely CHANGED with this gate, stated so it is a
  // decision rather than a side effect. A non-object payload produces a
  // root-level `invalid_type` and used to be a silent no-op: the spread
  // `{ ...current, ...42 }` contributes nothing, the persisted parse succeeded
  // on the unchanged record, and the renderer was told `{ ok: true }` for a save
  // that never happened. It is a renderer bug either way; now it fails loudly
  // instead of pretending to have saved.
  it('refuses a payload that is not an object at all, instead of silently no-opping', () => {
    for (const payload of [42, 'settings', null, true, []]) {
      const { wholeSaveRefused, unhandledFields } = classify(payload)
      expect(wholeSaveRefused, JSON.stringify(payload)).toBe(true)
      expect(unhandledFields, JSON.stringify(payload)).toEqual(['(non-string path)'])
    }
  })

  it('does not fire for a fully valid payload', () => {
    const { unhandledFields, wholeSaveRefused } = classify({ sortMode: 'from', mcpExportPort: 24000 })
    expect(unhandledFields).toEqual([])
    expect(wholeSaveRefused).toBe(false)
  })
})
