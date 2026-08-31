// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type {
  TranslateMessageRequest,
  TranslateMessageResult,
  TranslatedMessage,
} from '@mailcopilot/types'
import {
  useMailTranslation,
  translateLanguageFromUiLocale,
  type MailTranslationTarget,
} from './useMailTranslation'

vi.mock('../sentry', () => ({
  captureException: vi.fn(),
}))
import { captureException } from '../sentry'

type TranslateFn = (req: TranslateMessageRequest) => Promise<TranslateMessageResult>

function makeTranslation(overrides: Partial<TranslatedMessage> = {}): TranslatedMessage {
  return {
    translatedText: 'Hello there.',
    sourceLang: 'de',
    targetLang: 'en',
    provider: 'anthropic-api',
    cached: false,
    sourceIsTextProjection: true,
    ...overrides,
  }
}

const MESSAGE: MailTranslationTarget = { accountId: 1, folder: 'INBOX', uid: 42 }

function setup(
  translate: TranslateFn,
  overrides: {
    message?: MailTranslationTarget | null
    enabled?: boolean
    uiLocale?: string
  } = {},
) {
  const initial = {
    message: overrides.message === undefined ? MESSAGE : overrides.message,
    enabled: overrides.enabled ?? true,
    uiLocale: overrides.uiLocale ?? 'en',
    translate,
  }
  return renderHook(props => useMailTranslation(props), { initialProps: initial })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('translateLanguageFromUiLocale', () => {
  it('maps a bare interface locale to its language code', () => {
    expect(translateLanguageFromUiLocale('ru')).toBe('ru')
    expect(translateLanguageFromUiLocale('it')).toBe('it')
  })

  it('maps a region-qualified locale by its base subtag', () => {
    expect(translateLanguageFromUiLocale('pt-BR')).toBe('pt')
    expect(translateLanguageFromUiLocale('DE-at')).toBe('de')
  })

  it('falls back to English for a locale outside the closed set', () => {
    expect(translateLanguageFromUiLocale('cs')).toBe('en')
    expect(translateLanguageFromUiLocale('')).toBe('en')
  })
})

describe('useMailTranslation — the feature never runs on its own', () => {
  it('calls no provider on mount, and none when the message changes', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate)

    // Mount, a re-render, and a message switch: still nothing.
    view.rerender({ message: MESSAGE, enabled: true, uiLocale: 'en', translate })
    view.rerender({
      message: { accountId: 1, folder: 'INBOX', uid: 43 },
      enabled: true,
      uiLocale: 'en',
      translate,
    })
    await Promise.resolve()

    expect(translate).not.toHaveBeenCalled()
    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.showingTranslation).toBe(false)
  })

  it('is inert when the per-account opt-in is off — no bar, and a click cannot reach IPC', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate, { enabled: false })

    expect(view.result.current.active).toBe(false)
    act(() => view.result.current.request())
    await Promise.resolve()
    expect(translate).not.toHaveBeenCalled()
  })

  it('is inert with no open message', () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate, { message: null })
    expect(view.result.current.active).toBe(false)
    act(() => view.result.current.request())
    expect(translate).not.toHaveBeenCalled()
  })
})

describe('useMailTranslation — the request carries a ref and a code, never text', () => {
  it('sends exactly (accountId, folder, uid, targetLang) and no other field', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate, { uiLocale: 'ru' })

    act(() => view.result.current.request())
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1))

    const req = translate.mock.calls[0][0]
    expect(req).toEqual({ accountId: 1, folder: 'INBOX', uid: 42, targetLang: 'ru' })
    // No source language was stated, so the optional field is absent — not
    // present-and-null, which main would have to interpret.
    expect('sourceLang' in req).toBe(false)
  })

  it('seeds the target language from the interface locale', () => {
    const translate = vi.fn<TranslateFn>(async () => ({ ok: false, reason: 'budget' }))
    const view = setup(translate, { uiLocale: 'fr-CA' })
    expect(view.result.current.targetLang).toBe('fr')
  })

  it('sends the user-stated source language once it has been chosen', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate)

    act(() => view.result.current.setSourceLang('pl'))
    act(() => view.result.current.request())
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1))

    expect(translate.mock.calls[0][0].sourceLang).toBe('pl')
  })
})

