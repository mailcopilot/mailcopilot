import { useTranslation } from 'react-i18next'
import type { AttachmentMeta } from '../../packages/net/types'
import { formatBytes } from '../utils/mail'
import { fileIcon } from '../utils/fileIcon'

export type AttachmentRowProps = {
  attachment: AttachmentMeta
  onDownload: () => void
  disabled?: boolean
}

/**
 * Single attachment chip rendered in the MailViewer header: type-specific
 * icon + filename + human-readable size. The whole chip is a download button;
 * click behaviour is delegated to the caller (download is still driven by
 * main-process IPC).
 *
 * §2.125: the "Preview available" badge was removed — no preview action exists,
 * so the badge advertised a capability the product does not have while doubling
 * the chip width. `descriptor.previewable` is intentionally kept in
 * `src/utils/fileIcon.ts`: §2.126 brings the badge back together with a real
 * preview action. Only the label went away, not the data model.
 *
 * Pure presentation: no `fetch`, no IPC — matches CLAUDE.md §5 invariants
 * (renderer → preload whitelist only). The icon helper is tree-shakable and
 * reuses the existing lucide-react bundle; no new npm dependency.
 */
export default function AttachmentRow({ attachment, onDownload, disabled = false }: AttachmentRowProps) {
  const { t } = useTranslation()
  const descriptor = fileIcon(attachment.contentType, attachment.filename)
  const displayName = attachment.filename || t('mail.attachments.unnamed')
  // Explicit aria-label carries the full semantic intent ("Download
  // attachment: <name>") so assistive tech does not have to stitch it from
  // icon label + filename + size + preview badge. Inner nodes are marked
  // aria-hidden where they are purely decorative.
  const buttonAriaLabel = t('attachments.downloadAction', { name: displayName })

  return (
    <button
      type="button"
      className="attachment-chip"
      onClick={onDownload}
      disabled={disabled}
      title={t('mail.attachments.download')}
      aria-label={buttonAriaLabel}
    >
      <span className="attachment-icon" aria-hidden="true">
        {descriptor.icon}
      </span>
      <span className="attachment-name" aria-hidden="true">{displayName}</span>
      {typeof attachment.size === 'number' && attachment.size > 0 && (
        <span className="attachment-size" aria-hidden="true">{formatBytes(attachment.size)}</span>
      )}
    </button>
  )
}
