import { describe, it, expect } from 'vitest'
import {
  isThreadFocusPresent,
  resolveThreadFocusAnchor,
  resolveThreadKeyCommand,
  threadKeyLetter,
  type ThreadKeyContext,
  type ThreadKeyEvent,
} from './threadKeyboard'

const CARDS = ['1:INBOX:10', '1:INBOX:11', '1:INBOX:12']

function ctx(overrides: Partial<ThreadKeyContext> = {}): ThreadKeyContext {
  return {
    cardKeys: CARDS,
    focusedKey: null,
    activeKey: null,
    dismissed: false,
    // Default: the cursor was placed by j / k, which moves real focus onto the
    // card header. Cases where focus walked away say so explicitly.
    focusWithinCards: true,
    ...overrides,
  }
}

function ev(overrides: Partial<ThreadKeyEvent> = {}): ThreadKeyEvent {
  return {
    key: 'j',
    code: 'KeyJ',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  }
}

describe('threadKeyLetter', () => {
  it('reads the physical key so shortcuts survive a non-latin layout', () => {
    // Russian layout: pressing the physical J key reports key = 'о'.
    expect(threadKeyLetter('KeyJ', 'о')).toBe('j')
    expect(threadKeyLetter('KeyF', 'а')).toBe('f')
  })

  it('falls back to the character for single-character keys', () => {
    expect(threadKeyLetter('', 'R')).toBe('r')
  })

  it('passes named keys through untouched', () => {
    expect(threadKeyLetter('Enter', 'Enter')).toBe('Enter')
    expect(threadKeyLetter('Escape', 'Escape')).toBe('Escape')
  })
})

describe('resolveThreadFocusAnchor', () => {
  it('is the cursor when it points at an existing card', () => {
    expect(resolveThreadFocusAnchor(ctx({ focusedKey: CARDS[2], activeKey: CARDS[0] }))).toBe(2)
  })

  it('falls back to the open message when no cursor is placed', () => {
    expect(resolveThreadFocusAnchor(ctx({ activeKey: CARDS[1] }))).toBe(1)
  })

  it('ignores a cursor on a card that no longer exists', () => {
    expect(resolveThreadFocusAnchor(ctx({ focusedKey: '1:INBOX:99', activeKey: CARDS[2] }))).toBe(2)
  })

  it('falls back to the top of the stack with neither cursor nor open message', () => {
    expect(resolveThreadFocusAnchor(ctx())).toBe(0)
  })

  it('reports -1 for an empty stack', () => {
    expect(resolveThreadFocusAnchor(ctx({ cardKeys: [] }))).toBe(-1)
  })
})

describe('isThreadFocusPresent', () => {
  it('is false without a cursor and false for a stale one', () => {
    expect(isThreadFocusPresent(ctx())).toBe(false)
    expect(isThreadFocusPresent(ctx({ focusedKey: 'gone' }))).toBe(false)
    expect(isThreadFocusPresent(ctx({ focusedKey: CARDS[1] }))).toBe(true)
  })
})

