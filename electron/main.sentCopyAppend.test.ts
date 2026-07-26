import { describe, it, expect, vi } from 'vitest'

/**
 * §2.23 PR1 — append-copy-to-Sent flow in `sendMailWithAccountConfig`
 * (electron/main.ts). The flow is inline in the main.ts hotspot, so —
 * like main.drafts.test.ts and main.pendingMoves.test.ts — we mirror the
 * control flow and the diag construction verbatim and pin its behaviour:
 *
 *   (a) retroactive coverage of the §2.23 diag block: defensive field
 *       extraction, 500-char capping (codex §2.24 MEDIUM-3), String(e)
 *       fallback, null-safety;
 *   (b) captureException receives `source: 'sendMail:appendToSent'` + diag;
 *   (c) §2.23 PR1 additions: reportSentCopyAppendFailure is invoked from
 *       the catch with the hoisted sentFolder + providerId context;
 *   (d) negative: on a successful APPEND neither the metric/broadcast
 *       reporter nor captureException fires — only `mail:exists`.
 *
 * Any drift between this mirror and the production flow in main.ts is a
 * regression risk — when modifying the catch block there, mirror the
 * change here.
 */

// ─── Mirror: append-to-Sent flow (electron/main.ts, sendMailWithAccountConfig) ─

type ReportCtx = { accountId: number; providerId?: string | null; sentFolder?: string | null }

type AppendFlowDeps = {
  /** Mirrors assertImapAuth + listMailboxes + role resolution → roles.sent. */
  resolveSentFolder: () => Promise<string | undefined>
  /** Mirrors buildRawMessage. */
  buildRaw: () => Promise<string | Buffer>
  /** Mirrors appendToMailbox. */
  appendToMailbox: (folder: string, raw: string | Buffer) => Promise<void>
  broadcast: (channel: string, payload: unknown) => void
  logWarn: (...args: unknown[]) => void
  captureException: (e: unknown, ctx: Record<string, unknown>) => void
  /** Mirrors reportSentCopyAppendFailure from services/sentCopyFailure.ts. */
  report: (e: unknown, ctx: ReportCtx, broadcastFn: (channel: string, payload: unknown) => void) => void
}

async function appendSentCopyMirror(
  accountId: number,
  providerId: string | null,
  messageId: string | null,
  deps: AppendFlowDeps,
): Promise<void> {
  let sentFolderForDiag: string | undefined
  let rawSizeForDiag: number | undefined
  try {
    const sentFolder = await deps.resolveSentFolder()
    sentFolderForDiag = sentFolder
    if (sentFolder) {
      const raw = await deps.buildRaw()
      rawSizeForDiag = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
      await deps.appendToMailbox(sentFolder, raw)
      deps.broadcast('mail:exists', { accountId, path: sentFolder, force: true })
    } else {
      deps.logWarn(`Sent folder not resolved for account=${accountId} provider=${providerId} — APPEND skipped, message delivered via SMTP only`)
    }
  } catch (e) {
    // Mirror of the §2.23 diag block in main.ts — keep verbatim.
    const err = e as {
      code?: unknown
      response?: unknown
      responseStatus?: unknown
      responseText?: unknown
      serverResponseCode?: unknown
      command?: unknown
      message?: unknown
    } | null | undefined
    const pickStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, 500) : undefined
    const diag = {
      accountId,
      providerId: providerId ?? null,
      sentFolder: sentFolderForDiag ?? null,
      rawSize: rawSizeForDiag ?? null,
      messageId: messageId ?? null,
      errorMessage: pickStr(err?.message)
        ?? (e instanceof Error ? e.message : String(e)).slice(0, 500),
      errorCode: pickStr(err?.code),
      errorResponse: pickStr(err?.response),
      errorResponseStatus: pickStr(err?.responseStatus),
      errorResponseText: pickStr(err?.responseText),
      errorServerResponseCode: pickStr(err?.serverResponseCode),
      errorCommand: pickStr(err?.command),
    }
    deps.logWarn('Could not save copy to Sent (diag):', diag)
    deps.captureException(e, { source: 'sendMail:appendToSent', ...diag })
    // §2.23 PR1 — mirror of the reportSentCopyAppendFailure call.
    deps.report(e, {
      accountId,
      providerId,
      sentFolder: sentFolderForDiag ?? null,
    }, deps.broadcast)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<AppendFlowDeps> = {}): AppendFlowDeps & {
  broadcast: ReturnType<typeof vi.fn>
  logWarn: ReturnType<typeof vi.fn>
  captureException: ReturnType<typeof vi.fn>
  report: ReturnType<typeof vi.fn>
} {
  return {
    resolveSentFolder: () => Promise.resolve('Sent'),
    buildRaw: () => Promise.resolve('raw-message-bytes'),
    appendToMailbox: () => Promise.resolve(),
    broadcast: vi.fn(),
    logWarn: vi.fn(),
    captureException: vi.fn(),
    report: vi.fn(),
    ...overrides,
  } as never
}

