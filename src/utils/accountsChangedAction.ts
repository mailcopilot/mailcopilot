/**
 * What the main window does with an `accounts:changed` broadcast.
 *
 * - `switch-current`: another window switched the active mailbox; follow it
 *   locally, no reload (a reload would clear the list and skip auto-sync).
 * - `refresh-saved`: settings of an existing mailbox changed; refresh metadata
 *   and prefs only (no folder reload, so the sidebar does not flicker).
 * - `init`: run the full initial load again, which picks the current mailbox,
 *   opens INBOX and starts the sync.
 *
 * The "first" mailbox is the case `refresh-saved` cannot serve, and it is a
 * fact about the window's state, not about the profile's history: the window
 * has no usable current mailbox. That is true when it was opened with no
 * accounts (`currentAccountId === null`), and equally after the LAST mailbox
 * was removed in this session: the initial load stops early on an empty list,
 * so the window keeps the removed mailbox's id while its list of known accounts
 * is empty. In both cases only the initial load chooses a mailbox, opens INBOX
 * and releases the auto-sync, so a save that arrives while the current mailbox
 * is not among the known ones must run it, or the window stays on "Connect your
 * email" (or on nothing) until the page is reloaded by hand.
 */
export type AccountsChangedAction = 'switch-current' | 'refresh-saved' | 'init'

export type AccountsChangedState = {
  /** The mailbox the window currently shows, or null before one was chosen. */
  currentAccountId: number | null
  /** The ids of the accounts the window knew BEFORE this event. */
  knownAccountIds: readonly number[]
}

export function decideAccountsChangedAction(
  payload: unknown,
  state: AccountsChangedState,
): AccountsChangedAction {
  const data = payload && typeof payload === 'object' ? (payload as { kind?: unknown; id?: unknown }) : undefined
  const kind = typeof data?.kind === 'string' ? data.kind : ''
  const id = typeof data?.id === 'number' && Number.isFinite(data.id) ? data.id : NaN
  if (!(id > 0)) return 'init'
  if (kind === 'current') return 'switch-current'
  if (kind === 'saved') {
    const hasUsableCurrent = state.currentAccountId !== null && state.knownAccountIds.includes(state.currentAccountId)
    return hasUsableCurrent ? 'refresh-saved' : 'init'
  }
  return 'init'
}
