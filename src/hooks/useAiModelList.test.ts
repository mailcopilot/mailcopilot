// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { readModelListResult, useAiModelList } from './useAiModelList'

const invoke = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  ;(window as unknown as { api: unknown }).api = { invoke }
})
afterEach(() => { vi.restoreAllMocks() })

describe('readModelListResult', () => {
  it('accepts a list and drops malformed rows', () => {
    expect(readModelListResult({ ok: true, models: [{ id: 'a', label: 'A' }, { id: '', label: 'x' }, null, { id: 'b' }] }))
      .toEqual({ ok: true, models: [{ id: 'a', label: 'A' }] })
  })

  it('accepts a known failure word and turns anything else into provider', () => {
    expect(readModelListResult({ ok: false, reason: 'invalid_key' })).toEqual({ ok: false, reason: 'invalid_key' })
    expect(readModelListResult({ ok: false, reason: 'Gemini says: sk-secret' })).toEqual({ ok: false, reason: 'provider' })
    expect(readModelListResult(undefined)).toEqual({ ok: false, reason: 'provider' })
  })
})

describe('useAiModelList', () => {
  it('stays idle and asks nothing while no key is known', () => {
    const { result } = renderHook(() => useAiModelList('gemini-api', false))
    expect(result.current.state.status).toBe('idle')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('loads when active, naming only the provider (no key, no overrides)', async () => {
    invoke.mockResolvedValue({ ok: true, models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }] })
    const { result } = renderHook(() => useAiModelList('gemini-api', true))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(invoke).toHaveBeenCalledWith('ai:listModels', 'gemini-api', undefined)
    expect(result.current.state.models).toHaveLength(1)
  })

  it('reload sends the address fields as the form holds them: an emptied field is sent explicitly, as on save', async () => {
    invoke.mockResolvedValue({ ok: true, models: [] })
    const { result } = renderHook(() => useAiModelList('openai-api', true))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    // The automatic load sends nothing: it must never raise the confirmation dialog.
    expect(invoke).toHaveBeenLastCalledWith('ai:listModels', 'openai-api', undefined)
    await act(async () => { await result.current.reload({ aiOpenAiBaseUrl: 'https://openrouter.ai/api' }) })
    const typed = invoke.mock.lastCall?.[2] as Record<string, unknown>
    expect(typed.aiOpenAiBaseUrl).toBe('https://openrouter.ai/api')
    expect('aiProxyUrl' in typed).toBe(true)
    // Both fields emptied after a saved server/proxy: main must read this as "do not use", like settings:save does,
    // not as "keep the saved value" (which an absent key means).
    await act(async () => { await result.current.reload({ aiProxyUrl: undefined, aiOpenAiBaseUrl: undefined }) })
    const cleared = invoke.mock.lastCall?.[2] as Record<string, unknown>
    expect(cleared).toBeDefined()
    expect('aiProxyUrl' in cleared && 'aiOpenAiBaseUrl' in cleared).toBe(true)
    expect(cleared.aiProxyUrl).toBeUndefined()
    expect(cleared.aiOpenAiBaseUrl).toBeUndefined()
  })

  it('a failed load is an error state with the reason and no models', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'network' })
    const { result } = renderHook(() => useAiModelList('anthropic-api', true))
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(result.current.state).toMatchObject({ reason: 'network', models: [] })
  })

  it('a rejected IPC call is a provider failure, not an unhandled rejection', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useAiModelList('anthropic-api', true))
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'error', reason: 'provider' }))
  })

  it('drops a late answer for a provider the user has left', async () => {
    let release: (v: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise(r => { release = r }))
    invoke.mockResolvedValueOnce({ ok: true, models: [{ id: 'new-model', label: 'new-model' }] })
    const { result, rerender } = renderHook(({ p }) => useAiModelList(p, true), { initialProps: { p: 'openai-api' } })
    rerender({ p: 'gemini-api' })
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => { release({ ok: true, models: [{ id: 'stale-model', label: 'stale-model' }] }) })
    expect(result.current.state.models.map(m => m.id)).toEqual(['new-model'])
  })
})
