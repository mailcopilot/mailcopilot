import { useCallback, useState } from 'react'

/**
 * Renderer half of BACKLOG §2.167 — "one field of this save was not applied".
 *
 * `settings:save` no longer answers a single yes/no. A value that is merely out
 * of domain for ONE field costs that field and nothing else: the save proceeds,
 * every other edit lands, the persisted value of the offending field is left
 * untouched, and the reply carries
 *
 *   { ok: true, refused: [{ field: 'mcpExportWhitelist',
 *                           code: 'unknown_export_tool',
 *                           values: ['legacy_tool'] }] }
 *
 * (electron/settingsSaveRefusal.ts). This hook is what stops that from being a
 * silent partial save. The settings window's only "saved" signal is that it
 * closes, exactly as in §2.119 — so a refusal that closes the window tells the
 * person their edit went through when it did not.
 *
 * REPAIR IS REACTIVE, AND MAIN NAMES WHAT TO REPAIR. An earlier take on this
 * kept a copy of the export ceiling in the renderer and pruned the outgoing
 * array against it. That copy was a second source of truth for a domain main
 * owns, and it could only ever drift. It is gone: the window now sends what it
 * holds, and repairs its state from the `values` main sends back — the entries
 * of the submitted array that main itself rejected. Removing exactly those ends
 * the permanent-refusal loop (a stale name in state is otherwise re-submitted on
 * every save and refused every time) without this side guessing at the domain.
 *
 * `values` IS NOT EXHAUSTIVE. Main omits non-string members and overlong strings
 * and stops at a count cap (see `RefusedSettingsField` in
 * electron/settingsSaveRefusal.ts), so a consumer must read it as "these are
 * known to be bad", never "these are the only bad ones". Non-strings are
 * therefore repaired HERE, by type: `mcpExportWhitelist` is `string[]`, so a
 * number in it is corrupt persisted data and needs no domain knowledge to drop.
 * What survives both — an overlong entry, or an offender past the cap — leaves
 * the repair incomplete, which the caller detects by the array not changing and
 * answers by withholding the field (see `repairExportWhitelist`).
 *
 * VOCABULARY IS MAIN'S, NOT OURS. `field` and `code` are closed enums minted in
 * electron/settingsSaveRefusal.ts. They are mirrored here for labelling, but an
 * unrecognized value NEVER downgrades a refusal to a success — see
 * `parseSettingsFieldRefusals`.
 */

/** Fields a save may lose one at a time. Mirrors SETTINGS_REFUSABLE_FIELDS. */
export const KNOWN_REFUSABLE_SETTINGS_FIELDS = ['mcpExportWhitelist'] as const
export type KnownRefusableSettingsField = (typeof KNOWN_REFUSABLE_SETTINGS_FIELDS)[number]

/** Reasons a field was dropped. Mirrors SETTINGS_REFUSAL_CODES. */
export const KNOWN_SETTINGS_REFUSAL_CODES = ['unknown_export_tool'] as const
export type KnownSettingsRefusalCode = (typeof KNOWN_SETTINGS_REFUSAL_CODES)[number]

/**
 * One refused field as it arrived.
 *
 * `field` and `code` are deliberately `string`, not the unions above: a future
 * main that refuses a field or for a reason this build has never heard of must
 * still be able to say so. The unions are used to pick better wording, not to
 * decide whether the event is real.
 */
export interface RefusedSettingsField {
  field: string
  code: string
  /**
   * Submitted entries main rejected by name. Possibly empty and never
   * exhaustive — see the module header.
   */
  values: string[]
}

export function isKnownRefusableField(field: string): field is KnownRefusableSettingsField {
  return (KNOWN_REFUSABLE_SETTINGS_FIELDS as readonly string[]).includes(field)
}

export function isKnownRefusalCode(code: string): code is KnownSettingsRefusalCode {
  return (KNOWN_SETTINGS_REFUSAL_CODES as readonly string[]).includes(code)
}

