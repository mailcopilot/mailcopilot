/**
 * §2.167 — per-field refusal for `settings:save`.
 *
 * WHAT PROBLEM THIS SOLVES. `rendererWritableSettingsSchema` is the narrow
 * writable subset a renderer may send (§3.10 P0). It answers one question —
 * "is this payload entirely acceptable?" — and the handler used to act on that
 * single bit. Two different failures therefore shared one verdict:
 *
 *   1. a MAIN-ONLY field (mcpEnableStdio, stdioApproved, …) — an attempt to
 *      cross a security boundary. The whole payload must die, and it must be
 *      audited;
 *   2. a value that is merely out of domain for ONE field — e.g. an export
 *      tool name that a newer build no longer exports, still sitting in the
 *      persisted whitelist and round-tripped back by the settings window.
 *
 * (2) is not an attack and not a reason to discard the user's unrelated edits.
 * Before this module the second case had no verdict of its own at all: the
 * schema said "invalid", the handler shrugged, and the merged object went to
 * the PERSISTED schema, which is deliberately lax about this field
 * (`z.array(z.string())`, see the §2.158 note in packages/net/config.ts) — so
 * the out-of-domain value was written to disk verbatim and the renderer was
 * told nothing. Inert (McpExportServer.start() intersects with the ceiling
 * before registering anything), but stored, unreported and untrue to the
 * comment that claimed the renderer would learn its payload was wrong.
 *
 * THE RULE. The offending FIELD is refused; the save proceeds without it.
 * Refusal is non-destructive, exactly as in §2.119: the persisted value stays
 * (the field is deleted from the payload BEFORE the `{ ...current, ...payload }`
 * merge, so the merge cannot reset it to a default either), the submitted value
 * is not activated, and every other field of the same save is applied. The
 * renderer is told which field and why, in machine codes.
 *
 * WHAT THIS MODULE MUST NOT BECOME. It is not a second opinion on the §3.10 P0
 * gate. Main-only keys are reported here as `forbidden` and nothing more — the
 * caller keeps that gate as the FIRST thing that can end the handler, with its
 * own audit row and its own whole-payload refusal. Partial application is a
 * courtesy to an honest renderer; it is not extended to a renderer reaching for
 * a field it may not write.
 *
 * ALLOWLIST, NOT DENYLIST. Only (field, zod issue code) pairs listed in
 * `REFUSABLE_FIELDS` become a per-field refusal. Anything else is refused as a
 * WHOLE save: the handler throws on `unhandledFields` before any strip, merge
 * or store access. The refusal used to be borrowed — "falls through to
 * `settingsSchema.parse`, which throws" — which held only while the persisted
 * schema happened to reject the same value; §2.218's field-scoped
 * `.catch(undefined)` on `aiProvider` broke that accidental coupling, so the
 * refusal is now owned here explicitly. A blanket "strip whatever failed"
 * would silently swallow classes of bad payloads we have never reasoned about.
 *
 * NO RAW ZOD TEXT LEAVES THIS MODULE. `code` is a closed enum of our own
 * making. Zod messages carry the offending value and the full list of allowed
 * options; neither belongs in a renderer-facing reply or in a log line.
 *
 * THE REFUSAL NAMES THE VALUES IT REFUSED — TO THE RENDERER ONLY. `values`
 * holds the entries of the submitted array that failed the domain check, taken
 * from the payload the renderer itself sent. Without them the settings window
 * cannot repair its own state, and a single stale tool name becomes a permanent
 * refusal (the window round-trips the persisted whitelist on every save). The
 * alternative — a second copy of `EXPORTABLE_MCP_TOOLS` in the renderer so it
 * can guess which entries main disliked — is the mirror this field exists to
 * delete: main is the side that owns the ceiling, so main is the side that
 * names what fell outside it.
 *
 * `values` therefore travels on exactly one route: the IPC reply to the window
 * that submitted them. It must never reach a log line or telemetry — those two
 * carry closed vocabularies (`field`, `code`) and nothing else, per CLAUDE.md
 * §8. Echoing an input back to its own author discloses nothing; writing it to
 * disk or to Sentry would.
 */

/** Machine-readable reasons a single settings field was not applied. */
export const SETTINGS_REFUSAL_CODES = ['unknown_export_tool'] as const

export type SettingsRefusalCode = (typeof SETTINGS_REFUSAL_CODES)[number]

/**
 * Fields that a save may lose one at a time. A closed union, not `string`:
 * these values travel into a telemetry tag domain
 * (`settings_refused_field` in electron/metricsSchema.ts) and into a log line,
 * and the type is what states in the compiler that neither can ever receive a
 * name the renderer chose.
 */
