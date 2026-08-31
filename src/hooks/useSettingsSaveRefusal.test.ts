// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useSettingsSaveRefusal.ts — BACKLOG §2.167.
 *
 * Two load-bearing claims:
 *   1. a `settings:save` reply carrying `refused` is not a completed save, and
 *      stays reportable even in shapes this build did not anticipate;
 *   2. the window repairs its own state from what main NAMED, never from a
 *      local copy of main's domain — and it can tell when the reply named
 *      nothing it could act on, because that is the case it must answer by
 *      withholding the field instead of re-submitting it forever.
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  buildExportWhitelistPayload,
  isExportWhitelistConfigured,
  isKnownRefusableField,
  isKnownRefusalCode,
  parseSettingsFieldRefusals,
  repairExportWhitelist,
  useSettingsSaveRefusal,
} from './useSettingsSaveRefusal'

const WHITELIST_REFUSAL = {
  field: 'mcpExportWhitelist',
  code: 'unknown_export_tool',
  values: ['legacy_tool'],
}

describe('§2.167 parseSettingsFieldRefusals', () => {
  it('returns nothing for a plain successful save', () => {
    expect(parseSettingsFieldRefusals({ ok: true })).toEqual([])
  })

  it('returns nothing for replies that are not objects', () => {
    for (const reply of [undefined, null, 'ok', 42, []]) {
      expect(parseSettingsFieldRefusals(reply)).toEqual([])
    }
  })

  it('reads the refused field, its code and the values main named', () => {
    expect(parseSettingsFieldRefusals({ ok: true, refused: [WHITELIST_REFUSAL] }))
      .toEqual([WHITELIST_REFUSAL])
  })

  it('ignores a `refused` that is not an array', () => {
    expect(parseSettingsFieldRefusals({ ok: true, refused: 'mcpExportWhitelist' })).toEqual([])
  })

  // FAIL-VISIBLE. A future main refusing a field or for a reason this build has
  // never heard of must still be reported: dropping it would turn "your setting
  // was not saved" back into "saved", which is the defect being fixed.
  it('keeps a refusal whose field this build does not know', () => {
    const parsed = parseSettingsFieldRefusals({ refused: [{ field: 'somethingNew', code: 'why' }] })
    expect(parsed).toEqual([{ field: 'somethingNew', code: 'why', values: [] }])
    expect(isKnownRefusableField('somethingNew')).toBe(false)
  })

  it('keeps a refusal whose code is missing or malformed', () => {
    expect(parseSettingsFieldRefusals({ refused: [{ field: 'mcpExportWhitelist' }] }))
      .toEqual([{ field: 'mcpExportWhitelist', code: '', values: [] }])
    expect(parseSettingsFieldRefusals({ refused: [{ field: 'mcpExportWhitelist', code: 9 }] }))
      .toEqual([{ field: 'mcpExportWhitelist', code: '', values: [] }])
  })

  // Same reasoning one level down: a `values` this build cannot read costs the
  // repair, never the refusal itself.
  it('degrades a malformed `values` to nothing named, keeping the refusal', () => {
    for (const values of [undefined, null, 'legacy_tool', 42, {}]) {
      expect(parseSettingsFieldRefusals({
        refused: [{ field: 'mcpExportWhitelist', code: 'unknown_export_tool', values }],
      })).toEqual([{ field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: [] }])
    }
  })

  it('keeps only the string members of `values`, de-duplicated', () => {
    expect(parseSettingsFieldRefusals({
      refused: [{
        field: 'mcpExportWhitelist',
        code: 'unknown_export_tool',
        values: ['a', 42, 'a', null, 'b'],
      }],
    })).toEqual([{ field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: ['a', 'b'] }])
  })

  // A member with no field name cannot be rendered at all — there is nothing to
  // put in front of the person.
  it('skips members with no usable field name', () => {
    expect(parseSettingsFieldRefusals({ refused: [null, 'x', {}, { field: '' }, WHITELIST_REFUSAL] }))
      .toEqual([WHITELIST_REFUSAL])
  })

  // One line per field, but never at the cost of a name the repair needs.
  it('collapses repeats of the same field and merges their values', () => {
    expect(parseSettingsFieldRefusals({
      refused: [
        WHITELIST_REFUSAL,
        { field: 'mcpExportWhitelist', code: 'other', values: ['legacy_tool', 'second_tool'] },
      ],
    })).toEqual([{
      field: 'mcpExportWhitelist',
      code: 'unknown_export_tool',
      values: ['legacy_tool', 'second_tool'],
    }])
  })

  it('agrees with main about the known vocabulary', () => {
    expect(isKnownRefusableField('mcpExportWhitelist')).toBe(true)
    expect(isKnownRefusalCode('unknown_export_tool')).toBe(true)
    expect(isKnownRefusalCode('unknown_export_tools')).toBe(false)
  })
})

