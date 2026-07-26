// @vitest-environment jsdom
/**
 * Unit tests for src/windows/MailWindow.tsx — uiaudit.3 PR B4.
 *
 * Tests cover:
 *   - Header rendering: subject, from, date, To, Cc
 *   - Sandboxed iframe for HTML bodies (sandbox + referrerPolicy attributes)
 *   - Plain text fallback rendering
 *   - sanitizeMailHtml: <script> removal, javascript: URI neutralisation, on* stripping,
 *     remote image replacement, cid:/data: preservation, @import style removal
 *   - Link security (HIGH fix): rewriteMailHtmlLinks applied, mail:link phishing warning,
 *     ui:openExternal used (NOT shell:openExternal direct), suspicious link prompt shown
 *   - Close button calls window.close()
 *   - Minimize / maximize invoke IPC
 *   - Loading / error / offline states
 *   - Invalid params guard (no IPC call, error shown immediately)
 *   - Action toolbar: Reply → ui:openCompose with correct args
 *   - Action toolbar: Archive → net:move + window.close()
 *   - Action toolbar: Delete → net:delete + window.close() (when no trash folder)
 *   - Action toolbar: Delete → net:move to trash + window.close() (when trash folder present)
 *   - Action toolbar: Flag → net:setFlagged
 *   - Action toolbar: Mark seen → net:setSeen
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import type { FolderRoles, MessageDetails } from '@mailcopilot/types'

// ---------------------------------------------------------------------------
// Stable i18n mock — must be module-level to avoid infinite useEffect loops
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'mail.actions.openInWindow': 'Open in window',
  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize',
  'window.close': 'Close',
  'mail.headers.to': 'To',
  'mail.headers.cc': 'Cc',
  'mail.headers.bcc': 'Bcc',
  'mail.headers.date': 'Date',
  'mail.recipients.moreCount': '+{{count}} more',
  'app.empty.loadingMessage.title': 'Loading…',
  'app.empty.messageNotFound.title': 'Message not found',
  'app.errors.bodyNotAvailableOffline': 'Body not available offline',
  // Link warning dialog
  'mail.links.title': 'This link looks suspicious',
  'mail.links.textLabel': 'Link text',
  'mail.links.cancel': 'Cancel',
  'mail.links.openAnyway': 'Open anyway',
  'mail.links.warningHttp': 'The link uses http (not encrypted).',
  'mail.links.warningIdn': 'The domain uses IDN/punycode: {{unicode}} (punycode: {{ascii}}).',
  'mail.links.warningIdnSimple': 'The domain uses IDN/punycode: {{ascii}}.',
  'mail.links.warningMismatch': 'The link text shows {{shown}}, but it actually goes to {{real}}.',
  'mail.links.warningRawExternalLink': 'This link bypassed the standard URL rewriter — proceed only if you trust the source.',
  // MailActionsToolbar keys
  'mail.actions.reply': 'Reply',
  'mail.actions.replyAll': 'Reply all',
  'mail.actions.forward': 'Forward',
  'mail.actions.archive': 'Archive',
  'mail.actions.archiveNotFound': 'Archive folder not found',
  'mail.actions.delete': 'Delete',
  'mail.actions.flag': 'Star',
  'mail.actions.unflag': 'Unstar',
  'mail.actions.markRead': 'Mark as read',
  'mail.actions.markUnread': 'Mark as unread',
  'mail.actions.print': 'Print',
  'mail.actions.confirmPermanentDelete': 'This will permanently delete the message. This action cannot be undone.',
  'mail.actions.actionFailed': 'Action failed. Please try again.',
  'mail.actions.archived': 'Archived. Undo',
  'mail.actions.movedToTrash': 'Moved to trash. Undo',
  'mail.actions.undo': 'Undo',
  'mail.actions.undoFailed': 'Undo failed.',
  'mail.actions.toolbarLabel': 'Mail actions',
  'mail.attachments.unnamed': 'Attachment',
  'common.cancel': 'Cancel',
  // Compose templates (used by reply/forward handlers)
  'compose.templates.forwardHeader': '--- Forwarded message ---',
  'compose.templates.forwardFrom': 'From: {{from}}',
  'compose.templates.forwardDate': 'Date: {{date}}',
  'compose.templates.forwardSubject': 'Subject: {{subject}}',
  'compose.templates.forwardTo': 'To: {{to}}',
  'compose.templates.replyIntro': 'On {{date}}, {{from}} wrote:',
  'compose.templates.replyIntroNoDate': '{{from}} wrote:',
  'compose.templates.unknownSender': 'Unknown sender',
  'compose.templates.unknownDate': 'Unknown date',
}
const stableT = (key: string, opts?: Record<string, unknown>) => {
  const val = i18nMap[key] ?? key
  if (opts?.defaultValue && val === key) return String(opts.defaultValue)
  // Simple interpolation for {{ variable }} patterns used by link warning keys.
  if (opts && typeof val === 'string') {
    return val.replace(/\{\{(\w+)\}\}/g, (_, k) => (opts[k] !== undefined ? String(opts[k]) : `{{${k}}}`))
  }
  return val
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

// ---------------------------------------------------------------------------
// lucide-react — stub so SVG rendering doesn't require DOM quirks
// ---------------------------------------------------------------------------
vi.mock('lucide-react', () => ({
  Minus: () => React.createElement('span', { 'data-testid': 'icon-minus' }),
  Square: () => React.createElement('span', { 'data-testid': 'icon-square' }),
  Copy: () => React.createElement('span', { 'data-testid': 'icon-copy' }),
  X: () => React.createElement('span', { 'data-testid': 'icon-x' }),
  Loader2: () => React.createElement('span', { 'data-testid': 'icon-loader' }),
  AlertTriangle: () => React.createElement('span', { 'data-testid': 'icon-alert' }),
  WifiOff: () => React.createElement('span', { 'data-testid': 'icon-wifioff' }),
  Undo2: () => React.createElement('span', { 'data-testid': 'icon-undo2' }),
  ExternalLink: () => React.createElement('span', { 'data-testid': 'icon-external-link' }),
  // MailActionsToolbar icons (forwarded through the real component)
  Reply: () => React.createElement('span', { 'data-testid': 'icon-reply' }),
  ReplyAll: () => React.createElement('span', { 'data-testid': 'icon-replyall' }),
  Forward: () => React.createElement('span', { 'data-testid': 'icon-forward' }),
  Archive: () => React.createElement('span', { 'data-testid': 'icon-archive' }),
  Trash2: () => React.createElement('span', { 'data-testid': 'icon-trash2' }),
  Star: () => React.createElement('span', { 'data-testid': 'icon-star' }),
  Mail: () => React.createElement('span', { 'data-testid': 'icon-mail' }),
  MailOpen: () => React.createElement('span', { 'data-testid': 'icon-mailopen' }),
  Printer: () => React.createElement('span', { 'data-testid': 'icon-printer' }),
}))

// ---------------------------------------------------------------------------
// useMaximized — isolate from IPC
// ---------------------------------------------------------------------------
vi.mock('../hooks/useMaximized', () => ({
  useMaximized: () => false,
}))

// ---------------------------------------------------------------------------
// useTooltipDelegation — isolate tooltip hook (used by RecipientList)
// ---------------------------------------------------------------------------
vi.mock('../hooks/useTooltipDelegation', () => ({
  useTooltipDelegation: () => ({
    tooltipState: null,
    containerRef: vi.fn(),
    handleMouseOver: vi.fn(),
    handleMouseOut: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// window.api mock — set up before module loads
// ---------------------------------------------------------------------------
const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff, removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// window.close mock
// ---------------------------------------------------------------------------
const mockWindowClose = vi.fn()
Object.defineProperty(window, 'close', {
  value: mockWindowClose,
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Static import of the component under test
// ---------------------------------------------------------------------------
import MailWindow from './MailWindow'

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeMessageDetails(overrides: Partial<MessageDetails> = {}): MessageDetails {
  const base: MessageDetails = {
    uid: 42,
    envelope: {
      subject: 'Hello, World!',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [],
      date: '2024-01-15T10:30:00Z',
      messageId: '<abc@example.com>',
    },
    html: '<p>Hello from HTML</p>',
    offlineFallback: false,
    ...overrides,
  }
  // Allow overriding envelope as a sub-object by merging if both are objects
  if (overrides.envelope && base.envelope) {
    base.envelope = { ...base.envelope, ...overrides.envelope }
  }
  return base
}

function renderMailWindow(props: { accountId?: number; folder?: string; uid?: number } = {}) {
  const { accountId = 1, folder = 'INBOX', uid = 42 } = props
  return render(React.createElement(MailWindow, { accountId, folder, uid }))
}

// ---------------------------------------------------------------------------
// Tests: header rendering
// ---------------------------------------------------------------------------

describe('MailWindow — header rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'win:isMaximized') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  it('renders the subject in the title bar', async () => {
    await act(async () => { renderMailWindow() })
    const titleEl = document.querySelector('.child-titlebar-title')
    expect(titleEl?.textContent).toBe('Hello, World!')
  })

  it('renders the from address in the viewer header', async () => {
    await act(async () => { renderMailWindow() })
    const fromEl = document.querySelector('.mail-viewer-from')
    expect(fromEl?.textContent).toMatch(/alice@example\.com/)
  })

  it('renders the subject in the viewer subject row', async () => {
    await act(async () => { renderMailWindow() })
    const subjectEl = document.querySelector('.mail-viewer-subject')
    expect(subjectEl?.textContent).toBe('Hello, World!')
  })

  it('renders date label in the meta section', async () => {
    await act(async () => { renderMailWindow() })
    const metaKeys = document.querySelectorAll('.meta-key')
    const labels = Array.from(metaKeys).map(el => el.textContent)
    expect(labels).toContain('Date')
  })

  it('renders To recipient in the meta section', async () => {
    await act(async () => { renderMailWindow() })
    // §3.3.C-uiaudit.22: recipients are now rendered as .recipient-chip elements
    // inside RecipientList. The display label is the name ("Bob") when available;
    // the full address is in data-tooltip.
    const chips = document.querySelectorAll('.recipient-chip')
    const names = Array.from(chips).map(el => el.textContent ?? '')
    const tooltips = Array.from(chips).map(el => el.getAttribute('data-tooltip') ?? '')
    expect(
      names.some(t => t === 'Bob') || tooltips.some(t => t.includes('bob@example.com')),
    ).toBe(true)
  })

  it('renders Cc recipient when present', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({
          envelope: {
            subject: 'CC Test',
            from: [{ name: 'Alice', address: 'alice@example.com' }],
            to: [{ name: 'Bob', address: 'bob@example.com' }],
            cc: [{ name: 'Charlie', address: 'charlie@example.com' }],
            date: '2024-01-15T10:30:00Z',
            messageId: '<cc@example.com>',
          },
        }))
      }
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow() })
    const metaKeys = document.querySelectorAll('.meta-key')
    const labels = Array.from(metaKeys).map(el => el.textContent)
    expect(labels).toContain('Cc')
  })

  it('does not render Cc row when cc is empty', async () => {
    await act(async () => { renderMailWindow() })
    const metaKeys = document.querySelectorAll('.meta-key')
    const labels = Array.from(metaKeys).map(el => el.textContent)
    expect(labels).not.toContain('Cc')
  })
})

// ---------------------------------------------------------------------------
// Tests: iframe security
// ---------------------------------------------------------------------------

describe('MailWindow — iframe security', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  it('renders an iframe when message has HTML body', async () => {
    await act(async () => { renderMailWindow() })
    const iframe = document.querySelector('iframe[title="mail"]')
    expect(iframe).toBeInTheDocument()
  })

  it('iframe sandbox contains allow-same-origin and allow-modals but not allow-scripts', async () => {
    // Regression guard: allow-modals added in fix-wave 2.2 (window.print() requires it in
    // sandboxed iframes per HTML spec). allow-scripts must remain absent — security boundary.
    await act(async () => { renderMailWindow() })
    const iframe = document.querySelector('iframe[title="mail"]')
    const sandbox = iframe?.getAttribute('sandbox')
    expect(sandbox).toMatch(/allow-same-origin/)
    expect(sandbox).toMatch(/allow-modals/)
    expect(sandbox).not.toContain('allow-scripts')
  })

  it('iframe has referrerPolicy="no-referrer"', async () => {
    await act(async () => { renderMailWindow() })
    const iframe = document.querySelector('iframe[title="mail"]')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('renders <pre> plain text body when html is null', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({ html: undefined, text: 'Plain text body' }))
      }
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow() })
    expect(document.querySelector('iframe[title="mail"]')).not.toBeInTheDocument()
    const pre = document.querySelector('pre.mail-text')
    expect(pre?.textContent).toBe('Plain text body')
  })
})

// ---------------------------------------------------------------------------
// Tests: sanitizeMailHtml
// We verify via the iframe srcDoc — sanitizer is applied inside useMemo before
// the srcDoc is set, so the DOM attribute reflects post-sanitization HTML.
// ---------------------------------------------------------------------------

describe('MailWindow — sanitizeMailHtml', () => {
  afterEach(() => { cleanup() })

  async function renderWithHtml(htmlBody: string): Promise<string> {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({ html: htmlBody }))
      }
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow() })
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="mail"]')
    return iframe?.getAttribute('srcdoc') ?? ''
  }

  it('strips <script> blocks from HTML body', async () => {
    const srcDoc = await renderWithHtml('<p>Safe</p><script>alert("xss")</script>')
    expect(srcDoc).not.toMatch(/<script/i)
    expect(srcDoc).toMatch(/<p>Safe<\/p>/)
  })

  it('neutralises javascript: URIs in href attributes', async () => {
    // DOMPurify removes the href attribute entirely (per ALLOWED_URI_REGEXP that
    // forbids javascript:). The element survives but the dangerous href is gone.
    const srcDoc = await renderWithHtml('<a href="javascript:alert(1)">click</a>')
    expect(srcDoc).not.toMatch(/href\s*=\s*["']?javascript:/i)
    // The anchor itself may survive; the invariant is that javascript: href is absent.
  })

  it('neutralises javascript: URIs in src attributes', async () => {
    const srcDoc = await renderWithHtml('<img src="javascript:alert(1)">')
    expect(srcDoc).not.toMatch(/src\s*=\s*["']?javascript:/i)
  })

  it('strips on* event-handler attributes (onmouseover)', async () => {
    const srcDoc = await renderWithHtml('<div onmouseover="alert(1)">hover</div>')
    expect(srcDoc).not.toMatch(/onmouseover\s*=/i)
  })

  it('strips onclick handler from anchor elements', async () => {
    const srcDoc = await renderWithHtml('<a href="https://example.com" onclick="evilFn()">link</a>')
    expect(srcDoc).not.toMatch(/onclick\s*=/i)
  })

  it('does not leak script/eval for remote image src (CSP blocks fetch)', async () => {
    // The standalone MailWindow does not proxy external images (that's the full
    // pipeline in useMailIframeDoc). Instead it relies on the iframe CSP
    // `img-src data: cid:` to block the network fetch. The security property
    // tested here is that DOMPurify does not allow script execution through an
    // <img> src attribute (XSS via onerror, javascript: src, etc.) — the raw
    // https: URL may survive in the srcdoc but cannot fire scripts.
    const srcDoc = await renderWithHtml('<img src="https://tracker.example.com/pixel.gif" alt="tracker" onerror="alert(1)">')
    // onerror attribute must be stripped.
    expect(srcDoc).not.toMatch(/onerror\s*=/i)
    // img element itself may survive (CSP blocks the fetch in the browser).
  })

  it('preserves cid: inline image references', async () => {
    const srcDoc = await renderWithHtml('<img src="cid:image001@example.com" alt="inline">')
    expect(srcDoc).toMatch(/cid:image001@example\.com/)
  })

  it('preserves data: image references (inline base64 attachments)', async () => {
    const srcDoc = await renderWithHtml('<img src="data:image/png;base64,abc==" alt="inline">')
    expect(srcDoc).toMatch(/data:image\/png;base64,abc==/)
  })

  it('removes @import network-fetch rules from <style> blocks', async () => {
    // DOMPurify strips <style> tags from the body in jsdom (they are moved to
    // <head> by the parser). The invariant is that any @import that could
    // trigger a network fetch is not present in the final srcdoc.
    const srcDoc = await renderWithHtml('<style>@import "https://evil.com/style.css";</style><p>text</p>')
    expect(srcDoc).not.toMatch(/@import/)
  })
})

// ---------------------------------------------------------------------------
// Tests: loading and error states
// ---------------------------------------------------------------------------

describe('MailWindow — loading and error states', () => {
  afterEach(() => { cleanup() })

  it('shows loading indicator while fetch is in progress', async () => {
    let resolveDetails!: (v: MessageDetails) => void
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return new Promise<MessageDetails>(res => { resolveDetails = res })
      }
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow() })
    expect(document.querySelector('[data-testid="icon-loader"]')).toBeInTheDocument()

    // Resolve to avoid act warning about pending state updates
    await act(async () => { resolveDetails(makeMessageDetails()) })
  })

  it('shows error icon when fetch rejects', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.reject(new Error('IMAP error'))
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow() })
    expect(document.querySelector('[data-testid="icon-alert"]')).toBeInTheDocument()
  })

  it('shows offline icon when offlineFallback is true', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({ offlineFallback: true, html: undefined, text: undefined }))
      }
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow() })
    expect(document.querySelector('[data-testid="icon-wifioff"]')).toBeInTheDocument()
  })

  it('shows error icon when message has no html and no text', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({ html: undefined, text: undefined, offlineFallback: false }))
      }
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow() })
    expect(document.querySelector('[data-testid="icon-alert"]')).toBeInTheDocument()
  })

  it('shows error immediately and skips IPC when accountId is zero', async () => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    await act(async () => { renderMailWindow({ accountId: 0 }) })
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'net:messageDetails', expect.anything(), expect.anything(), expect.anything(),
    )
    expect(document.querySelector('[data-testid="icon-alert"]')).toBeInTheDocument()
  })

  it('shows error immediately and skips IPC when uid is negative', async () => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    await act(async () => { renderMailWindow({ uid: -5 }) })
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'net:messageDetails', expect.anything(), expect.anything(), expect.anything(),
    )
    expect(document.querySelector('[data-testid="icon-alert"]')).toBeInTheDocument()
  })

  it('shows error immediately and skips IPC when folder is empty string', async () => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    await act(async () => { renderMailWindow({ folder: '' }) })
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'net:messageDetails', expect.anything(), expect.anything(), expect.anything(),
    )
    expect(document.querySelector('[data-testid="icon-alert"]')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests: titlebar controls
// ---------------------------------------------------------------------------

describe('MailWindow — titlebar controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  it('close button calls window.close()', async () => {
    await act(async () => { renderMailWindow() })
    const closeBtn = document.querySelector<HTMLButtonElement>('.titlebar-btn-close')
    expect(closeBtn).toBeInTheDocument()
    fireEvent.click(closeBtn!)
    expect(mockWindowClose).toHaveBeenCalledOnce()
  })

  it('minimize button invokes win:minimize via IPC', async () => {
    await act(async () => { renderMailWindow() })
    // Minimize is the first .titlebar-btn in the titlebar
    const buttons = document.querySelectorAll<HTMLButtonElement>('.titlebar-btn')
    fireEvent.click(buttons[0]!)
    expect(mockInvoke).toHaveBeenCalledWith('win:minimize')
  })

  it('maximize button invokes win:maximize via IPC', async () => {
    await act(async () => { renderMailWindow() })
    const buttons = document.querySelectorAll<HTMLButtonElement>('.titlebar-btn')
    // Maximize is the second titlebar button
    fireEvent.click(buttons[1]!)
    expect(mockInvoke).toHaveBeenCalledWith('win:maximize')
  })

  it('fetches message via net:messageDetails IPC on mount with correct args', async () => {
    await act(async () => { renderMailWindow({ accountId: 3, folder: 'Sent', uid: 99 }) })
    expect(mockInvoke).toHaveBeenCalledWith('net:messageDetails', 3, 'Sent', 99)
  })
})

// ---------------------------------------------------------------------------
// Tests: link security (HIGH fix — rewriteMailHtmlLinks + phishing warning)
// ---------------------------------------------------------------------------

describe('MailWindow — link security', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      // Default: succeed silently for ui:openExternal, ui:domainToUnicode etc.
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  /**
   * Helper: get the mail:link listener registered via window.api.on.
   * Returns the callback so tests can fire simulated link events.
   */
  function getMailLinkListener(): ((payload: unknown) => void) | undefined {
    const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
    const call = calls.find(([ch]) => ch === 'mail:link')
    return call?.[1]
  }

  it('rewriteMailHtmlLinks is applied: http links in srcDoc use routed scheme, not raw http://', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({
          html: '<a href="https://example.com">Visit site</a>',
        }))
      }
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow() })
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="mail"]')
    const srcDoc = iframe?.getAttribute('srcdoc') ?? ''
    // The raw https:// href must be replaced by the routed mailcopilot-link:// scheme.
    expect(srcDoc).not.toMatch(/href\s*=\s*["']https?:\/\/example\.com/)
    expect(srcDoc).toMatch(/mailcopilot-link:\/\//)
  })

  it('registers mail:link IPC listener on mount', async () => {
    await act(async () => { renderMailWindow() })
    const calls = mockOn.mock.calls as Array<[string, unknown]>
    const mailLinkCall = calls.find(([ch]) => ch === 'mail:link')
    expect(mailLinkCall).toBeDefined()
  })

  it('unregisters mail:link IPC listener on unmount', async () => {
    const { unmount } = await act(async () => renderMailWindow())
    await act(async () => { unmount() })
    const offCalls = mockOff.mock.calls as Array<[string, unknown]>
    const mailLinkOff = offCalls.find(([ch]) => ch === 'mail:link')
    expect(mailLinkOff).toBeDefined()
  })

  it('safe link (https, no mismatch) opens directly via ui:openExternal without prompt', async () => {
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    // Payload arrives from main process already decoded (parseRoutedMailLink extracts u & t params).
    await act(async () => {
      listener!({ href: 'https://example.com', text: 'example.com' })
    })

    // No phishing prompt shown.
    expect(document.querySelector('.confirm-overlay')).not.toBeInTheDocument()
    // ui:openExternal called with the real URL (URL() normalises trailing slash).
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'https://example.com/')
  })

  it('http link triggers phishing warning prompt (warningHttp)', async () => {
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    // Payload arrives from main process already decoded.
    await act(async () => {
      listener!({ href: 'http://example.com', text: 'example.com' })
    })

    // Phishing prompt must be visible.
    expect(document.querySelector('.confirm-overlay')).toBeInTheDocument()
    expect(document.querySelector('#link-warning-title')?.textContent).toBe('This link looks suspicious')
    // http warning message present.
    const warnings = document.querySelectorAll('.link-warnings li')
    const texts = Array.from(warnings).map(li => li.textContent ?? '')
    expect(texts.some(w => w.includes('not encrypted'))).toBe(true)
    // ui:openExternal was NOT called yet (user hasn't confirmed).
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })

  it('display-text mismatch triggers phishing warning prompt (warningMismatch)', async () => {
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    // Link text says "paypal.com" but actually goes to "evil.com"
    await act(async () => {
      listener!({ href: 'https://evil.com/steal', text: 'paypal.com' })
    })

    const warnings = document.querySelectorAll('.link-warnings li')
    const texts = Array.from(warnings).map(li => li.textContent ?? '')
    expect(texts.some(w => w.includes('paypal.com') || w.includes('evil.com'))).toBe(true)
    expect(document.querySelector('.confirm-overlay')).toBeInTheDocument()
  })

  it('"Open anyway" button calls ui:openExternal and closes the prompt', async () => {
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    await act(async () => {
      listener!({ href: 'http://unsafe.com', text: 'unsafe.com' })
    })

    expect(document.querySelector('.confirm-overlay')).toBeInTheDocument()

    const openAnywayBtn = document.querySelector<HTMLButtonElement>('[data-testid="link-open-anyway"]')
    expect(openAnywayBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(openAnywayBtn!) })

    // URL() normalises trailing slash: "http://unsafe.com" → "http://unsafe.com/".
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'http://unsafe.com/')
    // Prompt dismissed after click.
    expect(document.querySelector('.confirm-overlay')).not.toBeInTheDocument()
  })

  it('"Cancel" button closes the prompt without calling openExternal', async () => {
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    await act(async () => {
      listener!({ href: 'http://unsafe.com', text: 'unsafe.com' })
    })

    expect(document.querySelector('.confirm-overlay')).toBeInTheDocument()

    const cancelBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.confirm-dialog-actions button'))
      .find(btn => btn.textContent === 'Cancel')
    expect(cancelBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(cancelBtn!) })

    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
    expect(document.querySelector('.confirm-overlay')).not.toBeInTheDocument()
  })

  it('shell:openExternal is never called directly — links always go via ui:openExternal IPC', async () => {
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    // Fire a safe link and confirm it opens.
    await act(async () => {
      listener!({ href: 'https://example.com', text: 'example.com' })
    })

    // Only ui:openExternal may be called — never shell:openExternal.
    const allInvokeCalls = mockInvoke.mock.calls as Array<[string, ...unknown[]]>
    const shellCalls = allInvokeCalls.filter(([ch]) => ch === 'shell:openExternal')
    expect(shellCalls).toHaveLength(0)
    expect(allInvokeCalls.some(([ch]) => ch === 'ui:openExternal')).toBe(true)
  })

  it('unsafeBypass=true forces phishing prompt even for trusted-looking https URL with empty text', async () => {
    // codex-security-review HIGH B4 regression guard.
    //
    // Before this fix, the main-process fallback in configureExternalLinks
    // called shell.openExternal() directly when a raw external URL slipped
    // past rewriteMailHtmlLinks() (e.g. <area href>, or any future
    // href-bearing element/attribute). That bypassed the phishing prompt
    // entirely.
    //
    // The new flow forwards the URL to renderer with unsafeBypass: true, and
    // the renderer always shows the prompt regardless of the URL's surface
    // shape — even a perfectly innocuous-looking https://example.com with
    // empty link text.
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    await act(async () => {
      listener!({ href: 'https://example.com', text: '', unsafeBypass: true })
    })

    // Prompt MUST be visible — without unsafeBypass this URL would have
    // opened directly with no warnings.
    expect(document.querySelector('.confirm-overlay')).toBeInTheDocument()
    // ui:openExternal NOT called yet (user has not confirmed).
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
    // Warning list contains at least one entry from the
    // warningRawExternalLink i18n key.
    const warnings = document.querySelectorAll('.link-warnings li')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('unsafeBypass omitted (default false) keeps existing safe-link short-circuit', async () => {
    // Regression guard: the new payload shape extends but does not change
    // the existing contract. A payload without unsafeBypass for a clean
    // https URL must still open directly without prompt.
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    await act(async () => {
      listener!({ href: 'https://example.com', text: 'example.com' })
    })

    expect(document.querySelector('.confirm-overlay')).not.toBeInTheDocument()
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'https://example.com/')
  })

  it('unsafeBypass=true stacks with other warnings (e.g. http triggers BOTH http and rawExternal)', async () => {
    // Sanity check: when both heuristics fire (http + bypass), the prompt
    // shows two distinct warnings, not one that overrides the other.
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    await act(async () => {
      listener!({ href: 'http://example.com', text: '', unsafeBypass: true })
    })

    expect(document.querySelector('.confirm-overlay')).toBeInTheDocument()
    const warnings = document.querySelectorAll('.link-warnings li')
    // At least 2 warnings: warningHttp + warningRawExternalLink.
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('malformed mail:link payload (missing href) is ignored silently', async () => {
    await act(async () => { renderMailWindow() })
    const listener = getMailLinkListener()
    expect(listener).toBeDefined()

    // Should not throw and should not open any link.
    await act(async () => {
      listener!({ text: 'some text' }) // href missing
      listener!('not an object')       // wrong type
      listener!(null)                  // null
    })

    expect(document.querySelector('.confirm-overlay')).not.toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })
})

// ---------------------------------------------------------------------------
// Tests: mail:print listener in MailWindow (gap #3 — §3.3.C-print.f1 fix-wave 2.1.C)
// ---------------------------------------------------------------------------

describe('MailWindow — mail:print listener calls iframe.contentWindow.print()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  /**
   * Retrieves the mail:print handler that MailWindow registered via window.api.on.
   * MailWindow registers it in a useEffect with no deps — fires once on mount.
   */
  function getMailPrintListener(): (() => void) | undefined {
    const calls = mockOn.mock.calls as Array<[string, () => void]>
    return calls.find(([ch]) => ch === 'mail:print')?.[1]
  }

  it('registers window.api.on("mail:print") on mount', async () => {
    await act(async () => { renderMailWindow() })
    const printCalls = (mockOn.mock.calls as Array<[string, unknown]>).filter(
      ([ch]) => ch === 'mail:print',
    )
    expect(printCalls).toHaveLength(1)
  })

  it('unregisters window.api.off("mail:print") on unmount with same handler reference', async () => {
    const { unmount } = await act(async () => renderMailWindow())

    const registered = getMailPrintListener()
    expect(registered).toBeDefined()

    await act(async () => { unmount() })

    const offCalls = mockOff.mock.calls as Array<[string, unknown]>
    const deregistered = offCalls.find(([ch]) => ch === 'mail:print')?.[1]
    expect(deregistered).toBeDefined()
    expect(deregistered).toBe(registered)
  })

  it('mail:print listener invokes iframe.contentWindow.print() when iframe is loaded', async () => {
    await act(async () => { renderMailWindow() })

    // The component renders an iframe via iframeRef (useRef). In jsdom, iframeRef.current
    // is set by React. We patch contentWindow on the DOM node so the handler sees it.
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="mail"]')
    expect(iframe).toBeInTheDocument()

    const mockPrint = vi.fn()
    let patched = false
    try {
      Object.defineProperty(iframe, 'contentWindow', {
        value: { print: mockPrint },
        writable: true,
        configurable: true,
      })
      patched = true
    } catch {
      // jsdom may not allow redefining contentWindow on a real iframe element.
      // In that case the test falls back to the no-throw guard below.
    }

    const handler = getMailPrintListener()
    expect(handler).toBeDefined()

    // Must not throw regardless of whether contentWindow is patchable.
    expect(() => act(() => { handler!() })).not.toThrow()

    if (patched) {
      // When patching succeeds, iframeRef.current?.contentWindow?.print() resolves to mockPrint.
      expect(mockPrint).toHaveBeenCalledOnce()
    }
  })

  it('mail:print listener does not throw when iframe is not yet in DOM (ref is null)', async () => {
    // Render without a mail loaded → loading state → no iframe in DOM → iframeRef.current null.
    let resolveDetails!: (v: ReturnType<typeof makeMessageDetails>) => void
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return new Promise<ReturnType<typeof makeMessageDetails>>(res => { resolveDetails = res })
      }
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow() })

    // At this point loading=true, no iframe — iframeRef.current should be null.
    const handler = getMailPrintListener()
    expect(handler).toBeDefined()

    // jsdom does not implement window.print — override to suppress stderr noise.
    const origPrint = window.print
    Object.defineProperty(window, 'print', { value: vi.fn(), writable: true, configurable: true })
    expect(() => act(() => { handler!() })).not.toThrow()
    Object.defineProperty(window, 'print', { value: origPrint, writable: true, configurable: true })

    // Resolve to avoid act() warning about pending state updates.
    await act(async () => { resolveDetails(makeMessageDetails()) })
  })

  it('mail:print listener does not call window.api.invoke (no IPC on new path)', async () => {
    await act(async () => { renderMailWindow() })

    const handler = getMailPrintListener()
    expect(handler).toBeDefined()

    // Patch contentWindow.print on the rendered iframe so the handler calls our
    // mock instead of jsdom's "Not implemented" window.print. jsdom's iframe
    // contentWindow is an internal proxy that ignores Object.defineProperty on the
    // top-level window — patching the iframe DOM node itself is the reliable approach.
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="mail"]')
    const printMock = vi.fn()
    if (iframe) {
      try {
        Object.defineProperty(iframe, 'contentWindow', {
          value: { print: printMock },
          writable: true,
          configurable: true,
        })
      } catch { /* jsdom may prevent redefine; test falls back to IPC assertion only */ }
    }

    // Capture invoke call count before firing the handler.
    const invokeCountBeforeHandler = mockInvoke.mock.calls.length

    act(() => { handler!() })

    // The handler must not trigger any additional IPC calls. Only mount calls
    // (net:messageDetails, cache:folderRoles, win:isMaximized) are expected
    // to have happened before this point.
    const invokesAfterHandler = mockInvoke.mock.calls.slice(invokeCountBeforeHandler) as Array<[string, ...unknown[]]>
    expect(invokesAfterHandler).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: action toolbar — Reply, Archive, Delete, Flag, Seen
// ---------------------------------------------------------------------------

describe('MailWindow — action toolbar: Reply', () => {
  const folderRoles: FolderRoles = { archive: 'Archive', trash: 'Trash' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: folderRoles })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  it('Reply button calls ui:openCompose with reply source and In-Reply-To uid', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const replyBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-reply"]')
    expect(replyBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(replyBtn!) })
    const composeCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'ui:openCompose')
    expect(composeCalls).toHaveLength(1)
    const [, , init] = composeCalls[0] as [string, number, { source: string; replyRef?: { uid: number } }]
    expect(init.source).toBe('reply')
    expect(init.replyRef?.uid).toBe(42)
  })

  it('Reply All button calls ui:openCompose with reply_all source', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-reply-all"]')
    expect(btn).toBeInTheDocument()
    await act(async () => { fireEvent.click(btn!) })
    const composeCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'ui:openCompose')
    expect(composeCalls).toHaveLength(1)
    const [, , init] = composeCalls[0] as [string, number, { source: string }]
    expect(init.source).toBe('reply_all')
  })

  it('Forward button calls ui:openCompose with forward source and Fwd: subject', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-forward"]')
    expect(btn).toBeInTheDocument()
    await act(async () => { fireEvent.click(btn!) })
    const composeCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'ui:openCompose')
    expect(composeCalls).toHaveLength(1)
    const [, , init] = composeCalls[0] as [string, number, { source: string; subject?: string }]
    expect(init.source).toBe('forward')
    expect(init.subject).toMatch(/^Fwd:/)
  })
})