describe('resolveThreadKeyCommand — cursor movement', () => {
  it('j moves down from the open message when the cursor is unplaced', () => {
    expect(resolveThreadKeyCommand(ev(), ctx({ activeKey: CARDS[0] })))
      .toEqual({ kind: 'focus', key: CARDS[1] })
  })

  it('k moves up from the cursor', () => {
    expect(resolveThreadKeyCommand(ev({ key: 'k', code: 'KeyK' }), ctx({ focusedKey: CARDS[2] })))
      .toEqual({ kind: 'focus', key: CARDS[1] })
  })

  it('clamps at the bottom and still claims the key', () => {
    // Must not fall through: otherwise `j` on the last card would move the
    // message list behind the open conversation.
    expect(resolveThreadKeyCommand(ev(), ctx({ focusedKey: CARDS[2] })))
      .toEqual({ kind: 'focus', key: CARDS[2] })
  })

  it('clamps at the top and still claims the key', () => {
    expect(resolveThreadKeyCommand(ev({ key: 'k', code: 'KeyK' }), ctx({ focusedKey: CARDS[0] })))
      .toEqual({ kind: 'focus', key: CARDS[0] })
  })

  it('leaves Shift+j / Shift+k to the list (range selection)', () => {
    expect(resolveThreadKeyCommand(ev({ shiftKey: true }), ctx({ focusedKey: CARDS[0] }))).toBeNull()
    expect(
      resolveThreadKeyCommand(ev({ key: 'k', code: 'KeyK', shiftKey: true }), ctx({ focusedKey: CARDS[0] })),
    ).toBeNull()
  })

  it('leaves the arrow keys to the message list', () => {
    expect(resolveThreadKeyCommand(ev({ key: 'ArrowDown', code: 'ArrowDown' }), ctx({ focusedKey: CARDS[0] }))).toBeNull()
    expect(resolveThreadKeyCommand(ev({ key: 'ArrowUp', code: 'ArrowUp' }), ctx({ focusedKey: CARDS[0] }))).toBeNull()
  })

  it('claims nothing when the stack is empty', () => {
    expect(resolveThreadKeyCommand(ev(), ctx({ cardKeys: [] }))).toBeNull()
  })
})

describe('resolveThreadKeyCommand — after Esc the list owns j / k', () => {
  // Regression: Esc used to clear the cursor only. `j` then re-derived an
  // anchor from the open card, claimed the keystroke again, and the message
  // list never saw one — "Esc hands the keys back" was never true.
  it('passes j and k through once the user stood the thread down', () => {
    const stood = ctx({ activeKey: CARDS[0], dismissed: true })
    expect(resolveThreadKeyCommand(ev(), stood)).toBeNull()
    expect(resolveThreadKeyCommand(ev({ key: 'k', code: 'KeyK' }), stood)).toBeNull()
  })

  it('takes the keys back as soon as the cursor is put on a card again', () => {
    const rearmed = ctx({ activeKey: CARDS[0], focusedKey: CARDS[1], dismissed: true })
    expect(resolveThreadKeyCommand(ev(), rearmed)).toEqual({ kind: 'focus', key: CARDS[2] })
  })

  it('still ignores a stale cursor while stood down', () => {
    expect(resolveThreadKeyCommand(ev(), ctx({ focusedKey: 'gone', dismissed: true }))).toBeNull()
  })
})

describe('resolveThreadKeyCommand — Esc answers "who owns j / k"', () => {
  it('stands the thread down straight after it opened, with no cursor placed', () => {
    // The cards own j / k from the first frame, so the way out must work from
    // the first frame too — requiring a cursor meant going IN to get OUT.
    expect(resolveThreadKeyCommand(ev({ key: 'Escape', code: 'Escape' }), ctx({ activeKey: CARDS[0] })))
      .toEqual({ kind: 'exit' })
  })

  it('declines the second Esc, so the list keeps its old meaning for it', () => {
    const stoodDown = ctx({ activeKey: CARDS[0], dismissed: true })
    expect(resolveThreadKeyCommand(ev({ key: 'Escape', code: 'Escape' }), stoodDown)).toBeNull()
  })

  it('claims Esc again once the cursor is back on a card', () => {
    const rearmed = ctx({ focusedKey: CARDS[1], dismissed: true })
    expect(resolveThreadKeyCommand(ev({ key: 'Escape', code: 'Escape' }), rearmed))
      .toEqual({ kind: 'exit' })
  })

  it('claims Esc even when focus walked off the cards', () => {
    // Esc is about ownership of j / k, which the thread holds regardless of
    // where the focus ring currently sits.
    const away = ctx({ focusedKey: CARDS[1], focusWithinCards: false })
    expect(resolveThreadKeyCommand(ev({ key: 'Escape', code: 'Escape' }), away))
      .toEqual({ kind: 'exit' })
  })
})

