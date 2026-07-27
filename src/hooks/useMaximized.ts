import { useEffect, useState } from 'react'

/**
 * Tracks the BrowserWindow maximized state.
 *
 * Queries the initial state via `win:isMaximized` IPC and subscribes to
 * `win:maximizeChanged` events emitted by main process on maximize/unmaximize.
 * This keeps the titlebar button icon in sync even when the window is
 * maximized via OS-level snap (drag to screen edge) or WM keyboard shortcuts.
 *
 * Window geometry is deliberately NOT managed here. The main process is the
 * single writer of bounds corrections (electron/services/windowRescue.ts).
 * An earlier revision auto-invoked a `win:fitToScreen` IPC from a `resize`
 * listener; combined with the main-process display handler it formed a
 * feedback loop that visibly shook the window after monitor/resolution
 * changes (renderer's window.screen lags main's display state, so the two
 * sides kept "correcting" each other). Do not reintroduce geometry logic in
 * the renderer — see docs/ARCHITECTURE.md "Window geometry — single writer".
 */
export function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // Query initial state (window may already be maximized on mount).
    void window.api.invoke('win:isMaximized').then((v) => setMaximized(v as boolean))

    const handler = (val: unknown) => setMaximized(val as boolean)
    window.api.on('win:maximizeChanged', handler)

    return () => {
      window.api.off('win:maximizeChanged', handler)
    }
  }, [])

  return maximized
}
