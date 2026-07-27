import { useState, useEffect, useRef, useCallback } from 'react'
import { Bell, Check, CheckCheck, AlertTriangle, Clock3, Trash2 } from 'lucide-react'

export type AppNotification = {
  id: number
  type: string
  title: string
  body: string
  refId: string | null
  read: boolean
  createdAt: string
}

type Props = {
  labels: {
    title: string
    markAllRead: string
    empty: string
    followUpDue: string
    sendFailed: string
    dismiss: string
  }
  onFollowUpClick?: (refId: string) => void
}

const ICON_MAP: Record<string, typeof Bell> = {
  followup_due: Clock3,
  send_failed: AlertTriangle,
}

export default function NotificationCenter({ labels, onFollowUpClick }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    try {
      const [list, count] = await Promise.all([
        window.api.invoke('notifications:list', 50) as Promise<AppNotification[]>,
        window.api.invoke('notifications:unreadCount') as Promise<number>,
      ])
      setItems(Array.isArray(list) ? list : [])
      setUnreadCount(typeof count === 'number' ? count : 0)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    void load()
    const onChange = () => { void load() }
    window.api?.on('notifications:changed', onChange)
    return () => { window.api?.off('notifications:changed', onChange) }
  }, [load])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        bellRef.current && !bellRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const handleMarkAllRead = async () => {
    try {
      await window.api.invoke('notifications:markAllRead')
    } catch { /* ignore */ }
  }

  const handleMarkRead = async (id: number) => {
    try {
      await window.api.invoke('notifications:markRead', id)
    } catch { /* ignore */ }
  }

  const handleDelete = async (id: number) => {
    try {
      await window.api.invoke('notifications:delete', id)
    } catch { /* ignore */ }
  }

  const handleItemClick = (item: AppNotification) => {
    if (!item.read) void handleMarkRead(item.id)
    if (item.type === 'followup_due' && item.refId && onFollowUpClick) {
      onFollowUpClick(item.refId)
    }
  }

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    } catch { return iso }
  }

  return (
    <div className="notification-center">
      <button
        ref={bellRef}
        type="button"
        className="notification-bell-btn"
        data-testid="notification-bell"
        onClick={() => setOpen(prev => !prev)}
        aria-label={labels.title}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="notification-badge" data-testid="notification-badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="notification-panel" data-testid="notification-panel">
          <div className="notification-panel-header">
            <span className="notification-panel-title">{labels.title}</span>
            {unreadCount > 0 && (
              <button
                type="button"
                className="notification-mark-all-btn"
                onClick={handleMarkAllRead}
                title={labels.markAllRead}
              >
                <CheckCheck size={14} /> {labels.markAllRead}
              </button>
            )}
          </div>
          <div className="notification-panel-list">
            {items.length === 0 && (
              <div className="notification-empty">{labels.empty}</div>
            )}
            {items.map(item => {
              const Icon = ICON_MAP[item.type] ?? Bell
              return (
                <div
                  key={item.id}
                  className={`notification-item${item.read ? '' : ' notification-unread'}`}
                  onClick={() => handleItemClick(item)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') handleItemClick(item) }}
                >
                  <div className="notification-item-icon">
                    <Icon size={16} className={item.type === 'send_failed' ? 'notif-icon-error' : 'notif-icon-info'} />
                  </div>
                  <div className="notification-item-content">
                    <div className="notification-item-title">{item.title}</div>
                    {item.body && <div className="notification-item-body">{item.body}</div>}
                    <div className="notification-item-time">{formatTime(item.createdAt)}</div>
                  </div>
                  <div className="notification-item-actions">
                    {!item.read && (
                      <button
                        type="button"
                        title={labels.dismiss}
                        onClick={e => { e.stopPropagation(); void handleMarkRead(item.id) }}
                      >
                        <Check size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      title={labels.dismiss}
                      onClick={e => { e.stopPropagation(); void handleDelete(item.id) }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
