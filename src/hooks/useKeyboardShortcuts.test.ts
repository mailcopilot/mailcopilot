// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useKeyboardShortcuts, type UseKeyboardShortcutsParams } from './useKeyboardShortcuts'
import type { MailSummary } from '../../packages/net/types'

function makeMail(uid: number, overrides?: Partial<MailSummary>): MailSummary {
  return {
    accountId: 1, folder: 'INBOX', uid,
    subject: `s${uid}`, from: `u${uid}@test`, fromAddr: `u${uid}@test`,
    date: '2026-01-01T00:00:00Z', unread: false, flagged: false, hasAttachments: false,
    ...overrides,
  }
}

// Mock window.api
const mockInvoke = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
  writable: true,
})

function fireKey(key: string, opts?: Partial<KeyboardEvent>) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
  window.dispatchEvent(ev)
}

function defaultParams(): UseKeyboardShortcutsParams {
  return {
    active: null,
    activeThread: null,
    hasAccount: true,
    hasMultiSelection: false,
    hotkeysPreset: 'gmail',
    selectedKeys: new Set(),
    showCommandPalette: false,
    sidebarWidth: 56,
    currentAccountId: 1,
    undoInfoRef: { current: null },
    qRef: { current: '' },
    viewMailsRef: { current: [] },
    threadRowsRef: { current: [] },
    selectionAnchorKey: { current: null },
    rolesByAccount: { current: new Map([[1, { sent: 'Sent', drafts: 'Drafts' }]]) },
    virtuosoRef: { current: null },
    onSearchRef: { current: vi.fn() },
    openMail: vi.fn(),
    replyMail: vi.fn(),
    archiveMail: vi.fn(),
    deleteMail: vi.fn(),
    spamMail: vi.fn(),
    bulkArchive: vi.fn(),
    bulkDelete: vi.fn(),
    bulkSpam: vi.fn(),
    handleUndo: vi.fn(),
    setSeenForMail: vi.fn(),
    setSeenForMany: vi.fn(),
    setFlaggedForMail: vi.fn(),
    togglePin: vi.fn(),
    focusSearchInput: vi.fn(),
    switchFolder: vi.fn(),
    toggleAiPanel: vi.fn(),
    summarizeWithAi: vi.fn(),
    setShowCommandPalette: vi.fn(),
    setCommandQuery: vi.fn(),
    setActive: vi.fn(),
    setDetails: vi.fn(),
    setSelectedKeys: vi.fn(),
    setFilterMode: vi.fn(),
    setShowShortcuts: vi.fn(),
    setQ: vi.fn(),
    setCtxMenu: vi.fn(),
    searchDebounceRef: { current: null },
  }
}

