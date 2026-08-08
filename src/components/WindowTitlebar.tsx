import type { ReactNode } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMaximized } from '../hooks/useMaximized'

/**
 * Window chrome for frameless windows.
 *
 * Every window this app opens is created with `frame: false` (see the
 * BrowserWindow options in electron/main.ts), so the OS draws no title bar and
 * no minimize/close buttons. Whatever a window renders is the ONLY way to drag
 * it or to close it with the mouse — a screen that renders none of this is a
 * window the user cannot move and cannot visibly close (§2.82 consent screen
 * shipped in exactly that state).
 *
 * This component is the single definition of that chrome. It replaces four
 * byte-identical copies that had drifted apart in small ways (only MailWindow
 * had tooltips) and would have become five with the consent screen. The main
 * window (src/App.tsx) keeps its own markup: it carries the app icon, a beta
 * marker and the unread badge inside the drag area, and uses `.titlebar`
 * rather than `.child-titlebar`.
 *
 * Two structural rules, both already learned the hard way in this project:
 *   - the root element carries `-webkit-app-region: drag` via `.child-titlebar`
 *     (src/App.css), which is what makes the window draggable;
 *   - `.titlebar-controls` re-declares `no-drag`, otherwise the three buttons
 *     would be part of the drag region and could not be clicked at all.
 *
 * `window.api` is used without a guard, matching the previous inline copies:
 * every window that renders a titlebar has already made IPC calls to get the
 * data it displays, so a missing bridge is not a state this component can be
 * reached in. (The consent screen included: `useTelemetryConsent` resolves to
 * "do not ask" when the bridge is absent, so it never renders.)
 */

type Props = {
  /** Window title shown next to the drag area. */
  title: ReactNode
  /**
   * Close handler. Defaults to `window.close()`, which is what child windows
   * want. The main window closes through the `win:close` IPC instead, so it
   * passes an explicit handler.
   *
   * Note for gates such as the telemetry consent screen: this button means
   * "close the window", not "answer the question". Callers must not route it
   * into a decision path.
   */
  onClose?: () => void
  /** Extra class on the root, e.g. to lift the bar above a modal overlay. */
  className?: string
  /** Root test id. Defaults to `window-titlebar`; one bar per window. */
  testId?: string
}

export default function WindowTitlebar({ title, onClose, className, testId = 'window-titlebar' }: Props) {
  const { t } = useTranslation()
  const maximized = useMaximized()

  const minimizeLabel = t('window.minimize', { defaultValue: 'Minimize' })
  const maximizeLabel = maximized
    ? t('window.restore', { defaultValue: 'Restore' })
    : t('window.maximize', { defaultValue: 'Maximize' })
  const closeLabel = t('window.close', { defaultValue: 'Close' })

  return (
    <div className={className ? `child-titlebar ${className}` : 'child-titlebar'} data-testid={testId}>
      <span className="child-titlebar-title">{title}</span>
      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          data-testid="window-titlebar-minimize"
          title={minimizeLabel}
          aria-label={minimizeLabel}
          onClick={() => void window.api.invoke('win:minimize')}
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar-btn"
          data-testid="window-titlebar-maximize"
          title={maximizeLabel}
          aria-label={maximizeLabel}
          onClick={() => void window.api.invoke('win:maximize')}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          data-testid="window-titlebar-close"
          title={closeLabel}
          aria-label={closeLabel}
          onClick={onClose ?? (() => window.close())}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
