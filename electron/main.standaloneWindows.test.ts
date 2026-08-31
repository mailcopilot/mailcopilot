import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §3.3.B4.f6 — Compose and standalone message windows are created WITHOUT a
 * WM parent (see `childWindowOptions.ts` for the Mutter `has_maximize_func`
 * rationale). Dropping `parent` also drops Electron's automatic teardown of
 * children when the main window closes, so `main.ts` reproduces that
 * lifetime explicitly via `standaloneChildWindows` /
 * `registerStandaloneChildWindow` / `closeStandaloneChildWindows`, wired into
 * the main window's `closed` event, plus creation-time placement via
 * `centerOverMainWindow`.
 *
 * `childWindowOptions.test.ts` unit-tests the DECISION (which kinds are
 * standalone) and the pure `centerOverRect` placement math directly — those
 * are importable. What is NOT importable is main.ts itself (module-level
 * side effects: window creation, IPC registration, DB open at import time),
 * so — like main.settingsClamp.test.ts and main.openInWindow.test.ts before
 * it — this suite reads the source instead. Unlike a from-scratch mock of the
 * registry contract, every assertion below is anchored to the actual
 * production text: it fails the moment a call site stops registering a
 * standalone window, stops wiring the sweep to the main window's `closed`
 * event, or drops the defensive `isDestroyed()` check in the sweep itself.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

describe('main.ts standalone window registry — implementation', () => {
  const declIdx = MAIN_TS.indexOf('const standaloneChildWindows = new Set<BrowserWindow>()')
  const registerStart = MAIN_TS.indexOf('function registerStandaloneChildWindow')
  const registerBody = MAIN_TS.slice(registerStart, MAIN_TS.indexOf('\n}', registerStart))
  const closeStart = MAIN_TS.indexOf('function closeStandaloneChildWindows')
  const closeBody = MAIN_TS.slice(closeStart, MAIN_TS.indexOf('\n}', closeStart))

  it('declares the registry as a Set of BrowserWindow', () => {
    expect(declIdx).toBeGreaterThan(-1)
  })

  it('registration adds to the set and wires its own removal on close', () => {
    expect(registerStart).toBeGreaterThan(-1)
    const addIdx = registerBody.indexOf('standaloneChildWindows.add(child)')
    const onClosedIdx = registerBody.indexOf("child.on('closed'")
    expect(addIdx).toBeGreaterThan(-1)
    expect(onClosedIdx).toBeGreaterThan(addIdx)
    // The removal must target the exact same set the add used — a stray
    // second Set (copy-paste refactor) would leave both stale.
    expect(registerBody).toContain('standaloneChildWindows.delete(child)')
  })

  it('sweep snapshots the set before iterating, because teardown mutates it mid-loop', () => {
    expect(closeStart).toBeGreaterThan(-1)
    // Teardown synchronously fires `closed`, which deletes from the live Set.
    // Iterating the live Set directly would skip elements as the engine's
    // iterator adjusts to the shrinking collection.
    expect(closeBody).toContain('[...standaloneChildWindows]')
  })

  it('sweep skips a window that is already destroyed', () => {
    // Without this guard, a window torn down via some other path before the
    // sweep reaches it would throw on the second call and abort the rest of
    // the sweep, leaving later windows alive.
    expect(closeBody).toMatch(/if\s*\(!child\.isDestroyed\(\)\)\s*child\.destroy\(\)/)
  })

  it('sweep is terminal — destroy(), never the cancellable close()', () => {
    // codex-security-review MEDIUM: `close()` is a request the page can refuse
    // (`beforeunload`). "The main window closed" is the end of the session, and
    // a compromised renderer must not be able to outlive it — an orphan keeps a
    // live preload bridge and, on Linux/Windows, keeps `window-all-closed` from
    // firing so the app never quits. Nothing honest can tell the difference:
    // no window in this app registers `beforeunload` or an unload-time flush.
    expect(closeBody).toContain('child.destroy()')
    expect(closeBody).not.toContain('child.close()')
  })
})

