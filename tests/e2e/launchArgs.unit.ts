/**
 * Unit tests for the e2e launch arguments (launchArgs.ts), run by vitest — the
 * `.unit.ts` suffix keeps them out of Playwright's testMatch.
 */
import { describe, expect, it } from 'vitest'
import { electronLaunchArgs, forceX11Args, hasDisplayServer } from './launchArgs'
import { E2E_RUN_ID_ENV, runMarkerArg } from './runMarker'

const RUN_ID = '5b0c6e2a-7d1f-4a3b-9c8d-112233445566'

describe('electronLaunchArgs', () => {
  it('pins Linux launches to X11 and tags them with the current run marker', () => {
    const args = electronLaunchArgs({ platform: 'linux', env: { [E2E_RUN_ID_ENV]: RUN_ID } })

    expect(args[0]).toBe('.')
    expect(args).toContain('--no-sandbox')
    expect(args).toContain('--ozone-platform=x11')
    expect(args).toContain(runMarkerArg(RUN_ID))
  })

  it('adds no X11 switch off Linux and no marker without a valid run id', () => {
    const args = electronLaunchArgs({ platform: 'darwin', env: {} })

    expect(args).not.toContain('--ozone-platform=x11')
    expect(args.some(a => a.startsWith('--mailcopilot-e2e-run'))).toBe(false)
    expect(forceX11Args({ platform: 'win32' })).toEqual([])
  })
})

describe('hasDisplayServer', () => {
  it('does not count a Wayland-only session as a display the app can use', () => {
    expect(hasDisplayServer({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })).toBe(false)
    expect(hasDisplayServer({ platform: 'linux', env: {} })).toBe(false)
  })

  it('counts an X display on Linux, and always has one elsewhere', () => {
    expect(hasDisplayServer({ platform: 'linux', env: { DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-0' } })).toBe(true)
    expect(hasDisplayServer({ platform: 'darwin', env: {} })).toBe(true)
  })
})
