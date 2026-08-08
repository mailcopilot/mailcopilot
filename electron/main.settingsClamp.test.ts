import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.82 iter2 finding 1 — no unclamped settings record may leave main.
 *
 * The renderer starts its OWN Sentry client from `sentryEnabled` alone
 * (src/App.tsx applies `s.sentryEnabled !== false` to both the `settings:get`
 * reply and every `settings:changed` broadcast). On a clean profile there is
 * no consent record while the settings schema still defaults that field to
 * `true` — so publishing the persisted value verbatim starts renderer
 * envelopes for a user who has never been asked. The fix is a clamp to the
 * effective permission (`clampTelemetryForRenderer`) on BOTH boundaries.
 *
 * electron/main.ts cannot be imported in a unit test (module-level side
 * effects: window creation, IPC registration, DB open), so this guard reads
 * the source instead — the same trade-off as the mirror-pattern suites in
 * main.auditLogClear.test.ts and friends. What it protects is not the clamp
 * logic (that is unit-tested in telemetryConsent.test.ts) but the far more
 * likely regression: a NEW publish site added later that forgets it.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
// Comment lines mention the channel by name (that is the point of the header
// on broadcastSettingsChanged) — count code only.
const MAIN_TS_CODE = MAIN_TS.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

describe('main.ts settings publication boundaries', () => {
  it('answers settings:get with a clamped record', () => {
    const line = MAIN_TS.split('\n').find(l => l.includes("handleIpc('settings:get'"))
    expect(line).toBeDefined()
    expect(line).toContain('clampTelemetryForRenderer')
  })

  it('has exactly one place that puts a settings record on the settings:changed channel', () => {
    // Every publish site must funnel through `broadcastSettingsChanged`, which
    // applies the clamp. Direct `webContents.send('settings:changed', …)` calls
    // are what leaked the raw record from three separate sites before the fix.
    const directSends = MAIN_TS_CODE.match(/send\(\s*'settings:changed'/g) ?? []
    expect(directSends).toHaveLength(0)

    const broadcasts = MAIN_TS_CODE.match(/broadcast\(\s*'settings:changed'/g) ?? []
    expect(broadcasts).toHaveLength(1)
  })

  // §2.82 iter3 finding 5 — a failed RAW read must not erase a refusal.
  //
  // `applyAboutToggle` reads anything other than `false` as "no expressed
  // opt-out on disk" and writes `true`. So when `getRawPersistedSettings()`
  // threw, the old `catch { return undefined }` turned a stored `false` into
  // `true` on the next unrelated `settings:save` — telemetry stayed off (there
  // is still no consent record), but the evidence of the earlier refusal was
  // gone and `migrateTelemetryConsent` would ask the user again.
  //
  // The fallback is the PARSED current value: identical to the raw one except
  // when the key is absent, and absent is not a refusal either.
  it('falls back to the parsed value when the raw settings read throws', () => {
    const marker = 'const persistedSentryEnabled = (() => {'
    const start = MAIN_TS.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const block = MAIN_TS.slice(start, MAIN_TS.indexOf('})()', start))
    expect(block).toContain('getRawPersistedSettings()?.sentryEnabled')
    expect(block).toMatch(/catch\s*\{\s*return\s+current\.sentryEnabled\s*\}/)
    expect(block).not.toMatch(/catch\s*\{\s*return\s+undefined\s*\}/)
  })

  it('the single publish site applies the clamp', () => {
    const fnStart = MAIN_TS.indexOf('function broadcastSettingsChanged')
    expect(fnStart).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(fnStart, MAIN_TS.indexOf('\n}', fnStart))
    expect(body).toContain('clampTelemetryForRenderer')
    expect(body).toContain("broadcast('settings:changed'")
  })
})

// §2.82 iter3 finding 2 (WHO) — the service defaults `isMainWindowSender` to
// `() => false`, so a wiring that forgets the predicate rejects every consent
// write. The behaviour of the gate is unit-tested in the service suite; what
// this guards is the wiring itself, which cannot be imported.
// §2.82 iter4 (security finding 1) — `settings:save` may only accept an
// About-switch value that turns telemetry ON when it comes from the settings
// window. The decision itself is unit-tested in telemetryConsent.test.ts
// (applyAboutToggleFromOrigin); what cannot be imported is the wiring, so the
// two things that could silently undo it are asserted against the source:
// the handler passing an origin at all, and the predicate resolving the
// SETTINGS window rather than the main one.
describe('main.ts About-switch sender gate', () => {
  it('routes settings:save through the origin-aware helper, not the ungated one', () => {
    expect(MAIN_TS_CODE).toContain('applyAboutToggleFromOrigin(')
    // The ungated helper must not be reachable from main.ts any more.
    expect(MAIN_TS_CODE).not.toMatch(/[^a-zA-Z]applyAboutToggle\(/)
  })

  it('derives the origin from the settings-window sender identity', () => {
    const start = MAIN_TS.indexOf("handleIpc('settings:save'")
    expect(start).toBeGreaterThan(-1)
    const handler = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    expect(handler).toContain('isSettingsWindowSender(event?.sender)')
    expect(handler).toContain("'settings-window'")
    expect(handler).toContain("'other-window'")
  })

  it('the predicate checks identity against the live settings window', () => {
    const start = MAIN_TS.indexOf('function isSettingsWindowSender')
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start))
    expect(body).toContain('settingsWin.webContents')
    expect(body).toContain('settingsWin.isDestroyed()')
    // The main-window predicate would reject the ONE window that carries the
    // switch, leaving the user unable to consent after a refusal.
    expect(body).not.toMatch(/(?<![A-Za-z])win\.webContents/)
  })
})

describe('main.ts telemetry consent wiring', () => {
  it('hands the consent service a main-window sender predicate', () => {
    const start = MAIN_TS.indexOf('initTelemetryConsent({')
    expect(start).toBeGreaterThan(-1)
    const call = MAIN_TS.slice(start, MAIN_TS.indexOf('})', start))
    expect(call).toContain('isMainWindowSender')
    // Identity against the live main window, evaluated per call — not a
    // captured `webContents` (the window does not exist at wiring time) and
    // not a truthiness check.
    expect(call).toContain('win.webContents')
    expect(call).toContain('win.isDestroyed()')
  })
})

// §2.58 iter2 (security review finding 1) — `update:systemInfo` answers with
// `process.execPath`. On a user-local install that path carries the home
// directory and therefore the account name, so the payload is only meant for
// the About panel, which renders exclusively inside the settings window
// (src/Root.tsx routes `#/settings`). Without a sender check any renderer on
// the preload whitelist could harvest it. The handler cannot be imported (the
// module opens windows, the DB and registers every IPC on load), so — like the
// About-switch gate above — the wiring is asserted against the source.
describe('main.ts update:systemInfo sender gate', () => {
  const start = MAIN_TS.indexOf("handleIpc('update:systemInfo'")
  const handler = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))

  it('refuses every sender that is not the settings window', () => {
    expect(start).toBeGreaterThan(-1)
    // Fail-closed: the NEGATIVE branch is the refusal, so an unknown or
    // destroyed window falls into it (see isSettingsWindowSender).
    expect(handler).toMatch(/if\s*\(!isSettingsWindowSender\(event\?\.sender\)\)/)
    expect(handler).toMatch(/return null/)
  })

  it('decides before it reads process.execPath', () => {
    const gateIdx = handler.indexOf('isSettingsWindowSender')
    const execPathIdx = handler.indexOf('process.execPath')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(execPathIdx).toBeGreaterThan(-1)
    // A gate evaluated after the payload is built is a gate that a later
    // refactor can drop without changing the answer for the allowed caller.
    expect(execPathIdx).toBeGreaterThan(gateIdx)
  })

  it('logs the refusal without echoing the sender or the payload', () => {
    const logLine = handler.split('\n').find(l => l.includes('logUpdate.warn'))
    expect(logLine).toBeDefined()
    // CLAUDE.md §8: no interpolation at all in the refusal line — sender
    // identity and payload fields are renderer-derived.
    expect(logLine).not.toContain('${')
  })
})