describe('main.ts standalone window registry — wiring', () => {
  it("closes the registry from the main window's own closed event", () => {
    expect(MAIN_TS).toContain("win.on('closed', () => { closeStandaloneChildWindows() })")
  })

  it('createChildWindow registers a window in the registry only for standalone kinds', () => {
    const start = MAIN_TS.indexOf('function createChildWindow(')
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\nfunction openSettingsWindow', start))
    expect(body).toContain('const standalone = isStandaloneWindowKind(kind)')
    expect(body).toContain('if (standalone) registerStandaloneChildWindow(child)')
    // The registration call must reference the window actually constructed,
    // and therefore come after the `new BrowserWindow(...)` call.
    const ctorIdx = body.indexOf('new BrowserWindow(')
    const regIdx = body.indexOf('registerStandaloneChildWindow(child)')
    expect(ctorIdx).toBeGreaterThan(-1)
    expect(regIdx).toBeGreaterThan(ctorIdx)
  })

  it('mail:openInWindow always registers the window it creates — kind is unconditionally standalone', () => {
    const start = MAIN_TS.indexOf("handleIpc('mail:openInWindow'")
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    const regIdx = body.indexOf('registerStandaloneChildWindow(child)')
    expect(regIdx).toBeGreaterThan(-1)
    // Unlike createChildWindow, this handler only ever builds a
    // `kind: 'mailWindow'` window (always standalone), so the call must not
    // be gated behind a conditional — a stray `if (...)` here would be dead
    // weight at best and, if the condition is ever wrong, a leak at worst.
    expect(body.slice(Math.max(0, regIdx - 40), regIdx)).not.toMatch(/if\s*\(/)
  })
})

describe('main.ts standalone window placement — wiring', () => {
  it('centerOverMainWindow refuses to compute placement without a live, non-destroyed main window', () => {
    const start = MAIN_TS.indexOf('function centerOverMainWindow')
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start))
    expect(body).toMatch(/if\s*\(!win\s*\|\|\s*win\.isDestroyed\(\)\)\s*return\s*\{\}/)
    expect(body).toContain('centerOverRect(main, workArea, { width, height }, standaloneChildWindows.size)')
  })

  it('picks the display by overlap with the main window, not by its top-left corner', () => {
    // `getDisplayMatching` uses the largest-overlap rule. The superseded
    // `offsetFromMainWindow` searched for the work area *containing* the
    // top-left corner, which resolved to the primary display whenever the main
    // window straddled a monitor edge or sat at a negative origin.
    const start = MAIN_TS.indexOf('function centerOverMainWindow')
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start))
    expect(body).toContain('screen.getDisplayMatching(main).workArea')
  })

  it('createChildWindow only computes centred placement for standalone kinds', () => {
    const start = MAIN_TS.indexOf('function createChildWindow(')
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\nfunction openSettingsWindow', start))
    // Settings/Account keep their WM-parent-relative default placement; only
    // the unparented kinds need main.ts to compute where they land.
    expect(body).toContain('const placement = standalone ? centerOverMainWindow(width, height) : {}')
  })

  it('mail:openInWindow places its window through the shared helper, not a bespoke path', () => {
    // The Medium finding this pins: the handler used to call its own
    // `offsetFromMainWindow()` while Compose already went through
    // `centerOverMainWindow()`. Two placement policies for two windows of the
    // same (standalone) class is exactly the drift docs/ARCHITECTURE.md
    // "Window geometry" §8 now forbids.
    const start = MAIN_TS.indexOf("handleIpc('mail:openInWindow'")
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    expect(body).toContain('const placement = centerOverMainWindow(width, height)')
    expect(body).toContain('x: placement.x')
    expect(body).toContain('y: placement.y')
  })

  it('has no second placement helper left anywhere in main.ts', () => {
    // `offsetFromMainWindow` is superseded, not deprecated: a surviving
    // definition would invite the next call site to reach for it again.
    expect(MAIN_TS).not.toMatch(/function\s+offsetFromMainWindow/)
  })
})

describe('main.ts mail:openInWindow — account guard', () => {
  const start = MAIN_TS.indexOf("handleIpc('mail:openInWindow'")
  const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))

  it('still refuses an unknown accountId before creating anything', () => {
    // The window is only worth opening for an account the app knows about;
    // without this a chatty renderer could name arbitrary ids.
    const guardIdx = body.indexOf("throw new Error('Unknown accountId')")
    const ctorIdx = body.indexOf('new BrowserWindow(')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(ctorIdx).toBeGreaterThan(guardIdx)
  })

  it('consults the fixture roster ONLY behind the IS_E2E flag', () => {
    // The e2e branch exists so this lookup agrees with `accounts:list` and
    // `pendingMoveAccountExists` (the fixture roster is the canonical one in
    // e2e). Dropping the flag would make the built-in fixture accounts
    // acceptable ids in a shipped build. What makes "shipped build" hold is
    // the derivation of IS_E2E itself, pinned in the suite below — this
    // assertion alone would be satisfied by an env-only flag too.
    expect(body).toMatch(/const accountKnown = IS_E2E\s*\n\s*\? E2E_ACCOUNTS\.some/)
    expect(body).toContain('listAccounts().some(a => a.id === input.accountId)')
  })
})

