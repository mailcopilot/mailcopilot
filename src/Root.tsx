import { useState, useEffect } from 'react'
import i18n, { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type Language } from './i18n'
import { SentryErrorBoundary, sendFeedback, isSentryActive } from './sentry'
import App from './App'
import Settings from './windows/Settings'
import Account from './windows/Account'
import Compose from './windows/Compose'
import MailWindow from './windows/MailWindow'

/** Inline feedback form for ErrorBoundary fallback.
 * Does not use i18n provider (React tree has crashed), strings are determined by lang. */
function FallbackFeedbackForm({ eventId, labels }: {
  eventId?: string
  labels: { feedbackTitle: string; feedbackPlaceholder: string; feedbackSend: string; feedbackThanks: string }
}) {
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)

  if (!isSentryActive()) return null

  if (sent) {
    return <p style={{ color: '#22c55e', fontSize: 14 }}>{labels.feedbackThanks}</p>
  }

  return (
    <div style={{ width: '100%', maxWidth: 400 }}>
      <p style={{ margin: '0 0 8px', fontSize: 13 }}>{labels.feedbackTitle}</p>
      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        placeholder={labels.feedbackPlaceholder}
        style={{
          width: '100%', minHeight: 60, padding: 8, borderRadius: 6,
          border: '1px solid #d1d5db', fontFamily: 'inherit', fontSize: 13,
          resize: 'vertical', boxSizing: 'border-box',
        }}
        maxLength={2000}
      />
      <button
        onClick={() => {
          if (!message.trim()) return
          sendFeedback({ message: message.trim(), associatedEventId: eventId })
          setSent(true)
        }}
        disabled={!message.trim()}
        style={{
          marginTop: 8, padding: '6px 16px', border: 'none',
          borderRadius: 6, background: '#3b82f6', color: '#fff',
          cursor: message.trim() ? 'pointer' : 'not-allowed', fontSize: 13,
          opacity: message.trim() ? 1 : 0.5,
        }}
      >
        {labels.feedbackSend}
      </button>
    </div>
  )
}

/** Fallback screen for critical React tree errors. Does not use hooks/i18n — must always work. */
function FallbackUI({ eventId }: { eventId?: string }) {
  const labels = {
    title: 'Something went wrong',
    description: 'An error occurred. The error report has been sent to the developers. Please try restarting the application.',
    reload: 'Reload',
    feedbackTitle: 'Describe what happened:',
    feedbackPlaceholder: 'What were you doing before the error...',
    feedbackSend: 'Send',
    feedbackThanks: 'Thank you for your feedback!',
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif',
      color: '#666', gap: 16, padding: 32,
    }}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <h2 style={{ margin: 0, fontSize: 18 }}>
        {labels.title}
      </h2>
      <p style={{ margin: 0, textAlign: 'center', maxWidth: 400 }}>
        {labels.description}
      </p>

      <FallbackFeedbackForm eventId={eventId} labels={labels} />

      <button
        onClick={() => window.location.reload()}
        style={{
          padding: '8px 24px', border: '1px solid #d1d5db', borderRadius: 6,
          background: '#fff', cursor: 'pointer', fontSize: 14,
        }}
      >
        {labels.reload}
      </button>
    </div>
  )
}

export default function Root() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const h = () => setHash(location.hash)
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])

  // Apply theme from settings. Also update on window focus so that changes from the Settings window
  // (which is a separate BrowserWindow) are applied after closing.
  useEffect(() => {
    let cancelled = false

    /** Applies theme and language from a settings object */
    const applySettings = (s: { theme?: unknown; language?: unknown }) => {
      const theme = s.theme === 'dark' ? 'dark' : 'light'
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme

      const lang: Language = (
        typeof s.language === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(s.language)
          ? s.language
          : DEFAULT_LANGUAGE
      ) as Language
      document.documentElement.lang = lang
      void i18n.changeLanguage(lang)
    }

    /** Loads settings from main process and applies them */
    const fetchAndApply = async () => {
      try {
        const s = await window.api.invoke('settings:get') as { theme?: unknown; language?: unknown } | undefined
        if (!cancelled && s) applySettings(s)
      } catch {
        // If IPC is unavailable, keep default values.
      }
    }

    void fetchAndApply()

    const onSettingsChanged = (s: unknown) => {
      if (s && typeof s === 'object') applySettings(s as { theme?: unknown; language?: unknown })
      else void fetchAndApply()
    }

    window.api?.on('settings:changed', onSettingsChanged)
    window.addEventListener('focus', fetchAndApply)
    return () => {
      cancelled = true
      window.api?.off('settings:changed', onSettingsChanged)
      window.removeEventListener('focus', fetchAndApply)
    }
  }, [])

  const content = (() => {
    if (hash === '#/settings') return <Settings />
    if (hash.startsWith('#/account')) {
      const params = new URLSearchParams(hash.split('?')[1] || '')
      const mode = params.get('mode') === 'edit' ? 'edit' as const : 'new' as const
      const editId = params.get('id') ? Number(params.get('id')) : undefined
      return <Account initialMode={mode} initialEditId={editId} />
    }
    if (hash === '#/compose') return <Compose />
    if (hash.startsWith('#/mail-window')) {
      const params = new URLSearchParams(hash.split('?')[1] || '')
      const accountId = Number(params.get('accountId') || '')
      const folder = params.get('folder') || ''
      const uid = Number(params.get('uid') || '')
      return <MailWindow accountId={accountId} folder={folder} uid={uid} />
    }
    return <App />
  })()

  return (
    <SentryErrorBoundary fallback={({ eventId }) => <FallbackUI eventId={eventId} />} showDialog={false}>
      {content}
    </SentryErrorBoundary>
  )
}
