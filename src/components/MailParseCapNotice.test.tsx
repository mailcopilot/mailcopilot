// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import MailParseCapNotice, { type MailParseCapNoticeProps } from './MailParseCapNotice'
import type { MessageParseCap } from '../../packages/net/types'

// Stable i18n mock with real interpolation (react-i18next's `t` substitutes
// {{token}} placeholders) — the hard-cap body needs {{limit}} to show up so the
// assertion below is checking real rendered text, not a stub.
const i18nMap: Record<string, string> = {
  'mail.parseCap.hard.title': 'This message is too large to open',
  'mail.parseCap.hard.body': 'It is larger than {{limit}}, the most we can read.',
  'mail.parseCap.soft.banner': 'Only the beginning of this message is shown.',
  'mail.parseCap.soft.action': 'Show full message',
  'mail.parseCap.soft.loading': 'Loading…',
  'mail.parseCap.soft.atLimit': 'This is as much of it as MailCopilot will display.',
}
const stableT = (key: string, opts?: Record<string, unknown>) => {
  const template = i18nMap[key] ?? key
  if (!opts) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_m, token: string) => String(opts[token] ?? ''))
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

function renderNotice(props: Partial<MailParseCapNoticeProps> & { cap: MessageParseCap }) {
  return render(React.createElement(MailParseCapNotice, props))
}

const HARD_CAP: MessageParseCap = { kind: 'hard', rawBytes: 150 * 1024 * 1024, limitBytes: 100 * 1024 * 1024 }
const SOFT_CAP_WITH_MORE: MessageParseCap = {
  kind: 'soft', rawBytes: 4 * 1024 * 1024, limitBytes: 1024 * 1024, canShowFull: true,
}
const SOFT_CAP_AT_LIMIT: MessageParseCap = {
  kind: 'soft', rawBytes: 20 * 1024 * 1024, limitBytes: 8 * 1024 * 1024, canShowFull: false,
}

describe('MailParseCapNotice', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders the hard-cap placeholder with the header facts and no way to bypass it', () => {
    renderNotice({ cap: HARD_CAP })

    const card = screen.getByTestId('mail-parse-cap-hard')
    expect(card).toBeInTheDocument()
    expect(card).toHaveTextContent('This message is too large to open')
    // The limit is a real, formatted number — not the raw byte count.
    expect(card).toHaveTextContent('100.0 MB')
    // §2.145 wave 3.1 — and the message's own size is NOT stated. On the
    // refused-mid-download path `rawBytes` is only a lower bound (the count
    // when we stopped consuming), so rendering it as "It is 150.0 MB" asserted
    // something we do not know. `HARD_CAP.rawBytes` is 150 MiB precisely so
    // this assertion would fail if the size came back.
    expect(card).not.toHaveTextContent('150.0 MB')
    // No button anywhere in the hard-cap card — an "open anyway" affordance
    // would be a button that asks the app to run out of memory.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-parse-cap-soft')).not.toBeInTheDocument()
  })

  it('renders the soft-cap banner with a working "show full" button when more is available', () => {
    const onShowFull = vi.fn()
    renderNotice({ cap: SOFT_CAP_WITH_MORE, onShowFull })

    expect(screen.getByTestId('mail-parse-cap-soft')).toBeInTheDocument()
    expect(screen.queryByTestId('mail-parse-cap-hard')).not.toBeInTheDocument()

    const button = screen.getByTestId('mail-parse-cap-show-full')
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('Show full message')
    expect(screen.queryByTestId('mail-parse-cap-at-limit')).not.toBeInTheDocument()

    fireEvent.click(button)
    expect(onShowFull).toHaveBeenCalledOnce()
  })

  it('disables the button and shows the loading label while a re-parse is in flight', () => {
    const onShowFull = vi.fn()
    renderNotice({ cap: SOFT_CAP_WITH_MORE, onShowFull, loading: true })

    const button = screen.getByTestId('mail-parse-cap-show-full')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Loading…')

    // Clicking a disabled button fires no click handler in jsdom either way,
    // but assert the contract explicitly: a slow re-parse must not be
    // queueable twice by an impatient click.
    fireEvent.click(button)
    expect(onShowFull).not.toHaveBeenCalled()
  })

  it('shows "at limit" instead of a button when even the raised tier clipped', () => {
    renderNotice({ cap: SOFT_CAP_AT_LIMIT, onShowFull: vi.fn() })

    expect(screen.queryByTestId('mail-parse-cap-show-full')).not.toBeInTheDocument()
    expect(screen.getByTestId('mail-parse-cap-at-limit')).toHaveTextContent(
      'This is as much of it as MailCopilot will display.',
    )
  })

  it('shows "at limit" (not a button) when canShowFull is true but no handler was wired', () => {
    // A caller that does not wire the re-parse gets the honest rendering of
    // "there is more, and this view cannot fetch it" — not a dead button.
    renderNotice({ cap: SOFT_CAP_WITH_MORE })

    expect(screen.queryByTestId('mail-parse-cap-show-full')).not.toBeInTheDocument()
    expect(screen.getByTestId('mail-parse-cap-at-limit')).toBeInTheDocument()
  })
})