/**
 * Read the `refused` array out of a `settings:save` reply.
 *
 * FAIL-VISIBLE. A malformed member is skipped (there is nothing to name), but a
 * member whose `field` or `code` this build does not know is kept: dropping it
 * would turn "your setting was not saved" into "saved", which is the exact
 * defect this hook exists to prevent. A malformed `values` degrades to `[]` —
 * "the field was refused and nothing can be named" — rather than discarding the
 * refusal, for the same reason.
 *
 * Repeats of the same field collapse into one entry and their `values` merge:
 * main de-duplicates already, and a second line for one field says nothing
 * extra, but silently dropping the second line's values would cost a repair.
 *
 * Pure and cheap — the settings window calls it once for the repair decision and
 * `recordSettingsSaveOutcome` calls it again for the notice.
 */
export function parseSettingsFieldRefusals(result: unknown): RefusedSettingsField[] {
  if (typeof result !== 'object' || result === null) return []
  const raw = (result as { refused?: unknown }).refused
  if (!Array.isArray(raw)) return []
  const out: RefusedSettingsField[] = []
  const byField = new Map<string, RefusedSettingsField>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { field, code, values } = entry as { field?: unknown; code?: unknown; values?: unknown }
    if (typeof field !== 'string' || field === '') continue
    const named = Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : []
    const existing = byField.get(field)
    if (existing) {
      for (const value of named) if (!existing.values.includes(value)) existing.values.push(value)
      continue
    }
    const parsed: RefusedSettingsField = {
      field,
      code: typeof code === 'string' ? code : '',
      values: named.filter((v, i) => named.indexOf(v) === i),
    }
    byField.set(field, parsed)
    out.push(parsed)
  }
  return out
}

/** What one repair of `mcpExportWhitelist` did to the window's state. */
export interface ExportWhitelistRepair {
  /** The whitelist to keep, in the order it was held. */
  next: string[]
  /** What was taken out, de-duplicated, in the order it was first seen. */
  removed: string[]
  /**
   * Whether the repair achieved anything. `false` means the refusal cannot be
   * repaired from what main said (its `values` named nothing this window holds,
   * or named nothing at all because every offender was past main's caps), and
   * the caller must stop submitting the field instead of re-sending an array
   * that will be refused again.
   */
  changed: boolean
}

/**
 * Printable form of a non-string whitelist member. `JSON.stringify` answers
 * `undefined` for `undefined` and for a function, hence the fallback.
 */
function jsonLabel(entry: unknown): string {
  try {
    const encoded: string | undefined = JSON.stringify(entry)
    return encoded ?? String(entry)
  } catch {
    // Circular structure — nothing readable to show, but the entry still has to
    // be counted as removed rather than silently kept.
    return String(entry)
  }
}

/**
 * Take the entries main refused out of the whitelist this window holds.
 *
 * Removed: every entry equal to one main named, and every non-string entry (see
 * the module header — main cannot name those, and no domain knowledge is needed
 * to know a `string[]` should not contain a number). Everything else is kept
 * verbatim, including duplicates: the array is the user's, not ours.
 *
 * `removed` is read by a human, so it collapses repeats and shows a corrupt
 * entry as the JSON it would have travelled as rather than `[object Object]`.
 */
export function repairExportWhitelist(
  current: readonly unknown[],
  values: readonly string[],
): ExportWhitelistRepair {
  const refused = new Set(values)
  const next: string[] = []
  const removed: string[] = []
  const seen = new Set<string>()
  for (const entry of current) {
    if (typeof entry === 'string' && !refused.has(entry)) {
      next.push(entry)
      continue
    }
    const label = typeof entry === 'string' ? entry : jsonLabel(entry)
    if (seen.has(label)) continue
    seen.add(label)
    removed.push(label)
  }
  return { next, removed, changed: next.length !== current.length }
}

