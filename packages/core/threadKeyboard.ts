/**
 * Keyboard grammar for an open conversation (§3.3.C-thread.4).
 *
 * The open thread is a stack of message cards. While it is on screen the cards
 * own `j` / `k`, so the cursor walks the conversation instead of the message
 * list; `Esc` gives the list its keys back. Everything below is a pure decision
 * function: it turns one keystroke plus the current card cursor into a command,
 * and knows nothing about the DOM, React or i18n. The renderer hook
 * (`src/hooks/useThreadKeyboard.ts`) performs the command.
 *
 * Two deliberate departures from the backlog sketch, both to avoid colliding
 * with keys the application already binds globally
 * (`src/hooks/useKeyboardShortcuts.ts`):
 *
 *  - Reply / reply-all / forward are `r` / `a` / `f`, the SAME letters the
 *    global handler uses for those actions on the open message. The sketch
 *    proposed `e` / `Shift+E`, but `e` is archive everywhere else in the
 *    product; making one letter mean "archive" in the list and "reply" inside a
 *    thread trades a conflict for a worse one.
 *  - `ArrowUp` / `ArrowDown` are NOT captured. They keep moving the message
 *    list, which leaves a way to walk the list while a conversation is open
 *    without first leaving card navigation.
 *
 * A command is produced only when the keystroke belongs to the thread. Anything
 * else returns `null` and the global handler sees the event untouched.
 */

export type ThreadReplyMode = 'reply' | 'replyAll' | 'forward'

export type ThreadKeyCommand =
  /** Move the card cursor (and DOM focus) to this card. */
  | { kind: 'focus'; key: string }
  /** Enter / Space on the focused card — same effect as clicking its header. */
  | { kind: 'activate'; key: string }
  /** Reply / reply all / forward, scoped to the focused card. */
  | { kind: 'reply'; key: string; mode: ThreadReplyMode }
  /** Esc — drop the card cursor; the message list owns `j` / `k` again. */
  | { kind: 'exit' }

/** The parts of a `KeyboardEvent` this grammar reads. */
export interface ThreadKeyEvent {
  key: string
  code: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export interface ThreadKeyContext {
  /** Card keys in render order (the order the user sees). */
  cardKeys: readonly string[]
  /** Card the cursor sits on, or null when the cursor has not been placed yet. */
  focusedKey: string | null
  /** Card that is currently open in the viewer. */
  activeKey: string | null
  /**
   * The user pressed `Esc` and asked for the message list back. Without this
   * the promise "Esc hands `j` / `k` to the list" cannot be kept: `Esc` only
   * clears the cursor, and the very next `j` would re-derive an anchor from the
   * open card and claim the keystroke again — the list would never see one.
   * Dropping the cursor and declining the keys are two different facts, so the
   * second one is stated, not inferred.
   *
   * It stays true until the user puts the cursor back on a card (clicking or
   * tabbing to a header), deliberately surviving a switch to another thread:
   * re-arming per thread would make `j` alternate between "next conversation"
   * and "next card" as the user walks the list.
   */
  dismissed: boolean
  /**
   * Whether the element the browser considers focused is a card header.
   *
   * The cursor and the focus ring are not the same fact: the cursor is
   * remembered, focus can walk away to the viewer toolbar or a link. Enter and
   * Space ACTIVATE whatever is focused, so the thread may only claim them while
   * focus is genuinely on a card — otherwise Enter on the Print button toggled
   * a remembered card instead of printing. `r` / `a` / `f` follow the same rule
   * for the same reason: with focus elsewhere the ring is gone, and acting on a
   * card the user can no longer see is a surprise. `j` / `k` are exempt — they
   * are the way INTO the cards, so they cannot require being there already.
   */
  focusWithinCards: boolean
}

/**
 * Letter of the physically pressed key (`KeyJ` -> `j`), so the shortcuts hold
 * in any keyboard layout. Mirrors `physicalKeyLetter` in
 * `src/hooks/useKeyboardShortcuts.ts`; non-letter keys fall back to `key`.
 */
export function threadKeyLetter(code: string, key: string): string {
  if (code.length === 4 && code.startsWith('Key')) return code.charAt(3).toLowerCase()
  return key.length === 1 ? key.toLowerCase() : key
}

/** True when the cursor sits on a card that still exists in the thread. */
export function isThreadFocusPresent(ctx: ThreadKeyContext): boolean {
  return ctx.focusedKey !== null && ctx.cardKeys.indexOf(ctx.focusedKey) >= 0
}

/**
 * Index the cursor moves from: the focused card, else the open card, else the
 * top of the stack. A focused key that no longer exists (thread re-grouped, the
 * message moved) is ignored rather than trusted — the same rule the message
 * list uses for a stale selection anchor.
 */
export function resolveThreadFocusAnchor(ctx: ThreadKeyContext): number {
  const { cardKeys, focusedKey, activeKey } = ctx
  if (cardKeys.length === 0) return -1
  if (focusedKey !== null) {
    const i = cardKeys.indexOf(focusedKey)
    if (i >= 0) return i
  }
  if (activeKey !== null) {
    const i = cardKeys.indexOf(activeKey)
    if (i >= 0) return i
  }
  return 0
}

export function resolveThreadKeyCommand(
  ev: ThreadKeyEvent,
  ctx: ThreadKeyContext,
): ThreadKeyCommand | null {
  // Ctrl/Cmd/Alt combinations belong to the application and the platform.
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null
  if (ctx.cardKeys.length === 0) return null

  const letter = threadKeyLetter(ev.code, ev.key)

  // Cursor movement. Shift+j / Shift+k stay with the list (range selection).
  if (!ev.shiftKey && (letter === 'j' || letter === 'k')) {
    // Asked to stand down and not put back on a card yet: the list owns these.
    if (ctx.dismissed && !isThreadFocusPresent(ctx)) return null
    const anchor = resolveThreadFocusAnchor(ctx)
    if (anchor < 0) return null
    const next = letter === 'j'
      ? Math.min(ctx.cardKeys.length - 1, anchor + 1)
      : Math.max(0, anchor - 1)
    // Emitted even at the ends of the stack: the keystroke must still be
    // swallowed there, otherwise `j` on the last card would jump the message
    // list behind the open conversation.
    return { kind: 'focus', key: ctx.cardKeys[next]! }
  }

  // Esc answers "who owns j / k", not "where is the cursor". A conversation
  // owns them from the moment it opens, before the user has moved the cursor
  // anywhere, so Esc has to work right there — requiring a cursor first meant
  // the only way out was to first go IN (press j, then Esc). Once the thread
  // has already stood down and holds no cursor it owns nothing, declines the
  // key, and the second Esc does what Esc always did (clear selection/search).
  if (ev.key === 'Escape') {
    return isThreadFocusPresent(ctx) || !ctx.dismissed ? { kind: 'exit' } : null
  }

  // Everything below acts on the card under the cursor, and only while focus is
  // actually on it (see `focusWithinCards`).
  if (!isThreadFocusPresent(ctx) || !ctx.focusWithinCards) return null
  const focusedKey = ctx.focusedKey!

  if (!ev.shiftKey && (ev.key === 'Enter' || ev.key === ' ' || ev.code === 'Space')) {
    return { kind: 'activate', key: focusedKey }
  }

  if (!ev.shiftKey) {
    if (letter === 'r') return { kind: 'reply', key: focusedKey, mode: 'reply' }
    if (letter === 'a') return { kind: 'reply', key: focusedKey, mode: 'replyAll' }
    if (letter === 'f') return { kind: 'reply', key: focusedKey, mode: 'forward' }
  }

  return null
}
