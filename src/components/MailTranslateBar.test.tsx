// @vitest-environment jsdom
/**
 * §3.3 B6 — MailTranslateBar unit tests.
 *
 * This component is a pure projector of `UseMailTranslationResult` (see its
 * own header docblock): no IPC, no state of its own. Every test here builds a
 * fake state object and asserts what renders and which callback a click
 * reaches — the state machine itself (resets, token discipline, refusal
 * ladder) is covered by `useMailTranslation.test.ts`.
 *
 * Nothing in this file existed before B6 — `MailTranslateBar.tsx` shipped with
 * zero unit tests of its own (only exercised indirectly through the hook
 * test), which left every rendering decision in the component — which control
 * shows for which status, whether the caption picker is an offer or a gate,
 * whether the text-projection disclosure line appears — unverified by
 * anything but eyes.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { TranslateRefusalReason, TranslatedMessage } from '@mailcopilot/types'
import type { UseMailTranslationResult } from '../hooks/useMailTranslation'

// ---- i18n stub (stable — prevents infinite re-renders) ----------------------
// Real production copy from src/i18n/locales/en.json, so a test failure here
// means the RENDERED text actually changed, not that the stub drifted from it.
const i18nMap: Record<string, string> = {
  'mail.translate.action': 'Translate',
  'mail.translate.retry': 'Try again',
  'mail.translate.attempt': "Attempt {{n}}.",
  'mail.translate.loading': 'Translating…',
  'mail.translate.showOriginal': 'Show original',
  'mail.translate.showTranslation': 'Show translation',
  'mail.translate.targetLabel': 'Translate into',
  'mail.translate.sourceLabel': 'Language of the original',
  'mail.translate.sourcePlaceholder': 'Choose a language',
  'mail.translate.sourceOffer': 'The language of the original could not be identified, so the translation above is not labelled with it. Naming it is optional: it updates the label and reuses the translation already produced, without asking the provider for a new one.',
  'mail.translate.sourceApply': 'Update the label',
  'mail.translate.sourceRestate': 'Not the right language?',
  'mail.translate.sourceRestateHint':
    'State the language of the original yourself. It only changes the label above: the translation you are reading stays as it is and is reused, without asking the provider for a new one.',
  'mail.translate.produced': 'Machine translation into {{target}}. The original is one click away.',
  'mail.translate.producedFrom': 'Machine translation from {{source}} into {{target}}. The original is one click away.',
  'mail.translate.textProjection': 'Translated from the plain-text version of the message, so its formatting and images are not part of the translation.',
  'mail.translate.refusal.budget': 'The AI budget for this period is used up. Raise it in Settings → AI, or wait for the next period.',
  'mail.translate.refusal.no_provider': 'No AI provider is set up yet. Add one in Settings → AI.',
  'mail.translate.refusal.provider_error':
    "The AI provider did not return a translation, and did not say why. Another attempt sends the message to the provider again.",
  'mail.translate.refusal.answer_too_long':
    "The translation does not fit within the AI provider's answer limit, so it came back cut off and is not shown. Another attempt would end the same way: neither this message nor the limit has changed.",
  'mail.translate.refusal.empty_input': 'There is no downloaded text for this message yet. Try again once the message has loaded.',
  'mail.translate.refusal.too_long':
    'This message is too long to translate in one go, and there is no way to translate only part of it — the whole message counts towards the limit, including any earlier correspondence quoted inside it.',
  'mail.translate.refusal.opt_out': 'Translation is turned off for this account. Turn it on in Settings → AI → Translate messages.',
  'mail.translate.languages.en': 'English',
  'mail.translate.languages.de': 'German',
  'mail.translate.languages.ru': 'Russian',
  'mail.translate.languages.uk': 'Ukrainian',
  'mail.translate.languages.ja': 'Japanese',
}

const stableT = (key: string, opts?: Record<string, unknown>): string => {
  let text = i18nMap[key] ?? key
  if (opts && typeof opts === 'object') {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
    }
  }
  return text
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}))

// ---- import after mocks -----------------------------------------------------
import MailTranslateBar, { type MailTranslateBarProps } from './MailTranslateBar'

// ---- factories --------------------------------------------------------------

function makeTranslation(overrides: Partial<TranslatedMessage> = {}): TranslatedMessage {
  return {
    translatedText: 'Translated body.',
    sourceLang: 'de',
    targetLang: 'en',
    provider: 'anthropic-api',
    cached: false,
    sourceIsTextProjection: true,
    ...overrides,
  }
}

function makeState(overrides: Partial<UseMailTranslationResult> = {}): UseMailTranslationResult {
  return {
    active: true,
    status: 'idle',
    translation: null,
    refusal: null,
    attempts: 0,
    canRetry: false,
    targetLang: 'en',
    sourceLang: null,
    needsLanguageChoice: false,
    canRestateSourceLang: false,
    sourceChoiceOpen: false,
    sourceChoiceVisible: false,
    canApplySourceLang: false,
    showingTranslation: false,
    setTargetLang: vi.fn(),
    setSourceLang: vi.fn(),
    toggleSourceChoice: vi.fn(),
    request: vi.fn(),
    showOriginal: vi.fn(),
    showTranslation: vi.fn(),
    ...overrides,
  }
}

function renderBar(overrides: Partial<MailTranslateBarProps> = {}) {
  const state = overrides.state ?? makeState()
  const props: MailTranslateBarProps = {
    state,
    originalIsHtml: overrides.originalIsHtml ?? false,
  }
  return { state, ...render(<MailTranslateBar {...props} />) }
}

afterEach(() => {
  cleanup()
})

describe('MailTranslateBar — visibility', () => {
  it('renders nothing at all when the hook reports inactive', () => {
    renderBar({ state: makeState({ active: false }) })
    expect(screen.queryByTestId('mail-translate-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-translate-action')).not.toBeInTheDocument()
  })
})

describe('MailTranslateBar — idle / loading', () => {
  it('shows the target language select and a Translate action when idle', () => {
    renderBar({ state: makeState({ status: 'idle' }) })
    expect(screen.getByTestId('mail-translate-bar')).toBeInTheDocument()
    expect(screen.getByTestId('mail-translate-target')).toBeInTheDocument()
    const action = screen.getByTestId('mail-translate-action')
    expect(action).toHaveTextContent('Translate')
    expect(action).not.toBeDisabled()
    // Not ready yet — the toggle button must not exist.
    expect(screen.queryByTestId('mail-translate-toggle')).not.toBeInTheDocument()
  })

  it('clicking the action calls state.request() — the only path to a provider', () => {
    const { state } = renderBar({ state: makeState({ status: 'idle' }) })
    fireEvent.click(screen.getByTestId('mail-translate-action'))
    expect(state.request).toHaveBeenCalledTimes(1)
  })

  it('shows loading copy and disables the action while a request is in flight', () => {
    const { state } = renderBar({ state: makeState({ status: 'loading' }) })
    const action = screen.getByTestId('mail-translate-action')
    expect(action).toHaveTextContent('Translating…')
    expect(action).toBeDisabled()
    // Disabled means a click cannot fire a second request.
    fireEvent.click(action)
    expect(state.request).not.toHaveBeenCalled()
  })
})

describe('MailTranslateBar — ready: the original/translation switch', () => {
  it('renders the toggle instead of the action once a translation is ready', () => {
    renderBar({ state: makeState({ status: 'ready', translation: makeTranslation(), showingTranslation: true }) })
    expect(screen.queryByTestId('mail-translate-action')).not.toBeInTheDocument()
    expect(screen.getByTestId('mail-translate-toggle')).toBeInTheDocument()
  })

  it('labels the toggle "Show original" and marks aria-pressed when showing the translation', () => {
    renderBar({ state: makeState({ status: 'ready', translation: makeTranslation(), showingTranslation: true }) })
    const toggle = screen.getByTestId('mail-translate-toggle')
    expect(toggle).toHaveTextContent('Show original')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('labels the toggle "Show translation" and clears aria-pressed when showing the original', () => {
    renderBar({ state: makeState({ status: 'ready', translation: makeTranslation(), showingTranslation: false }) })
    const toggle = screen.getByTestId('mail-translate-toggle')
    expect(toggle).toHaveTextContent('Show translation')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking the toggle while showing the translation calls showOriginal, never showTranslation', () => {
    const { state } = renderBar({
      state: makeState({ status: 'ready', translation: makeTranslation(), showingTranslation: true }),
    })
    fireEvent.click(screen.getByTestId('mail-translate-toggle'))
    expect(state.showOriginal).toHaveBeenCalledTimes(1)
    expect(state.showTranslation).not.toHaveBeenCalled()
  })

  it('clicking the toggle while showing the original calls showTranslation, never request (no re-fetch)', () => {
    const { state } = renderBar({
      state: makeState({ status: 'ready', translation: makeTranslation(), showingTranslation: false }),
    })
    fireEvent.click(screen.getByTestId('mail-translate-toggle'))
    expect(state.showTranslation).toHaveBeenCalledTimes(1)
    expect(state.request).not.toHaveBeenCalled()
  })
})

describe('MailTranslateBar — produced-from notice', () => {
  it('names both source and target language when a source label is known', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        showingTranslation: true,
        translation: makeTranslation({ sourceLang: 'de', targetLang: 'ru' }),
      }),
    })
    const notice = screen.getByTestId('mail-translate-notice')
    expect(notice).toHaveTextContent('Machine translation from German into Russian.')
  })

  it('falls back to a target-only sentence when sourceLang is null', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        showingTranslation: true,
        translation: makeTranslation({ sourceLang: null, targetLang: 'en' }),
      }),
    })
    const notice = screen.getByTestId('mail-translate-notice')
    expect(notice).toHaveTextContent('Machine translation into English.')
    expect(notice).not.toHaveTextContent('from')
  })

  it('does not render the notice while showing the original, even with a ready translation', () => {
    renderBar({
      state: makeState({ status: 'ready', translation: makeTranslation(), showingTranslation: false }),
    })
    expect(screen.queryByTestId('mail-translate-notice')).not.toBeInTheDocument()
  })

  it('appends the plain-text-projection disclosure only for an HTML original', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        showingTranslation: true,
        translation: makeTranslation({ sourceIsTextProjection: true }),
      }),
      originalIsHtml: true,
    })
    expect(screen.getByTestId('mail-translate-notice')).toHaveTextContent(
      'Translated from the plain-text version of the message',
    )
  })

  it('omits the disclosure for a plain-text original — the projection IS the message', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        showingTranslation: true,
        translation: makeTranslation({ sourceIsTextProjection: true }),
      }),
      originalIsHtml: false,
    })
    expect(screen.getByTestId('mail-translate-notice')).not.toHaveTextContent(
      'Translated from the plain-text version',
    )
  })
})

describe('MailTranslateBar — refusals render human, localized text', () => {
  const reasons: TranslateRefusalReason[] = [
    'budget',
    'no_provider',
    'provider_error',
    'answer_too_long',
    'empty_input',
    'too_long',
    'opt_out',
  ]

  for (const reason of reasons) {
    it(`shows the '${reason}' refusal as the exact localized sentence, not the raw key`, () => {
      renderBar({ state: makeState({ status: 'refused', refusal: reason }) })
      const banner = screen.getByTestId('mail-translate-refusal')
      expect(banner).toHaveTextContent(i18nMap[`mail.translate.refusal.${reason}`])
      // The literal i18n key must never leak onto the screen as if it were copy.
      expect(banner.textContent).not.toContain(`mail.translate.refusal.${reason}`)
    })
  }

  it('renders no refusal banner when status is not refused', () => {
    renderBar({ state: makeState({ status: 'idle', refusal: null }) })
    expect(screen.queryByTestId('mail-translate-refusal')).not.toBeInTheDocument()
  })

  it('offers a SECOND attempt after a refusal the hook says could go differently', () => {
    const { state } = renderBar({
      state: makeState({ status: 'refused', refusal: 'provider_error', canRetry: true }),
    })
    const action = screen.getByTestId('mail-translate-action')
    expect(action).toHaveTextContent('Try again')
    expect(action).not.toBeDisabled()
    fireEvent.click(action)
    expect(state.request).toHaveBeenCalledTimes(1)
  })
})

/**
 * 2026-08-31 incident, the interface half.
 *
 * A reader hit a refusal, pressed "try again" seven times in three seconds, and
 * saw nothing move. Every one of those presses really did reach the provider and
 * really was billed — the screen simply repainted the same sentence. Two things
 * are wrong in that story and both are fixed here: an attempt that cannot end
 * differently should not be offered at all, and an attempt that IS offered has
 * to visibly register when it is spent.
 */
