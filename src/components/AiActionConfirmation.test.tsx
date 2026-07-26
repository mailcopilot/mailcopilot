// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import i18next from 'i18next'

// Stable i18n stub mirroring AiPanel.test.tsx conventions.
const i18nMap: Record<string, string> = {
  'ai.confirmation.apply': 'Apply',
  'ai.confirmation.applied': 'Applied',
  'ai.confirmation.cancel': 'Cancel',
  'ai.confirmation.account': '{{email}}',
  'ai.confirmation.accountFallback': 'Account #{{accountId}}',
  'ai.confirmation.crossAccount_one': '{{count}} account',
  'ai.confirmation.crossAccount_other': '{{count}} accounts',
  'ai.confirmation.folder': 'Folder: {{folder}}',
  'ai.confirmation.emailCount': '{{count}} email(s)',
  'ai.confirmation.folderCount_one': '{{count}} folder',
  'ai.confirmation.folderCount_other': '{{count}} folders',
  'ai.confirmation.kinds.snooze_email': 'Snooze emails',
  'ai.confirmation.kinds.flag_email.star': 'Star emails',
  'ai.confirmation.kinds.flag_email.unstar': 'Unstar emails',
  'ai.confirmation.kinds.send_email': 'Send email',
}
// Resolve the actual map key, handling i18next pluralization.
// t('ai.confirmation.crossAccount', { count: N }) →
//   N===1 → crossAccount_one, N≥2 → crossAccount_other
const resolveMapKey = (key: string, opts?: Record<string, unknown>): string => {
  if (opts && 'count' in opts) {
    const count = Number(opts.count)
    const pluralKey = count === 1 ? `${key}_one` : `${key}_other`
    if (Object.prototype.hasOwnProperty.call(i18nMap, pluralKey)) return pluralKey
  }
  return key
}
const stableT = (key: string, opts?: Record<string, unknown>) => {
  const mapKey = resolveMapKey(key, opts)
  let text = i18nMap[mapKey] ?? i18nMap[key] ?? key
  if (opts && typeof opts === 'object') {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
    }
  }
  return text
}
const stableI18n = {
  t: stableT,
  i18n: {
    exists: (key: string) => Object.prototype.hasOwnProperty.call(i18nMap, key),
  },
}
vi.mock('react-i18next', () => ({
  useTranslation: () => stableI18n,
}))

import AiActionConfirmation, { type PendingActionSummary } from './AiActionConfirmation'
import React from 'react'

function makeSummary(overrides: Partial<PendingActionSummary> = {}): PendingActionSummary {
  return {
    previewId: 'preview-uuid-1',
    kind: 'snooze_email',
    i18nKey: 'ai.confirmation.kinds.snooze_email',
    description: 'Snooze 2 emails until 2026-04-30',
    accountId: 1,
    accountEmail: 'default@example.com',
    emailCount: 2,
    folder: 'INBOX',
    createdAt: Date.now(),
    confirmed: false,
    ...overrides,
  }
}

