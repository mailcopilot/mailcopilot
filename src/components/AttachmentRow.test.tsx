// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import AttachmentRow from './AttachmentRow'
import type { AttachmentMeta } from '../../packages/net/types'

// Deterministic t(): returns key for unknown, translates a couple of
// user-visible labels for readability in assertions. Mirrors the pattern used
// by AiPanel.test.tsx.
const i18nMap: Record<string, string> = {
  'attachments.previewAvailable': 'Preview available',
  'attachments.iconLabel.pdf': 'PDF document',
  'attachments.iconLabel.image': 'Image',
  'attachments.iconLabel.archive': 'Archive',
  'attachments.iconLabel.doc': 'Document',
  'attachments.iconLabel.spreadsheet': 'Spreadsheet',
  'attachments.iconLabel.presentation': 'Presentation',
  'attachments.iconLabel.text': 'Text file',
  'attachments.iconLabel.eml': 'Email',
  'attachments.iconLabel.generic': 'File',
  'mail.attachments.download': 'Download attachment',
  'mail.attachments.unnamed': 'Attachment',
}
// Support simple {{name}} interpolation for `attachments.downloadAction` so
// we can assert on the final rendered label in tests.
const INTERPOLATED: Record<string, string> = {
  'attachments.downloadAction': 'Download attachment: {{name}}',
}
const stableT = (key: string, opts?: Record<string, unknown>) => {
  if (key in INTERPOLATED) {
    return INTERPOLATED[key].replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
  }
  return i18nMap[key] ?? key
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}))

afterEach(cleanup)

function baseAtt(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    part: '1.2',
    filename: 'file.bin',
    contentType: 'application/octet-stream',
    size: 1024,
    ...overrides,
  }
}

describe('AttachmentRow', () => {
  it('renders PDF icon + filename + size + Preview badge for application/pdf', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'report.pdf', contentType: 'application/pdf', size: 2048 })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-name')?.textContent).toBe('report.pdf')
    expect(container.querySelector('.attachment-size')?.textContent).toBe('2.0 KB')
    const badge = container.querySelector('.attachment-preview-badge')
    expect(badge).toBeTruthy()
    expect(badge?.textContent).toBe('Preview available')
    // Badge must be hidden from AT — the button's aria-label already conveys
    // intent; the badge is a purely visual hint for sighted users.
    expect(badge?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders archive icon without Preview badge for application/zip', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'bundle.zip', contentType: 'application/zip' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })

  it('renders generic icon for unknown MIME + unknown extension (application/octet-stream + .xyz)', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'mystery.xyz', contentType: 'application/octet-stream' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })

  it('renders image icon + Preview badge for octet-stream fallback on .png', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'photo.png', contentType: 'application/octet-stream' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-preview-badge')?.textContent).toBe('Preview available')
  })

  it('renders unnamed fallback when filename is missing', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: undefined })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-name')?.textContent).toBe('Attachment')
  })

  it('omits size span when size is missing or zero', () => {
    const { container: c1 } = render(
      <AttachmentRow attachment={baseAtt({ size: undefined })} onDownload={() => {}} />
    )
    expect(c1.querySelector('.attachment-size')).toBeNull()
    cleanup()
    const { container: c2 } = render(
      <AttachmentRow attachment={baseAtt({ size: 0 })} onDownload={() => {}} />
    )
    expect(c2.querySelector('.attachment-size')).toBeNull()
  })

  it('fires onDownload when clicked', () => {
    const onDownload = vi.fn()
    const { container } = render(
      <AttachmentRow attachment={baseAtt()} onDownload={onDownload} />
    )
    fireEvent.click(container.querySelector('.attachment-chip')!)
    expect(onDownload).toHaveBeenCalledTimes(1)
  })

  it('does not fire onDownload when disabled', () => {
    const onDownload = vi.fn()
    const { container } = render(
      <AttachmentRow attachment={baseAtt()} onDownload={onDownload} disabled />
    )
    const btn = container.querySelector('.attachment-chip') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onDownload).not.toHaveBeenCalled()
  })

  it('uses the download title/tooltip', () => {
    const { container } = render(
      <AttachmentRow attachment={baseAtt()} onDownload={() => {}} />
    )
    expect(container.querySelector('.attachment-chip')?.getAttribute('title')).toBe('Download attachment')
  })

  it('exposes button aria-label with interpolated filename (assistive tech focus)', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'report.pdf', contentType: 'application/pdf' })}
        onDownload={() => {}}
      />
    )
    const btn = container.querySelector('.attachment-chip')
    expect(btn?.getAttribute('aria-label')).toBe('Download attachment: report.pdf')
  })

  it('interpolates the unnamed fallback into aria-label when filename is missing', () => {
    const { container } = render(
      <AttachmentRow attachment={baseAtt({ filename: undefined })} onDownload={() => {}} />
    )
    expect(container.querySelector('.attachment-chip')?.getAttribute('aria-label')).toBe('Download attachment: Attachment')
  })

  it('marks inner icon/name/size/badge as aria-hidden so screen readers read only the button label', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'report.pdf', contentType: 'application/pdf', size: 2048 })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.attachment-name')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.attachment-size')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.attachment-preview-badge')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders very long filename without truncation in DOM text', () => {
    const longName = 'a'.repeat(256) + '.pdf'
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: longName, contentType: 'application/pdf' })}
        onDownload={() => {}}
      />
    )
    // Full filename must be present in the DOM — visual truncation is a CSS
    // concern, not a logic concern; the accessible text must stay intact.
    expect(container.querySelector('.attachment-name')?.textContent).toBe(longName)
  })

  it('renders filename with special characters verbatim', () => {
    const weird = 'résumé (v2) — final <draft> & "notes".pdf'
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: weird, contentType: 'application/pdf' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-name')?.textContent).toBe(weird)
  })

  it('formats huge size (GB range) via formatBytes', () => {
    const twoGB = 2 * 1024 * 1024 * 1024
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ size: twoGB, filename: 'huge.bin' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-size')?.textContent).toBe('2.0 GB')
  })

  it('renders generic icon when contentType is an empty string and no extension', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'README', contentType: '' })}
        onDownload={() => {}}
      />
    )
    // Icon element is aria-hidden so screen readers ignore it; verify it
    // renders and no preview badge is shown for unknown content.
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })

  it('renders classified icon from extension when contentType is missing entirely', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'message.eml', contentType: undefined })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })

  it('classifies spreadsheet MIME without preview badge', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({
          filename: 'q1.xlsx',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })

  // Regression for MEDIUM-1: image/tiff must NOT display the "Preview
  // available" badge — the renderer can only preview PNG/JPEG/GIF/WEBP.
  it('does not show preview badge for image/tiff (unsupported image format)', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'scan.tiff', contentType: 'image/tiff' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-icon')).toBeTruthy()
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })

  it('does not show preview badge for image/heic (unsupported image format)', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'iphone.heic', contentType: 'image/heic' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })

  it('does not show preview badge for image/svg+xml (unsupported image format)', () => {
    const { container } = render(
      <AttachmentRow
        attachment={baseAtt({ filename: 'vector.svg', contentType: 'image/svg+xml' })}
        onDownload={() => {}}
      />
    )
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
  })
})
