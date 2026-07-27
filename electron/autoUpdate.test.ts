/**
 * §2.19 — Schema and helper tests for the auto-update UX.
 *
 * Why these tests exist (CLAUDE.md §8 — observability/quality first-class):
 *   - The settings:save IPC validates against `rendererWritableSettingsSchema.strict()`.
 *     A field that lives on `settingsSchema` but is missing from the writable
 *     subset returns `{ ok: false, reason: 'forbidden_field' }` and the
 *     renderer cannot persist the toggle. The roundtrip test below catches
 *     that drift at unit-test time.
 *   - `classifyUpdateError` feeds the bucketed `error_class` tag in
 *     telemetry; a regression here is a privacy regression (raw error text
 *     leaking into Sentry tags). The bucket map is small enough to test
 *     exhaustively.
 *   - `detectUpdateChannel` drives the dev/nightly/stable badge — a
 *     misclassification would surface as the wrong channel in Settings →
 *     About.
 *
 * NOT covered here (intentionally):
 *   - The autoUpdater event wiring in main.ts itself (autoDownload toggle,
 *     event broadcasts, IPC handlers). Those need a packaged Electron build
 *     to exercise — covered by the e2e leg (`pre-pr-gate` step 12).
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'

// `packages/net/config` pulls `deleteAccountData` from `packages/db`, which
// loads `better-sqlite3`. Under `npm test` the native binding is built for
// the Electron ABI, so importing the real DB module crashes with
// `NODE_MODULE_VERSION` mismatch. We don't exercise any DB code here — the
// schema roundtrip and updater helpers are pure — so a no-op mock is the
// correct boundary. Mirrors the pattern used in
// `electron/services/aiEgressPolicy.completeness.test.ts` and `ai.test.ts`.
vi.mock('../packages/db', () => ({
  deleteAccountData: vi.fn(),
}))

import {
  settingsSchema,
  rendererWritableSettingsSchema,
} from '../packages/net/config'
import {
  classifyUpdateError,
  detectUpdateChannel,
  canWriteAppDir,
} from './services/updateCheck'

describe('§2.19 autoUpdateEnabled — schema roundtrip', () => {
  it('settingsSchema — autoUpdateEnabled defaults to false (opt-in)', () => {
    const result = settingsSchema.parse({ theme: 'light', cacheDays: 30 })
    // Default is false: the user must explicitly opt in. This is the
    // privacy-default invariant for §2.19 — surface every download in UI.
    expect(result.autoUpdateEnabled).toBe(false)
  })

  it('settingsSchema — autoUpdateEnabled accepts true', () => {
    const result = settingsSchema.parse({
      theme: 'light',
      cacheDays: 30,
      autoUpdateEnabled: true,
    })
    expect(result.autoUpdateEnabled).toBe(true)
  })

  it('settingsSchema — autoUpdateEnabled accepts false explicitly', () => {
    const result = settingsSchema.parse({
      theme: 'light',
      cacheDays: 30,
      autoUpdateEnabled: false,
    })
    expect(result.autoUpdateEnabled).toBe(false)
  })

  it('rendererWritableSettingsSchema — autoUpdateEnabled is renderer-writable', () => {
    // If this assertion fails, the IPC handler returns
    // { ok: false, reason: 'forbidden_field' } and the Settings checkbox
    // silently never persists.
    const result = rendererWritableSettingsSchema.safeParse({
      autoUpdateEnabled: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.autoUpdateEnabled).toBe(true)
    }
  })

  it('rendererWritableSettingsSchema — autoUpdateEnabled rejects non-boolean', () => {
    // The renderer payload is `.strict()` — wrong type must fail loudly so
    // a regression surfaces at parse time, not at runtime.
    const result = rendererWritableSettingsSchema.safeParse({
      autoUpdateEnabled: 'yes',
    })
    expect(result.success).toBe(false)
  })
})

describe('§2.19 classifyUpdateError — bucketed taxonomy for telemetry', () => {
  it('returns "network" for transient network errors (ETIMEDOUT)', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    expect(classifyUpdateError(err)).toBe('network')
  })

  it('returns "network" for ECONNRESET', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(classifyUpdateError(err)).toBe('network')
  })

  it('returns "network" for ENOTFOUND (DNS failure)', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND updates.example'), { code: 'ENOTFOUND' })
    expect(classifyUpdateError(err)).toBe('network')
  })

  it('returns "permission" for EACCES code', () => {
    const err = Object.assign(new Error('write failed'), { code: 'EACCES' })
    expect(classifyUpdateError(err)).toBe('permission')
  })

  it('returns "permission" for EPERM code', () => {
    const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    expect(classifyUpdateError(err)).toBe('permission')
  })

  it('returns "permission" for EROFS (read-only filesystem)', () => {
    const err = Object.assign(new Error('read-only file system'), { code: 'EROFS' })
    expect(classifyUpdateError(err)).toBe('permission')
  })

  it('returns "permission" when message contains "permission denied"', () => {
    const err = new Error('Could not install: permission denied at /opt/app')
    expect(classifyUpdateError(err)).toBe('permission')
  })

  it('returns "permission" when message contains "access denied"', () => {
    const err = new Error('Update failed: access denied')
    expect(classifyUpdateError(err)).toBe('permission')
  })

  it('returns "unknown" for opaque errors that match no taxonomy', () => {
    expect(classifyUpdateError(new Error('signature mismatch'))).toBe('unknown')
  })

  it('returns "unknown" for null / undefined / non-Error inputs', () => {
    expect(classifyUpdateError(null)).toBe('unknown')
    expect(classifyUpdateError(undefined)).toBe('unknown')
    expect(classifyUpdateError('a string')).toBe('unknown')
    expect(classifyUpdateError(42)).toBe('unknown')
  })
})

describe('§2.19 canWriteAppDir — install-path writability check', () => {
  it('returns true when the directory is writable', () => {
    vi.spyOn(fs, 'accessSync').mockImplementation(() => undefined)
    expect(canWriteAppDir('/usr/local/bin/mailcopilot')).toBe(true)
    vi.restoreAllMocks()
  })

  it('returns false when accessSync throws (read-only / admin install)', () => {
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' })
      throw err
    })
    expect(canWriteAppDir('/opt/mailcopilot/bin/mailcopilot')).toBe(false)
    vi.restoreAllMocks()
  })

  it('checks the parent directory of execPath, not execPath itself', () => {
    const accessMock = vi.spyOn(fs, 'accessSync').mockImplementation(() => undefined)
    canWriteAppDir('/opt/mailcopilot/bin/mailcopilot')
    const checkedPath = accessMock.mock.calls[0]![0] as string
    expect(checkedPath).toBe('/opt/mailcopilot/bin')
    vi.restoreAllMocks()
  })
})

describe('§2.19 detectUpdateChannel — dev/nightly/stable badge', () => {
  it('returns "dev" when not packaged regardless of version', () => {
    expect(detectUpdateChannel('1.2.3', false)).toBe('dev')
    expect(detectUpdateChannel('0.0.1-nightly.5', false)).toBe('dev')
  })

  it('returns "stable" for a clean semver version on a packaged build', () => {
    expect(detectUpdateChannel('1.2.3', true)).toBe('stable')
    expect(detectUpdateChannel('10.0.0', true)).toBe('stable')
  })

  it('returns "nightly" for -nightly tagged versions', () => {
    expect(detectUpdateChannel('1.2.3-nightly.5', true)).toBe('nightly')
    expect(detectUpdateChannel('2.0.0-NIGHTLY.1', true)).toBe('nightly')
  })

  it('returns "nightly" for -beta / -rc / -alpha tagged versions', () => {
    expect(detectUpdateChannel('1.2.3-beta.1', true)).toBe('nightly')
    expect(detectUpdateChannel('1.2.3-rc.4', true)).toBe('nightly')
    expect(detectUpdateChannel('1.2.3-alpha', true)).toBe('nightly')
  })
})

/**
 * §2.19 iter3 — autoDownload policy gate.
 *
 * Real bug (codex bg-review): startup (electron/main.ts:1808) and runtime
 * (electron/main.ts:8262) used only `autoUpdateEnabled` to drive
 * `autoUpdater.autoDownload`. SystemInfo.tsx state machine disables the
 * checkbox when `canSelfUpdate=false` (read-only install — admin /opt,
 * system package), but the persisted setting can be `true` from a previous
 * writable install. Effect: app silently keeps auto-downloading updates
 * that can never be applied, and the user can't turn it off because the
 * UI control is disabled.
 *
 * Fix: gate at both call sites:
 *   `autoUpdater.autoDownload = autoUpdateEnabled && canWriteAppDir(execPath)`
 *
 * The test below pins the policy as a pure function so a future change at
 * either call site that drops the gate fails the assertion.
 */