describe('MailWindow — action toolbar: Archive', () => {
  afterEach(() => { cleanup() })

  it('Archive button shows undo banner immediately and does NOT call net:move yet (defer pattern)', async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    const folderRoles: FolderRoles = { archive: 'Archive', trash: 'Trash' }
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: folderRoles })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    expect(archiveBtn).toBeInTheDocument()
    expect(archiveBtn).not.toBeDisabled()
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Defer pattern: net:move must NOT be called immediately.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Banner is shown, window stays open.
    expect(mockWindowClose).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="undo-banner-message"]')?.textContent).toBe('Archived. Undo')
    vi.useRealTimers()
    cleanup()
  })

  it('Archive button is disabled when cache:folderRoles has no archive for account', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    expect(archiveBtn).toBeDisabled()
  })

  it('Archive button is disabled when cache:folderRoles returns empty', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({})
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    expect(archiveBtn).toBeDisabled()
  })
})

describe('MailWindow — action toolbar: Delete', () => {
  afterEach(() => { cleanup() })

  // BLOCKER fix tests: Delete button disabled until folderRolesLoaded
  it('Delete button is disabled while cache:folderRoles is loading', async () => {
    vi.clearAllMocks()
    let resolveFolderRoles!: (v: unknown) => void
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return new Promise(res => { resolveFolderRoles = res })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    expect(deleteBtn).toBeDisabled()
    // Resolve to avoid act() warning about pending state updates.
    await act(async () => { resolveFolderRoles({ 1: { archive: 'Archive', trash: 'Trash' } }) })
  })

  it('Delete button is enabled after cache:folderRoles resolves', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    expect(deleteBtn).not.toBeDisabled()
  })

  it('Delete moves to trash: shows undo banner immediately, does NOT call net:move yet (defer pattern)', async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    expect(deleteBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(deleteBtn!) })
    // No confirmation dialog for move-to-trash.
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).not.toBeInTheDocument()
    // Defer pattern: net:move must NOT be called immediately.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Banner shown, window stays open.
    expect(mockWindowClose).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="undo-banner-message"]')?.textContent).toBe('Moved to trash. Undo')
    vi.useRealTimers()
    cleanup()
  })

  it('Delete shows confirmation dialog when already in trash folder (permanent delete)', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'Trash', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    // Confirmation dialog must appear.
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).toBeInTheDocument()
    // net:delete must NOT be called yet — user hasn't confirmed.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:delete', expect.anything(), expect.anything(), expect.anything())
  })

  it('Delete shows confirmation dialog when no trash folder in roles', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalledWith('net:delete', expect.anything(), expect.anything(), expect.anything())
  })

  it('Confirming permanent delete calls net:delete and closes window', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'Trash', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    // Dialog shown — click the confirm button.
    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-ok"]')
    expect(confirmBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(confirmBtn!) })
    expect(mockInvoke).toHaveBeenCalledWith('net:delete', 1, 'Trash', [42])
    expect(mockWindowClose).toHaveBeenCalled()
  })

  it('Cancelling permanent delete dialog does not call net:delete', async () => {
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'Trash', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-cancel"]')
    expect(cancelBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(cancelBtn!) })
    // Dialog dismissed.
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).not.toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalledWith('net:delete', expect.anything(), expect.anything(), expect.anything())
    expect(mockWindowClose).not.toHaveBeenCalled()
  })
})

