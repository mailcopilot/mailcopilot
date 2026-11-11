// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const captureException = vi.fn()
vi.mock('../sentry', () => ({ captureException: (...args: unknown[]) => captureException(...args) }))

import { parseGoogleSignInAvailability, useGoogleSignInAvailability } from './useGoogleSignInAvailability'

describe('parseGoogleSignInAvailability', () => {
  it('reads a well-formed reply', () => {
    expect(parseGoogleSignInAvailability({ configured: true, newMailboxes: true }))
      .toEqual({ configured: true, newMailboxes: true })
    expect(parseGoogleSignInAvailability({ configured: true, newMailboxes: false }))
      .toEqual({ configured: true, newMailboxes: false })
  })

  it('treats anything but a literal true as false', () => {
    for (const bad of ['true', 1, 'yes', {}, [], null, undefined]) {
      expect(parseGoogleSignInAvailability({ configured: bad, newMailboxes: bad }))
        .toEqual({ configured: false, newMailboxes: false })
      expect(parseGoogleSignInAvailability({ configured: true, newMailboxes: bad }))
        .toEqual({ configured: true, newMailboxes: false })
    }
  })

  it('never reports new mailboxes without a configured client', () => {
    expect(parseGoogleSignInAvailability({ configured: false, newMailboxes: true }))
      .toEqual({ configured: false, newMailboxes: false })
  })

  it('tolerates a missing or non-object reply', () => {
    for (const raw of [undefined, null, 'ok', 42, []]) {
      expect(parseGoogleSignInAvailability(raw)).toEqual({ configured: false, newMailboxes: false })
    }
  })
})

describe('useGoogleSignInAvailability', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { value: { invoke }, writable: true, configurable: true })
  })
  afterEach(() => { invoke.mockReset() })

  it('starts unavailable, before the reply arrives', () => {
    invoke.mockReturnValue(new Promise(() => { /* never settles */ }))
    const { result } = renderHook(() => useGoogleSignInAvailability())
    expect(result.current).toEqual({ configured: false, newMailboxes: false })
    expect(invoke).toHaveBeenCalledWith('oauth:google:availability')
  })

  it('applies the reply from main', async () => {
    invoke.mockResolvedValue({ configured: true, newMailboxes: false })
    const { result } = renderHook(() => useGoogleSignInAvailability())
    await waitFor(() => expect(result.current).toEqual({ configured: true, newMailboxes: false }))
  })

  it('stays unavailable and reports when the invoke rejects', async () => {
    invoke.mockRejectedValue(new Error('channel down'))
    const { result } = renderHook(() => useGoogleSignInAvailability())
    await waitFor(() => expect(captureException).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({ configured: false, newMailboxes: false })
  })

  it('stays unavailable on a malformed reply', async () => {
    invoke.mockResolvedValue('nonsense')
    const { result } = renderHook(() => useGoogleSignInAvailability())
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    await Promise.resolve()
    expect(result.current).toEqual({ configured: false, newMailboxes: false })
  })
})
