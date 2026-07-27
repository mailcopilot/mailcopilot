// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import FolderContextMenu, { type FolderContextMenuState } from './FolderContextMenu'

afterEach(cleanup)

// window.api mock — needed for the fallback IPC path when onToggleIndexInSearch
// is not provided.
const mockInvoke = vi.fn().mockResolvedValue({ ok: true })
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

const t = (key: string) => key

function makeMenu(overrides: Partial<FolderContextMenuState> = {}): FolderContextMenuState {
  return {
    x: 100,
    y: 200,
    accountId: 1,
    folderPath: 'INBOX',
    folderLabel: 'Inbox',
    role: '\\Inbox',
    ...overrides,
  }
}

function renderMenu(props: {
  menu?: FolderContextMenuState
  canEditRemote?: boolean
  includeInBadges?: boolean
  visible?: boolean
  indexInSearch?: boolean
  onClose?: () => void
  onToggleIndexInSearch?: (m: FolderContextMenuState) => void
} = {}) {
  const merged = {
    menu: makeMenu(),
    canEditRemote: true,
    includeInBadges: false,
    visible: true,
    indexInSearch: true,
    onClose: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onChangeIcon: vi.fn(),
    onSetHeaderSync: vi.fn(),
    onToggleBadge: vi.fn(),
    onToggleVisible: vi.fn(),
    t,
    ...props,
  }
  return render(React.createElement(FolderContextMenu, merged))
}

describe('FolderContextMenu §2.15-ter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the exclude-from-search button when indexInSearch=true', () => {
    renderMenu({ indexInSearch: true })
    expect(screen.getByText('folders.menu.excludeFromSearch')).toBeInTheDocument()
  })

  it('renders the include-in-search button when indexInSearch=false', () => {
    renderMenu({ indexInSearch: false })
    expect(screen.getByText('folders.menu.includeInSearch')).toBeInTheDocument()
  })

  it('calls onToggleIndexInSearch callback when the search toggle button is clicked', () => {
    const onToggle = vi.fn()
    const onClose = vi.fn()
    const menu = makeMenu({ folderPath: 'Junk', role: '\\Junk' })
    renderMenu({ menu, indexInSearch: true, onToggleIndexInSearch: onToggle, onClose })

    fireEvent.click(screen.getByText('folders.menu.excludeFromSearch'))

    expect(onToggle).toHaveBeenCalledOnce()
    expect(onToggle).toHaveBeenCalledWith(menu)
    // onClose must also be called (menu dismissal)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('falls back to direct IPC when onToggleIndexInSearch is not provided', () => {
    const onClose = vi.fn()
    const menu = makeMenu({ accountId: 7, folderPath: 'Trash', role: '\\Trash' })
    renderMenu({ menu, indexInSearch: true, onToggleIndexInSearch: undefined, onClose })

    fireEvent.click(screen.getByText('folders.menu.excludeFromSearch'))

    // IPC must be invoked with the toggled value (true → false)
    expect(mockInvoke).toHaveBeenCalledWith(
      'folder:prefs:upsert',
      7,
      'Trash',
      { indexInSearch: false },
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('toggles from false to true when folder is currently excluded', () => {
    const onClose = vi.fn()
    const menu = makeMenu({ accountId: 3, folderPath: 'Spam' })
    renderMenu({ menu, indexInSearch: false, onToggleIndexInSearch: undefined, onClose })

    fireEvent.click(screen.getByText('folders.menu.includeInSearch'))

    expect(mockInvoke).toHaveBeenCalledWith(
      'folder:prefs:upsert',
      3,
      'Spam',
      { indexInSearch: true },
    )
  })

  it('closes the menu when Escape is pressed', () => {
    const onClose = vi.fn()
    renderMenu({ onClose })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledOnce()
  })
})
