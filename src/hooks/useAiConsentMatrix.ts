/**
 * useAiConsentMatrix — §1.26.1(3): one grid for every per-account AI consent.
 *
 * Four AI features are opt-in per mailbox (`aiThreadSummaryEnabled`,
 * `aiInstantReplyEnabled`, `aiProofreadEnabled`, `aiTranslateEnabled`), all of
 * them stored as `Record<stringified accountId, boolean>` and all defaulting to
 * OFF. The Settings AI tab used to render them as four separate sections, each
 * repeating the SAME account picker — four copies of one control, all bound to
 * one `accountId` state and all carrying the same `data-testid`. A reader could
 * not tell that the four pickers were one picker, and answering "which of my
 * mailboxes may use which feature" meant four passes over the same list.
 *
 * The shape that answers that question in one look is a grid: a row per mailbox,
 * a column per feature, a checkbox at the crossing. This module owns the whole
 * derivation — column tri-state, the bulk column action, the individual cell —
 * as pure functions plus a thin hook, so `src/windows/Settings.tsx` (a CLAUDE.md
 * §5 hotspot) only supplies state and renders (`AiConsentMatrix`).
 *
 * ## Why the bulk action is per COLUMN and never per grid
 *
 * EDPB Guidelines 05/2020 on consent (§3.2, "granularity"): consent is asked
 * separately for each purpose, and a single control that grants several distinct
 * purposes at once is not specific consent. The four features are four purposes
 * — summarising a thread, drafting a reply, checking spelling, translating —
 * so "allow this ONE feature in all my mailboxes" is a legitimate shortcut over
 * a repetitive axis, while "allow everything everywhere" is not offered at all.
 * There is deliberately no such affordance in this module: it is missing by
 * design, not missing by omission.
 * https://www.edpb.europa.eu/system/files/documents/files/file1/edpb_guidelines_202005_consent_en.pdf
 *
 * ## Why withdrawal is never harder than granting
 *
 * The column control is a three-state checkbox (all / some / none) — the
 * mixed-state convention from the Win32 UX guide, meaning "set for part of the
 * collection". Only `none` grants; `some` and `all` both withdraw, so from ANY
 * state withdrawal is one click (`nextColumnValue`). The first shape of this
 * cycle mapped `some` to "grant to everyone", which made granting from a mixed
 * column cost one click and withdrawing cost two — precisely the asymmetry
 * §2.82 forbids for telemetry consent, and for the same reason: the safe
 * direction may never be the expensive one. The price of the current cycle is
 * that "finish granting the rest" from a mixed column now takes two clicks
 * (withdraw, then grant), and that is the direction the asymmetry is allowed
 * to point.
 *
 * There is no confirmation dialog on either side either, and above all none on
 * the granting side that the withdrawing side does not have. It is safe to skip
 * the dialog because the result is visible in the very table the click happened
 * in and the inverse costs one click; nothing was sent, spent or disclosed by
 * the toggle itself — the consent only decides whether a LATER, explicit user
 * action is allowed to call a provider.
 *
 * ## Why the caller is handed an UPDATER, not a map
 *
 * `onChangeFeature` passes a function of the previous map, never a map computed
 * from the render-time snapshot. Two writes to the same feature coalesced into
 * one React batch would otherwise resolve as "last one wins over a stale map",
 * and the write that can be lost that way is a WITHDRAWAL — the unsafe
 * direction. React 18 does not reach that state through the discrete handlers
 * this grid uses, so this is depth, not a live defect; it costs one closure.
 *
 * What the updater does NOT re-derive is the DECISION: `nextColumnValue` is
 * evaluated on the state the user saw and clicked, and only the merge happens
 * against `prev`.
 *
 * ## What this module can and cannot promise about the label
 *
 * It publishes `AiConsentColumn.grants` — the exact value the column's click
 * will write — so a caller CAN name the control after what it does instead of
 * guessing from `state`. It cannot make the caller do so: this hook builds no
 * label and sees none, and a component is free to render its own words. That
 * half of the promise is held by `AiConsentMatrix` (which derives the
 * accessible name from `col.grants`) and pinned by its tests, not by anything
 * here.
 */

import { useCallback, useMemo } from 'react'

/** The four per-account AI opt-ins, in the order the grid renders them. */
export const AI_CONSENT_FEATURES = [
  'threadSummary',
  'instantReply',
  'proofread',
  'translate',
] as const

export type AiConsentFeature = (typeof AI_CONSENT_FEATURES)[number]

/**
 * Persisted shape of one opt-in: stringified account id → granted.
 *
 * A missing key and `false` mean the same thing (not granted) — the default is
 * OFF and every main-side gate treats "not exactly `true`" as a refusal. This
 * module never relies on absence, and never manufactures a `true` for a key it
 * did not find: no migration, no back-fill, no "repair" of an empty map.
 */
export type AiConsentMap = Record<string, boolean>

/**
 * How this module asks for a map to be persisted: a function of the previous
 * value, so a batched write can never resolve against a stale snapshot. See
 * "Why the caller is handed an UPDATER" above.
 */
export type AiConsentMapUpdate = (prev: AiConsentMap) => AiConsentMap