describe('useMailTranslation — original / translation switch', () => {
  it('shows the translation after a successful request and returns to the original in one call', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation({ translatedText: 'Guten Tag → Good day' }),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    expect(view.result.current.showingTranslation).toBe(true)
    expect(view.result.current.translation?.translatedText).toBe('Guten Tag → Good day')

    act(() => view.result.current.showOriginal())
    expect(view.result.current.showingTranslation).toBe(false)
    // Going back must not re-request: the original is a display swap.
    expect(translate).toHaveBeenCalledTimes(1)

    act(() => view.result.current.showTranslation())
    expect(view.result.current.showingTranslation).toBe(true)
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('resets to the original when the open message changes — the switch never sticks', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.showingTranslation).toBe(true))

    view.rerender({
      message: { accountId: 1, folder: 'INBOX', uid: 43 },
      enabled: true,
      uiLocale: 'en',
      translate,
    })

    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.translation).toBeNull()
    expect(view.result.current.showingTranslation).toBe(false)
  })

  it('separates two messages whose fields concatenate to the same string', async () => {
    // Guards the reset key's separator. `INBOX` + 42 and `INBOX4` + 2 are two
    // different messages that collapse to one key the moment the \u0000 frame is
    // lost — which is what an editor silently eating a raw NUL byte would do.
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate, { message: { accountId: 1, folder: 'INBOX', uid: 42 } })

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.showingTranslation).toBe(true))

    view.rerender({
      message: { accountId: 1, folder: 'INBOX4', uid: 2 },
      enabled: true,
      uiLocale: 'en',
      translate,
    })

    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.translation).toBeNull()
    expect(view.result.current.showingTranslation).toBe(false)
  })

  it('keeps the translation across a re-render that rebuilds an equal message object', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.showingTranslation).toBe(true))

    // A NEW object with the same identity — the everyday App.tsx re-render.
    view.rerender({
      message: { accountId: 1, folder: 'INBOX', uid: 42 },
      enabled: true,
      uiLocale: 'en',
      translate,
    })

    expect(view.result.current.showingTranslation).toBe(true)
  })

  it('discards a result produced for another target language when the target changes', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))

    act(() => view.result.current.setTargetLang('ja'))
    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.translation).toBeNull()
    expect(view.result.current.showingTranslation).toBe(false)
    expect(view.result.current.targetLang).toBe('ja')
  })

  it('re-selecting the same target keeps the translation on screen', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))

    act(() => view.result.current.setTargetLang('en'))
    expect(view.result.current.status).toBe('ready')
    expect(view.result.current.showingTranslation).toBe(true)
  })
})

describe('useMailTranslation — refusals are values, never crashes', () => {
  const reasons = [
    'budget',
    'no_provider',
    'provider_error',
    'empty_input',
    'too_long',
    'opt_out',
  ] as const

  for (const reason of reasons) {
    it(`surfaces '${reason}' as structured state and keeps the original on screen`, async () => {
      const translate = vi.fn<TranslateFn>(async () => ({ ok: false, reason }))
      const view = setup(translate)

      act(() => view.result.current.request())
      await waitFor(() => expect(view.result.current.status).toBe('refused'))

      expect(view.result.current.refusal).toBe(reason)
      expect(view.result.current.translation).toBeNull()
      expect(view.result.current.showingTranslation).toBe(false)
      // A refusal never offers the language picker: since §3.3.B6.f1 the picker
      // captions a translation that EXISTS, and a refusal produced none.
      expect(view.result.current.needsLanguageChoice).toBe(false)
    })
  }

  it('degrades an unexpected transport throw to provider_error and reports it', async () => {
    const translate = vi.fn<TranslateFn>(async () => {
      throw new Error('bridge is gone')
    })
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('refused'))

    expect(view.result.current.refusal).toBe('provider_error')
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: 'useMailTranslation.request',
    })
  })

  it('clears a previous refusal when a new request starts', async () => {
    let next: TranslateMessageResult = { ok: false, reason: 'provider_error' }
    const translate = vi.fn<TranslateFn>(async () => next)
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.refusal).toBe('provider_error'))

    next = { ok: true, translation: makeTranslation() }
    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))

    expect(view.result.current.refusal).toBeNull()
  })
})