export const SETTINGS_REFUSABLE_FIELDS = ['mcpExportWhitelist'] as const

export type SettingsRefusableField = (typeof SETTINGS_REFUSABLE_FIELDS)[number]

/**
 * Upper bounds on the echoed `values`.
 *
 * The array being described is renderer-writable, so its size and the length of
 * its members are chosen by the sender. A compromised window could hand over
 * ten thousand kilobyte-long strings and have main mirror all of it back in one
 * IPC reply. Nothing is protected by that reply being complete: it exists so a
 * settings window can drop a handful of stale tool names from its own state.
 * Anything past the caps is counted as refused (the FIELD is still dropped) but
 * not named.
 */
export const MAX_REFUSED_VALUES = 64
export const MAX_REFUSED_VALUE_LENGTH = 200

/** One field of a `settings:save` payload that was dropped, and why. */
export interface RefusedSettingsField {
  field: SettingsRefusableField
  code: SettingsRefusalCode
  /**
   * The submitted entries that failed, de-duplicated, in the order they were
   * seen. Renderer-facing only — see the module header.
   *
   * May be shorter than the number of offending entries, and empty even for a
   * real refusal: non-string members are omitted (they are not names the
   * renderer can match by identity, and a `string[]` field can be cleaned of
   * them without knowing the domain), overlong ones are omitted rather than
   * truncated (a cut-off string looks like a name and equals nothing), and the
   * caps above stop there. A consumer must therefore treat `values` as "these
   * are known to be bad", never as "these are the only bad ones".
   */
  values: string[]
}

/**
 * Structural view of a zod issue. Declared here rather than imported so this
 * module stays a pure function library with no dependency on the schema (or on
 * a particular zod major); `ZodError.issues` is assignable to it.
 */
export interface RendererSettingsIssue {
  readonly code: string
  readonly path: readonly PropertyKey[]
  /** Present on `unrecognized_keys` issues. */
  readonly keys?: unknown
}

/**
 * The only failures that may be answered with a per-field refusal.
 *
 * `mcpExportWhitelist` + `invalid_value` = an entry outside
 * `EXPORTABLE_MCP_TOOLS` (zod v4 reports an out-of-domain enum member with
 * that code). A wrong TYPE for the same field (`invalid_type` — not an array
 * at all) is deliberately absent: that is a renderer bug rather than stale
 * persisted data, `unknown_export_tool` would misdescribe it, and the old
 * throwing path says so more loudly.
 */
const REFUSABLE_FIELDS: ReadonlyArray<{
  field: SettingsRefusableField
  issueCode: string
  code: SettingsRefusalCode
}> = [
  { field: 'mcpExportWhitelist', issueCode: 'invalid_value', code: 'unknown_export_tool' },
]

export interface PartitionedSettingsIssues {
  /**
   * Keys the strict schema did not recognize, in the order zod reported them.
   * The caller decides which of them are main-only (§3.10 P0) — this module
   * does not own that list.
   */
  forbidden: string[]
  /**
   * Fields to drop from the payload before merging — one entry per field, no
   * matter how many of its entries failed; the offending entries themselves are
   * collected into that one entry's `values`.
   */
  refusedFields: RefusedSettingsField[]
  /**
   * §2.218.f2 — KNOWN fields whose value failed the renderer schema and which
   * are NOT on the refusal allowlist. De-duplicated, in first-seen order.
   *
   * The module header has always said these "keep the old behaviour — it falls
   * through to `settingsSchema.parse`, which throws". That was true only while
   * the persisted schema happened to reject the same value, i.e. the whole-save
   * refusal was INCIDENTAL, borrowed from a second schema that exists for a
   * different purpose. The moment a field was made tolerant on the persisted
   * side (`aiProvider` gained `.catch(undefined)` so a removed provider on disk
   * could not brick the settings load), the coupling broke and the documented
   * throw silently became a SILENT MUTATION: the renderer schema rejected
   * `aiProvider: 'subscription'`, nothing acted on that rejection, the merge
   * carried the value into the persisted parse, `.catch` turned it into "unset"
   * and the handler answered `{ ok: true }` — a stale or compromised window
   * could CLEAR a configured AI provider and have the rest of its payload
   * applied.
   *
   * So the refusal is stated here instead of being inferred downstream. The
   * caller throws before merging, which makes the behaviour independent of how
   * lax the persisted schema is for any particular field.
   *
   * Deliberately NOT the same thing as adding a field to {@link REFUSABLE_FIELDS}:
   * that list is an enumerated exception set for failures we have reasoned about
   * one at a time, and a value-level failure on a field nobody has reasoned
   * about must still kill the whole save.
   *
   * `unrecognized_keys` issues are NOT counted here. They are reported through
   * `forbidden`, where the caller applies the §3.10 P0 main-only gate; an
   * unknown key that is not main-only keeps falling through to the soft
   * persistent schema, which silently discards it. That behaviour predates
   * §2.167 and is not what this field is for.
   *
   * Values are never carried — only field names, which come from our own schema
   * and are therefore safe for a log line (CLAUDE.md §8).
   */
  unhandledFields: string[]
}

