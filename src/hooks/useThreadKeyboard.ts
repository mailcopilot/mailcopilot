import { useCallback, useEffect, useRef, useState } from 'react'
import {
  resolveThreadKeyCommand,
  type ThreadReplyMode,
} from '../../packages/core/threadKeyboard'
import {
  isThreadNavigationDismissed,
  setThreadNavigationDismissed,
} from './threadNavigationDismissal'

/**
 * Card-level keyboard navigation for the open conversation (§3.3.C-thread.4).
 *
 * The grammar itself is a pure function in `packages/core/threadKeyboard.ts`;
 * this hook only holds the cursor, moves real DOM focus and calls back into the
 * component. Keeping the decision pure is what makes the behaviour testable
 * without mounting Electron (CLAUDE.md §7).
 *
 * Precedence over the global shortcut handler is structural, not accidental:
 * the listener is registered in the CAPTURE phase, so it runs before the
 * bubble-phase handler in `useKeyboardShortcuts` regardless of which effect
 * registered first, and a handled keystroke is marked `preventDefault()` —
 * which that handler already treats as "not mine" on its first line. Listener
 * order between two bubble listeners on `window` depends on registration order,
 * and the global handler re-registers on every dependency change, so relying on
 * it would be a coin flip.
 *
 * Cursor lifetime: placed by `j` / `k` (or by focusing a card header with mouse
 * or Tab), cleared by `Esc` and by switching to another thread. It deliberately
 * survives a change of the open message — `Enter` on a card opens it, and the
 * cursor must stay where the user put it.
 *
 * `Esc` does two things, and they are separate: it drops the cursor AND stands
 * the thread down, so the next `j` reaches the message list instead of
 * re-deriving an anchor from the open card and claiming the key again. The
 * stand-down lives in `threadNavigationDismissal` — window scope, not hook
 * state, because this component unmounts on every single-message thread and
 * hook state would re-arm the cards two rows down the list. It is lifted only
 * when a card header takes focus (click or Tab).
 *
 * The cursor is remembered; DOM focus is not the same thing and may walk away
 * (Tab to the viewer toolbar). Keys that ACTIVATE something — Enter, Space —
 * and the card-scoped `r` / `a` / `f` are claimed only while focus is really on
 * a card header, so Enter on the Print button prints.
 */

export interface UseThreadKeyboardParams {
  /** Card keys in render order. Memoize: identity drives the stale-cursor check. */
  cardKeys: string[]
  /** Key of the message currently open in the viewer. */
  activeKey: string | null
  /** Thread identity; a change drops the cursor. */
  threadKey: string | null
  /** When false the hook listens to nothing (default true). */
  enabled?: boolean
  /** Enter / Space on the focused card — the component applies its header-click rule. */
  onActivate: (key: string) => void
  /** `r` / `a` / `f` on the focused card. */
  onReply: (key: string, mode: ThreadReplyMode) => void
}

export interface UseThreadKeyboardReturn {
  /** Card the cursor sits on, or null. */
  focusedKey: string | null
  /** Stable callback ref for a card header element, keyed by card key. */
  registerCard: (key: string) => (el: HTMLElement | null) => void
  /**
   * Place the cursor (used by the header's `focus` event: mouse and Tab).
   * Placing it on a card also lifts the post-`Esc` stand-down — this is the
   * way back into card navigation once the list has the keys.
   */
  setFocusedKey: (key: string | null) => void
}

function isTypingTarget(tgt: EventTarget | null): boolean {
  const el = tgt as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return Boolean((el as unknown as { isContentEditable?: boolean }).isContentEditable)
}

/**
 * True while any modal is on screen (command palette, shortcuts help, confirm
 * dialogs, AI egress prompt…). Asked of the DOM rather than plumbed down from
 * `App.tsx` as props: every one of those overlays already marks itself
 * `aria-modal="true"`, and a new one must too, so the DOM is the contract that
 * cannot drift.
 */
function hasOpenModal(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

/**
 * Is the focused element one of the card headers? Asked of the registered
 * elements rather than of a CSS ancestor, so focus INSIDE an expanded card —
 * an attachment button, a link — does not count: Enter there belongs to that
 * control, not to the card's fold.
 */
function isCardHeaderFocused(elements: Map<string, HTMLElement>): boolean {
  const el = document.activeElement
  if (!el) return false
  for (const candidate of elements.values()) {
    if (candidate === el) return true
  }
  return false
}

export function useThreadKeyboard(params: UseThreadKeyboardParams): UseThreadKeyboardReturn {
  const { cardKeys, activeKey, threadKey, enabled = true, onActivate, onReply } = params

  const [focusedKey, setFocusedKeyState] = useState<string | null>(null)

  const elements = useRef(new Map<string, HTMLElement>())
  const refCallbacks = useRef(new Map<string, (el: HTMLElement | null) => void>())

  // Putting the cursor on a card is the way back in after Esc.
  const setFocusedKey = useCallback((key: string | null) => {
    setFocusedKeyState(key)
    if (key !== null) setThreadNavigationDismissed(false)
  }, [])

  // Latest render values for the listener, which is registered once.
  const latest = useRef({ cardKeys, activeKey, enabled, focusedKey, onActivate, onReply })
  useEffect(() => {
    latest.current = { cardKeys, activeKey, enabled, focusedKey, onActivate, onReply }
  })

  // Another thread — the cursor from the previous one means nothing here.
  // The raw setter on purpose: clearing the cursor must not touch the
  // post-Esc stand-down, which outlives a thread switch by design.
  useEffect(() => {
    setFocusedKeyState(null)
  }, [threadKey])

  // The cursor points at a card that no longer exists (message moved, thread
  // re-grouped). Drop it rather than let the anchor resolve from a ghost.
  useEffect(() => {
    if (focusedKey !== null && !cardKeys.includes(focusedKey)) setFocusedKeyState(null)
  }, [cardKeys, focusedKey])

  const registerCard = useCallback((key: string) => {
    let cb = refCallbacks.current.get(key)
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) elements.current.set(key, el)
        else elements.current.delete(key)
      }
      refCallbacks.current.set(key, cb)
    }
    return cb
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const st = latest.current
      if (!st.enabled) return
      if (e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      if (hasOpenModal()) return

      const command = resolveThreadKeyCommand(
        {
          key: e.key,
          code: e.code,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
        },
        {
          cardKeys: st.cardKeys,
          focusedKey: st.focusedKey,
          activeKey: st.activeKey,
          dismissed: isThreadNavigationDismissed(),
          focusWithinCards: isCardHeaderFocused(elements.current),
        },
      )
      if (!command) return

      // Marks the event as ours for the global handler, and stops Space from
      // scrolling / Enter from firing the focused button a second time.
      e.preventDefault()

      switch (command.kind) {
        case 'focus': {
          setFocusedKey(command.key)
          elements.current.get(command.key)?.focus()
          break
        }
        case 'activate':
          st.onActivate(command.key)
          break
        case 'reply':
          st.onReply(command.key, command.mode)
          break
        case 'exit': {
          const el = st.focusedKey !== null ? elements.current.get(st.focusedKey) : undefined
          if (el && document.activeElement === el) el.blur()
          setFocusedKeyState(null)
          // Declining the keys is a separate fact from dropping the cursor:
          // without it the next `j` re-derives an anchor from the open card and
          // the message list never sees the keystroke. Window scope, so it
          // survives this component unmounting on a single-message thread.
          setThreadNavigationDismissed(true)
          break
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [setFocusedKey])

  return { focusedKey, registerCard, setFocusedKey }
}