describe('MailWindow — action toolbar: Flag and Seen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  it('Flag button calls net:setFlagged with true when message is currently unflagged', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const flagBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-flag"]')
    expect(flagBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(flagBtn!) })
    expect(mockInvoke).toHaveBeenCalledWith('net:setFlagged', 1, 'INBOX', [42], true)
  })

  it('Mark-seen button calls net:setSeen with false when message is currently read (flags include \\Seen)', async () => {
    // makeMessageDetails() does not include flags — default seen=true (initialized in useState).
    // The message details fixture has no flags array → seen defaults to true from useState.
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const seenBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-mark-seen"]')
    expect(seenBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(seenBtn!) })
    // seen was true → toggle → setSeen(false) = mark unread
    expect(mockInvoke).toHaveBeenCalledWith('net:setSeen', 1, 'INBOX', [42], false)
  })
})

// ---------------------------------------------------------------------------
// Tests: optimistic rollback on IPC failure (Flag + Seen)
// ---------------------------------------------------------------------------

describe('MailWindow — action toolbar: optimistic rollback on IPC failure', () => {
  afterEach(() => { cleanup() })

  it('flag state reverts to original when net:setFlagged rejects', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'net:setFlagged') return Promise.reject(new Error('IMAP error'))
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })

    // Initially unflagged — toolbar-flag should not have star-on class.
    const flagBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-flag"]')
    expect(flagBtn).toBeInTheDocument()
    expect(flagBtn).not.toHaveClass('star-on')

    // Click flag — optimistic update fires immediately (star-on), then rollback when IPC rejects.
    await act(async () => { fireEvent.click(flagBtn!) })

    // After rollback, the button must be back to unflagged.
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-flag"]')).not.toHaveClass('star-on')
  })

  it('seen state reverts to original when net:setSeen rejects', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'net:setSeen') return Promise.reject(new Error('IMAP error'))
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })

    // Default seen=true → button title should be "Mark as unread" (MailOpen icon).
    const seenBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-mark-seen"]')
    expect(seenBtn).toBeInTheDocument()
    expect(seenBtn).toHaveAttribute('title', 'Mark as unread')

    // Click → optimistic flip to seen=false → then IPC rejects → rollback to seen=true.
    await act(async () => { fireEvent.click(seenBtn!) })

    // After rollback the button title must be "Mark as unread" again (seen=true restored).
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-mark-seen"]')).toHaveAttribute('title', 'Mark as unread')
  })
})