/**
 * Follow a zod issue path into the payload it was produced from.
 *
 * Zod does not carry the offending value on the issue itself — `invalid_value`
 * reports the ALLOWED options in its own `values` field, and the received one
 * only appears inside the human message, which never leaves this module. The
 * path is the reliable way back to it: `['mcpExportWhitelist', 3]` is entry 3
 * of the submitted array.
 *
 * Anything unexpected on the way (a shorter payload than the issue describes, a
 * primitive where a container was expected) answers `undefined`, which the
 * caller reads as "nothing nameable here" rather than as an error: the field is
 * refused either way, this only decides whether the refusal can name a value.
 */
function readIssuePathValue(payload: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = payload
  for (const segment of path) {
    if (cursor === null || (typeof cursor !== 'object' && typeof cursor !== 'function')) {
      return undefined
    }
    if (typeof segment === 'symbol') return undefined
    // Own properties only: a payload arriving over IPC is a plain structured
    // clone, and reading up a prototype chain could only ever produce something
    // the sender did not send.
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined
    cursor = (cursor as Record<PropertyKey, unknown>)[segment]
  }
  return cursor
}

/**
 * Split the failures of `rendererWritableSettingsSchema.safeParse` into the
 * two verdicts the handler acts on. Issues matching neither are ignored on
 * purpose: they keep falling through to `settingsSchema.parse`.
 *
 * `payload` is the object that was parsed. It is optional so the function stays
 * usable as a pure classifier; without it a refusal is reported exactly as
 * before, just with an empty `values`.
 */
export function partitionRendererSettingsIssues(
  issues: readonly RendererSettingsIssue[],
  payload?: unknown,
): PartitionedSettingsIssues {
  const forbidden: string[] = []
  const refusedFields: RefusedSettingsField[] = []
  const unhandledFields: string[] = []
  const seenUnhandled = new Set<string>()
  // One entry per field: later issues for the same field add their value to the
  // refusal that already exists rather than producing a second line.
  const byField = new Map<string, { refusal: RefusedSettingsField; values: Set<string> }>()

  // §2.218.f2 — an issue that matches neither verdict is recorded rather than
  // dropped. `continue` used to mean "someone downstream will deal with it";
  // nobody did, and the one field where the persisted schema stopped agreeing
  // turned that silence into a silent write. See `unhandledFields`.
  const noteUnhandled = (field: unknown) => {
    const name = typeof field === 'string' ? field : '(non-string path)'
    if (seenUnhandled.has(name)) return
    seenUnhandled.add(name)
    unhandledFields.push(name)
  }

  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as { keys?: unknown }).keys
      if (Array.isArray(keys)) {
        for (const key of keys) if (typeof key === 'string') forbidden.push(key)
      }
      continue
    }
    // A field-level refusal is only meaningful for a TOP-LEVEL field: that is
    // the granularity at which the payload can be stripped.
    const field = issue.path[0]
    if (typeof field !== 'string') { noteUnhandled(field); continue }
    const match = REFUSABLE_FIELDS.find(r => r.field === field && r.issueCode === issue.code)
    if (!match) { noteUnhandled(field); continue }
    let entry = byField.get(match.field)
    if (!entry) {
      entry = { refusal: { field: match.field, code: match.code, values: [] }, values: new Set() }
      byField.set(match.field, entry)
      refusedFields.push(entry.refusal)
    }
    if (entry.refusal.values.length >= MAX_REFUSED_VALUES) continue
    const offending = readIssuePathValue(payload, issue.path)
    if (typeof offending !== 'string') continue
    if (offending.length > MAX_REFUSED_VALUE_LENGTH) continue
    if (entry.values.has(offending)) continue
    entry.values.add(offending)
    entry.refusal.values.push(offending)
  }

  return { forbidden, refusedFields, unhandledFields }
}

