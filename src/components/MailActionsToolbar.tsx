import { useTranslation } from 'react-i18next'
import { Reply, ReplyAll, Forward, Archive, Trash2, Star, Mail, MailOpen, Printer } from 'lucide-react'
import type { FolderRoles } from '@mailcopilot/types'

export type MailActionsToolbarProps = {
  /** Whether the message is currently flagged (starred). */
  flagged: boolean
  /** Whether the message is currently read (\\Seen). */
  seen: boolean
  /** Folder roles for the account — used to enable/disable Archive button. */
  folderRoles: FolderRoles | null
  /**
   * Whether folderRoles has finished loading (even if null result).
   * BLOCKER fix: Delete button is disabled until roles are known to prevent
   * accidental permanent deletion before cache:folderRoles resolves.
   */
  folderRolesLoaded?: boolean
  /**
   * HIGH fix: disable Archive and Delete buttons while a deferred undo action
   * is pending (pendingUndo !== null). Prevents chained destructive actions
   * on stale UIDs — the first action defers the IMAP MOVE, so the source UID
   * is still valid in the original folder. A second destructive action would
   * flush the first (server MOVE fires, UID becomes invalid in source folder),
   * then proceed with the original UID → IMAP NO/BAD "no message with uid".
   *
   * Reply / Forward / Flag / Seen remain enabled — they are non-destructive in
   * this context (Reply/Forward open Compose, Flag/Seen operate on IMAP flags
   * not on message location).
   */
  destructiveActionsDisabled?: boolean
  /**
   * MEDIUM fix: disable flag button while IPC is in-flight to prevent
   * re-entry (optimistic rollback race condition).
   */
  flagPending?: boolean
  /**
   * MEDIUM fix: disable seen button while IPC is in-flight to prevent
   * re-entry (optimistic rollback race condition).
   */
  seenPending?: boolean
  /** Called when user clicks Reply. */
  onReply: () => void
  /** Called when user clicks Reply All. */
  onReplyAll: () => void
  /** Called when user clicks Forward. */
  onForward: () => void
  /** Called when user clicks Archive. Disabled when folderRoles.archive is absent. */
  onArchive: () => void
  /** Called when user clicks Delete. */
  onDelete: () => void
  /** Called when user clicks Flag/Unflag (star). */
  onToggleFlag: () => void
  /** Called when user clicks Mark read/unread. */
  onToggleSeen: () => void
  /** Called when user clicks Print. */
  onPrint: () => void
  /** Extra CSS class applied to the toolbar root element. */
  className?: string
}

/**
 * Reusable mail action toolbar: Reply / Reply All / Forward / Archive / Delete /
 * Flag / Mark read|unread / Print.
 *
 * Extracted from MailWindow (uiaudit.3 action-toolbar task) and designed to be
 * shared with App.tsx viewer toolbar in a future consolidation pass.
 *
 * Security: pure presentation component — all actions are callbacks; IPC is
 * never called directly from here. Parent is responsible for routing actions to
 * the correct IPC channels via preload whitelist (CLAUDE.md §5).
 */
export default function MailActionsToolbar({
  flagged,
  seen,
  folderRoles,
  folderRolesLoaded = true,
  destructiveActionsDisabled = false,
  flagPending = false,
  seenPending = false,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
  onToggleFlag,
  onToggleSeen,
  onPrint,
  className = '',
}: MailActionsToolbarProps) {
  const { t } = useTranslation()
  // Archive disabled when: no archive folder known, OR a deferred undo is pending
  // (HIGH fix: prevent chained destructive actions on stale UIDs).
  const archiveNoFolder = !folderRoles?.archive
  const archiveDisabled = archiveNoFolder || destructiveActionsDisabled
  // BLOCKER fix: Delete is disabled until folderRoles have loaded, preventing
  // accidental permanent deletion while cache:folderRoles is still in-flight.
  // HIGH fix: also disabled while a deferred undo action is pending.
  const deleteDisabled = !folderRolesLoaded || destructiveActionsDisabled

  return (
    <div className={`mail-actions-toolbar${className ? ` ${className}` : ''}`} role="toolbar" aria-label={t('mail.actions.toolbarLabel')}>
      {/* LOW fix: explicit aria-label on every icon button for screen readers. */}
      <button
        data-testid="toolbar-reply"
        className="btn-icon"
        onClick={onReply}
        title={t('mail.actions.reply')}
        aria-label={t('mail.actions.reply')}
      >
        <Reply size={16} />
      </button>
      <button
        data-testid="toolbar-reply-all"
        className="btn-icon"
        onClick={onReplyAll}
        title={t('mail.actions.replyAll')}
        aria-label={t('mail.actions.replyAll')}
      >
        <ReplyAll size={16} />
      </button>
      <button
        data-testid="toolbar-forward"
        className="btn-icon"
        onClick={onForward}
        title={t('mail.actions.forward')}
        aria-label={t('mail.actions.forward')}
      >
        <Forward size={16} />
      </button>

      <span className="toolbar-divider" aria-hidden="true" />

      <button
        data-testid="toolbar-archive"
        className="btn-icon"
        onClick={onArchive}
        disabled={archiveDisabled}
        title={archiveNoFolder ? t('mail.actions.archiveNotFound') : t('mail.actions.archive')}
        aria-label={archiveNoFolder ? t('mail.actions.archiveNotFound') : t('mail.actions.archive')}
      >
        <Archive size={16} />
      </button>
      <button
        data-testid="toolbar-delete"
        className="btn-icon"
        onClick={onDelete}
        disabled={deleteDisabled}
        title={t('mail.actions.delete')}
        aria-label={t('mail.actions.delete')}
      >
        <Trash2 size={16} />
      </button>

      <span className="toolbar-divider" aria-hidden="true" />

      <button
        data-testid="toolbar-flag"
        className={`btn-icon${flagged ? ' star-on' : ''}`}
        onClick={onToggleFlag}
        disabled={flagPending}
        title={flagged ? t('mail.actions.unflag') : t('mail.actions.flag')}
        aria-label={flagged ? t('mail.actions.unflag') : t('mail.actions.flag')}
      >
        <Star size={16} fill={flagged ? 'currentColor' : 'none'} />
      </button>
      <button
        data-testid="toolbar-mark-seen"
        className="btn-icon"
        onClick={onToggleSeen}
        disabled={seenPending}
        title={seen ? t('mail.actions.markUnread') : t('mail.actions.markRead')}
        aria-label={seen ? t('mail.actions.markUnread') : t('mail.actions.markRead')}
      >
        {seen ? <MailOpen size={16} /> : <Mail size={16} />}
      </button>

      <span className="toolbar-divider" aria-hidden="true" />

      <button
        data-testid="toolbar-print"
        className="btn-icon"
        onClick={onPrint}
        title={t('mail.actions.print')}
        aria-label={t('mail.actions.print')}
      >
        <Printer size={16} />
      </button>
    </div>
  )
}
