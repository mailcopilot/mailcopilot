import React from 'react'
import ReactDOM from 'react-dom/client'
import { initSentry, setSentryUserEnabled, setSentryUserId } from './sentry'
import './i18n'
import Root from './Root'
import './index.css'
import { startUiFreezeDetector } from './utils/uiFreezeDetector'

// Apply theme synchronously before first paint to prevent flash-of-white in dark mode.
// The theme is passed from main process via additionalArguments → preload → window.api.initialTheme.
if (window.api?.initialTheme === 'dark') {
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.style.colorScheme = 'dark'
}

// Apply the persisted sentryEnabled flag BEFORE Sentry.init so the very
// first startup events (and the stable install-id attachment) honor the
// user's telemetry toggle. Without this there is a window between init and
// the later App.tsx settings load where events leak with the default
// "enabled" state. Use strict `=== true` so any unexpected absence of the
// bridge (test harness without preload, future-proofing) fails CLOSED,
// matching the main-process preflight policy.
const initialSentryEnabled = window.api?.sentryEnabled === true
setSentryUserEnabled(initialSentryEnabled)

// Sentry is initialized before rendering the React tree.
initSentry()
// Attach the pseudonymous install-id passed from main via additionalArguments,
// so renderer events share the same user identity as main-process events.
// Only attach when telemetry is actually enabled — otherwise we would bind
// the stable per-install id to a client that should be silent.
if (initialSentryEnabled && window.api?.installIdHash) {
  setSentryUserId(window.api.installIdHash)
}

// Log UI freezes (main-thread blocking > 500ms) to main.log so they can be
// correlated with concurrent IPC / sync activity.
startUiFreezeDetector()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
