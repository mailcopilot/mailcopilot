// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { MailAddress } from '@mailcopilot/types'

const i18nMap: Record<string, string> = {
  'mail.context.copyAddress': 'Copy address',
  'mail.recipients.moreCount': '+{{count}} more',
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  let text = i18nMap[key] ?? key
  for (const [k, v] of Object.entries(opts ?? {})) text = text.replace(`{{${k}}}`, String(v))
  return text
}
const stableUseTranslation = { t: stableT, i18n: { language: 'en' } }
vi.mock('react-i18next', () => ({ useTranslation: () => stableUseTranslation }))

const mockCapture = vi.fn()
vi.mock('../sentry', () => ({ captureException: (...a: unknown[]) => mockCapture(...a) }))

vi.mock('../hooks/useTooltipDelegation', () => ({
  useTooltipDelegation: () => ({ tooltipState: null, containerRef: vi.fn() }),
}))

import CopyableAddress, { CopyableAddressList } from './CopyableAddress'
import RecipientList from './RecipientList'
import { placeAddressMenu, bareAddress } from '../hooks/useAddressCopyMenu'

const writeText = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})
afterEach(() => cleanup())

/** Right mouse button, as the browser reports it for a real right-click. */
const rightClick = (el: Element, x = 120, y = 80) =>
  fireEvent.contextMenu(el, { button: 2, clientX: x, clientY: y })

describe('placeAddressMenu / bareAddress', () => {
  it('keeps the menu on screen; trims addresses', () => {
    expect(placeAddressMenu(10, 10, 1000, 800)).toEqual({ x: 10, y: 10 })
    const p = placeAddressMenu(990, 790, 1000, 800)
    expect(p.x).toBeLessThan(990)
    expect(p.y).toBeLessThan(790)
    expect(placeAddressMenu(-5, -5, 1000, 800)).toEqual({ x: 8, y: 8 })
    expect(bareAddress('  a@b.test ')).toBe('a@b.test')
    expect(bareAddress('   ')).toBe('')
  })
})

describe('CopyableAddress', () => {
  it('right-click opens a one-item menu that copies the bare address', () => {
    render(<CopyableAddress address="user@example.test">User Name &lt;user@example.test&gt;</CopyableAddress>)
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
    expect(rightClick(screen.getByText(/User Name/))).toBe(false) // native menu suppressed
    const menu = screen.getByTestId('address-context-menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('address-context-copy'))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('user@example.test')
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
  })

  it('offers no menu and leaves the event alone for a name-only entry', () => {
    render(<CopyableAddress address="">undisclosed-recipients</CopyableAddress>)
    const notPrevented = rightClick(screen.getByText('undisclosed-recipients'))
    expect(notPrevented).toBe(true)
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
  })

  it('closes on Escape and on an outside mousedown without copying', () => {
    render(
      <div>
        <CopyableAddress address="a@b.test">a</CopyableAddress>
        <button>outside</button>
      </div>,
    )
    rightClick(screen.getByText('a'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('address-context-menu')).toBeNull()

    rightClick(screen.getByText('a'))
    fireEvent.mouseDown(screen.getByTestId('address-context-copy')) // inside: stays open
    expect(screen.getByTestId('address-context-menu')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByText('outside'))
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('keyboard-opened menu (no pointer button) focuses the item', () => {
    render(<CopyableAddress address="a@b.test" tabIndex={0}>a</CopyableAddress>)
    fireEvent.contextMenu(screen.getByText('a'))
    expect(screen.getByTestId('address-context-copy')).toHaveFocus()
  })

  it('does not trigger a wrapping button when the item is used', () => {
    // Thread-card shape: the address lives inside a <button>, and the portal is
    // a React child of it, so events must not bubble into its handlers.
    const onCardClick = vi.fn()
    render(
      <button type="button" onClick={onCardClick}>
        <CopyableAddress address="a@b.test">a</CopyableAddress>
      </button>,
    )
    rightClick(screen.getByText('a'))
    fireEvent.click(screen.getByTestId('address-context-copy'))
    expect(writeText).toHaveBeenCalledWith('a@b.test')
    expect(onCardClick).not.toHaveBeenCalled()
  })

  it('reports a rejected clipboard write instead of throwing', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    render(<CopyableAddress address="a@b.test">a</CopyableAddress>)
    rightClick(screen.getByText('a'))
    fireEvent.click(screen.getByTestId('address-context-copy'))
    await vi.waitFor(() => expect(mockCapture).toHaveBeenCalled())
    expect(mockCapture.mock.calls[0][1]).toMatchObject({ source: 'useAddressCopyMenu.copy' })
  })

  it('survives a missing Clipboard API', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    render(<CopyableAddress address="a@b.test">a</CopyableAddress>)
    rightClick(screen.getByText('a'))
    expect(() => fireEvent.click(screen.getByTestId('address-context-copy'))).not.toThrow()
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
  })
})

describe('CopyableAddressList (From header)', () => {
  const list: MailAddress[] = [
    { name: 'Alice', address: 'alice@example.test' },
    { address: 'bob@example.test' },
    { name: 'Group' },
  ]

  it('renders the same text as the plain list and copies each entry separately', () => {
    const { container } = render(<div><CopyableAddressList list={list} /></div>)
    expect(container.textContent).toBe('Alice <alice@example.test>, bob@example.test, Group')
    rightClick(screen.getByText('bob@example.test'))
    fireEvent.click(screen.getByTestId('address-context-copy'))
    expect(writeText).toHaveBeenCalledWith('bob@example.test')
  })

  it('copies the bare address, not the "Name <address>" label', () => {
    render(<CopyableAddressList list={list} />)
    rightClick(screen.getByText('Alice <alice@example.test>'))
    fireEvent.click(screen.getByTestId('address-context-copy'))
    expect(writeText).toHaveBeenCalledWith('alice@example.test')
  })

  it('drops empty entries without a stray separator', () => {
    const { container } = render(<CopyableAddressList list={[{}, { address: 'a@b.test' }]} />)
    expect(container.textContent).toBe('a@b.test')
  })
})

describe('RecipientList chips (To / Cc / Bcc)', () => {
  it('right-click on a chip copies that recipient\'s bare address', () => {
    render(
      <RecipientList
        addresses={[
          { name: 'Carol', address: 'carol@example.test' },
          { name: 'Dave', address: 'dave@example.test' },
        ]}
      />,
    )
    const chips = screen.getAllByTestId('recipient-chip')
    expect(chips).toHaveLength(2)
    rightClick(chips[1])
    fireEvent.click(screen.getByTestId('address-context-copy'))
    expect(writeText).toHaveBeenCalledWith('dave@example.test')
  })

  it('a chip stays focusable and opens the menu from the keyboard', () => {
    render(<RecipientList addresses={[{ name: 'Carol', address: 'carol@example.test' }]} />)
    const chip = screen.getByTestId('recipient-chip')
    expect(chip).toHaveAttribute('tabindex', '0')
    fireEvent.contextMenu(chip)
    expect(screen.getByTestId('address-context-copy')).toHaveFocus()
  })

  it('Escape after a mouse-opened menu closes only the menu (focus on the chip, real order)', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `U${i}`, address: `u${i}@example.test` }))
    render(<RecipientList addresses={many} />)
    fireEvent.click(screen.getByTestId('recipient-more-btn'))
    const chip = screen.getAllByTestId('recipient-chip')[0]
    chip.focus()
    rightClick(chip)
    // Anything below the menu that also reacts to Escape (search clear, the
    // global shortcuts) listens on window in the bubble phase.
    const bubbled = vi.fn()
    window.addEventListener('keydown', bubbled)
    fireEvent.keyDown(chip, { key: 'Escape' })
    window.removeEventListener('keydown', bubbled)
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
    expect(screen.getAllByTestId('recipient-chip')).toHaveLength(5) // list not collapsed
    expect(bubbled).not.toHaveBeenCalled()
  })
})