function imapErr(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? 'Command failed')), fields)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('append-copy-to-Sent flow (mirror of main.ts sendMailWithAccountConfig)', () => {
  describe('success path (negative case for §2.23 PR1)', () => {
    it('broadcasts only mail:exists — no metric/broadcast reporter, no captureException', async () => {
      const deps = makeDeps()
      await appendSentCopyMirror(5, 'gmail', '<id@host>', deps)
      expect(deps.broadcast).toHaveBeenCalledTimes(1)
      expect(deps.broadcast).toHaveBeenCalledWith('mail:exists', { accountId: 5, path: 'Sent', force: true })
      expect(deps.report).not.toHaveBeenCalled()
      expect(deps.captureException).not.toHaveBeenCalled()
      expect(deps.logWarn).not.toHaveBeenCalled()
    })
  })

  describe('no Sent folder resolved', () => {
    it('logs a warning and skips APPEND, reporter and capture entirely', async () => {
      const appendToMailbox = vi.fn()
      const deps = makeDeps({ resolveSentFolder: () => Promise.resolve(undefined), appendToMailbox })
      await appendSentCopyMirror(5, 'generic-imap', null, deps)
      expect(appendToMailbox).not.toHaveBeenCalled()
      expect(deps.logWarn).toHaveBeenCalledTimes(1)
      expect(String(deps.logWarn.mock.calls[0][0])).toContain('Sent folder not resolved')
      expect(deps.broadcast).not.toHaveBeenCalled()
      expect(deps.report).not.toHaveBeenCalled()
      expect(deps.captureException).not.toHaveBeenCalled()
    })
  })

  describe('APPEND failure path — diag block (retroactive §2.23 coverage)', () => {
    it('extracts every ImapFlow error field into diag and captures with source', async () => {
      const e = imapErr({
        message: 'Command failed',
        code: 'NO',
        response: 'NO [OVERQUOTA] Quota exceeded',
        responseStatus: 'NO',
        responseText: 'Quota exceeded',
        serverResponseCode: 'OVERQUOTA',
        command: 'APPEND',
      })
      const deps = makeDeps({ appendToMailbox: () => Promise.reject(e) })
      await appendSentCopyMirror(7, 'gmail', '<mid@host>', deps)

      const expectedDiag = {
        accountId: 7,
        providerId: 'gmail',
        sentFolder: 'Sent',
        rawSize: Buffer.byteLength('raw-message-bytes', 'utf8'),
        messageId: '<mid@host>',
        errorMessage: 'Command failed',
        errorCode: 'NO',
        errorResponse: 'NO [OVERQUOTA] Quota exceeded',
        errorResponseStatus: 'NO',
        errorResponseText: 'Quota exceeded',
        errorServerResponseCode: 'OVERQUOTA',
        errorCommand: 'APPEND',
      }
      expect(deps.logWarn).toHaveBeenCalledWith('Could not save copy to Sent (diag):', expectedDiag)
      expect(deps.captureException).toHaveBeenCalledTimes(1)
      expect(deps.captureException).toHaveBeenCalledWith(e, {
        source: 'sendMail:appendToSent',
        ...expectedDiag,
      })
    })

    it('caps every string field at 500 chars (codex §2.24 MEDIUM-3)', async () => {
      const long = 'x'.repeat(601)
      const e = imapErr({ message: long, response: long, responseText: long })
      const deps = makeDeps({ appendToMailbox: () => Promise.reject(e) })
      await appendSentCopyMirror(1, 'outlook', null, deps)
      const diag = deps.captureException.mock.calls[0][1] as Record<string, string>
      expect(diag.errorMessage).toHaveLength(500)
      expect(diag.errorResponse).toHaveLength(500)
      expect(diag.errorResponseText).toHaveLength(500)
    })

    it('falls back to capped String(e) for non-Error throwables', async () => {
      const deps = makeDeps({ appendToMailbox: () => Promise.reject('boom-' + 'y'.repeat(600)) })
      await appendSentCopyMirror(1, null, null, deps)
      const diag = deps.captureException.mock.calls[0][1] as Record<string, unknown>
      expect(diag.errorMessage).toHaveLength(500)
      expect(String(diag.errorMessage).startsWith('boom-')).toBe(true)
      expect(diag.errorCode).toBeUndefined()
    })

    it('never throws on a null rejection (defensive err narrowing)', async () => {
      const deps = makeDeps({ appendToMailbox: () => Promise.reject(null) })
      await expect(appendSentCopyMirror(1, null, null, deps)).resolves.toBeUndefined()
      const diag = deps.captureException.mock.calls[0][1] as Record<string, unknown>
      expect(diag.errorMessage).toBe('null')
    })

    it('reports null sentFolder/rawSize when resolution fails before APPEND', async () => {
      const deps = makeDeps({ resolveSentFolder: () => Promise.reject(new Error('Invalid credentials')) })
      await appendSentCopyMirror(2, 'generic-imap', null, deps)
      const diag = deps.captureException.mock.calls[0][1] as Record<string, unknown>
      expect(diag.sentFolder).toBeNull()
      expect(diag.rawSize).toBeNull()
    })

    it('reports null rawSize when buildRawMessage fails after folder resolution', async () => {
      const deps = makeDeps({ buildRaw: () => Promise.reject(new Error('compose failed')) })
      await appendSentCopyMirror(2, 'gmail', null, deps)
      const diag = deps.captureException.mock.calls[0][1] as Record<string, unknown>
      expect(diag.sentFolder).toBe('Sent')
      expect(diag.rawSize).toBeNull()
    })
  })

  describe('APPEND failure path — §2.23 PR1 reporter wiring', () => {
    it('invokes the reporter with the original error, hoisted context and broadcast fn', async () => {
      const e = imapErr({ serverResponseCode: 'OVERQUOTA' })
      const deps = makeDeps({ appendToMailbox: () => Promise.reject(e) })
      await appendSentCopyMirror(9, 'gmail', '<mid@host>', deps)
      expect(deps.report).toHaveBeenCalledTimes(1)
      expect(deps.report).toHaveBeenCalledWith(
        e,
        { accountId: 9, providerId: 'gmail', sentFolder: 'Sent' },
        deps.broadcast,
      )
      // mail:exists must NOT fire on the failure path.
      expect(deps.broadcast).not.toHaveBeenCalledWith('mail:exists', expect.anything())
    })

    it('passes sentFolder: null to the reporter when resolution never happened', async () => {
      const deps = makeDeps({ resolveSentFolder: () => Promise.reject(new Error('ECONNRESET')) })
      await appendSentCopyMirror(4, 'outlook', null, deps)
      expect(deps.report).toHaveBeenCalledWith(
        expect.any(Error),
        { accountId: 4, providerId: 'outlook', sentFolder: null },
        deps.broadcast,
      )
    })
  })
})

