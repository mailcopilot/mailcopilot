// @vitest-environment jsdom
/**
 * Unit tests for src/components/LinkWarningDialog.tsx
 *
 * Tests cover:
 *   - Renders link URL and warnings list
 *   - Renders optional link text section
 *   - Omits link text section when text is empty
 *   - "Cancel" button calls onCancel
 *   - "Open anyway" button calls onApprove
 *   - Clicking backdrop calls onCancel
 *   - Clicking dialog body does NOT call onCancel (stopPropagation)
 *   - ARIA attributes present (alertdialog, aria-modal, labelledby, describedby)
 *   - data-testid="link-open-anyway" present on approve button
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import LinkWarningDialog from './LinkWarningDialog'
import type { LinkPromptState } from '../hooks/useMailLinkClick'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'mail.links.title': 'This link looks suspicious',
      'mail.links.textLabel': 'Link text',
      'mail.links.cancel': 'Cancel',
      'mail.links.openAnyway': 'Open anyway',
    }[key] ?? key),
  }),
}))

vi.mock('lucide-react', () => ({
  ExternalLink: () => React.createElement('span', { 'data-testid': 'icon-external-link' }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePrompt(overrides: Partial<LinkPromptState> = {}): LinkPromptState {
  return {
    url: 'http://example.com/',
    text: 'example.com',
    warnings: ['The link uses http (not encrypted).'],
    ...overrides,
  }
}

function renderDialog(
  prompt = makePrompt(),
  onApprove = vi.fn(),
  onCancel = vi.fn(),
) {
  return render(
    React.createElement(LinkWarningDialog, { prompt, onApprove, onCancel }),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinkWarningDialog — content', () => {
  afterEach(() => { cleanup() })

  it('renders the link URL', () => {
    renderDialog()
    expect(document.querySelector('.link-prompt-url')?.textContent).toBe('http://example.com/')
  })

  it('renders the warnings list', () => {
    const prompt = makePrompt({ warnings: ['Warning A', 'Warning B'] })
    renderDialog(prompt)
    const items = document.querySelectorAll('.link-warnings li')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toBe('Warning A')
    expect(items[1].textContent).toBe('Warning B')
  })

  it('renders link text section when text is non-empty', () => {
    renderDialog(makePrompt({ text: 'paypal.com' }))
    expect(document.querySelector('.link-prompt-text')).toBeInTheDocument()
    expect(document.querySelector('.link-prompt-value')?.textContent).toBe('paypal.com')
  })

  it('omits link text section when text is empty string', () => {
    renderDialog(makePrompt({ text: '' }))
    expect(document.querySelector('.link-prompt-text')).not.toBeInTheDocument()
  })
})

describe('LinkWarningDialog — ARIA', () => {
  afterEach(() => { cleanup() })

  it('has role="alertdialog" and aria-modal="true"', () => {
    renderDialog()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog).toBeInTheDocument()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
  })

  it('has aria-labelledby="link-warning-title"', () => {
    renderDialog()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.getAttribute('aria-labelledby')).toBe('link-warning-title')
    expect(document.getElementById('link-warning-title')).toBeInTheDocument()
  })

  it('has aria-describedby="link-warning-desc"', () => {
    renderDialog()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.getAttribute('aria-describedby')).toBe('link-warning-desc')
    expect(document.getElementById('link-warning-desc')).toBeInTheDocument()
  })
})

describe('LinkWarningDialog — interactions', () => {
  afterEach(() => { cleanup() })

  it('"Cancel" button calls onCancel', () => {
    const onCancel = vi.fn()
    const onApprove = vi.fn()
    renderDialog(makePrompt(), onApprove, onCancel)
    const cancelBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.confirm-dialog-actions button'))
      .find(btn => btn.textContent?.includes('Cancel'))
    expect(cancelBtn).toBeInTheDocument()
    fireEvent.click(cancelBtn!)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('"Open anyway" button calls onApprove', () => {
    const onApprove = vi.fn()
    const onCancel = vi.fn()
    renderDialog(makePrompt(), onApprove, onCancel)
    const openBtn = document.querySelector<HTMLButtonElement>('[data-testid="link-open-anyway"]')
    expect(openBtn).toBeInTheDocument()
    fireEvent.click(openBtn!)
    expect(onApprove).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('clicking the backdrop (confirm-overlay) calls onCancel', () => {
    const onCancel = vi.fn()
    renderDialog(makePrompt(), vi.fn(), onCancel)
    const overlay = document.querySelector('.confirm-overlay')
    expect(overlay).toBeInTheDocument()
    fireEvent.click(overlay!)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('clicking the dialog body does NOT call onCancel (stopPropagation)', () => {
    const onCancel = vi.fn()
    renderDialog(makePrompt(), vi.fn(), onCancel)
    const dialog = document.querySelector('.confirm-dialog')
    expect(dialog).toBeInTheDocument()
    fireEvent.click(dialog!)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('data-testid="link-open-anyway" is present on the approve button', () => {
    renderDialog()
    expect(document.querySelector('[data-testid="link-open-anyway"]')).toBeInTheDocument()
  })
})
