// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type {
  TranslateDraftRequest,
  TranslateDraftResult,
  TranslateLanguageCode,
} from '@mailcopilot/types'
import { useDraftTranslation } from './useDraftTranslation'

vi.mock('../sentry', () => ({ captureException: vi.fn() }))
import { captureException } from '../sentry'

type TranslateFn = (req: TranslateDraftRequest) => Promise<TranslateDraftResult>

function ok(translatedText: string, targetLang: TranslateLanguageCode = 'de'): TranslateDraftResult {
  return { ok: true, translation: { translatedText, targetLang, provider: 'anthropic-api' } }
}

function setup(
  translate: TranslateFn,
  overrides: {
    accountId?: number | null
    enabled?: boolean
    suggestedTargetLang?: TranslateLanguageCode | null
    composeGeneration?: number
  } = {},
) {
  const initial = {
    accountId: overrides.accountId === undefined ? 1 : overrides.accountId,
    enabled: overrides.enabled ?? true,
    suggestedTargetLang:
      overrides.suggestedTargetLang === undefined ? null : overrides.suggestedTargetLang,
    composeGeneration: overrides.composeGeneration ?? 0,
    translate,
  }
  return renderHook(props => useDraftTranslation(props), { initialProps: initial })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useDraftTranslation — target language priority rule (acceptance b)', () => {
  it('is empty, and the button inert, when there is neither a pick nor a suggestion', () => {
    const { result } = setup(vi.fn())
    expect(result.current.targetLang).toBeNull()
    expect(result.current.canRun).toBe(false)
  })

  it('falls back to the suggestion while no pick has been made', () => {
    const { result } = setup(vi.fn(), { suggestedTargetLang: 'de' })
    expect(result.current.targetLang).toBe('de')
    expect(result.current.canRun).toBe(true)
  })

  it("the user's pick beats the suggestion", () => {
    const { result } = setup(vi.fn(), { suggestedTargetLang: 'de' })
    act(() => result.current.setTargetLang('fr'))
    expect(result.current.targetLang).toBe('fr')
  })

  it('the suggestion never comes back after a pick, whatever else happens', () => {
    const translate = vi.fn(async () => ok('Bonjour'))
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.setTargetLang('fr'))

    // A fresh suggestion for the SAME draft, a re-render, a request and a
    // dismissal: none of them may resurrect it.
    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'it' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    expect(result.current.targetLang).toBe('fr')

    act(() => result.current.run('my own text'))
    act(() => result.current.dismiss())
    expect(result.current.targetLang).toBe('fr')
  })

  it('picking the same language twice is idempotent', () => {
    const { result } = setup(vi.fn())
    act(() => result.current.setTargetLang('es'))
    act(() => result.current.setTargetLang('es'))
    expect(result.current.targetLang).toBe('es')
  })
})

