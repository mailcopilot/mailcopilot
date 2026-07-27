// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SnoozeDropdown from './SnoozeDropdown'

afterEach(cleanup)

const t = (key: string) => key

function makeRect(): DOMRect {
  return { top: 100, left: 50, bottom: 130, right: 150, width: 100, height: 30, x: 50, y: 100, toJSON: () => ({}) }
}

describe('SnoozeDropdown', () => {
  it('renders 3 presets and a custom selection button', () => {
    const onSnooze = vi.fn()
    const onClose = vi.fn()
    render(<SnoozeDropdown anchorRect={makeRect()} onSnooze={onSnooze} onClose={onClose} t={t} />)

    expect(screen.getByText('snooze.laterToday')).toBeTruthy()
    expect(screen.getByText('snooze.tomorrowMorning')).toBeTruthy()
    expect(screen.getByText('snooze.nextWeek')).toBeTruthy()
    expect(screen.getByText('snooze.custom')).toBeTruthy()
  })

  it('clicking a preset calls onSnooze with a Date', () => {
    const onSnooze = vi.fn()
    const onClose = vi.fn()
    render(<SnoozeDropdown anchorRect={makeRect()} onSnooze={onSnooze} onClose={onClose} t={t} />)

    fireEvent.click(screen.getByText('snooze.laterToday'))

    expect(onSnooze).toHaveBeenCalledOnce()
    expect(onSnooze.mock.calls[0][0]).toBeInstanceOf(Date)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('clicking the overlay calls onClose', () => {
    const onSnooze = vi.fn()
    const onClose = vi.fn()
    const { container } = render(<SnoozeDropdown anchorRect={makeRect()} onSnooze={onSnooze} onClose={onClose} t={t} />)

    fireEvent.click(container.querySelector('.snooze-dropdown-overlay')!)

    expect(onClose).toHaveBeenCalledOnce()
    expect(onSnooze).not.toHaveBeenCalled()
  })

  it('shows datetime-local input when clicking custom', () => {
    const onSnooze = vi.fn()
    const onClose = vi.fn()
    render(<SnoozeDropdown anchorRect={makeRect()} onSnooze={onSnooze} onClose={onClose} t={t} />)

    fireEvent.click(screen.getByText('snooze.custom'))

    expect(screen.getByText('snooze.apply')).toBeTruthy()
    expect(document.querySelector('input[type="datetime-local"]')).toBeTruthy()
  })
})
