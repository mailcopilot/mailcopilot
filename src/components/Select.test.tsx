// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import Select from './Select'
import type { SelectOption } from './Select'

// Slim API-contract suite for the custom <Select> wrapper. Detailed behavioural
// coverage (keyboard nav, focus restoration, ARIA, typeahead, click-outside)
// lives in the e2e suite where a real layout engine + portal are available.
// jsdom-level tests here verify only what is observable from the rendered DOM:
// selected label, disabled, accessible name passthrough, value-not-in-options
// fallback, className/style applied to the wrapper, data-selected-value mirror.

afterEach(cleanup)

const colorOptions: SelectOption[] = [
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
]

const numOptions: SelectOption<number>[] = [
  { value: 5, label: '5 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
]

describe('Select — render contract', () => {
  it('shows the selected option label in the trigger', () => {
    render(<Select value="green" options={colorOptions} onChange={vi.fn()} testId="sel" />)
    expect(screen.getByTestId('sel')).toHaveTextContent('Green')
  })

  it('renders as disabled when disabled prop is true', () => {
    render(<Select value="red" options={colorOptions} onChange={vi.fn()} disabled testId="sel" />)
    expect(screen.getByTestId('sel')).toBeDisabled()
  })

  it('is collapsed by default (no listbox in DOM)', () => {
    render(<Select value="red" options={colorOptions} onChange={vi.fn()} />)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows numeric label when value is numeric', () => {
    render(<Select value={30} options={numOptions} onChange={vi.fn()} testId="num" />)
    expect(screen.getByTestId('num')).toHaveTextContent('30 seconds')
  })

  it('falls back to String(value) when value is not in options', () => {
    render(
      <Select
        value={'unknown' as 'red'}
        options={colorOptions}
        onChange={vi.fn()}
        testId="sel"
      />,
    )
    expect(screen.getByTestId('sel')).toHaveTextContent('unknown')
  })

  it('mirrors the value as data-selected-value on the trigger', () => {
    const { rerender } = render(
      <Select value="red" options={colorOptions} onChange={vi.fn()} testId="sel" />,
    )
    expect(screen.getByTestId('sel')).toHaveAttribute('data-selected-value', 'red')
    rerender(<Select value="green" options={colorOptions} onChange={vi.fn()} testId="sel" />)
    expect(screen.getByTestId('sel')).toHaveAttribute('data-selected-value', 'green')
  })
})

describe('Select — accessibility passthrough', () => {
  it('passes ariaLabel to the trigger', () => {
    render(
      <Select
        value="red"
        options={colorOptions}
        onChange={vi.fn()}
        testId="sel"
        ariaLabel="Pick a color"
      />,
    )
    expect(screen.getByTestId('sel')).toHaveAttribute('aria-label', 'Pick a color')
  })

  it('passes labelledBy to the trigger', () => {
    render(
      <>
        <span id="my-label">Color</span>
        <Select
          value="red"
          options={colorOptions}
          onChange={vi.fn()}
          testId="sel"
          labelledBy="my-label"
        />
      </>,
    )
    expect(screen.getByTestId('sel')).toHaveAttribute('aria-labelledby', expect.stringContaining('my-label'))
  })
})

describe('Select — typeahead', () => {
  it('commits the first option starting with the pressed letter when closed', () => {
    const onChange = vi.fn()
    render(<Select value="red" options={colorOptions} onChange={onChange} testId="sel" />)
    fireEvent.keyDown(screen.getByTestId('sel'), { key: 'b' })
    expect(onChange).toHaveBeenCalledWith('blue')
  })

  it('is case-insensitive', () => {
    const onChange = vi.fn()
    render(<Select value="red" options={colorOptions} onChange={onChange} testId="sel" />)
    fireEvent.keyDown(screen.getByTestId('sel'), { key: 'G' })
    expect(onChange).toHaveBeenCalledWith('green')
  })

  it('does nothing when no option starts with the key', () => {
    const onChange = vi.fn()
    render(<Select value="red" options={colorOptions} onChange={onChange} testId="sel" />)
    fireEvent.keyDown(screen.getByTestId('sel'), { key: 'z' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Select — styling passthrough', () => {
  it('forwards className to the wrapper (so flex layouts on parent target the wrapper)', () => {
    render(
      <Select
        value="red"
        options={colorOptions}
        onChange={vi.fn()}
        testId="sel"
        className="extra-class"
      />,
    )
    const wrapper = screen.getByTestId('sel').parentElement!
    expect(wrapper.className).toContain('extra-class')
    expect(wrapper.className).toContain('mc-select')
    expect(screen.getByTestId('sel').className).toContain('mc-select__trigger')
  })

  it('forwards inline style to the wrapper', () => {
    render(
      <Select
        value="red"
        options={colorOptions}
        onChange={vi.fn()}
        testId="sel"
        style={{ width: 200 }}
      />,
    )
    const wrapper = screen.getByTestId('sel').parentElement!
    expect(wrapper).toHaveStyle({ width: '200px' })
  })
})
