// @vitest-environment jsdom
/**
 * BACKLOG §2.167 — the settings window and a save that lost one FIELD.
 *
 * `settings:save` refuses `mcpExportWhitelist` on its own when the array
 * carries a tool name outside the export ceiling: the save proceeds, every
 * other edit lands, the persisted whitelist is left as it was, and the reply
 * carries `{ ok: true, refused: [{ field, code, values }] }` — `values` being
 * the submitted entries main rejected.
 *
 * Three things had to be true for that to be usable from here:
 *   1. the refusal is SHOWN. The window's only "saved" signal is that it
 *      closes, so a refusal that closes the window is a silent partial save;
 *   2. the window repairs its state from `values` — removing exactly what main
 *      named — so the next save carries a list main will accept. Without that,
 *      one stale name is re-submitted and refused on every save from here on,
 *      taking every later edit of that field with it;
 *   3. it never second-guesses the domain locally. A name main accepts is sent
 *      verbatim, whatever this build thinks of it.
 *
 * What main decides is electron/settingsSaveRefusal.test.ts; this is what the
 * window does with the reply and with its own state.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Keys, not sentences — except that interpolated values ARE the payload under
// test here (the notice has to name the tool it dropped), so they are appended.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts ? `${key} ${Object.values(opts).join(' ')}` : key),
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}))
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn(), language: 'en' },
  SUPPORTED_LANGUAGES: ['en', 'ru', 'fr', 'de', 'es', 'it'],
  DEFAULT_LANGUAGE: 'en',
}))
vi.mock('../sentry', () => ({ sendFeedback: vi.fn(), captureException: vi.fn() }))

import Settings from './Settings'

type SaveReply = Record<string, unknown> | undefined
/** A fixed reply, or one that depends on the payload — as main's does. */
type SaveResponder = SaveReply | ((payload: Record<string, unknown>) => SaveReply)

const ACCOUNT = {
  id: 1,
  name: 'Test',
  email: 'user@example.com',
  imap: { host: 'imap.example.com', port: 993, user: 'user@example.com', secure: true },
  smtp: { host: 'smtp.example.com', port: 465, user: 'user@example.com', secure: true },
}

let invoke: ReturnType<typeof vi.fn>
let closeSpy: ReturnType<typeof vi.spyOn>

function installApi(saveReply: SaveResponder, whitelist?: unknown): void {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'settings:get': return {
        theme: 'light',
        language: 'en',
        bodyRetentionDays: 365,
        mcpExportEnabled: true,
        mcpExportPort: 23847,
        ...(whitelist === undefined ? {} : { mcpExportWhitelist: whitelist }),
      }
      case 'settings:save': return typeof saveReply === 'function'
        ? saveReply(args[0] as Record<string, unknown>)
        : saveReply
      case 'accounts:list': return [ACCOUNT]
      case 'accounts:get': return ACCOUNT
      case 'accounts:getCurrent': return 1
      case 'mcpExport:status': return { status: 'stopped' }
      case 'mcp:status': return {}
      case 'tls:listPins': return []
      case 'rules:list': return []
      case 'aiRules:list': return []
      case 'templates:list': return []
      case 'ai:memoryRead': return ''
      default: return undefined
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(), off: vi.fn(), initialTheme: 'light', installIdHash: '', sentryEnabled: false },
  })
}

/** Mount, wait for the initial load, and press Save. */
async function mountAndSave(saveReply: SaveResponder, whitelist?: unknown): Promise<void> {
  installApi(saveReply, whitelist)
  render(<Settings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
  fireEvent.click(screen.getByTestId('settings-save'))
  await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'settings:save')).toBe(true))
}

/** Payloads of every `settings:save` the window issued, in order. */
function savePayloads(): Record<string, unknown>[] {
  return invoke.mock.calls
    .filter(([channel]) => channel === 'settings:save')
    .map(([, payload]) => payload as Record<string, unknown>)
}