describe('useKeyboardShortcuts', () => {
  let params: UseKeyboardShortcutsParams

  beforeEach(() => {
    vi.useFakeTimers()
    params = defaultParams()
    mockInvoke.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('Ctrl+K opens the command palette', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('k', { ctrlKey: true })
    expect(params.setShowCommandPalette).toHaveBeenCalledWith(true)
    expect(params.setCommandQuery).toHaveBeenCalledWith('')
  })

  it('Ctrl+Shift+A toggles the AI panel', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('a', { ctrlKey: true, shiftKey: true })
    expect(params.toggleAiPanel).toHaveBeenCalled()
  })

  it('Ctrl+Shift+S triggers AI summarization', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('s', { ctrlKey: true, shiftKey: true })
    expect(params.summarizeWithAi).toHaveBeenCalled()
  })

  it('Escape in command palette closes it', () => {
    params.showCommandPalette = true
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('Escape')
    expect(params.setShowCommandPalette).toHaveBeenCalledWith(false)
  })

  it('/ focuses search input', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('/')
    expect(params.focusSearchInput).toHaveBeenCalled()
  })

  it('? toggles shortcuts panel', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('?')
    expect(params.setShowShortcuts).toHaveBeenCalled()
  })

  it('c opens the compose window', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('c')
    expect(mockInvoke).toHaveBeenCalledWith('ui:openCompose')
  })

  it('c does nothing without an account', () => {
    params.hasAccount = false
    renderHook(() => useKeyboardShortcuts(params))
    mockInvoke.mockClear()
    fireKey('c')
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openCompose')
  })

  it('r replies to the active message', () => {
    const mail = makeMail(1)
    params.active = mail
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('r')
    expect(params.replyMail).toHaveBeenCalledWith(mail, 'reply')
  })

  it('a replies to all', () => {
    const mail = makeMail(1)
    params.active = mail
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('a')
    expect(params.replyMail).toHaveBeenCalledWith(mail, 'replyAll')
  })

  it('f forwards the message', () => {
    const mail = makeMail(1)
    params.active = mail
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('f')
    expect(params.replyMail).toHaveBeenCalledWith(mail, 'forward')
  })

  it('e archives the active message', () => {
    params.active = makeMail(1)
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('e')
    expect(params.archiveMail).toHaveBeenCalled()
  })

  it('e with multi-selection calls bulkArchive', () => {
    params.active = makeMail(1)
    params.hasMultiSelection = true
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('e')
    expect(params.bulkArchive).toHaveBeenCalled()
  })

  it('! marks as spam', () => {
    params.active = makeMail(1)
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('!')
    expect(params.spamMail).toHaveBeenCalled()
  })

  it('# deletes the message', () => {
    params.active = makeMail(1)
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('#')
    expect(params.deleteMail).toHaveBeenCalled()
  })

  it('Delete deletes the message', () => {
    params.active = makeMail(1)
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('Delete')
    expect(params.deleteMail).toHaveBeenCalled()
  })

  it('s toggles the flagged status', () => {
    const mail = makeMail(1, { flagged: false })
    params.active = mail
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('s')
    expect(params.setFlaggedForMail).toHaveBeenCalledWith(mail, true)
  })

  it('z calls handleUndo when undo is available', () => {
    params.undoInfoRef = { current: { accountId: 1, label: 'Del', messages: [], folder: 'INBOX', targetFolder: 'Trash', unreadDelta: 0 } }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('z')
    expect(params.handleUndo).toHaveBeenCalled()
  })

  it('z without undo does not call handleUndo', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('z')
    expect(params.handleUndo).not.toHaveBeenCalled()
  })

  it('u returns to the list (resets active)', () => {
    params.active = makeMail(1)
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('u')
    expect(params.setActive).toHaveBeenCalledWith(null)
    expect(params.setDetails).toHaveBeenCalledWith(null)
  })

  it('j/k navigates through the list', () => {
    const m1 = makeMail(1)
    const m2 = makeMail(2)
    params.active = m1
    params.viewMailsRef = { current: [m1, m2] }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('j') // down
    expect(params.openMail).toHaveBeenCalledWith(m2)
  })

  it('Shift+U marks as unread', () => {
    const mail = makeMail(1)
    params.active = mail
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('u', { shiftKey: true })
    expect(params.setSeenForMail).toHaveBeenCalledWith(mail, false)
  })

  it('Shift+I marks as read', () => {
    const mail = makeMail(1)
    params.active = mail
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('i', { shiftKey: true })
    expect(params.setSeenForMail).toHaveBeenCalledWith(mail, true)
  })

  it('two-key navigation g -> i switches to INBOX', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('g')
    fireKey('i')
    expect(params.switchFolder).toHaveBeenCalledWith('INBOX')
  })

  it('two-key navigation g -> s switches to Sent', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('g')
    fireKey('s')
    expect(params.switchFolder).toHaveBeenCalledWith('Sent')
  })

  it('two-key navigation g -> d switches to Drafts', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('g')
    fireKey('d')
    expect(params.switchFolder).toHaveBeenCalledWith('Drafts')
  })

  it('g without a second key resets after 1.5s', () => {
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('g')
    vi.advanceTimersByTime(1600)
    fireKey('i')
    expect(params.switchFolder).not.toHaveBeenCalled()
  })

  it('Enter opens the active message', () => {
    const mail = makeMail(1)
    params.active = mail
    params.viewMailsRef = { current: [mail] }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('Enter')
    expect(params.openMail).toHaveBeenCalledWith(mail)
  })

  it('Escape clears multi-selection', () => {
    const mail = makeMail(1)
    params.active = mail
    params.hasMultiSelection = true
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('Escape')
    expect(params.setSelectedKeys).toHaveBeenCalled()
  })

  it('Escape clears the search query', () => {
    params.qRef = { current: 'from:test@test' }
    params.searchDebounceRef = { current: null }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('Escape')
    expect(params.setQ).toHaveBeenCalledWith('')
  })

  it('does not intercept keys when input is focused', () => {
    renderHook(() => useKeyboardShortcuts(params))
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const ev = new KeyboardEvent('keydown', { key: 'c', bubbles: true })
    Object.defineProperty(ev, 'target', { value: input })
    input.dispatchEvent(ev)
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openCompose')
    document.body.removeChild(input)
  })

  describe('Gmail preset Ctrl shortcuts', () => {
    it('Ctrl+N opens compose', () => {
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('n', { ctrlKey: true })
      expect(mockInvoke).toHaveBeenCalledWith('ui:openCompose')
    })

    it('Ctrl+R replies to the message', () => {
      const mail = makeMail(1)
      params.active = mail
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('r', { ctrlKey: true })
      expect(params.replyMail).toHaveBeenCalledWith(mail, 'reply')
    })

    it('Ctrl+Shift+R replies to all', () => {
      const mail = makeMail(1)
      params.active = mail
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('r', { ctrlKey: true, shiftKey: true })
      expect(params.replyMail).toHaveBeenCalledWith(mail, 'replyAll')
    })

    it('Ctrl+F focuses search', () => {
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('f', { ctrlKey: true })
      expect(params.focusSearchInput).toHaveBeenCalled()
    })

    it('Ctrl+Shift+F forwards', () => {
      const mail = makeMail(1)
      params.active = mail
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('f', { ctrlKey: true, shiftKey: true })
      expect(params.replyMail).toHaveBeenCalledWith(mail, 'forward')
    })
  })

  describe('Outlook preset Ctrl shortcuts', () => {
    beforeEach(() => {
      params.hotkeysPreset = 'outlook'
    })

    it('Ctrl+F forwards the message', () => {
      const mail = makeMail(1)
      params.active = mail
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('f', { ctrlKey: true })
      expect(params.replyMail).toHaveBeenCalledWith(mail, 'forward')
    })

    it('Ctrl+E focuses search', () => {
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('e', { ctrlKey: true })
      expect(params.focusSearchInput).toHaveBeenCalled()
    })
  })

  it('x toggles message selection', () => {
    const mail = makeMail(1)
    params.active = mail
    params.viewMailsRef = { current: [mail] }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('x')
    expect(params.setSelectedKeys).toHaveBeenCalledWith(new Set(['1:INBOX:1']))
  })

  it('x toggles the whole ROW when the active message sits mid-thread', () => {
    // Same rule as Ctrl-click: the row may already be selected through its lead
    // (or through any other message), so toggling the active message's own key
    // would leave two keys of one row in the set and inflate the toolbar count.
    const lead = makeMail(30)
    const reply = makeMail(20)
    params.active = reply
    params.activeThread = { key: 't', lead, items: [lead, reply], count: 2, unreadCount: 0 }
    params.viewMailsRef = { current: [lead] }
    params.selectedKeys = new Set(['1:INBOX:30'])
    renderHook(() => useKeyboardShortcuts(params))

    fireKey('x')

    expect(params.setSelectedKeys).toHaveBeenCalledWith(new Set())
  })

  it('x selects the row by its LEAD key when nothing of the row is selected', () => {
    const lead = makeMail(30)
    const reply = makeMail(20)
    params.active = reply
    params.activeThread = { key: 't', lead, items: [lead, reply], count: 2, unreadCount: 0 }
    params.viewMailsRef = { current: [lead] }
    renderHook(() => useKeyboardShortcuts(params))

    fireKey('x')

    // The lead, not the active reply: the Shift range walks the lead list.
    expect(params.setSelectedKeys).toHaveBeenCalledWith(new Set(['1:INBOX:30']))
    expect(params.selectionAnchorKey.current).toBe('1:INBOX:30')
  })

  it('v opens the move context menu', () => {
    const mail = makeMail(1)
    params.active = mail
    params.viewMailsRef = { current: [mail] }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('v')
    expect(params.setCtxMenu).toHaveBeenCalled()
    expect(params.setSelectedKeys).toHaveBeenCalled()
  })

  describe('after `u` closes the viewer, keys resolve the selected ROW', () => {
    // `u` clears the active message and deliberately leaves the selection alone,
    // and what a selection holds after opening a thread is a MID-THREAD key.
    // Scanning the lead-only list for it misses and silently falls back to the
    // first row of the list — a message the user never picked.
    const other = makeMail(10)
    const lead = makeMail(30)
    const reply = makeMail(20)
    const otherRow = { key: '1:INBOX:10', lead: other, items: [other], count: 1, unreadCount: 0 }
    const row = { key: '1:INBOX:30', lead, items: [lead, reply], count: 2, unreadCount: 0 }

    beforeEach(() => {
      params.active = null
      params.activeThread = null
      params.selectedKeys = new Set(['1:INBOX:20'])
      params.viewMailsRef = { current: [other, lead] }
      params.threadRowsRef = { current: [otherRow, row] }
    })

    it('Enter opens the selected row, not the first row of the list', () => {
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('Enter')
      expect(params.openMail).toHaveBeenCalledWith(lead)
    })

    it('o opens the selected row, not the first row of the list', () => {
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('o')
      expect(params.openMail).toHaveBeenCalledWith(lead)
    })

    it('v offers to move the selected row, not the first row of the list', () => {
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('v')
      expect(params.setCtxMenu).toHaveBeenCalledWith(expect.objectContaining({ mail: lead, moveOpen: true }))
      expect(params.setSelectedKeys).toHaveBeenCalledWith(new Set(['1:INBOX:30']))
    })

    it('x toggles the selected row, not the first row of the list', () => {
      // The old fallback toggled `list[0]` and ADDED its lead key next to the
      // mid-thread key already in the set — two keys standing for two rows.
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('x')
      expect(params.setSelectedKeys).toHaveBeenCalledWith(new Set())
    })

    it('x clears the anchor when the last selected row goes', () => {
      // The mouse path assigns the returned anchor unconditionally; keeping a
      // stale one here made the next Shift-click draw its range from a row that
      // is no longer selected.
      params.selectionAnchorKey = { current: '1:INBOX:20' }
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('x')
      expect(params.selectionAnchorKey.current).toBeNull()
    })
  })

  it('Shift+j draws the range from an anchor sitting mid-thread', () => {
    // The mouse path maps the anchor onto its row lead lazily; the keyboard path
    // looked it up in the lead list directly, got -1, and selected only the
    // destination row instead of the range.
    const lead = makeMail(30)
    const reply = makeMail(20)
    const other = makeMail(10)
    const row = { key: '1:INBOX:30', lead, items: [lead, reply], count: 2, unreadCount: 0 }
    const otherRow = { key: '1:INBOX:10', lead: other, items: [other], count: 1, unreadCount: 0 }
    params.active = reply
    params.activeThread = row
    params.viewMailsRef = { current: [lead, other] }
    params.threadRowsRef = { current: [row, otherRow] }
    params.selectionAnchorKey = { current: '1:INBOX:20' }
    renderHook(() => useKeyboardShortcuts(params))

    fireKey('j', { shiftKey: true })

    expect(params.setSelectedKeys).toHaveBeenCalledWith(new Set(['1:INBOX:30', '1:INBOX:10']))
  })

  it('Ctrl+A selects all visible messages', () => {
    const m1 = makeMail(1)
    const m2 = makeMail(2)
    const m3 = makeMail(3)
    params.viewMailsRef = { current: [m1, m2, m3] }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('a', { ctrlKey: true })
    expect(params.setSelectedKeys).toHaveBeenCalledWith(
      new Set(['1:INBOX:1', '1:INBOX:2', '1:INBOX:3']),
    )
  })

  it('Ctrl+A does nothing with empty list', () => {
    params.viewMailsRef = { current: [] }
    renderHook(() => useKeyboardShortcuts(params))
    fireKey('a', { ctrlKey: true })
    expect(params.setSelectedKeys).not.toHaveBeenCalled()
  })

  it('Ctrl+A is not intercepted in input fields', () => {
    const m1 = makeMail(1)
    params.viewMailsRef = { current: [m1] }
    renderHook(() => useKeyboardShortcuts(params))
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const ev = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })
    Object.defineProperty(ev, 'target', { value: input })
    input.dispatchEvent(ev)
    expect(params.setSelectedKeys).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  describe('keyboard layout', () => {
    it('shortcut c works via event.code in Russian layout', () => {
      renderHook(() => useKeyboardShortcuts(params))
      // Physical 'C' is pressed, but key is Cyrillic 'с'
      fireKey('с', { code: 'KeyC' } as KeyboardEventInit)
      expect(mockInvoke).toHaveBeenCalledWith('ui:openCompose')
    })

    it('shortcut r works via event.code in Russian layout', () => {
      const mail = makeMail(1)
      params.active = mail
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('к', { code: 'KeyR' } as KeyboardEventInit)
      expect(params.replyMail).toHaveBeenCalledWith(mail, 'reply')
    })

    it('Ctrl+K works via event.code in Russian layout', () => {
      renderHook(() => useKeyboardShortcuts(params))
      fireKey('л', { ctrlKey: true, code: 'KeyK' } as KeyboardEventInit)
      expect(params.setShowCommandPalette).toHaveBeenCalledWith(true)
    })
  })
})
