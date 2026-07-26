// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock react-i18next — stable reference to t (like in real i18next),
// so that adding t to useEffect deps doesn't cause infinite render loop.
const i18nMap: Record<string, string> = {
  'ai.panel.title': 'AI Ассистент',
  'ai.panel.newChat': 'Новый чат',
  'ai.panel.close': 'Закрыть',
  'ai.panel.stop': 'Остановить',
  'ai.panel.thinking': 'Думаю...',
  'ai.panel.streaming': 'Генерирую...',
  'ai.panel.placeholder': 'Спросите что-нибудь...',
  'ai.panel.send': 'Отправить',
  'ai.errors.requestBudgetStopped': 'Запрос остановлен: достигнут лимит стоимости одного запроса.',
  'ai.onboarding.title': 'AI Ассистент',
  'ai.onboarding.description': 'Встроенный ассистент',
  'ai.onboarding.chooseProvider': 'Выберите способ:',
  'ai.onboarding.subscription': 'Подписка Claude',
  'ai.onboarding.subscriptionHint': 'Pro/Max',
  'ai.onboarding.apiKey': 'API-ключ',
  'ai.onboarding.apiKeyHint': 'Оплата по токенам',
  'ai.onboarding.configure': 'Настроить',
  'ai.onboarding.features.summarize': 'Суммаризация',
  'ai.onboarding.features.drafts': 'Черновики',
  'ai.onboarding.features.search': 'Поиск',
  'ai.onboarding.features.digest': 'Дайджест',
  'ai.privacy.title': 'Конфиденциальность',
  'ai.privacy.description': 'Данные отправляются провайдеру',
  'ai.privacy.accept': 'Согласен',
  'ai.privacy.cancel': 'Отмена',
  'ai.chips.summarize': 'Суммируй',
  'ai.chips.reply': 'Ответь',
  'ai.chips.summarizeThread': 'Суммируй цепочку',
  'ai.chips.keyDecisions': 'Ключевые решения',
  'ai.chips.digest': 'Дайджест',
  'ai.chips.needsReply': 'Требует ответа',
  'ai.chips.gtdTriage': 'GTD-разбор',
  'ai.chips.scopeFolder': 'Действия с папкой',
  'ai.chips.scopeEmail': 'Действия с письмом',
  'ai.errors.authCheck': 'Ошибка проверки авторизации',
  'ai.errors.errorPrefix': 'Ошибка',
  'ai.errors.invalidKey': 'Неверный ключ',
  'ai.errors.noSubscription': 'Нет подписки',
  'ai.errors.notConfigured': 'Не настроено',
  'ai.prompts.summarize': 'Суммируй это письмо',
  'ai.prompts.reply': 'Подготовь ответ на это письмо',
  'ai.prompts.summarizeThread': 'Суммируй эту цепочку писем',
  'ai.prompts.keyDecisions': 'Выдели ключевые решения',
  'ai.prompts.digest': 'Дайджест непрочитанных',
  'ai.prompts.needsReply': 'Какие письма требуют ответа?',
  'ai.sessions.title': 'История чатов',
  'ai.sessions.history': 'История',
  'ai.sessions.empty': 'Нет сохранённых бесед',
  'ai.sessions.untitled': 'Без названия',
  'ai.sessions.delete': 'Удалить беседу',
  'ai.sessions.clearAll': 'Очистить всё',
  // §3.10 P0 confirmation strings — used when wiring AiActionConfirmation.
  'ai.confirmation.apply': 'Применить',
  'ai.confirmation.applied': 'Применено',
  'ai.confirmation.cancel': 'Отмена',
  'ai.confirmation.account': 'Аккаунт #{{accountId}}',
  'ai.confirmation.folder': 'Папка: {{folder}}',
  'ai.confirmation.emailCount': '{{count}} письмо(а)',
  'ai.confirmation.errorPreviewMissing': 'Действие истекло',
  'ai.confirmation.proceedPrompt': 'Подтверждено; confirmation_token={{token}}',
  'ai.confirmation.kinds.snooze_email': 'Отложить письма',
  'ai.confirmation.kinds.flag_email.star': 'Звёздочка письмам',
  // §3.10 P2 egress confirm modal strings.
  'ai.egress.shieldTooltip': 'Доступ AI к интернету перехватывается',
  'ai.egress.confirmTitle': 'AI хочет обратиться в интернет',
  'ai.egress.confirmAllow': 'Разрешить',
  'ai.egress.confirmDeny': 'Запретить',
  'ai.egress.action.webSearch': 'Веб-поиск:',
  'ai.egress.action.webFetch': 'Загрузка URL:',
  'ai.egress.action.externalTool': 'Вызов внешнего инструмента',
  'ai.egress.timeout': 'Время ожидания истекло — доступ запрещён',
}
const stableT = (key: string, opts?: Record<string, unknown>) => {
  if (key === 'ai.panel.usingTool') return `Использую: ${opts?.tool ?? ''}...`
  let text = i18nMap[key] ?? key
  if (opts && typeof opts === 'object') {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
    }
  }
  return text
}
// AiActionConfirmation calls i18n.exists() to choose between the i18nKey and
// the description fallback. Reflect i18nMap presence accurately.
const stableI18n = {
  exists: (k: string) => Object.prototype.hasOwnProperty.call(i18nMap, k),
}
const stableUseTranslation = { t: stableT, i18n: stableI18n }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

// Mock react-markdown
vi.mock('react-markdown', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react')
  return {
    default: ({ children }: { children: string }) =>
      React.createElement('div', { 'data-testid': 'markdown' }, children),
  }
})

vi.mock('remark-gfm', () => ({ default: () => {} }))

// Mock window.api — add api to existing window (jsdom)
const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()
const mockRemoveAll = vi.fn()

Object.defineProperty(window, 'api', {
  value: {
    invoke: mockInvoke,
    on: mockOn,
    off: mockOff,
    removeAll: mockRemoveAll,
  },
  writable: true,
  configurable: true,
})

import AiPanel from './AiPanel'
import type { AiPanelProps } from './AiPanel'
import React from 'react'
// §1.4 renderer IPC dedup — reset the module-scoped cache/inflight maps
// between tests so the 500ms result cache doesn't hide duplicate calls
// across `it` blocks.
import { __resetForTests as resetSingleFlight } from '../utils/ipcSingleFlight'

function renderPanel(props: Partial<AiPanelProps> = {}) {
  const defaults: AiPanelProps = {
    open: true,
    onClose: vi.fn(),
    contextType: null,
    contextData: null,
    aiProvider: 'subscription',
    aiPrivacyConsent: true,
    aiSendOnEnter: true,
    onSettingsChange: vi.fn(),
    ...props,
  }
  return render(React.createElement(AiPanel, defaults))
}

