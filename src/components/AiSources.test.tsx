// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { CitationStatus } from '../utils/aiSourceVerdict'

const i18nMap: Record<string, string> = {
  'ai.panel.sources': 'Sources',
  'ai.panel.sourcesShowAll': 'All sources ({{count}})',
  'ai.panel.sourcesCollapse': 'Collapse',
  'ai.panel.sourceNotFound': 'message not found',
  'ai.panel.sourceNoSubject': 'no subject',
}
const stableT = (key: string, opts?: Record<string, unknown>) =>
  (i18nMap[key] ?? key).replace('{{count}}', String(opts?.count))
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({ useTranslation: () => stableUseTranslation }))

import AiSources from './AiSources'

const found = (n: number): Extract<CitationStatus, { status: 'found' }> =>
  ({ token: `t${n}`, status: 'found', subject: `Subject ${n}`, from: `f${n}@example.test`, date: 'd' })
const many = (n: number) => Array.from({ length: n }, (_, i) => found(i + 1))
const rows = () => document.querySelectorAll('.ai-source-link')

afterEach(() => cleanup())

describe('AiSources', () => {
  it.each([1, 3])('lists %i sources in full with no toggle', (n) => {
    render(<AiSources cited={many(n)} onOpen={vi.fn()} />)
    expect(rows()).toHaveLength(n)
    expect(screen.queryByTestId('ai-sources-toggle')).toBeNull()
  })

  it('collapses to the first three above three, keeping the original numbers', () => {
    render(<AiSources cited={many(50)} onOpen={vi.fn()} />)
    expect(rows()).toHaveLength(3)
    expect(rows()[2]).toHaveTextContent('#3')
    const toggle = screen.getByTestId('ai-sources-toggle')
    expect(toggle).toHaveTextContent('All sources (50)')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('four sources are already collapsed', () => {
    render(<AiSources cited={many(4)} onOpen={vi.fn()} />)
    expect(rows()).toHaveLength(3)
    expect(screen.getByTestId('ai-sources-toggle')).toHaveTextContent('All sources (4)')
  })

  it('expands to the full list ending with Collapse, and collapses again', () => {
    render(<AiSources cited={many(5)} onOpen={vi.fn()} />)
    const toggle = screen.getByTestId('ai-sources-toggle')
    fireEvent.click(toggle)
    expect(rows()).toHaveLength(5)
    expect(toggle).toHaveTextContent('Collapse')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // The toggle is the last thing in the list: it ends the expanded list.
    expect(toggle.previousElementSibling).toBe(rows()[4])
    fireEvent.click(toggle)
    expect(rows()).toHaveLength(3)
    expect(toggle).toHaveTextContent('All sources (5)')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('the toggle is a real button, reachable by keyboard, and names the list it controls', () => {
    render(<AiSources cited={many(5)} onOpen={vi.fn()} />)
    const toggle = screen.getByTestId('ai-sources-toggle')
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle).toHaveAttribute('type', 'button')
    expect(toggle).not.toHaveAttribute('tabindex', '-1')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(document.querySelector('.ai-sources-list'))
  })

  it('opens a source in either state', () => {
    const onOpen = vi.fn()
    render(<AiSources cited={many(5)} onOpen={onOpen} />)
    fireEvent.click(rows()[0])
    fireEvent.click(screen.getByTestId('ai-sources-toggle'))
    fireEvent.click(rows()[4])
    expect(onOpen.mock.calls).toEqual([['t1'], ['t5']])
  })

  it('each answer keeps its own state', () => {
    render(<><AiSources cited={many(5)} onOpen={vi.fn()} /><AiSources cited={many(5)} onOpen={vi.fn()} /></>)
    fireEvent.click(screen.getAllByTestId('ai-sources-toggle')[0])
    expect(rows()).toHaveLength(5 + 3)
  })

  it('a missing message keeps its caption and stays marked disabled', () => {
    render(<AiSources cited={[{ token: 'g', status: 'missing' }]} onOpen={vi.fn()} />)
    expect(rows()[0]).toHaveTextContent('message not found')
    expect(rows()[0]).toHaveAttribute('aria-disabled', 'true')
  })
})
