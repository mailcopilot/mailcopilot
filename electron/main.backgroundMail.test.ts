import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.99 — tray / close-to-tray / background operation wiring in main.ts.
 *
 * Everything DECIDABLE about this feature (which state counts as "safe to
 * hide", what a settings change does, what a sync tells the notifier) lives
 * in electron/services/backgroundMail.ts and is behaviourally unit-tested in
 * backgroundMail.test.ts, tray.test.ts, mailNotifier.test.ts and
 * unreadBadge.test.ts — none of that is duplicated here.
 *
 * What is NOT importable is main.ts itself (module-level side effects: window
 * creation, IPC registration, DB open at import time), so — like
 * main.standaloneWindows.test.ts before it — this suite reads the source
 * instead. Every assertion below is anchored to the actual production text:
 * it fails the moment a call site drops a guard, reorders the background
 * branch after the quit branch, or stops forwarding the real IS_E2E flag.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

describe('main.ts §2.99 — close to tray hides the window on the preference and a live icon', () => {
  const closeStart = MAIN_TS.indexOf("win.on('close', (event) => {")
  const closeEnd = MAIN_TS.indexOf('\n  })', closeStart)
  const closeBody = MAIN_TS.slice(closeStart, closeEnd)
  /**
   * The background branch, sliced out on its own.
   *
   * Asserting the three effects merely appear SOMEWHERE in the handler is not
   * enough: lifting any one of them out of the branch — say a `win.hide()` that
   * drifts above the gate during a refactor — would hide the window on EVERY
   * close, tray or no tray, preference or no preference, and every check that
   * only searched `closeBody` would still pass. So membership is asserted
   * against this slice, and the rest of the handler is asserted to be free of
   * them (see 'keeps all three effects inside the branch').
   */
  const gateIdx = closeBody.indexOf('if (!shuttingDown &&')
  const branchEnd = closeBody.indexOf('\n    }', gateIdx)
  const branch = closeBody.slice(gateIdx, branchEnd)
  const outsideBranch = closeBody.slice(0, gateIdx) + closeBody.slice(branchEnd)

  it('locates the close handler and its background branch', () => {
    expect(closeStart).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(-1)
    expect(branchEnd).toBeGreaterThan(gateIdx)
  })

  it('hides only when shutdown, the gate and a live window all allow it', () => {
    // A dropped `win &&` or `!win.isDestroyed()` here would let the app call
    // `.hide()` on a null/destroyed window; a dropped `shuttingDown` would make
    // app.quit()/updater teardown hide the window instead of closing it.
    expect(closeBody).toContain('if (!shuttingDown && shouldKeepRunningInBackground() && win && !win.isDestroyed()) {')
    expect(branch).toContain('event.preventDefault()')
    expect(branch).toContain('win.hide()')
  })

  it('keeps all three effects inside the branch, in order, and nowhere else in the handler', () => {
    // Order is not decoration: `preventDefault()` must come first or the close
    // proceeds and the subsequent `hide()` acts on a window that is going away,
    // and the hint must follow the hide it is describing.
    const preventIdx = branch.indexOf('event.preventDefault()')
    const hideIdx = branch.indexOf('win.hide()')
    const hintIdx = branch.indexOf('noteHiddenToTray()')
    expect(preventIdx).toBeGreaterThan(-1)
    expect(hideIdx).toBeGreaterThan(preventIdx)
    expect(hintIdx).toBeGreaterThan(hideIdx)
    // And none of them may live outside the branch — an unconditional
    // `preventDefault()` makes the window unclosable, an unconditional
    // `win.hide()` makes every close a hide.
    expect(outsideBranch).not.toContain('event.preventDefault()')
    expect(outsideBranch).not.toContain('win.hide()')
    expect(outsideBranch).not.toContain('noteHiddenToTray()')
  })

  it('is synchronous — no probe is awaited between the close event and the hide', () => {
    // §2.228 removed: the desktop is no longer asked whether it took the icon,
    // so there is no deferred close to re-issue and no latch to get wrong.
    // Relaunching restores the window whether or not the icon works (see the
    // second-instance suite below), which is what made the question moot.
    expect(closeBody).not.toContain('confirmCloseToTray')
    expect(closeBody).not.toContain('mayCloseToTray')
    expect(closeBody).not.toContain('closingForReal')
    expect(MAIN_TS).not.toContain('trayHost')
    expect(MAIN_TS).not.toContain('tray.close_gate')
  })

  it('hints where the window went, exactly once', () => {
    // A second call site added to a future branch would still satisfy an
    // ordering check (indexOf finds the first occurrence only), so count them.
    expect(closeBody.match(/noteHiddenToTray\(\)/g)).toHaveLength(1)
  })

  it('never suppresses saveWindowState — the tray path only changes whether the window quits', () => {
    const saveIdx = closeBody.indexOf('if (win && !win.isDestroyed()) saveWindowState(win)')
    const gateIdx = closeBody.indexOf('if (!shuttingDown &&')
    expect(saveIdx).toBeGreaterThan(-1)
    expect(saveIdx).toBeLessThan(gateIdx)
  })
})

describe('main.ts §2.99 — window-all-closed keeps running only behind a tray icon of ours', () => {
  const start = MAIN_TS.indexOf("app.on('window-all-closed', () => {")
  const end = MAIN_TS.indexOf('\n})', start)
  const body = MAIN_TS.slice(start, end)

  it('locates the handler', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('checks shouldKeepRunningInBackground() BEFORE the platform quit branch, and returns from it', () => {
    // Ordering matters: if the quit branch ran first, macOS's own
    // `process.platform !== 'darwin'` guard would still skip it there, but a
    // reordering that put quit first with no `return` would race `win = null`
    // against `app.quit()`. The background branch must be first AND terminal.
    const bgIdx = body.indexOf('if (shouldKeepRunningInBackground())')
    const quitIdx = body.indexOf("if (process.platform !== 'darwin')")
    expect(bgIdx).toBeGreaterThan(-1)
    expect(quitIdx).toBeGreaterThan(-1)
    expect(bgIdx).toBeLessThan(quitIdx)
    const bgBlockEnd = body.indexOf('\n  }', bgIdx)
    expect(body.slice(bgIdx, bgBlockEnd)).toContain('return')
  })

  it('nulls the window reference on the background path too, so a later createWindow() does not see a stale handle', () => {
    const bgIdx = body.indexOf('if (shouldKeepRunningInBackground())')
    const bgBlockEnd = body.indexOf('\n  }', bgIdx)
    expect(body.slice(bgIdx, bgBlockEnd)).toContain('win = null')
  })
})

/**
 * §2.99 — reopening the app is THE way back from a hidden window, and the three
 * suites below are what that claim rests on.
 *
 * It became load-bearing when the close-to-tray gate was removed: the app is
 * allowed to hide behind a tray icon it cannot prove the desktop draws,
 * precisely because reopening restores the window whether the icon works, is
 * dead, or was never drawn at all — and the tray menu still offers Quit. If this
 * path ever breaks, hiding stops being recoverable and the argument for removing
 * the gate collapses with it.
 *
 * "Reopening" is TWO events, and between them they cover every platform we ship:
 *  - Linux/Windows — relaunching from the launcher raises `second-instance`;
 *  - macOS — clicking the dock icon raises `activate`, and `second-instance`
 *    never fires there at all.
 * Both must land in `showMainWindow()`; the helper itself is pinned separately.
 * That split is not academic: the macOS handler used to be the stock
 * `if (getAllWindows().length === 0) createWindow()` recipe, which does NOTHING
 * for a window hidden by close-to-tray (it exists, so the count is 1) — the
 * window was unreachable on macOS for as long as the guarantee had been claimed.
 *
 * WHAT IS NOT COVERED, deliberately and unavoidably: the runtime behaviour of
 * these handlers. `main.ts` is not importable (module-level window creation, IPC
 * registration and a DB open at import time), and e2e cannot reach them either —
 * the single-instance lock is bypassed under `MAILCOPILOT_E2E`
 * (`const gotSingleInstanceLock = process.env.MAILCOPILOT_E2E === '1' || ...`),
 * so `second-instance` never fires in a spec run, and `activate` is a macOS
 * event our Linux CI cannot raise. What follows is therefore a SOURCE-MIRROR
 * assertion, in the pattern of main.standaloneWindows.test.ts: it fails the
 * moment a call site drops `show()`, `focus()`, `restore()` or the
 * create-if-absent branch, and it proves nothing about Electron's own delivery
 * of the events.
 */
describe('main.ts §2.99 — showMainWindow is the one implementation of "come back"', () => {
  const start = MAIN_TS.indexOf('function showMainWindow(): void {')
  const end = MAIN_TS.indexOf('\n}', start)
  const body = MAIN_TS.slice(start, end)
  const liveIdx = body.indexOf('if (win && !win.isDestroyed()) {')
  const liveEnd = body.indexOf('\n  }', liveIdx)
  const live = body.slice(liveIdx, liveEnd)

  it('locates the helper and its live-window branch', () => {
    expect(start).toBeGreaterThan(-1)
    expect(liveIdx).toBeGreaterThan(-1)
    expect(liveEnd).toBeGreaterThan(liveIdx)
  })

  it('restores, un-hides and focuses the existing window, in that order', () => {
    // The three repairs are not interchangeable and none of them is optional:
    // a minimized window ignores `focus()`, a hidden one stays hidden without
    // `show()`, and a window that is neither is still behind whatever the user
    // was looking at until `focus()` runs. `show()` in particular is the one
    // that answers a previous close-to-tray.
    const restoreIdx = live.indexOf('if (win.isMinimized()) win.restore()')
    const showIdx = live.indexOf('if (!win.isVisible()) win.show()')
    const focusIdx = live.indexOf('win.focus()')
    expect(restoreIdx).toBeGreaterThan(-1)
    expect(showIdx).toBeGreaterThan(restoreIdx)
    expect(focusIdx).toBeGreaterThan(showIdx)
  })

  it('focuses unconditionally — the raise must not hang off a state test of its own', () => {
    // `if (...) win.focus()` would leave the window restored but behind the
    // window the user reopened us from, which reads as "nothing happened".
    expect(live).toMatch(/\n\s*win\.focus\(\)/)
  })

  it('creates a window ONLY when there is none — a live window is never duplicated', () => {
    const createIdx = body.indexOf('createWindow()')
    expect(createIdx).toBeGreaterThan(liveEnd)
    expect(live).not.toContain('createWindow()')
    // The live branch must be terminal, or a returning user would get a second
    // window on top of the one just restored.
    expect(live).toContain('return')
  })

  it('addresses the MAIN window handle, not "some live window"', () => {
    // `BrowserWindow.getAllWindows().find(w => !w.isDestroyed())` — the shape
    // `second-instance` used to carry inline — returns whichever window was
    // created first among the live ones, so reopening with a Compose or
    // Settings window open raised that instead of the mailbox.
    expect(body).not.toContain('getAllWindows()')
  })
})

describe('main.ts §2.99 — second-instance brings the app back, window or not', () => {
  const start = MAIN_TS.indexOf("app.on('second-instance', (_event, argv) => {")
  const end = MAIN_TS.indexOf('\n  })', start)
  const body = MAIN_TS.slice(start, end)

  it('locates the handler', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('delegates the whole return path to the shared helper', () => {
    expect(body).toContain('showMainWindow()')
    // No second copy of the restore/show/focus logic: two copies of one rule
    // drift apart, and this one had already drifted (wrong window picked).
    expect(body).not.toContain('getAllWindows()')
    expect(body).not.toContain('createWindow()')
  })

  it('still handles a mailto: carried by the relaunch, after bringing the app back', () => {
    // Unrelated to the return path and easy to lose in a refactor of it: a
    // `mailto:` link clicked while the app is hidden arrives as argv here.
    const showIdx = body.indexOf('showMainWindow()')
    const mailtoIdx = body.indexOf("const mailtoArg = argv.find(a => a.startsWith('mailto:'))")
    expect(mailtoIdx).toBeGreaterThan(showIdx)
    expect(body).toContain('if (mailtoArg) handleMailtoUrl(mailtoArg)')
  })

  it('is reached at all — the single-instance lock is taken outside e2e', () => {
    // The handler only ever runs in the process that HOLDS the lock. Losing
    // that (an unconditional bypass, a lock taken after the listener) would
    // make every relaunch a second copy against the same database instead of a
    // way back to the first one.
    expect(MAIN_TS).toContain("const gotSingleInstanceLock = process.env.MAILCOPILOT_E2E === '1' || app.requestSingleInstanceLock()")
    const lockIdx = MAIN_TS.indexOf('const gotSingleInstanceLock =')
    expect(lockIdx).toBeLessThan(start)
    expect(MAIN_TS.slice(lockIdx, start)).toContain('app.quit()')
  })
})

describe('main.ts §2.99 — activate is the macOS route back, and it must not be the stock recipe', () => {
  const start = MAIN_TS.indexOf("app.on('activate', () => {")
  const end = MAIN_TS.indexOf('\n})', start)
  const body = MAIN_TS.slice(start, end)

  it('locates the handler', () => {
    expect(start).toBeGreaterThan(-1)
  })

  /**
   * THE regression this suite exists for. `activate` is the only reopen event
   * macOS raises — clicking the dock icon on a running app does not start a
   * second process, so `second-instance` never fires and the Linux/Windows
   * guarantee does not carry over. With close-to-tray armed the window is
   * hidden, NOT closed: it is still in `getAllWindows()`, so the boilerplate
   * `if (getAllWindows().length === 0) createWindow()` evaluated false and the
   * handler did nothing at all. The app was unreachable.
   */
  it('restores an existing hidden or minimized window, not only an absent one', () => {
    expect(body).toContain('showMainWindow()')
    // The window-count test is the bug itself, in any spelling.
    expect(body).not.toContain('getAllWindows()')
    expect(body).not.toMatch(/length\s*===\s*0/)
  })

  it('does not create a window itself — create-if-absent belongs to the helper', () => {
    // A direct `createWindow()` here would either duplicate the helper's own
    // branch or, unconditionally, open a second window on every dock click.
    expect(body).not.toContain('createWindow()')
  })
})

describe('main.ts §2.99 — a dropped mail:exists event (no listening window) drives a resync instead of silently vanishing', () => {
  const start = MAIN_TS.indexOf("await startIdle(id, cfg.imap, parsedMailbox, (data) => {")
  const end = MAIN_TS.indexOf('\n    })', start)
  const body = MAIN_TS.slice(start, end)

  it('locates the IDLE callback', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('reads the delivery count off broadcast()\'s own return value, not an assumption about window state', () => {
    expect(body).toContain("const delivered = broadcast('mail:exists', { accountId: id, ...data })")
    expect(body).toContain('if (delivered === 0) triggerAccountResync(id)')
    // The resync must be gated on the actual delivery count, not fired
    // unconditionally alongside the broadcast (which would double every
    // sync when a window IS listening).
    const deliveredIdx = body.indexOf('const delivered =')
    const resyncIdx = body.indexOf('if (delivered === 0)')
    expect(deliveredIdx).toBeLessThan(resyncIdx)
  })
})

describe('main.ts §2.99 — IS_E2E is forwarded verbatim, never re-decided at the wiring site', () => {
  it('passes the real computeIsE2E-derived flag into initBackgroundMail, not a literal', () => {
    // backgroundMail.test.ts pins what isE2E=true/false DOES (suppresses tray,
    // notifications, badge — AC15). What only main.ts can get wrong is
    // handing it the wrong source: a stray `isE2E: true` or
    // `isE2E: process.env.MAILCOPILOT_E2E === '1'` here would silently
    // reintroduce the packaged-build hole computeIsE2E exists to close
    // (CLAUDE.md §5 "Testing / Build" — IS_E2E is a conjunction, decided once).
    const start = MAIN_TS.indexOf('initBackgroundMail({')
    expect(start).toBeGreaterThan(-1)
    const block = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    expect(block).toContain('isE2E: IS_E2E')
    expect(block).toContain('onNotificationActivated: openMailRef')
    expect(block).not.toMatch(/isE2E:\s*(true|false|process\.env)/)
    expect(MAIN_TS).toContain('const IS_E2E = computeIsE2E(process.env, app.isPackaged)')
  })

  it('wires the tray with the real window/action callbacks, not stubs', () => {
    const start = MAIN_TS.indexOf('initTrayIntegration({')
    const end = MAIN_TS.indexOf('\n  })', start)
    const body = MAIN_TS.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain("iconPath: path.join(process.env.VITE_PUBLIC, 'icon.png')")
    expect(body).toContain('onOpen: () => showMainWindow()')
    expect(body).toContain('onCompose: () => openComposeWindow()')
    expect(body).toContain('onCheckMail: () => { void runPeriodicSync() }')
    // The main window handle must be re-read live (not captured once) and
    // must exclude a destroyed window — the Windows taskbar overlay call
    // inside tray.ts dereferences whatever this returns.
    expect(body).toContain('getMainWindow: () => (win && !win.isDestroyed() ? win : null)')
  })
})

describe('main.ts §2.99 — noteFolderSynced runs at every path that commits cached mail', () => {
  it('is called from exactly the four known sync completion sites', () => {
    // One per: net:inboxSummaries, the FLAGS-only fast path, the full header
    // sync tail, and the periodic (no-user-present) sync loop. A dropped call
    // site is the exact shape of the §2.86 class of defect this mirrors: a
    // path that commits messages but never tells the notifier/badge.
    const calls = MAIN_TS.match(/noteFolderSynced\([a-zA-Z]+, [a-zA-Z]+\)/g) ?? []
    expect(calls).toHaveLength(4)
    expect(calls).toContain('noteFolderSynced(id, parsedFolder)')
    expect(calls.filter(c => c === 'noteFolderSynced(id, parsedFolder)')).toHaveLength(3)
    expect(calls).toContain('noteFolderSynced(aid, folder)')
  })

  it('runs the periodic-sync call in `finally`, so a throwing fetch still updates the notifier', () => {
    const finallyIdx = MAIN_TS.lastIndexOf('} finally {', MAIN_TS.indexOf('noteFolderSynced(aid, folder)'))
    const noteIdx = MAIN_TS.indexOf('noteFolderSynced(aid, folder)')
    expect(finallyIdx).toBeGreaterThan(-1)
    expect(finallyIdx).toBeLessThan(noteIdx)
  })
})

/**
 * The quit is two acts. Disarming (closing review L1's unread-refresh gate)
 * has to happen the moment `before-quit` fires; destroying the icon has to
 * happen last, because the drain can take tens of seconds (bounded at ~28s —
 * see the deadline tests below) and an icon that disappears while the window is
 * still up reads as "Exit only removed the icon".
 *
 * Both live in the DRAINING handler, and nothing about the outcome may depend
 * on which of main.ts's two `before-quit` listeners Electron happens to call
 * first — that is what the position assertions below pin.
 */
describe('main.ts §2.99 — teardown disarms the tray early and releases the icon last', () => {
  const drainStart = MAIN_TS.indexOf("app.on('before-quit', (event) => {")
  const drainBody = MAIN_TS.slice(drainStart, MAIN_TS.indexOf('\n})', drainStart))

  it('locates the draining handler', () => {
    expect(drainStart).toBeGreaterThan(-1)
    expect(drainBody).toContain('event.preventDefault()')
    expect(drainBody).toContain('app.exit(0)')
  })

  it('disarms ahead of the re-entrancy guard and ahead of the first await', () => {
    // Same synchronous turn as the quit itself: no timer callback can slip in
    // and re-arm the debounce, and listener order stops mattering.
    //
    // Matched as a standalone statement (`^ {2}disarmTray\(\)$`), NOT via a
    // plain substring search: the explanatory comment right above the real
    // call also contains the literal text "disarmTray()" inside backticks
    // ("`disarmTray()` closes the unread-refresh gate"), and that mention sits
    // even earlier in the handler than the real call. A substring `indexOf`
    // finds the comment instead and would keep passing even if the actual
    // `disarmTray()` statement were deleted entirely (verified by temporarily
    // removing the call and re-running this test: with `indexOf` it stayed
    // green; with the anchored regex below it correctly turns red).
    const disarmMatch = drainBody.match(/^ {2}disarmTray\(\)$/m)
    expect(disarmMatch).not.toBeNull()
    const disarmIdx = disarmMatch!.index!
    expect(disarmIdx).toBeLessThan(drainBody.indexOf('if (shuttingDown) {'))
    expect(disarmIdx).toBeLessThan(drainBody.indexOf('await '))
  })

  it('destroys the icon as the statement immediately before app.exit(0)', () => {
    // `app.exit()` emits no further lifecycle events, so anything after it is
    // dead code and anything before the drain ends takes the icon away early.
    expect(drainBody).toMatch(/\n {4}shutdownTray\(\)\n(?: *\/\/[^\n]*\n)*(?: *)app\.exit\(0\)/)
  })

  it('wraps shutdownDbWritingTimers() so a throw there cannot strand the drain before the checkpoint or the icon release', () => {
    // If this call threw unguarded, the promise executing the drain would
    // simply reject: nothing after it — the WAL checkpoint, `shutdownTray()`,
    // `app.exit(0)` — would ever run, and the app would sit there "quitting"
    // forever with a live icon. `try { ... } catch { /* ignore */ }` is what
    // keeps the rest of the drain reachable.
    const wrapMatch = drainBody.match(/try \{ shutdownDbWritingTimers\(\) \} catch \{[^}]*\}/)
    expect(wrapMatch).not.toBeNull()
    const callIdx = wrapMatch!.index!
    // Everything the throw would otherwise strand has to be textually AFTER
    // the wrapped call, inside the same handler.
    const checkpointIdx = drainBody.indexOf('wal_checkpoint')
    const shutdownTrayIdx = drainBody.lastIndexOf('shutdownTray()')
    const exitIdx = drainBody.lastIndexOf('app.exit(0)')
    expect(checkpointIdx).toBeGreaterThan(callIdx)
    expect(shutdownTrayIdx).toBeGreaterThan(callIdx)
    expect(exitIdx).toBeGreaterThan(callIdx)
  })

  it('leaves the tray entirely out of the plain before-quit listener', () => {
    const start = MAIN_TS.lastIndexOf("app.on('before-quit', () => {")
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    expect(body).not.toMatch(/^\s*(?:shutdownTray|disarmTray|destroyTray)\(\)/m)
    expect(body).not.toContain('preventDefault')
  })

  it('imports both quit-time entry points, not the plain icon teardown', () => {
    expect(MAIN_TS).toContain("import { disarmTray, shutdownTray } from './services/tray'")
    expect(MAIN_TS).not.toContain("import { destroyTray } from './services/tray'")
  })
})

/**
 * "The drain takes ~28s" is a claim main.ts, services/tray.ts and the tests all
 * make. It is only true while EVERY `await` in the draining handler has a
 * deadline. Five of them once had none at all — `stopIdle`,
 * `disconnectAllPerAccount`, the search worker, the MCP export server and the
 * MCP clients — so one unreachable IMAP or MCP endpoint hung the quit forever
 * behind a stated bound that was really a wish.
 *
 * Source-mirror, like the rest of this file: the drain runs inside Electron's
 * lifecycle and cannot be invoked from a unit test, so what is pinned is the
 * shape of the code.
 */
describe('main.ts §2.99 — the quit drain is bounded, not merely hopeful', () => {
  const drainStart = MAIN_TS.indexOf("app.on('before-quit', (event) => {")
  const drainBody = MAIN_TS.slice(drainStart, MAIN_TS.indexOf('\n})', drainStart))

  /** Every awaited expression is one of these, and each carries its own cap. */
  const BOUNDED_AWAITS = [
    // Explicit per-step deadline (see `drainStep` / TEARDOWN_DEADLINE_MS).
    /^drainStep\(/,
    // Pre-existing caps, passed as literal milliseconds.
    /^waitForBodyIndexerIdle\(10_000\)$/,
    /^waitForPeriodicSyncIdle\(10_000\)$/,
    /^new Promise<void>\(resolve => setTimeout\(resolve, \d+\)\)$/,
    /^flushSentry\(\d+\)$/,
  ]

  it('gives every await in the handler an explicit deadline', () => {
    // Code lines only — the handler's own prose talks about `await` too.
    const awaited = drainBody.split('\n')
      .map(l => l.trim())
      .filter(l => !l.startsWith('//') && !l.startsWith('*'))
      .map(l => /\bawait\s+(.+)$/.exec(l)?.[1])
      .filter((e): e is string => Boolean(e))
      // Strip the trailing `} catch { ... }` of the one-line try wrappers.
      .map(e => e.replace(/\s*\}?\s*catch\s*\{.*$/, '').trim())
    expect(awaited.length).toBeGreaterThanOrEqual(9)
    for (const expr of awaited) {
      expect(
        BOUNDED_AWAITS.some(re => re.test(expr)),
        `unbounded await in the quit drain: \`await ${expr}\` — give it a deadline (drainStep) or add it to BOUNDED_AWAITS with its cap`,
      ).toBe(true)
    }
  })

  it('routes each of the five formerly-unbounded teardown steps through drainStep', () => {
    for (const step of [
      'stopIdle()',
      'disconnectAllPerAccount()',
      'searchWorkerClient.shutdown()',
      '.stop()',
      '.disconnectAll()',
    ]) {
      const line = drainBody.split('\n').find(l => l.includes(step) && l.includes('await '))
      expect(line, `no awaited call to ${step} found in the drain`).toBeDefined()
      expect(line!.trim().startsWith('await drainStep('), `${step} is awaited without a deadline`).toBe(true)
    }
  })

  it('implements drainStep as a race that neither throws nor leaks its timer', () => {
    const start = MAIN_TS.indexOf('async function drainStep(')
    expect(start).toBeGreaterThan(-1)
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n}\n', start))
    // Losing the race must not mean losing the drain: race + a settled-either-
    // way `run()`, no rethrow, and the timer cleared so a step that finished
    // early cannot hold the loop open.
    expect(body).toContain('Promise.race')
    expect(body).toContain('setTimeout')
    expect(body).toContain('clearTimeout(timer)')
    expect(body).not.toMatch(/^\s*throw /m)
    // Third-party text may not reach the log — the step label is ours.
    expect(body).toMatch(/logMain\.warn\([^)]*\{ step: label/)
  })

  it('states a total that matches the constants it is made of', () => {
    // The figure in the handler's own comment is the sum of every deadline
    // above; if someone retunes one constant, this fails instead of leaving a
    // stale promise in three files.
    const constStart = MAIN_TS.indexOf('const TEARDOWN_DEADLINE_MS = {')
    expect(constStart).toBeGreaterThan(-1)
    const constBody = MAIN_TS.slice(constStart, MAIN_TS.indexOf('} as const', constStart))
    const perStep = [...constBody.matchAll(/^\s{2}\w+: ([\d_]+),$/gm)].map(m => Number(m[1].replace(/_/g, '')))
    expect(perStep).toHaveLength(4)
    // imapLogout is spent twice (IDLE connection + per-account pool).
    const teardownTotal = perStep.reduce((a, b) => a + b, 0) + Number(constBody.match(/imapLogout: ([\d_]+)/)![1].replace(/_/g, ''))
    const totalMs = teardownTotal + 10_000 + 10_000 + 150 + 1_500
    const statedSeconds = Number(drainBody.match(/bounded at ~(\d+)s/)![1])
    expect(Math.ceil(totalMs / 1000)).toBe(statedSeconds)
  })
})

describe('main.ts §2.99 — settings change applies tray/autostart from the persisted store, not the payload', () => {
  const start = MAIN_TS.indexOf('function onSettingsChangedMain(')
  const end = MAIN_TS.indexOf('\nasync function syncOneAccountFolders', start)
  const body = MAIN_TS.slice(start, end)

  it('reads getSettings() fresh rather than trusting the caller-supplied `next`', () => {
    const persistedIdx = body.indexOf('const persisted = getSettings()')
    const applyIdx = body.indexOf('applyTrayEnabled(persisted.trayEnabled !== false)')
    expect(persistedIdx).toBeGreaterThan(-1)
    expect(applyIdx).toBeGreaterThan(persistedIdx)
  })

  /**
   * Round-2 HIGH-2 moved the applied-state cache out of main.ts and into
   * services/backgroundMail.ts, because main only ever knew the DESIRED value:
   * a startup registration that failed was recorded as done and no later save
   * ever retried it. main's remaining obligation is to hand the persisted
   * desire to the one owner — the edge-triggering, the retry rule and the
   * status write are that owner's, and are pinned behaviourally in
   * backgroundMail.test.ts (no module-level side effects there).
   */
  it('delegates the autostart decision to the service instead of caching the wish', () => {
    expect(body).toContain('syncLaunchAtLogin(persisted.launchAtLogin === true)')
    // No local cache, and no direct apply: both were the shape that blocked retry.
    expect(MAIN_TS).not.toContain('prevLaunchAtLogin')
    expect(MAIN_TS).not.toContain('applyLaunchAtLoginSetting(')
  })

  it('imports the delegating entry point', () => {
    expect(MAIN_TS).toContain('syncLaunchAtLogin')
  })

  /**
   * Round-3 HIGH — the status write happens INSIDE `onSettingsChangedMain`,
   * which the save handler runs AFTER its own `settings:changed`. Rather than
   * reordering the handler (whose consumers would all need auditing, and whose
   * UI update would then wait on an OS registration), the service publishes the
   * settings again once the outcome is recorded — correct whenever it runs,
   * including the startup write outside any save.
   *
   * The publish itself is pinned behaviourally in backgroundMail.test.ts
   * ("broadcasts settings AFTER writing the status"). What only main can supply
   * — and what a future refactor could quietly drop — is the hook, and the fact
   * that it reads the STORE rather than echoing the payload that triggered it.
   */
  it('gives the service a settings broadcast that reads the store (round-3 HIGH)', () => {
    const start = MAIN_TS.indexOf('initBackgroundMail({')
    expect(start).toBeGreaterThan(-1)
    const block = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
    expect(block).toContain('broadcastSettings: () => { broadcastSettingsChanged(getSettings()) }')
    // Not the save payload: `next` is the handler's local, and echoing it would
    // publish settings that predate the status this exists to carry.
    expect(block).not.toContain('broadcastSettingsChanged(next)')
  })

  it('still broadcasts before the main-process reactions — the early push is unchanged', () => {
    const broadcastIdx = MAIN_TS.indexOf('broadcastSettingsChanged(next)')
    const reactionsIdx = MAIN_TS.indexOf('onSettingsChangedMain(next)')
    expect(broadcastIdx).toBeGreaterThan(-1)
    expect(reactionsIdx).toBeGreaterThan(broadcastIdx)
  })
})

/**
 * §2.99 review H3 gap-fill (codex gap "os_badge_matches_renderer_folder_policy
 * _and_refreshes_after_local_mutations", second residual half).
 *
 * `invalidateUnreadBadge()` itself is behaviourally pinned in
 * backgroundMail.test.ts ("recounts the badge on a local unread change
 * without running the notifier"). What that cannot prove is that main.ts
 * actually CALLS it from every seam that changes local unread state without a
 * sync — a dropped call site here reproduces the exact §2.86-class defect
 * `noteFolderSynced`'s own wiring test guards against, just for the
 * non-sync mutation paths instead of the sync ones.
 */
describe('main.ts §2.99 review H3 — invalidateUnreadBadge runs at every local-mutation seam', () => {
  /**
   * Round-2 HIGH-3 replaced the enumeration this test used to pin ("exactly six
   * call sites") with OWNERSHIP: the invalidation hangs off the functions every
   * mutation of that kind already flows through, so a new caller inherits it.
   * A fixed count would now fail for the right reason — a new owner — and pass
   * for the wrong one, so what is asserted instead is that each owner carries
   * it, plus that nobody re-introduced a raw db write that bypasses an owner.
   */
  it('routes every main-side folder-preference write through the invalidating owners', () => {
    // The owners themselves are the only permitted callers of the db writers.
    const rawUpserts = MAIN_TS.match(/(?<!function write)\bupsertFolderPref\(/g) ?? []
    const rawRemovals = MAIN_TS.match(/(?<!function drop)\bremoveFolderPref\(/g) ?? []
    const rawStale = MAIN_TS.match(/(?<!function dropStale)\bdeleteStaleFolderPrefs\(/g) ?? []
    // Exactly one raw use of each — the call inside its own wrapper.
    expect(rawUpserts).toHaveLength(1)
    expect(rawRemovals).toHaveLength(1)
    expect(rawStale).toHaveLength(1)

    for (const owner of ['function writeFolderPref(', 'function dropFolderPref(', 'function dropStaleFolderPrefs(']) {
      const start = MAIN_TS.indexOf(owner)
      expect(start, owner).toBeGreaterThan(-1)
      expect(MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start)), owner).toContain('invalidateUnreadBadge()')
    }
  })

  it('recounts from the snooze-state owner, so every add/remove/wake path is covered', () => {
    const start = MAIN_TS.indexOf('function notifySnoozeChanged(')
    expect(start).toBeGreaterThan(-1)
    expect(MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start))).toContain('invalidateUnreadBadge()')
  })

  it('recounts from the account-teardown owner when an account is removed', () => {
    const start = MAIN_TS.indexOf('function completeAccountRemoval(')
    expect(start).toBeGreaterThan(-1)
    expect(MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start))).toContain('invalidateUnreadBadge()')
  })

  /**
   * Security review MEDIUM-2 — the notifier keys marks and pending toasts by
   * numeric account id, and ids are REUSED (`max + 1`). The teardown itself is
   * pinned behaviourally in mailNotifier.test.ts; what only main can get wrong
   * is failing to call it from the one function that owns account teardown, so
   * that is what is asserted here.
   */
  it('forgets the notifier state of a removed account, from the same owner', () => {
    const start = MAIN_TS.indexOf('function completeAccountRemoval(')
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n}', start))
    expect(body).toContain('forgetAccountBackgroundState(id)')
  })

  it('purgeVirtualFolderRefs recounts after a message leaves a folder locally (move/archive/delete/trash)', () => {
    const start = MAIN_TS.indexOf('function purgeVirtualFolderRefs(')
    const end = MAIN_TS.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    expect(MAIN_TS.slice(start, end)).toContain('invalidateUnreadBadge()')
  })

  it('processSnoozed recounts a woken message through the snooze owner', () => {
    const start = MAIN_TS.indexOf('function processSnoozed(')
    const end = MAIN_TS.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    // Not a direct call any more: the wake loop notifies, and notifying is what
    // invalidates (asserted above) — one owner instead of two call sites that
    // must be kept in step.
    expect(MAIN_TS.slice(start, end)).toContain('notifySnoozeChanged(item.accountId)')
  })

  it('replayAllOfflineOps recounts once after queued flag/move/delete ops land', () => {
    const start = MAIN_TS.indexOf('async function replayAllOfflineOps(')
    const end = MAIN_TS.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    expect(MAIN_TS.slice(start, end)).toContain('invalidateUnreadBadge()')
  })

  describe('net:setSeen recounts on all three reachable exits — three separate calls, not a shared finally', () => {
    const start = MAIN_TS.indexOf("handleIpc('net:setSeen',")
    const end = MAIN_TS.indexOf('\n})', start)
    const body = MAIN_TS.slice(start, end)

    it('locates the handler', () => {
      expect(start).toBeGreaterThan(-1)
    })

    it('recounts on the offline-queued exit (workOffline branch)', () => {
      const workOfflineIdx = body.indexOf('if (getSettings().workOffline) {')
      const blockEnd = body.indexOf('\n  }', workOfflineIdx)
      expect(workOfflineIdx).toBeGreaterThan(-1)
      expect(body.slice(workOfflineIdx, blockEnd)).toContain('invalidateUnreadBadge()')
    })

    it('recounts on the transient-failure-queued exit (catch branch)', () => {
      const catchIdx = body.indexOf('if (isTransientNetworkError(err)) {')
      const blockEnd = body.indexOf('\n    }', catchIdx)
      expect(catchIdx).toBeGreaterThan(-1)
      expect(body.slice(catchIdx, blockEnd)).toContain('invalidateUnreadBadge()')
    })

    it('recounts on the normal online success exit, after the try/catch', () => {
      // The third call sits after the whole try/catch, immediately before the
      // final `return { ok: true }` — reached only when setSeen succeeded
      // outright (neither of the two branches above returned first).
      // §2.17 Phase 1 — the call is wrapped in the interactive-tier scope
      // (`imapInteractive`), so the anchor names the wrapper. The assertion is
      // unchanged: the third recount still sits after the whole try/catch.
      const tryIdx = body.indexOf('try {\n    await imapInteractive(() => setSeen(')
      const lastInvalidateIdx = body.lastIndexOf('invalidateUnreadBadge()')
      const finalReturnIdx = body.lastIndexOf('return { ok: true as const }')
      expect(tryIdx).toBeGreaterThan(-1)
      expect(lastInvalidateIdx).toBeGreaterThan(tryIdx)
      expect(finalReturnIdx).toBeGreaterThan(lastInvalidateIdx)
    })

    it('does not call invalidateUnreadBadge from the IS_E2E short-circuit at the top', () => {
      const e2eIdx = body.indexOf('if (IS_E2E) {')
      const e2eBlockEnd = body.indexOf('\n  }', e2eIdx)
      expect(e2eIdx).toBeGreaterThan(-1)
      expect(body.slice(e2eIdx, e2eBlockEnd)).not.toContain('invalidateUnreadBadge()')
    })
  })
})
