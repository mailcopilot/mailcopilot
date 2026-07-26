import { useEffect, useRef } from 'react'
import { Badge, FolderCog, FolderPen, FolderX, EyeOff, RefreshCw, Search } from 'lucide-react'

export type FolderContextMenuState = {
  x: number
  y: number
  accountId: number
  folderPath: string
  folderLabel: string
  role: string | null
}

type Props = {
  menu: FolderContextMenuState
  canEditRemote: boolean
  includeInBadges: boolean
  visible: boolean
  /**
   * §2.15-ter: whether the folder participates in full-text search. When
   * false, new headers from sync skip the FTS5 index but the row still
   * shows up in the list view (for Spam/Trash management). The toggle
   * is wired through `folder:prefs:upsert` with `{ indexInSearch }`.
   *
   * Optional for backward compatibility with parent components that haven't
   * been updated yet — defaults to true (the column DEFAULT and the
   * common case for non-Junk/Trash folders).
   */
  indexInSearch?: boolean
  onClose: () => void
  onRename: (menu: FolderContextMenuState) => void
  onDelete: (menu: FolderContextMenuState) => void
  onChangeIcon: (menu: FolderContextMenuState) => void
  onSetHeaderSync: (menu: FolderContextMenuState, mode: 'full' | 'on_open') => void
  onToggleBadge: (menu: FolderContextMenuState) => void
  onToggleVisible: (menu: FolderContextMenuState) => void
  /**
   * §2.15-ter: optional callback. When omitted, the menu falls back to a
   * direct `folder:prefs:upsert` IPC call so the toggle works without the
   * caller wiring a custom handler. Parents that need to refresh local
   * state (App.tsx) should pass an explicit callback.
   */
  onToggleIndexInSearch?: (menu: FolderContextMenuState) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export default function FolderContextMenu({
  menu,
  canEditRemote,
  includeInBadges,
  visible,
  indexInSearch = true,
  onClose,
  onRename,
  onDelete,
  onChangeIcon,
  onSetHeaderSync,
  onToggleBadge,
  onToggleVisible,
  onToggleIndexInSearch,
  t,
}: Props) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // §2.15-ter fallback: if the parent didn't pass a handler, hit the IPC
  // directly so the toggle is functional. The folder list state will pick
  // up the change on the next render cycle (App.tsx polls folder_prefs
  // through `cache:folderPrefs` after upserts).
  const handleToggleIndexInSearch = (m: FolderContextMenuState) => {
    if (onToggleIndexInSearch) {
      onToggleIndexInSearch(m)
      return
    }
    void window.api
      .invoke('folder:prefs:upsert', m.accountId, m.folderPath, { indexInSearch: !indexInSearch })
      .catch(() => { /* surfaced by App.tsx error toast on next sync cycle */ })
  }

  useEffect(() => {
    const close = () => onCloseRef.current()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
    }
  }, [])

  return (
    <div className="context-menu" style={{ top: menu.y, left: menu.x }} onMouseDown={(e) => e.stopPropagation()}>
      <button className="ctx-item" onClick={() => { onClose(); onSetHeaderSync(menu, 'full') }}>
        <RefreshCw size={14} /> {t('folders.menu.syncFull')}
      </button>
      <button className="ctx-item" onClick={() => { onClose(); onSetHeaderSync(menu, 'on_open') }}>
        <FolderCog size={14} /> {t('folders.menu.syncOnOpen')}
      </button>

      <div className="ctx-sep" />

      <button className="ctx-item" onClick={() => { onClose(); onToggleBadge(menu) }}>
        <Badge size={14} /> {includeInBadges ? t('folders.menu.removeFromBadges') : t('folders.menu.addToBadges')}
      </button>
      <button className="ctx-item" onClick={() => { onClose(); onToggleVisible(menu) }}>
        <EyeOff size={14} /> {visible ? t('folders.menu.hideFromSidebar') : t('folders.menu.showInSidebar')}
      </button>
      <button className="ctx-item" onClick={() => { onClose(); handleToggleIndexInSearch(menu) }}>
        <Search size={14} /> {indexInSearch ? t('folders.menu.excludeFromSearch') : t('folders.menu.includeInSearch')}
      </button>
      <button className="ctx-item" onClick={() => { onClose(); onChangeIcon(menu) }}>
        <FolderPen size={14} /> {t('folders.menu.changeIcon')}
      </button>

      <div className="ctx-sep" />

      <button className="ctx-item" onClick={() => { onClose(); onRename(menu) }} disabled={!canEditRemote}>
        <FolderPen size={14} /> {t('folders.menu.rename')}
      </button>
      <button className="ctx-item danger" onClick={() => { onClose(); onDelete(menu) }} disabled={!canEditRemote}>
        <FolderX size={14} /> {t('folders.menu.delete')}
      </button>
    </div>
  )
}
