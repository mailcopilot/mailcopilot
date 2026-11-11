// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import en from '../../i18n/locales/en.json'
import { AiModelPicker } from './AiModelPicker'
import type { AiModelListState } from '../../hooks/useAiModelList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as string ?? key,
  }),
}))

afterEach(cleanup)

const READY: AiModelListState = {
  status: 'ready',
  models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }, { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }],
}

function setup(over: Partial<React.ComponentProps<typeof AiModelPicker>> = {}) {
  const onChange = vi.fn()
  const onRefresh = vi.fn()
  render(
    <AiModelPicker provider="gemini-api" value="gemini-3.6-flash" onChange={onChange} list={READY} onRefresh={onRefresh} overrides={{}} {...over} />,
  )
  return { onChange, onRefresh }
}

describe('AiModelPicker', () => {
  it('shows the saved model from the provider list and lets the user pick another', () => {
    const { onChange } = setup()
    const trigger = screen.getByTestId('settings-ai-model')
    expect(trigger).toHaveTextContent('Gemini 3.6 Flash')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: /Gemini 3\.8 Flash/ }))
    expect(onChange).toHaveBeenCalledWith('gemini-3.8-flash')
  })

  it('keeps a saved model that the list does not contain selected and visible', () => {
    setup({ value: 'gemini-2.0-flash' })
    expect(screen.getByTestId('settings-ai-model')).toHaveTextContent('gemini-2.0-flash')
  })

  it('shows the provider default when no model was ever chosen', () => {
    setup({ value: '' })
    expect(screen.getByTestId('settings-ai-model')).toHaveTextContent('Gemini 3.8 Flash')
  })

  it('offers free text for any id and a way back to the list', () => {
    const { onChange } = setup()
    fireEvent.click(screen.getByTestId('settings-ai-model'))
    fireEvent.click(screen.getByRole('option', { name: en.ai.settings.modelCustom }))
    const input = screen.getByTestId('settings-ai-model') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    fireEvent.change(input, { target: { value: 'my-private-model' } })
    expect(onChange).toHaveBeenCalledWith('my-private-model')
    fireEvent.click(screen.getByTestId('settings-ai-model-from-list'))
    expect(screen.getByTestId('settings-ai-model').tagName).toBe('BUTTON')
  })

  it('falls back to plain text with the current value and a reason when the list failed', () => {
    setup({ value: 'gemini-2.0-flash', list: { status: 'error', models: [], reason: 'network' } })
    const input = screen.getByTestId('settings-ai-model') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    expect(input.value).toBe('gemini-2.0-flash')
    expect(screen.getByTestId('settings-ai-model-error')).toHaveTextContent(en.ai.settings.modelListError.network)
  })

  it('is plain text before any list was loaded', () => {
    setup({ list: { status: 'idle', models: [] } })
    expect((screen.getByTestId('settings-ai-model') as HTMLInputElement).tagName).toBe('INPUT')
  })

  it('refresh passes the unsaved address fields and is disabled while loading', () => {
    const { onRefresh } = setup({ overrides: { aiOpenAiBaseUrl: 'https://openrouter.ai/api' } })
    fireEvent.click(screen.getByTestId('settings-ai-model-refresh'))
    expect(onRefresh).toHaveBeenCalledWith({ aiOpenAiBaseUrl: 'https://openrouter.ai/api' })
    cleanup()
    setup({ list: { status: 'loading', models: [] } })
    expect(screen.getByTestId('settings-ai-model-refresh')).toBeDisabled()
  })
})