/**
 * Whether a payload CARRIES the field at all.
 *
 * `payload.mcpExportWhitelist === undefined` cannot answer this: it is equally
 * true of an absent key and of a key explicitly set to `undefined`. The two are
 * opposite instructions to main — main merges what it is handed, so a
 * present-but-undefined field ERASES the persisted whitelist and drops the
 * export server back to its default set, while an absent field leaves disk
 * untouched. Every "the field is not sent" assertion here goes through `in`.
 */
function hasWhitelistKey(payload: Record<string, unknown>): boolean {
  return 'mcpExportWhitelist' in payload
}

/** Whitelist argument of every `mcpExport:start` the window issued, in order. */
function startWhitelists(): unknown[] {
  return invoke.mock.calls
    .filter(([channel]) => channel === 'mcpExport:start')
    .map(([, , whitelist]) => whitelist)
}

/** Open the AI tab, where the MCP export section lives, and press Start. */
async function pressExportStart(): Promise<void> {
  fireEvent.click(screen.getByTestId('settings-tab-ai'))
  fireEvent.click(await screen.findByTestId('mcp-export-toggle'))
  await waitFor(() => expect(startWhitelists().length).toBeGreaterThan(0))
}

/**
 * Main's own rule, in one line: refuse `mcpExportWhitelist` while it carries a
 * name outside the ceiling, and name those entries back. Everything else is
 * accepted.
 */
function refusingMain(unexportable: readonly string[]): SaveResponder {
  return payload => {
    const submitted = payload.mcpExportWhitelist
    if (!Array.isArray(submitted)) return { ok: true }
    const offending = submitted.filter(
      entry => typeof entry !== 'string' || unexportable.includes(entry),
    )
    if (offending.length === 0) return { ok: true }
    return {
      ok: true,
      refused: [{
        field: 'mcpExportWhitelist',
        code: 'unknown_export_tool',
        // Main omits non-string members: they are not names the renderer can
        // match by identity (electron/settingsSaveRefusal.ts).
        values: offending.filter((entry): entry is string => typeof entry === 'string'),
      }],
    }
  }
}

const REFUSED_REPLY = {
  ok: true,
  refused: [{ field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: ['update_memory'] }],
}

