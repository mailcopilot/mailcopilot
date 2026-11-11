// @vitest-environment jsdom
import { renderHook, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThreadKeyboard, type UseThreadKeyboardParams } from './useThreadKeyboard'
import { resetThreadNavigationDismissal } from './threadNavigationDismissal'

const CARDS = ['1:INBOX:10', '1:INBOX:11', '1:INBOX:12']

function press(
  key: string,
  code: string,
  opts: { target?: EventTarget; shiftKey?: boolean; ctrlKey?: boolean } = {},
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
  })
  const target: EventTarget = opts.target ?? window
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

function setup(overrides: Partial<UseThreadKeyboardParams> = {}) {
  const onActivate = vi.fn()
  const onReply = vi.fn()
  const params: UseThreadKeyboardParams = {
    cardKeys: CARDS,
    activeKey: CARDS[0],
    threadKey: 'thread-a',
    onActivate,
    onReply,
    ...overrides,
  }
  const view = renderHook((p: UseThreadKeyboardParams) => useThreadKeyboard(p), {
    initialProps: params,
  })
  // Real buttons so the cursor can move DOM focus, as it does in ThreadView.
  const buttons = new Map<string, HTMLButtonElement>()
  for (const key of params.cardKeys) {
    const el = document.createElement('button')
    el.setAttribute('data-key', key)
    document.body.appendChild(el)
    buttons.set(key, el)
    act(() => {
      view.result.current.registerCard(key)(el)
    })
  }
  return { ...view, onActivate, onReply, buttons, params }
}

afterEach(() => {
  // Unmount first: a hook instance left mounted keeps its capture listener and
  // would claim the next test's keystrokes before the fresh instance sees them.
  cleanup()
  document.body.innerHTML = ''
  // The stand-down is window scope by design (it must outlive an unmount), so
  // it also outlives a test case.
  resetThreadNavigationDismissal()
  vi.restoreAllMocks()
})

describe('useThreadKeyboard — cursor', () => {
  it('starts with no cursor', () => {
    const { result } = setup()
    expect(result.current.focusedKey).toBeNull()
  })

  it('j places the cursor below the open message and moves DOM focus there', () => {
    const { result, buttons } = setup()
    press('j', 'KeyJ')
    expect(result.current.focusedKey).toBe(CARDS[1])
    expect(document.activeElement).toBe(buttons.get(CARDS[1]))
  })

  it('k walks back up', () => {
    const { result } = setup()
    press('j', 'KeyJ')
    press('j', 'KeyJ')
    expect(result.current.focusedKey).toBe(CARDS[2])
    press('k', 'KeyK')
    expect(result.current.focusedKey).toBe(CARDS[1])
  })

  it('swallows j at the end of the stack instead of letting the list move', () => {
    const { result } = setup({ activeKey: CARDS[2] })
    const e = press('j', 'KeyJ')
    expect(result.current.focusedKey).toBe(CARDS[2])
    expect(e.defaultPrevented).toBe(true)
  })

  it('Escape drops the cursor and blurs the card', () => {
    const { result, buttons } = setup()
    press('j', 'KeyJ')
    expect(document.activeElement).toBe(buttons.get(CARDS[1]))
    press('Escape', 'Escape')
    expect(result.current.focusedKey).toBeNull()
    expect(document.activeElement).not.toBe(buttons.get(CARDS[1]))
  })

  it('hands j / k to the list after Escape, and keeps them there', () => {
    // The bug this pins: Escape cleared the cursor but the next j re-derived an
    // anchor from the open card and claimed the key, so the list never moved.
    const seen: KeyboardEvent[] = []
    const listHandler = (e: KeyboardEvent) => { if (!e.defaultPrevented) seen.push(e) }
    window.addEventListener('keydown', listHandler)
    try {
      const { result } = setup()
      press('j', 'KeyJ')
      press('Escape', 'Escape')
      expect(result.current.focusedKey).toBeNull()

      const first = press('j', 'KeyJ')
      const second = press('k', 'KeyK')
      expect(first.defaultPrevented).toBe(false)
      expect(second.defaultPrevented).toBe(false)
      expect(seen).toHaveLength(2)
      expect(result.current.focusedKey).toBeNull()
    } finally {
      window.removeEventListener('keydown', listHandler)
    }
  })

  it('takes the keys back when the cursor is put on a card again', () => {
    const { result } = setup()
    press('j', 'KeyJ')
    press('Escape', 'Escape')
    act(() => {
      result.current.setFocusedKey(CARDS[0])
    })
    press('j', 'KeyJ')
    expect(result.current.focusedKey).toBe(CARDS[1])
  })

  it('stays stood down across a thread switch', () => {
    // Re-arming per thread would make j alternate between "next conversation"
    // and "next card" while the user walks the list.
    const { result, rerender, params } = setup()
    press('j', 'KeyJ')
    press('Escape', 'Escape')
    rerender({
      ...params,
      threadKey: 'thread-b',
      cardKeys: ['2:INBOX:1', '2:INBOX:2'],
      activeKey: '2:INBOX:1',
    })
    const e = press('j', 'KeyJ')
    expect(e.defaultPrevented).toBe(false)
    expect(result.current.focusedKey).toBeNull()
  })

  it('drops the cursor when another thread is opened', () => {
    const { result, rerender, params } = setup()
    press('j', 'KeyJ')
    expect(result.current.focusedKey).toBe(CARDS[1])
    rerender({ ...params, threadKey: 'thread-b', cardKeys: ['2:INBOX:1'], activeKey: '2:INBOX:1' })
    expect(result.current.focusedKey).toBeNull()
  })

  it('drops a cursor that points at a card the thread no longer has', () => {
    const { result, rerender, params } = setup()
    press('j', 'KeyJ')
    rerender({ ...params, cardKeys: [CARDS[0], CARDS[2]] })
    expect(result.current.focusedKey).toBeNull()
  })

  it('accepts a cursor placed by mouse or Tab focus', () => {
    const { result, onReply, buttons } = setup()
    // Exactly what the browser does before ThreadView's onFocus runs.
    act(() => {
      buttons.get(CARDS[2])!.focus()
      result.current.setFocusedKey(CARDS[2])
    })
    press('r', 'KeyR')
    expect(onReply).toHaveBeenCalledWith(CARDS[2], 'reply')
  })
})