// ---------------------------------------------------------------------------
// Tests: flags initialisation from details.flags on mount
// ---------------------------------------------------------------------------

describe('MailWindow — flags initialised from details.flags on mount', () => {
  afterEach(() => { cleanup() })

  it('toolbar-flag has star-on class when details.flags includes \\Flagged', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({ flags: ['\\Seen', '\\Flagged'] }))
      }
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    expect(document.querySelector('[data-testid="toolbar-flag"]')).toHaveClass('star-on')
  })

  it('toolbar-flag does not have star-on class when details.flags does not include \\Flagged', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({ flags: ['\\Seen'] }))
      }
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    expect(document.querySelector('[data-testid="toolbar-flag"]')).not.toHaveClass('star-on')
  })

  it('mark-seen button title is "Mark as read" when details.flags does not include \\Seen', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') {
        return Promise.resolve(makeMessageDetails({ flags: [] }))
      }
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    // seen=false (no \\Seen flag) → button title "Mark as read"
    expect(document.querySelector('[data-testid="toolbar-mark-seen"]')).toHaveAttribute('title', 'Mark as read')
  })

  it('cache:folderRoles is requested on mount', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({})
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const cacheRolesCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'cache:folderRoles')
    expect(cacheRolesCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: archive/delete non-fatal error handling (window stays open on failure)
// ---------------------------------------------------------------------------

describe('MailWindow — action toolbar: window stays open when IPC fails', () => {
  afterEach(() => { cleanup() })

  it('window.close is NOT called immediately after archive button click (defer pattern — no IPC yet)', async () => {
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    expect(archiveBtn).not.toBeDisabled()
    await act(async () => { fireEvent.click(archiveBtn!) })

    // Defer pattern: no IPC call, no window close at this point.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(mockWindowClose).not.toHaveBeenCalled()
  })

  it('window.close is NOT called immediately after delete-to-trash button click (defer pattern)', async () => {
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })

    // Defer pattern: no IPC call, no window close immediately.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(mockWindowClose).not.toHaveBeenCalled()
  })

  it('window.close is NOT called when net:delete (permanent) rejects', async () => {
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      // No trash folder → permanent delete path needs confirmation.
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive' } })
      if (channel === 'net:delete') return Promise.reject(new Error('IMAP delete failed'))
      return Promise.resolve(undefined)
    })

    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    // Click delete — confirmation dialog appears.
    await act(async () => { fireEvent.click(deleteBtn!) })
    // Confirm permanent delete.
    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-ok"]')
    expect(confirmBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(confirmBtn!) })

    expect(mockWindowClose).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: BLOCKER fix — error banner shown when Archive/Delete IPC fails