describe('resolveThreadKeyCommand — focus that walked off the cards', () => {
  // Regression: the cursor is remembered, focus is not. With focus on the
  // viewer's Print button, Enter used to toggle the remembered card and
  // swallow the button's own activation.
  const away = ctx({ focusedKey: CARDS[1], activeKey: CARDS[0], focusWithinCards: false })

  it.each([
    ['Enter', 'Enter'],
    [' ', 'Space'],
  ])('leaves %s to the focused element', (key, code) => {
    expect(resolveThreadKeyCommand(ev({ key, code }), away)).toBeNull()
  })

  it.each([
    ['r', 'KeyR'],
    ['a', 'KeyA'],
    ['f', 'KeyF'],
  ])('leaves %s to the global handler — the ring the user sees is gone', (key, code) => {
    expect(resolveThreadKeyCommand(ev({ key, code }), away)).toBeNull()
  })

  it('still lets j / k walk the cards — they are the way in', () => {
    expect(resolveThreadKeyCommand(ev(), away)).toEqual({ kind: 'focus', key: CARDS[2] })
  })
})

describe('resolveThreadKeyCommand — modifiers', () => {
  it.each([
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['alt', { altKey: true }],
  ])('never claims a %s combination', (_name, mod) => {
    expect(resolveThreadKeyCommand(ev(mod), ctx({ focusedKey: CARDS[0] }))).toBeNull()
    expect(
      resolveThreadKeyCommand(ev({ key: 'a', code: 'KeyA', ...mod }), ctx({ focusedKey: CARDS[0] })),
    ).toBeNull()
  })
})

describe('resolveThreadKeyCommand — actions on the focused card', () => {
  const focused = ctx({ focusedKey: CARDS[1], activeKey: CARDS[0] })

  it('Enter activates the focused card', () => {
    expect(resolveThreadKeyCommand(ev({ key: 'Enter', code: 'Enter' }), focused))
      .toEqual({ kind: 'activate', key: CARDS[1] })
  })

  it('Space activates the focused card', () => {
    expect(resolveThreadKeyCommand(ev({ key: ' ', code: 'Space' }), focused))
      .toEqual({ kind: 'activate', key: CARDS[1] })
  })

  it.each([
    ['r', 'KeyR', 'reply'],
    ['a', 'KeyA', 'replyAll'],
    ['f', 'KeyF', 'forward'],
  ])('%s targets the focused card, not the open one', (key, code, mode) => {
    expect(resolveThreadKeyCommand(ev({ key, code }), focused))
      .toEqual({ kind: 'reply', key: CARDS[1], mode })
  })

  it('does not rebind e — archive keeps its meaning inside a thread', () => {
    expect(resolveThreadKeyCommand(ev({ key: 'e', code: 'KeyE' }), focused)).toBeNull()
    expect(resolveThreadKeyCommand(ev({ key: 'E', code: 'KeyE', shiftKey: true }), focused)).toBeNull()
  })

  it('leaves untouched letters alone', () => {
    for (const [key, code] of [['x', 'KeyX'], ['v', 'KeyV'], ['s', 'KeyS'], ['u', 'KeyU']]) {
      expect(resolveThreadKeyCommand(ev({ key, code }), focused)).toBeNull()
    }
  })

  it('Escape drops the cursor', () => {
    expect(resolveThreadKeyCommand(ev({ key: 'Escape', code: 'Escape' }), focused)).toEqual({ kind: 'exit' })
  })
})

describe('resolveThreadKeyCommand — without a cursor the global handler keeps its keys', () => {
  const noCursor = ctx({ activeKey: CARDS[0] })

  it.each([
    ['Enter', 'Enter'],
    [' ', 'Space'],
    ['r', 'KeyR'],
    ['a', 'KeyA'],
    ['f', 'KeyF'],
  ])('passes %s through until j / k placed the cursor', (key, code) => {
    expect(resolveThreadKeyCommand(ev({ key, code }), noCursor)).toBeNull()
  })

  it('treats a stale cursor as no cursor', () => {
    expect(resolveThreadKeyCommand(ev({ key: 'r', code: 'KeyR' }), ctx({ focusedKey: 'gone' }))).toBeNull()
  })
})