describe('useMailTranslation — the language picker is an OFFER, not a gate (§3.3.B6.f1)', () => {
  it('offers the picker when a translation came back with no caption', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: { ...makeTranslation(), sourceLang: null },
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))

    // The translation is already on screen — the picker only offers to label it.
    expect(view.result.current.showingTranslation).toBe(true)
    expect(view.result.current.needsLanguageChoice).toBe(true)
  })

  it('does not offer the picker when the caption is already there', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: { ...makeTranslation(), sourceLang: 'de' },
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))

    expect(view.result.current.needsLanguageChoice).toBe(false)
  })

  it("re-requests with the user's stated source language once they answer", async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: { ...makeTranslation(), sourceLang: null },
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.needsLanguageChoice).toBe(true))

    act(() => view.result.current.setSourceLang('ru'))
    act(() => view.result.current.request())
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(2))

    expect(translate.mock.calls[0][0].sourceLang).toBeUndefined()
    expect(translate.mock.calls[1][0].sourceLang).toBe('ru')
  })
})

describe('useMailTranslation — a WRONG caption is correctable too (§3.3.B6.f2)', () => {
  // The requirement this suite exists for: local detection fails CONFIDENTLY on
  // close relatives, so "the label is present" does not mean "the label is
  // right". A picker offered only when the label is MISSING leaves exactly the
  // measured failure mode with no ordinary way out.
  const captioned = (sourceLang: 'uk' | 'ru') => ({
    ok: true as const,
    translation: makeTranslation({ sourceLang, translatedText: 'Hello there.' }),
  })

  it('offers the correction on a confidently captioned translation', async () => {
    const translate = vi.fn<TranslateFn>(async () => captioned('uk'))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))

    // No unprompted picker — the caption is there, we are not nagging.
    expect(view.result.current.needsLanguageChoice).toBe(false)
    expect(view.result.current.sourceChoiceVisible).toBe(false)
    // …but the door exists.
    expect(view.result.current.canRestateSourceLang).toBe(true)
  })

  it('lets the reader replace a wrong-but-confident caption, served from cache', async () => {
    // Main resolves the label from `req.sourceLang` when it is given, and the
    // translation cache is keyed on the hash of the SOURCE TEXT — so the same
    // text comes back with the user's label and no provider call. The fake
    // mirrors that: the second answer is `cached: true`.
    const translate = vi.fn<TranslateFn>(async req => ({
      ok: true,
      translation: makeTranslation({
        sourceLang: req.sourceLang ?? 'uk',
        cached: req.sourceLang !== undefined,
      }),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    expect(view.result.current.translation?.sourceLang).toBe('uk')

    // The reader disagrees: it is Russian, not Ukrainian.
    act(() => view.result.current.toggleSourceChoice())
    expect(view.result.current.sourceChoiceVisible).toBe(true)
    act(() => view.result.current.setSourceLang('ru'))
    expect(view.result.current.canApplySourceLang).toBe(true)
    act(() => view.result.current.request())
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(2))

    expect(translate.mock.calls[0][0].sourceLang).toBeUndefined()
    expect(translate.mock.calls[1][0].sourceLang).toBe('ru')
    await waitFor(() => expect(view.result.current.translation?.sourceLang).toBe('ru'))
    // Nothing was paid for: the answer came out of the local cache.
    expect(view.result.current.translation?.cached).toBe(true)
  })

  it('seeds the picker with the caption on screen, so applying it is inert', async () => {
    const translate = vi.fn<TranslateFn>(async () => captioned('uk'))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    act(() => view.result.current.toggleSourceChoice())

    // Opened at what we currently claim — the reader corrects a statement
    // rather than answering a blank question.
    expect(view.result.current.sourceLang).toBe('uk')
    // …and "Update the label" to the label it already says would do nothing, so
    // it must not look available.
    expect(view.result.current.canApplySourceLang).toBe(false)
  })

  it('collapses the correction once the new caption has landed', async () => {
    const translate = vi.fn<TranslateFn>(async req => ({
      ok: true,
      translation: makeTranslation({ sourceLang: req.sourceLang ?? 'uk' }),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    act(() => view.result.current.toggleSourceChoice())
    act(() => view.result.current.setSourceLang('ru'))
    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.translation?.sourceLang).toBe('ru'))

    // An open picker whose button is inert is a control with nothing left to
    // do; the caption it existed to fix is now the caption the reader asked for.
    expect(view.result.current.sourceChoiceOpen).toBe(false)
    expect(view.result.current.sourceChoiceVisible).toBe(false)
    expect(view.result.current.canRestateSourceLang).toBe(true)
  })

  it('is a toggle, not a one-way door — a reader who opened it can put it away', async () => {
    const translate = vi.fn<TranslateFn>(async () => captioned('uk'))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))

    act(() => view.result.current.toggleSourceChoice())
    expect(view.result.current.sourceChoiceVisible).toBe(true)
    act(() => view.result.current.toggleSourceChoice())
    expect(view.result.current.sourceChoiceVisible).toBe(false)
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('never offers both doors at once', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation({ sourceLang: null }),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.needsLanguageChoice).toBe(true))

    // Caption missing: the unprompted offer is up, the correction door is not —
    // there is no caption to disagree with.
    expect(view.result.current.canRestateSourceLang).toBe(false)
    expect(view.result.current.sourceChoiceVisible).toBe(true)
  })

  it('does not offer the correction while the reader is on the original', async () => {
    const translate = vi.fn<TranslateFn>(async () => captioned('uk'))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.canRestateSourceLang).toBe(true))

    // The control corrects a CAPTION, and the caption is only on screen next to
    // the translation.
    act(() => view.result.current.showOriginal())
    expect(view.result.current.canRestateSourceLang).toBe(false)
  })

  it('keeps an already-open picker across a look at the original', async () => {
    const translate = vi.fn<TranslateFn>(async () => captioned('uk'))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    act(() => view.result.current.toggleSourceChoice())

    // Comparing against the original is exactly how a reader decides what the
    // language really is, so the toggle must not throw their answer away.
    act(() => view.result.current.showOriginal())
    expect(view.result.current.sourceChoiceVisible).toBe(true)
    act(() => view.result.current.setSourceLang('ru'))
    expect(view.result.current.canApplySourceLang).toBe(true)
  })

  it('closes the correction when the target language changes', async () => {
    const translate = vi.fn<TranslateFn>(async () => captioned('uk'))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    act(() => view.result.current.toggleSourceChoice())
    expect(view.result.current.sourceChoiceVisible).toBe(true)

    // The result the picker was captioning has just been dropped.
    act(() => view.result.current.setTargetLang('ja'))
    expect(view.result.current.sourceChoiceOpen).toBe(false)
    expect(view.result.current.sourceChoiceVisible).toBe(false)
    expect(view.result.current.canRestateSourceLang).toBe(false)
  })

  it('closes the correction when the message changes', async () => {
    const translate = vi.fn<TranslateFn>(async () => captioned('uk'))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    act(() => view.result.current.toggleSourceChoice())

    view.rerender({
      message: { accountId: 1, folder: 'INBOX', uid: 77 },
      enabled: true,
      uiLocale: 'en',
      translate,
    })

    expect(view.result.current.sourceChoiceOpen).toBe(false)
    expect(view.result.current.sourceChoiceVisible).toBe(false)
    expect(view.result.current.sourceLang).toBeNull()
  })

  it('closes the correction when the re-request is refused', async () => {
    let next: TranslateMessageResult = captioned('uk')
    const translate = vi.fn<TranslateFn>(async () => next)
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('ready'))
    act(() => view.result.current.toggleSourceChoice())
    act(() => view.result.current.setSourceLang('ru'))

    next = { ok: false, reason: 'budget' }
    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.status).toBe('refused'))

    // There is no translation left to caption, so nothing may still be asking
    // about its language.
    expect(view.result.current.sourceChoiceVisible).toBe(false)
    expect(view.result.current.canApplySourceLang).toBe(false)
    expect(view.result.current.canRestateSourceLang).toBe(false)
  })

  it('shows no picker on a stale open flag with no ready translation', async () => {
    let release: (r: TranslateMessageResult) => void = () => {}
    const translate = vi.fn<TranslateFn>(
      () => new Promise<TranslateMessageResult>(resolve => { release = resolve }),
    )
    const view = setup(translate)

    act(() => view.result.current.request())
    await act(async () => {
      release(captioned('uk'))
      await Promise.resolve()
    })
    act(() => view.result.current.toggleSourceChoice())
    expect(view.result.current.sourceChoiceVisible).toBe(true)

    // A second request is in flight: status is no longer 'ready', so the picker
    // must not hang over a result that is being replaced.
    act(() => view.result.current.request())
    expect(view.result.current.status).toBe('loading')
    expect(view.result.current.sourceChoiceVisible).toBe(false)
    expect(view.result.current.canApplySourceLang).toBe(false)
  })
})

