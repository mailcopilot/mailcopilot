// @vitest-environment jsdom
/**
 * Unit tests for src/components/TelemetryConsentDialog.tsx (§2.82).
 *
 * The component is presentational, so most of these assert legal properties of
 * the markup rather than behaviour (AC5 / EDPB Guidelines 03/2022):
 *   - two buttons of equal weight: same tag, same class, same disabled state,
 *     same parent, and neither carries autoFocus
 *   - no checkbox anywhere, therefore no pre-ticked one (Planet49 C-673/17)
 *   - the disclosure names what is sent and what is never sent, tells the user
 *     where the decision can be changed (GDPR art. 7(3)), and links the privacy
 *     page through the sanctioned `ui:openExternal` channel
 *   - real translations exist for every key in all six locales (AC14)
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const APP_CSS = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf8')

/** Body of the first CSS rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
  const match = new RegExp(`(^|[,}])\\s*\\${selector}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm').exec(APP_CSS)
  return match?.[3] ?? ''
}

/** Declared `z-index` of a rule, or NaN when the rule declares none. */
function zIndex(selector: string): number {
  return Number(/z-index:\s*(\d+)/.exec(ruleBody(selector))?.[1])
}

// Stable i18n mock — returns the key so assertions do not depend on wording.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../sentry', () => ({ captureException: vi.fn() }))

const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { on: vi.fn(), off: vi.fn(), invoke: mockInvoke },
  writable: true,
  configurable: true,
})

import TelemetryConsentDialog, { TELEMETRY_PRIVACY_URL } from './TelemetryConsentDialog'
import enLocale from '../i18n/locales/en.json'
import ruLocale from '../i18n/locales/ru.json'
import frLocale from '../i18n/locales/fr.json'
import deLocale from '../i18n/locales/de.json'
import esLocale from '../i18n/locales/es.json'
import itLocale from '../i18n/locales/it.json'

const LOCALES: Array<[string, Record<string, unknown>]> = [
  ['en', enLocale as unknown as Record<string, unknown>],
  ['ru', ruLocale as unknown as Record<string, unknown>],
  ['fr', frLocale as unknown as Record<string, unknown>],
  ['de', deLocale as unknown as Record<string, unknown>],
  ['es', esLocale as unknown as Record<string, unknown>],
  ['it', itLocale as unknown as Record<string, unknown>],
]

// Per-channel implementation rather than a blanket resolved value: the screen
// now renders a titlebar, whose `useMaximized` fires `win:isMaximized` on mount,
// so a `…Once` override would be consumed by that call instead of the one the
// test aims at.
beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation((channel: string) =>
    channel === 'win:isMaximized' ? Promise.resolve(false) : Promise.resolve({ ok: true }))
})
afterEach(() => { cleanup() })

/** Render and flush the titlebar's mount-time IPC so no state lands outside act(). */
async function renderDialog(props: { submitting?: boolean; onDecide?: (granted: boolean) => void } = {}) {
  const onDecide = props.onDecide ?? vi.fn()
  let result!: RenderResult
  await act(async () => {
    result = render(<TelemetryConsentDialog submitting={props.submitting ?? false} onDecide={onDecide} />)
  })
  return { onDecide, container: result.container }
}

