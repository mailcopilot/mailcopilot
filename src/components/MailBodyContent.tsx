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
 *
 * §2.128: the attachment list model (ordering, dedupe and the collapse
 * ceiling) lives in `src/utils/attachmentList.ts`. This component only owns the
 * expand/collapse UI state — deliberately keyed by activeMailKey so switching
 * messages never carries an expanded list over to the next one.
 *
 * No part ever loses its chip. Parts the body inlined (reported as
 * `hiddenAttachments` by `useMailIframeDoc`, which substituted their bytes and
 * therefore knows) are demoted below the real attachments and wait behind the
 * same toggle as any attachment past the ceiling. Expanding shows all of them.
 * Deciding "the browser already drew this" is not something we can do from
 * outside the browser, and getting it wrong used to cost the user a file.
 */

import { Loader2, AlertTriangle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MailAddress, MailSummary, AttachmentMeta, MessageDetails } from '../../packages/net/types'
import type { UseMailTranslationResult } from '../hooks/useMailTranslation'
import { buildAttachmentList } from '../utils/attachmentList'
import AttachmentRow from './AttachmentRow'
import InviteCard from './InviteCard'
import MailTranslateBar from './MailTranslateBar'
import MailBodyFallbackNotice from './MailBodyFallbackNotice'
import MailParseCapNotice from './MailParseCapNotice'
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
  /**
   * §2.128: the parts the body inlined, as reported by
   * `useMailIframeDoc().hiddenAttachments`. Exactly these are demoted below the
   * real attachments — never removed, and always reachable by expanding.
   *
   * Optional on purpose: a caller that does not render a body (or does not run
   * the hook) passes nothing and gets the server's own order.
   */
  hiddenAttachments?: readonly AttachmentMeta[] | null
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
  /**
   * §2.145 — called when the user asks to see the rest of a soft-capped
   * message. Optional: a caller that does not wire the re-parse gets a banner
   * without a button, which is the honest rendering of "there is more, and this
   * view cannot fetch it".
   */
  onShowFullMessage?: () => void
  /** §2.145 — true while that re-parse is in flight. */
  loadingFullMessage?: boolean
  /**
   * §3.3 B6 — the reading-pane translation state, owned by
   * `useMailTranslation` in App.tsx and scoped to the ACTIVE message.
   *
   * Optional: a caller that does not wire it renders exactly the previous
   * component (no bar, original body). When the hook reports
   * `showingTranslation`, the body area renders `translatedText` AS TEXT in
   * place of the original — never through the iframe and never through
   * `dangerouslySetInnerHTML`. The translation is model output derived from
   * untrusted mail, so routing it into markup would bypass the sanitizer that
   * guards the original body.
   *
   * The original is never modified, never re-cached and never overwritten: this
   * is a display swap over the same untouched `details`.
   */
  translation?: UseMailTranslationResult
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
  hiddenAttachments,
  iframeKey,
  mailIframeRef,
  activeMailKey,
  savingAttachment,
  onShowExternalImages,
  onRetry,
  onDownloadAttachment,
  onShowFullMessage,
  loadingFullMessage,
  translation,
}: MailBodyContentProps) {
  const { t } = useTranslation()

  // Expanded state is stored as "which message is expanded" rather than a bare
  // boolean: selecting another message then implicitly collapses the list
  // without an effect and without a stale-state window.
  const [expandedFor, setExpandedFor] = useState<string | null>(null)

  const attachmentsSource: AttachmentMeta[] | null = active ? details?.attachments ?? null : null
  const attachmentList = useMemo(
    () =>
      buildAttachmentList({
        attachments: attachmentsSource,
        inlineParts: hiddenAttachments,
        expanded: expandedFor === activeMailKey,
      }),
    [attachmentsSource, hiddenAttachments, expandedFor, activeMailKey],
  )

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
        {/* §3.3 B6 — sits with the meta rows, above the body: it is a statement
            about the open message, and it must be reachable before the reader
            scrolls into text they cannot read. Renders nothing when the
            per-account opt-in is off. */}
        {active && translation && (
          <MailTranslateBar state={translation} originalIsHtml={!!details?.html} />
        )}
      </div>

      {attachmentList.total > 0 && (
        <div
          className={`mail-attachments${attachmentList.expanded ? ' mail-attachments--expanded' : ''}`}
          data-testid="mail-attachments"
        >
          {attachmentList.visible.map(att => (
            <AttachmentRow
              key={att.part}
              attachment={att}
              onDownload={() => onDownloadAttachment(att)}
              disabled={savingAttachment === `${activeMailKey}:${att.part}`}
            />
          ))}
          {attachmentList.canExpand && (
            <button
              type="button"
              className="attachments-toggle"
              data-testid="attachments-toggle"
              aria-expanded={attachmentList.expanded}
              onClick={() => setExpandedFor(attachmentList.expanded ? null : activeMailKey)}
            >
              {/* The count is what is NOT on screen right now, not the total:
                  the toggle's only promise is "there are N more chips behind
                  me", and after §2.128 those N include the inlined parts. */}
              {attachmentList.expanded
                ? t('mail.attachments.showLess')
                : t('mail.attachments.showMore', { hidden: attachmentList.hiddenCount })}
            </button>
          )}
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
        ) : translation?.showingTranslation && translation.translation ? (
          /* §3.3 B6 — the translation is rendered AS TEXT, in a <pre> exactly
             like a plain-text body: a React text child, never `srcDoc`, never
             `dangerouslySetInnerHTML`. This branch stands above the original's
             own rendering chain because the user explicitly asked to read the
             translation; one click on the bar above puts the original back, and
             `details` was never touched to get here. */
          <pre data-testid="mail-body-translated" className="mail-text">
            {translation.translation.translatedText}
          </pre>
        ) : details?.offlineFallback ? (
          /* §2.17 Phase 1 — same envelope, three different causes; the words,
             the icon and the test id all come from one shared table so this
             window and the standalone message window cannot drift apart. */
          <MailBodyFallbackNotice
            reason={details.offlineFallbackReason}
            onRetry={active ? onRetry : undefined}
          />
        ) : details?.parseCap?.kind === 'hard' ? (
          /* §2.145 — stands ABOVE the "no body" branch on purpose: a hard-capped
             message HAS a body, we declined to read it, and answering "message
             not found" would be both false and unactionable. */
          <MailParseCapNotice cap={details.parseCap} />
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

        {/* §2.145 — the soft-cap banner sits BELOW the body, where the text
            stops: that is where a reader discovers the message ended early, and
            a banner above it would be answering a question nobody had asked
            yet. Suppressed while loading, so the first paint of a re-parse does
            not show the old banner over a spinner. */}
        {!loadingBody && details?.parseCap?.kind === 'soft' && (
          <MailParseCapNotice
            cap={details.parseCap}
            loading={loadingFullMessage}
            onShowFull={onShowFullMessage}
          />
        )}
      </div>
    </>
  )
}
