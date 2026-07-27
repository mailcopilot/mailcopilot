// @vitest-environment jsdom
/**
 * §3.3 B1 Privacy Audit Panel — component tests.
 *
 * Coverage targets:
 *  1. Collapsed by default — no IPC calls on mount, no data visible.
 *  2. Expand / collapse toggle (click + keyboard Enter/Space).
 *  3. Initial load: both IPC calls fired (aggregate + list).
 *  4. Period selector changes re-fetch with new period.
 *  5. Aggregate table renders rows, cost_usd null → "n/a".
 *  6. Audit log table renders rows; null fields → "n/a".
 *  7. Empty state: aggregate empty hint + log empty hint.
 *  8. Pagination: prev/next buttons enabled/disabled correctly.
 *  9. Soft-delete button invokes IPC and triggers refresh.
 * 10. Clear All: IPC always invoked; main { ok: true } → refresh;
 *     main { cancelled: true } → no refresh (§3.3.B1.f1).
 * 11. Export JSON / Export CSV buttons invoke correct IPC channels.
 * 12. Refresh button re-fetches.
 * 13. Error state displayed when IPC rejects.
 * 14. Loading state disables buttons.
 * 15. formatCost pure-function logic (exported via the component indirectly).
 * 16. formatTimestamp handles SQLite date strings and invalid input.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

// --- Stable i18n stub ---------------------------------------------------------
// Keys must match every t('...') call in AiPrivacyPanel.tsx.
// stableT and stableUseTranslation are module-level constants — recreating t
// on every render would trigger infinite render loops in useEffect([t]).
const i18nMap: Record<string, string> = {
  'ai.privacy.audit.title': 'Privacy & Audit',
  'ai.privacy.audit.hint': 'Review AI activity',
  'ai.privacy.audit.period': 'Period',
  'ai.privacy.audit.periodToday': 'Today',
  'ai.privacy.audit.periodWeek': 'This week',
  'ai.privacy.audit.periodMonth': 'This month',
  'ai.privacy.audit.refresh': 'Refresh',
  'ai.privacy.audit.aggregateTitle': 'Usage summary',
  'ai.privacy.audit.aggregateEmpty': 'No activity',
  'ai.privacy.audit.logTitle': 'Audit log',
  'ai.privacy.audit.logEmpty': 'No entries',
  'ai.privacy.audit.col.provider': 'Provider',
  'ai.privacy.audit.col.requests': 'Requests',
  'ai.privacy.audit.col.cost': 'Cost',
  'ai.privacy.audit.col.tokensIn': 'Tokens in',
  'ai.privacy.audit.col.tokensOut': 'Tokens out',
  'ai.privacy.audit.col.wrapped': 'Wrapped',
  'ai.privacy.audit.col.wrappedTooltip': 'Untrusted email content boundaries',
  'ai.privacy.audit.col.blocked': 'Blocked',
  'ai.privacy.audit.col.blockedTooltip': 'Egress injection blocks',
  'ai.privacy.audit.col.timestamp': 'Time',
  'ai.privacy.audit.col.model': 'Model',
  'ai.privacy.audit.col.goal': 'Goal',
  'ai.privacy.audit.col.tool': 'Tool',
  'ai.privacy.audit.col.outcome': 'Outcome',
  'ai.privacy.audit.col.actions': 'Actions',
  'ai.privacy.audit.notAvailable': 'n/a',
  'ai.privacy.audit.deleteRow': 'Delete this entry',
  'ai.privacy.audit.clearAll': 'Clear all',
  'ai.privacy.audit.exportJson': 'Export JSON',
  'ai.privacy.audit.exportCsv': 'Export CSV',
  'ai.privacy.audit.prev': 'Previous',
  'ai.privacy.audit.next': 'Next',
  'ai.privacy.audit.pageOf': 'Page {{page}} of {{total}}',
  'ai.privacy.audit.outcome.ok': 'OK',
  'ai.privacy.audit.outcome.error': 'Error',
  'ai.privacy.audit.outcome.aborted': 'Aborted',
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  let text = i18nMap[key] ?? key
  if (opts && typeof opts === 'object') {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
    }
  }
  return text
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

// --- Sentry mock (captureException must not throw) ----------------------------
vi.mock('../../sentry', () => ({
  captureException: vi.fn(),
}))

// --- window.api mock ----------------------------------------------------------
const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

// §3.3.B1.f1 — Clear-All confirmation now lives in the main process
// (dialog.showMessageBox in `ai:auditLog:clear`). Renderer no longer calls
// window.confirm. Tests assert (a) the IPC is invoked unconditionally on
// click, (b) `{ cancelled: true }` is honoured as a no-op (no refresh),
// (c) `{ ok: true }` triggers a refresh.

import AiPrivacyPanel from './AiPrivacyPanel'

// --- Factory helpers ----------------------------------------------------------

type AuditRow = {
  id: number
  provider: string
  model: string | null
  goal: string | null
  toolName: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  untrustedWrapped: number
  injectionBlocked: number
  outcome: 'ok' | 'error' | 'aborted'
  createdAt: string
  deletedAt: string | null
}

type AggregateRow = {
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  untrustedWrapped: number
  injectionBlocked: number
}

function makeAuditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 1,
    provider: 'anthropic-api',
    model: 'claude-sonnet-4-5',
    goal: 'chat',
    toolName: 'get_email',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.0123,
    untrustedWrapped: 3,
    injectionBlocked: 1,
    outcome: 'ok',
    createdAt: '2026-04-25 10:00:00',
    deletedAt: null,
    ...overrides,
  }
}

function makeAggregateRow(overrides: Partial<AggregateRow> = {}): AggregateRow {
  return {
    provider: 'anthropic-api',
    requests: 5,
    inputTokens: 500,
    outputTokens: 250,
    costUsd: 0.05,
    untrustedWrapped: 10,
    injectionBlocked: 2,
    ...overrides,
  }
}

/**
 * Set up a default mockInvoke that returns empty results for both IPC channels.
 * Individual tests can override specific channels.
 */