describe('TelemetryConsentDialog — no dark patterns (AC5)', () => {
  it('renders the two answers with identical weight', async () => {
    await renderDialog()
    const allow = screen.getByTestId('telemetry-consent-allow')
    const deny = screen.getByTestId('telemetry-consent-deny')

    expect(allow.tagName).toBe(deny.tagName)
    // Same class attribute — in practice both are unstyled, which is the point:
    // no btn-primary on one side and a plain button on the other.
    expect(allow.getAttribute('class')).toBe(deny.getAttribute('class'))
    expect(allow.className).not.toMatch(/primary/)
    expect(deny.className).not.toMatch(/primary/)
    // Same container, so neither can be visually demoted by placement.
    expect(allow.parentElement).toBe(deny.parentElement)
    expect(allow.parentElement).toHaveClass('confirm-dialog-actions')
  })

  it('gives neither button focus (Enter cannot answer for the user)', async () => {
    await renderDialog()
    expect(screen.getByTestId('telemetry-consent-allow')).not.toHaveAttribute('autofocus')
    expect(screen.getByTestId('telemetry-consent-deny')).not.toHaveAttribute('autofocus')
    expect(document.activeElement).toBe(document.body)
  })

  it('contains no checkbox at all, so none can be pre-ticked', async () => {
    const { container } = await renderDialog()
    expect(container.querySelectorAll('input')).toHaveLength(0)
  })

  it('reports the click as a boolean decision', async () => {
    const { onDecide } = await renderDialog()

    fireEvent.click(screen.getByTestId('telemetry-consent-deny'))
    expect(onDecide).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByTestId('telemetry-consent-allow'))
    expect(onDecide).toHaveBeenLastCalledWith(true)
  })

  it('disables both buttons together while the answer is being saved', async () => {
    await renderDialog({ submitting: true })
    expect(screen.getByTestId('telemetry-consent-allow')).toBeDisabled()
    expect(screen.getByTestId('telemetry-consent-deny')).toBeDisabled()
  })

  it('does not answer on a backdrop click', async () => {
    const { onDecide } = await renderDialog()
    fireEvent.click(screen.getByTestId('telemetry-consent-overlay'))
    expect(onDecide).not.toHaveBeenCalled()
  })
})

describe('TelemetryConsentDialog — disclosure', () => {
  it('lists what is sent and what is never sent', async () => {
    await renderDialog()
    const sent = screen.getByTestId('telemetry-consent-sent')
    const never = screen.getByTestId('telemetry-consent-never')

    expect(sent.querySelectorAll('li')).toHaveLength(6)
    expect(sent).toHaveTextContent('telemetryConsent.sent.errors')
    expect(sent).toHaveTextContent('telemetryConsent.sent.versions')
    expect(sent).toHaveTextContent('telemetryConsent.sent.performance')
    // The two categories the first version of the screen omitted: feature-usage
    // events (usage.session_summary + the per-feature events) and the durable
    // install identifier. Their absence made the list read as exhaustive while
    // it was not — see the disclosure note in TelemetryConsentDialog.tsx.
    expect(sent).toHaveTextContent('telemetryConsent.sent.usage')
    expect(sent).toHaveTextContent('telemetryConsent.sent.setup')
    expect(sent).toHaveTextContent('telemetryConsent.sent.installId')

    expect(never.querySelectorAll('li')).toHaveLength(5)
    expect(never).toHaveTextContent('telemetryConsent.never.bodies')
    expect(never).toHaveTextContent('telemetryConsent.never.addresses')
    expect(never).toHaveTextContent('telemetryConsent.never.attachments')
    expect(never).toHaveTextContent('telemetryConsent.never.searchQueries')
    expect(never).toHaveTextContent('telemetryConsent.never.aiPrompts')
  })

  it('names the withdrawal path on the screen itself (GDPR art. 7(3))', async () => {
    await renderDialog()
    expect(screen.getByTestId('telemetry-consent-change-later'))
      .toHaveTextContent('telemetryConsent.changeLater')
  })

  it('is announced as a modal dialog', async () => {
    await renderDialog()
    const dialog = screen.getByTestId('telemetry-consent-dialog')
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'telemetry-consent-title')
  })

  it('opens the privacy page through ui:openExternal', async () => {
    await renderDialog()
    fireEvent.click(screen.getByTestId('telemetry-consent-privacy-link'))
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', TELEMETRY_PRIVACY_URL)
    expect(TELEMETRY_PRIVACY_URL.startsWith('https://')).toBe(true)
  })

  it('survives a rejected openExternal without crashing the screen', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'ui:openExternal' ? Promise.reject(new Error('gate closed')) : Promise.resolve(false))
    await renderDialog()
    fireEvent.click(screen.getByTestId('telemetry-consent-privacy-link'))
    await Promise.resolve()
    expect(screen.getByTestId('telemetry-consent-dialog')).toBeInTheDocument()
  })
})