describe('AiActionConfirmation', () => {
  let onApply: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onApply = vi.fn().mockResolvedValue(undefined)
    onCancel = vi.fn().mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders verb label resolved from i18nKey', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary(),
      onApply,
      onCancel,
    }))
    expect(screen.getByTestId('ai-action-confirmation')).toBeInTheDocument()
    expect(screen.getByText('Snooze emails')).toBeInTheDocument()
  })

  it('falls back to description when i18n key missing', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({
        kind: 'made_up_kind',
        i18nKey: 'ai.confirmation.kinds.does_not_exist',
        description: 'Made-up description text',
      }),
      onApply,
      onCancel,
    }))
    expect(screen.getByText('Made-up description text')).toBeInTheDocument()
  })

  it('shows account email / folder / email count meta when provided', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ accountId: 7, accountEmail: 'sent@example.com', folder: 'Sent', emailCount: 5 }),
      onApply,
      onCancel,
    }))
    expect(screen.getByText('sent@example.com')).toBeInTheDocument()
    expect(screen.queryByText('Account #7')).not.toBeInTheDocument()
    expect(screen.getByText('Folder: Sent')).toBeInTheDocument()
    expect(screen.getByText('5 email(s)')).toBeInTheDocument()
  })

  it('hides account meta when accountId is null (e.g. mail rule action)', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ accountId: null, accountEmail: null, emailCount: null, folder: null, kind: 'create_mail_rule' }),
      onApply,
      onCancel,
    }))
    expect(screen.queryByText(/Account/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Folder/)).not.toBeInTheDocument()
    expect(screen.queryByText(/email\(s\)/)).not.toBeInTheDocument()
  })

  it('clicking Apply calls onApply with previewId', async () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ previewId: 'preview-xyz' }),
      onApply,
      onCancel,
    }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-action-apply'))
    })
    expect(onApply).toHaveBeenCalledWith('preview-xyz')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('clicking Cancel calls onCancel with previewId', async () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ previewId: 'preview-xyz' }),
      onApply,
      onCancel,
    }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-action-cancel'))
    })
    expect(onCancel).toHaveBeenCalledWith('preview-xyz')
    expect(onApply).not.toHaveBeenCalled()
  })

  it('disables Apply button when already confirmed', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ confirmed: true }),
      onApply,
      onCancel,
    }))
    const applyBtn = screen.getByTestId('ai-action-apply') as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  it('shows the right kind verb for star vs unstar (subtype routing)', () => {
    const { rerender } = render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ kind: 'flag_email', i18nKey: 'ai.confirmation.kinds.flag_email.star' }),
      onApply,
      onCancel,
    }))
    expect(screen.getByText('Star emails')).toBeInTheDocument()

    rerender(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ kind: 'flag_email', i18nKey: 'ai.confirmation.kinds.flag_email.unstar' }),
      onApply,
      onCancel,
    }))
    expect(screen.getByText('Unstar emails')).toBeInTheDocument()
  })

  // §2.20 PR1 — account meta rendering scenarios

  it('single-account with email: shows email address, not Account #id', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ accountId: 5, accountEmail: 'user@example.com', folder: null, emailCount: null }),
      onApply,
      onCancel,
    }))
    expect(screen.getByText('user@example.com')).toBeInTheDocument()
    expect(screen.queryByText(/Account #5/)).not.toBeInTheDocument()
    expect(screen.queryByText(/аккаунт/i)).not.toBeInTheDocument()
  })

  it('single-account fallback: shows Account #id when email is null', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({ accountId: 5, accountEmail: null, folder: null, emailCount: null }),
      onApply,
      onCancel,
    }))
    expect(screen.getByText('Account #5')).toBeInTheDocument()
    expect(screen.queryByText('user@example.com')).not.toBeInTheDocument()
  })

  it('multi-account: shows cross-account count and email list, not Account #id', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({
        accountId: 1,
        accountEmail: null,
        accountsCount: 3,
        accountSlots: [
          { accountId: 1, email: 'a@x.com' },
          { accountId: 2, email: 'b@y.com' },
          { accountId: 3, email: 'c@z.com' },
        ],
        folder: null,
        emailCount: null,
      }),
      onApply,
      onCancel,
    }))
    expect(screen.getByText(/3 accounts/)).toBeInTheDocument()
    expect(screen.getByText(/a@x\.com/)).toBeInTheDocument()
    expect(screen.getByText(/b@y\.com/)).toBeInTheDocument()
    expect(screen.getByText(/c@z\.com/)).toBeInTheDocument()
    // Must NOT show the audit-breadcrumb accountId as "Account #1"
    expect(screen.queryByText(/Account #1/)).not.toBeInTheDocument()
  })

  // §2.20 PR1 fix-wave 2 — folderBreakdown rendering (codex security HIGH fix)

  it('single-account multi-folder: shows all folders in breakdown, not just first', () => {
    // Codex HIGH attack scenario: attacker hides emails across multiple folders;
    // confirmation must expose all affected folders, not a single misleading label.
    const summary = makeSummary({
      accountId: 1,
      accountEmail: 'sergey@reg.ru',
      accountsCount: 1,
      folder: null,
      emailCount: 11,
      folderBreakdown: [
        { accountId: 1, folder: 'INBOX', count: 8 },
        { accountId: 1, folder: 'Important', count: 3 },
      ],
    })
    render(React.createElement(AiActionConfirmation, { summary, onApply, onCancel }))
    // Single-account email still shown
    expect(screen.getByText('sergey@reg.ru')).toBeInTheDocument()
    // folderCount label: 2 folders
    expect(screen.getByText(/2 folders/)).toBeInTheDocument()
    // Both folder entries visible — no accountEmail prefix for single-account
    expect(screen.getByText(/INBOX \(8\)/)).toBeInTheDocument()
    expect(screen.getByText(/Important \(3\)/)).toBeInTheDocument()
    // Must NOT show only one folder (the HIGH gap)
    const breakdown = document.querySelector('.ai-action-confirmation-folder-breakdown')
    expect(breakdown?.querySelectorAll('.ai-action-confirmation-folder-item').length).toBe(2)
  })

  it('multi-account, all INBOX: breakdown collapses to single folder meta (§2.20 polish — avoid redundant per-account list when folder name is identical)', () => {
    const summary = makeSummary({
      accountId: null,
      accountEmail: null,
      accountsCount: 3,
      accountSlots: [
        { accountId: 1, email: 'a@x.com' },
        { accountId: 2, email: 'b@y.com' },
        { accountId: 3, email: null },
      ],
      folder: null,
      emailCount: 24,
      folderBreakdown: [
        { accountId: 1, folder: 'INBOX', count: 10 },
        { accountId: 2, folder: 'INBOX', count: 8 },
        { accountId: 3, folder: 'INBOX', count: 6 },
      ],
    })
    render(React.createElement(AiActionConfirmation, { summary, onApply, onCancel }))
    // Cross-account counter still shown
    expect(screen.getByText(/3 accounts/)).toBeInTheDocument()
    // Single folder shown via folder meta
    expect(screen.getByText(/Folder: INBOX/)).toBeInTheDocument()
    // No per-account folder breakdown list (all same folder → redundant)
    expect(screen.queryByText(/3 folders/)).not.toBeInTheDocument()
    expect(document.querySelectorAll('.ai-action-confirmation-folder-item').length).toBe(0)
  })

  it('multi-account, mixed folders per account: breakdown shows per-account labels', () => {
    const summary = makeSummary({
      accountId: null,
      accountEmail: null,
      accountsCount: 3,
      accountSlots: [
        { accountId: 1, email: 'a@x.com' },
        { accountId: 2, email: 'b@y.com' },
        { accountId: 3, email: null },
      ],
      folder: null,
      emailCount: 24,
      folderBreakdown: [
        { accountId: 1, folder: 'INBOX', count: 10 },
        { accountId: 2, folder: 'Archive', count: 8 },
        { accountId: 3, folder: 'Important', count: 6 },
      ],
    })
    render(React.createElement(AiActionConfirmation, { summary, onApply, onCancel }))
    // Cross-account counter
    expect(screen.getByText(/3 accounts/)).toBeInTheDocument()
    // Account list rendered by existing crossAccount branch (emails appear in both account-list and breakdown)
    expect(screen.getAllByText(/a@x\.com/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/b@y\.com/).length).toBeGreaterThanOrEqual(1)
    // Folder breakdown with per-account labels (3 entries, different folders → not collapsed)
    expect(screen.getByText(/3 folders/)).toBeInTheDocument()
    // Folder items in the breakdown list specifically
    const folderItems = document.querySelectorAll('.ai-action-confirmation-folder-item')
    const folderTexts = Array.from(folderItems).map((el) => el.textContent ?? '')
    expect(folderTexts.some((t) => t.includes('a@x.com: INBOX (10)'))).toBe(true)
    expect(folderTexts.some((t) => t.includes('b@y.com: Archive (8)'))).toBe(true)
    // Null-email slot gets fallback label
    expect(folderTexts.some((t) => t.includes('Account #3: Important (6)'))).toBe(true)
  })

  it('multi-account multi-folder cross product: all 4 breakdown entries rendered', () => {
    const summary = makeSummary({
      accountId: null,
      accountEmail: null,
      accountsCount: 2,
      accountSlots: [
        { accountId: 1, email: 'alice@x.com' },
        { accountId: 2, email: 'bob@y.com' },
      ],
      folder: null,
      emailCount: 20,
      folderBreakdown: [
        { accountId: 1, folder: 'INBOX', count: 5 },
        { accountId: 1, folder: 'Archive', count: 3 },
        { accountId: 2, folder: 'INBOX', count: 8 },
        { accountId: 2, folder: 'Sent', count: 4 },
      ],
    })
    render(React.createElement(AiActionConfirmation, { summary, onApply, onCancel }))
    expect(screen.getByText(/4 folders/)).toBeInTheDocument()
    const items = document.querySelectorAll('.ai-action-confirmation-folder-item')
    const texts = Array.from(items).map((el) => el.textContent ?? '')
    expect(texts.some((t) => t.includes('alice@x.com: INBOX (5)'))).toBe(true)
    expect(texts.some((t) => t.includes('alice@x.com: Archive (3)'))).toBe(true)
    expect(texts.some((t) => t.includes('bob@y.com: INBOX (8)'))).toBe(true)
    expect(texts.some((t) => t.includes('bob@y.com: Sent (4)'))).toBe(true)
    expect(items.length).toBe(4)
  })

  it('single-account single-folder legacy: folderBreakdown undefined → no breakdown rendered, folder shown normally', () => {
    const summary = makeSummary({
      accountId: 1,
      accountEmail: 'legacy@example.com',
      folder: 'INBOX',
      emailCount: 3,
      // folderBreakdown intentionally absent
    })
    render(React.createElement(AiActionConfirmation, { summary, onApply, onCancel }))
    expect(screen.getByText('Folder: INBOX')).toBeInTheDocument()
    expect(document.querySelector('.ai-action-confirmation-folder-breakdown')).toBeNull()
  })

  it('multi-account: accountSlots with null email renders fallback label (deleted account)', () => {
    render(React.createElement(AiActionConfirmation, {
      summary: makeSummary({
        accountId: null,
        accountEmail: null,
        accountsCount: 3,
        accountSlots: [
          { accountId: 1, email: 'a@x.com' },
          { accountId: 2, email: null },
          { accountId: 3, email: 'c@z.com' },
        ],
        folder: null,
        emailCount: null,
      }),
      onApply,
      onCancel,
    }))
    // Cross-account meta must be visible.
    expect(screen.getByText(/3 accounts/)).toBeInTheDocument()
    expect(screen.getByText(/a@x\.com/)).toBeInTheDocument()
    expect(screen.getByText(/c@z\.com/)).toBeInTheDocument()
    // Null slot must render as fallback label, not blank.
    expect(screen.getByText(/Account #2/)).toBeInTheDocument()
    // No empty comma-comma sequences visible (no blank slot).
    const emailsSpan = document.querySelector('.ai-action-confirmation-meta-emails')
    expect(emailsSpan?.textContent).not.toMatch(/,\s*,/)
  })
})

