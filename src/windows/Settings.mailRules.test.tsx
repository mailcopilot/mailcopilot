// @vitest-environment jsdom
/**
 * §2.162 — a stored rule that is not shaped like a rule must not take the Rules
 * tab down with it.
 *
 * Rules live in the database as two JSON strings. The screen used to
 * `JSON.parse` them and use the result: a row holding `"null"` reached
 * `rule.conditions.length` and crashed the whole tab, and `"{}"` survived the
 * list only to crash the editor at `.map`. Such a row cannot be produced by
 * this editor, but an assistant — or a build older than the structural check on
 * save — could write one, and validating on save does nothing for rows already
 * stored.
 *
 * Why that is worse than it sounds: the refusal design deliberately leaves
 * "disable / rename / delete" unguarded so a user always has a way out of a
 * rule that no longer works. A crashing tab removes that way out for the one
 * case that needs it most — hence these tests drive the actual buttons rather
 * than only asserting that the row renders.
 *
 * The normalisation itself is tested in components/mailRuleDrafts.test.ts. This
 * file tests the WIRING: that Settings uses it, which a mirror test could not
 * tell (the crash came from the call site, not from the decision).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}))
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn(), language: 'en' },
  SUPPORTED_LANGUAGES: ['en', 'ru', 'fr', 'de', 'es', 'it'],
  DEFAULT_LANGUAGE: 'en',
}))
vi.mock('../sentry', () => ({
  sendFeedback: vi.fn(),
  captureException: vi.fn(),
}))

import Settings from './Settings'

type Row = Record<string, unknown>

let invoke: ReturnType<typeof vi.fn>

function ruleRow(overrides: Row = {}): Row {
  return {
    id: 'rule-ok',
    accountId: null,
    name: 'Newsletters',
    enabled: true,
    priority: 0,
    conditions: JSON.stringify([{ field: 'from_address', op: 'contains', value: '@news.test' }]),
    actions: JSON.stringify([{ type: 'archive' }]),
    stopProcessing: false,
    ...overrides,
  }
}

/** Mount Settings with `rules:list` answering `rules`, and open the Rules tab. */
async function openRulesTab(rules: Row[]): Promise<void> {
  invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'settings:get': return { theme: 'light' }
      case 'settings:save': return { ok: true }
      case 'accounts:list': return []
      case 'accounts:getCurrent': return null
      case 'rules:list': return rules
      case 'rules:delete': return { ok: true }
      case 'rules:update': return { ok: true }
      case 'aiRules:list': return []
      case 'aiRules:log': return []
      case 'templates:list': return []
      case 'mcpExport:status': return { status: 'stopped' }
      case 'mcp:status': return []
      case 'tls:listPins': return []
      default: return undefined
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn(),
      off: vi.fn(),
      initialTheme: 'light',
      installIdHash: '',
      sentryEnabled: false,
    },
  })

  render(<Settings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
  fireEvent.click(screen.getByTestId('settings-tab-rules'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('rules:list'))
}

function ruleItem(name: string): HTMLElement {
  const item = [...document.querySelectorAll('.rule-item')].find(
    el => el.textContent?.includes(name),
  )
  expect(item, `no rule row for ${name}`).toBeTruthy()
  return item as HTMLElement
}

describe('§2.162 Settings — a malformed stored rule stays usable', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
  })

  // REGRESSION GUARD — `null.length` used to throw during render, so the whole
  // tab (including every other rule) disappeared.
  it('renders the tab when a row decoded to null', async () => {
    await openRulesTab([
      ruleRow(),
      ruleRow({ id: 'rule-null', name: 'Broken null', conditions: 'null' }),
    ])
    await screen.findByText('Broken null')
    // The healthy rule is still listed — the crash used to take it with it.
    expect(screen.getByText('Newsletters')).toBeInTheDocument()
  })

  it('marks the row instead of claiming it has zero conditions', async () => {
    await openRulesTab([ruleRow({ id: 'rule-null', name: 'Broken null', conditions: 'null' })])
    const item = ruleItem('Broken null')
    expect(item.querySelector('[data-testid="rule-malformed-badge"]')).toBeInTheDocument()
    expect(item.textContent).toContain('settings.rules.malformedBadge')
    expect(item.textContent).not.toContain('0 settings.rules.conditions')
  })

  it('shows the counts for a healthy rule, and no marker', async () => {
    await openRulesTab([ruleRow()])
    const item = ruleItem('Newsletters')
    expect(item.querySelector('[data-testid="rule-malformed-badge"]')).toBeNull()
    expect(item.textContent).toContain('1 settings.rules.conditions')
  })

  // THE evacuation path: the toggle patch touches neither half, so the save
  // guard lets it through — but only if the row can be rendered at all.
  it('lets the user disable a malformed rule', async () => {
    await openRulesTab([ruleRow({ id: 'rule-null', name: 'Broken null', conditions: 'null' })])
    const checkbox = ruleItem('Broken null').querySelector('input[type="checkbox"]')
    fireEvent.click(checkbox as Element)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('rules:update', 'rule-null', { enabled: false }),
    )
  })

  it('lets the user delete a malformed rule', async () => {
    // The `null` half, not the `{}` one: that is the row the list could not
    // render at all, so deleting it was unreachable rather than merely awkward.
    await openRulesTab([ruleRow({ id: 'rule-null', name: 'Broken null', conditions: 'null' })])
    const del = [...ruleItem('Broken null').querySelectorAll('button')].find(
      b => b.getAttribute('title') === 'Delete',
    )
    fireEvent.click(del as Element)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('rules:delete', 'rule-null'))
  })

  // REGRESSION GUARD — `{}.map` threw here, one click after the list survived.
  it('opens the editor on a malformed rule and explains the state', async () => {
    await openRulesTab([ruleRow({ id: 'rule-obj', name: 'Broken object', conditions: '{}', actions: '{}' })])
    const edit = [...ruleItem('Broken object').querySelectorAll('button')].find(
      b => b.getAttribute('title') === 'Edit',
    )
    fireEvent.click(edit as Element)

    const notice = await screen.findByTestId('rule-malformed-notice')
    expect(notice).toHaveTextContent('settings.rules.refusal.malformedRule')
    // Opened empty rather than half-built: the halves could not be read.
    expect(screen.queryAllByRole('combobox', { name: 'settings.rules.conditionField' }))
      .toHaveLength(0)
  })

  // A `move` with no folder used to save quietly, move nothing, and be written
  // to the audit log as applied; it is now refused as `malformed_rule`. Saying
  // that after the click would leave the user staring at an empty box they were
  // never told about, so the editor blocks the save and marks the field.
  it('blocks the save while a move action names no folder', async () => {
    await openRulesTab([ruleRow({
      name: 'Move without target',
      actions: JSON.stringify([{ type: 'move', folder: 'Later' }]),
    })])
    const edit = [...ruleItem('Move without target').querySelectorAll('button')].find(
      b => b.getAttribute('title') === 'Edit',
    )
    fireEvent.click(edit as Element)

    await screen.findByTestId('rule-editor-save')
    expect(screen.getByTestId('rule-editor-save')).not.toBeDisabled()

    // Blank the folder, as a user clearing the box would.
    const textInputs = [...document.querySelectorAll('.modal-dialog input[type="text"]')]
    const folder = textInputs[textInputs.length - 1]
    fireEvent.change(folder as Element, { target: { value: '   ' } })

    expect(screen.getByTestId('rule-move-folder-required')).toBeInTheDocument()
    expect(screen.getByTestId('rule-editor-save')).toBeDisabled()
    expect(invoke).not.toHaveBeenCalledWith('rules:update', expect.anything(), expect.anything())
  })

  it('opens the editor on a healthy rule without the notice', async () => {
    await openRulesTab([ruleRow()])
    const edit = [...ruleItem('Newsletters').querySelectorAll('button')].find(
      b => b.getAttribute('title') === 'Edit',
    )
    fireEvent.click(edit as Element)

    await screen.findByText('settings.rules.conditions')
    expect(screen.queryByTestId('rule-malformed-notice')).not.toBeInTheDocument()
    // The stored condition is presented for editing, not swallowed.
    expect(screen.getAllByRole('combobox', { name: 'settings.rules.conditionField' }))
      .toHaveLength(1)
  })
})
