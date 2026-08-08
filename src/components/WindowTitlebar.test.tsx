// @vitest-environment jsdom
/**
 * Unit tests for src/components/WindowTitlebar.tsx.
 *
 * Every window in this app is frameless (`frame: false` in electron/main.ts),
 * so this component is the only thing that makes a window draggable and the
 * only visible way to close it. The tests therefore assert the two structural
 * properties that carry that behaviour — and assert them against src/App.css,
 * not against a hardcoded class name: `-webkit-app-region` has no effect in
 * jsdom, so a test that only checked `className` would keep passing after
 * someone dropped the rule from the stylesheet.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Stable i18n mock — returns the key so label assertions read as "this control
// is labelled from i18n", not as a check on the English wording. The component's
// `defaultValue` fallbacks are deliberately ignored here; that the keys actually
// exist in all six locales is asserted in the i18n block below.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const mockInvoke = vi.fn()
const eventHandlers = new Map<string, (payload: unknown) => void>()
Object.defineProperty(window, 'api', {
  value: {
    invoke: mockInvoke,
    on: vi.fn((channel: string, handler: (payload: unknown) => void) => { eventHandlers.set(channel, handler) }),
    off: vi.fn((channel: string) => { eventHandlers.delete(channel) }),
  },
  writable: true,
  configurable: true,
})

const mockWindowClose = vi.fn()
Object.defineProperty(window, 'close', { value: mockWindowClose, writable: true, configurable: true })

import WindowTitlebar from './WindowTitlebar'
import enLocale from '../i18n/locales/en.json'
import ruLocale from '../i18n/locales/ru.json'
import frLocale from '../i18n/locales/fr.json'
import deLocale from '../i18n/locales/de.json'
import esLocale from '../i18n/locales/es.json'
import itLocale from '../i18n/locales/it.json'

const APP_CSS = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf8')

/** Body of the first rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
  const match = new RegExp(`(^|[,}])\\s*\\${selector}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm').exec(APP_CSS)
  return match?.[3] ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  eventHandlers.clear()
  mockInvoke.mockResolvedValue(false)
})
afterEach(() => { cleanup() })

describe('WindowTitlebar — window chrome for frameless windows', () => {
  it('renders a drag region: the root carries the class App.css declares as draggable', async () => {
    await act(async () => { render(<WindowTitlebar title="Compose" />) })
    const bar = screen.getByTestId('window-titlebar')

    expect(bar).toHaveClass('child-titlebar')
    expect(ruleBody('.child-titlebar')).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('keeps the buttons out of the drag region (otherwise they cannot be clicked)', async () => {
    await act(async () => { render(<WindowTitlebar title="Compose" />) })
    const controls = screen.getByTestId('window-titlebar-close').parentElement

    expect(controls).toHaveClass('titlebar-controls')
    expect(ruleBody('.titlebar-controls')).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('shows the title', async () => {
    await act(async () => { render(<WindowTitlebar title="Quarterly report" />) })
    expect(document.querySelector('.child-titlebar-title')).toHaveTextContent('Quarterly report')
  })

  it('minimizes and maximizes through the whitelisted IPC channels', async () => {
    await act(async () => { render(<WindowTitlebar title="Compose" />) })

    fireEvent.click(screen.getByTestId('window-titlebar-minimize'))
    expect(mockInvoke).toHaveBeenCalledWith('win:minimize')

    fireEvent.click(screen.getByTestId('window-titlebar-maximize'))
    expect(mockInvoke).toHaveBeenCalledWith('win:maximize')
  })

  it('closes the window by default', async () => {
    await act(async () => { render(<WindowTitlebar title="Compose" />) })
    fireEvent.click(screen.getByTestId('window-titlebar-close'))
    expect(mockWindowClose).toHaveBeenCalledTimes(1)
  })

  it('uses the caller close handler instead of window.close when given one', async () => {
    const onClose = vi.fn()
    await act(async () => { render(<WindowTitlebar title="Compose" onClose={onClose} />) })

    fireEvent.click(screen.getByTestId('window-titlebar-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mockWindowClose).not.toHaveBeenCalled()
  })

  it('labels every control (frameless windows have no OS tooltips to fall back on)', async () => {
    await act(async () => { render(<WindowTitlebar title="Compose" />) })
    for (const id of ['minimize', 'maximize', 'close']) {
      const btn = screen.getByTestId(`window-titlebar-${id}`)
      expect(btn.getAttribute('aria-label')).toBeTruthy()
      expect(btn.getAttribute('title')).toBe(btn.getAttribute('aria-label'))
    }
  })

  it('switches the middle control to "restore" while the window is maximized', async () => {
    await act(async () => { render(<WindowTitlebar title="Compose" />) })
    expect(screen.getByTestId('window-titlebar-maximize')).toHaveAttribute('aria-label', 'window.maximize')

    await act(async () => { eventHandlers.get('win:maximizeChanged')?.(true) })
    expect(screen.getByTestId('window-titlebar-maximize')).toHaveAttribute('aria-label', 'window.restore')
  })

  it('accepts an extra class and a custom test id without dropping the drag class', async () => {
    await act(async () => {
      render(<WindowTitlebar title="Consent" className="child-titlebar-overlay" testId="custom-bar" />)
    })
    const bar = screen.getByTestId('custom-bar')
    expect(bar).toHaveClass('child-titlebar')
    expect(bar).toHaveClass('child-titlebar-overlay')
  })
})

describe('WindowTitlebar — i18n', () => {
  const LOCALES: Array<[string, Record<string, unknown>]> = [
    ['en', enLocale as unknown as Record<string, unknown>],
    ['ru', ruLocale as unknown as Record<string, unknown>],
    ['fr', frLocale as unknown as Record<string, unknown>],
    ['de', deLocale as unknown as Record<string, unknown>],
    ['es', esLocale as unknown as Record<string, unknown>],
    ['it', itLocale as unknown as Record<string, unknown>],
  ]

  it.each(LOCALES)('%s translates every window control label', (_lang, locale) => {
    const block = locale.window as Record<string, unknown>
    expect(block).toBeTruthy()
    for (const key of ['minimize', 'maximize', 'restore', 'close']) {
      const value = block[key]
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
      expect(value as string).not.toMatch(/TODO|FIXME|__/)
    }
  })
})
