// @vitest-environment jsdom
/**
 * §1.26.1(3) — the AI consent grid as rendered.
 *
 * The rules live in `useAiConsentMatrix` and are pinned there; this file covers
 * what only the markup can answer: that there is exactly ONE account control in
 * the tab (the defect was four duplicates sharing a testid), that the column
 * header really carries the native mixed state, and that no control on screen
 * grants more than one feature at a time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

const i18nMap: Record<string, string> = {
  'ai.settings.consentMatrix.title': 'AI features per mailbox',
  'ai.settings.consentMatrix.help': 'Each AI feature is asked for separately.',
  'ai.settings.consentMatrix.accountColumn': 'Mailbox',
  'ai.settings.consentMatrix.noAccounts': 'Add a mailbox first.',
  'ai.settings.consentMatrix.cellLabel': '{{feature}} in {{account}}',
  'ai.settings.consentMatrix.allowAll_other': 'Allow “{{feature}}” in all {{count}} mailboxes',
  'ai.settings.consentMatrix.clearAll_other': 'Turn “{{feature}}” off in all {{count}} mailboxes',
  'ai.settings.threadSummary.title': 'Thread AI Summary',
  'ai.settings.threadSummary.help': 'Summarises long threads.',
  'ai.settings.instantReply.title': 'Instant Reply',
  'ai.settings.instantReply.help': 'Drafts quick replies.',
  'ai.settings.proofread.title': 'AI Proofread',
  'ai.settings.proofread.help': 'Checks what you wrote.',
  'ai.settings.translate.title': 'AI Translate',
  'ai.settings.translate.help': 'Translates messages and drafts.',
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  // i18next resolves `count` to a plural suffix; the grid is only ever rendered
  // with 2+ mailboxes here, so `_other` is enough for a stub.
  const raw = i18nMap[key] ?? i18nMap[`${key}_other`] ?? key
  if (!opts) return raw
  return raw.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ''))
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({ useTranslation: () => stableUseTranslation }))

import AiConsentMatrix from './AiConsentMatrix'
import type {
  AiConsentFeature,
  AiConsentMap,
  AiConsentValue,
} from '../../hooks/useAiConsentMatrix'

/**
 * `onChangeFeature` receives an UPDATER, not a finished map (the hook's
 * docblock says why: a batched write must never resolve against a stale
 * snapshot). Assertions here run it against the map the component was rendered
 * with, which is what the caller's `setState` would pass in the common case.
 */
function applied(
  onChangeFeature: ReturnType<typeof vi.fn>,
  value: AiConsentValue,
  feature: AiConsentFeature,
): AiConsentMap {
  const call = onChangeFeature.mock.calls.find(c => c[0] === feature)
  expect(call, `no write for ${feature}`).toBeDefined()
  const update = call![1] as unknown
  expect(typeof update).toBe('function')
  return (update as (p: AiConsentMap) => AiConsentMap)(value[feature])
}

const ACCOUNTS = [
  { id: 1, label: 'One (one@example.test)' },
  { id: 2, label: 'Two (two@example.test)' },
]

const EMPTY: AiConsentValue = {
  threadSummary: {},
  instantReply: {},
  proofread: {},
  translate: {},
}

function renderMatrix(over: Partial<React.ComponentProps<typeof AiConsentMatrix>> = {}) {
  const props: React.ComponentProps<typeof AiConsentMatrix> = {
    accounts: ACCOUNTS,
    value: EMPTY,
    onChangeFeature: vi.fn(),
    ...over,
  }
  return { ...render(<AiConsentMatrix {...props} />), props }
}

afterEach(() => cleanup())
beforeEach(() => vi.clearAllMocks())