// The screen shipped with `maxHeight: 80vh; overflowY: auto` on the whole
// dialog, which scrolled the answer row together with the prose: at the default
// 1200x800 window both buttons were below the fold in all six locales (the
// disclosure is 1031px tall in en, 1206px in fr, against 638px of visible
// dialog). Equal weight between two off-screen buttons is not equal weight.
//
// jsdom has no layout, so the pixels are proven in tests/e2e/telemetryConsent
// .spec.ts. What IS checkable here are the two structural facts the fix rests
// on — the answer row is outside the scrolling region, and the stylesheet still
// declares the column/scroller/footer rules — which is what a well-meaning
// "simplify the styles" edit would take away.
describe('TelemetryConsentDialog — the answers cannot scroll away', () => {
  it('keeps the answer row outside the scrolling region', async () => {
    await renderDialog()
    const body = screen.getByTestId('telemetry-consent-body')

    // The prose scrolls…
    expect(body).toContainElement(screen.getByTestId('telemetry-consent-sent'))
    expect(body).toContainElement(screen.getByTestId('telemetry-consent-never'))
    expect(body).toContainElement(screen.getByTestId('telemetry-consent-change-later'))
    expect(body).toContainElement(screen.getByTestId('telemetry-consent-privacy-link'))

    // …the answers do not.
    expect(body).not.toContainElement(screen.getByTestId('telemetry-consent-allow'))
    expect(body).not.toContainElement(screen.getByTestId('telemetry-consent-deny'))
    // The question stays put as well, so what the buttons answer is always read
    // together with them.
    expect(body).not.toContainElement(screen.getByTestId('telemetry-consent-dialog')
      .querySelector('#telemetry-consent-title') as HTMLElement)
  })

  it('carries the layout classes the stylesheet hangs the rules on', async () => {
    await renderDialog()
    expect(screen.getByTestId('telemetry-consent-overlay')).toHaveClass('consent-overlay')
    expect(screen.getByTestId('telemetry-consent-dialog')).toHaveClass('consent-dialog')
    expect(screen.getByTestId('telemetry-consent-body')).toHaveClass('consent-dialog-body')
  })

  it('declares a capped column whose middle is the only scroller', () => {
    const dialog = ruleBody('.consent-dialog')
    expect(dialog).toMatch(/flex-direction:\s*column/)
    expect(dialog).toMatch(/max-height:/)
    // The box itself must not scroll — that is precisely the shipped bug.
    expect(dialog).toMatch(/overflow:\s*hidden/)

    const body = ruleBody('.consent-dialog-body')
    expect(body).toMatch(/overflow-y:\s*auto/)
    // Without min-height a flex item refuses to shrink below its content and
    // pushes the footer out of the box, restoring the bug with the markup intact.
    expect(body).toMatch(/min-height:\s*0/)
  })

  it('pins the answer row so it is never compressed or scrolled out', () => {
    expect(ruleBody('.consent-dialog .confirm-dialog-actions')).toMatch(/flex:\s*0\s+0\s+auto/)
  })

  it('leaves room for the fixed titlebar above the capped dialog', () => {
    // .child-titlebar is 36px and fixed above the backdrop; without the overlay
    // padding a viewport-tall dialog slides under the drag region and the close
    // button — the only way out of this screen that is not an answer.
    const titlebarHeight = Number(/height:\s*(\d+)px/.exec(ruleBody('.child-titlebar'))?.[1])
    const padTop = Number(/padding:\s*(\d+)px/.exec(ruleBody('.consent-overlay'))?.[1])
    expect(titlebarHeight).toBeGreaterThan(0)
    expect(padTop).toBeGreaterThanOrEqual(titlebarHeight)
  })
})

