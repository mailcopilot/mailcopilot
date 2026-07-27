/**
 * MailBodyContent — shared renderer for the mail meta/attachments/body block.
 *
 * Extracted from App.tsx to eliminate duplication between the ThreadView
 * renderBody slot and the single-message else-branch (CLAUDE.md §5 hotspot
 * policy). Both call sites now delegate here with identical props.
 *
 * Pure presentation — no IPC, no side-effects. All data is passed in from
 * App.tsx, which owns state and IPC calls.
 *
 * §2.22: When details.calendarInvite is defined, renders an InviteCard above
 * the message body. InviteCard owns the RSVP IPC call and its own local state.
 *
 * §3.3.C-uiaudit.22: metaTo/metaCc changed from string to MailAddress[] so
 * RecipientList can render collapsible chips with tooltips. metaBcc and
 * isSentByMe added for BCC privacy invariant (BCC shown only when isSentByMe).
 */

import { Loader2, WifiOff, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MailAddress, MailSummary, AttachmentMeta, MessageDetails } from '../../packages/net/types'
import AttachmentRow from './AttachmentRow'
import InviteCard from './InviteCard'
import RecipientList from './RecipientList'

export interface MailBodyContentProps {
  /** Currently displayed mail summary (used for retry click and attachment save key). */
  active: MailSummary | null
  /** Full message details including html/text/attachments. */
  details: MessageDetails | null
  /**
   * §2.22 fix iter2B: Normalized identity email list for the active account.
   * Passed to InviteCard to detect organizer==self with trim+lowercase across
   * multiple identity sources (primary, smtp.user, imap.user, aliases).
   * Replaces the single `accountEmail` string to handle mixed-case / alias cases.
   */
  identities?: string[]
  /** Whether the body is currently loading. */
  loadingBody: boolean
  /**
   * §3.3.C-uiaudit.22: To address list (raw MailAddress[] from envelope).
   * Replaces the old pre-formatted string to enable collapsible chip rendering.
   */
  metaTo: MailAddress[]
  /**
   * §3.3.C-uiaudit.22: Cc address list (raw MailAddress[] from envelope).
   * Replaces the old pre-formatted string to enable collapsible chip rendering.
   */
  metaCc: MailAddress[]
  /**
   * §3.3.C-uiaudit.22: Bcc address list. Rendered only when isSentByMe === true.
   * BCC privacy invariant: never shown for received mail.
   */
  metaBcc?: MailAddress[]
  /**
   * §3.3.C-uiaudit.22: Whether the active message was sent by the current account
   * (i.e. it lives in a Sent folder). Controls BCC row visibility.
   */
  isSentByMe?: boolean
  /** Rendered date string (already formatted by caller). */
  metaDate: string
  /** Whether the message contains external images (privacy banner trigger). */
  mailHasExternalImages: boolean
  /** Whether the user has enabled always-load-images globally. */
  alwaysLoadImages: boolean
  /** Whether the user manually revealed images for this message. */
  showExternalImages: boolean
  /** Prepared srcdoc for the HTML iframe (null while being built). */
  mailIframeDoc: string | null
  /** Unique key for the iframe element — forces remount on content change. */
  iframeKey: string
  /** Ref forwarded to the iframe element so the caller can interact with it. */
  mailIframeRef: React.Ref<HTMLIFrameElement>
  /** Active mail key string used for disabling individual attachment buttons. */
  activeMailKey: string
  /** Saving-in-progress attachment key (accountId:folder:uid:part). */
  savingAttachment: string | null
  /** Called when the user clicks "Show images". */
  onShowExternalImages: () => void
  /** Called when the user clicks Retry after offline load failure. */
  onRetry: () => void
  /** Called when the user clicks download on an attachment. */
  onDownloadAttachment: (att: AttachmentMeta) => void
}

