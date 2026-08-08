import { describe, it, expect, vi } from 'vitest'

// The service imports the metrics pipeline (Sentry SDK, electron-log). The
// mirror only needs the pure diag builder, so stub the sink.
vi.mock('./metrics', () => ({ recordEvent: vi.fn() }))

import { buildSentCopyAppendDiag } from './services/sentCopyFailure'

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
    // Mirror of the §2.82-iter2 catch block in main.ts — keep verbatim. The
    // diag itself is NOT mirrored any more: it is built by the real service
    // function, which owns the PII boundary, so this test cannot pass while
    // production sends something the builder does not produce.
    const diag = buildSentCopyAppendDiag(e, {
      accountId,
      providerId,
      sentFolder: sentFolderForDiag ?? null,
      rawSize: rawSizeForDiag ?? null,
      messageId: messageId ?? null,
    })
    deps.logWarn('Could not save copy to Sent (diag):', diag)
    const appendErr = new Error(`sent_copy_append_failed: ${diag.reason}`)
    appendErr.name = 'SentCopyAppendError'
    deps.captureException(appendErr, { source: 'sendMail:appendToSent', ...diag })
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

  describe('APPEND failure path — diag block (§2.82 iter2 PII boundary)', () => {
    it('captures a synthetic error with the sanitized diag and the source tag', async () => {
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

      expect(deps.captureException).toHaveBeenCalledTimes(1)
      const [captured, ctx] = deps.captureException.mock.calls[0] as [Error, Record<string, unknown>]
      // The raw ImapFlow rejection must NOT be the captured object — its
      // message and stack are server- and library-authored.
      expect(captured).not.toBe(e)
      expect(captured.name).toBe('SentCopyAppendError')
      expect(captured.message).toBe('sent_copy_append_failed: quota')
      expect(ctx).toMatchObject({
        source: 'sendMail:appendToSent',
        accountId: 7,
        providerId: 'gmail',
        sentFolderRole: 'sent',
        sentFolderLen: 4,
        rawSize: Buffer.byteLength('raw-message-bytes', 'utf8'),
        reason: 'quota',
        errorResponseStatus: 'NO',
        errorServerResponseCode: 'OVERQUOTA',
        errorCommand: 'APPEND',
      })
      // §2.82 iter3 finding 1 — each field is checked against its OWN closed
      // vocabulary, so `NO` (a tagged-response status) is dropped from the
      // socket-error-code field even though it is a real protocol word.
      expect(ctx.errorCode).toBeUndefined()
      // Both sinks get the SAME object.
      expect(deps.logWarn).toHaveBeenCalledWith(
        'Could not save copy to Sent (diag):',
        expect.objectContaining({ reason: 'quota', sentFolderRole: 'sent' }),
      )
    })

    // The regression test for §2.82 iter2 finding 1. Before the fix the folder
    // name, the Message-ID and 500 chars of server response went out verbatim,
    // contradicting the consent screen's unqualified promise about folder names
    // and addresses.
    it('sends neither the folder name, the Message-ID, nor the server response text', async () => {
      const FOLDER = 'Отправленные/2026'
      const MESSAGE_ID = '<abc123@mail.ivanov-family.example>'
      const e = imapErr({
        message: `APPEND failed for mailbox "${FOLDER}": user ivan@example.com over quota`,
        response: `NO [OVERQUOTA] ${FOLDER} exceeded for ivan@example.com`,
        responseText: `${FOLDER} exceeded`,
        responseStatus: 'NO',
      })
      const deps = makeDeps({
        resolveSentFolder: () => Promise.resolve(FOLDER),
        appendToMailbox: () => Promise.reject(e),
      })
      await appendSentCopyMirror(3, 'generic-imap', MESSAGE_ID, deps)

      const [captured, ctx] = deps.captureException.mock.calls[0] as [Error, Record<string, unknown>]
      // Everything that leaves the process for this failure: the exception's
      // own text plus every context value, serialized.
      const outgoing = `${captured.name} ${captured.message} ${JSON.stringify(ctx)}`
      expect(outgoing).not.toContain(FOLDER)
      expect(outgoing).not.toContain('Отправленные')
      expect(outgoing).not.toContain(MESSAGE_ID)
      expect(outgoing).not.toContain('abc123')
      expect(outgoing).not.toContain('ivanov-family')
      expect(outgoing).not.toContain('ivan@example.com')
      expect(outgoing).not.toContain('exceeded')
      // ...and what it DOES carry instead.
      expect(ctx.sentFolderRole).toBe('sent')
      expect(ctx.sentFolderLen).toBe(FOLDER.length)
      expect(ctx.reason).toBe('quota')
      expect(typeof ctx.messageIdHash).toBe('string')
      expect(ctx.messageIdHash).toMatch(/^[0-9a-f]{12}$/)
      expect(typeof ctx.errorTextLen).toBe('number')
    })

    it('never throws on a null rejection (defensive err narrowing)', async () => {
      const deps = makeDeps({ appendToMailbox: () => Promise.reject(null) })
      await expect(appendSentCopyMirror(1, null, null, deps)).resolves.toBeUndefined()
      const diag = deps.captureException.mock.calls[0][1] as Record<string, unknown>
      expect(diag.reason).toBe('unknown')
    })

    it('reports a null folder role and null rawSize when resolution fails before APPEND', async () => {
      const deps = makeDeps({ resolveSentFolder: () => Promise.reject(new Error('Invalid credentials')) })
      await appendSentCopyMirror(2, 'generic-imap', null, deps)
      const diag = deps.captureException.mock.calls[0][1] as Record<string, unknown>
      expect(diag.sentFolderRole).toBeNull()
      expect(diag.sentFolderLen).toBeUndefined()
      expect(diag.rawSize).toBeNull()
    })

    it('reports null rawSize when buildRawMessage fails after folder resolution', async () => {
      const deps = makeDeps({ buildRaw: () => Promise.reject(new Error('compose failed')) })
      await appendSentCopyMirror(2, 'gmail', null, deps)
      const diag = deps.captureException.mock.calls[0][1] as Record<string, unknown>
      expect(diag.sentFolderRole).toBe('sent')
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

    // (c) Module-level import of the service — both entry points.
    expect(src).toMatch(
      /import\s*\{[^}]*reportSentCopyAppendFailure[^}]*\}\s*from\s*['"]\.\/services\/sentCopyFailure['"]/,
    )
    expect(src).toMatch(
      /import\s*\{[^}]*buildSentCopyAppendDiag[^}]*\}\s*from\s*['"]\.\/services\/sentCopyFailure['"]/,
    )
    // (d) §2.82 iter2 — the catch block must build the diag through the
    //     service, never inline. An inline object is how the leak got in.
    expect(src).toMatch(/const diag = buildSentCopyAppendDiag\(e, \{/)

    // Locate the catch-block anchor — this string is unique in the file.
    const anchorIdx = src.indexOf("'sendMail:appendToSent'")
    expect(anchorIdx).toBeGreaterThan(-1)

    // (b) captureException is called immediately before the anchor on the same
    //     line: captureException(e, { source: 'sendMail:appendToSent', ...diag })
    const captureRegion = src.slice(Math.max(0, anchorIdx - 90), anchorIdx + 10)
    expect(captureRegion).toMatch(/captureException\s*\(/)
    // ...and it must capture the SYNTHETIC error, not the raw rejection.
    expect(captureRegion).toContain('appendErr')

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