describe('TelemetryConsentDialog — window chrome', () => {
  // The main window is frameless and Root renders this screen INSTEAD of
  // <App/>, which owns the app's only drag region. Without a titlebar here the
  // first window a new user ever sees cannot be moved and offers no visible way
  // out — the state this screen shipped in.
  it('renders a drag region', async () => {
    await renderDialog()
    const titlebar = screen.getByTestId('telemetry-consent-titlebar')
    expect(titlebar).toHaveClass('child-titlebar')
    // Asserted against the stylesheet, not just the class name: the property has
    // no effect in jsdom, so a class-only check would survive its removal.
    expect(ruleBody('.child-titlebar')).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('keeps the bar above the modal backdrop, which would otherwise swallow it', async () => {
    await renderDialog()
    expect(screen.getByTestId('telemetry-consent-titlebar')).toHaveClass('child-titlebar-overlay')
    // The backdrop is `position: fixed; inset: 0`, so stacking order is the only
    // thing that keeps the drag region and the close button reachable.
    expect(zIndex('.child-titlebar-overlay')).toBeGreaterThan(zIndex('.confirm-overlay'))
  })

  it('closes the window from the titlebar without recording an answer', async () => {
    const { onDecide } = await renderDialog()

    fireEvent.click(screen.getByTestId('window-titlebar-close'))

    expect(mockInvoke).toHaveBeenCalledWith('win:close')
    // Walking away is not a decision: no record is written, so the question is
    // asked again next start (GDPR art. 4(11) — silence is not consent, and it
    // is not a refusal either). Escape, which DOES record a refusal, is a
    // separate path in useTelemetryConsent.
    expect(onDecide).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalledWith('telemetry:setConsent', expect.anything())
  })

  it('survives a rejected win:close without crashing the screen', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'win:close' ? Promise.reject(new Error('no window')) : Promise.resolve(false))
    await renderDialog()

    fireEvent.click(screen.getByTestId('window-titlebar-close'))
    await act(async () => { await Promise.resolve() })

    expect(screen.getByTestId('telemetry-consent-dialog')).toBeInTheDocument()
  })
})

