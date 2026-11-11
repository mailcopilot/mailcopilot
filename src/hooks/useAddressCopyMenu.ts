/**
 * State and clipboard write for the one-item "Copy address" menu on a sender /
 * recipient address in the reading view.
 *
 * A renderer (React) menu, not the native one in electron/services/contextMenu.ts:
 * that one serves surfaces the renderer cannot see (links in the sandboxed
 * message iframe, editable fields). An address in the reading view is a plain
 * DOM element, and for those the project pattern is a React menu that calls
 * preventDefault (ContextMenu.tsx, FolderContextMenu.tsx). The write uses
 * navigator.clipboard like CertRecoveryDialog; no IPC channel.
 */

import { useCallback, useState, type MouseEvent } from 'react'
import { captureException } from '../sentry'

export type AddressMenuState = {
  x: number
  y: number
  /** The bare address written to the clipboard. */
  address: string
  /** Opened from the keyboard: the item takes focus so Enter works. */
  viaKeyboard: boolean
}

const MENU_W = 200
const MENU_H = 48
const EDGE = 8

/** Keeps the menu fully inside the viewport. */
export function placeAddressMenu(x: number, y: number, viewportW: number, viewportH: number) {
  return {
    x: Math.max(EDGE, Math.min(x, viewportW - MENU_W - EDGE)),
    y: Math.max(EDGE, Math.min(y, viewportH - MENU_H - EDGE)),
  }
}

/** Trimmed address, or '' when there is nothing to copy. */
export function bareAddress(address: string | null | undefined): string {
  return typeof address === 'string' ? address.trim() : ''
}

function selectionTouches(el: Element): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || sel.toString().trim() === '') return false
  for (let i = 0; i < sel.rangeCount; i++) {
    if (sel.getRangeAt(i).intersectsNode(el)) return true
  }
  return false
}

export function useAddressCopyMenu(address: string | null | undefined) {
  const [menu, setMenu] = useState<AddressMenuState | null>(null)
  const bare = bareAddress(address)

  const onContextMenu = useCallback((e: MouseEvent<HTMLElement>) => {
    // Name-only entry (group, "undisclosed-recipients"): nothing to copy, leave
    // the event alone.
    if (!bare) return
    // A non-empty selection that reaches into this address keeps the native
    // menu, whose "Copy" copies the selection (this menu cannot).
    if (selectionTouches(e.currentTarget)) return
    e.preventDefault()
    e.stopPropagation()
    // A mouse right-click reports button 2 and the pointer position; the menu
    // key / Shift+F10 reports neither, so anchor to the focused element.
    const viaKeyboard = e.button !== 2
    const rect = e.currentTarget.getBoundingClientRect()
    const pos = placeAddressMenu(
      viaKeyboard ? rect.left : e.clientX,
      viaKeyboard ? rect.bottom : e.clientY,
      window.innerWidth,
      window.innerHeight,
    )
    setMenu({ ...pos, address: bare, viaKeyboard })
  }, [bare])

  const close = useCallback(() => setMenu(null), [])

  const copy = useCallback(() => {
    const value = menu?.address
    setMenu(null)
    if (!value) return
    // A missing Clipboard API or a rejected write goes to monitoring only.
    try {
      void navigator.clipboard?.writeText(value).catch((err: unknown) => {
        captureException(err, { source: 'useAddressCopyMenu.copy' })
      })
    } catch (err) {
      captureException(err, { source: 'useAddressCopyMenu.copy' })
    }
  }, [menu])

  return { menu, onContextMenu, close, copy }
}
