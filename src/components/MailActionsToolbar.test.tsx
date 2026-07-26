// @vitest-environment jsdom
/**
 * Unit tests for src/components/MailActionsToolbar.tsx
 *
 * Covers:
 *   - All buttons render with correct data-testid attributes
 *   - Archive disabled when folderRoles.archive is absent
 *   - Archive enabled when folderRoles.archive is present
 *   - Flag button shows "star-on" class when flagged=true
 *   - Mark-read button shows correct icon for seen/unseen state
 *   - Each button fires the correct callback on click
 *   - Dividers are rendered (aria-hidden)
 *   - className prop applied to root element
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import type { FolderRoles } from '@mailcopilot/types'

// ---------------------------------------------------------------------------
// Stable i18n mock
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'mail.actions.reply': 'Reply',
  'mail.actions.replyAll': 'Reply all',
  'mail.actions.forward': 'Forward',
  'mail.actions.archive': 'Archive',
  'mail.actions.archiveNotFound': 'Archive folder not found',
  'mail.actions.delete': 'Delete',
  'mail.actions.flag': 'Star',
  'mail.actions.unflag': 'Unstar',
  'mail.actions.markRead': 'Mark as read',
  'mail.actions.markUnread': 'Mark as unread',
  'mail.actions.print': 'Print',
  'mail.actions.confirmPermanentDelete': 'This will permanently delete the message.',
  'mail.actions.actionFailed': 'Action failed. Please try again.',
  'mail.actions.toolbarLabel': 'Mail actions',
}
const stableT = (key: string) => i18nMap[key] ?? key
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}))

// ---------------------------------------------------------------------------
// lucide-react stubs — minimal SVG replacements for jsdom
// ---------------------------------------------------------------------------
vi.mock('lucide-react', () => ({
  Reply: () => React.createElement('span', { 'data-icon': 'reply' }),
  ReplyAll: () => React.createElement('span', { 'data-icon': 'replyall' }),
  Forward: () => React.createElement('span', { 'data-icon': 'forward' }),
  Archive: () => React.createElement('span', { 'data-icon': 'archive' }),
  Trash2: () => React.createElement('span', { 'data-icon': 'trash2' }),
  Star: ({ fill }: { fill?: string }) => React.createElement('span', { 'data-icon': 'star', 'data-fill': fill }),
  Mail: () => React.createElement('span', { 'data-icon': 'mail' }),
  MailOpen: () => React.createElement('span', { 'data-icon': 'mailopen' }),
  Printer: () => React.createElement('span', { 'data-icon': 'printer' }),
}))

// ---------------------------------------------------------------------------
// Static import
// ---------------------------------------------------------------------------
import MailActionsToolbar from './MailActionsToolbar'
import type { MailActionsToolbarProps } from './MailActionsToolbar'

// ---------------------------------------------------------------------------
// Factory: default props — all callbacks are no-ops by default
// ---------------------------------------------------------------------------
function makeProps(overrides: Partial<MailActionsToolbarProps> = {}): MailActionsToolbarProps {
  return {
    flagged: false,
    seen: true,
    folderRoles: { archive: 'Archive', trash: 'Trash' } satisfies FolderRoles,
    onReply: vi.fn(),
    onReplyAll: vi.fn(),
    onForward: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onToggleFlag: vi.fn(),
    onToggleSeen: vi.fn(),
    onPrint: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: rendering
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — rendering', () => {
  afterEach(() => { cleanup() })

  it('renders all action buttons with correct data-testid attributes', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-reply')).toBeInTheDocument()
    expect(getByTestId('toolbar-reply-all')).toBeInTheDocument()
    expect(getByTestId('toolbar-forward')).toBeInTheDocument()
    expect(getByTestId('toolbar-archive')).toBeInTheDocument()
    expect(getByTestId('toolbar-delete')).toBeInTheDocument()
    expect(getByTestId('toolbar-flag')).toBeInTheDocument()
    expect(getByTestId('toolbar-mark-seen')).toBeInTheDocument()
    expect(getByTestId('toolbar-print')).toBeInTheDocument()
  })

  it('root element has class mail-actions-toolbar', () => {
    const { container } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(container.firstChild).toHaveClass('mail-actions-toolbar')
  })

  it('extra className is appended to root element', () => {
    const { container } = render(React.createElement(MailActionsToolbar, makeProps({ className: 'custom-class' })))
    expect(container.firstChild).toHaveClass('mail-actions-toolbar')
    expect(container.firstChild).toHaveClass('custom-class')
  })

  it('renders aria-hidden dividers', () => {
    const { container } = render(React.createElement(MailActionsToolbar, makeProps()))
    const dividers = container.querySelectorAll('.toolbar-divider[aria-hidden="true"]')
    expect(dividers.length).toBeGreaterThanOrEqual(2)
  })

  it('toolbar root has localized aria-label from mail.actions.toolbarLabel', () => {
    const { container } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(container.firstChild).toHaveAttribute('aria-label', 'Mail actions')
  })
})

// ---------------------------------------------------------------------------
// Tests: Archive disabled/enabled based on folderRoles
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — archive button state', () => {
  afterEach(() => { cleanup() })

  it('archive button is disabled when folderRoles.archive is absent', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRoles: { trash: 'Trash' } }))
    )
    expect(getByTestId('toolbar-archive')).toBeDisabled()
  })

  it('archive button has archiveNotFound title when disabled', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRoles: { trash: 'Trash' } }))
    )
    expect(getByTestId('toolbar-archive')).toHaveAttribute('title', 'Archive folder not found')
  })

  it('archive button is enabled when folderRoles.archive is present', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRoles: { archive: 'Archive' } }))
    )
    expect(getByTestId('toolbar-archive')).not.toBeDisabled()
  })

  it('archive button has archive title when enabled', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRoles: { archive: 'Archive' } }))
    )
    expect(getByTestId('toolbar-archive')).toHaveAttribute('title', 'Archive')
  })

  it('archive button is disabled when folderRoles is null', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRoles: null }))
    )
    expect(getByTestId('toolbar-archive')).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Tests: flag button visual state
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — flag button state', () => {
  afterEach(() => { cleanup() })

  it('flag button has star-on class when flagged=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ flagged: true }))
    )
    expect(getByTestId('toolbar-flag')).toHaveClass('star-on')
  })

  it('flag button does not have star-on class when flagged=false', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ flagged: false }))
    )
    expect(getByTestId('toolbar-flag')).not.toHaveClass('star-on')
  })

  it('flag button title is "Unstar" when flagged=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ flagged: true }))
    )
    expect(getByTestId('toolbar-flag')).toHaveAttribute('title', 'Unstar')
  })

  it('flag button title is "Star" when flagged=false', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ flagged: false }))
    )
    expect(getByTestId('toolbar-flag')).toHaveAttribute('title', 'Star')
  })
})

// ---------------------------------------------------------------------------
// Tests: seen/unseen button state
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — seen/unseen button state', () => {
  afterEach(() => { cleanup() })

  it('mark-seen button title is "Mark as unread" when seen=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ seen: true }))
    )
    expect(getByTestId('toolbar-mark-seen')).toHaveAttribute('title', 'Mark as unread')
  })

  it('mark-seen button title is "Mark as read" when seen=false', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ seen: false }))
    )
    expect(getByTestId('toolbar-mark-seen')).toHaveAttribute('title', 'Mark as read')
  })

  it('shows MailOpen icon when seen=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ seen: true }))
    )
    expect(getByTestId('toolbar-mark-seen').querySelector('[data-icon="mailopen"]')).toBeInTheDocument()
  })

  it('shows Mail icon when seen=false', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ seen: false }))
    )
    expect(getByTestId('toolbar-mark-seen').querySelector('[data-icon="mail"]')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests: callbacks fired on click
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — callbacks', () => {
  let props: MailActionsToolbarProps
  beforeEach(() => {
    props = makeProps()
  })
  afterEach(() => { cleanup() })

  it('onReply called when Reply button clicked', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-reply'))
    expect(props.onReply).toHaveBeenCalledOnce()
  })

  it('onReplyAll called when Reply All button clicked', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-reply-all'))
    expect(props.onReplyAll).toHaveBeenCalledOnce()
  })

  it('onForward called when Forward button clicked', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-forward'))
    expect(props.onForward).toHaveBeenCalledOnce()
  })

  it('onArchive called when Archive button clicked (when enabled)', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-archive'))
    expect(props.onArchive).toHaveBeenCalledOnce()
  })

  it('onArchive NOT called when Archive button is disabled', () => {
    const disabledProps = makeProps({ folderRoles: null })
    const { getByTestId } = render(React.createElement(MailActionsToolbar, disabledProps))
    fireEvent.click(getByTestId('toolbar-archive'))
    expect(disabledProps.onArchive).not.toHaveBeenCalled()
  })

  it('onDelete called when Delete button clicked', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-delete'))
    expect(props.onDelete).toHaveBeenCalledOnce()
  })

  it('onToggleFlag called when Flag button clicked', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-flag'))
    expect(props.onToggleFlag).toHaveBeenCalledOnce()
  })

  it('onToggleSeen called when Mark-seen button clicked', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-mark-seen'))
    expect(props.onToggleSeen).toHaveBeenCalledOnce()
  })

  it('onPrint called when Print button clicked', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, props))
    fireEvent.click(getByTestId('toolbar-print'))
    expect(props.onPrint).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Tests: BLOCKER fix — delete disabled until folderRolesLoaded
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — delete button loading guard', () => {
  afterEach(() => { cleanup() })

  it('delete button is disabled when folderRolesLoaded is false', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRolesLoaded: false }))
    )
    expect(getByTestId('toolbar-delete')).toBeDisabled()
  })

  it('delete button is enabled when folderRolesLoaded is true (default)', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRolesLoaded: true }))
    )
    expect(getByTestId('toolbar-delete')).not.toBeDisabled()
  })

  it('delete button is enabled when folderRolesLoaded is omitted (default true)', () => {
    // Default: folderRolesLoaded=true so existing consumers are not broken.
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-delete')).not.toBeDisabled()
  })

  it('onDelete NOT called when delete button is disabled (folderRolesLoaded=false)', () => {
    const disabledProps = makeProps({ folderRolesLoaded: false })
    const { getByTestId } = render(React.createElement(MailActionsToolbar, disabledProps))
    fireEvent.click(getByTestId('toolbar-delete'))
    expect(disabledProps.onDelete).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: MEDIUM fix — flagPending and seenPending props disable buttons
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — pending guards for flag/seen', () => {
  afterEach(() => { cleanup() })

  it('flag button is disabled when flagPending=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ flagPending: true }))
    )
    expect(getByTestId('toolbar-flag')).toBeDisabled()
  })

  it('flag button is enabled when flagPending=false (default)', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ flagPending: false }))
    )
    expect(getByTestId('toolbar-flag')).not.toBeDisabled()
  })

  it('seen button is disabled when seenPending=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ seenPending: true }))
    )
    expect(getByTestId('toolbar-mark-seen')).toBeDisabled()
  })

  it('seen button is enabled when seenPending=false (default)', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ seenPending: false }))
    )
    expect(getByTestId('toolbar-mark-seen')).not.toBeDisabled()
  })

  it('onToggleFlag NOT called when flagPending=true', () => {
    const pendingProps = makeProps({ flagPending: true })
    const { getByTestId } = render(React.createElement(MailActionsToolbar, pendingProps))
    fireEvent.click(getByTestId('toolbar-flag'))
    expect(pendingProps.onToggleFlag).not.toHaveBeenCalled()
  })

  it('onToggleSeen NOT called when seenPending=true', () => {
    const pendingProps = makeProps({ seenPending: true })
    const { getByTestId } = render(React.createElement(MailActionsToolbar, pendingProps))
    fireEvent.click(getByTestId('toolbar-mark-seen'))
    expect(pendingProps.onToggleSeen).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: HIGH fix — destructiveActionsDisabled disables Archive and Delete
//        while a deferred undo is pending (stale-UID guard).
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — destructiveActionsDisabled (HIGH fix: stale-UID guard)', () => {
  afterEach(() => { cleanup() })

  it('archive button is disabled when destructiveActionsDisabled=true (folder has archive)', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ destructiveActionsDisabled: true }))
    )
    expect(getByTestId('toolbar-archive')).toBeDisabled()
  })

  it('delete button is disabled when destructiveActionsDisabled=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ destructiveActionsDisabled: true }))
    )
    expect(getByTestId('toolbar-delete')).toBeDisabled()
  })

  it('archive button has normal archive title (not archiveNotFound) when disabled via destructiveActionsDisabled', () => {
    // Archive folder exists; button is disabled only because a pending undo is active.
    // The title should still read "Archive" (not "Archive folder not found") so the user
    // understands the folder is configured — it is just temporarily locked.
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({
        folderRoles: { archive: 'Archive', trash: 'Trash' },
        destructiveActionsDisabled: true,
      }))
    )
    expect(getByTestId('toolbar-archive')).toHaveAttribute('title', 'Archive')
  })

  it('archive button has archiveNotFound title when disabled via both missing archive AND destructiveActionsDisabled', () => {
    // No archive folder; disabled for both reasons — archiveNotFound title is shown.
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({
        folderRoles: { trash: 'Trash' },
        destructiveActionsDisabled: true,
      }))
    )
    expect(getByTestId('toolbar-archive')).toHaveAttribute('title', 'Archive folder not found')
  })

  it('onArchive NOT called when destructiveActionsDisabled=true', () => {
    const p = makeProps({ destructiveActionsDisabled: true })
    const { getByTestId } = render(React.createElement(MailActionsToolbar, p))
    fireEvent.click(getByTestId('toolbar-archive'))
    expect(p.onArchive).not.toHaveBeenCalled()
  })

  it('onDelete NOT called when destructiveActionsDisabled=true', () => {
    const p = makeProps({ destructiveActionsDisabled: true })
    const { getByTestId } = render(React.createElement(MailActionsToolbar, p))
    fireEvent.click(getByTestId('toolbar-delete'))
    expect(p.onDelete).not.toHaveBeenCalled()
  })

  it('reply/forward buttons remain enabled when destructiveActionsDisabled=true (non-destructive)', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ destructiveActionsDisabled: true }))
    )
    expect(getByTestId('toolbar-reply')).not.toBeDisabled()
    expect(getByTestId('toolbar-reply-all')).not.toBeDisabled()
    expect(getByTestId('toolbar-forward')).not.toBeDisabled()
  })

  it('flag and seen buttons remain enabled when destructiveActionsDisabled=true (non-destructive)', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ destructiveActionsDisabled: true }))
    )
    expect(getByTestId('toolbar-flag')).not.toBeDisabled()
    expect(getByTestId('toolbar-mark-seen')).not.toBeDisabled()
  })

  it('print button remains enabled when destructiveActionsDisabled=true', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ destructiveActionsDisabled: true }))
    )
    expect(getByTestId('toolbar-print')).not.toBeDisabled()
  })

  it('archive and delete are enabled again when destructiveActionsDisabled=false (default)', () => {
    // Default prop (false) — buttons must be available normally.
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-archive')).not.toBeDisabled()
    expect(getByTestId('toolbar-delete')).not.toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Tests: LOW fix — aria-label on all toolbar icon buttons
// ---------------------------------------------------------------------------

describe('MailActionsToolbar — aria-label accessibility', () => {
  afterEach(() => { cleanup() })

  it('reply button has aria-label matching title', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-reply')).toHaveAttribute('aria-label', 'Reply')
  })

  it('reply-all button has aria-label', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-reply-all')).toHaveAttribute('aria-label', 'Reply all')
  })

  it('forward button has aria-label', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-forward')).toHaveAttribute('aria-label', 'Forward')
  })

  it('archive button has aria-label (enabled)', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-archive')).toHaveAttribute('aria-label', 'Archive')
  })

  it('archive button has aria-label (disabled)', () => {
    const { getByTestId } = render(
      React.createElement(MailActionsToolbar, makeProps({ folderRoles: null }))
    )
    expect(getByTestId('toolbar-archive')).toHaveAttribute('aria-label', 'Archive folder not found')
  })

  it('delete button has aria-label', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-delete')).toHaveAttribute('aria-label', 'Delete')
  })

  it('flag button has aria-label "Star" when unflagged', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps({ flagged: false })))
    expect(getByTestId('toolbar-flag')).toHaveAttribute('aria-label', 'Star')
  })

  it('flag button has aria-label "Unstar" when flagged', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps({ flagged: true })))
    expect(getByTestId('toolbar-flag')).toHaveAttribute('aria-label', 'Unstar')
  })

  it('mark-seen button has aria-label "Mark as unread" when seen', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps({ seen: true })))
    expect(getByTestId('toolbar-mark-seen')).toHaveAttribute('aria-label', 'Mark as unread')
  })

  it('mark-seen button has aria-label "Mark as read" when unseen', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps({ seen: false })))
    expect(getByTestId('toolbar-mark-seen')).toHaveAttribute('aria-label', 'Mark as read')
  })

  it('print button has aria-label', () => {
    const { getByTestId } = render(React.createElement(MailActionsToolbar, makeProps()))
    expect(getByTestId('toolbar-print')).toHaveAttribute('aria-label', 'Print')
  })
})
