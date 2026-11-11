import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiModelListFailure, AiModelListResult, AiModelOption } from '@mailcopilot/core'

export type AiModelListState =
  | { status: 'idle'; models: AiModelOption[] }
  | { status: 'loading'; models: AiModelOption[] }
  | { status: 'ready'; models: AiModelOption[] }
  | { status: 'error'; models: AiModelOption[]; reason: AiModelListFailure }

export interface AiModelListOverrides {
  aiProxyUrl?: string
  aiOpenAiBaseUrl?: string
}

const REASONS: ReadonlySet<string> = new Set<AiModelListFailure>([
  'no_key', 'invalid_key', 'store_unavailable', 'destination_not_approved', 'network', 'timeout', 'provider',
])

/** Reads the answer of `ai:listModels` defensively: anything unexpected is a `provider` failure. */
export function readModelListResult(raw: unknown): AiModelListResult {
  const r = raw as Partial<AiModelListResult> | null
  if (r && r.ok === true && Array.isArray(r.models)) {
    const models = r.models.filter(
      (m): m is AiModelOption => !!m && typeof m.id === 'string' && m.id !== '' && typeof m.label === 'string',
    )
    return { ok: true, models }
  }
  if (r && r.ok === false && typeof r.reason === 'string' && REASONS.has(r.reason)) {
    return { ok: false, reason: r.reason }
  }
  return { ok: false, reason: 'provider' }
}

/**
 * The provider's model list for the Settings picker. Loads when `active` turns on (a key is stored) and on
 * `reload`. The automatic load sends no address overrides, so it can never raise the destination-approval dialog;
 * the refresh button passes the unsaved proxy/base URL as the form holds them, an emptied field explicitly (the
 * shared merge rule reads a present key as the new value, `undefined` meaning "do not use"). A late answer for a
 * provider the user has since left is dropped.
 */
export function useAiModelList(provider: string, active: boolean) {
  const [state, setState] = useState<AiModelListState>({ status: 'idle', models: [] })
  const seq = useRef(0)

  const load = useCallback(async (overrides?: AiModelListOverrides) => {
    if (!provider) return
    const mine = ++seq.current
    setState(prev => ({ status: 'loading', models: prev.models }))
    let result: AiModelListResult
    try {
      // The refresh button hands over the form as it is. BOTH keys are sent, an emptied field as an explicit
      // `undefined`: main reads a present-but-empty key as "do not use this", exactly as `settings:save` does, while an
      // absent key means "keep the saved value". Dropping the empty one made the list come from a server or proxy the
      // user had just cleared.
      const given: AiModelListOverrides | undefined = overrides
        ? { aiProxyUrl: overrides.aiProxyUrl || undefined, aiOpenAiBaseUrl: overrides.aiOpenAiBaseUrl || undefined }
        : undefined
      result = readModelListResult(
        await window.api.invoke('ai:listModels', provider, given),
      )
    } catch {
      result = { ok: false, reason: 'provider' }
    }
    if (mine !== seq.current) return
    setState(result.ok
      ? { status: 'ready', models: result.models }
      : { status: 'error', models: [], reason: result.reason })
  }, [provider])

  useEffect(() => {
    if (!active || !provider) {
      seq.current++
      setState({ status: 'idle', models: [] })
      return
    }
    void load()
  }, [active, provider, load])

  return { state, reload: load }
}