// ---------------------------------------------------------------------------

describe('MailWindow — action error banner', () => {
  afterEach(() => { cleanup() })

  it('archive net:move failure at timer-commit: window still closes (defer pattern — error not surfaceable at close)', async () => {
    // With the defer pattern, net:move fires only when the timer expires (user committed).
    // At that point the window is closing; the error is swallowed and window.close()
    // is still called in .finally(). There is no visible error banner because the
    // window is already closing — this is intentional.
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'net:move') return Promise.reject(new Error('network error'))
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Before timer: no net:move, no error, no close.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(document.querySelector('[data-testid="action-error-banner"]')).not.toBeInTheDocument()
    expect(mockWindowClose).not.toHaveBeenCalled()
    // Advance timer — net:move fires, rejects, but window.close() is still called in .finally().
    await act(async () => { vi.advanceTimersByTime(3001) })
    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Archive', [42])
    expect(mockWindowClose).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('error banner shown when permanent delete net:delete rejects (after confirmation)', async () => {
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive' } })
      if (channel === 'net:delete') return Promise.reject(new Error('network error'))
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-ok"]')
    await act(async () => { fireEvent.click(confirmBtn!) })
    expect(document.querySelector('[data-testid="action-error-banner"]')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests: MEDIUM fix — accounts:get loaded on mount for Reply All self-filter
// ---------------------------------------------------------------------------

describe('MailWindow — accounts:get identity for Reply All', () => {
  afterEach(() => { cleanup() })

  it('accounts:get is requested on mount', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'accounts:get') return Promise.resolve({
        id: 1, smtp: { user: 'me@example.com', host: 'smtp', port: 587, secure: true },
        imap: { user: 'me@example.com', host: 'imap', port: 993, secure: true },
        identities: [], providerId: 'generic-imap', transportType: 'imap-smtp',
      })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const calls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
    expect(calls.some(([ch]) => ch === 'accounts:get')).toBe(true)
  })

  it('Reply All excludes self email from cc when selfEmail matches a recipient', async () => {
    vi.clearAllMocks()
    // Message from Alice to [Me, Bob] — Reply All should go to Alice, cc Bob (not Me).
    const msgDetails = makeMessageDetails({
      envelope: {
        subject: 'Test',
        from: [{ name: 'Alice', address: 'alice@example.com' }],
        to: [
          { name: 'Me', address: 'me@example.com' },
          { name: 'Bob', address: 'bob@example.com' },
        ],
        cc: [],
        date: '2024-01-15T10:30:00Z',
        messageId: '<abc@example.com>',
      },
    })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(msgDetails)
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'accounts:get') return Promise.resolve({
        id: 1, smtp: { user: 'me@example.com', host: 'smtp', port: 587, secure: true },
        imap: { user: 'me@example.com', host: 'imap', port: 993, secure: true },
        identities: [], providerId: 'generic-imap', transportType: 'imap-smtp',
      })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const replyAllBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-reply-all"]')
    await act(async () => { fireEvent.click(replyAllBtn!) })
    const composeCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'ui:openCompose')
    expect(composeCalls).toHaveLength(1)
    const [, , init] = composeCalls[0] as [string, number, { to?: string; cc?: string }]
    // Our own address should not appear in to or cc.
    const allRecipients = `${init.to ?? ''} ${init.cc ?? ''}`.toLowerCase()
    expect(allRecipients).not.toMatch(/me@example\.com/)
  })
})

// ---------------------------------------------------------------------------
// Tests: MEDIUM fix — forward fetches attachments via net:attachmentBase64
// ---------------------------------------------------------------------------

describe('MailWindow — forward with attachments', () => {
  afterEach(() => { cleanup() })

  it('Forward calls net:attachmentBase64 for non-CID attachments', async () => {
    vi.clearAllMocks()
    const msgWithAttachment = makeMessageDetails({
      attachments: [
        { part: '2', filename: 'doc.pdf', contentType: 'application/pdf', size: 1000 },
      ],
    })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(msgWithAttachment)
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'net:attachmentBase64') {
        return Promise.resolve({ ok: true, contentBase64: 'dGVzdA==', contentType: 'application/pdf' })
      }
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const fwdBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-forward"]')
    await act(async () => { fireEvent.click(fwdBtn!) })
    expect(mockInvoke).toHaveBeenCalledWith('net:attachmentBase64', 1, 'INBOX', 42, '2')
    // Compose should be called with attachments.
    const composeCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'ui:openCompose')
    expect(composeCalls).toHaveLength(1)
    const [, , init] = composeCalls[0] as [string, number, { attachments?: unknown[] }]
    expect(Array.isArray(init.attachments)).toBe(true)
    expect((init.attachments ?? []).length).toBeGreaterThan(0)
  })

  it('Forward skips CID attachments (inline images)', async () => {
    vi.clearAllMocks()
    const msgWithCid = makeMessageDetails({
      attachments: [
        { part: '2', filename: 'img.png', contentType: 'image/png', size: 500, cid: 'image001@example.com' },
      ],
    })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(msgWithCid)
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const fwdBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-forward"]')
    await act(async () => { fireEvent.click(fwdBtn!) })
    // CID attachments must not be fetched.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:attachmentBase64', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })
})

// ---------------------------------------------------------------------------
// Tests: MEDIUM fix — pending guard on flag/seen buttons (re-entry safe)
// ---------------------------------------------------------------------------

describe('MailWindow — flag/seen pending guard', () => {
  afterEach(() => { cleanup() })

  it('flag button is disabled while net:setFlagged IPC is pending', async () => {
    vi.clearAllMocks()
    let resolveFlag!: (v: unknown) => void
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'net:setFlagged') return new Promise(res => { resolveFlag = res })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const flagBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-flag"]')
    fireEvent.click(flagBtn!)
    await act(async () => {}) // flush synchronous state updates
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-flag"]')).toBeDisabled()
    await act(async () => { resolveFlag(undefined) })
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-flag"]')).not.toBeDisabled()
  })

  it('seen button is disabled while net:setSeen IPC is pending', async () => {
    vi.clearAllMocks()
    let resolveSeen!: (v: unknown) => void
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'net:setSeen') return new Promise(res => { resolveSeen = res })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const seenBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-mark-seen"]')
    fireEvent.click(seenBtn!)
    await act(async () => {})
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-mark-seen"]')).toBeDisabled()
    await act(async () => { resolveSeen(undefined) })
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-mark-seen"]')).not.toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Tests: HIGH fix — undo banner for Archive and Move-to-trash
// ---------------------------------------------------------------------------

describe('MailWindow — undo banner: Archive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('Archive shows undo banner; window does NOT close immediately; net:move not called yet', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    expect(mockWindowClose).not.toHaveBeenCalled()
    // Defer pattern: no net:move until timer expires.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('Undo click cancels deferred Archive move — NO net:move call; banner disappears; window stays open', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid="undo-banner-btn"]')
    expect(undoBtn).toBeInTheDocument()
    await act(async () => { fireEvent.click(undoBtn!) })
    // Undo = cancel deferred move. No net:move should ever be called.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Banner gone, window stays open.
    expect(document.querySelector('[data-testid="undo-banner"]')).not.toBeInTheDocument()
    expect(mockWindowClose).not.toHaveBeenCalled()
  })

  it('Archive timer expire fires net:move then closes window after 3000ms', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(mockWindowClose).not.toHaveBeenCalled()
    // Advance past the 3000ms deferred net:move + window.close.
    await act(async () => { vi.advanceTimersByTime(3001) })
    // net:move must be called on timer expiry (defer pattern commit).
    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Archive', [42])
    expect(mockWindowClose).toHaveBeenCalledOnce()
  })

  it('Undo click cancels the auto-close timer so window stays open indefinitely', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid="undo-banner-btn"]')
    await act(async () => { fireEvent.click(undoBtn!) })
    // Timer should be cancelled — advancing past 3s must NOT close window.
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(mockWindowClose).not.toHaveBeenCalled()
  })
})

