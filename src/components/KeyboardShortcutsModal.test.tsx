// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

const i18nMap: Record<string, string> = {
  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.navigation': 'Navigation',
  'shortcuts.actions': 'Actions',
  'shortcuts.general': 'General',
  // new context-menu section (uiaudit.x)
  'shortcuts.contextMenuTitle': 'Context menu',
  'shortcuts.contextMenuHint': 'Quick actions on message (reply, archive, move…)',
  'shortcuts.nextPrev': 'Next / previous',
  'shortcuts.open': 'Open message',
  'shortcuts.backToList': 'Back to list',
  'shortcuts.focusSearch': 'Focus search',
  'shortcuts.goInbox': 'Go to Inbox',
  'shortcuts.goSent': 'Go to Sent',
  'shortcuts.goDrafts': 'Go to Drafts',
  'shortcuts.goStarred': 'Go to Starred',
  'shortcuts.compose': 'Compose',
  'shortcuts.reply': 'Reply',
  'shortcuts.replyAll': 'Reply all',
  'shortcuts.forward': 'Forward',
  'shortcuts.star': 'Star / unstar',
  'shortcuts.archive': 'Archive',
  'shortcuts.markRead': 'Mark as read',
  'shortcuts.markUnread': 'Mark as unread',
  'shortcuts.spam': 'Report spam',
  'shortcuts.selectToggle': 'Select / deselect',
  'shortcuts.move': 'Move to folder',
  'shortcuts.undo': 'Undo',
  'shortcuts.delete': 'Delete',
  'shortcuts.clearSelection': 'Clear selection',
  'shortcuts.commandPalette': 'Open command palette',
  'shortcuts.showHelp': 'Show keyboard shortcuts',
  'common.close': 'Close',
}
const stableT = (key: string) => i18nMap[key] ?? key
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

import KeyboardShortcutsModal from './KeyboardShortcutsModal'

afterEach(cleanup)

describe('KeyboardShortcutsModal', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders dialog with accessible role', () => {
    render(React.createElement(KeyboardShortcutsModal, { onClose }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders all four section headings', () => {
    render(React.createElement(KeyboardShortcutsModal, { onClose }))
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Actions')).toBeInTheDocument()
    expect(screen.getByText('General')).toBeInTheDocument()
    // new section added in polish bundle #2
    expect(screen.getByText('Context menu')).toBeInTheDocument()
  })

  it('renders context menu section hint text', () => {
    render(React.createElement(KeyboardShortcutsModal, { onClose }))
    expect(screen.getByText('Quick actions on message (reply, archive, move…)')).toBeInTheDocument()
  })

  it('renders "Right-click" kbd element in context menu section', () => {
    const { container } = render(React.createElement(KeyboardShortcutsModal, { onClose }))
    const kbdElements = Array.from(container.querySelectorAll('kbd'))
    const rightClickKbd = kbdElements.find(el => el.textContent === 'Right-click')
    expect(rightClickKbd).toBeDefined()
  })

  it('calls onClose when overlay background is clicked', () => {
    render(React.createElement(KeyboardShortcutsModal, { onClose }))
    // Click the overlay (not the modal dialog itself)
    const overlay = document.querySelector('.shortcuts-overlay')!
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not close when clicking inside the modal', () => {
    render(React.createElement(KeyboardShortcutsModal, { onClose }))
    const modal = screen.getByRole('dialog')
    fireEvent.click(modal)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when Escape key is pressed', () => {
    render(React.createElement(KeyboardShortcutsModal, { onClose }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('removes keydown listener when unmounted', () => {
    const { unmount } = render(React.createElement(KeyboardShortcutsModal, { onClose }))
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
