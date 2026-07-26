import { createElement, type ReactNode } from 'react'
import {
  File as FileIcon,
  FileText,
  FileImage,
  FileArchive,
  FileSpreadsheet,
  Presentation,
  Mail as MailIcon,
} from 'lucide-react'

/**
 * Descriptor for attachment visual metadata: rendered icon, i18n label key
 * (aria-label), and whether the attachment is previewable by the app
 * (PDF/image today — used as a hint badge, not a guarantee).
 */
export type FileIconDescriptor = {
  icon: ReactNode
  label: string
  previewable: boolean
}

const ICON_SIZE = 14

/**
 * MIME types that the app can render inline. Must stay aligned with the
 * preview-supported categories in `electron/services/attachmentContent.ts`
 * (PDF + `IMAGE_MIME_SET`). Image formats outside this set (tiff, heic,
 * svg+xml, etc.) fall back to download — do not mark them previewable.
 */
const PREVIEWABLE_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/**
 * Normalize a filename extension (lowercase, no leading dot). Returns empty
 * string when no extension can be extracted.
 */
function extractExtension(filename?: string): string {
  if (!filename) return ''
  const trimmed = filename.trim()
  // Ignore dotfiles without another dot (e.g. ".gitignore"). Split on the last dot.
  const idx = trimmed.lastIndexOf('.')
  if (idx <= 0 || idx === trimmed.length - 1) return ''
  return trimmed.slice(idx + 1).toLowerCase()
}

/**
 * Map a filename extension to a synthetic MIME type. Only covers cases where
 * the server sent `application/octet-stream` (or an empty MIME) and the
 * extension is our only clue. Keep this list tight — add cases only when they
 * correspond to a branch in `fileIcon`.
 */
function extensionToMime(ext: string): string | undefined {
  switch (ext) {
    case 'pdf':
      return 'application/pdf'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'heic':
      return 'image/heic'
    case 'zip':
      return 'application/zip'
    case 'tar':
      return 'application/x-tar'
    case 'gz':
    case 'tgz':
      return 'application/x-gzip'
    case 'doc':
      return 'application/msword'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'odt':
      return 'application/vnd.oasis.opendocument.text'
    case 'xls':
      return 'application/vnd.ms-excel'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'ods':
      return 'application/vnd.oasis.opendocument.spreadsheet'
    case 'ppt':
      return 'application/vnd.ms-powerpoint'
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'odp':
      return 'application/vnd.oasis.opendocument.presentation'
    case 'txt':
      return 'text/plain'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'eml':
      return 'message/rfc822'
    default:
      return undefined
  }
}

const DOCUMENT_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
])

const SPREADSHEET_MIMES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
])

const PRESENTATION_MIMES = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
])

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/x-gzip',
])

const TEXT_MIMES = new Set(['text/plain', 'text/markdown'])

function classify(mime: string): FileIconDescriptor | undefined {
  if (mime === 'application/pdf') {
    return {
      icon: createElement(FileText, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.pdf',
      previewable: true,
    }
  }
  if (mime.startsWith('image/')) {
    return {
      icon: createElement(FileImage, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.image',
      previewable: PREVIEWABLE_MIMES.has(mime),
    }
  }
  if (ARCHIVE_MIMES.has(mime)) {
    return {
      icon: createElement(FileArchive, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.archive',
      previewable: false,
    }
  }
  if (DOCUMENT_MIMES.has(mime)) {
    return {
      icon: createElement(FileText, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.doc',
      previewable: false,
    }
  }
  if (SPREADSHEET_MIMES.has(mime)) {
    return {
      icon: createElement(FileSpreadsheet, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.spreadsheet',
      previewable: false,
    }
  }
  if (PRESENTATION_MIMES.has(mime)) {
    return {
      icon: createElement(Presentation, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.presentation',
      previewable: false,
    }
  }
  if (TEXT_MIMES.has(mime)) {
    return {
      icon: createElement(FileText, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.text',
      previewable: false,
    }
  }
  if (mime === 'message/rfc822') {
    return {
      icon: createElement(MailIcon, { size: ICON_SIZE, 'aria-hidden': true }),
      label: 'attachments.iconLabel.eml',
      previewable: false,
    }
  }
  return undefined
}

function generic(): FileIconDescriptor {
  return {
    icon: createElement(FileIcon, { size: ICON_SIZE, 'aria-hidden': true }),
    label: 'attachments.iconLabel.generic',
    previewable: false,
  }
}

/**
 * Resolve a visual descriptor (icon + i18n aria-label key + previewable flag)
 * for an attachment. Accepts the server-provided `mimeType` (possibly empty or
 * `application/octet-stream`) and optional `filename` used as an extension
 * fallback. Pure — no side effects, no `fetch`, safe to call per-render.
 */
export function fileIcon(mimeType: string | undefined, filename?: string): FileIconDescriptor {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim()

  // First, treat specific and well-formed MIME types (but skip the generic
  // octet-stream bucket — it carries no type information and should defer to
  // the filename extension).
  if (mime && mime !== 'application/octet-stream') {
    const direct = classify(mime)
    if (direct) return direct
  }

  // Fallback: parse filename extension. Applies when MIME is missing or is
  // `application/octet-stream`.
  const ext = extractExtension(filename)
  if (ext) {
    // `.eml` can arrive without a message/rfc822 MIME.
    if (ext === 'eml') {
      return {
        icon: createElement(MailIcon, { size: ICON_SIZE, 'aria-hidden': true }),
        label: 'attachments.iconLabel.eml',
        previewable: false,
      }
    }
    const inferred = extensionToMime(ext)
    if (inferred) {
      const viaExt = classify(inferred)
      if (viaExt) return viaExt
    }
  }

  return generic()
}