describe('§2.167 repairExportWhitelist', () => {
  it('removes exactly the entries main named, keeping the rest in order', () => {
    expect(repairExportWhitelist(['get_email', 'legacy_tool', 'list_folders'], ['legacy_tool']))
      .toEqual({ next: ['get_email', 'list_folders'], removed: ['legacy_tool'], changed: true })
  })

  // `values` is never exhaustive (main omits non-strings), so the type check is
  // the renderer's own job: a number in a `string[]` is corrupt persisted data
  // and needs no knowledge of the export ceiling to reject.
  it('removes non-string entries by type, even when main named nothing', () => {
    const repair = repairExportWhitelist(['get_email', 42, null], [])
    expect(repair.next).toEqual(['get_email'])
    expect(repair.removed).toEqual(['42', 'null'])
    expect(repair.changed).toBe(true)
  })

  it('shows a corrupt entry as the JSON it would have travelled as', () => {
    expect(repairExportWhitelist([{ tool: 'x' }, undefined], []).removed)
      .toEqual(['{"tool":"x"}', 'undefined'])
  })

  // THE WITHHOLD SIGNAL. Main refused the field but named nothing this window
  // holds — the caller must stop submitting the field rather than re-send an
  // array that will be refused again.
  it('reports no change when the refusal named nothing it could act on', () => {
    expect(repairExportWhitelist(['get_email'], [])).toEqual({
      next: ['get_email'], removed: [], changed: false,
    })
    expect(repairExportWhitelist(['get_email'], ['not_in_the_list']).changed).toBe(false)
  })

  it('keeps duplicates of surviving entries but names a removed one once', () => {
    const repair = repairExportWhitelist(
      ['get_email', 'get_email', 'legacy_tool', 'legacy_tool'],
      ['legacy_tool'],
    )
    expect(repair.next).toEqual(['get_email', 'get_email'])
    expect(repair.removed).toEqual(['legacy_tool'])
  })

  it('can empty the list, which still means "export nothing"', () => {
    expect(repairExportWhitelist(['legacy_tool'], ['legacy_tool']))
      .toEqual({ next: [], removed: ['legacy_tool'], changed: true })
  })
})

describe('§2.167 export whitelist payload normalization', () => {
  // The whole point: only ABSENCE means "no preference". Anything that reads an
  // empty array as absence widens what the export server registers, because
  // `resolveExportWhitelist` answers a nullish whitelist with the default set.
  it('counts any array on disk as a configured list, empty included', () => {
    expect(isExportWhitelistConfigured(['get_email'])).toBe(true)
    expect(isExportWhitelistConfigured([])).toBe(true)
  })

  it('counts a missing or malformed value as never configured', () => {
    for (const persisted of [undefined, null, '', 'get_email', 0, {}]) {
      expect(isExportWhitelistConfigured(persisted)).toBe(false)
    }
  })

  it('sends a configured list as-is, including an empty one', () => {
    expect(buildExportWhitelistPayload(['get_email'], true)).toEqual(['get_email'])
    expect(buildExportWhitelistPayload([], true)).toEqual([])
  })

  it('sends nothing only when no list was ever configured', () => {
    expect(buildExportWhitelistPayload([], false)).toBeUndefined()
  })

  // A never-configured state that somehow holds entries is still the person's
  // list — dropping it would be the opposite failure (narrowing by surprise).
  it('sends entries even when the configured flag was never set', () => {
    expect(buildExportWhitelistPayload(['get_email'], false)).toEqual(['get_email'])
  })

  it('copies, so a consumer cannot mutate the window state through it', () => {
    const held = ['get_email']
    const payload = buildExportWhitelistPayload(held, true)
    payload?.push('list_folders')
    expect(held).toEqual(['get_email'])
  })
})

describe('§2.167 useSettingsSaveRefusal', () => {
  it('reports nothing for a clean save', () => {
    const { result } = renderHook(() => useSettingsSaveRefusal())
    let notice: unknown
    act(() => { notice = result.current.recordSettingsSaveOutcome({ result: { ok: true } }) })
    expect(notice).toBeNull()
    expect(result.current.settingsSaveRefusal).toBeNull()
  })

  // The return value is the contract the caller acts on: a caller that ignores
  // it closes the window, and closing is this window's only "saved" signal.
  it('returns the notice it stores when main refused a field', () => {
    const { result } = renderHook(() => useSettingsSaveRefusal())
    let notice: unknown
    act(() => {
      notice = result.current.recordSettingsSaveOutcome({ result: { ok: true, refused: [WHITELIST_REFUSAL] } })
    })
    expect(notice).toEqual({ refusedFields: [WHITELIST_REFUSAL], repairedExportTools: [] })
    expect(result.current.settingsSaveRefusal).toEqual(notice)
  })

  it('carries the names the window took out of its own state', () => {
    const { result } = renderHook(() => useSettingsSaveRefusal())
    act(() => {
      result.current.recordSettingsSaveOutcome({
        result: { ok: true, refused: [WHITELIST_REFUSAL] },
        repairedExportTools: ['legacy_tool'],
      })
    })
    expect(result.current.settingsSaveRefusal)
      .toEqual({ refusedFields: [WHITELIST_REFUSAL], repairedExportTools: ['legacy_tool'] })
  })

  // A notice from an earlier attempt must not outlive the attempt that fixed
  // the thing it describes — which, after a repair, is the very next save.
  it('drops the previous notice on the next save', () => {
    const { result } = renderHook(() => useSettingsSaveRefusal())
    act(() => {
      result.current.recordSettingsSaveOutcome({
        result: { ok: true, refused: [WHITELIST_REFUSAL] },
        repairedExportTools: ['legacy_tool'],
      })
    })
    act(() => { result.current.recordSettingsSaveOutcome({ result: { ok: true } }) })
    expect(result.current.settingsSaveRefusal).toBeNull()
  })

  it('can be cleared on demand', () => {
    const { result } = renderHook(() => useSettingsSaveRefusal())
    act(() => {
      result.current.recordSettingsSaveOutcome({ result: { refused: [WHITELIST_REFUSAL] } })
    })
    act(() => { result.current.clearSettingsSaveRefusal() })
    expect(result.current.settingsSaveRefusal).toBeNull()
  })

  it('copies the repaired names rather than holding the caller\'s array', () => {
    const { result } = renderHook(() => useSettingsSaveRefusal())
    const repaired = ['legacy_tool']
    act(() => { result.current.recordSettingsSaveOutcome({ result: {}, repairedExportTools: repaired }) })
    repaired.push('later')
    expect(result.current.settingsSaveRefusal?.repairedExportTools).toEqual(['legacy_tool'])
  })
})