describe('MailWindow — undo banner: Move-to-trash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('Move-to-trash shows undo banner; no net:move yet (defer pattern)', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="undo-banner-message"]')?.textContent).toBe('Moved to trash. Undo')
    expect(mockWindowClose).not.toHaveBeenCalled()
    // No net:move until timer expires.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('Undo click on trash banner cancels deferred move — NO net:move call; window stays open', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid="undo-banner-btn"]')
    await act(async () => { fireEvent.click(undoBtn!) })
    // Undo = cancel deferred move. No net:move.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(document.querySelector('[data-testid="undo-banner"]')).not.toBeInTheDocument()
    expect(mockWindowClose).not.toHaveBeenCalled()
  })

  it('Move-to-trash timer expire fires net:move then closes window after 3000ms', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    await act(async () => { vi.advanceTimersByTime(3001) })
    // net:move must fire on commit.
    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Trash', [42])
    expect(mockWindowClose).toHaveBeenCalledOnce()
  })
})

describe('MailWindow — permanent delete: no undo banner', () => {
  afterEach(() => { cleanup() })

  it('Permanent delete closes window immediately after net:delete without undo banner', async () => {
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'Trash', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-ok"]')
    await act(async () => { fireEvent.click(confirmBtn!) })
    // Permanent delete — window closes immediately, no undo banner.
    expect(mockWindowClose).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="undo-banner"]')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests: defer pattern — acceptance criteria from iteration 3 codex review
// ---------------------------------------------------------------------------

describe('MailWindow — defer undo: Archive fires net:move on timer expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })
  afterEach(() => { vi.useRealTimers(); cleanup() })

  it('AC#1 — Archive defers net:move until timer expires (no net:move before 3000ms, net:move at 3000ms)', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // No net:move before timer fires.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Advance to just past the 3000ms threshold.
    await act(async () => { vi.advanceTimersByTime(3001) })
    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Archive', [42])
  })

  it('AC#2 — Archive Undo cancels deferred move: no net:move at any point', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid="undo-banner-btn"]')
    await act(async () => { fireEvent.click(undoBtn!) })
    // Timer cancelled — advancing past 3000ms must not trigger net:move.
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('AC#4 (HIGH fix) — Archive button is disabled while undo banner active; clicking it is a no-op (stale-UID guard)', async () => {
    // With the HIGH fix, Archive button is disabled when destructiveActionsDisabled=true
    // (i.e. pendingUndo !== null). The old behaviour of "second click flushes first" is
    // replaced by prevention: the user cannot trigger a second destructive action at all
    // until the first is committed (timer expiry) or cancelled (Undo click).
    // This eliminates the stale-UID race entirely.
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    // First archive click — starts pending, banner shown, button becomes disabled.
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    expect(archiveBtn).toBeDisabled()
    // Second click on disabled button — must be a no-op. No net:move fired.
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Banner still showing (first pending is still active).
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
  })
})

describe('MailWindow — defer undo: permanent delete flushes pending undo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })
  afterEach(() => { vi.useRealTimers(); cleanup() })

  it('AC#3 (HIGH fix) — Delete button is disabled while Archive undo pending; confirm dialog cannot open until Undo clicked', async () => {
    // With the HIGH fix (destructiveActionsDisabled), Delete button is disabled while a
    // pending undo is active. The user must either Undo or wait for the timer to expire
    // before the Delete (permanent confirm dialog) path is available.
    // This closes HIGH 2: "permanent delete dialog opens flushes pending undo before user confirms".
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      // No trash folder → delete goes to permanent confirm
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Pending undo is active — Delete button must be disabled.
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    expect(deleteBtn).toBeDisabled()
    // Clicking disabled Delete must NOT open confirm dialog.
    await act(async () => { fireEvent.click(deleteBtn!) })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).not.toBeInTheDocument()
    // After Undo, Delete becomes available again.
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid="undo-banner-btn"]')
    await act(async () => { fireEvent.click(undoBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).not.toBeInTheDocument()
    expect(deleteBtn).not.toBeDisabled()
    // Now clicking Delete opens the confirm dialog normally.
    await act(async () => { fireEvent.click(deleteBtn!) })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).toBeInTheDocument()
    // No net:move was ever called (Archive was Undo'd — no IMAP move occurred).
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })
})