describe('selection, window blur and focus return', () => {
  it('a selection covering the address keeps the native menu (no menu, not prevented)', () => {
    render(<CopyableAddress address="alice@example.test">Alice &lt;alice@example.test&gt;</CopyableAddress>)
    const el = screen.getByText(/Alice/)
    window.getSelection()!.selectAllChildren(el)
    expect(rightClick(el)).toBe(true)
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
    window.getSelection()!.removeAllRanges()
  })

  it('a selection elsewhere does not suppress the menu', () => {
    render(<div><span>other text</span><CopyableAddress address="a@b.test">a</CopyableAddress></div>)
    window.getSelection()!.selectAllChildren(screen.getByText('other text'))
    expect(rightClick(screen.getByText('a'))).toBe(false)
    expect(screen.getByTestId('address-context-menu')).toBeInTheDocument()
    window.getSelection()!.removeAllRanges()
  })

  it('closes when the window loses focus (a click into the message iframe)', () => {
    render(<CopyableAddress address="a@b.test">a</CopyableAddress>)
    rightClick(screen.getByText('a'))
    fireEvent.blur(window)
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
  })

  it.each([
    ['Escape', () => fireEvent.keyDown(screen.getByTestId('address-context-copy'), { key: 'Escape' })],
    ['Enter on the item', () => fireEvent.click(screen.getByTestId('address-context-copy'))],
  ])('%s returns focus to the address and the menu key reopens it', (_name, close) => {
    render(<CopyableAddress address="a@b.test" tabIndex={0}>a</CopyableAddress>)
    const el = screen.getByText('a')
    el.focus()
    fireEvent.contextMenu(el)
    expect(screen.getByTestId('address-context-copy')).toHaveFocus()
    close()
    expect(screen.queryByTestId('address-context-menu')).toBeNull()
    expect(el).toHaveFocus()
    fireEvent.contextMenu(el)
    expect(screen.getByTestId('address-context-menu')).toBeInTheDocument()
  })

  it('an outside click does not steal focus back to the address', () => {
    render(<div><CopyableAddress address="a@b.test" tabIndex={0}>a</CopyableAddress><button>outside</button></div>)
    rightClick(screen.getByText('a'))
    screen.getByText('outside').focus()
    fireEvent.mouseDown(screen.getByText('outside'))
    expect(screen.getByText('outside')).toHaveFocus()
  })
})