describe('MailTranslateBar — a retry is offered only when it could change something', () => {
  it('draws NO button for a refusal the hook rules out, rather than a dead one', () => {
    renderBar({
      state: makeState({ status: 'refused', refusal: 'answer_too_long', canRetry: false }),
    })
    // The refusal itself is still on screen and still explains itself.
    expect(screen.getByTestId('mail-translate-refusal')).toHaveTextContent(
      i18nMap['mail.translate.refusal.answer_too_long'],
    )
    // A control whose outcome is already known is not a choice, and each press
    // of it would be a fresh billed request.
    expect(screen.queryByTestId('mail-translate-action')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-translate-toggle')).not.toBeInTheDocument()
  })

  it('never withholds the button outside a refusal — idle and loading always keep it', () => {
    // `canRetry` is a statement about a refusal on screen. Reading it as a
    // general "may this button exist" would hide the ordinary Translate action.
    renderBar({ state: makeState({ status: 'idle', canRetry: false }) })
    expect(screen.getByTestId('mail-translate-action')).toHaveTextContent('Translate')
    cleanup()
    renderBar({ state: makeState({ status: 'loading', canRetry: false }) })
    expect(screen.getByTestId('mail-translate-action')).toBeDisabled()
  })

  it('leaves the reader a way forward when the button is gone — the target select stays', () => {
    // Changing the target resets the hook to idle, which is how the Translate
    // action comes back. Without this the bar would be a cul-de-sac.
    renderBar({
      state: makeState({ status: 'refused', refusal: 'too_long', canRetry: false }),
    })
    expect(screen.getByTestId('mail-translate-target')).toBeInTheDocument()
  })
})

describe('MailTranslateBar — a repeat that refuses identically still shows it happened', () => {
  it('says nothing about attempts on the first refusal', () => {
    renderBar({
      state: makeState({ status: 'refused', refusal: 'provider_error', canRetry: true, attempts: 1 }),
    })
    expect(screen.queryByTestId('mail-translate-attempts')).not.toBeInTheDocument()
  })

  it('counts from the second attempt on, so an identical refusal is not an identical screen', () => {
    renderBar({
      state: makeState({ status: 'refused', refusal: 'provider_error', canRetry: true, attempts: 2 }),
    })
    expect(screen.getByTestId('mail-translate-attempts')).toHaveTextContent('Attempt 2.')
    cleanup()
    renderBar({
      state: makeState({ status: 'refused', refusal: 'provider_error', canRetry: true, attempts: 7 }),
    })
    expect(screen.getByTestId('mail-translate-attempts')).toHaveTextContent('Attempt 7.')
  })

  it('keeps the count with the refusal it belongs to, not on a ready translation', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation(),
        showingTranslation: true,
        attempts: 3,
      }),
    })
    expect(screen.queryByTestId('mail-translate-attempts')).not.toBeInTheDocument()
  })
})

