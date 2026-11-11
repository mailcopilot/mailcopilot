/**
 * Unit tests for the Playwright global teardown's reporting, run by vitest —
 * the `.unit.ts` suffix keeps them out of Playwright's testMatch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import globalTeardown from './global-teardown'
import { reapRunMarkedProcesses } from './runMarker'

vi.mock('./runMarker', async importOriginal => ({
  ...(await importOriginal<typeof import('./runMarker')>()),
  reapRunMarkedProcesses: vi.fn(),
}))

const reap = vi.mocked(reapRunMarkedProcesses)

afterEach(() => {
  vi.restoreAllMocks()
  reap.mockReset()
})

describe('globalTeardown', () => {
  it('warns when the process table could not be scanned instead of reporting "found 0"', async () => {
    reap.mockResolvedValue({ status: 'scan-failed', error: 'cannot list /proc: EACCES' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await globalTeardown()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/WARNING: could not list processes \(cannot list \/proc: EACCES\).*NOT reaped/)
    expect(log).not.toHaveBeenCalled()
  })

  it('logs the counts of a completed scan', async () => {
    reap.mockResolvedValue({
      status: 'done',
      found: 2,
      killed: 2,
      unreadable: 3,
      identityChanged: 0,
      xvfbScanFailed: false,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await globalTeardown()

    expect(log.mock.calls[0][0]).toContain('found 2, killed 2')
    expect(warn).not.toHaveBeenCalled()
  })

  it('never throws when reaping itself fails', async () => {
    reap.mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(globalTeardown()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[e2e-teardown] orphan reaping failed:', expect.any(Error))
  })
})