// ---------------------------------------------------------------------------
// §2.20 PR1 — i18n integration: real i18next with production RU resources.
// Verifies that Russian pluralization (one/few/many/other) works correctly
// for `crossAccount_*` keys. This is NOT covered by the stub t() above
// because the stub only handles `_one` and `_other`.
//
// We use a standalone i18next instance (i18next.createInstance()) to avoid
// conflicting with the module-level react-i18next mock — the tests here call
// the i18n logic directly, not through the React component.
// ---------------------------------------------------------------------------

describe('AiActionConfirmation — i18n integration (real i18next)', () => {
  // Lazily initialized once per describe block.
  let inst: Awaited<ReturnType<typeof i18next.createInstance>> | null = null

  async function getInst() {
    if (inst) return inst
    inst = i18next.createInstance()
    await inst.init({
      lng: 'ru',
      fallbackLng: 'en',
      ns: ['translation'],
      defaultNS: 'translation',
      resources: {
        ru: {
          translation: (await import('../i18n/locales/ru.json')).default,
        },
        en: {
          translation: (await import('../i18n/locales/en.json')).default,
        },
      },
      interpolation: { escapeValue: false },
    })
    return inst
  }

  it('RU pluralization: 1 account → "1 аккаунт" (one form)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.crossAccount', { count: 1 })).toBe('1 аккаунт')
  })

  it('RU pluralization: 2 accounts → "2 аккаунта" (few form)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.crossAccount', { count: 2 })).toBe('2 аккаунта')
  })

  it('RU pluralization: 5 accounts → "5 аккаунтов" (many form)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.crossAccount', { count: 5 })).toBe('5 аккаунтов')
  })

  it('RU pluralization: 11 accounts → "11 аккаунтов" (many form — teens exception)', async () => {
    // Russian teen numbers (11-19) use "many", not "few".
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.crossAccount', { count: 11 })).toBe('11 аккаунтов')
  })

  it('RU pluralization: 21 accounts → "21 аккаунт" (one form — compound)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.crossAccount', { count: 21 })).toBe('21 аккаунт')
  })

  it('RU accountFallback resolves to "Аккаунт №7"', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.accountFallback', { accountId: 7 })).toBe('Аккаунт №7')
  })

  it('EN crossAccount_other used for count >= 2', async () => {
    const i = await getInst()
    const en = i.getFixedT('en')
    expect(en('ai.confirmation.crossAccount', { count: 3 })).toBe('3 accounts')
  })

  // folderCount pluralization tests
  it('RU folderCount: 1 → "1 папка" (one form)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.folderCount', { count: 1 })).toBe('1 папка')
  })

  it('RU folderCount: 2 → "2 папки" (few form)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.folderCount', { count: 2 })).toBe('2 папки')
  })

  it('RU folderCount: 5 → "5 папок" (many form)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.folderCount', { count: 5 })).toBe('5 папок')
  })

  it('RU folderCount: 11 → "11 папок" (many form — teens exception)', async () => {
    const t = (await getInst()).t.bind(await getInst())
    expect(t('ai.confirmation.folderCount', { count: 11 })).toBe('11 папок')
  })

  it('EN folderCount: 1 → "1 folder" (one form)', async () => {
    const i = await getInst()
    const en = i.getFixedT('en')
    expect(en('ai.confirmation.folderCount', { count: 1 })).toBe('1 folder')
  })

  it('EN folderCount: 3 → "3 folders" (other form)', async () => {
    const i = await getInst()
    const en = i.getFixedT('en')
    expect(en('ai.confirmation.folderCount', { count: 3 })).toBe('3 folders')
  })
})