describe('useMailTranslation — a late response never lands on the wrong message', () => {
  it('drops a response that resolves after the message changed', async () => {
    let release: (r: TranslateMessageResult) => void = () => {}
    const translate = vi.fn<TranslateFn>(
      () => new Promise<TranslateMessageResult>(resolve => { release = resolve }),
    )
    const view = setup(translate)

    act(() => view.result.current.request())
    expect(view.result.current.status).toBe('loading')

    view.rerender({
      message: { accountId: 1, folder: 'INBOX', uid: 99 },
      enabled: true,
      uiLocale: 'en',
      translate,
    })

    await act(async () => {
      release({ ok: true, translation: makeTranslation({ translatedText: 'stale' }) })
      await Promise.resolve()
    })

    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.translation).toBeNull()
  })

  it('keeps only the newest of two overlapping requests', async () => {
    const pending: Array<(r: TranslateMessageResult) => void> = []
    const translate = vi.fn<TranslateFn>(
      () => new Promise<TranslateMessageResult>(resolve => { pending.push(resolve) }),
    )
    const view = setup(translate)

    act(() => view.result.current.request())
    act(() => view.result.current.request())
    expect(pending).toHaveLength(2)

    await act(async () => {
      // The FIRST resolves last — the classic out-of-order response.
      pending[1]({ ok: true, translation: makeTranslation({ translatedText: 'second' }) })
      pending[0]({ ok: true, translation: makeTranslation({ translatedText: 'first' }) })
      await Promise.resolve()
    })

    expect(view.result.current.translation?.translatedText).toBe('second')
  })
})

