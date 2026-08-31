// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import type { OAuthConnectStage } from '@mailcopilot/types'

// Real locale strings — the point of several assertions below is that every
// stage actually resolves to copy, so a missing key must fail the test rather
// than echo back the key name.
import en from '../i18n/locales/en.json'

function lookup(key: string): string | undefined {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
  ) as string | undefined
}

const stableT = (key: string, vars?: Record<string, string>): string => {
  const raw = lookup(key)
  if (raw === undefined) return key
  return vars
    ? raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? `{{${name}}}`)
    : raw
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

import OAuthWaiting from './OAuthWaiting'

afterEach(cleanup)

const ALL_STAGES: OAuthConnectStage[] = ['browser', 'token', 'imap', 'smtp', 'saving']

describe('OAuthWaiting §2.94', () => {
  it('renders a resolved stage line for every stage of the flow', () => {
    for (const stage of ALL_STAGES) {
      cleanup()
      render(React.createElement(OAuthWaiting, { provider: 'gmail', stage }))
      const line = screen.getByTestId('account-wizard-oauth-stage')
      // A missing translation would echo the key back — that is the failure
      // this asserts against, since the wizard would then show raw dot-paths.
      expect(line).toHaveTextContent(/\S/)
      expect(line.textContent).not.toContain('account.wizard')
    }
  })

  it('announces stage changes to assistive tech', () => {
    render(React.createElement(OAuthWaiting, { provider: 'gmail', stage: 'imap' }))
    const line = screen.getByTestId('account-wizard-oauth-stage')
    expect(line).toHaveAttribute('role', 'status')
    expect(line).toHaveAttribute('aria-live', 'polite')
  })

  it('names the provider being connected', () => {
    render(React.createElement(OAuthWaiting, { provider: 'gmail', stage: 'browser' }))
    expect(screen.getByRole('heading').textContent).toContain('Gmail')

    cleanup()
    render(React.createElement(OAuthWaiting, { provider: 'outlook', stage: 'browser' }))
    expect(screen.getByRole('heading').textContent).toContain('Outlook')
  })

  it('points at the browser only while the browser round trip is pending', () => {
    // The whole complaint was the wait *after* the browser is done, so the
    // hint has to stop pointing there once control is back in the app.
    render(React.createElement(OAuthWaiting, { provider: 'gmail', stage: 'browser' }))
    expect(screen.getByText(stableT('account.wizard.oauthWaiting.browserHint'))).toBeInTheDocument()

    cleanup()
    render(React.createElement(OAuthWaiting, { provider: 'gmail', stage: 'imap' }))
    expect(screen.getByText(stableT('account.wizard.oauthWaiting.appHint'))).toBeInTheDocument()
    expect(screen.queryByText(stableT('account.wizard.oauthWaiting.browserHint'))).not.toBeInTheDocument()
  })

  it('renders the step wrapper the wizard keys off', () => {
    render(React.createElement(OAuthWaiting, { provider: 'outlook', stage: 'saving' }))
    expect(screen.getByTestId('account-wizard-oauth-waiting')).toBeInTheDocument()
  })
})