beforeEach(() => {
  closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('§2.167 settings window — a refused field is not a completed save', () => {
  // REGRESSION GUARD. Closing is the only "saved" signal this window has.
  it('keeps the window open and shows which field was refused', async () => {
    await mountAndSave(REFUSED_REPLY, ['update_memory'])
    await screen.findByTestId('settings-save-refusal-notice')
    expect(screen.getByTestId('settings-save-refusal-field-mcpExportWhitelist')).toBeInTheDocument()
    expect(closeSpy).not.toHaveBeenCalled()
  })

  // The refusal costs the field and the close, nothing else: main applied every
  // other edit of the same payload, so the remaining save steps must still run.
  it('still runs the rest of the save', async () => {
    await mountAndSave(REFUSED_REPLY, ['update_memory'])
    await waitFor(() =>
      expect(invoke.mock.calls.some(([c]) => c === 'accounts:save')).toBe(true))
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('reports a field this build does not know rather than closing silently', async () => {
    await mountAndSave({ ok: true, refused: [{ field: 'somethingNew', code: 'whatever' }] })
    await screen.findByTestId('settings-save-refusal-field-somethingNew')
    expect(closeSpy).not.toHaveBeenCalled()
  })
})

describe('§2.167 settings window — a stale tool name is repaired from the reply', () => {
  const STALE = ['get_email', 'update_memory', 'list_folders']

  // The mirror of the export ceiling that used to live in the renderer is gone:
  // whatever the window holds is what main gets to judge.
  it('sends the whitelist verbatim, including a name main will refuse', async () => {
    await mountAndSave(refusingMain(['update_memory']), STALE)
    expect(savePayloads()[0].mcpExportWhitelist).toEqual(STALE)
  })

  it('removes exactly the entries main named, and says which', async () => {
    await mountAndSave(refusingMain(['update_memory']), STALE)
    const repaired = await screen.findByTestId('settings-save-refusal-repaired')
    expect(repaired).toHaveTextContent('update_memory')
    expect(repaired).not.toHaveTextContent('get_email')
  })

  // THE POINT OF THE REPAIR. Without it the stale name is re-submitted forever
  // and every later edit of the field dies with it. With it, the field is NOT
  // withheld: the next save carries the corrected list and stores it.
  it('lets the next save carry the corrected list and complete', async () => {
    await mountAndSave(refusingMain(['update_memory']), STALE)
    await screen.findByTestId('settings-save-refusal-repaired')

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(2))
    expect(savePayloads()[1].mcpExportWhitelist).toEqual(['get_email', 'list_folders'])
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-save-refusal-notice')).toBeNull()
  })

  // No automatic retry: the window stays open on exactly one save so the person
  // reads what left their list before pressing Save themselves.
  it('does not re-save by itself after repairing', async () => {
    await mountAndSave(refusingMain(['update_memory']), STALE)
    await screen.findByTestId('settings-save-refusal-repaired')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(savePayloads()).toHaveLength(1)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  // `values` cannot carry non-strings, so this repair is the renderer's own:
  // a number in a `string[]` is corrupt persisted data.
  it('cleans non-string entries by type, even though main named none', async () => {
    await mountAndSave(refusingMain([]), ['get_email', 42])
    const repaired = await screen.findByTestId('settings-save-refusal-repaired')
    expect(repaired).toHaveTextContent('42')

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(2))
    expect(savePayloads()[1].mcpExportWhitelist).toEqual(['get_email'])
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
  })

  // NEVER WIDEN. A whitelist of only-unexportable names exported nothing; the
  // repaired value must keep meaning "nothing". `undefined` would hand the
  // export server its default set instead.
  it('sends an explicit empty list when every name was refused', async () => {
    await mountAndSave(refusingMain(['update_memory']), ['update_memory'])
    await screen.findByTestId('settings-save-refusal-repaired')
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(2))
    expect(savePayloads()[1].mcpExportWhitelist).toEqual([])
  })
})

describe('§2.167 settings window — a partial repair', () => {
  // Main names what it can, and its naming is capped: one save can carry away
  // SOME of the offenders. What follows must not collapse into either extreme —
  // "the field is broken forever" (the loop the repair exists to break) or
  // "keep resubmitting" (a save that can never complete).
  const CONFIGURED = ['get_email', 'stale_one', 'stale_two']

  /** Names `stale_one` on the first refusal, then refuses naming anything. */
  function partiallyNamingMain(): SaveResponder {
    let refusals = 0
    return payload => {
      if (!hasWhitelistKey(payload)) return { ok: true }
      refusals += 1
      return {
        ok: true,
        refused: [{
          field: 'mcpExportWhitelist',
          code: 'unknown_export_tool',
          values: refusals === 1 ? ['stale_one'] : [],
        }],
      }
    }
  }

  it('repairs what was named, keeps submitting the field, then withholds it', async () => {
    await mountAndSave(partiallyNamingMain(), CONFIGURED)
    const repaired = await screen.findByTestId('settings-save-refusal-repaired')
    expect(repaired).toHaveTextContent('stale_one')
    expect(savePayloads()[0].mcpExportWhitelist).toEqual(CONFIGURED)

    // NO AUTOMATIC RETRY: the person has to read what left their list.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(savePayloads()).toHaveLength(1)
    expect(closeSpy).not.toHaveBeenCalled()

    // A repaired field is NOT withheld — the corrected list is submitted again.
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(2))
    expect(savePayloads()[1].mcpExportWhitelist).toEqual(['get_email', 'stale_two'])
    // This refusal named nothing, so nothing could be repaired from it and no
    // removal may be claimed.
    await waitFor(() =>
      expect(screen.queryByTestId('settings-save-refusal-repaired')).toBeNull())
    expect(closeSpy).not.toHaveBeenCalled()

    // ...and from here the field is withheld, so the window can be closed. It is
    // OMITTED, not sent as `undefined`: see `hasWhitelistKey`.
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(3))
    expect(hasWhitelistKey(savePayloads()[2])).toBe(false)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
  })
})

describe('§2.167 settings window — starting the export server never widens', () => {
  // THE DEFECT THIS GUARDS. `mcpExport:start` reads a nullish whitelist as "the
  // caller expressed no preference" and registers DEFAULT_EXPORT_WHITELIST
  // (`resolveExportWhitelist`). A list the person configured — including one a
  // refusal repair emptied — must therefore reach it as an ARRAY, or pressing
  // Start hands out tools the configuration said to export nothing of.
  it('starts with an explicit empty list after a repair emptied the list', async () => {
    await mountAndSave(refusingMain(['update_memory']), ['update_memory'])
    await screen.findByTestId('settings-save-refusal-repaired')

    await pressExportStart()
    expect(startWhitelists()[0]).toEqual([])
  })

  it('starts with an explicit empty list for a persisted empty whitelist', async () => {
    installApi({ ok: true }, [])
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))

    await pressExportStart()
    expect(startWhitelists()[0]).toEqual([])
  })

  // Unchanged behaviour: nobody ever configured a list, so the server is
  // started with no preference and picks its own read-only default set.
  it('starts with no whitelist when none was ever configured', async () => {
    installApi({ ok: true })
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))

    await pressExportStart()
    expect(startWhitelists()[0]).toBeUndefined()
  })

  it('starts with the configured list verbatim', async () => {
    installApi({ ok: true }, ['get_email', 'list_folders'])
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))

    await pressExportStart()
    expect(startWhitelists()[0]).toEqual(['get_email', 'list_folders'])
  })
})

