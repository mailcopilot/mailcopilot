/**
 * AiActionConfirmation — confirmation block surfaced inside the AI panel
 * whenever the AI proposes a mutating action via a `*_preview` MCP tool.
 *
 * Why this exists (CLAUDE.md §5 — Verifiable Private Inbox Agent invariant):
 * mutating MCP tools (snooze, flag, send, mail rule changes, …) cannot fire
 * without an explicit user click on Apply. The click triggers the
 * `ai:action:apply` IPC, which issues a confirmation token in main; the
 * token is then injected into the AI's next prompt via
 * `describePendingPreviews()`, which lets the AI call `apply_*`.
 *
 * Until the user clicks Apply, the underlying DB / IMAP / SMTP callbacks
 * are never invoked — even if the AI is being prompt-injected by an email
 * body. The token is the structural barrier; the chat-side phrase
 * ("ok"/"yes"/"do it") is informational only.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X, Loader2 } from 'lucide-react'

export type PendingActionSummary = {
  previewId: string
  kind: string
  i18nKey: string
  description: string
  accountId: number | null
  /** Single-account: resolved email address; null if account not found or multi-account batch. */
  accountEmail: string | null
  /** Multi-account batch only: per-account id+email slots; email is null for deleted/unfound accounts. */
  accountSlots?: { accountId: number; email: string | null }[]
  /** Multi-account batch only: total number of accounts involved. */
  accountsCount?: number
  /**
   * Multi-folder batch: per-(accountId, folder) breakdown with per-folder email counts.
   * Undefined for single-account single-folder (legacy shape — `folder` field is set).
   * Length >= 2 for any multi-folder case; length >= 1 for multi-account single-folder-per-account.
   */
  folderBreakdown?: { accountId: number; folder: string; count: number }[]
  emailCount: number | null
  folder: string | null
  createdAt: number
  confirmed?: boolean
}

export type AiActionConfirmationProps = {
  /** Summary returned by `ai:action:list` IPC. */
  summary: PendingActionSummary
  /** Called when user clicks Apply — should invoke `ai:action:apply` IPC and
   *  surface the resulting `confirmationToken` back to the AI panel for the
   *  next prompt turn. */
  onApply: (previewId: string) => Promise<void>
  /** Called when user clicks Cancel — invokes `ai:action:cancel` IPC and
   *  removes the confirmation block. */
  onCancel: (previewId: string) => Promise<void>
}

/**
 * Resolve a localized verb for an action kind. The i18n key conventions
 * follow `ai.confirmation.kinds.<kind>[.subtype]`. We try the full key
 * first; if missing, fall back to the kind-only key; if still missing, fall
 * back to the renderer-friendly `description` string from the summary.
 */
function useKindLabel(summary: PendingActionSummary): string {
  const { t, i18n } = useTranslation()
  const tryKey = (key: string): string | null => {
    if (i18n.exists(key)) return t(key)
    return null
  }
  return tryKey(summary.i18nKey)
    ?? tryKey(`ai.confirmation.kinds.${summary.kind}`)
    ?? summary.description
}

