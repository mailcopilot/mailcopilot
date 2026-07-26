import { useEffect, useRef } from 'react'
import {
  Reply, ReplyAll, Forward, MailOpen, MailCheck,
  ShieldAlert, Archive, Trash2, FolderInput, Clock3, BookOpen, Pin,
} from 'lucide-react'
import type { FolderRoles, Mailbox, MailSummary } from '../../packages/net/types'
import { getFolderRole, folderLabel } from '../utils/mail'
import FolderIcon from './FolderIcon'

export type ContextMenuState = {
  x: number
  y: number
  mail: MailSummary
  moveOpen: boolean
}

type Props = {
  menu: ContextMenuState
  folders: Mailbox[]
  currentFolder: string
  roles: FolderRoles
  onClose: () => void
  onToggleMoveOpen: () => void
  onReply: (mail: MailSummary, mode: 'reply' | 'replyAll' | 'forward') => void
  onToggleSeen: (mail: MailSummary, seen: boolean) => void
  onMove: (mail: MailSummary, folder: string) => void
  onSpam: (mail: MailSummary) => void
  onArchive: (mail: MailSummary) => void
  onSnooze: (mail: MailSummary) => void
  onReadLater: (mail: MailSummary) => void
  onPin: (mail: MailSummary) => void
  onDelete: (mail: MailSummary) => void
  t: (key: string, opts?: Record<string, unknown>) => string
  /** Number of selected emails (>1 = bulk mode) */
  selectedCount?: number
}

export default function ContextMenu({
  menu, folders, currentFolder, roles,
  onClose, onToggleMoveOpen,
  onReply, onToggleSeen, onMove, onSpam, onArchive, onSnooze, onReadLater, onPin, onDelete,
  t, selectedCount = 1,
}: Props) {
  // Use ref so that useEffect doesn't re-run on every re-render
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

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

  const { mail } = menu
  const isBulk = selectedCount > 1

  return (
    <div
      className="context-menu"
      style={{ top: menu.y, left: menu.x }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {isBulk && (
        <>
          <span className="ctx-header">{t('mail.context.selected', { count: selectedCount })}</span>
          <div className="ctx-sep" />
        </>
      )}

      {!isBulk && (
        <>
          <button className="ctx-item" onClick={() => { onClose(); void onReply(mail, 'reply') }}>
            <Reply size={14} /> {t('mail.actions.reply')}
          </button>
          <button className="ctx-item" onClick={() => { onClose(); void onReply(mail, 'replyAll') }}>
            <ReplyAll size={14} /> {t('mail.actions.replyAll')}
          </button>
          <button className="ctx-item" onClick={() => { onClose(); void onReply(mail, 'forward') }}>
            <Forward size={14} /> {t('mail.actions.forward')}
          </button>
          <div className="ctx-sep" />
        </>
      )}

      <button
        className="ctx-item"
        onClick={() => {
          onClose()
          // In bulk mode always mark as read regardless of the clicked row's
          // unread state — the selection may contain a mix of read and unread
          // messages and "mark all as read" is the unambiguous bulk semantic.
          void onToggleSeen(mail, isBulk ? true : mail.unread)
        }}
      >
        {isBulk ? <MailCheck size={14} /> : (mail.unread ? <MailOpen size={14} /> : <MailCheck size={14} />)}
        {isBulk ? t('mail.actions.markRead') : (mail.unread ? t('mail.actions.markRead') : t('mail.actions.markUnread'))}
      </button>

      <button className="ctx-item" onClick={() => { onClose(); onSnooze(mail) }}>
        <Clock3 size={14} /> {t('snooze.snooze')}
      </button>

      <button className="ctx-item" onClick={() => { onClose(); onReadLater(mail) }}>
        <BookOpen size={14} /> {t('readLater.add')}
      </button>

      <button className="ctx-item" onClick={() => { onClose(); onPin(mail) }}>
        <Pin size={14} /> {mail.pinned ? t('mail.actions.unpin') : t('mail.actions.pin')}
      </button>

      <button className="ctx-item" onClick={onToggleMoveOpen}>
        <FolderInput size={14} /> {t('mail.actions.moveToFolder')}
      </button>
      {menu.moveOpen && (
        <div className="ctx-sublist">
          {folders.filter(f => f.path !== currentFolder).map(f => {
            const role = getFolderRole(f.path, f.specialUse, roles)
            return (
              <button
                key={f.path}
                className="ctx-subitem"
                onClick={() => { onClose(); void onMove(mail, f.path) }}
              >
                <FolderIcon role={role} size={16} />
                {folderLabel(f.name, role, t)}
              </button>
            )
          })}
        </div>
      )}

      <button
        className="ctx-item"
        onClick={() => { onClose(); void onSpam(mail) }}
        disabled={!roles.junk}
        title={roles.junk ? t('mail.actions.spamTo', { junk: roles.junk }) : t('mail.actions.junkNotFound')}
      >
        <ShieldAlert size={14} /> {t('mail.actions.spam')}
      </button>

      <button
        className="ctx-item"
        onClick={() => { onClose(); void onArchive(mail) }}
        disabled={!roles.archive}
        title={roles.archive ? t('mail.actions.archiveTo', { archive: roles.archive }) : t('mail.actions.archiveNotFound')}
      >
        <Archive size={14} /> {t('mail.actions.archive')}
      </button>

      <button
        className="ctx-item danger"
        onClick={() => { onClose(); void onDelete(mail) }}
        title={roles.trash && currentFolder !== roles.trash
          ? t('mail.actions.deleteToTrash', { trash: roles.trash })
          : t('mail.actions.deleteForever')}
      >
        <Trash2 size={14} /> {t('mail.actions.delete')}
      </button>
    </div>
  )
}