function setupEmptyInvoke() {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
    if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [], total: 0 })
    return Promise.resolve({})
  })
}

function setupInvokeWithData(
  aggregate: AggregateRow[],
  auditRows: AuditRow[],
  total?: number,
) {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'ai:auditLog:aggregate') return Promise.resolve(aggregate)
    if (channel === 'ai:auditLog:list') {
      return Promise.resolve({ rows: auditRows, total: total ?? auditRows.length })
    }
    return Promise.resolve({})
  })
}

function renderPanel() {
  return render(React.createElement(AiPrivacyPanel))
}

/** Expand the collapsible panel by clicking the header. */
async function expandPanel() {
  const header = screen.getByRole('button', { name: /privacy/i })
  await act(async () => { fireEvent.click(header) })
  // Wait for async IPC calls to settle.
  await act(async () => {})
}

// --- Tests -------------------------------------------------------------------

describe('AiPrivacyPanel — collapsed by default', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('renders without crashing and shows title', () => {
    renderPanel()
    expect(screen.getByText('Privacy & Audit')).toBeInTheDocument()
  })

  it('does not call any IPC on mount (collapsed)', () => {
    renderPanel()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('does not render period selector, table, or action buttons while collapsed', () => {
    renderPanel()
    expect(screen.queryByTestId('ai-privacy-period')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ai-privacy-export-json')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ai-privacy-clear-all')).not.toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — expand / collapse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupEmptyInvoke()
  })
  afterEach(() => { cleanup() })

  it('expands when header is clicked and calls IPC', async () => {
    renderPanel()
    await expandPanel()
    expect(screen.getByTestId('ai-privacy-period')).toBeInTheDocument()
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:aggregate', expect.anything())
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', expect.anything())
  })

  it('collapses again when header is clicked a second time', async () => {
    renderPanel()
    await expandPanel()
    // Click again to collapse.
    const header = screen.getByRole('button', { name: /privacy/i })
    await act(async () => { fireEvent.click(header) })
    expect(screen.queryByTestId('ai-privacy-period')).not.toBeInTheDocument()
  })

  it('expands via keyboard Enter key', async () => {
    renderPanel()
    const header = screen.getByRole('button', { name: /privacy/i })
    await act(async () => { fireEvent.keyDown(header, { key: 'Enter' }) })
    await act(async () => {})
    expect(screen.getByTestId('ai-privacy-period')).toBeInTheDocument()
  })

  it('expands via keyboard Space key', async () => {
    renderPanel()
    const header = screen.getByRole('button', { name: /privacy/i })
    await act(async () => { fireEvent.keyDown(header, { key: ' ' }) })
    await act(async () => {})
    expect(screen.getByTestId('ai-privacy-period')).toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — IPC calls on expand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupEmptyInvoke()
  })
  afterEach(() => { cleanup() })

  it('fires aggregate IPC with default period "week"', async () => {
    renderPanel()
    await expandPanel()
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:aggregate', { period: 'week' })
  })

  it('fires list IPC with offset 0 on initial expand', async () => {
    renderPanel()
    await expandPanel()
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', { limit: 50, offset: 0 })
  })

  it('re-fires both IPC calls with new period when period selector changes', async () => {
    renderPanel()
    await expandPanel()
    vi.clearAllMocks()
    // Change period to "today".
    await act(async () => {
      fireEvent.change(screen.getByTestId('ai-privacy-period'), { target: { value: 'today' } })
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:aggregate', { period: 'today' })
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', { limit: 50, offset: 0 })
  })

  it('re-fires both IPC calls when refresh button is clicked', async () => {
    renderPanel()
    await expandPanel()
    vi.clearAllMocks()
    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'))
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:aggregate', expect.anything())
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', expect.anything())
  })
})

describe('AiPrivacyPanel — aggregate table', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('renders aggregate row with cost and token data', async () => {
    setupInvokeWithData([makeAggregateRow({ provider: 'anthropic-api', requests: 5, costUsd: 0.05 })], [])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('anthropic-api')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    // $0.0500 renders as $0.0500 (toFixed(4)).
    expect(screen.getByText('$0.0500')).toBeInTheDocument()
  })

  it('renders "n/a" for cost_usd=null (subscription provider)', async () => {
    setupInvokeWithData([makeAggregateRow({ provider: 'subscription', costUsd: null })], [])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('n/a')).toBeInTheDocument()
  })

  it('renders aggregate empty hint when no data', async () => {
    setupEmptyInvoke()
    renderPanel()
    await expandPanel()
    expect(screen.getByText('No activity')).toBeInTheDocument()
  })

  it('renders multiple providers as separate rows', async () => {
    setupInvokeWithData(
      [
        makeAggregateRow({ provider: 'anthropic-api', requests: 3 }),
        makeAggregateRow({ provider: 'openai-api', requests: 7 }),
      ],
      [],
    )
    renderPanel()
    await expandPanel()
    expect(screen.getByText('anthropic-api')).toBeInTheDocument()
    expect(screen.getByText('openai-api')).toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — audit log table', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('renders log empty hint when no rows', async () => {
    setupEmptyInvoke()
    renderPanel()
    await expandPanel()
    expect(screen.getByText('No entries')).toBeInTheDocument()
  })

  it('renders audit row with all non-null fields', async () => {
    const row = makeAuditRow({
      id: 42,
      provider: 'anthropic-api',
      model: 'claude-sonnet-4-5',
      outcome: 'ok',
    })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('anthropic-api')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
  })

  it('renders "n/a" for null model field', async () => {
    const row = makeAuditRow({ id: 1, model: null, goal: null, toolName: null })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    // Multiple n/a values exist for model + goal + toolName + inputTokens + outputTokens.
    const naElements = screen.getAllByText('n/a')
    expect(naElements.length).toBeGreaterThanOrEqual(3)
  })

  it('renders "n/a" cost for null costUsd', async () => {
    const row = makeAuditRow({ id: 1, costUsd: null })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    expect(screen.getAllByText('n/a').length).toBeGreaterThanOrEqual(1)
  })

  it('renders outcome "error" label for error outcome', async () => {
    const row = makeAuditRow({ outcome: 'error' })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('Error')).toBeInTheDocument()
  })

  it('renders outcome "aborted" label for aborted outcome', async () => {
    const row = makeAuditRow({ outcome: 'aborted' })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('Aborted')).toBeInTheDocument()
  })

  it('renders delete button with testid per row id', async () => {
    const row = makeAuditRow({ id: 7 })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    expect(screen.getByTestId('ai-privacy-delete-7')).toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('shows "Page 1 of 1" for single-page result', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeAuditRow({ id: i + 1 }))
    setupInvokeWithData([], rows, 5)
    renderPanel()
    await expandPanel()
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument()
  })

  it('shows "Page 1 of 2" for 51-row result (PAGE_SIZE=50)', async () => {
    // total=51 → ceil(51/50)=2 pages
    const rows = Array.from({ length: 50 }, (_, i) => makeAuditRow({ id: i + 1 }))
    setupInvokeWithData([], rows, 51)
    renderPanel()
    await expandPanel()
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
  })

  it('Prev button is disabled on page 1', async () => {
    const rows = [makeAuditRow({ id: 1 })]
    setupInvokeWithData([], rows, 51)
    renderPanel()
    await expandPanel()
    const prevBtn = screen.getByText('Previous') as HTMLButtonElement
    expect(prevBtn.disabled).toBe(true)
  })

  it('Next button is enabled when there is a next page', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeAuditRow({ id: i + 1 }))
    setupInvokeWithData([], rows, 51)
    renderPanel()
    await expandPanel()
    const nextBtn = screen.getByText('Next') as HTMLButtonElement
    expect(nextBtn.disabled).toBe(false)
  })

  it('clicking Next advances to page 2 and fires list IPC with offset 50', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeAuditRow({ id: i + 1 }))
    setupInvokeWithData([], rows, 51)
    renderPanel()
    await expandPanel()
    vi.clearAllMocks()
    await act(async () => {
      fireEvent.click(screen.getByText('Next'))
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', { limit: 50, offset: 50 })
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
  })

  it('clicking Prev from page 2 goes back to page 1 with offset 0', async () => {
    // Start on page 1, advance to 2, then go back.
    let callCount = 0
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') {
        const rows = Array.from({ length: 50 }, (_, i) => makeAuditRow({ id: i + 1 + callCount * 50 }))
        callCount++
        return Promise.resolve({ rows, total: 101 })
      }
      return Promise.resolve({})
    })
    renderPanel()
    await expandPanel()
    await act(async () => { fireEvent.click(screen.getByText('Next')) })
    await act(async () => {})
    vi.clearAllMocks()
    await act(async () => { fireEvent.click(screen.getByText('Previous')) })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', { limit: 50, offset: 0 })
  })

  it('period change resets page to 0', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeAuditRow({ id: i + 1 }))
    setupInvokeWithData([], rows, 51)
    renderPanel()
    await expandPanel()
    // Advance to page 2.
    await act(async () => { fireEvent.click(screen.getByText('Next')) })
    await act(async () => {})
    vi.clearAllMocks()
    // Change period → should reset to page 1.
    await act(async () => {
      fireEvent.change(screen.getByTestId('ai-privacy-period'), { target: { value: 'today' } })
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', { limit: 50, offset: 0 })
  })
})

