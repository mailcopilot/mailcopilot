/**
 * "The user asked the message list to keep `j` / `k`" — one fact, one owner.
 *
 * It is stated at window scope on purpose (§3.3.C-thread.4 fix wave 2). The
 * obvious home, `useThreadKeyboard`'s own state, cannot hold it: `ThreadView`
 * is mounted only for conversations with more than one message, so walking the
 * list after `Esc` past a single message unmounts the hook and a fresh instance
 * comes back armed — `j` silently belonged to the cards again two rows later.
 * The stand-down is a property of how the person is reading right now, not of
 * any one conversation, and a module binding is exactly that scope: every
 * renderer window loads its own instance of this module, so the main window and
 * a standalone message window never share the answer.
 *
 * Nothing renders from it, so it is a plain binding rather than a store with
 * subscriptions: the value is read inside a keydown handler, where the current
 * value is all that matters. It is lifted only by putting the cursor back on a
 * card (click or Tab on a card header).
 */

let dismissed = false

/** True while the message list owns `j` / `k`. */
export function isThreadNavigationDismissed(): boolean {
  return dismissed
}

export function setThreadNavigationDismissed(value: boolean): void {
  dismissed = value
}

/**
 * Test seam. Module state outlives a component unmount by design, which also
 * means it outlives a test; specs that press `Esc` reset it between cases.
 */
export function resetThreadNavigationDismissal(): void {
  dismissed = false
}