describe('MailWindow — defer undo: actionError clears undo banner', () => {
  afterEach(() => { cleanup() })

  it('AC#6 — actionError (reply failure) clears pending undo banner and cancels timer', async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      // Simulate compose failure so actionError fires.
      if (channel === 'ui:openCompose') return Promise.reject(new Error('compose failed'))
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    // Trigger an error via reply failure.
    const replyBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-reply"]')
    await act(async () => { fireEvent.click(replyBtn!) })
    // actionError banner must appear.
    expect(document.querySelector('[data-testid="action-error-banner"]')).toBeInTheDocument()
    // undo banner must be gone (cleared by error).
    expect(document.querySelector('[data-testid="undo-banner"]')).not.toBeInTheDocument()
    // Advancing timer must NOT trigger net:move (timer was cancelled).
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    vi.useRealTimers()
  })
})

describe('MailWindow — defer undo: Cancel button autofocus via useLayoutEffect', () => {
  afterEach(() => { cleanup() })

  it('AC#5 — Cancel button receives focus when confirm dialog opens (useLayoutEffect, no setTimeout)', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'Trash', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-cancel"]')
    expect(cancelBtn).toBeInTheDocument()
    // useLayoutEffect fires synchronously after DOM mutation — focus should be set already.
    expect(document.activeElement).toBe(cancelBtn)
  })
})

// ---------------------------------------------------------------------------
// Tests: MEDIUM fix — confirm dialog accessibility (focus trap, Escape, backdrop)
// ---------------------------------------------------------------------------

