import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeConsentRecord, TELEMETRY_CONSENT_VERSION } from '../telemetryConsent'
import {
  UPDATE_CHECK_INTERVAL_MS,
  computeAutoDownload,
  createBackgroundUpdateChecks,
  createUpdatePolicy,
  buildUpdateRequestHeaders,
  NEUTRAL_STAGING_USER_ID,
  createUpdateScheduler,
  isBackgroundUpdateCheckAllowed,
  type UpdateCheckSettings,
} from './updateScheduler'

const HOUR = UPDATE_CHECK_INTERVAL_MS
const AT = '2026-11-04T10:00:00.000Z'

const ANSWERED_GRANTED = { telemetryConsent: makeConsentRecord(true, AT) }
const ANSWERED_DENIED = { telemetryConsent: makeConsentRecord(false, AT) }

/**
 * A scheduler wired to a mutable settings object, driven by vitest fake timers.
 * `isAllowed` goes through the REAL `isBackgroundUpdateCheckAllowed`, so the
 * tests exercise the same composition main.ts wires.
 */
function harness(initial: UpdateCheckSettings, accounts = false) {
  const state = { settings: initial, accounts }
  const runCheck = vi.fn()
  const scheduler = createUpdateScheduler({
    isAllowed: () => isBackgroundUpdateCheckAllowed(() => state.settings, () => state.accounts),
    runCheck,
    now: () => Date.now(),
  })
  return { state, runCheck, scheduler }
}

beforeEach(() => { vi.useFakeTimers({ now: new Date(AT) }) })
afterEach(() => { vi.useRealTimers() })

describe('isBackgroundUpdateCheckAllowed', () => {
  const noAccounts = () => false
  const hasAccount = () => true

  it('is false only on a genuine first run: no consent record in any version and no account', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ({}), noAccounts)).toBe(false)
  })

  it('is true after a granted answer for the current version', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ANSWERED_GRANTED, noAccounts)).toBe(true)
  })

  it('is true after a DENIED answer too: the screen was answered, diagnostics are a separate choice', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ANSWERED_DENIED, noAccounts)).toBe(true)
  })

  it('keeps checking for a record from an older disclosure version (the screen asking again does not stop updates)', () => {
    const old = { telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: AT } }
    expect(isBackgroundUpdateCheckAllowed(() => old, noAccounts)).toBe(true)
    expect(TELEMETRY_CONSENT_VERSION).toBeGreaterThan(1)
    const v1 = { telemetryConsent: { granted: false, version: 1, at: AT } }
    expect(isBackgroundUpdateCheckAllowed(() => v1, noAccounts)).toBe(true)
  })

  it('keeps checking for a record of any shape: only its presence matters', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ({ telemetryConsent: { granted: 'yes' } }), noAccounts)).toBe(true)
    expect(isBackgroundUpdateCheckAllowed(() => ({ telemetryConsent: {} }), noAccounts)).toBe(true)
  })

  it('a non-object value is not a record', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ({ telemetryConsent: 'granted' }), noAccounts)).toBe(false)
    expect(isBackgroundUpdateCheckAllowed(() => ({ telemetryConsent: null }), noAccounts)).toBe(false)
  })

  it('a profile with an account but no record (set up before consent existed) keeps checking', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ({}), hasAccount)).toBe(true)
  })

  it('does not consult the account list when a record exists or the user switched checks off', () => {
    const hasAccounts = vi.fn(() => true)
    isBackgroundUpdateCheckAllowed(() => ANSWERED_GRANTED, hasAccounts)
    isBackgroundUpdateCheckAllowed(() => ({ updateCheckEnabled: false }), hasAccounts)
    expect(hasAccounts).not.toHaveBeenCalled()
  })

  it('treats an absent updateCheckEnabled as on (existing profiles keep checking)', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ({ ...ANSWERED_GRANTED }), noAccounts)).toBe(true)
    expect(isBackgroundUpdateCheckAllowed(() => ({ ...ANSWERED_GRANTED, updateCheckEnabled: true }), noAccounts)).toBe(true)
  })

  it('is false when the user switched checks off, with or without a record or account', () => {
    expect(isBackgroundUpdateCheckAllowed(() => ({ ...ANSWERED_GRANTED, updateCheckEnabled: false }), noAccounts)).toBe(false)
    expect(isBackgroundUpdateCheckAllowed(() => ({ ...ANSWERED_DENIED, updateCheckEnabled: false }), noAccounts)).toBe(false)
    expect(isBackgroundUpdateCheckAllowed(() => ({ updateCheckEnabled: false }), hasAccount)).toBe(false)
  })

  it('throws when settings cannot be read, so the caller sends nothing but keeps planning', () => {
    expect(() => isBackgroundUpdateCheckAllowed(() => { throw new Error('store unavailable') }, noAccounts)).toThrow()
  })

  it('throws when the account list cannot be read on the first-run branch', () => {
    expect(() => isBackgroundUpdateCheckAllowed(() => ({}), () => { throw new Error('config unavailable') })).toThrow()
  })
})

