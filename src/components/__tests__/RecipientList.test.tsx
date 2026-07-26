// @vitest-environment jsdom
/**
 * §3.3.C-uiaudit.22 — RecipientList unit tests.
 *
 * Covers:
 *   - Render with 0, 1, 3, 4, 10 addresses
 *   - "+N more" button shown/hidden correctly
 *   - Single recipient: no "+0 more" button rendered
 *   - Expand / collapse toggle
 *   - BCC isSentByMe gate in MailBodyContent integration
 *   - Keyboard: Enter/Space on "+N more" toggles; Esc collapses
 *   - data-tooltip attribute on chips
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { MailAddress } from '../../../packages/types'

// ---- i18n stub ---------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'mail.recipients.moreCount': '+{{count}} more',
  'mail.headers.to': 'To',
  'mail.headers.cc': 'Cc',
  'mail.headers.bcc': 'Bcc',
  'mail.headers.date': 'Date',
  'app.empty.loadingMessage.title': 'Loading…',
  'app.errors.bodyNotAvailableOffline': 'Body not available offline',
  'mail.actions.retry': 'Retry',
  'app.empty.messageNotFound.title': 'Message not found',
  'mail.privacy.imagesBlocked': 'Images blocked',
  'mail.privacy.showImages': 'Show images',
}

const stableT = (key: string, opts?: Record<string, unknown>): string => {
  let text = i18nMap[key] ?? key
  if (opts && typeof opts === 'object') {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
    }
  }
  return text
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: stableT,
    i18n: { language: 'en-US' },
  }),
}))

// ---- useTooltipDelegation stub -----------------------------------------------
vi.mock('../../hooks/useTooltipDelegation', () => ({
  useTooltipDelegation: () => ({
    tooltipState: null,
    containerRef: vi.fn(),
    handleMouseOver: vi.fn(),
    handleMouseOut: vi.fn(),
  }),
}))

// ---- window.api stub (required by MailBodyContent internals) -----------------
Object.defineProperty(window, 'api', {
  value: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

// ---- import after mocks ------------------------------------------------------
import RecipientList from '../RecipientList'
import MailBodyContent, { type MailBodyContentProps } from '../MailBodyContent'
import type { MailSummary, MessageDetails } from '../../../packages/net/types'

// ---- helpers -----------------------------------------------------------------

function makeAddr(name: string, address: string): MailAddress {
  return { name, address }
}

function makeAddresses(count: number): MailAddress[] {
  return Array.from({ length: count }, (_, i) =>
    makeAddr(`User ${i + 1}`, `user${i + 1}@example.test`),
  )
}

function makeMailSummary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    accountId: 1,
    folder: 'INBOX',
    uid: 42,
    from: 'Sender <sender@example.test>',
    subject: 'Test Subject',
    date: '2026-06-15T10:00:00Z',
    unread: false,
    flagged: false,
    ...overrides,
  }
}

function makeDetails(overrides: Partial<MessageDetails> = {}): MessageDetails {
  return {
    uid: 42,
    text: 'Plain text body.',
    ...overrides,
  }
}

function makeProps(overrides: Partial<MailBodyContentProps> = {}): MailBodyContentProps {
  return {
    active: makeMailSummary(),
    details: makeDetails(),
    identities: ['user@example.test'],
    loadingBody: false,
    metaTo: [],
    metaCc: [],
    metaDate: 'June 15, 2026',
    mailHasExternalImages: false,
    alwaysLoadImages: false,
    showExternalImages: false,
    mailIframeDoc: null,
    iframeKey: 'key-1',
    mailIframeRef: { current: null },
    activeMailKey: '1:INBOX:42',
    savingAttachment: null,
    onShowExternalImages: vi.fn(),
    onRetry: vi.fn(),
    onDownloadAttachment: vi.fn(),
    ...overrides,
  }
}

// ── RecipientList unit tests ────────────────────────────────────────────────

describe('RecipientList', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing when addresses is empty', () => {
    const { container } = render(<RecipientList addresses={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a single address with no "+N more" button', () => {
    const addrs = makeAddresses(1)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    expect(screen.getByText('User 1')).toBeInTheDocument()
    // No expand button for a single recipient (no overflow)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders exactly maxVisible chips and no button when count equals maxVisible', () => {
    const addrs = makeAddresses(3)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    expect(screen.getByText('User 1')).toBeInTheDocument()
    expect(screen.getByText('User 2')).toBeInTheDocument()
    expect(screen.getByText('User 3')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows "+N more" button when addresses.length > maxVisible', () => {
    const addrs = makeAddresses(4)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    // Only first 3 visible initially
    expect(screen.getByText('User 1')).toBeInTheDocument()
    expect(screen.getByText('User 2')).toBeInTheDocument()
    expect(screen.getByText('User 3')).toBeInTheDocument()
    expect(screen.queryByText('User 4')).not.toBeInTheDocument()

    // Button shows +1 more
    const btn = screen.getByRole('button', { name: '+1 more' })
    expect(btn).toBeInTheDocument()
    expect(btn.tagName).toBe('BUTTON')
  })

  it('expands to show all addresses on button click', () => {
    const addrs = makeAddresses(4)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    const btn = screen.getByRole('button', { name: '+1 more' })
    fireEvent.click(btn)

    // All 4 now visible
    expect(screen.getByText('User 4')).toBeInTheDocument()
    // Collapse button still shows the same count label
    expect(screen.getByRole('button', { name: '+1 more' })).toBeInTheDocument()
  })

  it('collapses back on second click', () => {
    const addrs = makeAddresses(4)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    const btn = screen.getByRole('button', { name: '+1 more' })
    fireEvent.click(btn) // expand
    fireEvent.click(screen.getByRole('button', { name: '+1 more' })) // collapse

    expect(screen.queryByText('User 4')).not.toBeInTheDocument()
  })

  it('shows correct overflow count for 10 addresses', () => {
    const addrs = makeAddresses(10)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    const btn = screen.getByRole('button', { name: '+7 more' })
    expect(btn).toBeInTheDocument()
  })

  it('collapses on Escape key when expanded', () => {
    const addrs = makeAddresses(5)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    fireEvent.click(screen.getByRole('button', { name: '+2 more' }))
    // All visible
    expect(screen.getByText('User 5')).toBeInTheDocument()

    // Press Escape on the wrapper
    const wrapper = screen.getByRole('button', { name: '+2 more' }).closest('.recipient-list')!
    fireEvent.keyDown(wrapper, { key: 'Escape' })

    expect(screen.queryByText('User 5')).not.toBeInTheDocument()
  })

  it('toggles expand on Enter key on the more button', () => {
    const addrs = makeAddresses(4)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    const btn = screen.getByRole('button', { name: '+1 more' })
    fireEvent.keyDown(btn, { key: 'Enter' })

    expect(screen.getByText('User 4')).toBeInTheDocument()
  })

  it('toggles expand on Space key on the more button', () => {
    const addrs = makeAddresses(4)
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    const btn = screen.getByRole('button', { name: '+1 more' })
    fireEvent.keyDown(btn, { key: ' ' })

    expect(screen.getByText('User 4')).toBeInTheDocument()
  })

  it('renders data-tooltip on each chip', () => {
    const addrs = [makeAddr('Alice Smith', 'alice@example.test')]
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    const chip = screen.getByText('Alice Smith')
    expect(chip).toHaveAttribute('data-tooltip', 'Alice Smith <alice@example.test>')
  })

  it('renders email as tooltip when name is absent', () => {
    const addrs: MailAddress[] = [{ address: 'bob@example.test' }]
    render(<RecipientList addresses={addrs} maxVisible={3} />)

    const chip = screen.getByText('bob@example.test')
    expect(chip).toHaveAttribute('data-tooltip', 'bob@example.test')
  })

})

  it('"+N more" button has aria-expanded=false when collapsed', () => {
    const addrs = makeAddresses(5)
    const { container } = render(<RecipientList addresses={addrs} maxVisible={3} />)

    const btn = container.querySelector('[data-testid="recipient-more-btn"]')!
    expect(btn).toHaveAttribute('aria-expanded', 'false')
  })

  it('"+N more" button has aria-expanded=true when expanded', () => {
    const addrs = makeAddresses(5)
    const { container } = render(<RecipientList addresses={addrs} maxVisible={3} />)

    const btn = container.querySelector('[data-testid="recipient-more-btn"]')!
    fireEvent.click(btn)

    expect(container.querySelector('[data-testid="recipient-more-btn"]')).toHaveAttribute('aria-expanded', 'true')
  })

  it('renders data-testid="recipient-list" on wrapper', () => {
    const { container } = render(<RecipientList addresses={makeAddresses(2)} />)
    expect(container.querySelector('[data-testid="recipient-list"]')).toBeInTheDocument()
  })

  it('renders data-testid="recipient-chip" on each visible chip', () => {
    const { container } = render(<RecipientList addresses={makeAddresses(3)} maxVisible={3} />)
    const chips = container.querySelectorAll('[data-testid="recipient-chip"]')
    expect(chips).toHaveLength(3)
  })

  it('renders data-testid="recipient-more-btn" on overflow button', () => {
    const { container } = render(<RecipientList addresses={makeAddresses(5)} maxVisible={3} />)
    expect(container.querySelector('[data-testid="recipient-more-btn"]')).toBeInTheDocument()
  })

  it('moreCount label interpolates count=1 correctly', () => {
    // en stub: "+{{count}} more" → "+1 more"
    const { container } = render(<RecipientList addresses={makeAddresses(4)} maxVisible={3} />)
    expect(container.querySelector('[data-testid="recipient-more-btn"]')).toHaveTextContent('+1 more')
  })

  it('moreCount label interpolates count=7 correctly', () => {
    // en stub: "+{{count}} more" → "+7 more"
    const { container } = render(<RecipientList addresses={makeAddresses(10)} maxVisible={3} />)
    expect(container.querySelector('[data-testid="recipient-more-btn"]')).toHaveTextContent('+7 more')
  })

  it('shows all chips after expand when there are many addresses', () => {
    const addrs = makeAddresses(10)
    const { container } = render(<RecipientList addresses={addrs} maxVisible={3} />)

    // Initially 3 chips
    expect(container.querySelectorAll('[data-testid="recipient-chip"]')).toHaveLength(3)

    const btn = container.querySelector('[data-testid="recipient-more-btn"]')!
    fireEvent.click(btn)

    // All 10 chips now visible
    expect(container.querySelectorAll('[data-testid="recipient-chip"]')).toHaveLength(10)
  })

  it('returns null for a zero-length addresses array (renders nothing)', () => {
    const { container } = render(<RecipientList addresses={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('handles address object with no name and no address (empty object)', () => {
    // addrDisplayName({}) returns "" — chip renders empty text, no crash
    const addrs: MailAddress[] = [{}]
    const { container } = render(<RecipientList addresses={addrs} maxVisible={3} />)
    // No throw; data-tooltip is undefined for empty address (addrTooltip({}) === "")
    const chip = container.querySelector('[data-testid="recipient-chip"]')
    expect(chip).toBeInTheDocument()
    // addrTooltip({}) returns "" → RecipientList passes undefined (falsy guard) → no attribute
    expect(chip).not.toHaveAttribute('data-tooltip')
  })

  it('does not render overflow button when exactly maxVisible addresses present', () => {
    // Boundary: count === maxVisible → overflow = 0 → no button
    const { container } = render(<RecipientList addresses={makeAddresses(3)} maxVisible={3} />)
    expect(container.querySelector('[data-testid="recipient-more-btn"]')).not.toBeInTheDocument()
  })

  it('does not render overflow button when count is one less than maxVisible', () => {
    const { container } = render(<RecipientList addresses={makeAddresses(2)} maxVisible={3} />)
    expect(container.querySelector('[data-testid="recipient-more-btn"]')).not.toBeInTheDocument()
  })

  it('Escape key does NOT collapse when list is already collapsed', () => {
    const addrs = makeAddresses(5)
    const { container } = render(<RecipientList addresses={addrs} maxVisible={3} />)

    // Don't expand — press Escape on wrapper while collapsed
    const wrapper = container.querySelector('.recipient-list')!
    fireEvent.keyDown(wrapper, { key: 'Escape' })

    // Nothing changes — button still there, hidden user still absent
    expect(container.querySelector('[data-testid="recipient-more-btn"]')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-testid="recipient-chip"]')).toHaveLength(3)
  })

// ── MailBodyContent BCC isSentByMe gate ─────────────────────────────────────

describe('MailBodyContent — BCC isSentByMe gate', () => {
  afterEach(() => {
    cleanup()
  })

  it('does not render BCC row when isSentByMe is false', () => {
    const bcc = makeAddresses(2)
    const props = makeProps({ metaBcc: bcc, isSentByMe: false })
    render(<MailBodyContent {...props} />)

    expect(screen.queryByText('Bcc')).not.toBeInTheDocument()
  })

  it('does not render BCC row when isSentByMe is undefined', () => {
    const bcc = makeAddresses(2)
    const props = makeProps({ metaBcc: bcc, isSentByMe: undefined })
    render(<MailBodyContent {...props} />)

    expect(screen.queryByText('Bcc')).not.toBeInTheDocument()
  })

  it('renders BCC row when isSentByMe is true and bcc is non-empty', () => {
    const bcc = makeAddresses(2)
    const props = makeProps({ metaBcc: bcc, isSentByMe: true })
    render(<MailBodyContent {...props} />)

    expect(screen.getByText('Bcc')).toBeInTheDocument()
  })

  it('does not render BCC row when isSentByMe is true but bcc is empty', () => {
    const props = makeProps({ metaBcc: [], isSentByMe: true })
    render(<MailBodyContent {...props} />)

    expect(screen.queryByText('Bcc')).not.toBeInTheDocument()
  })

  it('does not render BCC row when isSentByMe is true but metaBcc is undefined', () => {
    const props = makeProps({ metaBcc: undefined, isSentByMe: true })
    render(<MailBodyContent {...props} />)

    expect(screen.queryByText('Bcc')).not.toBeInTheDocument()
  })

  it('renders To row with RecipientList chips when metaTo is non-empty', () => {
    const toAddrs = makeAddresses(2)
    const props = makeProps({ metaTo: toAddrs })
    render(<MailBodyContent {...props} />)

    expect(screen.getByText('To')).toBeInTheDocument()
    expect(screen.getByText('User 1')).toBeInTheDocument()
    expect(screen.getByText('User 2')).toBeInTheDocument()
  })

  it('does not render To row when metaTo is empty', () => {
    const props = makeProps({ metaTo: [] })
    render(<MailBodyContent {...props} />)

    expect(screen.queryByText('To')).not.toBeInTheDocument()
  })
})
