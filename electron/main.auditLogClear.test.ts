import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * §3.3.B1.f1 — ai:auditLog:clear handler: main-process confirmation gate
 * (pure unit tests via mirror pattern).
 *
 * `electron/main.ts` registers this handler through `handleIpc`, and the file
 * itself cannot be imported in unit tests (too many side-effects at module
 * level: BrowserWindow creation, IPC registrations, DB open, etc.). We mirror
 * the handler logic verbatim — the same approach used in
 * `main.pendingMoves.test.ts` and `main.drafts.test.ts` — so that:
 *
 *   - The IS_E2E bypass (auto-confirm when MAILCOPILOT_E2E === '1') is pinned.
 *   - Cancel path (response !== 1) returns { ok: false, cancelled: true }
 *     without calling clearAiActionLog.
 *   - Confirm path (response === 1) calls clearAiActionLog and returns
 *     { ok: true, deleted: N }.
 *   - Edge responses: undefined, −1 (window destroyed), 0 (cancel button).
 *   - No-parent branch (BrowserWindow.fromWebContents returns null) still
 *     shows the dialog and respects Cancel / Delete All.
 *   - Telemetry is fire-and-forget — errors inside recordEvent never surface.
 *
 * Any drift between this mirror and the production handler in main.ts is a
 * regression risk. Keep the mirror in sync when modifying the handler.
 */

// ---------------------------------------------------------------------------
// Mirror: ai:auditLog:clear handler logic
// ---------------------------------------------------------------------------
// The production code references `dialog.showMessageBox`, `BrowserWindow`,
// `clearAiActionLog`, `recordEvent`, and `IS_E2E`.  We inject all of them as
// constructor arguments so every test gets a fresh, fully controlled instance.

interface DialogResult {
  response: number
}

interface MockBrowserWindow {
  webContents: unknown
}

class AuditLogClearHandler {
  constructor(
    private readonly isE2E: boolean,
    // Mirrors Electron's dialog.showMessageBox overloads:
    //   (parent, opts) → called when BrowserWindow.fromWebContents returns a window
    //   (opts)         → called when there is no parent window (null result)
    private readonly showMessageBox: ((
      parent: MockBrowserWindow,
      opts: object,
    ) => Promise<DialogResult>) &
      ((opts: object) => Promise<DialogResult>),
    private readonly fromWebContents: (sender: unknown) => MockBrowserWindow | null,
    private readonly clearAiActionLog: () => number,
    private readonly recordEvent: (name: string, tags: object) => void,
  ) {}