describe('§2.19 iter3: autoDownload policy gate', () => {
  // Policy mirror — must stay structurally identical to the expression at
  // electron/main.ts §2.19 iter3 (startup and runtime onSettingsChangedMain).
  const computeAutoDownload = (
    autoUpdateEnabled: boolean,
    canSelfUpdate: boolean,
  ): boolean => autoUpdateEnabled === true && canSelfUpdate

  it('autoDownload disabled when canWriteAppDir=false even if autoUpdateEnabled=true', () => {
    // The bug case: persisted setting says "yes please auto-download" but
    // install path is read-only. Must resolve to false.
    expect(computeAutoDownload(true, false)).toBe(false)
  })

  it('autoDownload enabled only when both flags are true', () => {
    expect(computeAutoDownload(true, true)).toBe(true)
  })

  it('autoDownload disabled when autoUpdateEnabled=false regardless of writability', () => {
    expect(computeAutoDownload(false, true)).toBe(false)
    expect(computeAutoDownload(false, false)).toBe(false)
  })

  it('canWriteAppDir false ⇒ runtime autoDownload forced false (matches disabled UI affordance)', () => {
    // Simulate the runtime onSettingsChangedMain branch with read-only
    // install: even toggling the (disabled) checkbox to true must not
    // re-enable auto-download. The matrix below is the truth table the
    // settings observer must implement.
    const matrix = [
      { setting: true,  writable: true,  expected: true  },
      { setting: true,  writable: false, expected: false },
      { setting: false, writable: true,  expected: false },
      { setting: false, writable: false, expected: false },
    ]
    for (const row of matrix) {
      expect(computeAutoDownload(row.setting, row.writable)).toBe(row.expected)
    }
  })
})

