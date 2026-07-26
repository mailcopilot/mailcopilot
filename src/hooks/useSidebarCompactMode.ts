import { useEffect, useState } from 'react'

/**
 * uiaudit.14 — returns true when the window height is below the compact
 * threshold (720 px). Adds the `sidebar-compact` CSS class to the sidebar
 * element so nav rows get reduced vertical padding.
 *
 * Implemented as a JS listener (not @media query) because Electron frameless
 * windows can have any viewport height and CSS `height` media queries target
 * the *CSS viewport*, which differs from `window.innerHeight` in some WMs.
 */
const COMPACT_HEIGHT_THRESHOLD = 720

export function useSidebarCompactMode(): boolean {
  const [compact, setCompact] = useState(
    () => window.innerHeight < COMPACT_HEIGHT_THRESHOLD,
  )

  useEffect(() => {
    const handleResize = () => {
      setCompact(window.innerHeight < COMPACT_HEIGHT_THRESHOLD)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return compact
}