  /**
   * Mirrors the production `handleIpc('ai:auditLog:clear', async (e) => { … })`.
   * `sender` corresponds to `e.sender` in the real handler.
   */
  async handle(sender: unknown): Promise<
    | { ok: true; deleted: number }
    | { ok: false; cancelled: true; deleted: 0 }
  > {
    if (!this.isE2E) {
      const parent = this.fromWebContents(sender)
      const result = parent
        ? await this.showMessageBox(parent, {
            type: 'warning',
            title: 'Clear AI audit log',
            message: 'Delete all AI audit log entries?',
            detail:
              'This soft-deletes every entry from the audit log view. ' +
              'Underlying records remain in the local database until ' +
              'automatic rotation removes the oldest (default cap: 10,000 ' +
              'entries). Export the audit log first if you need long-term ' +
              'retention. This action cannot be undone from the UI.',
            buttons: ['Cancel', 'Delete All'],
            defaultId: 0,
            cancelId: 0,
          })
        : await this.showMessageBox({
            type: 'warning',
            title: 'Clear AI audit log',
            message: 'Delete all AI audit log entries?',
            detail:
              'This soft-deletes every entry from the audit log view. ' +
              'Underlying records remain in the local database until ' +
              'automatic rotation removes the oldest (default cap: 10,000 ' +
              'entries). Export the audit log first if you need long-term ' +
              'retention. This action cannot be undone from the UI.',
            buttons: ['Cancel', 'Delete All'],
            defaultId: 0,
            cancelId: 0,
          })
      if (result.response !== 1) {
        return { ok: false as const, cancelled: true as const, deleted: 0 }
      }
    }
    const deleted = this.clearAiActionLog()
    try {
      this.recordEvent('ai.audit.entry_deleted', { scope: 'all' })
    } catch { /* telemetry must never break user-visible behaviour */ }
    return { ok: true as const, deleted }
  }
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const FAKE_SENDER = { webContents: 'fake-sender' }
const FAKE_WINDOW: MockBrowserWindow = { webContents: 'fake-window' }

function makeHandler(opts: {
  isE2E?: boolean
  dialogResponse?: number
  hasParentWindow?: boolean
  clearResult?: number
  recordEvent?: ReturnType<typeof vi.fn>
}): {
  handler: AuditLogClearHandler
  mockShowMessageBox: ReturnType<typeof vi.fn>
  mockClearAiActionLog: ReturnType<typeof vi.fn>
  mockRecordEvent: ReturnType<typeof vi.fn>
  mockFromWebContents: ReturnType<typeof vi.fn>
} {
  const mockShowMessageBox = vi.fn().mockResolvedValue({
    response: opts.dialogResponse ?? 1,
  })
  const mockClearAiActionLog = vi.fn().mockReturnValue(opts.clearResult ?? 5)
  const mockRecordEvent = opts.recordEvent ?? vi.fn()
  const mockFromWebContents = vi.fn().mockReturnValue(
    opts.hasParentWindow === false ? null : FAKE_WINDOW,
  )
  const handler = new AuditLogClearHandler(
    opts.isE2E ?? false,
    mockShowMessageBox,
    mockFromWebContents,
    mockClearAiActionLog,
    mockRecordEvent,
  )
  return { handler, mockShowMessageBox, mockClearAiActionLog, mockRecordEvent, mockFromWebContents }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('main.ts §3.3.B1.f1 — ai:auditLog:clear handler (normal mode)', () => {
  it('returns { ok: true, deleted: N } when user clicks Delete All (response=1)', async () => {
    const { handler, mockClearAiActionLog } = makeHandler({ dialogResponse: 1, clearResult: 7 })

    const result = await handler.handle(FAKE_SENDER)

    expect(result).toEqual({ ok: true, deleted: 7 })
    expect(mockClearAiActionLog).toHaveBeenCalledTimes(1)
  })

  it('returns { ok: false, cancelled: true } when user clicks Cancel (response=0)', async () => {
    const { handler, mockClearAiActionLog } = makeHandler({ dialogResponse: 0 })

    const result = await handler.handle(FAKE_SENDER)

    expect(result).toEqual({ ok: false, cancelled: true, deleted: 0 })
    expect(mockClearAiActionLog).not.toHaveBeenCalled()
  })

  it('does NOT call clearAiActionLog when dialog returns Cancel (response=0)', async () => {
    const { handler, mockClearAiActionLog } = makeHandler({ dialogResponse: 0 })

    await handler.handle(FAKE_SENDER)

    expect(mockClearAiActionLog).not.toHaveBeenCalled()
  })

  it('does NOT call clearAiActionLog when dialog response is undefined (dialog dismissed via Esc)', async () => {
    // On some platforms showMessageBox can resolve with response=undefined when
    // the native dialog is dismissed without clicking a button (window destroyed).
    // The guard `result.response !== 1` catches this — undefined !== 1.
    const mockShowMessageBox = vi.fn().mockResolvedValue({ response: undefined })
    const mockClearAiActionLog = vi.fn().mockReturnValue(0)
    const handler = new AuditLogClearHandler(
      false,
      mockShowMessageBox,
      vi.fn().mockReturnValue(FAKE_WINDOW),
      mockClearAiActionLog,
      vi.fn(),
    )

    const result = await handler.handle(FAKE_SENDER)

    expect(result).toEqual({ ok: false, cancelled: true, deleted: 0 })
    expect(mockClearAiActionLog).not.toHaveBeenCalled()
  })

  it('does NOT call clearAiActionLog when dialog response is −1 (window destroyed)', async () => {
    // Electron docs: showMessageBox can return response=-1 if the parent window
    // is closed while the dialog is open.
    const { handler, mockClearAiActionLog } = makeHandler({ dialogResponse: -1 })

    const result = await handler.handle(FAKE_SENDER)

    expect(result).toEqual({ ok: false, cancelled: true, deleted: 0 })
    expect(mockClearAiActionLog).not.toHaveBeenCalled()
  })

  it('shows the dialog with the parent window when BrowserWindow.fromWebContents returns a window', async () => {
    const { handler, mockShowMessageBox } = makeHandler({ dialogResponse: 1, hasParentWindow: true })

    await handler.handle(FAKE_SENDER)

    // showMessageBox called with the parent window as first arg.
    expect(mockShowMessageBox).toHaveBeenCalledWith(
      FAKE_WINDOW,
      expect.objectContaining({ buttons: ['Cancel', 'Delete All'] }),
    )
  })

  it('shows the dialog with opts-only (no parent arg) when BrowserWindow.fromWebContents returns null', async () => {
    const { handler, mockShowMessageBox } = makeHandler({
      dialogResponse: 1,
      hasParentWindow: false,
    })

    await handler.handle(FAKE_SENDER)

    // Production calls dialog.showMessageBox(opts) — single-argument overload.
    // No null first argument — mirrors electron/main.ts:7529 exactly.
    expect(mockShowMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Cancel', 'Delete All'] }),
    )
  })

  it('records ai.audit.entry_deleted telemetry on confirm', async () => {
    const { handler, mockRecordEvent } = makeHandler({ dialogResponse: 1 })

    await handler.handle(FAKE_SENDER)

    expect(mockRecordEvent).toHaveBeenCalledWith(
      'ai.audit.entry_deleted',
      expect.objectContaining({ scope: 'all' }),
    )
  })

  it('does NOT fire telemetry when user cancels', async () => {
    const { handler, mockRecordEvent } = makeHandler({ dialogResponse: 0 })

    await handler.handle(FAKE_SENDER)

    expect(mockRecordEvent).not.toHaveBeenCalled()
  })

  it('does not surface recordEvent errors to the caller (telemetry fire-and-forget)', async () => {
    const throwingRecordEvent = vi.fn().mockImplementation(() => {
      throw new Error('telemetry outage')
    })
    const { handler } = makeHandler({ dialogResponse: 1, recordEvent: throwingRecordEvent })

    // Must resolve without throwing even though recordEvent throws.
    await expect(handler.handle(FAKE_SENDER)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    )
  })
})

// ---------------------------------------------------------------------------
// E2E bypass (IS_E2E=true) — auto-confirm without dialog
// ---------------------------------------------------------------------------

describe('main.ts §3.3.B1.f1 — ai:auditLog:clear handler (IS_E2E bypass)', () => {
  it('skips the dialog entirely and calls clearAiActionLog when IS_E2E=true', async () => {
    const { handler, mockShowMessageBox, mockClearAiActionLog } = makeHandler({
      isE2E: true,
      clearResult: 3,
    })

    const result = await handler.handle(FAKE_SENDER)

    expect(result).toEqual({ ok: true, deleted: 3 })
    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(mockClearAiActionLog).toHaveBeenCalledTimes(1)
  })

  it('IS_E2E bypass: returns ok:true even when clearAiActionLog returns 0', async () => {
    const { handler } = makeHandler({ isE2E: true, clearResult: 0 })

    const result = await handler.handle(FAKE_SENDER)

    expect(result).toEqual({ ok: true, deleted: 0 })
  })

  it('IS_E2E bypass: still fires telemetry event', async () => {
    const { handler, mockRecordEvent } = makeHandler({ isE2E: true })

    await handler.handle(FAKE_SENDER)

    expect(mockRecordEvent).toHaveBeenCalledWith('ai.audit.entry_deleted', { scope: 'all' })
  })
})

// ---------------------------------------------------------------------------
// Response shape contract (AC: returned shape is stable)
// ---------------------------------------------------------------------------

describe('main.ts §3.3.B1.f1 — ai:auditLog:clear response shape', () => {
  it('confirm path always returns deleted as a number', async () => {
    const { handler } = makeHandler({ dialogResponse: 1, clearResult: 42 })

    const result = await handler.handle(FAKE_SENDER)

    expect(typeof result.deleted).toBe('number')
  })

  it('cancel path always returns deleted: 0', async () => {
    const { handler } = makeHandler({ dialogResponse: 0 })

    const result = await handler.handle(FAKE_SENDER)

    expect(result.deleted).toBe(0)
  })

  it('confirm path has ok: true and no cancelled field', async () => {
    const { handler } = makeHandler({ dialogResponse: 1 })

    const result = await handler.handle(FAKE_SENDER)

    expect(result.ok).toBe(true)
    // `cancelled` must be absent on the confirm path.
    expect('cancelled' in result).toBe(false)
  })

  it('cancel path has ok: false and cancelled: true', async () => {
    const { handler } = makeHandler({ dialogResponse: 0 })

    const result = await handler.handle(FAKE_SENDER)

    expect(result.ok).toBe(false)
    // TypeScript narrows to { cancelled: true } — runtime must agree.
    expect((result as { cancelled?: boolean }).cancelled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// beforeEach guard: tests must be independent
// ---------------------------------------------------------------------------

describe('main.ts §3.3.B1.f1 — isolation: each it() is self-contained', () => {
  let mockClearAiActionLog: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockClearAiActionLog = vi.fn().mockReturnValue(1)
  })

  it('clearAiActionLog call count resets between tests (a)', async () => {
    const handler = new AuditLogClearHandler(
      false,
      vi.fn().mockResolvedValue({ response: 1 }),
      vi.fn().mockReturnValue(FAKE_WINDOW),
      mockClearAiActionLog,
      vi.fn(),
    )
    await handler.handle(FAKE_SENDER)
    expect(mockClearAiActionLog).toHaveBeenCalledTimes(1)
  })

  it('clearAiActionLog call count resets between tests (b)', async () => {
    // If isolation worked, this test starts with a fresh mockClearAiActionLog.
    const handler = new AuditLogClearHandler(
      false,
      vi.fn().mockResolvedValue({ response: 0 }),
      vi.fn().mockReturnValue(FAKE_WINDOW),
      mockClearAiActionLog,
      vi.fn(),
    )
    await handler.handle(FAKE_SENDER)
    // Cancel path → clearAiActionLog NOT called.
    expect(mockClearAiActionLog).not.toHaveBeenCalled()
  })
})