describe('useDraftTranslation — the memory belongs to the draft, not the window', () => {
  it('a new compose:init drops the pick and applies the new suggestion', () => {
    const translate = vi.fn()
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'es', composeGeneration: 0 })
    act(() => result.current.setTargetLang('es'))
    expect(result.current.targetLang).toBe('es')

    // The window was reused for a reply to somebody else: a remembered target
    // is a statement about the recipient of the PREVIOUS mail.
    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 1,
      translate,
    })
    expect(result.current.targetLang).toBe('de')
  })

  it('clears a produced translation when the draft changes', async () => {
    const translate = vi.fn(async () => ok('Hallo'))
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run('my own text'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: null,
      composeGeneration: 1,
      translate,
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
    expect(result.current.targetLang).toBeNull()
  })

  it('writes the pick nowhere but its own state — no settings, no IPC', () => {
    const invoke = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = { invoke }
    const { result } = setup(vi.fn())
    act(() => result.current.setTargetLang('ja'))
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('useDraftTranslation — nothing is ever automatic (acceptance c)', () => {
  it('does not translate on mount, with or without a suggestion', async () => {
    const translate = vi.fn(async () => ok('x'))
    setup(translate, { suggestedTargetLang: 'de' })
    await Promise.resolve()
    expect(translate).not.toHaveBeenCalled()
  })

  it('does not translate when the suggestion arrives late', async () => {
    const translate = vi.fn(async () => ok('x'))
    const { rerender } = setup(translate)
    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    await Promise.resolve()
    expect(translate).not.toHaveBeenCalled()
  })

  it('does not translate when the user changes the target', async () => {
    const translate = vi.fn(async () => ok('x'))
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.setTargetLang('fr'))
    await Promise.resolve()
    expect(translate).not.toHaveBeenCalled()
  })

  it('does not repeat itself after a translation was produced', async () => {
    const translate = vi.fn(async () => ok('Hallo'))
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run('my own text'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(translate).toHaveBeenCalledTimes(1)

    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('refuses to run at all without a target language', () => {
    const translate = vi.fn()
    const { result } = setup(translate)
    act(() => result.current.run('my own text'))
    expect(translate).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('refuses to run while the per-account opt-in is off', () => {
    const translate = vi.fn()
    const { result } = setup(translate, { enabled: false, suggestedTargetLang: 'de' })
    expect(result.current.active).toBe(false)
    act(() => result.current.run('my own text'))
    expect(translate).not.toHaveBeenCalled()
  })
})

describe('useDraftTranslation — what crosses the wire and what comes back (acceptance d)', () => {
  const QUOTED = 'My own reply.\n\nOn Monday, someone wrote:\n> the original message\n'

  it('sends only the own part of the draft, plus the target code', async () => {
    // Typed via `vi.fn<TranslateFn>` explicitly (not left to inference) so
    // `translate.mock.calls[0][0]` below has a real element type — a bare
    // `vi.fn(async () => ...)` infers a zero-parameter mock, which TS still
    // accepts as `setup`'s argument (fewer params is assignable) but leaves
    // `.mock.calls` untyped for args.
    const translate = vi.fn<TranslateFn>(async () => ok('Meine eigene Antwort.'))
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run(QUOTED))
    await waitFor(() => expect(translate).toHaveBeenCalled())

    const req = translate.mock.calls[0][0] as TranslateDraftRequest
    expect(req.accountId).toBe(1)
    expect(req.targetLang).toBe('de')
    expect(req.text).toContain('My own reply.')
    expect(req.text).not.toContain('> the original message')
    // Nothing else rides along — in particular no "this came from the
    // suggestion" flag, which would be an unverifiable renderer claim.
    expect(Object.keys(req).sort()).toEqual(['accountId', 'targetLang', 'text'])
  })

  it('builds the replacement with the quoted tail carried through byte-for-byte', async () => {
    const translate = vi.fn(async () => ok('Meine eigene Antwort.'))
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run(QUOTED))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    const preview = result.current.preview!
    expect(preview.rewritten).toBe('Meine eigene Antwort.')
    expect(preview.sourceBody).toBe(QUOTED)
    expect(preview.replacement).toContain('Meine eigene Antwort.')
    expect(preview.replacement).toContain('On Monday, someone wrote:\n> the original message\n')
    expect(preview.replacement).not.toContain('My own reply.')
  })

  it('preserves a signature verbatim in the replacement', async () => {
    const body = 'Hello there.\n\n--\nSergey\n'
    const translate = vi.fn(async () => ok('Hallo zusammen.'))
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run(body))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.preview!.replacement.endsWith('--\nSergey\n')).toBe(true)
  })
})

describe('useDraftTranslation — refusals (acceptance e)', () => {
  it('gates an empty draft locally, without an IPC call', () => {
    const translate = vi.fn()
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run('   \n  '))
    expect(translate).not.toHaveBeenCalled()
    expect(result.current.refusal).toBe('empty_input')
  })

  it('gates a draft with no own text locally, and says so specifically', () => {
    const translate = vi.fn()
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run('> only a quote\n> and nothing else\n'))
    expect(translate).not.toHaveBeenCalled()
    expect(result.current.refusal).toBe('no_own_text')
  })

  it.each(['budget', 'no_provider', 'provider_error', 'too_long', 'opt_out', 'no_own_text'] as const)(
    'surfaces the %s refusal from the wire unchanged',
    async reason => {
      const translate = vi.fn(async () => ({ ok: false as const, reason }))
      const { result } = setup(translate, { suggestedTargetLang: 'de' })
      act(() => result.current.run('my own text'))
      await waitFor(() => expect(result.current.status).toBe('refused'))
      expect(result.current.refusal).toBe(reason)
      expect(result.current.preview).toBeNull()
    },
  )

  it('degrades an unexpected transport throw to provider_error and reports it', async () => {
    const translate = vi.fn(async () => { throw new Error('bridge gone') })
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run('my own text'))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.refusal).toBe('provider_error')
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: 'useDraftTranslation.run',
    })
  })
})