// ─── Mirror-drift tripwire ────────────────────────────────────────────────────
//
// Guard against the production wiring in electron/main.ts drifting from the
// mirror above without triggering test failures. sendMailWithAccountConfig is
// a private function inside the hotspot and cannot be imported, but we CAN read
// the source as text and pin the three structural tokens the mirror encodes.
//
// Follows the §1.4 part 3 pattern (see mailboxesAndRolesInflight.test.ts).

describe('mirror-drift tripwire — production wiring in electron/main.ts', () => {
  it('contains all three key structural tokens for the APPEND catch block', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, 'main.ts'), 'utf8')

    // (c) Module-level import of the service.
    expect(src).toMatch(
      /import\s*\{[^}]*reportSentCopyAppendFailure[^}]*\}\s*from\s*['"]\.\/services\/sentCopyFailure['"]/,
    )

    // Locate the catch-block anchor — this string is unique in the file.
    const anchorIdx = src.indexOf("'sendMail:appendToSent'")
    expect(anchorIdx).toBeGreaterThan(-1)

    // (b) captureException is called immediately before the anchor on the same
    //     line: captureException(e, { source: 'sendMail:appendToSent', ...diag })
    const captureRegion = src.slice(Math.max(0, anchorIdx - 60), anchorIdx + 10)
    expect(captureRegion).toMatch(/captureException\s*\(/)

    // (a) reportSentCopyAppendFailure follows captureException in the same
    //     catch block — within ~500 chars after the anchor.
    const reportRegion = src.slice(anchorIdx, anchorIdx + 500)
    expect(reportRegion).toMatch(/reportSentCopyAppendFailure\s*\(/)
  })
})

// ─── Preload listen-only pin ──────────────────────────────────────────────────
//
// mail:sentCopyFailed must be in ALLOWED_LISTEN_CHANNELS (renderer subscribes
// to it for the "delivered, but no Sent copy" toast) but must NOT appear in
// ALLOWED_INVOKE_CHANNELS (it is a unidirectional push from main to renderer —
// the renderer must never invoke main through this channel).

describe('preload listen-only pin — mail:sentCopyFailed channel whitelist', () => {
  it('mail:sentCopyFailed is listed inside ALLOWED_LISTEN_CHANNELS', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, 'preload.ts'), 'utf8')
    const listenIdx = src.indexOf('const ALLOWED_LISTEN_CHANNELS')
    expect(listenIdx).toBeGreaterThan(-1)
    // Read up to 3000 chars from the array start — enough to cover the full array.
    const listenRegion = src.slice(listenIdx, listenIdx + 3000)
    expect(listenRegion).toContain("'mail:sentCopyFailed'")
  })

  it('mail:sentCopyFailed is NOT listed inside ALLOWED_INVOKE_CHANNELS', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, 'preload.ts'), 'utf8')
    const invokeIdx = src.indexOf('const ALLOWED_INVOKE_CHANNELS')
    const listenIdx = src.indexOf('const ALLOWED_LISTEN_CHANNELS')
    expect(invokeIdx).toBeGreaterThan(-1)
    // The invoke array is declared before the listen array in the file.
    expect(listenIdx).toBeGreaterThan(invokeIdx)
    // Extract exactly the invoke-channels region.
    const invokeRegion = src.slice(invokeIdx, listenIdx)
    expect(invokeRegion).not.toContain("'mail:sentCopyFailed'")
  })
})
