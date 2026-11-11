/**
 * Launch arguments and display detection for every Electron launch in the e2e
 * tree. Kept free of `@playwright/test` imports so vitest can unit-test it
 * (`launchArgs.unit.ts`); `helpers.ts` re-exports it for the specs.
 *
 * Platform and environment are parameters defaulting to the current process,
 * so tests inject them instead of mutating globals.
 */
import { runMarkerArgs } from './runMarker'

export type LaunchContext = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

export function hasDisplayServer({ platform = process.platform, env = process.env }: LaunchContext = {}): boolean {
  if (platform !== 'linux') return true
  // Only an X display counts: `forceX11Args()` pins the app to X11, so a
  // session that offers nothing but Wayland cannot host it and must fall back
  // to xvfb-run.
  return Boolean(env.DISPLAY)
}

/**
 * Chromium switch that pins the display backend to X11 on Linux; empty
 * elsewhere.
 *
 * On a Wayland desktop Electron's ozone layer auto-selects Wayland and connects
 * to the developer's real compositor even when started under `xvfb-run`
 * (unsetting WAYLAND_DISPLAY does not help: libwayland falls back to the
 * `wayland-0` socket in XDG_RUNTIME_DIR). The windows then appear on the
 * developer's monitors instead of Xvfb and nearly every test times out. Forcing
 * X11 makes the display in DISPLAY — the virtual one under xvfb-run — the only
 * one the app can reach.
 */
export function forceX11Args({ platform = process.platform }: LaunchContext = {}): string[] {
  return platform === 'linux' ? ['--ozone-platform=x11'] : []
}

/**
 * Arguments for every Electron launch in the e2e tree. Launch sites must use
 * this instead of spelling out their own list, so a flag that keeps the app off
 * the developer's screen or makes it reapable cannot be missed at one of them.
 */
export function electronLaunchArgs(context: LaunchContext = {}): string[] {
  return [
    '.',
    // --no-sandbox is required in CI (Docker runs as root).
    '--no-sandbox',
    // --disable-gpu — software rendering, stabilizes operation in Docker without GPU.
    '--disable-gpu',
    // --disable-dev-shm-usage — Docker containers have limited /dev/shm (64 MB default),
    //   Chromium uses it for shared memory; insufficient space causes renderer crashes
    //   ("Target crashed" errors). This flag tells Chromium to use /tmp instead.
    '--disable-dev-shm-usage',
    ...forceX11Args(context),
    // Tags the app with this Playwright run's id so global-teardown.ts can kill
    // it if a torn-down worker never closed it (see runMarker.ts).
    ...runMarkerArgs(context.env ?? process.env),
  ]
}