describe('main.ts IS_E2E — derivation', () => {
  /**
   * codex-security-review HIGH: `IS_E2E` used to be
   * `process.env.MAILCOPILOT_E2E === '1'`, an env-only read. Every branch
   * gated on it — the fixture rosters and mailboxes, the no-op send/sync
   * paths, the account guard above, the certificate-trust and audit-log-clear
   * short-circuits — was therefore reachable on a SHIPPED build by anything
   * able to set an environment variable for the user (wrapper script, dropper,
   * shell profile). The flag now goes through `computeIsE2E(env, isPackaged)`,
   * which folds in the build check the way `assertE2EHandlerAllowed` and the
   * secret store already did individually (CLAUDE.md §2.132 class).
   *
   * `e2eFlag.test.ts` owns the truth table; what can only be checked against
   * the source is that main.ts actually asks that function and does not derive
   * the flag from the environment behind its back.
   */
  it('derives IS_E2E through computeIsE2E, passing the packaged bit', () => {
    expect(MAIN_TS).toContain('const IS_E2E = computeIsE2E(process.env, app.isPackaged)')
  })

  it('imports computeIsE2E from the pure module', () => {
    expect(MAIN_TS).toMatch(/import\s*\{\s*computeIsE2E\s*\}\s*from\s*'\.\/e2eFlag'/)
  })

  it('never assigns IS_E2E straight from the environment', () => {
    // The exact shape of the old defect, plus any variation that reads
    // process.env into this flag without the packaged bit.
    expect(MAIN_TS).not.toMatch(/IS_E2E\s*=\s*process\.env/)
    expect(MAIN_TS).not.toMatch(/IS_E2E\s*=\s*[^\n]*MAILCOPILOT_E2E\s*===/)
  })

  it('assigns IS_E2E exactly once', () => {
    // A second assignment (a `let` reassigned in a test hook, a shadowing
    // const in some block) would make the pinned derivation above meaningless.
    const assignments = MAIN_TS.match(/\bIS_E2E\s*=[^=]/g) ?? []
    expect(assignments).toHaveLength(1)
  })
})

describe('main.ts standalone window kinds — literals at the call sites', () => {
  // The kind string is what selects the whole standalone policy (no WM parent,
  // centred placement, registry lifetime) inside `buildChildWindowOptions` /
  // `isStandaloneWindowKind`. A typo here type-checks nowhere near the
  // behaviour it silently disables for `createChildWindow`'s dynamic kind, so
  // pin both literals at their sources.
  it('the generic factory forwards its own kind parameter unchanged', () => {
    const start = MAIN_TS.indexOf('function createChildWindow(')
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\nfunction openSettingsWindow', start))
    expect(body).toContain('function createChildWindow(kind: ChildWindowKind')
    expect(body).toContain('const standalone = isStandaloneWindowKind(kind)')
    // Forwarded, never re-derived: `kind,` as its own property shorthand.
    expect(body).toMatch(/buildChildWindowOptions<BrowserWindow>\(\{\s*\n\s*kind,/)
  })

  it("Compose asks the factory for kind 'compose'", () => {
    const start = MAIN_TS.indexOf('function openComposeWindow')
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, start + 1200)
    expect(body).toMatch(/createChildWindow\(\s*'compose'/)
  })

  it("the mail window handler asks for kind 'mailWindow'", () => {
    const start = MAIN_TS.indexOf("handleIpc('mail:openInWindow'")
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    expect(body).toContain("kind: 'mailWindow'")
  })
})

describe('main.ts child window creation — shared bootstrap arguments reach both standalone call sites', () => {
  // childBrowserArgs() carries the theme flag, install-id hash and effective
  // telemetry permission the renderer's Sentry.init needs at first paint
  // (see childBrowserArgs doc in main.ts). framelessCornerOptions() is the
  // platform-specific corner behaviour for the custom titlebar. Both places
  // that build a BrowserWindow via buildChildWindowOptions must pass both,
  // or the two window families boot with different renderer bootstraps.
  const sites: Array<{ name: string; start: number }> = [
    { name: 'createChildWindow (compose)', start: MAIN_TS.indexOf('function createChildWindow(') },
    { name: "mail:openInWindow handler (mailWindow)", start: MAIN_TS.indexOf("handleIpc('mail:openInWindow'") },
  ]

  it.each(sites)('$name passes childBrowserArgs(), framelessCornerOptions() and the live main window through', ({ start }) => {
    expect(start).toBeGreaterThan(-1)
    const ctorIdx = MAIN_TS.indexOf('buildChildWindowOptions<BrowserWindow>({', start)
    expect(ctorIdx).toBeGreaterThan(start)
    const closeIdx = MAIN_TS.indexOf('}))', ctorIdx)
    expect(closeIdx).toBeGreaterThan(ctorIdx)
    const call = MAIN_TS.slice(ctorIdx, closeIdx)
    expect(call).toContain('additionalArguments: childBrowserArgs()')
    expect(call).toContain('cornerOptions: framelessCornerOptions()')
    // Both sites hand `win` through unconditionally; whether it is actually
    // attached as a WM parent is `buildChildWindowOptions`'s decision alone
    // (pinned in childWindowOptions.test.ts "ignores a supplied parent for
    // standalone kinds even if one is passed") — a call site that pre-filters
    // it (e.g. `parent: standalone ? undefined : win`) would duplicate that
    // decision in two places.
    expect(call).toContain('parent: win')
  })
})
