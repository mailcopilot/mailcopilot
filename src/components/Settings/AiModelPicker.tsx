import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import { DEFAULT_AI_MODELS, type AiModelProvider } from '@mailcopilot/core'
import { Select } from '../Select'
import type { AiModelListOverrides, AiModelListState } from '../../hooks/useAiModelList'

const CUSTOM = '__custom__'

interface Props {
  provider: AiModelProvider
  /** The saved model id; empty means "never chosen", shown as the provider default. */
  value: string
  onChange: (id: string) => void
  list: AiModelListState
  onRefresh: (overrides?: AiModelListOverrides) => void
  /** Unsaved address fields, sent only when the user presses refresh. */
  overrides: AiModelListOverrides
}

/**
 * Model field of the AI settings: the provider's own list plus free text for any id. A model that is not in the
 * list (saved earlier, or typed) stays selected and visible. When the list cannot be loaded the field is plain text.
 */
export function AiModelPicker({ provider, value, onChange, list, onRefresh, overrides }: Props) {
  const { t } = useTranslation()
  const [custom, setCustom] = useState(false)
  const current = value || DEFAULT_AI_MODELS[provider]
  const hasList = list.models.length > 0
  const inList = list.models.some(m => m.id === current)
  const showText = !hasList || custom

  const options = [
    ...list.models.map(m => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label} (${m.id})` })),
    ...(!inList && !showText ? [{ value: current, label: current }] : []),
    { value: CUSTOM, label: t('ai.settings.modelCustom') },
  ]

  return (
    <>
      {showText ? (
        <input
          data-testid="settings-ai-model"
          type="text"
          value={value}
          placeholder={DEFAULT_AI_MODELS[provider]}
          aria-label={t('ai.settings.model')}
          onChange={e => onChange(e.target.value)}
          style={{ width: 220, fontFamily: 'monospace' }}
        />
      ) : (
        <Select
          testId="settings-ai-model"
          value={current}
          onChange={v => {
            if (v === CUSTOM) { setCustom(true); return }
            setCustom(false)
            onChange(v)
          }}
          ariaLabel={t('ai.settings.model')}
          options={options}
        />
      )}
      {hasList && custom && (
        <button type="button" className="btn-link" data-testid="settings-ai-model-from-list" onClick={() => setCustom(false)}>
          {t('ai.settings.modelFromList')}
        </button>
      )}
      <button
        type="button"
        className="btn-link"
        data-testid="settings-ai-model-refresh"
        aria-label={t('ai.settings.modelRefresh')}
        title={t('ai.settings.modelRefresh')}
        disabled={list.status === 'loading'}
        onClick={() => onRefresh(overrides)}
      >
        {list.status === 'loading' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
      </button>
      {list.status === 'error' && (
        <span className="hint-inline" data-testid="settings-ai-model-error">
          {t(`ai.settings.modelListError.${list.reason}`)}
        </span>
      )}
    </>
  )
}