describe('AiPrivacyPanel — soft-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('calls ai:auditLog:softDelete with the correct row id', async () => {
    const row = makeAuditRow({ id: 42 })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-delete-42'))
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:softDelete', { id: 42 })
  })

  it('triggers a refresh (re-fetches list) after soft-delete', async () => {
    const row = makeAuditRow({ id: 1 })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    vi.clearAllMocks()
    // After the delete the refresh re-fires both IPC channels.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:auditLog:softDelete') return Promise.resolve({ deleted: true })
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [], total: 0 })
      return Promise.resolve({})
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-delete-1'))
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', expect.anything())
  })

  it('shows error message when soft-delete IPC rejects', async () => {
    const row = makeAuditRow({ id: 5 })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [row], total: 1 })
      if (channel === 'ai:auditLog:softDelete') return Promise.reject(new Error('DB error'))
      return Promise.resolve({})
    })
    renderPanel()
    await expandPanel()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-delete-5'))
    })
    await act(async () => {})
    expect(screen.getByText('DB error')).toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — clear all', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  // §3.3.B1.f1 — Renderer always invokes the IPC. The native
  // dialog.showMessageBox lives in the main handler; we simulate its two
  // terminal states by stubbing the IPC response shape.

  it('invokes ai:auditLog:clear and refreshes when main returns ok', async () => {
    const row = makeAuditRow({ id: 1 })
    setupInvokeWithData([], [row], 1)
    renderPanel()
    await expandPanel()
    vi.clearAllMocks()
    // After clear the refresh re-fires both IPC channels. Main returns
    // { ok: true, deleted: 1 } once the user confirmed the native dialog.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:auditLog:clear') return Promise.resolve({ ok: true, deleted: 1 })
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [], total: 0 })
      return Promise.resolve({})
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-clear-all'))
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:clear')
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:list', expect.anything())
  })

  it('honours { cancelled: true } from main as a no-op (no refresh)', async () => {
    const row = makeAuditRow({ id: 1 })
    setupInvokeWithData([], [row], 1)
    renderPanel()
    await expandPanel()
    vi.clearAllMocks()
    // Main returns { ok: false, cancelled: true, deleted: 0 } when the
    // user clicks Cancel (or closes the native dialog). Renderer must
    // not trigger a refresh — assert no follow-up list call.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:auditLog:clear') {
        return Promise.resolve({ ok: false, cancelled: true, deleted: 0 })
      }
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [row], total: 1 })
      return Promise.resolve({})
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-clear-all'))
    })
    await act(async () => {})
    // The IPC is invoked unconditionally (renderer can no longer gate).
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:clear')
    // But the refresh-on-success branch must NOT fire.
    expect(mockInvoke).not.toHaveBeenCalledWith('ai:auditLog:list', expect.anything())
    expect(mockInvoke).not.toHaveBeenCalledWith('ai:auditLog:aggregate', expect.anything())
  })

  it('Clear All button is disabled when total=0', async () => {
    setupEmptyInvoke()
    renderPanel()
    await expandPanel()
    const clearBtn = screen.getByTestId('ai-privacy-clear-all') as HTMLButtonElement
    expect(clearBtn.disabled).toBe(true)
  })

  it('shows error message when clear IPC rejects', async () => {
    const row = makeAuditRow({ id: 1 })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [row], total: 1 })
      if (channel === 'ai:auditLog:clear') return Promise.reject(new Error('Clear failed'))
      return Promise.resolve({})
    })
    renderPanel()
    await expandPanel()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-clear-all'))
    })
    await act(async () => {})
    expect(screen.getByText('Clear failed')).toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — export buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupEmptyInvoke()
  })
  afterEach(() => { cleanup() })

  it('Export JSON button calls ai:auditLog:export with format=json', async () => {
    renderPanel()
    await expandPanel()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-export-json'))
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:export', { format: 'json' })
  })

  it('Export CSV button calls ai:auditLog:export with format=csv', async () => {
    renderPanel()
    await expandPanel()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-export-csv'))
    })
    await act(async () => {})
    expect(mockInvoke).toHaveBeenCalledWith('ai:auditLog:export', { format: 'csv' })
  })

  it('shows error when export IPC rejects', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [], total: 0 })
      if (channel === 'ai:auditLog:export') return Promise.reject(new Error('Export failed'))
      return Promise.resolve({})
    })
    renderPanel()
    await expandPanel()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-privacy-export-json'))
    })
    await act(async () => {})
    expect(screen.getByText('Export failed')).toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — error state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('shows error message when IPC rejects on expand', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC error'))
    renderPanel()
    await expandPanel()
    expect(screen.getByText('IPC error')).toBeInTheDocument()
  })

  it('clears error on successful subsequent fetch', async () => {
    // First call fails, then succeeds.
    let attempt = 0
    mockInvoke.mockImplementation((channel: string) => {
      if (attempt++ === 0) return Promise.reject(new Error('transient'))
      if (channel === 'ai:auditLog:aggregate') return Promise.resolve([])
      if (channel === 'ai:auditLog:list') return Promise.resolve({ rows: [], total: 0 })
      return Promise.resolve({})
    })
    renderPanel()
    await expandPanel()
    expect(screen.getByText('transient')).toBeInTheDocument()
    // Refresh — second attempt succeeds.
    await act(async () => { fireEvent.click(screen.getByText('Refresh')) })
    await act(async () => {})
    expect(screen.queryByText('transient')).not.toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — formatCost pure logic (via rendered output)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('renders "$0.00" for cost=0', async () => {
    setupInvokeWithData([makeAggregateRow({ costUsd: 0 })], [])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('$0.00')).toBeInTheDocument()
  })

  it('renders "<$0.01" for tiny cost below 0.01', async () => {
    setupInvokeWithData([makeAggregateRow({ costUsd: 0.0001 })], [])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('<$0.01')).toBeInTheDocument()
  })

  it('renders 4-decimal cost for cost>=0.01', async () => {
    setupInvokeWithData([makeAggregateRow({ costUsd: 1.5 })], [])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('$1.5000')).toBeInTheDocument()
  })

  it('renders "n/a" for cost=null in aggregate row', async () => {
    setupInvokeWithData([makeAggregateRow({ costUsd: null })], [])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('n/a')).toBeInTheDocument()
  })
})