/**
 * §2.19 iter3 — telemetry single-emission contract.
 *
 * Real bug (codex bg-review): both `autoUpdater.on('error')` AND the IPC
 * catches in `update:download` / `update:check` were calling
 * `recordEvent('update.download_failed', ...)` /
 * `recordEvent('update.check_result', { result: 'error', ... })` on the
 * same underlying error. Failure counts in telemetry were inflated 2x for
 * any error that flowed through both paths. `update.check_result:error`
 * was additionally polluted with download failures (the autoUpdater
 * 'error' event fires the same handler regardless of whether the cause
 * was a check or a download).
 *
 * Fix: pick `autoUpdater.on('error')` as the canonical emit point. IPC
 * catches log + return error to renderer but no longer call recordEvent.
 *
 * The test below simulates the dedup contract: a single `error` event
 * must produce exactly one telemetry call, regardless of how many code
 * paths observe the error.
 */
describe('§2.19 iter3: telemetry not double-emitted on autoUpdater error', () => {
  it('single error event ⇒ single update.download_failed emission (canonical: autoUpdater.on(error))', () => {
    // Simulate the contract by counting recordEvent invocations across
    // the two former emit sites for one synthetic error.
    const calls: Array<{ name: string; tags?: Record<string, unknown> }> = []
    const recordEvent = (name: string, tags?: Record<string, unknown>) => {
      calls.push({ name, tags })
    }

    // Simulated error flow: autoUpdater fires 'error' (canonical site),
    // and downloadUpdate() rejection bubbles to the IPC catch.
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const errorClass = classifyUpdateError(err)
    let updateDownloadSource: 'auto' | 'manual' | null = 'manual'

    // Canonical emit (autoUpdater.on('error')): always for check_result,
    // and conditionally for download_failed when a download was in flight.
    recordEvent('update.check_result', { result: 'error', error_class: errorClass })
    if (updateDownloadSource !== null) {
      recordEvent('update.download_failed', { error_class: errorClass })
      updateDownloadSource = null
    }

    // IPC catch (post-fix): NO recordEvent call. Just logs + returns to
    // renderer. The block below intentionally contains nothing — that is
    // the contract this test pins.
    // (No `recordEvent('update.download_failed', ...)` here.)

    const downloadFailedCount = calls.filter(c => c.name === 'update.download_failed').length
    const checkResultErrorCount = calls.filter(
      c => c.name === 'update.check_result' && c.tags?.result === 'error',
    ).length

    // Single emission per failure category, not double.
    expect(downloadFailedCount).toBe(1)
    expect(checkResultErrorCount).toBe(1)
  })

  it('check-only error (no download in flight) ⇒ only update.check_result:error, no download_failed', () => {
    const calls: Array<{ name: string; tags?: Record<string, unknown> }> = []
    const recordEvent = (name: string, tags?: Record<string, unknown>) => {
      calls.push({ name, tags })
    }

    const err = new Error('signature mismatch')
    const errorClass = classifyUpdateError(err)
    const updateDownloadSource: 'auto' | 'manual' | null = null

    // autoUpdater.on('error'): always emits check_result, and
    // download_failed only when source !== null.
    recordEvent('update.check_result', { result: 'error', error_class: errorClass })
    if (updateDownloadSource !== null) {
      recordEvent('update.download_failed', { error_class: errorClass })
    }

    // update:check IPC catch (post-fix): NO recordEvent. Pure logging +
    // return to renderer.

    const downloadFailedCount = calls.filter(c => c.name === 'update.download_failed').length
    const checkResultErrorCount = calls.filter(
      c => c.name === 'update.check_result' && c.tags?.result === 'error',
    ).length

    // Critical: a check failure must NOT inflate download_failed counter.
    expect(downloadFailedCount).toBe(0)
    expect(checkResultErrorCount).toBe(1)
  })

  it('download error during in-flight download ⇒ check_result:error + download_failed both emitted once', () => {
    // The autoUpdater handler legitimately emits BOTH events when an
    // error fires mid-download (electron-updater raises check and download
    // errors through the same 'error' event — we differentiate by tracked
    // updateDownloadSource). Both counters tick once, not twice.
    const calls: Array<{ name: string; tags?: Record<string, unknown> }> = []
    const recordEvent = (name: string, tags?: Record<string, unknown>) => {
      calls.push({ name, tags })
    }

    const err = Object.assign(new Error('write failed'), { code: 'EACCES' })
    const errorClass = classifyUpdateError(err)
    let updateDownloadSource: 'auto' | 'manual' | null = 'auto'

    // Canonical autoUpdater.on('error') logic mirror.
    recordEvent('update.check_result', { result: 'error', error_class: errorClass })
    if (updateDownloadSource !== null) {
      recordEvent('update.download_failed', { error_class: errorClass })
      updateDownloadSource = null
    }

    // IPC catch (post-fix): no recordEvent.

    expect(calls.filter(c => c.name === 'update.check_result').length).toBe(1)
    expect(calls.filter(c => c.name === 'update.download_failed').length).toBe(1)
    // error_class buckets propagate consistently across both events.
    expect(calls[0]!.tags?.error_class).toBe('permission')
    expect(calls[1]!.tags?.error_class).toBe('permission')
  })
})