describe('useDraftTranslation — a late answer never lands under a new question', () => {
  it('drops a response superseded by a target change', async () => {
    let release: ((r: TranslateDraftResult) => void) | null = null
    const translate = vi.fn(() => new Promise<TranslateDraftResult>(res => { release = res }))
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run('my own text'))
    act(() => result.current.setTargetLang('fr'))
    await act(async () => { release!(ok('Hallo')) })
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
  })

  it('drops a response superseded by a dismissal', async () => {
    let release: ((r: TranslateDraftResult) => void) | null = null
    const translate = vi.fn(() => new Promise<TranslateDraftResult>(res => { release = res }))
    const { result } = setup(translate, { suggestedTargetLang: 'de' })
    act(() => result.current.run('my own text'))
    act(() => result.current.dismiss())
    await act(async () => { release!(ok('Hallo')) })
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f-renderer — what the reset key is, and what it deliberately is not.
//
// The reset was previously keyed on `draftKey` (the draft's STORAGE id) plus
// `enabled`. Both were wrong in a way that cost the user work or money:
//   - the storage id resolves asynchronously, long after the toolbar becomes
//     interactive, so the `'' → real id` transition wiped a pick and a paid
//     request made in that window;
//   - `enabled` is a per-account permission, not a draft identity, so flipping
//     it (or switching sender account) erased the pick and let the suggestion
//     come back — the exact opposite of "the pick wins irreversibly within this
//     draft".
// ---------------------------------------------------------------------------
describe('useDraftTranslation — the reset key is the compose generation and nothing else', () => {
  it('keeps the pick and lands the answer while the rest of the init is still settling', async () => {
    // The reviewer's timeline: `accountId` is already known (the control is
    // rendered and clickable) but the window is still resolving its mailbox,
    // folder roles and draft id. The user picks a language and pays for a
    // translation right there. Everything that arrives afterwards must be
    // irrelevant to this hook.
    let release: ((r: TranslateDraftResult) => void) | null = null
    const translate = vi.fn<TranslateFn>(() => new Promise<TranslateDraftResult>(res => { release = res }))
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })

    act(() => result.current.setTargetLang('fr'))
    act(() => result.current.run('my own text'))
    expect(result.current.status).toBe('loading')

    // Late arrivals of the init sequence, all under the SAME generation: a
    // suggestion that only now reaches the window, and any number of unrelated
    // re-renders. Under the old `draftKey` shape this is where the freshly
    // resolved storage id landed and threw the pick and the request away.
    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'it' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'it' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })

    expect(result.current.targetLang).toBe('fr')
    expect(result.current.status).toBe('loading')

    await act(async () => { release!(ok('Ma propre réponse.', 'fr')) })
    expect(result.current.status).toBe('ready')
    expect(result.current.preview!.rewritten).toBe('Ma propre réponse.')
    expect(result.current.targetLang).toBe('fr')
  })

  it('keeps the pick when the per-account opt-in flips off and back on inside one draft', () => {
    const translate = vi.fn()
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })
    act(() => result.current.setTargetLang('fr'))

    const at = (enabled: boolean) => ({
      accountId: 1,
      enabled,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    rerender(at(false))
    expect(result.current.active).toBe(false)
    rerender(at(true))

    // Same draft throughout: the suggestion must NOT be back.
    expect(result.current.targetLang).toBe('fr')
    expect(result.current.active).toBe(true)
  })

  it('keeps the pick when the sender account changes inside one draft', () => {
    const translate = vi.fn()
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })
    act(() => result.current.setTargetLang('fr'))

    rerender({
      accountId: 2,
      enabled: true,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    expect(result.current.targetLang).toBe('fr')
  })

  it('still drops an in-flight answer when the sender account changes', async () => {
    // The pick survives a mailbox switch; an ANSWER produced for the previous
    // account does not — it was paid for and gated under a different account.
    let release: ((r: TranslateDraftResult) => void) | null = null
    const translate = vi.fn<TranslateFn>(() => new Promise<TranslateDraftResult>(res => { release = res }))
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })
    act(() => result.current.run('my own text'))

    rerender({
      accountId: 2,
      enabled: true,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    await act(async () => { release!(ok('Hallo')) })
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
    // ...and the pick-versus-suggestion rule is untouched by that invalidation.
    expect(result.current.targetLang).toBe('de')
  })

  it('still drops an in-flight answer when the per-account opt-in goes off', async () => {
    let release: ((r: TranslateDraftResult) => void) | null = null
    const translate = vi.fn<TranslateFn>(() => new Promise<TranslateDraftResult>(res => { release = res }))
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })
    act(() => result.current.run('my own text'))

    rerender({
      accountId: 1,
      enabled: false,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    await act(async () => { release!(ok('Hallo')) })
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
  })

  it('drops the pick only on a generation bump, however many times it advances', () => {
    const translate = vi.fn()
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })
    act(() => result.current.setTargetLang('fr'))

    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'es' as TranslateLanguageCode,
      composeGeneration: 1,
      translate,
    })
    expect(result.current.targetLang).toBe('es')

    act(() => result.current.setTargetLang('ja'))
    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: null,
      composeGeneration: 2,
      translate,
    })
    expect(result.current.targetLang).toBeNull()
    expect(result.current.canRun).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f3 — occupancy is a fact about the request, not about the intent.
