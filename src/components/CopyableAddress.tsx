/**
 * Wraps an address in the reading view with a context menu (right-click, menu
 * key, Shift+F10) offering one item, "Copy address", that writes the bare
 * address (`user@example.com`, never `Name <user@example.com>`). Name-only
 * entries get no menu. Logic lives in `useAddressCopyMenu`.
 * `CopyableAddressList` renders a whole envelope list, entries copyable apart.
 */

import { useCallback, useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MailAddress } from '@mailcopilot/types'
import { addrToString } from '@mailcopilot/core'
import { useAddressCopyMenu } from '../hooks/useAddressCopyMenu'

type CopyableAddressProps = Omit<HTMLAttributes<HTMLSpanElement>, 'onContextMenu'> & {
  /** Bare address to copy; empty / missing disables the menu. */
  address?: string | null
  children: ReactNode
}

export default function CopyableAddress({ address, children, ...rest }: CopyableAddressProps) {
  const { t } = useTranslation()
  const { menu, onContextMenu, close, copy } = useAddressCopyMenu(address)

  // Dismissal as in the mail-list menu, plus window blur: a click into the
  // message body (a sandboxed iframe) never reaches this document's listeners,
  // but it takes focus away from the window.
  const spanRef = useRef<HTMLSpanElement | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  // Closing from the menu itself (Escape, the item) hands focus back to the
  // address so the menu key opens it again; closing by an outside click or
  // scroll does not move focus.
  const closeToAddress = useCallback(() => {
    closeRef.current()
    spanRef.current?.focus({ preventScroll: true })
  }, [])
  const open = menu !== null
  useEffect(() => {
    if (!open) return
    const dismiss = () => closeRef.current()
    // Capture phase on window runs before anything below the menu. Escape is
    // consumed here: it must not also collapse a recipient list, clear the
    // search or reach the global shortcuts.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeToAddress()
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [open, closeToAddress])

  return (
    <>
      <span {...rest} ref={spanRef} onContextMenu={onContextMenu}>{children}</span>
      {menu && createPortal(
        // A React child of whatever wraps the address (card header button, chip
        // list): events must not bubble into those handlers.
        <div
          className="context-menu address-context-menu"
          role="menu"
          data-testid="address-context-menu"
          style={{ top: menu.y, left: menu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="ctx-item"
            data-testid="address-context-copy"
            autoFocus={menu.viaKeyboard}
            onClick={(e) => { e.stopPropagation(); copy(); closeToAddress() }}
          >
            <Copy size={14} /> {t('mail.context.copyAddress')}
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

export function CopyableAddressList({ list }: { list: MailAddress[] }) {
  // Same text as `addrListToString`; empty entries dropped before separators.
  const entries = list
    .map((a) => ({ a, label: addrToString(a) }))
    .filter((e) => e.label !== '')
  return (
    <>
      {entries.map(({ a, label }, i) => (
        <span key={`${a.address ?? ''}-${i}`}>
          {i > 0 && ', '}
          <CopyableAddress
            address={a.address}
            data-testid="mail-address"
            tabIndex={a.address?.trim() ? 0 : undefined}
          >
            {label}
          </CopyableAddress>
        </span>
      ))}
    </>
  )
}