/**
 * Whether the persisted settings carried an EXPLICIT `mcpExportWhitelist`.
 *
 * An array is a configured list — INCLUDING an empty one. `[]` on disk means
 * "export nothing", which is a decision someone made; only the absence of the
 * key means "no preference expressed". Reading `[]` as "not configured" would
 * be the same widening this helper exists to prevent, one step earlier: the
 * empty list would be normalized back to `undefined` and every consumer that
 * treats nullish as "use the default set" would hand out the defaults.
 */
export function isExportWhitelistConfigured(persisted: unknown): boolean {
  return Array.isArray(persisted)
}

/**
 * The whitelist as it must be handed to anything that reads nullish as "caller
 * expressed no preference → use the default set" (`resolveExportWhitelist` in
 * electron/services/mcpExport.ts, and `settings:save`, which leaves the
 * persisted value alone on `undefined`).
 *
 * ONE RULE, EVERY CONSUMER. A configured list travels as-is — `[]` included,
 * because "export nothing" is exactly what a list emptied by a repair (or
 * stored empty) means. Only a list that was never configured travels as
 * `undefined`. The `length > 0 ? list : undefined` shorthand this replaces read
 * the same on the surface and was a silent WIDENING on both call sites: an
 * export server started from an emptied list would have registered the default
 * tool set instead of nothing.
 */
export function buildExportWhitelistPayload(
  whitelist: readonly string[],
  configured: boolean,
): string[] | undefined {
  if (!configured && whitelist.length === 0) return undefined
  return [...whitelist]
}

/** Everything one save has to report about itself, or nothing. */
export interface SettingsSaveRefusalNotice {
  /** Fields main refused. */
  refusedFields: RefusedSettingsField[]
  /** Export tool names this window took out of its state in response. */
  repairedExportTools: string[]
}

export interface RecordSettingsSaveOutcomeInput {
  /** Whatever `settings:save` answered. Any shape. */
  result: unknown
  /** Names removed from `mcpExportWhitelist` because main refused them. */
  repairedExportTools?: readonly string[]
}

export interface UseSettingsSaveRefusalReturn {
  /** What to render, or null when the save had nothing to report. */
  settingsSaveRefusal: SettingsSaveRefusalNotice | null
  /**
   * Record the outcome of one `settings:save`.
   *
   * Returns the notice (truthy) when the window must stay open so it can be
   * read, and `null` when the save was clean. Returning the notice rather than
   * storing it silently is deliberate: a caller that ignores the return value
   * closes the window, which is the defect, so the contract is in the caller's
   * face at the call site.
   */
  recordSettingsSaveOutcome: (input: RecordSettingsSaveOutcomeInput) => SettingsSaveRefusalNotice | null
  /** Drop the notice (e.g. before a fresh attempt). */
  clearSettingsSaveRefusal: () => void
}

export function useSettingsSaveRefusal(): UseSettingsSaveRefusalReturn {
  const [notice, setNotice] = useState<SettingsSaveRefusalNotice | null>(null)

  const recordSettingsSaveOutcome = useCallback((
    { result, repairedExportTools = [] }: RecordSettingsSaveOutcomeInput,
  ): SettingsSaveRefusalNotice | null => {
    const refusedFields = parseSettingsFieldRefusals(result)
    const next: SettingsSaveRefusalNotice | null =
      refusedFields.length === 0 && repairedExportTools.length === 0
        ? null
        : { refusedFields, repairedExportTools: [...repairedExportTools] }
    // Overwritten on every save, so a notice from an earlier attempt cannot
    // outlive the attempt that fixed it.
    setNotice(next)
    return next
  }, [])

  const clearSettingsSaveRefusal = useCallback(() => setNotice(null), [])

  return {
    settingsSaveRefusal: notice,
    recordSettingsSaveOutcome,
    clearSettingsSaveRefusal,
  }
}
