/**
 * §2.99 — decides what the user is told about newly arrived mail.
 *
 * WHY THIS OWNS ITS OWN MARK. The pipeline position ("everything up to this
 * UID has already been considered") is this service's state, per folder, and it
 * is NEVER derived from `MAX(uid) FROM messages` at decision time. That is the
 * §2.86 lesson from the static-rules runner, in the opposite direction: the
 * cache is written by paths that do not notify (pagination, remote-search
 * hydration, a crashed pass, the body indexer), so "highest cached UID" answers
 * a question about STORAGE, not about what the user has been told. Deriving the
 * mark from storage would either notify about mail the user has had for months
 * (the archive, on first launch after upgrade) or silently swallow arrivals.
 *
 * Seeding therefore happens ONCE at startup, before any sync can run, from the
 * cache as it stands — so the first launch of this build produces zero toasts
 * about the existing archive — and after that only this module moves the mark.
 *
 * UIDVALIDITY. A folder whose UID space was renumbered has no comparable mark:
 * the pass is abandoned, the mark is re-seeded from the new space, and nothing
 * is announced. `null` means "unknown", not "different" — the strict-comparison
 * version of this rule is what re-created the original defect in §2.86's fix.
 *
 * No electron import: the presentation is a dependency, so the decision logic
 * is unit-tested without a display server.
 */

import { hiddenUnreadPathsFor, type FolderRoleMap } from '../unreadBadge'

/** Cached message fields the notifier reads. Never logged, never telemetered. */
export type MailNotifierMessage = {
  uid: number
  subject: string | null
  /** Display sender (name if known, address otherwise). */
  from?: string | null
  unread: boolean
}

/** What the presentation layer is asked to show. Identifiers + display text. */
export type NewMailNotification = {
  accountId: number
  folder: string
  /** Newest new message — the one the click opens. */
  uid: number
  /** How many new unread messages this batch covers (>= 1). */
  count: number
  subject: string | null
  from: string | null
  lang: string | undefined
}

export interface MailNotifierDeps {
  listAccountIds: () => number[]
  /** Folder prefs for one account; only 'full' / 'period' folders are watched. */
  listFolderPrefs: (accountId: number) => Array<{ folderPath: string; headerSyncMode?: string }>
  /** Current UIDVALIDITY of a folder, or null when unknown. */
  getUidValidity: (accountId: number, folder: string) => number | null
  /** Highest cached UID — used ONLY to seed or re-seed a mark, never to gate work. */
  getMaxUidForFolder: (accountId: number, folder: string) => number
  /** Cached UIDs above `sinceUid`, ascending. */
  getUidsSince: (accountId: number, folder: string, sinceUid: number, limit: number) => number[]
  getMessageByUid: (accountId: number, folder: string, uid: number) => MailNotifierMessage | undefined
  getSettings: () => {
    notificationsEnabled?: boolean
    hiddenUnreadFolders?: string[]
    language?: string
  }
  getFolderRoles: (accountId: number) => FolderRoleMap | null
  /**
   * The SHARED badge-inclusion policy (packages/core `isFolderCountedInBadges`)
   * applied to this folder. Notifications and badges must agree about which
   * folders the user considers theirs; anything else means a toast for mail the
   * app never counted (review H2).
   */
  isCountedInBadges: (accountId: number, folder: string) => boolean
  /** Show one notification. Must never throw (the caller is a sync path). */
  present: (notification: NewMailNotification) => void
  log: {
    info: (msg: string) => void
    warn: (msg: string, err?: unknown) => void
  }
  /** Sentry reporter — never throws (see electron/sentry.ts). */
  captureException: (err: unknown, context: Record<string, unknown>) => void
}

/** Upper bound on messages examined per folder per pass. */
export const NOTIFIER_MAX_PER_PASS = 50

/**
 * Coalescing window. A sync pass reports folder by folder, and IDLE can land
 * several arrivals within a second; without a window the user would get one
 * toast per folder for what is, to them, one delivery.
 */
export const NOTIFIER_BATCH_MS = 1500

type Mark = { uid: number; uidValidity: number | null }
type Pending = { count: number; folder: string; uid: number; subject: string | null; from: string | null }

let deps: MailNotifierDeps | null = null
const marks = new Map<string, Mark>()
const pending = new Map<number, Pending>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function key(accountId: number, folder: string): string {
  return `${accountId}:${folder}`
}