/**
 * Remove the refused fields from an incoming payload.
 *
 * Shallow copy + `delete`, so a key the renderer sent as an EXPLICIT
 * `undefined` survives on every other field — the settings window uses that to
 * mean "cleared input", and §2.119 reads it as a request to move the AI
 * destination. Rebuilding the object from defined entries would erase that
 * distinction. The named exceptions, where an `undefined` must NOT clear, are
 * handled by {@link dropErasingUndefined} — a separate pass with its own
 * allowlist, so "clear" stays the default reading of the two.
 *
 * A non-object payload is returned untouched: it cannot carry fields, so there
 * is nothing to strip, and the caller's own validation still owns the verdict.
 */
export function stripRefusedFields(
  payload: unknown,
  refusedFields: readonly RefusedSettingsField[],
): unknown {
  if (refusedFields.length === 0) return payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  for (const { field } of refusedFields) delete copy[field]
  return copy
}

/**
 * Fields an explicit `undefined` may not erase.
 *
 * THE PROPERTY THAT PUTS A FIELD HERE — and the only one: its ABSENCE from the
 * persisted store is read downstream as a WIDER permission than any value it
 * can hold. `mcpExportWhitelist` is such a field. `resolveExportWhitelist` in
 * electron/services/mcpExport.ts treats a nullish value as "the caller
 * expressed no preference" and serves `DEFAULT_EXPORT_WHITELIST`, so a stored
 * list that narrows the exported tool surface disappears into a wider default
 * the moment the key leaves the store.
 *
 * WHAT WENT WRONG WITHOUT THIS. `{ ...current, ...payload }` distinguishes a
 * key that is ABSENT from one that is PRESENT with `undefined`: the first keeps
 * the persisted value, the second overwrites it with `undefined`, which
 * `saveSettings` then drops from disk. Both are spelled "no value" in a payload
 * that was built by object literal, and the writable schema accepts either
 * (every field is `.optional()`), so a renderer that meant "leave this one
 * alone" and said it with an explicit `undefined` silently widened the export
 * surface on the next start. Reachable from an HONEST settings window — a
 * persisted tool name too long to be echoed back in a refusal cannot be
 * repaired, so the window withholds the field — and trivially from a
 * compromised one, which is the reason the rule lives in main and not in a
 * renderer helper.
 *
 * "EXPORT NOTHING" IS STILL SAYABLE, with an explicit `[]`. An empty array is a
 * value, not an absence: it survives here untouched and is written as-is.
 *
 * WHY NOT SIMPLY DROP EVERY `undefined`. On this very channel a present-but-
 * undefined key is the ONLY way to clear a field, and three live flows depend
 * on it: §2.119 reads it as "clear this address" (the settings window sends
 * `aiOpenAiBaseUrl: aiOpenAiBaseUrl || undefined`), "Reset AI provider" sends
 * `{ aiProvider: undefined }` as its entire payload, and the trusted-domain
 * list is emptied by `trustedDomains: trustedDomains || undefined`. A blanket
 * rule turns all three into no-ops — and the last two in the UNSAFE direction,
 * leaving a provider and a trusted-domain list the user asked to remove. So the
 * fields are named, and a candidate has to be argued against the property
 * above rather than added because it looks similar.
 *
 * DISJOINT FROM `AI_DESTINATION_FIELDS`, pinned by a test. Those two fields are
 * (re)written downstream from this same normalised object
 * (`applyAiDestinationOverrides`), so listing one here would delete the clear
 * in the one place §2.119 performs it, not just in the merge.
 */
export const UNERASABLE_SETTINGS_FIELDS = ['mcpExportWhitelist'] as const

export type UnerasableSettingsField = (typeof UNERASABLE_SETTINGS_FIELDS)[number]

/**
 * Read an explicit `undefined` as "key omitted" for {@link UNERASABLE_SETTINGS_FIELDS}.
 *
 * Returns the payload itself when nothing matched, so the common save allocates
 * no copy. A non-object payload is returned untouched for the same reason as in
 * {@link stripRefusedFields}: it carries no fields, and the caller's own
 * validation owns the verdict on it.
 */
export function dropErasingUndefined(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const source = payload as Record<string, unknown>
  let copy: Record<string, unknown> | null = null
  for (const field of UNERASABLE_SETTINGS_FIELDS) {
    // Own properties only — same reasoning as `readIssuePathValue`: an IPC
    // payload is a structured clone, so a prototype hit is never what was sent.
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue
    if (source[field] !== undefined) continue
    copy ??= { ...source }
    delete copy[field]
  }
  return copy ?? payload
}
