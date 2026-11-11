/**
 * Normalisation of a model-supplied instant for the scheduling MCP tools
 * (`preview_snooze_email` → `wakeAt`, `preview_add_followup` → `remindAt`).
 *
 * WHY THIS EXISTS. Both values end up in SQLite (`snoozed.wake_at`,
 * `follow_ups.remind_at`) and firing is decided by a STRING comparison against
 * `new Date().toISOString()` (`wake_at <= ?`, `remind_at <= ?` in
 * `packages/db/index.ts`). A string comparison is only a time comparison when
 * every stored value is in the SAME canonical form — UTC, `Z`-suffixed, with
 * millisecond precision. Anything else silently misfires:
 *
 *   - `2026-09-23T09:00:00+03:00` sorts as if it were 09:00 UTC, so the email
 *     comes back three hours late;
 *   - a wall-clock time with no offset (`2026-09-23T09:00:00`) is read
 *     against whatever the writer happened to mean;
 *   - a non-ISO string (`tomorrow 09:00`) is lexicographically GREATER than
 *     every ISO timestamp, so the row is never due — the email never returns
 *     and nothing reports a failure.
 *
 * The UI path is already safe: the renderer calls `wakeAt.toISOString()` and
 * `main.ts` validates with `z.string().datetime({ offset: true })`. The MCP
 * tools accepted `z.string().min(1)` and wrote the model's string through
 * unchanged. This module gives the tool path the same grammar (literally the
 * same zod validator) plus the normalisation the renderer was doing by hand.
 *
 * DELIBERATELY A REFUSAL, NOT A REPAIR. We do not guess an offset for a naive
 * time and we do not parse natural language: both would put us in the position
 * of deciding what the user meant. The model gets a machine-readable reason
 * and the exact required shape, so it can re-ask the user or re-derive the
 * instant and call again. Silently writing an unusable value is the failure
 * mode this module exists to remove.
 *
 * Kept out of `ai.ts` on purpose (hotspot policy, CLAUDE.md §4): pure, no
 * Electron and no database imports, so it is unit-testable on its own.
 */
import { z } from 'zod'

/**
 * Same validator the UI path uses (`snoozeWakeAtSchema` in `electron/main.ts`).
 * `offset: true` accepts `Z` AND an explicit `±HH:MM`, and rejects a bare
 * wall-clock time. Sharing the constructor rather than hand-rolling a regex is
 * the point: two grammars for one contract drift apart.
 */
const isoInstantWithOffset = z.string().datetime({ offset: true })

/**
 * Upper bound on how far ahead a model may schedule.
 *
 * NAMED DIVERGENCE FROM THE UI PATH: the snooze dropdown has no ceiling at all
 * (`SnoozeDropdown.tsx` only enforces `> Date.now()`), and this bound does not
 * change it.
 *
 * The justification is NOT that a hallucinated year would be invisible — the
 * confirmation card renders the scheduled instant, so a human who reads it
 * sees the year. The bound is defence in depth for the case where the human
 * does not read it: Apply is one click at the end of a chat turn, and a
 * plausible-looking card is exactly what a user clicks through. Five years is
 * far past any real "remind me later" and near enough that a typo'd millennium
 * is caught before it becomes a row that can never come due in a human
 * lifetime. It is a bound on a value supplied by a model that may be relaying
 * injected email text, not a limit we are imposing on the user's own choices.
 */
export const AI_SCHEDULE_MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000

export type ScheduleInstantRefusalReason =
  | 'not_iso_offset'
  | 'in_past'
  | 'too_far_future'

export type ScheduleInstantResult =
  | { ok: true; iso: string }
  | { ok: false; reason: ScheduleInstantRefusalReason; message: string }

/**
 * The current instant rendered as a local ISO 8601 string with an explicit
 * offset (`2026-09-22T17:40:05+03:00`).
 *
 * The system prompt carries this so the model can resolve "tomorrow at 9" into
 * an absolute instant. Without it the refusal below is a dead end: the model
 * would know the required shape but not the user's offset, and would have to
 * ask the user for their timezone.
 */
export function localIsoWithOffset(now: Date = new Date()): string {
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  const shifted = new Date(now.getTime() + offsetMin * 60_000)
  return `${shifted.toISOString().slice(0, 19)}${sign}${hh}:${mm}`
}

/**
 * Validate a model-supplied instant and normalise it to canonical UTC.
 *
 * @param raw   the value as the model sent it
 * @param field the parameter name, so the refusal names what to fix
 * @param nowMs injected clock, so tests do not depend on the wall clock
 */
export function normalizeScheduleInstant(
  raw: string,
  field: string,
  nowMs: number = Date.now(),
): ScheduleInstantResult {
  const parsed = isoInstantWithOffset.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'not_iso_offset',
      message:
        `"${field}" must be an absolute instant in ISO 8601 form WITH an explicit UTC offset, ` +
        `for example "2026-09-23T09:00:00+03:00" or "2026-09-23T06:00:00Z". ` +
        `A wall-clock time without an offset ("2026-09-23T09:00:00") and natural language ` +
        `("tomorrow 09:00", "in 2 hours") are rejected. Resolve the user's wording against ` +
        `the current time given at the top of this conversation, then call the tool again. ` +
        `Nothing was scheduled.`,
    }
  }

  const ms = Date.parse(parsed.data)
  if (Number.isNaN(ms)) {
    // Defence in depth: zod already rejects impossible calendar dates, so
    // reaching here would mean the grammar and Date disagree.
    return {
      ok: false,
      reason: 'not_iso_offset',
      message: `"${field}" is not a representable date. Nothing was scheduled.`,
    }
  }

  const iso = new Date(ms).toISOString()

  if (ms <= nowMs) {
    return {
      ok: false,
      reason: 'in_past',
      message:
        `"${field}" resolves to ${iso}, which is not in the future ` +
        `(now is ${new Date(nowMs).toISOString()}). Pick a later instant and call the tool again. ` +
        `Nothing was scheduled.`,
    }
  }

  if (ms - nowMs > AI_SCHEDULE_MAX_FUTURE_MS) {
    return {
      ok: false,
      reason: 'too_far_future',
      message:
        `"${field}" resolves to ${iso}, which is more than 5 years away. ` +
        `If that year is correct, ask the user to confirm it; otherwise correct it and call the ` +
        `tool again. Nothing was scheduled.`,
    }
  }

  return { ok: true, iso }
}
