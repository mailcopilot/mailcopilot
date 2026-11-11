import { describe, it, expect, vi } from 'vitest'
import { installUpdaterRequestPolicy, stripUpdaterRequestHeaders } from './updaterRequestPolicy'

// The behaviour on a real request is proven in tests/e2e/updater-request-headers.spec.ts;
// these pin the pure part and the failure mode of the hook.
describe('stripUpdaterRequestHeaders', () => {
  it('drops Accept-Language in any case and keeps every other header untouched', () => {
    const out = stripUpdaterRequestHeaders({
      'Accept-Language': 'ru-RU', 'accept-language': 'en-US', 'ACCEPT-LANGUAGE': 'de',
      'x-user-staging-id': 'id', 'User-Agent': 'electron-builder', Range: 'bytes=0-9',
    })
    expect(out).toEqual({ 'x-user-staging-id': 'id', 'User-Agent': 'electron-builder', Range: 'bytes=0-9' })
  })

  it('does not mutate its input', () => {
    const input = { 'Accept-Language': 'en-US', a: 'b' }
    stripUpdaterRequestHeaders(input)
    expect(input).toEqual({ 'Accept-Language': 'en-US', a: 'b' })
  })
})

describe('installUpdaterRequestPolicy', () => {
  it('registers a before-send-headers hook that answers with the stripped headers', () => {
    const onBeforeSendHeaders = vi.fn()
    installUpdaterRequestPolicy({ webRequest: { onBeforeSendHeaders } } as never)
    const hook = onBeforeSendHeaders.mock.calls[0]![0] as (d: unknown, cb: (r: unknown) => void) => void
    const cb = vi.fn()
    hook({ requestHeaders: { 'Accept-Language': 'en-US', Host: 'h' } }, cb)
    expect(cb).toHaveBeenCalledWith({ requestHeaders: { Host: 'h' } })
  })

  it('lets the request through unchanged when the hook itself fails', () => {
    const onBeforeSendHeaders = vi.fn()
    installUpdaterRequestPolicy({ webRequest: { onBeforeSendHeaders } } as never)
    const hook = onBeforeSendHeaders.mock.calls[0]![0] as (d: unknown, cb: (r: unknown) => void) => void
    const cb = vi.fn()
    hook({ requestHeaders: null }, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({})
  })
})
