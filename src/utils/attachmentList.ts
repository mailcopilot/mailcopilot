/**
 * Attachment list model for the mail viewer — pure logic, no DOM, no IPC.
 *
 * **Nothing in this module ever removes a part from the list.** That is the
 * §2.128 final shape, and it is the whole point.
 *
 * Earlier revisions subtracted the parts the body had inlined, on the theory
 * that a chip for an image the reader can already see is noise. Six review
 * rounds narrowed the rule that decides "already seen" and a security pass then
 * showed the narrowing can never be finished: `<div style="display:none"><img
 * src="cid:report"></div>` satisfies every condition we can check from outside
 * the browser, yet draws nothing. Whether a pixel reached the screen is decided
 * by layout and the cascade — by the browser — so any rule of ours is a guess,
 * and a wrong guess costs the user a file.
 *
 * So the guarantee changed from "we show the chips the body did not draw" to
 * one we can actually keep: **the attachments stay reachable, and the list
 * stays bounded.** Concretely:
 *
 *  - **Order** — real attachments first, inlined parts after them
 *    ({@link orderAttachments}). The inlined ones are demoted, not dropped.
 *  - **Cap** — only the leading real attachments render while the list is
 *    collapsed, up to {@link ATTACHMENT_COLLAPSED_LIMIT}
 *    ({@link capAttachmentList}). Everything else — inlined parts *and* real
 *    attachments past the ceiling — sits behind the same toggle.
 *  - **Expanding shows every part, with no exception.**
 *
 * The consequence worth stating out loud: a message cannot make an attachment
 * unreachable. Misjudging "inline" now costs one extra click instead of a file,
 * which retires the whole class of findings rather than its latest instance.
 *
 * `buildAttachmentList({ groupInline: false })` runs the cap with the grouping
 * fully disabled — the executable proof that the ceiling does not depend on any
 * inline judgement at all.
 *
 * **This module owns no opinion about which parts are inline.** The decision
 * lives in one place — `useMailIframeDoc`, which fetches and substitutes the
 * bytes and therefore knows what it substituted — and arrives here as a ready
 * list (`inlineParts`). See `packages/core/cidRefs.ts` for the four conditions
 * it applies; they now choose "first or behind the toggle", not "shown or
 * lost".
 *
 * Deliberately free of any `dompurify` import (unlike `src/utils/mail.ts`) so
 * the module stays testable under the default node environment.
 */

import type { AttachmentMeta } from '../../packages/types'

/** Chips rendered while the list is collapsed. */
export const ATTACHMENT_COLLAPSED_LIMIT = 4

export type AttachmentListOptions = {
  /** Raw parts as reported by the server (`MessageDetails.attachments`). */
  attachments?: AttachmentMeta[] | null
  /**
   * The parts the body renderer inlined, as reported by
   * `useMailIframeDoc().hiddenAttachments`.
   *
   * These are demoted below the real attachments and, while collapsed, live
   * behind the toggle. They are never removed.
   *
   * Absent or empty means "nothing was inlined", so the list is simply the
   * server's own order.
   */
  inlineParts?: readonly AttachmentMeta[] | null
  /** Whether the user expanded the list for the current message. */
  expanded?: boolean
  /** Chips rendered while collapsed. */
  collapsedLimit?: number
  /**
   * Grouping kill switch. When `false`, nothing is reordered and nothing is
   * deduplicated — the list is exactly what the server sent, and only the cap
   * applies. Exists so the cap can be exercised without any inline judgement.
   */
  groupInline?: boolean
}

export type AttachmentListModel = {
  /** Every part, real attachments first, inlined parts after (post-dedupe). */
  items: AttachmentMeta[]
  /** Subset to render right now (capped unless expanded). */
  visible: AttachmentMeta[]
  /** `items.length` — every part the message carries. */
  total: number
  /** How many chips are not on screen right now — the number on the toggle. */
  hiddenCount: number
  /** Whether an expand/collapse toggle should be rendered at all. */
  canExpand: boolean
  /** Echo of the requested expanded state, normalized to a boolean. */
  expanded: boolean
}

/**
 * Membership test for the reported inline set.
 *
 * Object identity, not a `cid` / filename / path comparison: `inlineParts` and
 * `attachments` are the same `MessageDetails.attachments` entries in the same
 * render pass, so identity is exact and needs no key. A key would be one more
 * thing that could disagree with the renderer.
 */
function inlineSet(inlineParts?: readonly AttachmentMeta[] | null): Set<AttachmentMeta> {
  return new Set<AttachmentMeta>(inlineParts ?? [])
}

/**
 * The parts the renderer did NOT report as inlined — the ones that get the
 * collapsed row. Order is preserved.
 *
 * Note what this is no longer: a filter deciding who stays in the list. Its
 * result decides *placement*, and its complement ({@link selectInlineAttachments})
 * is appended right after it.
 */
export function selectRealAttachments(
  attachments: AttachmentMeta[],
  inlineParts?: readonly AttachmentMeta[] | null,
): AttachmentMeta[] {
  if (!inlineParts || inlineParts.length === 0) return attachments.slice()
  const inline = inlineSet(inlineParts)
  return attachments.filter(att => !inline.has(att))
}