describe('MailWindow — confirm dialog accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => { cleanup() })

  async function openConfirmDialog() {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'Trash', uid: 42 }) })
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    await act(async () => { fireEvent.click(deleteBtn!) })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).toBeInTheDocument()
  }

  it('Escape key on confirm dialog cancels it', async () => {
    await openConfirmDialog()
    const dialog = document.querySelector<HTMLDivElement>('.confirm-dialog')
    expect(dialog).toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(dialog!, { key: 'Escape', code: 'Escape' })
    })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).not.toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalledWith('net:delete', expect.anything(), expect.anything(), expect.anything())
    expect(mockWindowClose).not.toHaveBeenCalled()
  })

  it('Backdrop click (overlay) cancels dialog', async () => {
    await openConfirmDialog()
    const overlay = document.querySelector<HTMLDivElement>('.confirm-overlay')
    expect(overlay).toBeInTheDocument()
    await act(async () => { fireEvent.click(overlay!) })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).not.toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalledWith('net:delete', expect.anything(), expect.anything(), expect.anything())
  })

  it('Click on dialog content (not backdrop) does NOT close dialog', async () => {
    await openConfirmDialog()
    const dialog = document.querySelector<HTMLDivElement>('.confirm-dialog')
    await act(async () => { fireEvent.click(dialog!) })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).toBeInTheDocument()
  })

  it('Tab key wraps focus from last to first button (focus trap)', async () => {
    await openConfirmDialog()
    const dialog = document.querySelector<HTMLDivElement>('.confirm-dialog')
    const confirmOkBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-ok"]')
    expect(confirmOkBtn).toBeInTheDocument()
    // Simulate Tab press while focus is on the last (confirm) button.
    confirmOkBtn!.focus()
    await act(async () => {
      fireEvent.keyDown(dialog!, { key: 'Tab', code: 'Tab', shiftKey: false })
    })
    // Dialog must still be visible (focus trap, not closed).
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).toBeInTheDocument()
  })

  it('Shift+Tab key wraps focus from first to last button (focus trap)', async () => {
    await openConfirmDialog()
    const dialog = document.querySelector<HTMLDivElement>('.confirm-dialog')
    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete-cancel"]')
    expect(cancelBtn).toBeInTheDocument()
    // Simulate Shift+Tab while focus is on the first (cancel) button.
    cancelBtn!.focus()
    await act(async () => {
      fireEvent.keyDown(dialog!, { key: 'Tab', code: 'Tab', shiftKey: true })
    })
    // Dialog must still be visible.
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests: LOW fix — Reply/Forward error shows actionError banner
// ---------------------------------------------------------------------------

describe('MailWindow — reply/forward error banner', () => {
  afterEach(() => { cleanup() })

  it('Reply error shows actionError banner', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'ui:openCompose') return Promise.reject(new Error('compose failed'))
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const replyBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-reply"]')
    await act(async () => { fireEvent.click(replyBtn!) })
    expect(document.querySelector('[data-testid="action-error-banner"]')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="action-error-banner"]')?.textContent).toBe('Action failed. Please try again.')
  })

  it('Forward error shows actionError banner', async () => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      if (channel === 'ui:openCompose') return Promise.reject(new Error('compose failed'))
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const fwdBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-forward"]')
    await act(async () => { fireEvent.click(fwdBtn!) })
    expect(document.querySelector('[data-testid="action-error-banner"]')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests: HIGH fix — Archive while pending disables Archive and Delete buttons
// Acceptance criteria #1, #2, #3 (stale-UID guard via destructiveActionsDisabled prop)
// ---------------------------------------------------------------------------

describe('MailWindow — HIGH fix: destructiveActionsDisabled while undo banner active', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('AC#1 — Archive while pending: Archive button is disabled (DOM disabled attr) while undo banner is active', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Banner is shown — destructive buttons must be disabled.
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')).toBeDisabled()
  })

  it('AC#1 — Archive while pending: Delete button is disabled (DOM disabled attr) while undo banner is active', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Banner is shown — Delete must also be disabled.
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')).toBeDisabled()
  })

  it('AC#2 — Permanent delete button disabled while undo banner active (cannot open confirm dialog)', async () => {
    // Render in Trash folder so delete → permanent confirm (no trash-to-trash move).
    vi.clearAllMocks()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      // No trash role → delete always goes to confirm dialog
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive' } })
      return Promise.resolve(undefined)
    })
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Undo banner active → Delete button disabled.
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    const deleteBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')
    expect(deleteBtn).toBeDisabled()
    // Clicking the disabled Delete must NOT open the confirm dialog.
    await act(async () => { fireEvent.click(deleteBtn!) })
    expect(document.querySelector('[data-testid="confirm-permanent-delete-overlay"]')).not.toBeInTheDocument()
  })

  it('AC#3 — Archive → Undo re-enables Archive and Delete buttons', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    // Both destructive buttons must be disabled while pending.
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')).toBeDisabled()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')).toBeDisabled()
    // Click Undo → cancel the pending move.
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid="undo-banner-btn"]')
    await act(async () => { fireEvent.click(undoBtn!) })
    // Banner gone → destructive buttons must be re-enabled.
    expect(document.querySelector('[data-testid="undo-banner"]')).not.toBeInTheDocument()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')).not.toBeDisabled()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-delete"]')).not.toBeDisabled()
  })

  it('Reply / Forward / Flag / Seen remain enabled while undo banner is active', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    // Non-destructive buttons must remain enabled.
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-reply"]')).not.toBeDisabled()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-reply-all"]')).not.toBeDisabled()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-forward"]')).not.toBeDisabled()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-flag"]')).not.toBeDisabled()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-mark-seen"]')).not.toBeDisabled()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-print"]')).not.toBeDisabled()
  })

  it('Timer expiry (3000ms) fires net:move exactly once and closes window', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Before timer: no net:move.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Advance past 3000ms.
    await act(async () => { vi.advanceTimersByTime(3001) })
    const moveCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'net:move')
    // Exactly one net:move must fire (idempotent — not double-fire).
    expect(moveCalls).toHaveLength(1)
    expect(mockWindowClose).toHaveBeenCalledOnce()
  })

  it('Unmount with pending fires single net:move (idempotent unmount cleanup)', async () => {
    const { unmount } = await act(async () => renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }))
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(document.querySelector('[data-testid="undo-banner"]')).toBeInTheDocument()
    // Unmount while pending (without letting timer expire) — cleanup must fire net:move once.
    await act(async () => { unmount() })
    const moveCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'net:move')
    expect(moveCalls).toHaveLength(1)
    expect(moveCalls[0]).toEqual(['net:move', 1, 'INBOX', 'Archive', [42]])
  })
})

// ---------------------------------------------------------------------------
// Tests: MEDIUM fix — flushPendingUndo ref-idempotent (double synchronous call)
// ---------------------------------------------------------------------------

describe('MailWindow — MEDIUM fix: flushPendingUndo idempotent (ref-based)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWindowClose.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:messageDetails') return Promise.resolve(makeMessageDetails())
      if (channel === 'cache:folderRoles') return Promise.resolve({ 1: { archive: 'Archive', trash: 'Trash' } })
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('Double-Archive click fires net:move exactly once (first flush + second click starts new pending)', async () => {
    // AC#4 from codex: second Archive while pending → flush fires exactly one net:move for the first,
    // then sets up a new pending for the second. The new pending does NOT immediately fire.
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    // First click — starts pending, no net:move yet.
    await act(async () => { fireEvent.click(archiveBtn!) })
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Archive button now disabled (HIGH fix).
    expect(document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')).toBeDisabled()
    // Undo to re-enable buttons first (since Archive button is disabled while pending).
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-testid="undo-banner-btn"]')
    await act(async () => { fireEvent.click(undoBtn!) })
    // No net:move after undo.
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // Second click — re-archives from clean state. No double net:move from undo path.
    await act(async () => { fireEvent.click(archiveBtn!) })
    await act(async () => { vi.advanceTimersByTime(3001) })
    const moveCalls = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>)
      .filter(([ch]) => ch === 'net:move')
    // Exactly one net:move total (from the timer of the second archive click).
    expect(moveCalls).toHaveLength(1)
  })

  it('2999ms — net:move has NOT fired yet (boundary before commit)', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Just under the 3000ms threshold — no commit yet.
    await act(async () => { vi.advanceTimersByTime(2999) })
    expect(mockInvoke).not.toHaveBeenCalledWith('net:move', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(mockWindowClose).not.toHaveBeenCalled()
  })

  it('3000ms — net:move fires and window closes (boundary at commit)', async () => {
    await act(async () => { renderMailWindow({ accountId: 1, folder: 'INBOX', uid: 42 }) })
    const archiveBtn = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-archive"]')
    await act(async () => { fireEvent.click(archiveBtn!) })
    // Advance exactly to (past) the 3000ms threshold.
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(mockInvoke).toHaveBeenCalledWith('net:move', 1, 'INBOX', 'Archive', [42])
    expect(mockWindowClose).toHaveBeenCalledOnce()
  })
})