describe('useMailTranslation — invalidation is complete, not just visible', () => {
  it('drops a response for the OLD target language when the target changes mid-flight', async () => {
    let release: (r: TranslateMessageResult) => void = () => {}
    const translate = vi.fn<TranslateFn>(
      () => new Promise<TranslateMessageResult>(resolve => { release = resolve }),
    )
    const view = setup(translate, { uiLocale: 'en' })

    act(() => view.result.current.request())
    expect(view.result.current.status).toBe('loading')

    // The user changes their mind while the English translation is still in
    // flight, and then does nothing at all — no second request to bump a token.
    act(() => view.result.current.setTargetLang('ja'))
    expect(view.result.current.status).toBe('idle')

    await act(async () => {
      release({
        ok: true,
        translation: makeTranslation({ targetLang: 'en', translatedText: 'English result' }),
      })
      await Promise.resolve()
    })

    // Without the token bump this English text would be sitting under a
    // "Japanese" selection, captioned as a translation the user never got.
    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.translation).toBeNull()
    expect(view.result.current.showingTranslation).toBe(false)
    expect(view.result.current.targetLang).toBe('ja')
  })

  it('puts the reading pane back on the original when the per-account opt-in is switched off', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: makeTranslation(),
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.showingTranslation).toBe(true))

    // Settings → AI → Translate messages, off. The bar disappears with
    // `active`, so whatever the body area is showing has to stop being the
    // translation — there would be no control left to switch back with.
    view.rerender({ message: MESSAGE, enabled: false, uiLocale: 'en', translate })

    expect(view.result.current.active).toBe(false)
    expect(view.result.current.showingTranslation).toBe(false)
    expect(view.result.current.translation).toBeNull()
    expect(view.result.current.status).toBe('idle')
  })

  it('drops a response that arrives after the opt-in was switched off', async () => {
    let release: (r: TranslateMessageResult) => void = () => {}
    const translate = vi.fn<TranslateFn>(
      () => new Promise<TranslateMessageResult>(resolve => { release = resolve }),
    )
    const view = setup(translate)

    act(() => view.result.current.request())
    view.rerender({ message: MESSAGE, enabled: false, uiLocale: 'en', translate })

    await act(async () => {
      release({ ok: true, translation: makeTranslation() })
      await Promise.resolve()
    })

    // Turning the feature off must not be undone a second later by a promise
    // that was already on its way.
    expect(view.result.current.translation).toBeNull()
    expect(view.result.current.showingTranslation).toBe(false)
  })

  it('forgets a stated source language when the feature is switched off and on again', async () => {
    const translate = vi.fn<TranslateFn>(async () => ({
      ok: true,
      translation: { ...makeTranslation(), sourceLang: null },
    }))
    const view = setup(translate)

    act(() => view.result.current.request())
    await waitFor(() => expect(view.result.current.needsLanguageChoice).toBe(true))
    act(() => view.result.current.setSourceLang('pl'))
    expect(view.result.current.sourceLang).toBe('pl')

    view.rerender({ message: MESSAGE, enabled: false, uiLocale: 'en', translate })
    view.rerender({ message: MESSAGE, enabled: true, uiLocale: 'en', translate })

    expect(view.result.current.sourceLang).toBeNull()
    expect(view.result.current.needsLanguageChoice).toBe(false)
  })
})