/** The reported parts, in the server's original order. */
export function selectInlineAttachments(
  attachments: AttachmentMeta[],
  inlineParts?: readonly AttachmentMeta[] | null,
): AttachmentMeta[] {
  if (!inlineParts || inlineParts.length === 0) return []
  const inline = inlineSet(inlineParts)
  return attachments.filter(att => inline.has(att))
}

/**
 * Real attachments first, inlined parts after — a stable partition that keeps
 * the server's order inside each group and loses nothing.
 *
 * A part carrying `Content-Disposition: attachment` cannot end up in the second
 * group: `useMailIframeDoc` never reports one (condition 2 in
 * `packages/core/cidRefs.ts`), and this function only moves what it is told.
 */
export function orderAttachments(
  attachments: AttachmentMeta[],
  inlineParts?: readonly AttachmentMeta[] | null,
): { items: AttachmentMeta[]; realCount: number } {
  const real = selectRealAttachments(attachments, inlineParts)
  if (real.length === attachments.length) return { items: real, realCount: real.length }
  return {
    items: [...real, ...selectInlineAttachments(attachments, inlineParts)],
    realCount: real.length,
  }
}

/**
 * Identity key for deduplication: the MIME part path, and nothing else.
 *
 * The part path is the only field that *identifies* a part — it is what
 * `net:attachmentBase64` / `net:saveAttachment` address, so two entries sharing
 * it necessarily denote the same bytes, and two entries not sharing it may not.
 *
 * Earlier revisions also collapsed on a shared `cid`, and on
 * filename + type + size, arguing that such parts are "indistinguishable to the
 * user anyway". Indistinguishable in the *list* is not the same as identical:
 * none of those fields is derived from the content, and all of them are set by
 * the sender. A message carrying `report.pdf` twice — same declared type, same
 * declared size, different bytes — would have silently lost one of them, and
 * §2.128 accepts no direction in which a part disappears.
 *
 * Compactness is not this function's job: the cap
 * ({@link capAttachmentList}) already bounds the block, and one extra chip is
 * cheap next to an unreachable file. Content-hash dedupe would be a legitimate
 * extension — but only over bytes we have actually read, which the list model
 * never does.
 */
function dedupeKey(att: AttachmentMeta): string {
  return typeof att.part === 'string' ? att.part.trim() : ''
}

/**
 * Collapse repeated occurrences of the SAME part, keeping the first.
 *
 * In practice this only fires when the server (or our own parser) reports a
 * part twice; it also guarantees the `key={att.part}` React lists downstream
 * stay collision-free. Parts with no usable path are never merged — an unknown
 * identity is not evidence of sameness.
 */
export function dedupeAttachments(attachments: AttachmentMeta[]): AttachmentMeta[] {
  const seen = new Set<string>()
  const out: AttachmentMeta[] = []
  for (const att of attachments) {
    const key = dedupeKey(att)
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(att)
  }
  return out
}

/**
 * Cap the rendered chip count (§2.128 part 2).
 *
 * Pure and inline-agnostic: hand it thirty genuine attachments and it still
 * keeps the block small enough for the message to stay on screen.
 *
 * `collapsedEligible` bounds how far into `items` the collapsed row may reach —
 * the caller sets it to the number of leading real attachments so inlined parts
 * wait behind the toggle. It never adds items, only withholds them until the
 * user expands, so the "nothing is ever removed" guarantee holds by
 * construction: `expanded` always yields `items` in full.
 */
export function capAttachmentList(
  items: AttachmentMeta[],
  opts: { expanded?: boolean; collapsedLimit?: number; collapsedEligible?: number } = {},
): AttachmentListModel {
  const expanded = opts.expanded === true
  const rawLimit = opts.collapsedLimit ?? ATTACHMENT_COLLAPSED_LIMIT
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : ATTACHMENT_COLLAPSED_LIMIT
  const total = items.length
  const rawEligible = opts.collapsedEligible ?? total
  const eligible = Number.isFinite(rawEligible) ? Math.min(Math.max(Math.floor(rawEligible), 0), total) : total
  const collapsedCount = Math.min(limit, eligible)
  const overflows = collapsedCount < total
  const visible = overflows && !expanded ? items.slice(0, collapsedCount) : items.slice()
  return {
    items,
    visible,
    total,
    hiddenCount: total - visible.length,
    // Once collapsed rendering is in play the toggle must also be able to
    // collapse again, so it stays available while expanded.
    canExpand: overflows,
    expanded: overflows ? expanded : false,
  }
}

/** Full model: dedupe + order (optional) → cap (always). Nothing is dropped. */
export function buildAttachmentList(options: AttachmentListOptions = {}): AttachmentListModel {
  const raw = Array.isArray(options.attachments) ? options.attachments : []
  const groupInline = options.groupInline !== false
  const { items, realCount } = groupInline
    ? orderAttachments(dedupeAttachments(raw), options.inlineParts)
    : { items: raw.slice(), realCount: raw.length }
  return capAttachmentList(items, {
    expanded: options.expanded,
    collapsedLimit: options.collapsedLimit,
    collapsedEligible: realCount,
  })
}
