import { useCallback, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, ExternalLink } from 'lucide-react'
import { captureException } from '../sentry'
import WindowTitlebar from './WindowTitlebar'

/**
 * §2.82 — first-run telemetry consent screen.
 *
 * Presentational only: the decision, the IPC round-trip and the Escape binding
 * live in `useTelemetryConsent`. Rendered by `src/Root.tsx` INSTEAD of `<App/>`,
 * which is what keeps the account wizard from opening behind it (AC4) — this is
 * a gate, not an overlay on a running app.
 *
 * The rules below are legal requirements, not styling preferences. Changing any
 * of them invalidates the consent we collect:
 *
 *   - Two buttons, identical markup and identical class (none), same size, same
 *     container. Highlighting "allow" or shrinking "don't allow" is a named
 *     deceptive pattern (EDPB Guidelines 03/2022 §3; GDPR art. 4(11) requires
 *     freely given consent).
 *   - No `autoFocus` on either button, so Enter cannot answer for the user.
 *   - No checkbox at all, therefore no pre-ticked one (CJEU Planet49 C-673/17:
 *     a pre-ticked box is not consent).
 *   - No nudging copy ("recommended", "help us", emphasis on the upside).
 *   - Concrete disclosure: what is sent, what is never sent, and where the
 *     decision can be changed (GDPR art. 7(3) — withdrawal must be as easy as
 *     giving, so the path to it is named on the screen itself).
 *
 * Layout carries the same weight as the markup: the screen is a column whose
 * middle (`.consent-dialog-body`) is the ONLY scrolling region, so both answers
 * are on screen at every window size down to the 900x600 minimum and in every
 * locale. Scrolling the dialog as a whole — the shipped state — left both
 * buttons below the fold in all six locales at the default 1200x800 window,
 * i.e. an enumeration of what we collect with no visible way to answer it.
 * Equal weight between two invisible buttons is not equal weight. Do not put
 * the answer row back inside the scroller, and do not shorten the disclosure to
 * make it fit; the rules live in App.css under "§2.82" and the e2e sweep in
 * tests/e2e/telemetryConsent.spec.ts fails if either is undone.
 *
 * There is no outside-click handler: a stray click on the backdrop must not be
 * read as an answer in either direction. Escape (handled in the hook) is the
 * only keyboard exit and it records a refusal.
 *
 * The screen renders its own titlebar. The main window is frameless
 * (`frame: false`, electron/main.ts) and Root renders this component INSTEAD of
 * `<App/>`, which is where the app's only drag region normally lives — so
 * without the bar the very first window a new user sees cannot be moved with
 * the mouse and shows no way to close it. See WindowTitlebar for the chrome
 * itself; the close semantics are documented on `closeWindow` below.
 */

/** Canonical disclosure page. Same host the rest of the app links to
 *  (`electron/main.ts` update dialog, Settings → About). */
export const TELEMETRY_PRIVACY_URL = 'https://docs.mailcopilot.io/privacy/telemetry'

/** Bullet-list metrics only. The layout that keeps both answers on screen lives
 *  in App.css (`.consent-overlay` / `.consent-dialog*`) rather than inline: it
 *  is a column with a scrolling middle, which inline styles cannot express
 *  without also restating the `.confirm-dialog` rules it builds on — and the
 *  regression test asserts the footer rule against the stylesheet. */
const LIST_STYLE: CSSProperties = { margin: '4px 0 12px', paddingLeft: 20, fontSize: 13, lineHeight: 1.5 }
/** No bottom margin: the pinned footer supplies the gap above the buttons. */
const LINK_ROW_STYLE: CSSProperties = { margin: 0 }

type Props = {
  /** True while the answer is being persisted — both buttons disable together
   *  (disabling only one would emphasize the other). */
  submitting: boolean
  /** Reports the click. `false` must be reachable in one click, like `true`. */
  onDecide: (granted: boolean) => void
}

/**
 * Bullet lists are enumerated from i18n so all six locales stay in step.
 *
 * The "sent" list is a DISCLOSURE, not a summary: it is read as exhaustive, so
 * every category the app can actually transmit has to appear in it. Consent
 * obtained against an incomplete list is not informed consent (GDPR art. 4(11);
 * EDPB Guidelines 03/2022 on misleading interfaces), and the "learn more" link
 * does not repair that — the list itself is what the user answers on.
 *
 * The categories map to `electron/metricsSchema.ts` (the exhaustive registry of
 * what may be emitted) plus the two surfaces that live outside it:
 *   errors      — captureException payloads (type + scrubbed stack frames)
 *   versions    — release + platform/OS attached to every event
 *   performance — NET_SPANS / ELECTRON_SPANS / DB_SPANS durations, *_ms histograms
 *   usage       — usage.session_summary feature bitmap, per-feature events, and
 *                 the `sentryLogger.info('AI chat completed', …)` structured log
 *                 (AI provider, model, tool names, estimated cost)
 *   aiKeyStore  — ai.api_key_store_op: which provider, which operation on the
 *                 OS secret store (read / write / delete) and how it ended
 *                 (found / absent / ok / store_error). "Is there a key in your
 *                 keychain" is an observation about the machine, not a feature
 *                 the user invoked, so `usage` does not cover it — it needs its
 *                 own bullet. The key VALUE is never part of the event, which
 *                 the copy says out loud because that is the reader's first
 *                 question.
 *   setup       — app.session_started / onboarding.* tags: accounts_count,
 *                 provider kind, auth_type, lang, theme, platform
 *   installId   — install_id_hash, also set as the Sentry user id. It is what
 *                 makes the data pseudonymous rather than anonymous, so it is
 *                 named on the screen together with the fact that it ties
 *                 sessions of one installation together.
 *
 * When a new telemetry category ships, extend this list and bump
 * TELEMETRY_CONSENT_VERSION (electron/telemetryConsent.ts) so people who already
 * answered are asked again against the revised disclosure.
 */