describe('useThreadKeyboard — actions', () => {
  it('Enter and Space activate the focused card', () => {
    const { onActivate } = setup()
    press('j', 'KeyJ')
    press('Enter', 'Enter')
    press(' ', 'Space')
    expect(onActivate).toHaveBeenNthCalledWith(1, CARDS[1])
    expect(onActivate).toHaveBeenNthCalledWith(2, CARDS[1])
  })

  it('r / a / f reply to the focused card', () => {
    const { onReply } = setup()
    press('j', 'KeyJ')
    press('r', 'KeyR')
    press('a', 'KeyA')
    press('f', 'KeyF')
    expect(onReply.mock.calls).toEqual([
      [CARDS[1], 'reply'],
      [CARDS[1], 'replyAll'],
      [CARDS[1], 'forward'],
    ])
  })

  it('does nothing for r / a / f before the cursor is placed', () => {
    const { onReply } = setup()
    const e = press('r', 'KeyR')
    expect(onReply).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('useThreadKeyboard — precedence over the global handler', () => {
  let globalSeen: KeyboardEvent[]
  let globalHandler: (e: KeyboardEvent) => void

  beforeEach(() => {
    globalSeen = []
    // Mirrors useKeyboardShortcuts: bubble phase on window, first line bails
    // out on an event somebody already claimed.
    globalHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      globalSeen.push(e)
    }
    window.addEventListener('keydown', globalHandler)
  })

  afterEach(() => {
    window.removeEventListener('keydown', globalHandler)
  })

  it('claims j before the global handler sees it, even though it registered later', () => {
    setup()
    press('j', 'KeyJ')
    expect(globalSeen).toHaveLength(0)
  })

  it('leaves Shift+j to the global handler (range selection in the list)', () => {
    setup()
    press('j', 'KeyJ')
    press('j', 'KeyJ', { shiftKey: true })
    expect(globalSeen).toHaveLength(1)
  })

  it('leaves the arrow keys to the global handler', () => {
    setup()
    press('j', 'KeyJ')
    press('ArrowDown', 'ArrowDown')
    expect(globalSeen).toHaveLength(1)
  })

  it('leaves e (archive) to the global handler', () => {
    setup()
    press('j', 'KeyJ')
    press('e', 'KeyE')
    expect(globalSeen).toHaveLength(1)
  })

  it('leaves Ctrl combinations alone', () => {
    setup()
    press('j', 'KeyJ')
    press('k', 'KeyK', { ctrlKey: true })
    expect(globalSeen).toHaveLength(1)
  })
})

describe('useThreadKeyboard — focus that walked off the cards', () => {
  // Regression: the cursor is remembered, focus is not. Tab to the viewer
  // toolbar and Enter used to toggle the remembered card while the focused
  // button never fired.
  function setupWithOutsideFocus() {
    const view = setup()
    press('j', 'KeyJ')
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    return { ...view, outside }
  }

  it('leaves Enter and Space to the focused element', () => {
    const { onActivate, outside } = setupWithOutsideFocus()
    const enter = press('Enter', 'Enter', { target: outside })
    const space = press(' ', 'Space', { target: outside })
    expect(onActivate).not.toHaveBeenCalled()
    expect(enter.defaultPrevented).toBe(false)
    expect(space.defaultPrevented).toBe(false)
  })

  it('leaves r / a / f to the global handler', () => {
    const { onReply, outside } = setupWithOutsideFocus()
    press('r', 'KeyR', { target: outside })
    press('f', 'KeyF', { target: outside })
    expect(onReply).not.toHaveBeenCalled()
  })

  it('still walks the cards on j and pulls focus back', () => {
    const { result, outside, buttons } = setupWithOutsideFocus()
    press('j', 'KeyJ', { target: outside })
    expect(result.current.focusedKey).toBe(CARDS[2])
    expect(document.activeElement).toBe(buttons.get(CARDS[2]))
  })
})

describe('useThreadKeyboard — Esc with no cursor placed', () => {
  it('stands the thread down right after it opened', () => {
    const { result } = setup()
    const esc = press('Escape', 'Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(result.current.focusedKey).toBeNull()

    const j = press('j', 'KeyJ')
    expect(j.defaultPrevented).toBe(false)
    expect(result.current.focusedKey).toBeNull()
  })

  it('declines the second Esc so the list keeps its meaning for it', () => {
    setup()
    press('Escape', 'Escape')
    const second = press('Escape', 'Escape')
    expect(second.defaultPrevented).toBe(false)
  })
})

describe('useThreadKeyboard — the stand-down outlives this component', () => {
  it('keeps j with the list after the thread view unmounts and comes back', () => {
    // The real path: Esc, then j onto a SINGLE-message thread, which unmounts
    // ThreadView, then j onto another conversation, which mounts a fresh hook.
    const first = setup()
    press('Escape', 'Escape')
    first.unmount()
    cleanup()

    const second = setup()
    const j = press('j', 'KeyJ')
    expect(j.defaultPrevented).toBe(false)
    expect(second.result.current.focusedKey).toBeNull()
  })

  it('is lifted by putting the cursor back on a card', () => {
    const first = setup()
    press('Escape', 'Escape')
    first.unmount()
    cleanup()

    const second = setup()
    act(() => {
      second.buttons.get(CARDS[0])!.focus()
      second.result.current.setFocusedKey(CARDS[0])
    })
    press('j', 'KeyJ')
    expect(second.result.current.focusedKey).toBe(CARDS[1])
  })
})

describe('useThreadKeyboard — guards', () => {
  it('ignores keys typed into an input', () => {
    const { result } = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    const e = press('j', 'KeyJ', { target: input })
    expect(result.current.focusedKey).toBeNull()
    expect(e.defaultPrevented).toBe(false)
  })

  it('ignores keys typed into a contenteditable', () => {
    const { result } = setup()
    const div = document.createElement('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    document.body.appendChild(div)
    press('j', 'KeyJ', { target: div })
    expect(result.current.focusedKey).toBeNull()
  })

  it('stands down while a modal is open', () => {
    const { result } = setup()
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    press('j', 'KeyJ')
    expect(result.current.focusedKey).toBeNull()
    modal.remove()
    press('j', 'KeyJ')
    expect(result.current.focusedKey).toBe(CARDS[1])
  })

  it('does nothing when disabled', () => {
    const { result } = setup({ enabled: false })
    press('j', 'KeyJ')
    expect(result.current.focusedKey).toBeNull()
  })

  it('ignores an event another handler already claimed', () => {
    // Registered before the hook so it runs first in the capture phase.
    const claim = (e: KeyboardEvent) => e.preventDefault()
    window.addEventListener('keydown', claim, true)
    try {
      const { result } = setup()
      press('j', 'KeyJ')
      expect(result.current.focusedKey).toBeNull()
    } finally {
      window.removeEventListener('keydown', claim, true)
    }
  })

  it('stops listening after unmount', () => {
    const { unmount, onActivate } = setup()
    press('j', 'KeyJ')
    unmount()
    press('Enter', 'Enter')
    expect(onActivate).not.toHaveBeenCalled()
  })
})
