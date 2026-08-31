import { useState, useEffect, type ReactElement } from 'react'
import i18n, { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type Language } from './i18n'
import { SentryErrorBoundary, sendFeedback, isSentryActive } from './sentry'
import App from './App'
import Settings from './windows/Settings'
import Account from './windows/Account'
import Compose from './windows/Compose'
import MailWindow from './windows/MailWindow'
import TelemetryConsentDialog from './components/TelemetryConsentDialog'
import { useTelemetryConsent, reportConsentTreeError } from './hooks/useTelemetryConsent'

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

/**
 * Route a child-window hash to its component.
 *
 * Returns `null` for the main window — which is also how Root decides whether
 * the telemetry consent gate applies, so a hash that this table routes can
 * never end up behind the gate.
 *
 * Note the direction of the default: `null` means "not a known child window",
 * and Root treats that as the main window, so an UNKNOWN hash falls INTO the
 * gate. A new child window is therefore not covered automatically — omitting it
 * here puts the consent screen in front of it instead of leaving it out. Add
 * every new child-window hash to this table (and to the routing tests in
 * src/Root.test.tsx).
 *
 * Pure: no hooks, safe to call during render before the hook list.
 */
// eslint-disable-next-line react-refresh/only-export-components -- exported for unit tests (src/Root.test.tsx); same pattern as detectAuthRecoveryKind in App.tsx.
export function renderChildWindow(hash: string): ReactElement | null {
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
  return null
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

  const childWindow = renderChildWindow(hash)

  // §2.82 — first-run telemetry consent. Main-window only, and NOT because a
  // child window's user has necessarily answered: since §2.236 the main UI can
  // render `unresolved`, with no record written, and every window it opens is
  // reachable from there. The reason is that a child window is not a separate
  // owner of the question — there is one record per install, the screen belongs
  // to the main window (main refuses `telemetry:setConsent` from anyone else),
  // and asking from four windows at once would put four screens on screen for
  // one answer. Not a bypass either: effective permission is main's, and main
  // clamps `sentryEnabled` to false for the whole app while no record exists,
  // so a child window rendering without the screen sends nothing.
  const consent = useTelemetryConsent({ enabled: childWindow === null })

  // §2.236 AC1 — mirror the handshake onto `<html>`. Two attributes, no copy, no
  // behaviour: `resolved` (main answered) and `unresolved` (nobody answered
  // within the bound) both render the app, and this is what tells them apart
  // afterwards — in DevTools on the machine that reproduces the defect, and in
  // the e2e suite. Same mechanism as `dataset.theme` above.
  useEffect(() => {
    document.documentElement.dataset.telemetryConsent = consent.phase
    document.documentElement.dataset.telemetryConsentAttempts = String(consent.attempts)
  }, [consent.phase, consent.attempts])

  const content = (() => {
    if (childWindow) return childWindow
    // Nothing is rendered while the state query is in flight, and `<App/>` is
    // not rendered at all while the screen is up. That is deliberate: mounting
    // App runs its load effect, which opens the account wizard when no account
    // exists — the consent question has to come before any of that (AC (c)/AC4).
    if (consent.phase === 'checking') return null
    if (consent.phase === 'required') {
      return <TelemetryConsentDialog submitting={consent.submitting} onDecide={consent.decide} />
    }
    // `resolved` AND `unresolved` (§2.236). The app renders either way — mail is
    // never held hostage behind a modal (GDPR art. 7(4)) — but the two are not
    // the same state and are not allowed to become the same state: `unresolved`
    // wrote no record, so telemetry stays off and the question returns next
    // launch, while `resolved` means an answer exists. The difference is carried
    // by the phase itself and by the `<html>` attributes above; nothing here may
    // collapse `unresolved` into `resolved`.
    return <App />
  })()

  return (
    <SentryErrorBoundary
      fallback={({ eventId }) => <FallbackUI eventId={eventId} />}
      // §2.236 AC1(d) — a crash while the consent screen is up is the one crash
      // the boundary's own report cannot deliver (telemetry is necessarily off
      // while the question is open, so `beforeSend` drops it). The handler adds
      // the local line that is not dropped. Instrumentation only: what renders
      // on a crash is unchanged.
      onError={(error) => reportConsentTreeError(consent.phase, error)}
      showDialog={false}
    >
      {content}
    </SentryErrorBoundary>
  )
}
