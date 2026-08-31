/**
 * §2.145 — what the user is told when a parse cap shaped the message they
 * opened.
 *
 * Two caps, two genuinely different messages, and the difference is not one of
 * degree:
 *
 *  - HARD — the raw message was too large to hand to the MIME parser at all, so
 *    nothing was decoded. This renders INSTEAD OF a body, and it offers no way
 *    forward. That is the point: an "open anyway" button would be a button that
 *    asks the application to run out of memory, and dressing a crash up as a
 *    user choice is not a choice. What it does instead is tell the user the one
 *    fact the placeholder can stand on — how big the message is — and leave
 *    them holding a message they can still act on (forward it, save it, open it
 *    elsewhere) rather than an error.
 *  - SOFT — the message opened normally and its body was clipped. This renders
 *    BELOW the body, as a banner, and it does offer a way forward, because the
 *    raised tier is bounded and the cost is one the user has asked to pay.
 *    When even the raised tier clipped (`canShowFull === false`) the banner
 *    still appears and the button does not: a button that would change nothing
 *    is worse than no button.
 *
 * Pure presentation — no IPC, no state of its own. The caller owns the re-parse
 * (see `useShowFullMessage`).
 *
 * Styling reuses `.empty-state` and `.privacy-banner`, the two shapes the mail
 * viewer already uses for exactly these roles (a body that is not there, and a
 * strip explaining why what is there is incomplete).
 */

import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MessageParseCap } from '../../packages/net/types'
import { formatBytes } from '../utils/mail'

export interface MailParseCapNoticeProps {
  /** The cap that shaped this message. */
  cap: MessageParseCap
  /** True while a "show full message" re-parse is in flight; disables the button
   *  so a slow re-parse cannot be queued twice by an impatient click. */
  loading?: boolean
  /** Called when the user asks for the rest of the message. Absent on the hard
   *  path, where there is nothing to ask for. */
  onShowFull?: () => void
}

export default function MailParseCapNotice({ cap, loading, onShowFull }: MailParseCapNoticeProps) {
  const { t } = useTranslation()

  if (cap.kind === 'hard') {
    return (
      <div className="empty-state" data-testid="mail-parse-cap-hard">
        <AlertTriangle size={24} />
        <p>{t('mail.parseCap.hard.title')}</p>
        {/* §2.145 wave 3.1 — the copy says "larger than {limit}", never "it is
            {size}". `cap.rawBytes` is EXACT on the two paths that measured a
            whole message (parser entry, on-disk stat) and a LOWER BOUND on the
            one that refused a download mid-stream — it is the count at the
            moment we stopped consuming, not the message's size. One string
            serves every hard path, and "larger than the limit" is true on all
            of them by construction, so no branch and no extra flag on the DTO
            is needed to keep it honest. */}
        <p>{t('mail.parseCap.hard.body', { limit: formatBytes(cap.limitBytes) })}</p>
      </div>
    )
  }

  return (
    <div className="privacy-banner" data-testid="mail-parse-cap-soft">
      <span>{t('mail.parseCap.soft.banner')}</span>
      {cap.canShowFull && onShowFull ? (
        <button
          type="button"
          className="btn-primary"
          data-testid="mail-parse-cap-show-full"
          disabled={loading === true}
          onClick={onShowFull}
        >
          {loading ? t('mail.parseCap.soft.loading') : t('mail.parseCap.soft.action')}
        </button>
      ) : (
        <span data-testid="mail-parse-cap-at-limit">{t('mail.parseCap.soft.atLimit')}</span>
      )}
    </div>
  )
}