describe('MailTranslateBar — the source picker offers a caption, it does not gate (§3.3.B6.f1)', () => {
  it('shows no source-language picker while neither door is open', () => {
    renderBar({
      state: makeState({
        status: 'refused',
        refusal: 'budget',
        needsLanguageChoice: false,
        sourceChoiceVisible: false,
      }),
    })
    expect(screen.queryByTestId('mail-translate-source-choice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-translate-source-restate')).not.toBeInTheDocument()
  })

  it('offers the picker UNDERNEATH a translation the reader can already see', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: null }),
        showingTranslation: true,
        needsLanguageChoice: true,
        sourceChoiceVisible: true,
      }),
    })
    // The whole point of the fix wave: the picker is an offer attached to a
    // finished translation, so the two-way toggle (and therefore the
    // translation itself) is on screen at the same time as the picker.
    expect(screen.getByTestId('mail-translate-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('mail-translate-notice')).toBeInTheDocument()
    expect(screen.getByTestId('mail-translate-source-choice')).toBeInTheDocument()
  })

  it('says in words that naming the language is optional and costs no new request', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        needsLanguageChoice: true,
        sourceChoiceVisible: true,
        sourceLang: null,
      }),
    })
    expect(screen.getByTestId('mail-translate-source-offer')).toHaveTextContent(
      i18nMap['mail.translate.sourceOffer'],
    )
  })

  it('renders no unprompted offer line when the caption is already known', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: 'de' }),
        showingTranslation: true,
        needsLanguageChoice: false,
        canRestateSourceLang: true,
        sourceChoiceVisible: false,
      }),
    })
    // The picker is reachable (see the correction-door suite below), but it
    // does not push itself at a reader who has no complaint about the label.
    expect(screen.queryByTestId('mail-translate-source-offer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-translate-source-choice')).not.toBeInTheDocument()
  })

  it('labels the picker button as a LABEL correction, never as "Translate"', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        needsLanguageChoice: true,
        sourceChoiceVisible: true,
        canApplySourceLang: true,
        sourceLang: 'ru',
      }),
    })
    const apply = screen.getByTestId('mail-translate-source-apply')
    expect(apply).toHaveTextContent('Update the label')
    // Reusing the first-attempt copy here is what made the offer read as a
    // gate ("translate again, this time properly"), so guard against it.
    expect(apply).not.toHaveTextContent('Translate')
  })

  it('keeps the button inert until a source language has been chosen', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        needsLanguageChoice: true,
        sourceChoiceVisible: true,
        canApplySourceLang: false,
        sourceLang: null,
      }),
    })
    expect(screen.getByTestId('mail-translate-source-apply')).toBeDisabled()
  })

  it('enables the button once a source language is set, and clicking it calls request()', () => {
    const { state } = renderBar({
      state: makeState({
        status: 'ready',
        needsLanguageChoice: true,
        sourceChoiceVisible: true,
        canApplySourceLang: true,
        sourceLang: 'ru',
      }),
    })
    const apply = screen.getByTestId('mail-translate-source-apply')
    expect(apply).not.toBeDisabled()
    fireEvent.click(apply)
    expect(state.request).toHaveBeenCalledTimes(1)
  })

  it('choosing a source language calls setSourceLang with the selected closed-set code', () => {
    const { state } = renderBar({
      state: makeState({
        status: 'ready',
        needsLanguageChoice: true,
        sourceChoiceVisible: true,
        sourceLang: null,
      }),
    })
    fireEvent.change(screen.getByTestId('mail-translate-source'), { target: { value: 'ja' } })
    expect(state.setSourceLang).toHaveBeenCalledWith('ja')
  })
})