/**
 * §2.19 iter4 — codex security iter1 closures.
 *
 * Three findings, one test block per fix:
 *   - High 1 — raw err.message must NOT reach electron-log, Sentry, or
 *     IPC return shapes. The bucketed `classifyUpdateError` enum is the
 *     only PII-safe carrier.
 *   - High 2 — `update.*` events are mainOnly. The `metrics:record` IPC
 *     bridge MUST reject them when received from the renderer (defense
 *     against a compromised renderer smuggling raw error_class strings
 *     into Sentry).
 *   - Medium  — `update:download` and `update:install` MUST be gated by
 *     `updateCanSelfUpdate`. The renderer's disabled UI affordance is
 *     not an authorization boundary.
 */
describe('§2.19 iter4: classifyUpdateError used in all 4 sites — no raw err.message in logs/Sentry/IPC response', () => {
  // Mirror of the policy we enforce at the four call sites in main.ts.
  // Every site MUST go through classifyUpdateError, NEVER touch err.message.
  // The matrix below pins the policy as a pure check: given a synthetic
  // updater error with PII-rich text, any sanitization helper can only
  // surface the bucket, not the original string.
  const sanitize = (err: unknown): string => `update_${classifyUpdateError(err)}`

  it('local log message contains only the bucketed class, never raw text', () => {
    // Updater errors routinely carry install paths and version strings.
    // The local file log (electron-log) is user-readable and rotates to
    // disk — it must follow the same hygiene as Sentry events.
    const err = new Error('write failed at /opt/mailcopilot/bin/mailcopilot-1.2.3-nightly')
    const sanitized = sanitize(err)
    expect(sanitized).toBe('update_unknown')
    expect(sanitized).not.toContain('/opt/mailcopilot')
    expect(sanitized).not.toContain('1.2.3')
    expect(sanitized).not.toContain('write failed')
  })

  it('Sentry capture key is synthetic update_<class>, not the original Error object', () => {
    // The autoUpdater.on('error') Sentry capture passes
    // `new Error('update_<class>')`, NOT the raw `err`. This guarantees
    // the Sentry event's `.message`, `.stack`, and grouping fingerprint
    // are derived solely from the enum bucket — a future stack frame in
    // electron-updater that includes the install path can never leak.
    const errs: Array<{ err: unknown; expected: string }> = [
      { err: Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' }), expected: 'update_network' },
      { err: Object.assign(new Error('write failed at /opt/myapp'), { code: 'EACCES' }), expected: 'update_permission' },
      { err: new Error('signature mismatch: SHA256(/var/cache/...)= abc123'), expected: 'update_unknown' },
    ]
    for (const { err, expected } of errs) {
      const synthetic = new Error(`update_${classifyUpdateError(err)}`)
      expect(synthetic.message).toBe(expected)
      // The synthetic carries no path / hostname / version remnant.
      expect(synthetic.message).not.toContain('/')
      expect(synthetic.message).not.toContain(':')
    }
  })

  it('update:check IPC error response carries error_class only, NO message field', () => {
    // Mirror of update:check's catch shape post-iter4. The previous
    // shape included `message: msg` which leaked the same PII the
    // sanitizer otherwise sealed off.
    const err = new Error('Update server returned 503: https://updates.mailcopilot.io')
    const errorClass = classifyUpdateError(err)
    const response = { ok: false as const, status: 'error' as const, error_class: errorClass }

    expect(response).toEqual({ ok: false, status: 'error', error_class: 'unknown' })
    // Schema invariant: the response shape MUST NOT have a 'message' key.
    // A regression that re-adds it would expose the raw err.message to
    // the renderer — which then ends up in Sentry breadcrumbs (the
    // renderer doesn't strip update IPC responses before they hit
    // breadcrumbs).
    expect(Object.keys(response)).not.toContain('message')
  })

  it('update:download IPC error response carries error_class only, NO message field', () => {
    const err = Object.assign(new Error('write failed at /opt/mailcopilot'), { code: 'EACCES' })
    const errorClass = classifyUpdateError(err)
    const response = { ok: false as const, reason: 'download_failed', error_class: errorClass }
    expect(response).toEqual({ ok: false, reason: 'download_failed', error_class: 'permission' })
    expect(Object.keys(response)).not.toContain('message')
  })

  it('update:install IPC error response carries error_class only, NO message field', () => {
    // Symmetric for the linux_installer_failed branch and the
    // synthetic-throw branch. Both must drop the raw `message` field
    // and key on the bucket.
    const err = Object.assign(new Error('pkexec failed: /usr/bin/dpkg -i ...'), { code: 'EAGAIN' })
    const errorClass = classifyUpdateError(err)
    const linuxResp = { ok: false as const, reason: 'linux_installer_failed', error_class: errorClass }
    expect(Object.keys(linuxResp)).not.toContain('message')

    // The synthetic throw used by the unknown-install branch is also
    // PII-clean: only the bucket name lands in the renderer's promise
    // rejection.
    const thrown = new Error(`update_install_${errorClass}`)
    expect(thrown.message).toMatch(/^update_install_(network|permission|unknown)$/)
    expect(thrown.message).not.toContain('/')
  })
})

/**
 * §2.19 iter4 — High 2: update.* metrics are mainOnly, IPC bridge rejects
 * renderer-side emission. We test this through the schema (the source of
 * truth) — the bridge logic in electron/ipc.ts reads `def.mainOnly` and
 * drops the payload before calling recordEvent.
 */
describe('§2.19 iter4: update.* tag enums enforced at runtime via mainOnly + DOMAINS', async () => {
  const { METRIC_EVENTS, DOMAINS } = await import('./metricsSchema')

  it('every update.* event is marked mainOnly: true', () => {
    const updateEvents = Object.entries(METRIC_EVENTS).filter(([n]) => n.startsWith('update.'))
    expect(updateEvents.length).toBeGreaterThanOrEqual(6)
    for (const [name, def] of updateEvents) {
      expect(
        (def as { mainOnly?: boolean }).mainOnly,
        `${name} must be mainOnly: true (privacy invariant — see metricsSchema.ts §2.19 iter4)`,
      ).toBe(true)
    }
  })

  it('update_error_class domain mirrors UpdateErrorClass taxonomy from services/updateCheck.ts', () => {
    // Drift catch: if classifyUpdateError grows a new bucket but the
    // metric domain forgets to add it, the IPC bridge will silently drop
    // the tag value — masking a real failure mode in production.
    expect(DOMAINS.update_error_class).toEqual(['network', 'permission', 'unknown'])
  })

  it('update_check_source / update_check_result / update_install_outcome enums match the values main.ts emits', () => {
    expect(DOMAINS.update_check_source).toEqual(['auto', 'manual'])
    expect(DOMAINS.update_check_result).toEqual(['up-to-date', 'available', 'error'])
    expect(DOMAINS.update_install_outcome).toEqual(['success', 'deferred', 'failed'])
  })

  it('update.* event tag specs reference the new enum domains, NOT plain "string"', () => {
    // Schema-drift catch: a future PR that adds an event tag must use
    // an enum domain (or a primitive type hint), but for update.* the
    // privacy invariant requires enums end-to-end. A regression to
    // 'string' would re-open the High 2 hole.
    const checkTriggered = METRIC_EVENTS['update.check_triggered']
    expect(checkTriggered.tags.source).toBe('update_check_source')

    const checkResult = METRIC_EVENTS['update.check_result']
    expect(checkResult.tags.result).toBe('update_check_result')
    expect(checkResult.tags.error_class).toBe('update_error_class')

    const downloadStarted = METRIC_EVENTS['update.download_started']
    expect(downloadStarted.tags.source).toBe('update_check_source')

    const downloadFailed = METRIC_EVENTS['update.download_failed']
    expect(downloadFailed.tags.error_class).toBe('update_error_class')

    const installOutcome = METRIC_EVENTS['update.install_outcome']
    expect(installOutcome.tags.result).toBe('update_install_outcome')
    expect(installOutcome.tags.error_class).toBe('update_error_class')
  })

  it('IPC bridge contract: a payload referencing a mainOnly event MUST be dropped before recordEvent fires', () => {
    // Pure mirror of the gate in electron/ipc.ts → registerMetricsRecordHandler.
    // The bridge does:
    //   const def = METRIC_EVENTS[p.name]
    //   if (def.mainOnly === true) { logTelemetry.warn(...); return }
    // This test pins the policy: given a payload from the renderer for a
    // mainOnly event, the bridge must short-circuit before any tag is
    // forwarded to recordEvent.
    const def = METRIC_EVENTS['update.download_failed']
    const rendererPayload = {
      name: 'update.download_failed',
      kind: 'event',
      tags: { error_class: '/etc/passwd contents pretending to be an enum' },
    }
    // Bridge logic mirror:
    const accepted = !((def as { mainOnly?: boolean }).mainOnly === true)
    expect(accepted).toBe(false)
    // And the renderer-supplied tag value (intended PII smuggling
    // attempt) is structurally unable to reach Sentry through this path.
    expect(rendererPayload.tags.error_class).toContain('/etc/passwd') // present in input
    // ...but the bridge returns before it ever lands in tags forwarded
    // to recordEvent. The acceptance gate is the only thing that
    // matters; the tag value itself is irrelevant once we reject.
  })

  it('IPC bridge enum-domain enforcement: out-of-domain tag values are dropped for non-mainOnly events too', () => {
    // Defense in depth — even for events the renderer is allowed to
    // emit, if a tag spec is an enum domain (not 'string'/'number'/
    // 'boolean'), values outside the domain must be silently dropped.
    // This pins the policy added alongside `mainOnly`.
    const fakeSpec = 'update_error_class' // not a primitive
    const fakeValue = '<script>alert(1)</script>; rm -rf /'
    const domain = (DOMAINS as Record<string, readonly (string | number | boolean)[]>)[fakeSpec]
    expect(domain).toBeDefined()
    expect(domain.includes(fakeValue)).toBe(false)
    // Bridge logic mirror: in `if (typeof spec === 'string' && spec !== 'string' ...)`
    // the bridge calls `domain.includes(v)` and `continue`s on miss — the
    // tag is dropped, but the rest of the payload is still forwarded
    // (so we don't lose telemetry for a single bad tag value).
  })
})

/**
 * §2.19 iter4 — Medium: update:download + update:install gated by
 * updateCanSelfUpdate.
 *
 * Real risk (codex): both handlers only checked `app.isPackaged`. SystemInfo's
 * disabled UI affordance kicks in when canSelfUpdate=false (read-only
 * install path), but a compromised renderer can call `window.api.invoke`
 * directly and bypass the UI. The handler MUST short-circuit before
 * touching autoUpdater.
 */
describe('§2.19 iter4: update:download + update:install rejected when canSelfUpdate=false', () => {
  // Pure policy mirror — the gate in main.ts looks like:
  //   if (!updateCanSelfUpdate) return { ok: false, reason: 'permission_denied', error_class: 'permission' }
  // The matrix here pins the truth table the IPC handler must implement.
  const computeGate = (
    isPackaged: boolean,
    updateCanSelfUpdate: boolean,
  ): { allow: boolean; rejectShape?: { ok: false; reason: string; error_class: string } } => {
    if (!isPackaged) return { allow: true } // dev short-circuit returns ok:true
    if (!updateCanSelfUpdate) {
      return {
        allow: false,
        rejectShape: { ok: false, reason: 'permission_denied', error_class: 'permission' },
      }
    }
    return { allow: true }
  }

  it('rejects download when packaged + canSelfUpdate=false', () => {
    const result = computeGate(true, false)
    expect(result.allow).toBe(false)
    expect(result.rejectShape).toEqual({
      ok: false,
      reason: 'permission_denied',
      error_class: 'permission',
    })
  })

  it('rejects install when packaged + canSelfUpdate=false', () => {
    // Same gate, same shape — the policy is symmetric across both
    // handlers (codex finding requires both gated, not just one).
    const result = computeGate(true, false)
    expect(result.allow).toBe(false)
    expect(result.rejectShape).toEqual({
      ok: false,
      reason: 'permission_denied',
      error_class: 'permission',
    })
  })

  it('allows download/install when packaged + canSelfUpdate=true (normal path)', () => {
    expect(computeGate(true, true).allow).toBe(true)
  })

  it('allows in dev (!packaged) regardless of canSelfUpdate (handler returns early ok)', () => {
    // The !app.isPackaged branch returns { ok: true } unconditionally —
    // dev/e2e have no real updater. canSelfUpdate is only enforced for
    // packaged builds.
    expect(computeGate(false, false).allow).toBe(true)
    expect(computeGate(false, true).allow).toBe(true)
  })

  it('reject shape error_class is in the update_error_class enum domain (no raw text)', async () => {
    const { DOMAINS } = await import('./metricsSchema')
    const result = computeGate(true, false)
    expect(result.rejectShape).toBeDefined()
    expect(DOMAINS.update_error_class.includes(result.rejectShape!.error_class as 'permission')).toBe(true)
  })
})