describe('TelemetryConsentDialog — i18n (AC14)', () => {
  const REQUIRED_KEYS = [
    'title', 'intro', 'sentTitle', 'neverTitle', 'changeLater', 'learnMore', 'allow', 'deny',
  ]
  const SENT_KEYS = ['errors', 'versions', 'performance', 'usage', 'setup', 'installId']
  const NEVER_KEYS = ['bodies', 'addresses', 'attachments', 'searchQueries', 'aiPrompts']

  it.each(LOCALES)('%s carries a real translation for every consent key', (_lang, locale) => {
    const block = locale.telemetryConsent as Record<string, unknown>
    expect(block).toBeTruthy()
    for (const key of REQUIRED_KEYS) {
      const value = block[key]
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
      expect(value as string).not.toMatch(/TODO|FIXME|__/)
    }
    for (const [group, keys] of [['sent', SENT_KEYS], ['never', NEVER_KEYS]] as const) {
      const items = block[group] as Record<string, unknown>
      expect(Object.keys(items).sort()).toEqual([...keys].sort())
      for (const key of keys) {
        expect(typeof items[key]).toBe('string')
        expect((items[key] as string).trim().length).toBeGreaterThan(0)
      }
    }
  })

  it.each(LOCALES)('%s explains the clamped About switch', (_lang, locale) => {
    const about = (locale.settings as Record<string, Record<string, unknown>>).about
    expect(typeof about.sentryConsentPending).toBe('string')
    expect((about.sentryConsentPending as string).trim().length).toBeGreaterThan(0)
  })

  // A durable install identifier travels with the data (install_id_hash, also
  // set as the Sentry user id), so the data is pseudonymous, not anonymous.
  // Calling it "anonymous" on the answer surface overstates the protection and
  // makes the consent misleading (GDPR art. 4(11), recital 26). The word is
  // allowed in `intro`, where every locale uses it in the NEGATIVE ("not fully
  // anonymous") — hence the check targets the short strings the user reads
  // right next to the two buttons plus the Settings switch label.
  const ANONYMITY_WORDS = ['anonym', 'аноним', 'anonim', 'anónim']

  it.each(LOCALES)('%s does not call the data anonymous on the answer surface', (_lang, locale) => {
    const block = locale.telemetryConsent as Record<string, string>
    const about = (locale.settings as Record<string, Record<string, unknown>>).about
    const claims = [
      block.title, block.sentTitle, block.neverTitle, block.allow, block.deny,
      about.sentryEnabled as string,
    ].join(' ').toLowerCase()
    for (const word of ANONYMITY_WORDS) expect(claims).not.toContain(word)
  })

  // The identifier is the reason the data is not anonymous, so the intro has to
  // name it — the bullet list alone would leave the framing sentence claiming
  // more privacy than the payload delivers.
  const IDENTIFIER_WORD: Record<string, string> = {
    en: 'identifier', ru: 'идентификатор', fr: 'identifiant',
    de: 'kennung', es: 'identificador', it: 'identificatore',
  }

  it.each(LOCALES)('%s names the install identifier in the intro and in the sent list', (lang, locale) => {
    const block = locale.telemetryConsent as Record<string, unknown>
    const word = IDENTIFIER_WORD[lang]
    expect((block.intro as string).toLowerCase()).toContain(word)
    const sent = block.sent as Record<string, string>
    expect(sent.installId.toLowerCase()).toContain(word)
  })

  // "Email addresses are never sent" is read as unconditional, but Settings →
  // About carries a feedback form (Settings.tsx) whose optional email field is
  // forwarded to Sentry with the message. The form is a deliberate, user-typed
  // action rather than background collection, so the fix is a qualifier on the
  // existing bullet — but the qualifier has to be there, in every locale, or the
  // disclosure promises more than the app delivers (GDPR art. 4(11)).
  const EXCEPTION_MARKERS: Record<string, string[]> = {
    en: ['exception', 'feedback form'],
    ru: ['исключение', 'обратной связи'],
    fr: ['exception', 'formulaire de retour'],
    de: ['ausnahme', 'feedback-formular'],
    es: ['excepción', 'formulario de comentarios'],
    it: ['eccezione', 'modulo di feedback'],
  }

  it.each(LOCALES)('%s qualifies the address bullet with the feedback form', (lang, locale) => {
    const sent = (locale.telemetryConsent as Record<string, unknown>).never as Record<string, string>
    const addresses = sent.addresses.toLowerCase()
    for (const marker of EXCEPTION_MARKERS[lang]) expect(addresses).toContain(marker)
  })

  // Same claim, second surface: the About hint sits directly above the feedback
  // form, so the qualifier has to be visible at the moment the address is typed,
  // not only on the first-run screen.
  it.each(LOCALES)('%s qualifies the About telemetry hint next to the form', (lang, locale) => {
    const about = (locale.settings as Record<string, Record<string, unknown>>).about
    const hint = (about.sentryHint as string).toLowerCase()
    // The form marker only — "exception" reads oddly in a hint that is already
    // next to the form; what matters is that the address path is named.
    expect(hint).toContain(EXCEPTION_MARKERS[lang][1])
  })

  // Third surface for the same form: the intro used to promise that "every
  // feature works the same either way", but Settings → About swaps the built-in
  // feedback form for a plain website link while telemetry is off
  // (`!sentryEnabled` branch in Settings.tsx). The answer therefore does change
  // what the app offers, and the consent screen has to say so — an unqualified
  // parity promise is the kind of claim the user can check in one click. The
  // check is "the intro names the feedback form", because any rewrite back to an
  // absolute promise necessarily drops that mention.
  it.each(LOCALES)('%s names the feedback form as the one thing the answer changes', (lang, locale) => {
    const intro = (locale.telemetryConsent as Record<string, string>).intro.toLowerCase()
    expect(intro).toContain(EXCEPTION_MARKERS[lang][1])
  })

  // Both surfaces used to promise, without qualification, that message content,
  // subjects and folder names are NEVER sent. The guarantee the code actually
  // provides is narrower and of a different kind (see the note above `EMAIL_RE`
  // in piiScrub.ts): typed metrics and the sent-copy diagnostics carry a closed
  // set of fields, so content cannot ride along by construction — but a call
  // site that has not yet been converted to a synthetic error still forwards a
  // third-party server's message verbatim, and the scrubber recognises address
  // and path SHAPES only, never a folder name or a subject.
  //
  // So the honest claim is two-part: nothing we send is BUILT from mail content,
  // and on top of that addresses and paths are stripped automatically from the
  // one text we do not compose ourselves. The check pins the second half, which
  // is precisely the half any rewrite back to a flat "never" would delete.
  const SCRUB_MARKERS: Record<string, [string, string]> = {
    en: ['automatically', 'error'],
    ru: ['автоматически', 'ошиб'],
    fr: ['automatiquement', 'erreur'],
    de: ['automatisch', 'fehler'],
    es: ['automáticamente', 'error'],
    it: ['automaticamente', 'errore'],
  }

  it.each(LOCALES)('%s states the content claim as scope plus scrubbing, not as "never"', (lang, locale) => {
    const bodies = ((locale.telemetryConsent as Record<string, unknown>).never as Record<string, string>).bodies
    const hint = ((locale.settings as Record<string, Record<string, unknown>>).about.sentryHint as string)
    for (const surface of [bodies, hint]) {
      for (const marker of SCRUB_MARKERS[lang]) expect(surface.toLowerCase()).toContain(marker)
    }
  })

  // Second half of the same claim, second failure mode: both surfaces used to
  // present the scrubbing itself as total ("from ANY error text a mail server
  // returns"). It is not. `scrubEventPiiWith` recognises address and path
  // SHAPES, walks free-form containers only to depth 4 and 500 nodes, skips the
  // feedback envelope on purpose and leaves `server_name` alone by policy — so
  // the honest form is "automatically, wherever they can be recognised". The
  // marker is the recognition qualifier, which is exactly what a rewrite back
  // to a total promise would delete. Kept separate from the check above so the
  // two halves fail independently and name their own cause.
  const RECOGNITION_MARKERS: Record<string, string> = {
    en: 'recognis', ru: 'распозна', fr: 'reconn', de: 'erkann', es: 'reconoc', it: 'riconosc',
  }

  it.each(LOCALES)('%s bounds the scrubbing claim by what can be recognised', (lang, locale) => {
    const bodies = ((locale.telemetryConsent as Record<string, unknown>).never as Record<string, string>).bodies
    const hint = ((locale.settings as Record<string, Record<string, unknown>>).about.sentryHint as string)
    for (const surface of [bodies, hint]) {
      expect(surface.toLowerCase()).toContain(RECOGNITION_MARKERS[lang])
    }
  })

  it.each(LOCALES)('%s does not nudge the user towards "allow"', (_lang, locale) => {
    const block = locale.telemetryConsent as Record<string, string>
    const prose = [block.title, block.intro, block.allow, block.deny].join(' ').toLowerCase()
    // EDPB Guidelines 03/2022: no "recommended"/"best choice" framing anywhere
    // near the two answers, in any of the six languages we ship.
    for (const nudge of [
      'recommended', 'рекомендуется', 'рекомендуем', 'empfohlen', 'recomendado',
      'recommandé', 'consigliato', 'best choice', 'please allow',
    ]) {
      expect(prose).not.toContain(nudge)
    }
  })
})
