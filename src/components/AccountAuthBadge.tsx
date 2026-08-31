import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'

/** Longest account label rendered inline. The label comes from the account's
 *  own name / address, so it is user data rather than server data — bounded
 *  anyway so a pathological value cannot push the action button out of the
 *  strip. Rendered as a text node; never HTML. */
const LABEL_MAX = 80

type Props = {
  /** Account this strip is about. Passed back to `onFix` unchanged. */
  accountId: number
  /** Display name or address of the account. Empty string is allowed — the
   *  copy then falls back to the account-less wording. */
  accountLabel: string
  /** Open this account's settings so the user can sign in again. */
  onFix: (accountId: number) => void
}

/**
 * §2.157 — unobtrusive per-account "this mailbox needs signing in again"
 * strip.
 *
 * Deliberately NOT a modal: the condition is not urgent (mail is not lost, it
 * is merely not arriving), it can persist for days, and a modal would be
 * dismissed reflexively and then never seen again. It is a quiet row with one
 * affordance — open the account's settings, which is the only place the user
 * can actually fix it.
 *
 * Thin and presentational: the state and the IPC live in
 * src/hooks/useAccountAuthState.ts. This component owns no state at all, so it
 * cannot disagree with main about which accounts are flagged.
 */
export default function AccountAuthBadge({ accountId, accountLabel, onFix }: Props) {
  const { t } = useTranslation()
  const label = (accountLabel || '').trim().slice(0, LABEL_MAX)

  return (
    <div
      className="account-auth-badge"
      role="status"
      data-testid={`account-auth-badge-${accountId}`}
    >
      <KeyRound size={14} className="account-auth-badge-icon" aria-hidden="true" />
      <span className="account-auth-badge-text">
        {label
          ? t('app.accountAuth.message', { account: label })
          : t('app.accountAuth.messageNoAccount')}
      </span>
      <button
        type="button"
        className="account-auth-badge-action"
        data-testid={`account-auth-fix-${accountId}`}
        onClick={() => onFix(accountId)}
      >
        {t('app.accountAuth.action')}
      </button>
    </div>
  )
}