describe('computeAutoDownload', () => {
  const cases: Array<[boolean | undefined, boolean | undefined, boolean, boolean]> = []
  for (const auto of [true, false, undefined]) {
    for (const check of [undefined, true, false]) {
      for (const canSelf of [true, false]) {
        cases.push([auto, check, canSelf, auto === true && check !== false && canSelf])
      }
    }
  }

  it.each(cases)('autoUpdateEnabled=%s updateCheckEnabled=%s canSelfUpdate=%s -> %s', (auto, check, canSelf, expected) => {
    const settings: UpdateCheckSettings = {}
    if (auto !== undefined) settings.autoUpdateEnabled = auto
    if (check !== undefined) settings.updateCheckEnabled = check
    expect(computeAutoDownload(settings, canSelf)).toBe(expected)
  })

  it('downloads on its own only when all three hold', () => {
    expect(computeAutoDownload({ autoUpdateEnabled: true }, true)).toBe(true)
    expect(computeAutoDownload({ autoUpdateEnabled: true, updateCheckEnabled: false }, true)).toBe(false)
  })
})

describe('createUpdateScheduler', () => {
  it('(a) setting off: no check at start and none when the hourly timer would fire', () => {
    const { runCheck, scheduler } = harness({ ...ANSWERED_GRANTED, updateCheckEnabled: false })
    scheduler.start()
    expect(runCheck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3 * HOUR)
    expect(runCheck).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('(a) a pending timer that fires after the setting was turned off sends nothing, even without sync()', () => {
    const { state, runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
    // The timer is pending; the setting flips but nobody calls sync().
    state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: false }
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
    // And the schedule does not re-arm itself behind the user's back.
    vi.advanceTimersByTime(5 * HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(a) sync() after turning the setting off cancels the pending timer', () => {
    const { state, runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: false }
    scheduler.sync()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(2 * HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(b) turning the setting on mid-session resumes with a check', () => {
    const { state, runCheck, scheduler } = harness({ ...ANSWERED_GRANTED, updateCheckEnabled: false })
    scheduler.start()
    expect(runCheck).not.toHaveBeenCalled()

    state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: true }
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('(c) on -> off -> on within the hour sends no extra request; resume waits out the interval', () => {
    const { state, runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(20 * 60_000)
    state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: false }
    scheduler.sync()
    vi.advanceTimersByTime(10 * 60_000)
    state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: true }
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(1)

    // 30 minutes have passed since the check: 30 are left, not a fresh hour.
    vi.advanceTimersByTime(30 * 60_000 - 1)
    expect(runCheck).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('(c) repeated toggling cannot produce a request per click', () => {
    const { state, runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    for (let i = 0; i < 10; i++) {
      state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: false }
      scheduler.sync()
      state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: true }
      scheduler.sync()
    }
    expect(runCheck).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('(c) resuming after more than an hour off checks immediately', () => {
    const { state, runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: false }
    scheduler.sync()
    vi.advanceTimersByTime(2 * HOUR)
    state.settings = { ...ANSWERED_GRANTED }
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('(d) fresh profile: runCheck is never called, at start or on the timer', () => {
    const { runCheck, scheduler } = harness({})
    scheduler.start()
    vi.advanceTimersByTime(5 * HOUR)
    scheduler.sync()
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('(d) after a granted answer, sync() starts the check', () => {
    const { state, runCheck, scheduler } = harness({})
    scheduler.start()
    expect(runCheck).not.toHaveBeenCalled()
    state.settings = { ...ANSWERED_GRANTED }
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(d) after a denied answer, sync() starts the check too', () => {
    const { state, runCheck, scheduler } = harness({})
    scheduler.start()
    state.settings = { ...ANSWERED_DENIED }
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(d) answering "no" to the update option on the screen sends nothing at all', () => {
    const { state, runCheck, scheduler } = harness({})
    scheduler.start()
    state.settings = { ...ANSWERED_GRANTED, updateCheckEnabled: false }
    scheduler.sync()
    vi.advanceTimersByTime(3 * HOUR)
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('(d) an old-version record does NOT stop checks: only a genuine first run waits', () => {
    const old = { telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: AT } }
    const { runCheck, scheduler } = harness(old)
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('(d) a profile with an account and no record (pre-consent install) keeps checking', () => {
    const { runCheck, scheduler } = harness({}, true)
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(d) a first run opens as soon as the record is written', () => {
    const { state, runCheck, scheduler } = harness({}, false)
    scheduler.start()
    expect(runCheck).not.toHaveBeenCalled()
    state.settings = { ...ANSWERED_DENIED }
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(e) start() with unreadable settings sends nothing now, and the next tick reads again and checks', () => {
    let broken = true
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => isBackgroundUpdateCheckAllowed(
        () => { if (broken) throw new Error('store unavailable'); return { ...ANSWERED_GRANTED } },
        () => false,
      ),
      runCheck,
    })
    expect(() => scheduler.start()).not.toThrow()
    expect(runCheck).not.toHaveBeenCalled()
    // The schedule was NOT dropped by the failed read.
    expect(vi.getTimerCount()).toBe(1)
    broken = false
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('(e) sync() with unreadable settings keeps planning: no check now, the next tick checks once readable', () => {
    const state = { broken: false, settings: { ...ANSWERED_GRANTED, updateCheckEnabled: false } as UpdateCheckSettings }
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => isBackgroundUpdateCheckAllowed(
        () => { if (state.broken) throw new Error('store unavailable'); return state.settings },
        () => false,
      ),
      runCheck,
    })
    scheduler.start()
    expect(vi.getTimerCount()).toBe(0)

    // The user switches checks on, but the store cannot be read at that moment.
    state.settings = { ...ANSWERED_GRANTED }
    state.broken = true
    expect(() => scheduler.sync()).not.toThrow()
    expect(runCheck).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    state.broken = false
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(e) a failed read at sync() does not cancel a timer that is already pending', () => {
    let broken = false
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => { if (broken) throw new Error('store unavailable'); return true },
      runCheck,
    })
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    broken = true
    scheduler.sync()
    expect(vi.getTimerCount()).toBe(1)
    broken = false
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('(e) a steadily denied state still stops the schedule (unreadable is not denied)', () => {
    let state: 'allowed' | 'denied' = 'allowed'
    const scheduler = createUpdateScheduler({
      isAllowed: () => state === 'allowed',
      runCheck: vi.fn(),
    })
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    state = 'denied'
    scheduler.sync()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('(e) an isAllowed that throws means no check, and does not propagate', () => {
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => { throw new Error('boom') },
      runCheck,
    })
    expect(() => { scheduler.start(); scheduler.sync() }).not.toThrow()
    vi.advanceTimersByTime(2 * HOUR)
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('(e) isAllowed that starts throwing while a timer is pending stops the request at the timer', () => {
    let broken = false
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => { if (broken) throw new Error('store unavailable'); return true },
      runCheck,
    })
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
    broken = true
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(f) sync() before start() does nothing, even when allowed', () => {
    const { runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.sync()
    expect(runCheck).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(2 * HOUR)
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('(f) start() after an early sync() still begins the schedule', () => {
    const { runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.sync()
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('(g) a throwing runCheck does not stop the schedule', () => {
    const { runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    runCheck.mockImplementation(() => { throw new Error('feed unreachable') })
    expect(() => scheduler.start()).not.toThrow()
    expect(runCheck).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(3)
  })

  it('(h) checks at start and then once an hour, not before', () => {
    const { runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOUR - 1)
    expect(runCheck).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(runCheck).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(3 * HOUR)
    expect(runCheck).toHaveBeenCalledTimes(6)
  })

  it('(h) the interval is one hour', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000)
  })

  it('sync() while running neither duplicates the timer nor re-checks', () => {
    const { runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    scheduler.sync()
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('calling start() twice does not double the cadence', () => {
    const { runCheck, scheduler } = harness({ ...ANSWERED_GRANTED })
    scheduler.start()
    scheduler.start()
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })

  it('uses injected timers and clock instead of the globals', () => {
    let nowMs = 1_000
    const handles: Array<{ fn: () => void; ms: number }> = []
    const cleared: unknown[] = []
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => true,
      runCheck,
      now: () => nowMs,
      setTimer: (fn, ms) => { const h = { fn, ms }; handles.push(h); return h },
      clearTimer: h => { cleared.push(h) },
    })
    scheduler.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
    expect(handles).toHaveLength(1)
    expect(handles[0].ms).toBe(HOUR)
    expect(vi.getTimerCount()).toBe(0)
    nowMs += HOUR
    handles[0].fn()
    expect(runCheck).toHaveBeenCalledTimes(2)
    expect(handles).toHaveLength(2)
  })

  it('clears the injected timer when the permission goes away', () => {
    let allowed = true
    const cleared: unknown[] = []
    const scheduler = createUpdateScheduler({
      isAllowed: () => allowed,
      runCheck: vi.fn(),
      now: () => 0,
      setTimer: (fn, ms) => ({ fn, ms }),
      clearTimer: h => { cleared.push(h) },
    })
    scheduler.start()
    allowed = false
    scheduler.sync()
    expect(cleared).toHaveLength(1)
    // A second sync with nothing pending clears nothing more.
    scheduler.sync()
    expect(cleared).toHaveLength(1)
  })
})

describe('createBackgroundUpdateChecks (the wiring main.ts uses)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup(initial: Record<string, unknown>, accountsPresent = false) {
    const settings: Record<string, unknown> = { ...initial }
    const accounts = { value: accountsPresent }
    const checkForUpdates = vi.fn(() => Promise.resolve(null))
    const recordAutoCheck = vi.fn()
    const checks = createBackgroundUpdateChecks({
      readSettings: () => settings,
      hasAccounts: () => accounts.value,
      checkForUpdates,
      recordAutoCheck,
    })
    return { settings, accounts, checkForUpdates, recordAutoCheck, checks }
  }
  const answered = () => ({ telemetryConsent: makeConsentRecord(false, '2026-11-04T00:00:00.000Z') })

  it('fresh profile: nothing is requested at start or hourly until the first-run answer is recorded', async () => {
    const { settings, checkForUpdates, recordAutoCheck, checks } = setup({})
    checks.start()
    await vi.advanceTimersByTimeAsync(3 * UPDATE_CHECK_INTERVAL_MS)
    expect(checkForUpdates).not.toHaveBeenCalled()
    expect(recordAutoCheck).not.toHaveBeenCalled()
    // The answer is persisted, then main calls sync() (onConsentRecorded).
    Object.assign(settings, answered())
    checks.sync()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    expect(recordAutoCheck).toHaveBeenCalledTimes(1)
  })

  it('an existing profile without a first-run record but with an account is not held back', async () => {
    const { checkForUpdates, checks } = setup({}, true)
    checks.start()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('setting off: no request at start or on the timer; turning it on mid-session resumes', async () => {
    const { settings, checkForUpdates, checks } = setup({ ...answered(), updateCheckEnabled: false })
    checks.start()
    await vi.advanceTimersByTimeAsync(2 * UPDATE_CHECK_INTERVAL_MS)
    expect(checkForUpdates).not.toHaveBeenCalled()
    settings.updateCheckEnabled = true
    checks.sync()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('a rejecting updater call does not stop the schedule or surface', async () => {
    const { checkForUpdates, checks } = setup({ ...answered() })
    checkForUpdates.mockRejectedValue(new Error('offline'))
    checks.start()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('the manual path is the updater itself: it is callable while background checks are off', async () => {
    const { checkForUpdates, checks } = setup({ ...answered(), updateCheckEnabled: false })
    checks.start()
    // Manual button => main calls the updater directly, not through the scheduler.
    await checkForUpdates()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('buildUpdateRequestHeaders', () => {
  it('always pins the per-install staging id to a constant, with or without a token', () => {
    expect(buildUpdateRequestHeaders()).toEqual({ 'x-user-staging-id': NEUTRAL_STAGING_USER_ID })
    expect(buildUpdateRequestHeaders('tok')).toEqual({
      'PRIVATE-TOKEN': 'tok',
      'x-user-staging-id': NEUTRAL_STAGING_USER_ID,
    })
    expect(NEUTRAL_STAGING_USER_ID).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('a blocked tick keeps the schedule alive', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('one transient failure to read settings does not silence checks for the session', async () => {
    let failing = false
    const runCheck = vi.fn()
    const s = createUpdateScheduler({
      isAllowed: () => { if (failing) throw new Error('store busy'); return true },
      runCheck,
    })
    s.start()
    expect(runCheck).toHaveBeenCalledTimes(1)
    failing = true
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
    failing = false
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(2)
  })
})

describe('an explicit refusal at a tick ends the schedule (unreadable earlier, denied now)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('start() unreadable arms a retry; the tick reads a refusal and leaves no timer behind', () => {
    const state: { mode: 'unreadable' | 'denied' | 'allowed' } = { mode: 'unreadable' }
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => {
        if (state.mode === 'unreadable') throw new Error('store busy')
        return state.mode === 'allowed'
      },
      runCheck,
    })
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)

    state.mode = 'denied'
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).not.toHaveBeenCalled()
    // Same as sync(): the refusal removes the timer instead of re-arming it.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5 * HOUR)
    expect(runCheck).not.toHaveBeenCalled()

    // Lifting the refusal goes through sync(), as every settings change does.
    state.mode = 'allowed'
    scheduler.sync()
    expect(runCheck).toHaveBeenCalledTimes(1)
  })

  it('an unreadable tick still re-arms (only a refusal ends the schedule)', () => {
    let broken = true
    const runCheck = vi.fn()
    const scheduler = createUpdateScheduler({
      isAllowed: () => { if (broken) throw new Error('store busy'); return true },
      runCheck,
    })
    scheduler.start()
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    broken = false
    vi.advanceTimersByTime(HOUR)
    expect(runCheck).toHaveBeenCalledTimes(1)
  })
})

describe('createUpdatePolicy (what both settings paths call) with the real scheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function wire(initial: Record<string, unknown>, opts: { canSelfUpdate?: boolean } = {}) {
    const settings: Record<string, unknown> = { ...initial }
    const checkForUpdates = vi.fn(() => Promise.resolve(null))
    const checks = createBackgroundUpdateChecks({
      readSettings: () => settings,
      hasAccounts: () => false,
      checkForUpdates,
      recordAutoCheck: vi.fn(),
    })
    let autoDownload = false
    const policy = createUpdatePolicy({
      scheduler: checks,
      canSelfUpdate: opts.canSelfUpdate ?? true,
      getAutoDownload: () => autoDownload,
      setAutoDownload: next => { autoDownload = next },
    })
    return { settings, checkForUpdates, checks, policy, autoDownload: () => autoDownload }
  }
  const answered = () => ({ telemetryConsent: makeConsentRecord(false, AT) })

  it('first-run answer where the policy\'s own settings read throws once: the schedule still starts', async () => {
    const { settings, checkForUpdates, checks, policy } = wire({})
    checks.start()
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(checkForUpdates).not.toHaveBeenCalled()

    // The answer is persisted, then main's onConsentRecorded runs policy.apply(getSettings):
    // that getSettings() read throws this once.
    Object.assign(settings, answered())
    let first = true
    policy.apply(() => { if (first) { first = false; throw new Error('store busy') } return settings })

    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(checkForUpdates).toHaveBeenCalledTimes(4)
  })

  it('a failed read costs only the auto-download flip, which keeps its previous value', () => {
    const { settings, policy, autoDownload } = wire({ ...answered(), autoUpdateEnabled: true })
    policy.apply(() => settings)
    expect(autoDownload()).toBe(true)
    policy.apply(() => { throw new Error('store busy') })
    expect(autoDownload()).toBe(true)
  })

  it('follows the setting: off turns auto-download off and stops the schedule; on restores both', async () => {
    const { settings, checkForUpdates, checks, policy, autoDownload } =
      wire({ ...answered(), autoUpdateEnabled: true })
    checks.start()
    policy.apply(() => settings)
    expect(autoDownload()).toBe(true)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    settings.updateCheckEnabled = false
    policy.apply(() => settings)
    expect(autoDownload()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    settings.updateCheckEnabled = true
    policy.apply(() => settings)
    expect(autoDownload()).toBe(true)
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('never turns auto-download on where the install cannot update itself', () => {
    const { settings, policy, autoDownload } = wire({ ...answered(), autoUpdateEnabled: true }, { canSelfUpdate: false })
    policy.apply(() => settings)
    expect(autoDownload()).toBe(false)
  })
})