describe('AiPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSingleFlight()
    // jsdom doesn't implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
    // Stable UUID for session creation
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('test-session-uuid' as `${string}-${string}-${string}-${string}-${string}`)
    // By default, authorization is successful and session IPC resolves
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
      if (channel === 'aiSession:list') return Promise.resolve([])
      if (channel === 'aiSession:create') return Promise.resolve({ id: 'test-session-uuid', title: '', provider: 'subscription' })
      if (channel === 'aiSession:addMessage') return Promise.resolve({ id: 1 })
      if (channel === 'aiSession:messages') return Promise.resolve([])
      if (channel === 'aiSession:generateTitle') return Promise.resolve('Test Title')
      return Promise.resolve()
    })
  })

  afterEach(() => {
    cleanup()
  })

  // --- Rendering ---

  describe('Rendering', () => {
    it('renders nothing when open=false', () => {
      renderPanel({ open: false })
      expect(screen.queryByTestId('ai-panel')).toBeNull()
    })

    it('renders panel when open=true', async () => {
      await act(async () => { renderPanel() })
      expect(screen.getByTestId('ai-panel')).toBeInTheDocument()
    })

    it('shows AI Assistant title', async () => {
      await act(async () => { renderPanel() })
      expect(screen.getByText('AI Ассистент')).toBeInTheDocument()
    })

    it('shows input field', async () => {
      await act(async () => { renderPanel() })
      expect(screen.getByTestId('ai-input')).toBeInTheDocument()
    })

    it('shows placeholder when messages are empty', async () => {
      await act(async () => { renderPanel() })
      expect(screen.getByText('Спросите что-нибудь...')).toBeInTheDocument()
    })
  })

  // --- Onboarding ---

  describe('Onboarding', () => {
    it('shows onboarding if provider is not set', async () => {
      await act(async () => { renderPanel({ aiProvider: undefined }) })
      expect(screen.getByTestId('ai-onboarding')).toBeInTheDocument()
    })

    it('shows two options: subscription and API key', async () => {
      await act(async () => { renderPanel({ aiProvider: undefined }) })
      expect(screen.getByText('Подписка Claude')).toBeInTheDocument()
      expect(screen.getByText('API-ключ')).toBeInTheDocument()
    })

    it('calls onSettingsChange when selecting subscription', async () => {
      const onSettingsChange = vi.fn()
      await act(async () => { renderPanel({ aiProvider: undefined, onSettingsChange }) })

      const subscriptionBtn = screen.getByText('Подписка Claude').closest('button')!
      await act(async () => { fireEvent.click(subscriptionBtn) })

      expect(onSettingsChange).toHaveBeenCalledWith('aiProvider', 'subscription')
    })

    it('calls onSettingsChange when selecting API key', async () => {
      const onSettingsChange = vi.fn()
      await act(async () => { renderPanel({ aiProvider: undefined, onSettingsChange }) })

      const apiBtn = screen.getByText('API-ключ').closest('button')!
      await act(async () => { fireEvent.click(apiBtn) })

      expect(onSettingsChange).toHaveBeenCalledWith('aiProvider', 'anthropic-api')
    })

    it('shows settings link', async () => {
      await act(async () => { renderPanel({ aiProvider: undefined }) })
      expect(screen.getByText('Настроить')).toBeInTheDocument()
    })
  })

  // --- Privacy ---

  describe('Privacy', () => {
    it('shows privacy dialog if consent is not given', async () => {
      await act(async () => { renderPanel({ aiPrivacyConsent: false }) })
      expect(screen.getByTestId('ai-privacy-dialog')).toBeInTheDocument()
    })

    it('Accept button calls onSettingsChange', async () => {
      const onSettingsChange = vi.fn()
      await act(async () => { renderPanel({ aiPrivacyConsent: false, onSettingsChange }) })

      const acceptBtn = screen.getByText('Согласен')
      await act(async () => { fireEvent.click(acceptBtn) })

      expect(onSettingsChange).toHaveBeenCalledWith('aiPrivacyConsent', true)
    })

    it('Cancel button calls onClose', async () => {
      const onClose = vi.fn()
      await act(async () => { renderPanel({ aiPrivacyConsent: false, onClose }) })

      const cancelBtn = screen.getByText('Отмена')
      await act(async () => { fireEvent.click(cancelBtn) })

      expect(onClose).toHaveBeenCalled()
    })
  })

  // --- Authorization errors ---

  describe('Authorization errors', () => {
    it('shows error on invalid_key', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'invalid_key' })
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      expect(screen.getByTestId('ai-auth-error')).toBeInTheDocument()
      expect(screen.getByText('Неверный ключ')).toBeInTheDocument()
    })

    it('shows error on no_subscription', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'no_subscription' })
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      expect(screen.getByTestId('ai-auth-error')).toBeInTheDocument()
      expect(screen.getByText('Нет подписки')).toBeInTheDocument()
    })
  })

  // --- Sending messages ---

  describe('Sending messages', () => {
    it('sends via Send button', async () => {
      await act(async () => { renderPanel() })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Hello AI' } }) })

      // Send button should be enabled
      const sendBtn = screen.getByTitle('Отправить')
      await act(async () => { fireEvent.click(sendBtn) })

      expect(mockInvoke).toHaveBeenCalledWith(
        'ai:chat',
        expect.stringContaining('ai-'),
        'Hello AI',
        undefined,
        'test-session-uuid',
        'subscription',
      )
    })

    it('clears input after sending', async () => {
      await act(async () => { renderPanel() })

      const input = screen.getByTestId('ai-input') as HTMLTextAreaElement
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      expect(input.value).toBe('')
    })

    it('does not send empty message', async () => {
      await act(async () => { renderPanel() })

      const sendBtn = screen.getByTitle('Отправить')
      expect(sendBtn).toBeDisabled()
    })

    it('Enter sends when aiSendOnEnter=true', async () => {
      await act(async () => { renderPanel({ aiSendOnEnter: true }) })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })

      expect(mockInvoke).toHaveBeenCalledWith(
        'ai:chat',
        expect.any(String),
        'Test',
        undefined,
        'test-session-uuid',
        'subscription',
      )
    })

    it('Ctrl+Enter sends when aiSendOnEnter=false', async () => {
      await act(async () => { renderPanel({ aiSendOnEnter: false }) })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }) })

      expect(mockInvoke).toHaveBeenCalledWith(
        'ai:chat',
        expect.any(String),
        'Test',
        undefined,
        'test-session-uuid',
        'subscription',
      )
    })

    it('passes context when sending', async () => {
      await act(async () => {
        renderPanel({
          contextType: 'email',
          contextData: { accountId: 1, folder: 'INBOX', uid: 42 },
        })
      })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Summarize' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      expect(mockInvoke).toHaveBeenCalledWith(
        'ai:chat',
        expect.any(String),
        'Summarize',
        { type: 'email', data: { accountId: 1, folder: 'INBOX', uid: 42 } },
        'test-session-uuid',
        'subscription',
      )
    })
  })

  // --- Contextual chips ---

  describe('Contextual chips', () => {
    it('shows chips for email context', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })

      expect(screen.getByTestId('ai-chips')).toBeInTheDocument()
      expect(screen.getByText('Суммируй')).toBeInTheDocument()
      expect(screen.getByText('Ответь')).toBeInTheDocument()
    })

    it('shows chips for thread context', async () => {
      await act(async () => { renderPanel({ contextType: 'thread' }) })

      expect(screen.getByText('Суммируй цепочку')).toBeInTheDocument()
      expect(screen.getByText('Ключевые решения')).toBeInTheDocument()
    })

    it('shows chips for folder context', async () => {
      await act(async () => { renderPanel({ contextType: 'folder' }) })

      expect(screen.getByText('Дайджест')).toBeInTheDocument()
      expect(screen.getByText('Требует ответа')).toBeInTheDocument()
    })

    it('shows global chips (weeklyReview, cleanupAll) when context is absent', async () => {
      await act(async () => { renderPanel({ contextType: null }) })

      const chipsEl = screen.queryByTestId('ai-chips')
      expect(chipsEl).not.toBeNull()
      expect(screen.getByText('ai.chips.weeklyReview')).toBeInTheDocument()
      expect(screen.getByText('ai.chips.cleanupAll')).toBeInTheDocument()
    })

    it('clicking a chip sends a prompt', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })

      await act(async () => { fireEvent.click(screen.getByText('Суммируй')) })

      expect(mockInvoke).toHaveBeenCalledWith(
        'ai:chat',
        expect.any(String),
        'Суммируй это письмо',
        expect.any(Object),
        'test-session-uuid',
        'subscription',
      )
    })

    it('shows scope toggle when email is open', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })
      expect(screen.getByTestId('ai-chip-scope-toggle')).toBeInTheDocument()
    })

    it('hides scope toggle in folder view', async () => {
      await act(async () => { renderPanel({ contextType: 'folder' }) })
      expect(screen.queryByTestId('ai-chip-scope-toggle')).toBeNull()
    })

    it('toggles to folder chips on click', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })
      // Initially email chips
      expect(screen.getByText('Суммируй')).toBeInTheDocument()
      expect(screen.queryByText('GTD-разбор')).toBeNull()

      // Click toggle → folder chips
      await act(async () => { fireEvent.click(screen.getByTestId('ai-chip-scope-toggle')) })
      expect(screen.queryByText('Суммируй')).toBeNull()
      expect(screen.getByText('GTD-разбор')).toBeInTheDocument()
      expect(screen.getByText('Дайджест')).toBeInTheDocument()
    })

    it('toggles back to email chips on second click', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })

      // Toggle to folder
      await act(async () => { fireEvent.click(screen.getByTestId('ai-chip-scope-toggle')) })
      expect(screen.getByText('GTD-разбор')).toBeInTheDocument()

      // Toggle back to email
      await act(async () => { fireEvent.click(screen.getByTestId('ai-chip-scope-toggle')) })
      expect(screen.getByText('Суммируй')).toBeInTheDocument()
      expect(screen.queryByText('GTD-разбор')).toBeNull()
    })

    it('resets scope to email when contextType changes', async () => {
      const { rerender } = await act(async () => renderPanel({ contextType: 'email' }))

      // Toggle to folder
      await act(async () => { fireEvent.click(screen.getByTestId('ai-chip-scope-toggle')) })
      expect(screen.getByText('GTD-разбор')).toBeInTheDocument()

      // Change contextType → scope resets to email
      const threadProps: AiPanelProps = {
        open: true, onClose: vi.fn(), contextType: 'thread', contextData: null,
        aiProvider: 'subscription', aiPrivacyConsent: true, aiSendOnEnter: true,
      }
      await act(async () => { rerender(React.createElement(AiPanel, threadProps)) })
      expect(screen.getByText('Суммируй цепочку')).toBeInTheDocument()
      expect(screen.queryByText('GTD-разбор')).toBeNull()
    })
  })

  // --- Closing and Escape ---

  describe('Closing', () => {
    it('close button calls onClose', async () => {
      const onClose = vi.fn()
      await act(async () => { renderPanel({ onClose }) })

      const closeBtn = screen.getByTitle('Закрыть')
      await act(async () => { fireEvent.click(closeBtn) })

      expect(onClose).toHaveBeenCalled()
    })

    it('Escape in input calls onClose when not streaming', async () => {
      const onClose = vi.fn()
      await act(async () => { renderPanel({ onClose }) })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }) })

      expect(onClose).toHaveBeenCalled()
    })
  })

  // --- New chat ---

  describe('New chat', () => {
    it('new chat button calls ai:newSession', async () => {
      await act(async () => { renderPanel() })

      const newChatBtn = screen.getByTitle('Новый чат')
      await act(async () => { fireEvent.click(newChatBtn) })

      expect(mockInvoke).toHaveBeenCalledWith('ai:newSession')
    })

    // Regression: cross-session preview-registry leak via History panel.
    // loadSession crosses a session boundary, so it must also clear the main-side
    // pending preview registry — otherwise a previewId/confirmation_token from the
    // previously-active session leaks into the freshly-loaded session and the AI
    // sees stale "USER CONFIRMED" hints. The wave-3 fix only covered the explicit
    // "new chat" button; this is the same class of bug via a different UI entry.
    it('loadSession invokes ai:newSession to clear preview registry', async () => {
      const otherSessions = [
        { id: 'session-other', title: 'Other', updatedAt: Date.now(), provider: 'subscription' },
      ]
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve(otherSessions)
        if (channel === 'aiSession:messages') return Promise.resolve([])
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })

      // Open History panel and click the other session.
      const historyBtn = screen.getByTitle('История')
      await act(async () => { fireEvent.click(historyBtn) })
      const sessionItem = screen.getByText('Other')
      await act(async () => { fireEvent.click(sessionItem) })

      expect(mockInvoke).toHaveBeenCalledWith('ai:newSession')
    })

    // Regression: deleting the currently-active session also crosses a session
    // boundary (local state resets to "no active session"), so the registry must
    // be cleared too. Without this, the next session the user opens inherits a
    // pending preview from the deleted one.
    it('deleteSession of active session invokes ai:newSession', async () => {
      const sessions = [
        { id: 'session-active', title: 'Active', updatedAt: Date.now(), provider: 'subscription' },
      ]
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve(sessions)
        if (channel === 'aiSession:messages') return Promise.resolve([])
        if (channel === 'aiSession:delete') return Promise.resolve()
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })

      // Open History, load the session so it becomes activeSessionId.
      await act(async () => { fireEvent.click(screen.getByTitle('История')) })
      await act(async () => { fireEvent.click(screen.getByText('Active')) })

      // Re-open History (loadSession closes it) and delete the active session.
      await act(async () => { fireEvent.click(screen.getByTitle('История')) })
      const deleteBtn = screen.getByTitle('Удалить беседу')
      mockInvoke.mockClear()
      await act(async () => { fireEvent.click(deleteBtn) })

      // After clear, the only ai:newSession call we care about is the one
      // triggered by deleteSession itself.
      expect(mockInvoke).toHaveBeenCalledWith('ai:newSession')
    })

    // Regression (codex wave 5): "Clear all" sessions also crosses the session
    // boundary — local activeSessionId resets to null and `messages` clears,
    // abandoning whatever preview state belonged to the formerly-active
    // session. Without `ai:newSession`, the next session the user starts
    // would inherit those stale previews. Same class of leak as
    // loadSession (wave 3) and deleteSession of active (wave 4); this is
    // the 4th and final session boundary.
    it('deleteAllSessions invokes ai:newSession to clear preview registry', async () => {
      const sessions = [
        { id: 'session-active', title: 'Active', updatedAt: Date.now(), provider: 'subscription' },
      ]
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve(sessions)
        if (channel === 'aiSession:messages') return Promise.resolve([])
        if (channel === 'aiSession:deleteAll') return Promise.resolve()
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })

      // Open History → "Clear all" button is rendered when sessionList is non-empty.
      await act(async () => { fireEvent.click(screen.getByTitle('История')) })
      const clearAllBtn = screen.getByTitle('Очистить всё')
      mockInvoke.mockClear()
      await act(async () => { fireEvent.click(clearAllBtn) })

      expect(mockInvoke).toHaveBeenCalledWith('ai:newSession')
      expect(mockInvoke).toHaveBeenCalledWith('aiSession:deleteAll')
    })

    // Negative: deleting a non-active session must NOT clear the registry —
    // local state didn't change, so previews owned by the still-active session
    // are still valid and should not be wiped.
    it('deleteSession of non-active session does NOT invoke ai:newSession', async () => {
      const sessions = [
        { id: 'session-active', title: 'Active', updatedAt: Date.now(), provider: 'subscription' },
        { id: 'session-other', title: 'Other', updatedAt: Date.now() - 1000, provider: 'subscription' },
      ]
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve(sessions)
        if (channel === 'aiSession:messages') return Promise.resolve([])
        if (channel === 'aiSession:delete') return Promise.resolve()
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })

      // Activate the first session.
      await act(async () => { fireEvent.click(screen.getByTitle('История')) })
      await act(async () => { fireEvent.click(screen.getByText('Active')) })

      // Re-open History, delete the OTHER (non-active) session.
      await act(async () => { fireEvent.click(screen.getByTitle('История')) })
      // Find the delete button next to "Other".
      const otherRow = screen.getByText('Other').closest('.ai-session-item') as HTMLElement
      const deleteBtn = otherRow.querySelector('.ai-session-delete') as HTMLElement
      mockInvoke.mockClear()
      await act(async () => { fireEvent.click(deleteBtn) })

      const newSessionCalls = mockInvoke.mock.calls.filter(c => c[0] === 'ai:newSession')
      expect(newSessionCalls).toHaveLength(0)
    })
  })

  // --- IPC subscriptions ---

  describe('IPC', () => {
    it('calls removeAll before subscribing to ai:stream', async () => {
      await act(async () => { renderPanel() })

      expect(mockRemoveAll).toHaveBeenCalledWith('ai:stream')
      // removeAll is called BEFORE on
      const removeAllOrder = mockRemoveAll.mock.invocationCallOrder[0]
      const onOrder = mockOn.mock.invocationCallOrder[0]
      expect(removeAllOrder).toBeLessThan(onOrder)
    })

    it('subscribes to ai:stream when open=true', async () => {
      await act(async () => { renderPanel() })

      expect(mockOn).toHaveBeenCalledWith('ai:stream', expect.any(Function))
    })

    it('unsubscribes from ai:stream on unmount', async () => {
      const { unmount } = render(React.createElement(AiPanel, {
        open: true,
        onClose: vi.fn(),
        contextType: null,
        contextData: null,
        aiProvider: 'subscription',
        aiPrivacyConsent: true,
      }))

      // Wait for async effects
      await act(async () => {})

      unmount()

      expect(mockOff).toHaveBeenCalledWith('ai:stream', expect.any(Function))
    })

    it('checks authorization on open', async () => {
      await act(async () => { renderPanel() })

      expect(mockInvoke).toHaveBeenCalledWith('ai:checkAuth', 'subscription')
    })

    // §1.4 renderer IPC stampede fix: two mounts of AiPanel (e.g. the
    // open-effect firing plus the aiProvider-settle effect firing) must
    // coalesce into a single `ai:checkAuth` IPC. Without singleFlightInvoke
    // this would be 2 fires in ~tens of ms (observed 2026-04-23).
    it('deduplicates rapid duplicate ai:checkAuth fires via singleFlightInvoke', async () => {
      let pendingResolve: (value: unknown) => void = () => {}
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') {
          return new Promise((resolve) => { pendingResolve = resolve })
        }
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      await act(async () => { renderPanel({ aiProvider: 'subscription' }) })

      const checkAuthCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'ai:checkAuth')
      expect(checkAuthCalls.length).toBe(1)

      // Resolve so the promise chain settles.
      await act(async () => {
        pendingResolve({ status: 'authenticated' })
      })
    })

    it('sends context via ai:setContext', async () => {
      vi.useFakeTimers()

      await act(async () => {
        renderPanel({
          contextType: 'folder',
          contextData: { folder: 'INBOX' },
        })
      })

      await act(async () => { vi.advanceTimersByTime(400) })

      expect(mockInvoke).toHaveBeenCalledWith('ai:setContext', {
        type: 'folder',
        data: { folder: 'INBOX' },
      })

      vi.useRealTimers()
    })
  })

  // --- Stream events ---

  describe('Stream events', () => {
    function getStreamHandler(): (event: Record<string, unknown>) => void {
      const call = mockOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'ai:stream',
      )
      if (!call) throw new Error('ai:stream handler not found')
      return call[1] as (event: Record<string, unknown>) => void
    }

    it('text_delta appends text to assistant message', async () => {
      await act(async () => { renderPanel() })

      // First send a message to create user+assistant entries
      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      // Simulate a stream event
      const handler = getStreamHandler()
      await act(async () => {
        handler({ type: 'text_delta', requestId: 'test', text: 'Hello' })
      })

      // Verify user message is displayed
      const userMessages = screen.getAllByTestId('ai-message-user')
      expect(userMessages).toHaveLength(1)
      expect(userMessages[0].textContent).toContain('Test')
    })

    it('status:done stops streaming', async () => {
      await act(async () => { renderPanel() })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      const handler = getStreamHandler()
      await act(async () => {
        handler({ type: 'status', requestId: 'test', status: 'done' })
      })

      // After done, input should not be disabled
      const inputAfter = screen.getByTestId('ai-input') as HTMLTextAreaElement
      expect(inputAfter.disabled).toBe(false)
    })

    it('error adds an error message', async () => {
      await act(async () => { renderPanel() })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      const handler = getStreamHandler()
      await act(async () => {
        handler({ type: 'error', requestId: 'test', message: 'Something failed' })
      })

      const assistantMsgs = screen.getAllByTestId('ai-message-assistant')
      const lastMsg = assistantMsgs[assistantMsgs.length - 1]
      expect(lastMsg.textContent).toContain('Something failed')
    })

    // §2.51.f2 — a `notice` is NOT an error: main sends a machine-readable code
    // (it has no i18next instance) and the renderer localizes it.
    it('notice with a known code renders the localized text, not the raw English fallback', async () => {
      await act(async () => { renderPanel() })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'notice',
          requestId: 'test',
          code: 'request_budget_exceeded',
          message: 'Request stopped: the per-request cost limit of $2.00 was reached.',
        })
      })

      const assistantMsgs = screen.getAllByTestId('ai-message-assistant')
      const lastMsg = assistantMsgs[assistantMsgs.length - 1]
      expect(lastMsg.textContent).toContain('Запрос остановлен')
      // The English fallback from main must not leak into the UI for known codes.
      expect(lastMsg.textContent).not.toContain('Request stopped')
    })

    // A future main-process code the renderer does not recognize yet (version
    // skew between main and renderer bundles, e.g. mid-rollout) must not crash
    // the panel or render nothing — it falls back to the English `message` main
    // already sent, same as the fallback branch in AiPanel.tsx.
    it('notice with an unrecognized code falls back to the raw message instead of throwing or rendering nothing', async () => {
      await act(async () => { renderPanel() })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'notice',
          requestId: 'test',
          code: 'some_future_notice_code',
          message: 'A future notice the renderer does not know yet.',
        })
      })

      const assistantMsgs = screen.getAllByTestId('ai-message-assistant')
      const lastMsg = assistantMsgs[assistantMsgs.length - 1]
      expect(lastMsg.textContent).toContain('A future notice the renderer does not know yet.')
    })

    it('shows sources from result when aiShowSources=true', async () => {
      await act(async () => { renderPanel({ aiShowSources: true }) })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'result',
          requestId: 'test',
          text: 'done',
          sessionId: 'sid',
          sources: [{ ref: { accountId: 1, folder: 'INBOX', uid: 101 }, reason: 'mock' }],
        })
      })

      // Enriched source: shows #N and fallback folder/uid when no subject
      expect(screen.getByText('#1')).toBeInTheDocument()
      expect(screen.getByText('INBOX/101')).toBeInTheDocument()
    })

    it('hides sources when aiShowSources=false', async () => {
      await act(async () => { renderPanel({ aiShowSources: false }) })

      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: 'Test' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })

      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'result',
          requestId: 'test',
          text: 'done',
          sessionId: 'sid',
          sources: [{ ref: { accountId: 1, folder: 'INBOX', uid: 101 }, reason: 'mock' }],
        })
      })

      // Sources should be hidden — neither the number nor the fallback should appear
      expect(screen.queryByText('INBOX/101')).toBeNull()
    })
  })

  // --- Prompt history ---

  describe('Prompt history (ArrowUp/ArrowDown)', () => {
    /** Gets the stream events handler */
    function getStreamHandler(): (event: Record<string, unknown>) => void {
      const call = mockOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'ai:stream',
      )
      if (!call) throw new Error('ai:stream handler not found')
      return call[1] as (event: Record<string, unknown>) => void
    }

    /** Sends a prompt via UI and finishes the stream */
    async function sendPrompt(text: string) {
      const input = screen.getByTestId('ai-input')
      await act(async () => { fireEvent.change(input, { target: { value: text } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Отправить')) })
      // Finish stream so isStreaming=false for next send
      const handler = getStreamHandler()
      await act(async () => {
        handler({ type: 'status', requestId: 'test', status: 'done' })
      })
    }

    it('ArrowUp inserts previous prompt', async () => {
      await act(async () => { renderPanel() })

      await sendPrompt('первый')
      await sendPrompt('второй')

      const input = screen.getByTestId('ai-input') as HTMLTextAreaElement

      // ArrowUp → last prompt
      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowUp' })
      })
      expect(input.value).toBe('второй')

      // ArrowUp → first prompt
      await act(async () => {
        fireEvent.keyDown(input, { key: 'ArrowUp' })
      })
      expect(input.value).toBe('первый')
    })

    it('ArrowDown returns to newer prompt and draft', async () => {
      await act(async () => { renderPanel() })

      await sendPrompt('aaa')
      await sendPrompt('bbb')

      const input = screen.getByTestId('ai-input') as HTMLTextAreaElement

      // Type a draft
      await act(async () => { fireEvent.change(input, { target: { value: 'draft' } }) })

      // Simulate cursor at start (Home), then ArrowUp → bbb
      input.selectionStart = 0
      input.selectionEnd = 0
      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowUp' }) })
      expect(input.value).toBe('bbb')

      // ArrowUp → aaa
      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowUp' }) })
      expect(input.value).toBe('aaa')

      // ArrowDown → bbb
      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowDown' }) })
      expect(input.value).toBe('bbb')

      // ArrowDown → return to draft
      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowDown' }) })
      expect(input.value).toBe('draft')
    })

    it('ArrowUp does not duplicate consecutive identical prompts', async () => {
      await act(async () => { renderPanel() })

      await sendPrompt('same')
      await sendPrompt('same')

      const input = screen.getByTestId('ai-input') as HTMLTextAreaElement

      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowUp' }) })
      expect(input.value).toBe('same')

      // ArrowUp again — doesn't go further, only one element
      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowUp' }) })
      expect(input.value).toBe('same')
    })

    it('ArrowUp does not react with empty history', async () => {
      await act(async () => { renderPanel() })

      const input = screen.getByTestId('ai-input') as HTMLTextAreaElement
      await act(async () => { fireEvent.change(input, { target: { value: 'current' } }) })

      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowUp' }) })
      // Value unchanged
      expect(input.value).toBe('current')
    })

    it('ArrowDown does not react when not in history navigation mode', async () => {
      await act(async () => { renderPanel() })

      await sendPrompt('test')

      const input = screen.getByTestId('ai-input') as HTMLTextAreaElement
      await act(async () => { fireEvent.change(input, { target: { value: 'current' } }) })

      await act(async () => { fireEvent.keyDown(input, { key: 'ArrowDown' }) })
      expect(input.value).toBe('current')
    })
  })

  // --- §3.10 P0: AI mutating action confirmation barrier ---
  //
  // The wiring under test: when the AI calls a `*_preview` MCP tool, the panel
  // refreshes its pending-actions list from main, renders an
  // AiActionConfirmation block in the chat flow, and routes Apply/Cancel
  // clicks back to `ai:action:apply` / `ai:action:cancel` IPC. After Apply
  // the panel nudges the AI with a synthetic user turn that carries the
  // confirmation token.

  describe('Pending mutating actions (§3.10 P0)', () => {
    function getStreamHandler(): (event: Record<string, unknown>) => void {
      const call = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'ai:stream')
      if (!call) throw new Error('ai:stream handler not found')
      return call[1] as (event: Record<string, unknown>) => void
    }

    /** Build a `PendingActionSummary`-shaped row mirroring `ai:action:list`. */
    function summary(overrides: Record<string, unknown> = {}) {
      return {
        previewId: 'preview-uuid-1',
        kind: 'snooze_email',
        i18nKey: 'ai.confirmation.kinds.snooze_email',
        description: 'Snooze 2 emails',
        accountId: 1,
        emailCount: 2,
        folder: 'INBOX',
        createdAt: Date.now(),
        confirmed: false,
        ...overrides,
      }
    }

    it('refreshes pending actions on panel open (mounting effect)', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve([])
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })

      expect(mockInvoke).toHaveBeenCalledWith('ai:action:list')
    })

    it('renders confirmation block after a preview tool ends', async () => {
      let listResponse: unknown[] = []
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve(listResponse)
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()

      // After a preview_* tool ends, main now has a pending action; flip the
      // mocked list and dispatch tool_use_end.
      listResponse = [summary()]
      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__preview_snooze_email',
          result: '{"previewId":"preview-uuid-1"}',
        })
      })

      // Block renders inside the chat flow with the localized verb.
      expect(screen.getByTestId('ai-pending-actions')).toBeInTheDocument()
      expect(screen.getByTestId('ai-action-confirmation')).toBeInTheDocument()
      expect(screen.getByText('Отложить письма')).toBeInTheDocument()
    })

    it('does NOT refresh pending actions for non-preview/non-apply tools', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve([])
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()
      // After mount the open-effect already fired one ai:action:list. Reset.
      const listCallsBefore = mockInvoke.mock.calls.filter(c => c[0] === 'ai:action:list').length

      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__list_emails',
          result: '[]',
        })
      })

      const listCallsAfter = mockInvoke.mock.calls.filter(c => c[0] === 'ai:action:list').length
      expect(listCallsAfter).toBe(listCallsBefore)
    })

    it('clicking Apply invokes ai:action:apply, marks block confirmed, nudges AI with token', async () => {
      let listResponse: unknown[] = [summary()]
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve(listResponse)
        if (channel === 'aiSession:create') return Promise.resolve({ id: 'test-session-uuid' })
        if (channel === 'aiSession:addMessage') return Promise.resolve({ id: 1 })
        if (channel === 'ai:action:apply') return Promise.resolve({
          ok: true,
          confirmationToken: 'tok-xyz',
          summary: summary({ confirmed: true }),
        })
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()

      // Trigger a preview tool to render the confirmation block.
      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__preview_snooze_email',
          result: '{"previewId":"preview-uuid-1"}',
        })
      })
      expect(screen.getByTestId('ai-action-confirmation')).toBeInTheDocument()

      // Server-side state changes after Apply — main now reports confirmed=true.
      listResponse = [summary({ confirmed: true })]

      // Click Apply.
      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-action-apply'))
      })

      // IPC fired with the previewId.
      expect(mockInvoke).toHaveBeenCalledWith('ai:action:apply', 'preview-uuid-1')

      // The AI was nudged: a user message containing the token was sent
      // through ai:chat in the next turn.
      const chatCalls = mockInvoke.mock.calls.filter(c => c[0] === 'ai:chat')
      expect(chatCalls.length).toBeGreaterThan(0)
      const lastChat = chatCalls[chatCalls.length - 1]
      // arg index 2 is the user-prompt string passed to ai:chat.
      expect(String(lastChat[2])).toContain('tok-xyz')

      // Optimistic confirmed flag flipped → Apply button is now disabled
      // ("Применено" replacing "Применить").
      expect(screen.getByText('Применено')).toBeInTheDocument()
    })

    it('Apply with preview_not_found surfaces an error and removes the block', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve([summary()])
        if (channel === 'ai:action:apply') return Promise.resolve({
          ok: false,
          reason: 'preview_not_found_or_already_consumed',
        })
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__preview_snooze_email',
          result: '{}',
        })
      })

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-action-apply'))
      })

      // Block is removed.
      expect(screen.queryByTestId('ai-action-confirmation')).toBeNull()
      // Error message rendered in the chat.
      const assistantMsgs = screen.getAllByTestId('ai-message-assistant')
      const last = assistantMsgs[assistantMsgs.length - 1]
      expect(last.textContent).toContain('Действие истекло')
    })

    it('clicking Cancel invokes ai:action:cancel and removes the block', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve([summary()])
        if (channel === 'ai:action:cancel') return Promise.resolve({ ok: true })
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__preview_snooze_email',
          result: '{}',
        })
      })
      expect(screen.getByTestId('ai-action-confirmation')).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-action-cancel'))
      })

      expect(mockInvoke).toHaveBeenCalledWith('ai:action:cancel', 'preview-uuid-1')
      expect(screen.queryByTestId('ai-action-confirmation')).toBeNull()
    })

    it('refreshes pending list after apply_* tools end (post-mutation cleanup)', async () => {
      let listResponse: unknown[] = [summary()]
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve(listResponse)
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__preview_snooze_email',
          result: '{}',
        })
      })
      expect(screen.getByTestId('ai-action-confirmation')).toBeInTheDocument()

      // Simulate apply_* completing main-side: registry drops the entry.
      listResponse = []
      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__apply_snooze_email',
          result: '{"ok":true}',
        })
      })

      expect(screen.queryByTestId('ai-action-confirmation')).toBeNull()
    })

    // §3.10 P0 HIGH#3 fix — Apply must be blocked while a turn is
    // streaming. `sendMessage` returns early during streaming, so without
    // this gate clicking Apply would consume the token main-side but never
    // nudge the AI with the proceedPrompt — the AI's next turn would
    // never see the token and the model would re-ask.
    it('blocks Apply during streaming (pending-actions wrapper has aria-disabled + pointer-events: none)', async () => {
      let listResponse: unknown[] = [summary()]
      const applySpy = vi.fn().mockResolvedValue({
        ok: true, confirmationToken: 'tok-streaming', summary: summary({ confirmed: true }),
      })
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve(listResponse)
        if (channel === 'ai:action:apply') return applySpy()
        if (channel === 'aiSession:create') return Promise.resolve({ id: 'test-session-uuid' })
        if (channel === 'aiSession:addMessage') return Promise.resolve({ id: 1 })
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()

      // Render the confirmation block, then immediately put the panel
      // into the streaming state — exactly the race the fix targets:
      // tool_use_end fires (preview registered), assistant text is
      // still streaming, user clicks Apply.
      listResponse = [summary()]
      await act(async () => {
        handler({ type: 'tool_use_end', requestId: 'r1', toolName: 'mcp__mailcopilot__preview_snooze_email', result: '{}' })
      })
      expect(screen.getByTestId('ai-action-confirmation')).toBeInTheDocument()

      // Drive the panel into streaming via send.
      const input = screen.getByTestId('ai-input') as HTMLTextAreaElement
      await act(async () => { fireEvent.change(input, { target: { value: 'snooze it' } }) })
      await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })

      // The container is now visually blocked.
      const wrapper = screen.getByTestId('ai-pending-actions')
      expect(wrapper.getAttribute('aria-disabled')).toBe('true')
      expect(wrapper.getAttribute('data-streaming-blocked')).toBe('true')
      expect((wrapper as HTMLElement).style.pointerEvents).toBe('none')

      // Even if a click slips through (e.g. via keyboard automation that
      // bypasses pointer-events), the handler short-circuits because
      // isStreaming === true. So no apply IPC is sent and no token is
      // burned main-side.
      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-action-apply'))
      })
      expect(applySpy).not.toHaveBeenCalled()
    })

    it('newChat clears local pending actions visually', async () => {
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([])
        if (channel === 'ai:action:list') return Promise.resolve([summary()])
        return Promise.resolve()
      })

      await act(async () => { renderPanel() })
      const handler = getStreamHandler()
      await act(async () => {
        handler({
          type: 'tool_use_end',
          requestId: 'r1',
          toolName: 'mcp__mailcopilot__preview_snooze_email',
          result: '{}',
        })
      })
      expect(screen.getByTestId('ai-action-confirmation')).toBeInTheDocument()

      // After newChat the renderer mirror is cleared; the next list refresh
      // returns empty so the block stays gone.
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ai:action:list') return Promise.resolve([])
        return Promise.resolve()
      })
      await act(async () => { fireEvent.click(screen.getByTitle('Новый чат')) })
      expect(screen.queryByTestId('ai-action-confirmation')).toBeNull()
    })
  })

  // §3.10 P2: inline confirm modal for internet-tool egress consent.
  // When main sends `ai:internet-tool-pending`, AiPanel shows a modal
  // with Allow / Deny buttons. Allow invokes ai:internet-tool-approve;
  // Deny invokes ai:internet-tool-deny. Modal hides after either action.
  // Shield icon visible in header when policy !== 'allow'.
  describe('Egress confirm modal (§3.10 P2)', () => {
    // Helper: get the registered `ai:internet-tool-pending` handler
    // installed by AiPanel via window.api.on(...)
    function getPendingHandler(): (payload: unknown) => void {
      const call = mockOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'ai:internet-tool-pending',
      )
      if (!call) throw new Error('ai:internet-tool-pending handler not found')
      return call[1] as (payload: unknown) => void
    }

    it('confirm modal hidden by default (no pending event)', async () => {
      await act(async () => { renderPanel() })
      expect(screen.queryByTestId('ai-egress-confirm')).toBeNull()
    })

    it('confirm modal appears when ai:internet-tool-pending fires', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-1', toolName: 'web_search', query: 'latest news' })
      })
      expect(screen.getByTestId('ai-egress-confirm')).toBeInTheDocument()
      expect(screen.getByText('AI хочет обратиться в интернет')).toBeInTheDocument()
    })

    it('shows web search action label and escaped query', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-1', toolName: 'web_search', query: 'test <query>' })
      })
      expect(screen.getByText('Веб-поиск:')).toBeInTheDocument()
      // Query is rendered as a React text node (no dangerouslySetInnerHTML).
      // React auto-escapes text nodes — the raw string appears as-is in the DOM.
      expect(screen.getByText('test <query>')).toBeInTheDocument()
    })

    it('shows web fetch action label and url', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-2', toolName: 'WebFetch', url: 'https://example.com' })
      })
      expect(screen.getByText('Загрузка URL:')).toBeInTheDocument()
      expect(screen.getByText('https://example.com')).toBeInTheDocument()
    })

    it('shows external tool label for unknown tool name', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-3', toolName: 'some_unknown_mcp_tool' })
      })
      expect(screen.getByText('Вызов внешнего инструмента')).toBeInTheDocument()
    })

    it('Allow button invokes ai:internet-tool-approve with requestId', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-approve', toolName: 'web_search', query: 'foo' })
      })
      const allowBtn = screen.getByTestId('ai-egress-confirm-allow')
      await act(async () => { fireEvent.click(allowBtn) })

      expect(mockInvoke).toHaveBeenCalledWith(
        'ai:internet-tool-approve',
        'req-approve',
      )
    })

    it('modal hides after Allow click', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-hide-allow', toolName: 'web_search' })
      })
      expect(screen.getByTestId('ai-egress-confirm')).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-egress-confirm-allow'))
      })
      expect(screen.queryByTestId('ai-egress-confirm')).toBeNull()
    })

    it('Deny button invokes ai:internet-tool-deny with requestId', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-deny', toolName: 'WebFetch', url: 'https://bad.com' })
      })
      const denyBtn = screen.getByTestId('ai-egress-confirm-deny')
      await act(async () => { fireEvent.click(denyBtn) })

      expect(mockInvoke).toHaveBeenCalledWith(
        'ai:internet-tool-deny',
        'req-deny',
      )
    })

    it('modal hides after Deny click', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-hide-deny', toolName: 'web_search' })
      })
      expect(screen.getByTestId('ai-egress-confirm')).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(screen.getByTestId('ai-egress-confirm-deny'))
      })
      expect(screen.queryByTestId('ai-egress-confirm')).toBeNull()
    })

    it('modal replaces itself when a second pending event fires (new requestId)', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-first', toolName: 'web_search', query: 'first' })
      })
      expect(screen.getByText('first')).toBeInTheDocument()

      await act(async () => {
        handler({ requestId: 'req-second', toolName: 'WebFetch', url: 'https://second.com' })
      })
      expect(screen.queryByText('first')).toBeNull()
      expect(screen.getByText('https://second.com')).toBeInTheDocument()
    })

    it('Shield icon visible in header when policy is not allow', async () => {
      await act(async () => { renderPanel({ aiEgressPolicy: 'default-deny' }) })
      expect(screen.getByTestId('ai-egress-shield')).toBeInTheDocument()
    })

    it('Shield icon not visible when policy is allow', async () => {
      await act(async () => { renderPanel({ aiEgressPolicy: 'allow' }) })
      expect(screen.queryByTestId('ai-egress-shield')).toBeNull()
    })

    it('Shield icon tooltip contains shield text', async () => {
      await act(async () => { renderPanel({ aiEgressPolicy: 'default-deny' }) })
      const shield = screen.getByTestId('ai-egress-shield')
      expect(shield).toHaveAttribute('title', 'Доступ AI к интернету перехватывается')
    })

    it('ignores payload without requestId — modal does not appear', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        // No requestId field — should be silently ignored.
        handler({ toolName: 'web_search', query: 'foo' })
      })
      expect(screen.queryByTestId('ai-egress-confirm')).toBeNull()
    })

    it('ignores null payload — modal does not appear', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => { handler(null) })
      expect(screen.queryByTestId('ai-egress-confirm')).toBeNull()
    })

    // XSS safety: React renders text nodes via the virtual DOM, which means
    // special HTML characters (<, >, &, etc.) are never interpreted as markup.
    // getByText finds the visible text content — React auto-escapes on render,
    // so we assert the raw string value, not an HTML-entity-escaped string.
    it('URL with HTML characters renders as raw text (no XSS) in DOM', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({
          requestId: 'req-url-escape',
          toolName: 'WebFetch',
          url: 'https://evil.com?x=<script>alert(1)</script>',
        })
      })
      // React text node renders raw string — angle brackets appear literally, not as tags.
      expect(screen.getByText(
        'https://evil.com?x=<script>alert(1)</script>',
      )).toBeInTheDocument()
    })

    it('query with ampersand and quotes renders as raw text in DOM', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({
          requestId: 'req-amp-escape',
          toolName: 'WebSearch',
          // Include &, ", ' — React text node renders these as-is (no dangerouslySetInnerHTML).
          query: 'tom & "jerry" it\'s',
        })
      })
      expect(screen.getByText('tom & "jerry" it\'s')).toBeInTheDocument()
    })

    it('confirm modal does not appear when panel is closed (open=false) and event fires', async () => {
      // Render with open=false — the useEffect that registers the handler has the
      // `open` dependency; when open=false the handler is NOT registered, so firing
      // the event should have no effect.
      await act(async () => { renderPanel({ open: false }) })

      // The component renders nothing when closed so there is no handler to call.
      // Verify mockOn was NOT called for ai:internet-tool-pending.
      const call = mockOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'ai:internet-tool-pending',
      )
      expect(call).toBeUndefined()
      expect(screen.queryByTestId('ai-egress-confirm')).toBeNull()
    })

    it('WebSearch variant of toolName also shows web search label', async () => {
      // The component checks for both 'web_search' and 'WebSearch' — verify both.
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-websearch-variant', toolName: 'WebSearch', query: 'cats' })
      })
      expect(screen.getByText('Веб-поиск:')).toBeInTheDocument()
    })

    it('web_fetch variant of toolName shows web fetch label', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-webfetch-variant', toolName: 'web_fetch', url: 'https://fetch.example' })
      })
      expect(screen.getByText('Загрузка URL:')).toBeInTheDocument()
    })
  })

  // --- Chips layout ---

  describe('Chips layout', () => {
    it('chips have title and aria-label attributes', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })

      const chipsEl = screen.getByTestId('ai-chips')
      const chipButtons = Array.from(chipsEl.querySelectorAll('button.ai-chip:not(.ai-chip-scope)'))
      expect(chipButtons.length).toBeGreaterThan(0)
      for (const btn of chipButtons) {
        expect(btn.getAttribute('aria-label')).not.toBeNull()
        expect(btn.getAttribute('title')).not.toBeNull()
      }
    })

    it('scope toggle has aria-label', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })

      const scopeToggle = screen.getByTestId('ai-chip-scope-toggle')
      expect(scopeToggle.getAttribute('aria-label')).toBe('Действия с папкой')
    })
  })

  // --- uiaudit.7: input always visible (layout structure test) ---
  //
  // jsdom does not implement CSS layout so getBoundingClientRect always returns
  // zeroes. We verify the structural invariant instead: .ai-input-area must be
  // a direct child of .ai-panel (not nested inside .ai-body), so that the
  // flex-column panel keeps input pinned to the bottom regardless of how much
  // scrollable content is in .ai-body above it.

  describe('Input row layout structure (uiaudit.7)', () => {
    it('ai-input-area is a direct child of ai-panel, not inside ai-body', async () => {
      await act(async () => { renderPanel() })

      const panel = screen.getByTestId('ai-panel')
      const inputArea = screen.getByTestId('ai-input')
        .closest('.ai-input-area') as HTMLElement | null
      expect(inputArea).not.toBeNull()

      // .ai-input-area must be a direct child of .ai-panel
      expect(inputArea!.parentElement).toBe(panel)
    })

    it('ai-body is a direct child of ai-panel and contains messages', async () => {
      await act(async () => { renderPanel() })

      const panel = screen.getByTestId('ai-panel')
      const body = screen.getByTestId('ai-body')

      // .ai-body must be a direct child of .ai-panel
      expect(body.parentElement).toBe(panel)

      // .ai-messages must be inside .ai-body (not a sibling of it)
      const messages = screen.getByTestId('ai-messages')
      expect(body.contains(messages)).toBe(true)
    })

    it('ai-input-area is NOT inside ai-body', async () => {
      await act(async () => { renderPanel() })

      const body = screen.getByTestId('ai-body')
      const inputArea = screen.getByTestId('ai-input')
        .closest('.ai-input-area') as HTMLElement | null
      expect(inputArea).not.toBeNull()

      // input row must NOT be a descendant of .ai-body
      expect(body.contains(inputArea)).toBe(false)
    })

    it('chips rendered as a sibling of ai-body, not a descendant (always visible above input)', async () => {
      await act(async () => { renderPanel({ contextType: 'email' }) })

      const body = screen.getByTestId('ai-body')
      const chips = screen.getByTestId('ai-chips')

      // chips must NOT scroll with messages — they stay pinned above the input
      // along with .ai-status / .ai-egress-confirm / .ai-input-area.
      expect(body.contains(chips)).toBe(false)
    })
  })

  // --- Egress consent placement ---
  //
  // pendingEgress now renders as a sibling of .ai-body (above the input,
  // below .ai-chips), so it is always visible regardless of message scroll
  // position. No scroll-into-view is needed.
  describe('Egress consent placement', () => {
    function getPendingHandler(): (payload: unknown) => void {
      const call = mockOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'ai:internet-tool-pending',
      )
      if (!call) throw new Error('ai:internet-tool-pending handler not found')
      return call[1] as (payload: unknown) => void
    }

    it('egress confirm block is rendered outside ai-body (always visible above input)', async () => {
      await act(async () => { renderPanel() })
      const handler = getPendingHandler()
      await act(async () => {
        handler({ requestId: 'req-position', toolName: 'web_search', query: 'pos' })
      })

      const body = screen.getByTestId('ai-body')
      const confirmBlock = screen.getByTestId('ai-egress-confirm')

      // The confirm block must NOT be inside .ai-body — it sits between
      // .ai-body and .ai-input-area as a sibling, so it is always visible.
      expect(body.contains(confirmBlock)).toBe(false)
    })
  })
})
