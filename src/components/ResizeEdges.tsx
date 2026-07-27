import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * Invisible resize handles for frameless Electron windows on Linux.
 * GNOME/Mutter does not provide WM resize handles for undecorated (frame:false)
 * windows on X11, so we emulate them with CSS+IPC.
 *
 * Top edge is intentionally omitted — the titlebar (-webkit-app-region: drag)
 * occupies the top and must remain unobstructed for WM drag & snap-to-edge.
 */

const EDGE_SIZE = 5
const CORNER_SIZE = 8

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EDGES: { dir: Dir; style: React.CSSProperties }[] = [
  // Bottom edge
  { dir: 's', style: { bottom: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_SIZE, cursor: 's-resize' } },
  // Left/right edges — start below titlebar (36px)
  { dir: 'e', style: { right: 0, top: 36, bottom: CORNER_SIZE, width: EDGE_SIZE, cursor: 'e-resize' } },
  { dir: 'w', style: { left: 0, top: 36, bottom: CORNER_SIZE, width: EDGE_SIZE, cursor: 'w-resize' } },
  // Bottom corners only (top corners belong to titlebar drag area)
  { dir: 'sw', style: { bottom: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE, cursor: 'sw-resize' } },
  { dir: 'se', style: { bottom: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE, cursor: 'se-resize' } },
]

const BASE_STYLE: React.CSSProperties = {
  position: 'fixed',
  zIndex: 99999,
  background: 'transparent',
}

export default function ResizeEdges() {
  const [isLinux, setIsLinux] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const activeRef = useRef(false)

  const stopResize = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false
    void window.api.invoke('win:stopResize')
  }, [])

  useEffect(() => {
    window.api.invoke('win:getPlatform').then((p) => {
      setIsLinux(p === 'linux')
    })
    window.api.invoke('win:isMaximized').then((m) => setMaximized(!!m))
    const onMaxChange = (val: unknown) => setMaximized(!!val)
    window.api.on('win:maximizeChanged', onMaxChange)
    return () => { window.api.off('win:maximizeChanged', onMaxChange) }
  }, [])

  useEffect(() => {
    const handleMouseUp = () => stopResize()
    const handleBlur = () => stopResize()
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') stopResize()
    }
    const handleMouseLeave = (event: MouseEvent) => {
      if (event.buttons === 0) stopResize()
    }

    window.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibility)
    document.addEventListener('mouseleave', handleMouseLeave)

    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibility)
      document.removeEventListener('mouseleave', handleMouseLeave)
      stopResize()
    }
  }, [stopResize])

  const handleMouseDown = useCallback((dir: Dir) => {
    activeRef.current = true
    void window.api.invoke('win:startResize', dir)
  }, [])

  if (!isLinux || maximized) return null

  return (
    <>
      {EDGES.map(({ dir, style }) => (
        <div
          key={dir}
          style={{ ...BASE_STYLE, ...style }}
          onMouseDown={(e) => { e.preventDefault(); handleMouseDown(dir) }}
        />
      ))}
    </>
  )
}