describe('§2.167 settings window — a refusal it cannot repair', () => {
  // Main refused the field but named nothing this window holds (every offender
  // was past main's naming caps). Nothing here can repair such a value, so the
  // field is withheld from every later save instead of being submitted to be
  // refused again — otherwise the window could never be closed through the
  // button that opened it.
  const UNNAMEABLE = { ok: true, refused: [{ field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: [] }] }

  it('withholds the field from the next save, so that save can complete', async () => {
    await mountAndSave(
      payload => (hasWhitelistKey(payload) ? UNNAMEABLE : { ok: true }),
      ['get_email'],
    )
    await screen.findByTestId('settings-save-refusal-field-mcpExportWhitelist')
    expect(savePayloads()[0].mcpExportWhitelist).toEqual(['get_email'])

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(2))
    expect(hasWhitelistKey(savePayloads()[1])).toBe(false)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-save-refusal-notice')).toBeNull()
  })

  // THE DEFECT THIS GUARDS (found by security review of §2.167). Withholding
  // used to send `mcpExportWhitelist: undefined` — a PRESENT key. Main merges
  // the payload it is handed, so that erased the persisted whitelist and left
  // the export server on its default set: a refusal the window could not repair
  // silently WIDENED what a later Start would export. The field must be absent.
  it('does not erase the persisted whitelist while withholding the field', async () => {
    await mountAndSave(
      payload => (hasWhitelistKey(payload) ? UNNAMEABLE : { ok: true }),
      ['get_email'],
    )
    await screen.findByTestId('settings-save-refusal-field-mcpExportWhitelist')

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(2))
    expect(Object.keys(savePayloads()[1])).not.toContain('mcpExportWhitelist')
  })

  // Nothing left the person's list, so the notice must not claim anything did.
  it('announces no removal it did not make', async () => {
    await mountAndSave(UNNAMEABLE, ['get_email'])
    await screen.findByTestId('settings-save-refusal-field-mcpExportWhitelist')
    expect(screen.queryByTestId('settings-save-refusal-repaired')).toBeNull()
  })
})