describe('AiConsentMatrix', () => {
  it('renders one row per mailbox and one cell per feature', () => {
    renderMatrix()
    expect(screen.getByTestId('settings-ai-consent-row-1')).toBeInTheDocument()
    expect(screen.getByTestId('settings-ai-consent-row-2')).toBeInTheDocument()
    for (const f of ['threadSummary', 'instantReply', 'proofread', 'translate']) {
      expect(screen.getByTestId(`settings-ai-consent-${f}-1`)).toBeInTheDocument()
      expect(screen.getByTestId(`settings-ai-consent-${f}-2`)).toBeInTheDocument()
    }
  })

  it('renders NO account picker of its own — the grid shows every mailbox at once', () => {
    // The defect being fixed: four sections, four copies of the shared account
    // `<Select>`, all with `data-testid="settings-folders-account"` and all
    // bound to one `accountId`.
    renderMatrix()
    expect(screen.queryByTestId('settings-folders-account')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it('shows every cell unticked when nothing has been granted (default OFF)', () => {
    renderMatrix()
    expect(screen.getByTestId('settings-ai-consent-translate-1')).not.toBeChecked()
    expect(screen.getByTestId('settings-ai-consent-all-translate')).not.toBeChecked()
  })

  it('a cell click grants that one mailbox for that one feature', () => {
    const { props } = renderMatrix()
    fireEvent.click(screen.getByTestId('settings-ai-consent-proofread-2'))
    const onChange = props.onChangeFeature as ReturnType<typeof vi.fn>
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(applied(onChange, EMPTY, 'proofread')).toEqual({ '2': true })
  })

  it('the column header is a real three-state checkbox', () => {
    const partly: AiConsentValue = { ...EMPTY, translate: { '1': true } }
    renderMatrix({ value: partly })
    const head = screen.getByTestId('settings-ai-consent-all-translate') as HTMLInputElement
    // Mixed = "set for part of the collection" (Win32 UX guide). The native
    // `indeterminate` property is what maps to aria-checked="mixed"; an
    // attribute cannot express it.
    expect(head.indeterminate).toBe(true)
    expect(head.checked).toBe(false)
  })

  it('is fully checked, not mixed, once every mailbox has granted it', () => {
    const all: AiConsentValue = { ...EMPTY, translate: { '1': true, '2': true } }
    renderMatrix({ value: all })
    const head = screen.getByTestId('settings-ai-consent-all-translate') as HTMLInputElement
    expect(head.indeterminate).toBe(false)
    expect(head.checked).toBe(true)
  })

  it('the column action names the feature and the number of mailboxes it touches', () => {
    renderMatrix()
    expect(screen.getByTestId('settings-ai-consent-all-translate'))
      .toHaveAttribute('aria-label', 'Allow “AI Translate” in all 2 mailboxes')
  })

  it('the column action says "turn off" once everyone has it — withdrawal is one click', () => {
    const all: AiConsentValue = { ...EMPTY, translate: { '1': true, '2': true } }
    const { props } = renderMatrix({ value: all })
    const head = screen.getByTestId('settings-ai-consent-all-translate')
    expect(head).toHaveAttribute('aria-label', 'Turn “AI Translate” off in all 2 mailboxes')
    fireEvent.click(head)
    expect(applied(props.onChangeFeature as ReturnType<typeof vi.fn>, all, 'translate'))
      .toEqual({ '1': false, '2': false })
  })

  it('a MIXED column says "turn off" too, and one click withdraws', () => {
    // The three states each have to name what the click does. The old label
    // only asked `state === 'all'`, so a mixed column offered to "allow" and
    // then — after the cycle was fixed — withdrew instead.
    const partly: AiConsentValue = { ...EMPTY, translate: { '1': true } }
    const { props } = renderMatrix({ value: partly })
    const head = screen.getByTestId('settings-ai-consent-all-translate')
    expect(head).toHaveAttribute('aria-label', 'Turn “AI Translate” off in all 2 mailboxes')
    fireEvent.click(head)
    expect(applied(props.onChangeFeature as ReturnType<typeof vi.fn>, partly, 'translate'))
      .toEqual({ '1': false, '2': false })
  })

  it('the header title matches its accessible name in all three states', () => {
    for (const [value, label] of [
      [EMPTY, 'Allow “AI Translate” in all 2 mailboxes'],
      [{ ...EMPTY, translate: { '1': true } }, 'Turn “AI Translate” off in all 2 mailboxes'],
      [{ ...EMPTY, translate: { '1': true, '2': true } }, 'Turn “AI Translate” off in all 2 mailboxes'],
    ] as Array<[AiConsentValue, string]>) {
      cleanup()
      renderMatrix({ value })
      const head = screen.getByTestId('settings-ai-consent-all-translate')
      expect(head).toHaveAttribute('aria-label', label)
      expect(head).toHaveAttribute('title', label)
    }
  })

  it('a column click writes exactly one feature — never several purposes at once', () => {
    // EDPB Guidelines 05/2020 granularity: there is no "allow everything
    // everywhere" affordance, and a bulk click must not behave like one.
    const { props } = renderMatrix()
    const onChange = props.onChangeFeature as ReturnType<typeof vi.fn>
    fireEvent.click(screen.getByTestId('settings-ai-consent-all-instantReply'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(applied(onChange, EMPTY, 'instantReply')).toEqual({ '1': true, '2': true })
  })

  it('offers no control that grants more than one feature', () => {
    renderMatrix()
    const boxes = screen.getAllByRole('checkbox')
    // 4 column headers + 2 mailboxes × 4 features. Any extra checkbox would be
    // a broader-than-one-purpose control that has to be justified here first.
    expect(boxes).toHaveLength(4 + 2 * 4)
  })

  it('asks for no confirmation on either direction of a bulk action (AC-5)', () => {
    // Symmetry is the point: a dialog on granting that withdrawal does not have
    // would make "off" cost more than "on". Neither has one, and the evidence
    // of the click is the column of cells right below it.
    const confirmSpy = vi.spyOn(window, 'confirm')
    const { props } = renderMatrix()
    fireEvent.click(screen.getByTestId('settings-ai-consent-all-translate'))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(props.onChangeFeature).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
  })

  it('keeps the per-feature explanations that the four retired sections carried', () => {
    renderMatrix()
    expect(screen.getByText('Translates messages and drafts.')).toBeInTheDocument()
    expect(screen.getByText('Checks what you wrote.')).toBeInTheDocument()
  })

  it('renders an explanation instead of an empty table when there are no mailboxes', () => {
    renderMatrix({ accounts: [] })
    expect(screen.getByTestId('settings-ai-consent-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-ai-consent-all-translate')).not.toBeInTheDocument()
  })
})