function isWatchedFolder(d: MailNotifierDeps, accountId: number, folder: string): boolean {
  const pref = d.listFolderPrefs(accountId).find(p => p.folderPath === folder)
  if (!pref) return false
  if (pref.headerSyncMode !== 'full' && pref.headerSyncMode !== 'period') return false
  // A folder that does not reach the badge does not reach a toast either — one
  // policy, shared with the renderer (packages/core/unreadBadgePolicy.ts).
  if (!d.isCountedInBadges(accountId, folder)) return false
  // Plus the legacy per-install exclusion list, which is notification-specific
  // here: it is a strict NARROWING of the badge policy, never a widening.
  const settings = d.getSettings()
  const hidden = hiddenUnreadPathsFor(settings.hiddenUnreadFolders, d.getFolderRoles(accountId))
  return !hidden.has(folder)
}

/** Wire the notifier and drop any state from a previous wiring (tests, reload). */
export function initMailNotifier(next: MailNotifierDeps): void {
  deps = next
  marks.clear()
  pending.clear()
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

/**
 * Give every folder this install already knows about a starting mark, BEFORE
 * anything can sync. Idempotent: a folder that already has a mark keeps it.
 * Returns the number of folders seeded.
 */
export function seedMailNotifierMarks(): number {
  const d = deps
  if (!d) return 0
  let seeded = 0
  for (const accountId of d.listAccountIds()) {
    let prefs: Array<{ folderPath: string; headerSyncMode?: string }> = []
    try {
      prefs = d.listFolderPrefs(accountId)
    } catch (err) {
      d.log.warn(`Notifier seeding skipped an account (#${accountId})`, err)
      continue
    }
    for (const pref of prefs) {
      if (pref.headerSyncMode !== 'full' && pref.headerSyncMode !== 'period') continue
      const k = key(accountId, pref.folderPath)
      if (marks.has(k)) continue
      marks.set(k, {
        uid: d.getMaxUidForFolder(accountId, pref.folderPath),
        uidValidity: d.getUidValidity(accountId, pref.folderPath),
      })
      seeded++
    }
  }
  return seeded
}

export type NotifyOutcome =
  | 'not-wired'
  | 'not-watched'
  | 'seeded'
  | 'uidvalidity-changed'
  | 'disabled'
  | 'nothing-new'
  | 'queued'
  | 'failed'

/**
 * Consider `(accountId, folder)` after a main-side sync committed its batches.
 *
 * Safe to call from any sync path and for any folder: eligibility (sync mode,
 * hidden folders, master switch) is decided HERE, so no call site has to know
 * what counts as notifiable. Never throws.
 */
export function notifyNewMail(accountId: number, folder: string): NotifyOutcome {
  const d = deps
  if (!d) return 'not-wired'
  try {
    if (!isWatchedFolder(d, accountId, folder)) return 'not-watched'
    const k = key(accountId, folder)
    const currentValidity = d.getUidValidity(accountId, folder)
    const mark = marks.get(k)

    // A folder seen for the first time (added after startup seeding) gets a
    // baseline and nothing else — its existing mail is not news.
    if (!mark) {
      marks.set(k, { uid: d.getMaxUidForFolder(accountId, folder), uidValidity: currentValidity })
      return 'seeded'
    }

    // Renumbered UID space: the mark is not comparable to the new UIDs. Both
    // sides must be KNOWN for this to be a mismatch — null is "unknown".
    if (mark.uidValidity !== null && currentValidity !== null && mark.uidValidity !== currentValidity) {
      marks.set(k, { uid: d.getMaxUidForFolder(accountId, folder), uidValidity: currentValidity })
      return 'uidvalidity-changed'
    }

    // Notifications off: keep the mark moving so re-enabling does not replay
    // everything that arrived meanwhile.
    if (d.getSettings().notificationsEnabled === false) {
      marks.set(k, { uid: d.getMaxUidForFolder(accountId, folder), uidValidity: currentValidity })
      return 'disabled'
    }

    const uids = d.getUidsSince(accountId, folder, mark.uid, NOTIFIER_MAX_PER_PASS)
    if (uids.length === 0) {
      if (mark.uidValidity === null && currentValidity !== null) {
        marks.set(k, { uid: mark.uid, uidValidity: currentValidity })
      }
      return 'nothing-new'
    }

    // Read the batch FIRST, move the mark afterwards (review H1). The mark is
    // the record of "these messages have been dealt with", and until the batch
    // is queued for presentation that is not true: a throw from
    // `getMessageByUid` — or a crash — between the two would consume the
    // messages for good, because a restart re-seeds the mark from the cache's
    // MAX(uid) and can never look below it again.
    //
    // The failure direction is chosen deliberately: dying AFTER the mark
    // commits but before the toast reaches the screen loses mail silently,
    // while dying before the commit re-announces at most one pass. Duplicate
    // toast > silent loss.
    let count = 0
    let newest: MailNotifierMessage | null = null
    for (const uid of uids) {
      const msg = d.getMessageByUid(accountId, folder, uid)
      if (!msg || !msg.unread) continue
      count++
      newest = msg
    }

    // Advance only over what this pass actually examined: a capped pass leaves
    // a contiguous tail for the next one (ascending UIDs, same shape as the
    // static-rules runner). Committed for BOTH outcomes below — read messages
    // are as dealt-with as announced ones, and re-reading them next pass would
    // re-scan the same tail forever.
    const commitMark = () => {
      const highestSeen = uids[uids.length - 1]
      marks.set(k, { uid: Math.max(mark.uid, highestSeen), uidValidity: currentValidity ?? mark.uidValidity })
    }

    if (count === 0 || !newest) {
      commitMark()
      return 'nothing-new'
    }

    queue(accountId, { count, folder, uid: newest.uid, subject: newest.subject ?? null, from: newest.from ?? null })
    commitMark()
    return 'queued'
  } catch (err) {
    // Sanitised: no folder path, no subject, no server text — this reaches
    // Sentry (CLAUDE.md §8). The local log gets the account id only.
    d.log.warn(`New-mail notification pass failed for account #${accountId}`, err)
    d.captureException(new Error('mailNotifier pass failed'), {
      source: 'mailNotifier:pass',
      accountId,
    })
    return 'failed'
  }
}

function queue(accountId: number, item: Pending): void {
  const existing = pending.get(accountId)
  if (existing) {
    // LAST PROCESSED wins for the display text and for the ref the click opens
    // — not "newest by date". Folders are reported in sync order, so with two
    // folders landing in one window the toast names whichever was processed
    // last; the count still covers both. Comparing dates across folders would
    // mean loading and ordering every candidate for a one-line toast, which is
    // not worth it (review L2 — documented, deliberately not changed).
    pending.set(accountId, { ...item, count: existing.count + item.count })
  } else {
    pending.set(accountId, item)
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushMailNotifications()
    }, NOTIFIER_BATCH_MS)
    // Never keep the process alive for a pending toast.
    flushTimer.unref?.()
  }
}