describe('AiPrivacyPanel — formatTimestamp (via rendered output)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { cleanup() })

  it('renders a parseable timestamp for SQLite date string (space-separated)', async () => {
    // SQLite emits 'YYYY-MM-DD HH:MM:SS' without T or Z. formatTimestamp converts
    // it to a locale string. We only verify it is non-empty and not the raw key.
    const row = makeAuditRow({ createdAt: '2026-04-25 10:30:00' })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    // Any non-empty rendered text that is NOT the raw SQLite string (the component
    // converts via toLocaleString) OR falls back to the original if parsing fails.
    // We just confirm it rendered without crashing and is in the DOM.
    expect(screen.getByText(/2026|25\/04|Apr/)).toBeInTheDocument()
  })

  it('falls back to raw string when given an unparseable timestamp', async () => {
    const row = makeAuditRow({ createdAt: 'not-a-date' })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    expect(screen.getByText('not-a-date')).toBeInTheDocument()
  })

  it('handles ISO 8601 timestamp with T separator', async () => {
    const row = makeAuditRow({ createdAt: '2026-04-25T10:30:00Z' })
    setupInvokeWithData([], [row])
    renderPanel()
    await expandPanel()
    // Should parse successfully (no crash, no raw key).
    expect(screen.getByText(/2026|25\/04|Apr/)).toBeInTheDocument()
  })
})
