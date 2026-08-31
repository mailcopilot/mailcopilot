/**
 * §2.124 e2e — proves off-thread EML parsing actually dispatches to the REAL
 * built worker (`dist-electron/eml-parse-worker.js`) in a live Electron
 * process, not just to the fixture worker scripts
 * `packages/net/emlParseOffload.test.ts` drives under vitest.
 *
 * ROUTE. `net:messageDetails` short-circuits under `IS_E2E` (main.ts) before
 * it ever touches a real `.eml`, so the ordinary message-open path is
 * unreachable here. `mail:rsvpInvite` is NOT gated: `resolveInviteForRsvp`
 * (electron/main.ts) tier (b) calls `readEml()` (packages/net/mailStore.ts)
 * and, on a hit, `extractIcsFromRawEml()` (packages/net/eml.ts) — the same
 * dispatch machinery `net:messageDetails` would use, unguarded. This test
 * bypasses the injected e2e mailbox and the renderer UI entirely: it writes
 * a real `.eml` straight into the on-disk cache directory
 * (`<dataDir>/mail/<accountId>/<folder>/<uid>.eml`) and calls
 * `mail:rsvpInvite` directly over the IPC bridge. The RSVP UI flow itself
 * (InviteCard, Accept/Decline buttons) is already covered by
 * `invite-rsvp.spec.ts`, which goes through the e2e mailbox and therefore
 * never reaches tier (b) — this spec exists specifically to reach it.
 *
 * DISCRIMINATOR. `eml.parse_dispatch` (electron/metricsSchema.ts) is
 * deliberately marked `aggregate: false`: unlike every other metric, it
 * writes its local `electron-log` line unconditionally, bypassing both the
 * 10s aggregation buffer and the telemetry consent gate (see the comment on
 * that entry). `electron/logger.ts` turns file logging on whenever
 * `!app.isPackaged` (e2e always runs unpackaged — no extra flag needed), so
 * the line lands in `<dataDir>/logs/main.log`. The assertion that actually
 * distinguishes a live worker from a silently-degraded inline fallback is
 * `worker >= 1 && inline_unavailable === 0` — `worker > 0` alone is not
 * enough, because a broken worker build does not produce an ABSENCE of
 * dispatch events, it produces `inline_unavailable` ones instead.
 *
 * Neither the `UiFreeze` watchdog (measures the single worst event-loop gap,
 * not cumulative time across thousands of microsecond `setImmediate` yields)
 * nor wall-clock timing (only ~10x separation between the worker and inline
 * paths, and flat across fixture sizes) can tell these two states apart —
 * see packages/net/emlWorkerClient.ts for the full measurement writeup.
 * `eml.parse_dispatch` is the only categorical signal that can.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'
import { EML_WORKER_MIN_BYTES, type EmlParsePath } from '../../packages/net/emlWorkerClient'

// accountId=1 matches E2E_ACCOUNTS[0] in electron/main.ts (identity
// e2e1@example.test) — resolveFromForRsvp and sendRsvpEmail both key off it.
const RSVP_ACCOUNT_ID = 1
const RSVP_FOLDER = 'INBOX'
// Arbitrary uid never touched by the injected e2e mailbox (that box's uids
// come from E2E_UID_SEQ / hand-picked fixture uids well below this).
const RSVP_UID = 90210

// Comfortable margin above the threshold so the dispatch decision is not
// sensitive to a few bytes of MIME framing overhead one way or the other —
// the boundary-exactness case is already covered by
// packages/net/emlParseOffload.test.ts ("offloads at exactly the threshold").
const FIXTURE_TARGET_BYTES = EML_WORKER_MIN_BYTES + 16 * 1024

/**
 * A syntactically valid multipart RFC822 message carrying a REQUEST invite,
 * padded with a dedicated attachment part so the raw byte length clears
 * `EML_WORKER_MIN_BYTES`. Padding lives in its own part (not the calendar
 * part, not the body) so it cannot be mistaken for the ics attachment by
 * `extractIcsFromRawEmlInline` (packages/net/eml.ts), which selects the ics
 * part purely by content-type / filename.
 */