/**
 * Forget everything this service holds for `accountId` (security review
 * MEDIUM-2).
 *
 * Called from the account-teardown owner in main. Two distinct hazards, both
 * rooted in the fact that account ids are REUSED:
 *  - a MARK left behind becomes the starting watermark of the next account to
 *    take that id, so its existing mail is silently declared "already dealt
 *    with" (or, with a lower UID space, everything looks new at once);
 *  - a PENDING notification still holds the removed mailbox's subject, sender
 *    and a ref that now points at nothing — showing it would surface content
 *    from an account the user just deleted.
 *
 * The mark keys are `accountId:folder`, so the account's own folders are
 * matched by prefix; nothing else in the map can collide with it because the
 * separator cannot appear in the numeric id.
 */
export function forgetAccountNotifications(accountId: number): void {
  const prefix = `${accountId}:`
  for (const k of [...marks.keys()]) {
    if (k.startsWith(prefix)) marks.delete(k)
  }
  pending.delete(accountId)
  // Nothing left to present — do not keep a timer alive for an empty queue.
  if (pending.size === 0 && flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

/** Present everything queued, one notification per account. Never throws. */
export function flushMailNotifications(): void {
  const d = deps
  if (!d) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const batch = [...pending.entries()]
  pending.clear()
  const lang = (() => {
    try { return d.getSettings().language } catch { return undefined }
  })()
  for (const [accountId, item] of batch) {
    try {
      d.present({
        accountId,
        folder: item.folder,
        uid: item.uid,
        count: item.count,
        subject: item.subject,
        from: item.from,
        lang,
      })
    } catch (err) {
      d.log.warn(`Presenting a new-mail notification failed for account #${accountId}`, err)
      d.captureException(new Error('mailNotifier present failed'), {
        source: 'mailNotifier:present',
        accountId,
      })
    }
  }
}