const SENT_ITEMS = ['errors', 'versions', 'performance', 'usage', 'aiKeyStore', 'setup', 'installId'] as const
const NEVER_ITEMS = ['bodies', 'addresses', 'attachments', 'searchQueries', 'aiPrompts'] as const

export default function TelemetryConsentDialog({ submitting, onDecide }: Props) {
  const { t } = useTranslation()

  const openPrivacyPage = useCallback(() => {
    try {
      void window.api?.invoke('ui:openExternal', TELEMETRY_PRIVACY_URL)
        ?.catch((err: unknown) => captureException(err, { source: 'TelemetryConsentDialog.openPrivacy' }))
    } catch (err) {
      captureException(err, { source: 'TelemetryConsentDialog.openPrivacy' })
    }
  }, [])

  /**
   * Titlebar close button — closes the window, nothing else.
   *
   * Deliberately NOT `onDecide(false)`. Escape and the "don't allow" button
   * record a refusal; closing the window records nothing, so the question is
   * asked again on the next start. That difference is the point: walking away
   * is not an answer (GDPR art. 4(11) — consent, and equally its refusal, is a
   * statement or clear affirmative action, not the absence of one). The main
   * window closes through `win:close` the same way App's titlebar does.
   */
  const closeWindow = useCallback(() => {
    try {
      void window.api?.invoke('win:close')
        ?.catch((err: unknown) => captureException(err, { source: 'TelemetryConsentDialog.closeWindow' }))
    } catch (err) {
      captureException(err, { source: 'TelemetryConsentDialog.closeWindow' })
    }
  }, [])

  return (
    <>
    <WindowTitlebar
      title="MailCopilot"
      className="child-titlebar-overlay"
      testId="telemetry-consent-titlebar"
      onClose={closeWindow}
    />
    <div className="confirm-overlay consent-overlay" role="presentation" data-testid="telemetry-consent-overlay">
      <div
        className="confirm-dialog link-dialog consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="telemetry-consent-title"
        aria-describedby="telemetry-consent-intro"
        data-testid="telemetry-consent-dialog"
      >
        <p id="telemetry-consent-title" className="consent-dialog-title">
          <ShieldCheck size={16} style={{ verticalAlign: -2, marginRight: 4 }} />
          {t('telemetryConsent.title')}
        </p>

        {/* The only scrolling region on the screen. Everything the user reads is
            in here; the question above and the two answers below stay put, at
            every window size and in every locale (App.css §2.82).
            `tabIndex` makes the region reachable by keyboard so the disclosure
            can be read without a pointer. It is not focus on an answer — both
            buttons stay unfocused, so Enter still cannot answer for the user. */}
        <div className="consent-dialog-body" data-testid="telemetry-consent-body" tabIndex={0}>
          <div className="link-prompt-text" id="telemetry-consent-intro">
            <div className="link-prompt-value">{t('telemetryConsent.intro')}</div>
          </div>

          <div className="link-prompt-text">
            <div className="link-prompt-label">{t('telemetryConsent.sentTitle')}</div>
            <ul style={LIST_STYLE} data-testid="telemetry-consent-sent">
              {SENT_ITEMS.map(key => <li key={key}>{t(`telemetryConsent.sent.${key}`)}</li>)}
            </ul>
          </div>

          <div className="link-prompt-text">
            <div className="link-prompt-label">{t('telemetryConsent.neverTitle')}</div>
            <ul style={LIST_STYLE} data-testid="telemetry-consent-never">
              {NEVER_ITEMS.map(key => <li key={key}>{t(`telemetryConsent.never.${key}`)}</li>)}
            </ul>
          </div>

          <div className="link-prompt-text">
            <div className="link-prompt-value" data-testid="telemetry-consent-change-later">
              {t('telemetryConsent.changeLater')}
            </div>
          </div>

          <div style={LINK_ROW_STYLE}>
            <button
              type="button"
              className="btn-link"
              data-testid="telemetry-consent-privacy-link"
              onClick={openPrivacyPage}
            >
              {t('telemetryConsent.learnMore')}
              <ExternalLink size={12} style={{ verticalAlign: -1, marginLeft: 4 }} />
            </button>
          </div>
        </div>

        {/* Equal weight by construction: same element, same (absent) class, same
            disabled state, same container. Neither carries autoFocus. */}
        <div className="confirm-dialog-actions">
          <button
            type="button"
            data-testid="telemetry-consent-deny"
            disabled={submitting}
            onClick={() => onDecide(false)}
          >
            {t('telemetryConsent.deny')}
          </button>
          <button
            type="button"
            data-testid="telemetry-consent-allow"
            disabled={submitting}
            onClick={() => onDecide(true)}
          >
            {t('telemetryConsent.allow')}
          </button>
        </div>
      </div>
    </div>
    </>
  )
}