function buildLargeInviteEml(targetBytes: number): Buffer {
  const boundary = 'e2e-eml-dispatch-boundary'
  const CRLF = '\r\n'

  const icsBody = [
    'BEGIN:VCALENDAR',
    'PRODID:-//MailCopilot E2E//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:e2e-dispatch-invite-001@example.test',
    'DTSTAMP:20260801T100000Z',
    'DTSTART:20260815T140000Z',
    'DTEND:20260815T150000Z',
    'SUMMARY:E2E Dispatch Fixture Event',
    'ORGANIZER;CN=E2E Organizer:mailto:organizer@example.test',
    'ATTENDEE;CN=E2E One;PARTSTAT=NEEDS-ACTION:mailto:e2e1@example.test',
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF)

  function assemble(filler: string): string {
    return [
      'From: E2E Organizer <organizer@example.test>',
      'To: E2E One <e2e1@example.test>',
      'Subject: eml.parse_dispatch e2e fixture',
      'Date: Sat, 1 Aug 2026 10:00:00 +0000',
      'Message-ID: <e2e-dispatch-fixture@example.test>',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      'This message carries a REQUEST invite plus padding so the raw byte',
      'length clears EML_WORKER_MIN_BYTES and the parse offloads to the',
      'worker thread.',
      '',
      `--${boundary}`,
      'Content-Type: text/calendar; method=REQUEST; charset=UTF-8',
      'Content-Disposition: attachment; filename="invite.ics"',
      'Content-Transfer-Encoding: 7bit',
      '',
      icsBody,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; name="padding.txt"',
      'Content-Disposition: attachment; filename="padding.txt"',
      'Content-Transfer-Encoding: 7bit',
      '',
      filler,
      '',
      `--${boundary}--`,
      '',
    ].join(CRLF)
  }

  // Pure-ASCII filler, so string length === byte length: measure the shell
  // with no filler, then top up to the target exactly (no post-hoc epilogue
  // hacks needed).
  const shellLength = Buffer.byteLength(assemble(''), 'utf8')
  const fillerBytes = Math.max(0, targetBytes - shellLength)
  return Buffer.from(assemble('P'.repeat(fillerBytes)), 'utf8')
}

/** Parses `Metrics eml.parse_dispatch { path: 'worker', size_bucket: '...' }`
 *  lines (electron-log / util.inspect formatting, pretty-printed across
 *  several lines) out of a raw log slice and counts occurrences per path. */
function countDispatchPaths(logText: string): Partial<Record<EmlParsePath, number>> {
  const counts: Partial<Record<EmlParsePath, number>> = {}
  const entryRe = /eml\.parse_dispatch\s*\{([^}]*)\}/g
  let entry: RegExpExecArray | null
  while ((entry = entryRe.exec(logText))) {
    const pathMatch = /path:\s*'([a-zA-Z_]+)'/.exec(entry[1])
    if (!pathMatch) continue
    const p = pathMatch[1] as EmlParsePath
    counts[p] = (counts[p] ?? 0) + 1
  }
  return counts
}

test('eml.parse_dispatch: a real cached .eml above the offload threshold reaches the worker path, not a silent inline fallback', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-eml-dispatch-'))
    const page = ctx.page!
    const dataDir = ctx.dataDir!
    const logPath = path.join(dataDir, 'logs', 'main.log')

    // Snapshot the log offset before touching anything: `initLogger` already
    // wrote its own startup lines (including an unrelated `app.startup_ms`
    // Metrics line) by the time launchApp() resolves, and nothing else in
    // e2e mode parses a real >64KiB .eml on its own (periodic sync and the
    // body indexer both key off DB rows; our fixture has none) — but reading
    // only the delta makes that assumption unnecessary to rely on.
    const baseline = await fs.stat(logPath).then(s => s.size).catch(() => 0)

    const raw = buildLargeInviteEml(FIXTURE_TARGET_BYTES)
    expect(raw.length).toBeGreaterThanOrEqual(EML_WORKER_MIN_BYTES)

    const emlDir = path.join(dataDir, 'mail', String(RSVP_ACCOUNT_ID), RSVP_FOLDER)
    await fs.mkdir(emlDir, { recursive: true })
    await fs.writeFile(path.join(emlDir, `${RSVP_UID}.eml`), raw)

    const result = await page.evaluate(
      async ({ accountId, folder, uid }) => {
        return window.api.invoke('mail:rsvpInvite', {
          accountId,
          folder,
          uid,
          response: 'ACCEPTED',
        })
      },
      { accountId: RSVP_ACCOUNT_ID, folder: RSVP_FOLDER, uid: RSVP_UID },
    )
    // sendMailWithAccountConfig is mocked under IS_E2E (electron/main.ts) and
    // returns { messageId: 'e2e' } synchronously — confirms resolveInvite
    // actually found and parsed the fixture (a miss returns
    // `{ ok: false, error: 'No calendar invite found for this message' }`).
    expect(result).toEqual({ ok: true, messageId: 'e2e' })

    let dispatch: Partial<Record<EmlParsePath, number>> = {}
    await expect.poll(async () => {
      const buf = await fs.readFile(logPath).catch(() => Buffer.alloc(0))
      dispatch = countDispatchPaths(buf.subarray(baseline).toString('utf8'))
      return Object.keys(dispatch).length > 0
    }, { timeout: EXPECT_TIMEOUT }).toBe(true)

    expect(dispatch.worker ?? 0).toBeGreaterThanOrEqual(1)
    expect(dispatch.inline_unavailable ?? 0).toBe(0)
  } finally {
    await cleanupApp(ctx)
  }
})
