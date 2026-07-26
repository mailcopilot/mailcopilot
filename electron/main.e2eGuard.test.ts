import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * §3.3.C-uiaudit.22 / codex-bg-review HIGH — defense-in-depth guard
 * for renderer-exposed `e2e:*` IPC handlers (`e2e:localizeMails`,
 * `e2e:injectCalendarMail`, `e2e:injectMail`).
 *
 * The production helper lives in `electron/main.ts` as
 * `assertE2EHandlerAllowed(channel)`. We mirror it here rather than
 * importing main.ts directly because main.ts is an 8000+ LoC hotspot with
 * extensive ES-module side effects (registers IPC handlers, opens DB at
 * module load, wires Sentry sinks). The same rationale is documented in
 * `main.openInWindow.test.ts`.
 *
 * If the production guard changes — the truth-table semantics or the
 * Sentry-capture side-effect — mirror the change here.
 *
 * Truth table:
 *
 *   isPackaged  |  MAILCOPILOT_E2E=1  |  outcome
 *   -----------+---------------------+-----------------------------
 *   true       |  true               |  throw + captureException
 *   true       |  false              |  throw + captureException
 *   false      |  true               |  proceed
 *   false      |  false              |  throw (no captureException)
 *
 * Rationale for the four cells:
 *   • `isPackaged === true` is the hard stop. Even if an attacker injects
 *     `MAILCOPILOT_E2E=1` into a shipped binary's runtime env, the handler
 *     refuses. We also fire a Sentry breadcrumb because a benign user
 *     cannot trigger this path.
 *   • `isPackaged === false` is dev / Playwright. Without the env opt-in
 *     we still refuse — keeps the channels off by default during normal
 *     `electron .` development sessions.
 */

const captureExceptionMock = vi.fn()

// Local mirror of the production helper. Keep in lock-step with main.ts.
type AppFlag = { isPackaged: boolean }
function makeAssertE2EHandlerAllowed(isE2E: boolean, app: AppFlag, capture: typeof captureExceptionMock) {
  return function assertE2EHandlerAllowed(channel: string): void {
    if (app.isPackaged) {
      capture(new Error(`${channel} called in packaged build`), {
        source: 'security:e2e_guard',
        channel,
      })
      throw new Error(`${channel} is disabled in packaged builds`)
    }
    if (!isE2E) throw new Error(`${channel} is only available in e2e mode`)
  }
}

beforeEach(() => {
  captureExceptionMock.mockReset()
})

describe('assertE2EHandlerAllowed', () => {
  it('rejects when packaged build AND env opt-in (env-injection attack)', () => {
    const assert = makeAssertE2EHandlerAllowed(/*isE2E=*/ true, { isPackaged: true }, captureExceptionMock)
    expect(() => assert('e2e:injectMail')).toThrow(/disabled in packaged builds/)
    // High-signal anomaly — reported to Sentry with source tag.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const [err, ctx] = captureExceptionMock.mock.calls[0]!
    expect((err as Error).message).toBe('e2e:injectMail called in packaged build')
    expect(ctx).toMatchObject({ source: 'security:e2e_guard', channel: 'e2e:injectMail' })
  })

  it('rejects when packaged build even without env opt-in', () => {
    const assert = makeAssertE2EHandlerAllowed(/*isE2E=*/ false, { isPackaged: true }, captureExceptionMock)
    expect(() => assert('e2e:injectCalendarMail')).toThrow(/disabled in packaged builds/)
    // Still captured — the channel got invoked at all, which should not
    // happen in a packaged build.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock.mock.calls[0]![1]).toMatchObject({
      source: 'security:e2e_guard',
      channel: 'e2e:injectCalendarMail',
    })
  })

  it('rejects when not packaged but env opt-in is missing', () => {
    const assert = makeAssertE2EHandlerAllowed(/*isE2E=*/ false, { isPackaged: false }, captureExceptionMock)
    expect(() => assert('e2e:localizeMails')).toThrow(/only available in e2e mode/)
    // Not an attack — just a regular dev run without the flag. No Sentry.
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('proceeds when not packaged AND env opt-in is set (legitimate Playwright)', () => {
    const assert = makeAssertE2EHandlerAllowed(/*isE2E=*/ true, { isPackaged: false }, captureExceptionMock)
    expect(() => assert('e2e:injectMail')).not.toThrow()
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('uses the channel name in the thrown error so call sites are diagnosable', () => {
    const assert = makeAssertE2EHandlerAllowed(/*isE2E=*/ false, { isPackaged: false }, captureExceptionMock)
    expect(() => assert('e2e:injectMail')).toThrow(/^e2e:injectMail is only available in e2e mode$/)
  })
})