//
// `setTargetLang` invalidates the ANSWER and returns the status to `idle`; it
// cannot recall the call already on the wire. While occupancy was read off the
// status, re-aiming mid-flight declared the draft free — and the toolbar let
// the rewrite, the corrector and a second translation start over a request the
// user was still paying for.
// ---------------------------------------------------------------------------
describe('useDraftTranslation — busy tracks the call, not the intent', () => {
  function deferred() {
    let release: ((r: TranslateDraftResult) => void) | null = null
    const translate = vi.fn<TranslateFn>(() => new Promise<TranslateDraftResult>(res => { release = res }))
    return { translate, release: (r: TranslateDraftResult) => release!(r) }
  }

  it('is false before anything is asked for', () => {
    const { result } = setup(vi.fn(), { suggestedTargetLang: 'de' })
    expect(result.current.busy).toBe(false)
  })

  it('stays true when the target language changes mid-flight, though the status goes idle', async () => {
    const { translate, release } = deferred()
    const { result } = setup(translate, { suggestedTargetLang: 'de' })

    act(() => result.current.run('my own text'))
    expect(result.current.busy).toBe(true)
    expect(result.current.status).toBe('loading')

    act(() => result.current.setTargetLang('fr'))
    // The answer is disowned...
    expect(result.current.status).toBe('idle')
    // ...but the request is not, and neither is its price.
    expect(result.current.busy).toBe(true)

    await act(async () => { release(ok('Hallo')) })
    expect(result.current.busy).toBe(false)
    // The disowned answer still never lands.
    expect(result.current.status).toBe('idle')
    expect(result.current.preview).toBeNull()
  })

  it('refuses to start a second paid call while the first is on the wire', async () => {
    const { translate, release } = deferred()
    const { result } = setup(translate, { suggestedTargetLang: 'de' })

    act(() => result.current.run('my own text'))
    act(() => result.current.setTargetLang('fr'))
    act(() => result.current.run('my own text'))
    expect(translate).toHaveBeenCalledTimes(1)

    // Once it settles, the same click works — this is a hold, not a lockout.
    await act(async () => { release(ok('Hallo')) })
    expect(result.current.busy).toBe(false)
    act(() => result.current.run('my own text'))
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('stays true across a dismissal until the call actually settles', async () => {
    const { translate, release } = deferred()
    const { result } = setup(translate, { suggestedTargetLang: 'de' })

    act(() => result.current.run('my own text'))
    act(() => result.current.dismiss())
    expect(result.current.status).toBe('idle')
    expect(result.current.busy).toBe(true)

    await act(async () => { release(ok('Hallo')) })
    expect(result.current.busy).toBe(false)
  })

  it('is cleared by a refusal and by a transport throw, not only by a translation', async () => {
    const refusing = vi.fn<TranslateFn>(async () => ({ ok: false as const, reason: 'budget' as const }))
    const { result } = setup(refusing, { suggestedTargetLang: 'de' })
    act(() => result.current.run('my own text'))
    await waitFor(() => expect(result.current.status).toBe('refused'))
    expect(result.current.busy).toBe(false)

    const throwing = vi.fn<TranslateFn>(async () => { throw new Error('bridge gone') })
    const second = setup(throwing, { suggestedTargetLang: 'de' })
    act(() => second.result.current.run('my own text'))
    await waitFor(() => expect(second.result.current.status).toBe('refused'))
    expect(second.result.current.busy).toBe(false)
  })

  it('is released by a generation bump even when the provider never answers', () => {
    // The bar must not stay held for the NEXT message by a call abandoned with
    // the previous one — the same reason the hung-provider reset exists.
    const translate = vi.fn<TranslateFn>(() => new Promise<TranslateDraftResult>(() => {}))
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })
    act(() => result.current.run('my own text'))
    expect(result.current.busy).toBe(true)

    rerender({
      accountId: 1,
      enabled: true,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 1,
      translate,
    })
    expect(result.current.busy).toBe(false)
    // ...and the freed hook really works again.
    act(() => result.current.run('my own text'))
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('is released when the sender account changes, and a later settle cannot re-hold it', async () => {
    const { translate, release } = deferred()
    const { result, rerender } = setup(translate, { suggestedTargetLang: 'de', composeGeneration: 0 })
    act(() => result.current.run('my own text'))

    rerender({
      accountId: 2,
      enabled: true,
      suggestedTargetLang: 'de' as TranslateLanguageCode,
      composeGeneration: 0,
      translate,
    })
    expect(result.current.busy).toBe(false)

    await act(async () => { release(ok('Hallo')) })
    expect(result.current.busy).toBe(false)
    expect(result.current.status).toBe('idle')
  })
})
