// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import ContextMenu, { type ContextMenuState } from './ContextMenu'
import type { MailSummary } from '../../packages/net/types'

afterEach(cleanup)

const t = (key: string) => key

function makeMail(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    uid: 1,
    accountId: 1,
    folder: 'INBOX',
    subject: 'Test subject',
    from: 'Test User',
    fromAddr: 'test@example.com',
    date: new Date().toISOString(),
    unread: false,
    flagged: false,
    ...overrides,
  }
}

function makeMenu(mail: MailSummary): ContextMenuState {
  return { x: 100, y: 200, mail, moveOpen: false }
}

const baseProps = {
  folders: [],
  currentFolder: 'INBOX',
  roles: {},
  onClose: vi.fn(),
  onToggleMoveOpen: vi.fn(),
  onReply: vi.fn(),
  onToggleSeen: vi.fn(),
  onMove: vi.fn(),
  onSpam: vi.fn(),
  onArchive: vi.fn(),
  onSnooze: vi.fn(),
  onReadLater: vi.fn(),
  onPin: vi.fn(),
  onDelete: vi.fn(),
  t,
}

describe('ContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('single-message mode', () => {
    it('shows "markRead" for unread message', () => {
      const mail = makeMail({ unread: true })
      render(React.createElement(ContextMenu, { ...baseProps, menu: makeMenu(mail), selectedCount: 1 }))
      expect(screen.getByText('mail.actions.markRead')).toBeInTheDocument()
    })

    it('shows "markUnread" for read message', () => {
      const mail = makeMail({ unread: false })
      render(React.createElement(ContextMenu, { ...baseProps, menu: makeMenu(mail), selectedCount: 1 }))
      expect(screen.getByText('mail.actions.markUnread')).toBeInTheDocument()
    })

    it('calls onToggleSeen with mail.unread value in single mode', () => {
      const onToggleSeen = vi.fn()
      const onClose = vi.fn()
      const mail = makeMail({ unread: true })
      render(React.createElement(ContextMenu, {
        ...baseProps,
        onToggleSeen,
        onClose,
        menu: makeMenu(mail),
        selectedCount: 1,
      }))
      const btn = screen.getByText('mail.actions.markRead').closest('button')!
      fireEvent.click(btn)
      // In single mode, seen=mail.unread (true → mark as read)
      expect(onToggleSeen).toHaveBeenCalledWith(mail, true)
    })
  })

  describe('bulk mode (selectedCount > 1)', () => {
    it('shows "markRead" regardless of clicked row unread state', () => {
      // Regression test: in bulk mode the label must always be "markRead",
      // even when the right-clicked row is already read (unread=false).
      const mail = makeMail({ unread: false })
      render(React.createElement(ContextMenu, { ...baseProps, menu: makeMenu(mail), selectedCount: 3 }))
      expect(screen.getByText('mail.actions.markRead')).toBeInTheDocument()
    })

    it('does NOT show "markUnread" in bulk mode even for a read message', () => {
      const mail = makeMail({ unread: false })
      render(React.createElement(ContextMenu, { ...baseProps, menu: makeMenu(mail), selectedCount: 3 }))
      expect(screen.queryByText('mail.actions.markUnread')).toBeNull()
    })

    it('calls onToggleSeen with seen=true in bulk mode regardless of clicked row state', () => {
      // Regression test for the bulk bug: before the fix, onClick called
      // onToggleSeen(mail, mail.unread) which was false for a read message,
      // effectively marking all selected messages as UNread instead of READ.
      const onToggleSeen = vi.fn()
      const onClose = vi.fn()
      const mail = makeMail({ unread: false }) // right-clicked row is already read
      render(React.createElement(ContextMenu, {
        ...baseProps,
        onToggleSeen,
        onClose,
        menu: makeMenu(mail),
        selectedCount: 3,
      }))
      const btn = screen.getByText('mail.actions.markRead').closest('button')!
      fireEvent.click(btn)
      // Must always pass seen=true in bulk mode, not mail.unread (which is false here)
      expect(onToggleSeen).toHaveBeenCalledWith(mail, true)
    })

    it('shows selected count header in bulk mode', () => {
      const mail = makeMail()
      render(React.createElement(ContextMenu, { ...baseProps, menu: makeMenu(mail), selectedCount: 5 }))
      expect(screen.getByText('mail.context.selected')).toBeInTheDocument()
    })

    it('hides reply/replyAll/forward in bulk mode', () => {
      const mail = makeMail()
      render(React.createElement(ContextMenu, { ...baseProps, menu: makeMenu(mail), selectedCount: 2 }))
      expect(screen.queryByText('mail.actions.reply')).toBeNull()
      expect(screen.queryByText('mail.actions.replyAll')).toBeNull()
      expect(screen.queryByText('mail.actions.forward')).toBeNull()
    })
  })
})