/** Renders the per-(account, folder) breakdown for multi-folder batch confirmations. */
function FolderBreakdownMeta({
  summary,
  t,
}: {
  summary: PendingActionSummary
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const breakdown = summary.folderBreakdown!
  const isMultiAccount = (summary.accountsCount ?? 0) >= 2

  // §2.20 polish: when every breakdown entry points at the same folder name
  // (e.g. all accounts have only INBOX), the per-account list is redundant
  // noise — `email1: INBOX, email2: INBOX, email3: INBOX` adds nothing the
  // multi-account header didn't already convey, and the folder name is
  // visible. Show a compact single-folder meta item instead. Different
  // folder names → keep full breakdown (security HIGH closure depends on
  // user seeing all distinct folders).
  const uniqueFolderNames = new Set(breakdown.map((br) => br.folder))
  const allSameFolder = uniqueFolderNames.size === 1

  if (allSameFolder) {
    const [folder] = uniqueFolderNames
    return (
      <span className="ai-action-confirmation-meta-item">
        {t('ai.confirmation.folder', { folder })}
      </span>
    )
  }

  return (
    <span className="ai-action-confirmation-meta-item ai-action-confirmation-folder-breakdown">
      {t('ai.confirmation.folderCount', { count: breakdown.length })}
      {': '}
      <span className="ai-action-confirmation-folder-list">
        {breakdown.map((br, idx) => {
          const accountSlot =
            isMultiAccount && summary.accountSlots
              ? summary.accountSlots.find((s) => s.accountId === br.accountId)
              : undefined
          const accountLabel = accountSlot
            ? (accountSlot.email ??
                t('ai.confirmation.accountFallback', { accountId: accountSlot.accountId }))
            : null
          const folderLabel = accountLabel
            ? `${accountLabel}: ${br.folder} (${br.count})`
            : `${br.folder} (${br.count})`
          return (
            <span key={`${br.accountId}-${br.folder}`} className="ai-action-confirmation-folder-item">
              {idx > 0 && ', '}
              {folderLabel}
            </span>
          )
        })}
      </span>
    </span>
  )
}

export default function AiActionConfirmation({ summary, onApply, onCancel }: AiActionConfirmationProps) {
  const { t } = useTranslation()
  const verbLabel = useKindLabel(summary)
  const [busy, setBusy] = useState<'idle' | 'applying' | 'cancelling'>('idle')

  const handleApply = useCallback(async () => {
    if (busy !== 'idle') return
    setBusy('applying')
    try {
      await onApply(summary.previewId)
    } finally {
      setBusy('idle')
    }
  }, [busy, onApply, summary.previewId])

  const handleCancel = useCallback(async () => {
    if (busy !== 'idle') return
    setBusy('cancelling')
    try {
      await onCancel(summary.previewId)
    } finally {
      setBusy('idle')
    }
  }, [busy, onCancel, summary.previewId])

  // Confirmed = token was already issued (e.g. user double-clicked Apply
  // before re-render). The block stays visible to give the AI next-turn
  // context, but Apply is disabled.
  const alreadyConfirmed = Boolean(summary.confirmed)

  return (
    <div
      className="ai-action-confirmation"
      data-testid="ai-action-confirmation"
      data-preview-id={summary.previewId}
      data-kind={summary.kind}
    >
      <div className="ai-action-confirmation-header">
        <span className="ai-action-confirmation-verb">{verbLabel}</span>
      </div>
      <div className="ai-action-confirmation-meta">
        {summary.accountsCount != null && summary.accountsCount >= 2 ? (
          <span className="ai-action-confirmation-meta-item">
            {t('ai.confirmation.crossAccount', { count: summary.accountsCount })}
            {summary.accountSlots && summary.accountSlots.length > 0 && (
              <span className="ai-action-confirmation-meta-emails">
                {' '}({summary.accountSlots.map((slot) =>
                  slot.email !== null
                    ? slot.email
                    : t('ai.confirmation.accountFallback', { accountId: slot.accountId })
                ).join(', ')})
              </span>
            )}
          </span>
        ) : summary.accountId !== null && summary.accountEmail !== null ? (
          <span className="ai-action-confirmation-meta-item">
            {t('ai.confirmation.account', { email: summary.accountEmail })}
          </span>
        ) : summary.accountId !== null ? (
          <span className="ai-action-confirmation-meta-item">
            {t('ai.confirmation.accountFallback', { accountId: summary.accountId })}
          </span>
        ) : null}
        {summary.folder && (
          <span className="ai-action-confirmation-meta-item">
            {t('ai.confirmation.folder', { folder: summary.folder })}
          </span>
        )}
        {summary.folderBreakdown && summary.folderBreakdown.length >= 2 && (
          <FolderBreakdownMeta summary={summary} t={t} />
        )}
        {summary.emailCount !== null && (
          <span className="ai-action-confirmation-meta-item">
            {t('ai.confirmation.emailCount', { count: summary.emailCount })}
          </span>
        )}
      </div>
      <div className="ai-action-confirmation-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleCancel}
          disabled={busy !== 'idle'}
          data-testid="ai-action-cancel"
        >
          {busy === 'cancelling' ? <Loader2 size={14} className="spin" /> : <X size={14} />}
          {t('ai.confirmation.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleApply}
          disabled={busy !== 'idle' || alreadyConfirmed}
          data-testid="ai-action-apply"
        >
          {busy === 'applying' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
          {alreadyConfirmed ? t('ai.confirmation.applied') : t('ai.confirmation.apply')}
        </button>
      </div>
    </div>
  )
}
