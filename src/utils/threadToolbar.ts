/**
 * Pure helpers that resolve the thread-aware action targets used by the
 * mail-viewer top toolbar in `App.tsx`. Extracted out of the App.tsx hotspot
 * so that:
 *   1. The thread-vs-single decision is testable without rendering App.
 *   2. Future call sites (Compose toolbar, command palette) reuse the same rule.
 *
 * Contract — kept identical to the inline logic in App.tsx:
 *   isThreadMode  = groupConversations === true && activeThread != null && activeThread.count > 1
 *   latestMail    = newest message in the thread by `date` (descending). Falls back to `active`
 *                   when the thread is empty or not in thread-mode.
 *   replyTarget   = latestMail when in thread-mode, otherwise active.
 *   threadUnread  = number of items in the thread with `unread === true`. Zero outside thread-mode.
 *
 * Sort tie-breaker: when two messages share the same date, the original
 * order in `activeThread.items` is preserved (Array.prototype.sort is stable
 * in all modern JS engines per ECMA-2019). Dates that fail to parse are
 * coerced to NaN by `new Date(...).getTime()`; they sort to the bottom on
 * descending sort, so they never silently win as "latest".
 */

import type { MailSummary } from '@mailcopilot/types'
import type { ThreadRow } from './threading'

/** True when the viewer should treat the open mail as part of a multi-message thread. */
export function isThreadMode(
  groupConversations: boolean,
  activeThread: ThreadRow | null | undefined,
): boolean {
  return Boolean(groupConversations && activeThread && activeThread.count > 1)
}

/**
 * Newest mail in the thread by parsed date. When `activeThread` is empty or
 * `inThreadMode === false`, returns the provided `fallback` (the currently
 * active mail). Items with un-parseable dates sort to the bottom and never
 * win as "latest".
 */
export function pickLatestMail(
  activeThread: ThreadRow | null | undefined,
  fallback: MailSummary,
  inThreadMode: boolean,
): MailSummary {
  if (!inThreadMode || !activeThread || activeThread.items.length === 0) {
    return fallback
  }
  const sorted = [...activeThread.items].sort((a, b) => {
    const ta = new Date(b.date).getTime()
    const tb = new Date(a.date).getTime()
    // NaN comparisons return false on both sides → treat NaN as -Infinity
    // so it sinks to the bottom of a descending sort.
    const aNum = Number.isFinite(ta) ? ta : Number.NEGATIVE_INFINITY
    const bNum = Number.isFinite(tb) ? tb : Number.NEGATIVE_INFINITY
    return aNum - bNum
  })
  return sorted[0] ?? fallback
}

/** Whichever message a Reply / ReplyAll / Forward / Snooze button should target. */
export function pickReplyTarget(
  active: MailSummary,
  latestMail: MailSummary,
  inThreadMode: boolean,
): MailSummary {
  return inThreadMode ? latestMail : active
}

/** Count of unread items in the thread. Returns 0 outside thread-mode. */
export function countThreadUnread(
  activeThread: ThreadRow | null | undefined,
  inThreadMode: boolean,
): number {
  if (!inThreadMode || !activeThread) return 0
  return activeThread.items.filter(m => m.unread).length
}