/** All four maps as the grid sees them. */
export type AiConsentValue = Record<AiConsentFeature, AiConsentMap>

/** Column header state — `some` renders as the mixed (indeterminate) checkbox. */
export type AiConsentColumnState = 'none' | 'some' | 'all'

/** Whether one mailbox has granted one feature. Strict `=== true`, like main. */
export function isConsentGranted(map: AiConsentMap, accountId: number): boolean {
  return map[String(accountId)] === true
}

/**
 * Tri-state of a column over the CURRENTLY KNOWN mailboxes.
 *
 * Derived from `accountIds` rather than from the map's own keys on purpose: the
 * map can still hold entries for a mailbox that was deleted, and those must not
 * make the header claim "some" for a set the user cannot see. An empty mailbox
 * list is `none` — nothing is granted, because there is nothing to grant to.
 */
export function consentColumnState(
  map: AiConsentMap,
  accountIds: readonly number[],
): AiConsentColumnState {
  if (accountIds.length === 0) return 'none'
  let granted = 0
  for (const id of accountIds) if (isConsentGranted(map, id)) granted++
  if (granted === 0) return 'none'
  return granted === accountIds.length ? 'all' : 'some'
}

/** One cell written; every other entry, including unknown ids, carried through. */
export function withConsent(
  map: AiConsentMap,
  accountId: number,
  next: boolean,
): AiConsentMap {
  return { ...map, [String(accountId)]: next }
}

/**
 * One whole column written for the listed mailboxes.
 *
 * Entries for ids NOT in the list survive untouched: a mailbox that is merely
 * absent from this render (not yet loaded, or removed while the window was
 * open) must not have its recorded answer rewritten by a click aimed at other
 * mailboxes. Withdrawal writes an explicit `false` rather than deleting the key,
 * so the record says "asked and refused" instead of "never asked".
 */
export function withColumnConsent(
  map: AiConsentMap,
  accountIds: readonly number[],
  next: boolean,
): AiConsentMap {
  const out: AiConsentMap = { ...map }
  for (const id of accountIds) out[String(id)] = next
  return out
}

/**
 * Result of clicking a column header: grant only from a column nobody has
 * granted; from every other state, withdraw.
 *
 * `some -> none` rather than `some -> all` is the load-bearing half — see
 * "Why withdrawal is never harder than granting" above. Exported so the tests
 * can pin the whole cycle and the header can label itself from the same value.
 */
export function nextColumnValue(state: AiConsentColumnState): boolean {
  return state === 'none'
}

export type AiConsentColumn = {
  feature: AiConsentFeature
  state: AiConsentColumnState
  /**
   * What `toggleAll` would write. Exposed so a caller can name the header after
   * what the click does in each of the three states instead of guessing from
   * `state` — `AiConsentMatrix` does exactly that; this module cannot check
   * that any caller does.
   */
  grants: boolean
  /** Grant to every listed mailbox, or withdraw from every one. */
  toggleAll: () => void
}

export type AiConsentCell = {
  feature: AiConsentFeature
  granted: boolean
  toggle: (next: boolean) => void
}

export type AiConsentRow = {
  accountId: number
  cells: AiConsentCell[]
}

export type UseAiConsentMatrixParams = {
  /** Mailboxes to render, in display order. */
  accountIds: readonly number[]
  /** Current value of all four opt-ins. */
  value: AiConsentValue
  /**
   * Persist a whole feature map; the caller owns the four `useState` setters
   * and passes the updater straight to the matching one.
   */
  onChangeFeature: (feature: AiConsentFeature, update: AiConsentMapUpdate) => void
}

export type UseAiConsentMatrixResult = {
  columns: AiConsentColumn[]
  rows: AiConsentRow[]
  /** Number of mailboxes a column action would affect — copy says it out loud. */
  accountCount: number
}

export function useAiConsentMatrix({
  accountIds,
  value,
  onChangeFeature,
}: UseAiConsentMatrixParams): UseAiConsentMatrixResult {
  const ids = useMemo(() => [...accountIds], [accountIds])

  const setFeature = useCallback(
    (feature: AiConsentFeature, update: AiConsentMapUpdate) => onChangeFeature(feature, update),
    [onChangeFeature],
  )

  const columns = useMemo<AiConsentColumn[]>(
    () =>
      AI_CONSENT_FEATURES.map(feature => {
        const state = consentColumnState(value[feature], ids)
        const grants = nextColumnValue(state)
        return {
          feature,
          state,
          grants,
          toggleAll: () => setFeature(feature, prev => withColumnConsent(prev, ids, grants)),
        }
      }),
    [ids, setFeature, value],
  )

  const rows = useMemo<AiConsentRow[]>(
    () =>
      ids.map(accountId => ({
        accountId,
        cells: AI_CONSENT_FEATURES.map(feature => ({
          feature,
          granted: isConsentGranted(value[feature], accountId),
          toggle: (next: boolean) =>
            setFeature(feature, prev => withConsent(prev, accountId, next)),
        })),
      })),
    [ids, setFeature, value],
  )

  return { columns, rows, accountCount: ids.length }
}