describe('§2.167 settings window — a refused field alongside a rejected AI destination', () => {
  // §2.119 (address move) and §2.167 (per-field refusal) are independent gates
  // over the same `settings:save`, and main can report both at once (both ride
  // on `{ ok: true, ... }` — see electron/main.ts). Neither hook may swallow
  // the other's half: a person who both changed the AI destination and had a
  // stale export tool name refused must be told about both, not whichever one
  // happened to be checked last.
  const COMBINED_REPLY = {
    ok: true,
    aiDestinationRejected: {
      reason: 'declined',
      fields: ['aiOpenAiBaseUrl'],
      message: 'The AI API destination was not changed.',
    },
    refused: [{ field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: ['update_memory'] }],
  }

  it('shows both notices and keeps the window open', async () => {
    await mountAndSave(COMBINED_REPLY, ['update_memory'])
    await screen.findByTestId('settings-ai-destination-notice')
    await screen.findByTestId('settings-save-refusal-notice')
    expect(screen.getByTestId('settings-save-refusal-field-mcpExportWhitelist')).toBeInTheDocument()
    expect(closeSpy).not.toHaveBeenCalled()
  })

  // The repair runs before the `!aiDestinationApplied` early return in the
  // save handler — this is what proves it: a repair gated behind that check
  // would never fire when the destination was ALSO rejected, and the stale
  // tool name would be resubmitted (and refused again) on every later save.
  it('still repairs the whitelist state even though the destination change was rejected', async () => {
    await mountAndSave(COMBINED_REPLY, ['update_memory'])
    const repaired = await screen.findByTestId('settings-save-refusal-repaired')
    expect(repaired).toHaveTextContent('update_memory')
  })

  // THIS COMPOSITION IS WHY THE CLOSING LINE IS SCOPED. Something else in the
  // same save was ALSO not applied — the AI destination, reported by the notice
  // rendered right above. A line claiming every other change landed would be
  // contradicted on screen by its own neighbour. The banner speaks only for
  // what the save accepted; the English wording is pinned in
  // SettingsSaveRefusalNotice.test.tsx.
  it('does not claim every other change was saved', async () => {
    await mountAndSave(COMBINED_REPLY, ['update_memory'])
    await screen.findByTestId('settings-ai-destination-notice')
    expect(await screen.findByTestId('settings-save-refusal-other-saved'))
      .toHaveTextContent('settings.mcpExport.otherSettingsSaved')
  })
})

describe('§2.167 settings window — an accepted save is unaffected', () => {
  it('closes the window and shows no notice', async () => {
    await mountAndSave({ ok: true }, ['get_email', 'list_folders'])
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-save-refusal-notice')).toBeNull()
    expect(savePayloads()[0].mcpExportWhitelist).toEqual(['get_email', 'list_folders'])
  })

  // Unchanged behaviour for the untouched setting: an empty whitelist means "no
  // explicit list", and main must be left to keep whatever it has. "Leave it
  // alone" is an ABSENT key — `undefined` under a present key would instead
  // erase whatever main has (see `hasWhitelistKey`).
  it('omits the field entirely when no whitelist was ever configured', async () => {
    await mountAndSave({ ok: true })
    expect(hasWhitelistKey(savePayloads()[0])).toBe(false)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
  })

  // The other side of the "a repair emptied a configured list" rule: an empty
  // list ON DISK is a configured "export nothing", not an absence of one, so it
  // travels as an explicit `[]`. Sending `undefined` would say "no preference"
  // to a main that reads nullish as "keep/derive the default set".
  it('sends a persisted empty list as an explicit empty list', async () => {
    await mountAndSave({ ok: true }, [])
    expect(hasWhitelistKey(savePayloads()[0])).toBe(true)
    expect(savePayloads()[0].mcpExportWhitelist).toEqual([])
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
  })

  // The whole rule in one assertion: the key exists only when its value is an
  // array. Everything else — a never-configured list, a withheld field — omits
  // it rather than sending `undefined` under it.
  it('carries the field only as an array', async () => {
    await mountAndSave({ ok: true }, ['get_email'])
    for (const payload of savePayloads()) {
      expect(hasWhitelistKey(payload)).toBe(Array.isArray(payload.mcpExportWhitelist))
    }
    expect(savePayloads()[0].mcpExportWhitelist).toEqual(['get_email'])
  })

  it('closes the window when main answers with no payload at all', async () => {
    await mountAndSave(undefined)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-save-refusal-notice')).toBeNull()
  })
})