describe('MailTranslateBar — a caption that IS there can still be corrected (§3.3.B6.f2)', () => {
  it('offers the correction next to the caption it would correct', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        // 'uk' over Russian mail: the confidently-wrong close relative that
        // makes this door necessary in the first place.
        translation: makeTranslation({ sourceLang: 'uk', targetLang: 'en' }),
        showingTranslation: true,
        canRestateSourceLang: true,
      }),
    })
    const notice = screen.getByTestId('mail-translate-notice')
    const restate = screen.getByTestId('mail-translate-source-restate')
    // Inside the notice, not floating elsewhere in the bar: the control has to
    // read as a disagreement with THAT sentence.
    expect(notice).toContainElement(restate)
    expect(restate).toHaveTextContent(i18nMap['mail.translate.sourceRestate'])
  })

  it('does not offer the correction while the reader is looking at the original', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: 'de' }),
        showingTranslation: false,
        // The hook already folds `showingTranslation` into this flag; the
        // component must not resurrect the control on its own.
        canRestateSourceLang: false,
      }),
    })
    expect(screen.queryByTestId('mail-translate-source-restate')).not.toBeInTheDocument()
  })

  it('the correction control is a disclosure — clicking it toggles, it never requests', () => {
    const { state } = renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: 'de' }),
        showingTranslation: true,
        canRestateSourceLang: true,
        sourceChoiceOpen: false,
      }),
    })
    const restate = screen.getByTestId('mail-translate-source-restate')
    expect(restate).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(restate)
    expect(state.toggleSourceChoice).toHaveBeenCalledTimes(1)
    // Nothing may reach a provider from a disclosure.
    expect(state.request).not.toHaveBeenCalled()
  })

  it('opens the SAME picker as the missing-caption door, with wording for this door', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: 'de' }),
        showingTranslation: true,
        canRestateSourceLang: true,
        sourceChoiceOpen: true,
        sourceChoiceVisible: true,
        needsLanguageChoice: false,
        sourceLang: 'de',
      }),
    })
    expect(screen.getByTestId('mail-translate-source-choice')).toBeInTheDocument()
    expect(screen.getByTestId('mail-translate-source-apply')).toHaveTextContent('Update the label')
    // The explanatory line is the "state it yourself" one, NOT the "we could
    // not identify it" one — that sentence would be false here.
    const offer = screen.getByTestId('mail-translate-source-offer')
    expect(offer).toHaveTextContent(i18nMap['mail.translate.sourceRestateHint'])
    expect(offer).not.toHaveTextContent('could not be identified')
    expect(screen.getByTestId('mail-translate-source-restate')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('keeps the translation and the two-way toggle on screen while correcting', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: 'de' }),
        showingTranslation: true,
        canRestateSourceLang: true,
        sourceChoiceOpen: true,
        sourceChoiceVisible: true,
      }),
    })
    // Correcting a label is not a modal question: what the reader came for
    // stays readable, and the original stays one click away.
    expect(screen.getByTestId('mail-translate-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('mail-translate-notice')).toBeInTheDocument()
  })

  it('leaves the apply button inert while the choice still equals the caption', () => {
    renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: 'de' }),
        showingTranslation: true,
        canRestateSourceLang: true,
        sourceChoiceOpen: true,
        sourceChoiceVisible: true,
        sourceLang: 'de',
        canApplySourceLang: false,
      }),
    })
    expect(screen.getByTestId('mail-translate-source-apply')).toBeDisabled()
  })

  it('applies a corrected language through the same request path', () => {
    const { state } = renderBar({
      state: makeState({
        status: 'ready',
        translation: makeTranslation({ sourceLang: 'de' }),
        showingTranslation: true,
        canRestateSourceLang: true,
        sourceChoiceOpen: true,
        sourceChoiceVisible: true,
        sourceLang: 'ru',
        canApplySourceLang: true,
      }),
    })
    const apply = screen.getByTestId('mail-translate-source-apply')
    expect(apply).not.toBeDisabled()
    fireEvent.click(apply)
    expect(state.request).toHaveBeenCalledTimes(1)
  })
})

describe('MailTranslateBar — target language select', () => {
  it('changing the target select calls setTargetLang with the closed-set code', () => {
    const { state } = renderBar({ state: makeState({ targetLang: 'en' }) })
    fireEvent.change(screen.getByTestId('mail-translate-target'), { target: { value: 'de' } })
    expect(state.setTargetLang).toHaveBeenCalledWith('de')
  })

  it('lists every accepted language code as an option, and nothing else', () => {
    renderBar()
    const select = screen.getByTestId('mail-translate-target') as HTMLSelectElement
    const values = Array.from(select.options).map(o => o.value)
    expect(values).toEqual([
      'en', 'ru', 'uk', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'tr', 'ar', 'zh', 'ja', 'ko', 'hi',
    ])
  })
})