export default function MailBodyContent({
  active,
  details,
  identities,
  loadingBody,
  metaTo,
  metaCc,
  metaBcc,
  isSentByMe,
  metaDate,
  mailHasExternalImages,
  alwaysLoadImages,
  showExternalImages,
  mailIframeDoc,
  iframeKey,
  mailIframeRef,
  activeMailKey,
  savingAttachment,
  onShowExternalImages,
  onRetry,
  onDownloadAttachment,
}: MailBodyContentProps) {
  const { t } = useTranslation()

  const visibleAttachments: AttachmentMeta[] = active && details?.attachments
    ? details.attachments.filter(
        att =>
          (att.disposition || '').toLowerCase() !== 'inline' || Boolean(att.filename),
      )
    : []

  // BCC privacy invariant: only show BCC row when the message was sent by me
  // AND the bcc list is non-empty. Never show BCC for received mail.
  const showBcc = isSentByMe === true && Array.isArray(metaBcc) && metaBcc.length > 0

  return (
    <>
      <div className="mail-viewer-meta">
        {metaTo.length > 0 && (
          <div className="meta-row meta-row--recipients">
            <span className="meta-key">{t('mail.headers.to')}</span>
            <RecipientList addresses={metaTo} maxVisible={3} />
          </div>
        )}
        {metaCc.length > 0 && (
          <div className="meta-row meta-row--recipients">
            <span className="meta-key">{t('mail.headers.cc')}</span>
            <RecipientList addresses={metaCc} maxVisible={3} />
          </div>
        )}
        {showBcc && (
          <div className="meta-row meta-row--recipients">
            <span className="meta-key">{t('mail.headers.bcc')}</span>
            <RecipientList addresses={metaBcc!} maxVisible={3} />
          </div>
        )}
        <div className="meta-row">
          <span className="meta-key">{t('mail.headers.date')}</span>
          <span className="meta-val">{metaDate}</span>
        </div>
      </div>

      {visibleAttachments.length > 0 && (
        <div className="mail-attachments">
          {visibleAttachments.map(att => (
            <AttachmentRow
              key={att.part}
              attachment={att}
              onDownload={() => onDownloadAttachment(att)}
              disabled={savingAttachment === `${activeMailKey}:${att.part}`}
            />
          ))}
        </div>
      )}

      {/* §2.22: inline RSVP card for messages with a text/calendar MIME part */}
      {active && details?.calendarInvite && (
        <InviteCard
          invite={details.calendarInvite}
          messageUid={active.uid}
          accountId={active.accountId}
          folder={active.folder}
          identities={identities}
        />
      )}

      <div className="mail-viewer-body">
        {loadingBody ? (
          <div className="empty-state">
            <Loader2 size={24} className="spin" />
            <p>{t('app.empty.loadingMessage.title')}</p>
          </div>
        ) : details?.offlineFallback ? (
          <div className="empty-state offline-fallback">
            <WifiOff size={24} />
            <p>{t('app.errors.bodyNotAvailableOffline')}</p>
            {active && (
              <button
                type="button"
                className="btn-primary"
                data-testid="mail-offline-retry"
                onClick={onRetry}
              >
                {t('mail.actions.retry')}
              </button>
            )}
          </div>
        ) : details && !details.html && !details.text ? (
          <div className="empty-state">
            <AlertTriangle size={24} />
            <p>{t('app.empty.messageNotFound.title')}</p>
          </div>
        ) : details?.html ? (
          <div className="mail-html-wrap">
            {mailHasExternalImages && !(alwaysLoadImages || showExternalImages) && (
              <div className="privacy-banner" data-testid="images-blocked-banner">
                <span>{t('mail.privacy.imagesBlocked')}</span>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onShowExternalImages}
                >
                  {t('mail.privacy.showImages')}
                </button>
              </div>
            )}
            {mailIframeDoc ? (
              <iframe
                key={iframeKey}
                ref={mailIframeRef}
                title="mail"
                sandbox="allow-same-origin allow-top-navigation-by-user-activation allow-modals"
                referrerPolicy="no-referrer"
                className="mail-iframe"
                srcDoc={mailIframeDoc}
              />
            ) : (
              <div className="empty-state">
                <Loader2 size={24} className="spin" />
                <p>{t('app.empty.loadingMessage.title')}</p>
              </div>
            )}
          </div>
        ) : (
          <pre data-testid="mail-body-text" className="mail-text">
            {details?.text || ''}
          </pre>
        )}
      </div>
    </>
  )
}
